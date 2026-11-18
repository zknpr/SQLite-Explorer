import './vscode_mock_setup';

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, type TestContext } from 'node:test';
import * as vscode from 'vscode';
import { createNativeDatabaseConnection, isNativeAvailable, NativeWorkerProcess } from '../../src/nativeWorker';
import type { DatabaseOperations } from '../../src/core/types';

/**
 * The native engine reads and writes the file itself, beside whatever other
 * program has it open. SQLite refuses a statement at once when that program
 * holds a lock in its way: an edit beside a reader, a read beside a writer
 * that is committing. An application that touched its database at the instant
 * of an edit failed that edit with "database is locked". The engine's
 * connections now wait a moment for such a lock (`LOCK_WAIT_MS` in
 * `natives/native-worker.js`) and fail as before when it is kept.
 *
 * One pair is not waited for and has no test here: an edit beside another
 * connection's open write transaction. SQLite calls no busy handler for a
 * transaction that has read and then asks for the write lock.
 */

/** Long enough to be told from no wait at all, short beside the engine's wait. */
const HELD_MS = 150;

async function fixture(t: TestContext) {
    const root = process.cwd();
    if (!await isNativeAvailable(root)) {
        if (process.env.FUZZ_EXPECT_TARGET) throw new Error(`Missing native runtime for ${process.env.FUZZ_EXPECT_TARGET}`);
        t.skip('Bundled native runtime unavailable');
        return;
    }
    fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
    const directory = fs.mkdtempSync(path.join(root, '.tmp', 'native-lock-wait-'));
    const file = path.join(directory, 'test.db');
    const seed = new DatabaseSync(file);
    try {
        seed.exec('CREATE TABLE entries(id INTEGER PRIMARY KEY, value TEXT, large BLOB);'
            + "INSERT INTO entries VALUES(1, 'one', zeroblob(3000000)), (2, 'two', NULL);");
    } finally {
        seed.close();
    }
    const others: DatabaseSync[] = [];
    let worker: NativeWorkerProcess | undefined;
    const originalCall = NativeWorkerProcess.prototype.call;
    /** Runs right before a request of that name is sent to the engine, once. */
    const before = new Map<string, () => void>();
    t.mock.method(NativeWorkerProcess.prototype, 'call', function (
        this: NativeWorkerProcess,
        ...args: Parameters<typeof originalCall>
    ) {
        worker = this;
        const hook = before.get(String(args[0]));
        before.delete(String(args[0]));
        hook?.();
        return originalCall.apply(this, args);
    });
    const bundle = await createNativeDatabaseConnection(vscode.Uri.file(root));
    t.after(async () => {
        for (const other of others) if (other.isOpen) other.close();
        bundle.workerMethods[Symbol.dispose]();
        await fs.promises.rm(directory, { recursive: true, force: true });
    });
    /** Another program's connection, holding the file as a reader or as a writer. */
    const hold = (kind: 'reader' | 'writer') => {
        const other = new DatabaseSync(file, { timeout: 0 });
        others.push(other);
        if (kind === 'writer') other.exec('BEGIN EXCLUSIVE');
        else {
            other.exec('BEGIN');
            other.prepare('SELECT count(*) FROM entries').get();
        }
        return { letGo: () => { other.exec('ROLLBACK'); other.close(); } };
    };
    const open = async (): Promise<DatabaseOperations> =>
        (await bundle.establishConnection(vscode.Uri.file(file), 'test.db', false)).databaseOps;
    const value = (id: number) => {
        const reader = new DatabaseSync(file, { readOnly: true });
        try { return reader.prepare('SELECT value FROM entries WHERE id = ?').get(id)?.value; } finally { reader.close(); }
    };
    return {
        file, open, hold, value, before,
        compile: (statements: string[]) => originalCall.apply(worker!, ['compileBatch', [statements]]) as Promise<{ errors: Array<string | null> }>
    };
}

async function timed<T>(run: () => Promise<T>): Promise<{ ms: number; result?: T; error?: Error }> {
    const start = performance.now();
    try {
        return { result: await run(), ms: performance.now() - start };
    } catch (error) {
        return { error: error as Error, ms: performance.now() - start };
    }
}

const page = (engine: DatabaseOperations) => engine.fetchTableData('entries', { columns: ['id', 'value'], limit: 10, offset: 0 });

