import './vscode_mock_setup';

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, type TestContext } from 'node:test';
import v8 from 'node:v8';
import * as vscode from 'vscode';
import { createNativeDatabaseConnection, getNativeBinaryPath, NativeWorkerProcess, nativeRequestsWrittenByV8 } from '../../src/nativeWorker';

/**
 * The bundled runtime reads version 15 of V8's serialization format. The
 * extension host used to write its requests with its own V8's serializer,
 * whose version the editor can raise: VS Code 1.139 and later (V8 15.0) write
 * version 16, where VS Code 1.110 to 1.138 and Node 24 write 15. There the
 * engine read no request, and every open waited out its 30 seconds before
 * the extension fell back to WebAssembly.
 *
 * The extension now writes its requests itself, always as version 15
 * (`nativeRequestFormat.ts`). This suite runs under Node, so a newer V8 is
 * stood in for by stamping another version on what Node's serializer
 * writes: a request must not pass through that serializer at all.
 */

interface Fixture {
    file: string;
    binary: string;
    script: string;
    /** What stops an engine this test started. They run before the folder is removed. */
    engines: Array<() => void>;
}

async function fixture(t: TestContext): Promise<Fixture | undefined> {
    const root = process.cwd();
    const binary = await getNativeBinaryPath(root);
    if (!binary) {
        if (process.env.FUZZ_EXPECT_TARGET) throw new Error(`Missing native runtime for ${process.env.FUZZ_EXPECT_TARGET}`);
        t.skip('Bundled native runtime unavailable');
        return undefined;
    }
    fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
    const directory = fs.mkdtempSync(path.join(root, '.tmp', 'native-wire-format-'));
    const engines: Array<() => void> = [];
    // One hook, engines first: on Windows a database an engine has open
    // cannot be removed, and an engine left running keeps this process alive.
    t.after(async () => {
        for (const stop of engines) stop();
        await fs.promises.rm(directory, { recursive: true, force: true });
    });
    const file = path.join(directory, 'test.db');
    const seed = new DatabaseSync(file);
    try {
        seed.exec("CREATE TABLE entries(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO entries VALUES(1, 'one'), (2, 'two');");
    } finally {
        seed.close();
    }
    return { file, binary, script: path.join(root, 'natives', 'native-worker.js'), engines };
}

/** Makes this process's V8 serializer write `version`, as a newer V8 does. */
function writeWireVersion(t: TestContext, version: number): void {
    const serialize = v8.serialize;
    t.mock.method(v8, 'serialize', (value: unknown) => {
        const serialized = serialize(value);
        assert.equal(serialized[0], 0xff);
        assert.equal(serialized[1], 15, 'this runtime writes the version the bundled runtime reads');
        serialized[1] = version;
        return serialized;
    });
}

async function rawWorker(given: Fixture): Promise<NativeWorkerProcess> {
    const worker = new NativeWorkerProcess(given.binary, given.script);
    given.engines.push(() => worker.stop());
    await worker.start();
    return worker;
}

describe('what the native engine is sent', () => {
    it('is read by the engine whatever version the editor\'s V8 writes', async (t) => {
        const given = await fixture(t);
        if (!given) return;
        // A version the engine could not read, had the request been written by V8.
        writeWireVersion(t, 99);
        const leftToV8 = nativeRequestsWrittenByV8.count;
        const bundle = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
        given.engines.push(() => bundle.workerMethods[Symbol.dispose]());

        const connection = await bundle.establishConnection(vscode.Uri.file(given.file), 'test.db');
        const rows = await connection.databaseOps.executeQuery('SELECT id, value FROM entries ORDER BY id');
        assert.deepEqual(rows[0].rows, [[1, 'one'], [2, 'two']]);

        // Every kind of value a statement is given, as the engine stores it.
        const worker = await rawWorker(given);
        await worker.call('open', [given.file, false, 0]);
        const kinds = await worker.call<{ values: unknown[][] }>('query', [
            'SELECT typeof(?1), ?1, typeof(?2), ?2, typeof(?3), ?3, typeof(?4), typeof(?5), CAST(?5 AS TEXT), typeof(?6), hex(?6), typeof(?7), ?7, typeof(?8), ?8',
            [28, 2.5, 'café ✓', null, 9007199254740993n, new Uint8Array([1, 2, 255]), -2147483648, 'x'.repeat(300)]
        ]);
        assert.deepEqual(kinds.values[0], [
            'integer', 28, 'real', 2.5, 'text', 'café ✓', 'null', 'integer', '9007199254740993', 'blob', '0102FF',
            'integer', -2147483648, 'text', 'x'.repeat(300)
        ]);
        assert.equal(nativeRequestsWrittenByV8.count, leftToV8, 'no request was left to V8');
    });

    it('labels a value it leaves to V8 with the version the engine reads', async (t) => {
        const given = await fixture(t);
        if (!given) return;
        // What V8 15 writes. No request the extension makes holds a date; this one is here for the path.
        writeWireVersion(t, 16);
        const leftToV8 = nativeRequestsWrittenByV8.count;
        const worker = await rawWorker(given);

        await worker.call('open', [given.file, false, 0, new Date(0)]);

        const rows = await worker.call<{ values: unknown[][] }>('query', ['SELECT count(*) FROM entries']);
        assert.deepEqual(rows.values, [[2]]);
        assert.equal(nativeRequestsWrittenByV8.count, leftToV8 + 1);
    });

    it('fails at once, with the engine\'s reason, when the engine cannot read a request', async (t) => {
        const given = await fixture(t);
        if (!given) return;
        // A version nothing has been compared for is sent as it is.
        writeWireVersion(t, 99);
        const worker = await rawWorker(given);
        const started = Date.now();

        await assert.rejects(
            async () => { await worker.call('open', [given.file, false, 0, new Date(0)]); },
            /The native engine could not read a request: /
        );

        // Not after the 30 seconds a request is given.
        assert.ok(Date.now() - started < 10_000, `${Date.now() - started} ms`);
    });
});