describe('the native engine beside another program that holds the file', () => {
    it('writes an edit once a reader lets go', async t => {
        const f = await fixture(t); if (!f) return;
        const engine = await f.open();
        await page(engine);
        const reader = f.hold('reader');
        setTimeout(reader.letGo, HELD_MS);
        const edit = await timed(() => engine.updateCell('entries', 2, 'value', 'edited'));
        assert.equal(edit.error, undefined);
        assert.ok(edit.ms >= HELD_MS - 20, `the edit returned after ${edit.ms} ms, before the reader let go`);
        assert.equal(f.value(2), 'edited');
    });

    it('reads a page once a writer lets go', async t => {
        const f = await fixture(t); if (!f) return;
        const engine = await f.open();
        await page(engine);
        const writer = f.hold('writer');
        setTimeout(writer.letGo, HELD_MS);
        const read = await timed(() => page(engine));
        assert.equal(read.error, undefined);
        assert.deepEqual(read.result?.rows, [[1, 'one'], [2, 'two']]);
    });

    it('reads on its second connection once a writer lets go', async t => {
        const f = await fixture(t); if (!f) return;
        const engine = await f.open();
        await page(engine);
        // Save As copies the database on the second connection: the writer
        // arrives when the first connection has done its part.
        let arrived = false;
        f.before.set('vacuumInto', () => {
            arrived = true;
            setTimeout(f.hold('writer').letGo, HELD_MS);
        });
        const copy = path.join(path.dirname(f.file), 'copy.db');
        const saving = await timed(async () => engine.writeToFile!(copy));
        assert.equal(arrived, true);
        assert.equal(saving.error, undefined);
        assert.ok(saving.ms >= HELD_MS - 20, `Save As returned after ${saving.ms} ms, before the writer let go`);
        const saved = new DatabaseSync(copy, { readOnly: true });
        try {
            assert.equal(saved.prepare('SELECT count(*) AS rows FROM entries').get()?.rows, 2);
        } finally {
            saved.close();
        }
    });

    it('opens a cell read session once a writer lets go', async t => {
        const f = await fixture(t); if (!f) return;
        const engine = await f.open();
        await page(engine);
        // The session reads on a handle it opens for itself: the writer
        // arrives when the requests before that one have been answered.
        let arrived = false;
        f.before.set('openCellReadSession', () => {
            arrived = true;
            setTimeout(f.hold('writer').letGo, HELD_MS);
        });
        const opened = await timed(() => engine.openCellReadSession({ table: 'entries', column: 'large', rowId: 1 }));
        assert.equal(arrived, true);
        assert.equal(opened.error, undefined);
        assert.ok(opened.ms >= HELD_MS - 20, `the session opened after ${opened.ms} ms, before the writer let go`);
        assert.equal(opened.result?.metadata.byteLength, 3000000);
        await engine.closeCellReadSession(opened.result!.sessionId);
    });

    it('fails an edit after its wait when the reader keeps the file', async t => {
        const f = await fixture(t); if (!f) return;
        const engine = await f.open();
        await page(engine);
        const reader = f.hold('reader');
        try {
            const edit = await timed(() => engine.updateCell('entries', 2, 'value', 'edited'));
            assert.match(String(edit.error?.message), /database is locked/);
            // It waited, in steps shorter than a second, and it stopped.
            assert.ok(edit.ms >= 450 && edit.ms < 2500, `the edit failed after ${edit.ms} ms`);
            assert.equal(f.value(2), 'two');
            // The engine answers the next request.
            assert.deepEqual((await page(engine)).rows, [[1, 'one'], [2, 'two']]);
        } finally {
            reader.letGo();
        }
        await engine.updateCell('entries', 2, 'value', 'edited later');
        assert.equal(f.value(2), 'edited later');
    });

    it('does not wait for a lock its own cell read session holds', async t => {
        const f = await fixture(t); if (!f) return;
        const engine = await f.open();
        await page(engine);
        // The session reads on a handle of its own and keeps its snapshot
        // between requests. Only this engine can end it, so a wait would hold
        // up the one thread that could.
        const session = await engine.openCellReadSession({ table: 'entries', column: 'large', rowId: 1 });
        const refused = await timed(() => engine.updateCell('entries', 2, 'value', 'edited'));
        assert.match(String(refused.error?.message), /database is locked/);
        assert.ok(refused.ms < 300, `the edit failed after ${refused.ms} ms`);
        await engine.closeCellReadSession(session.sessionId);
        // With the session gone the engine waits for another program again.
        const reader = f.hold('reader');
        setTimeout(reader.letGo, HELD_MS);
        const edit = await timed(() => engine.updateCell('entries', 2, 'value', 'edited'));
        assert.equal(edit.error, undefined);
        assert.equal(f.value(2), 'edited');
    });

    it('loads the grid\'s helpers after a first page that a lock refused', async t => {
        const f = await fixture(t); if (!f) return;
        // Held from before the open, so the first page is the first statement
        // that reads the file on this connection.
        const writer = f.hold('writer');
        let engine: DatabaseOperations;
        try {
            engine = await f.open();
            await assert.rejects(page(engine), /database is locked/);
        } finally {
            writer.letGo();
        }
        const sent: string[] = [];
        for (const method of ['queryPacked', 'queryNumeric']) f.before.set(method, () => { sent.push(method); });
        assert.deepEqual((await page(engine)).rows, [[1, 'one'], [2, 'two']]);
        // The packed page is the one the helpers serve. A helper tried on the
        // locked file would have stayed off, and it would have waited as well:
        // that is not timed here, because one wait on a busy machine takes
        // longer than three on an idle one.
        assert.deepEqual(sent, ['queryPacked']);
    });

    it('waits once, not once per statement, when a batch of statements is compiled', async t => {
        const f = await fixture(t); if (!f) return;
        // Held from before the open, so the connection has no schema yet and
        // every statement compiled would read the file for it.
        const writer = f.hold('writer');
        try {
            await f.open();
            const statements = Array.from({ length: 40 }, (_, index) => `EXPLAIN SELECT ${index} FROM entries`);
            const compiled = await timed(() => f.compile(statements));
            assert.equal(compiled.error, undefined);
            assert.equal(compiled.result?.errors.length, statements.length);
            for (const error of compiled.result!.errors) assert.match(String(error), /database is locked/);
            // Forty waits would take 24 seconds.
            assert.ok(compiled.ms < 5000, `compiling took ${compiled.ms} ms`);
        } finally {
            writer.letGo();
        }
    });
});
