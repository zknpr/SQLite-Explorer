import './vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test';
import * as vscode from 'vscode';

import { createDatabaseEngine, type WasmDatabaseEngine } from '../../src/core/sqlite-db';
import type { DatabaseOperations } from '../../src/core/types';
import { othersCanRenameIn } from '../../src/folderAccess';
import { createNativeDatabaseConnection, isNativeAvailable, NativeWorkerProcess } from '../../src/nativeWorker';
import { accessEntryTools } from '../../src/posixAccessEntries';
import { entriesForOther, NO_REAL_ENTRIES, shareWithOther } from './helpers/access-entries';

/**
 * A save that writes into its target (`writeInto` in `atomicDatabaseWrite.ts`)
 * leaves the file it found, where a save by rename leaves the snapshot under
 * the target's name. Each engine goes on from the save with the file that is
 * really there: these tests save through the engines themselves, twice in a
 * row, onto the file each has open.
 */

/**
 * A folder for one test. It is removed after whatever the test adds to
 * `closing` has run: Windows does not delete a database an engine has open.
 */
function scratch(t: TestContext): { directory: string; closing: Array<() => unknown> } {
    fs.mkdirSync('.tmp', { recursive: true });
    const directory = fs.realpathSync(fs.mkdtempSync(path.resolve('.tmp/save-in-place-')));
    const closing: Array<() => unknown> = [];
    t.after(async () => {
        for (const close of closing.reverse()) await close();
        // The engine's process lets go of the file a moment after it is told to stop.
        await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });
    return { directory, closing };
}

function seed(file: string): void {
    const made = new DatabaseSync(file);
    try {
        made.exec("CREATE TABLE entries(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO entries VALUES (1, 'one'), (2, 'two')");
    } finally {
        made.close();
    }
}

function valueOf(file: string, id: number): unknown {
    const opened = new DatabaseSync(file, { readOnly: true });
    try {
        return opened.prepare('SELECT value FROM entries WHERE id = ?').get(id)?.value;
    } finally {
        opened.close();
    }
}

async function nativeEngine(t: TestContext, file: string, log: string[], closing: Array<() => unknown>): Promise<DatabaseOperations | undefined> {
    const root = process.cwd();
    if (!await isNativeAvailable(root)) {
        if (process.env.FUZZ_EXPECT_TARGET) throw new Error(`Missing native runtime for ${process.env.FUZZ_EXPECT_TARGET}`);
        t.skip('Bundled native runtime unavailable');
        return undefined;
    }
    const bundle = await createNativeDatabaseConnection(vscode.Uri.file(root), undefined, { appendLine: (line: string) => { log.push(line); } } as vscode.OutputChannel);
    closing.push(() => { bundle.workerMethods[Symbol.dispose](); });
    return (await bundle.establishConnection(vscode.Uri.file(file), path.basename(file), false)).databaseOps;
}

const page = async (engine: DatabaseOperations): Promise<unknown[][]> =>
    (await engine.fetchTableData('entries', { columns: ['id', 'value'], limit: 10, offset: 0 })).rows;

describe('the native engine after Save As onto its own file', () => {
    // Off Windows nothing can say that a file keeps a list of its own. Reported as Windows for the one
    // call, the save cannot read the file's list (there is no icacls), which is the other way onto that
    // route: a file whose list is not known is written into. The call also takes Windows' other branches
    // in the save (its lock is let go before the commit), as it does there. The save holds the file
    // while it copies into it, by its path in Windows' extended form, which names nothing here: for
    // this one call that form is the path as it is.
    for (const route of ['replaces the file', 'writes into the file'] as const) {
        it(`goes on with the file that is there when the save ${route}`, { skip: process.platform === 'win32' && 'the real lists decide on Windows: see below' }, async t => {
            const { directory, closing } = scratch(t);
            const file = path.join(directory, 'test.db');
            seed(file);
            const log: string[] = [];
            const engine = await nativeEngine(t, file, log, closing);
            if (!engine) return;
            await engine.updateCell('entries', 2, 'value', 'edited');
            const before = fs.statSync(file, { bigint: true }).ino;

            const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
            const extended = path.win32.toNamespacedPath;
            try {
                if (route === 'writes into the file') {
                    Object.defineProperty(process, 'platform', { value: 'win32' });
                    path.win32.toNamespacedPath = given => given;
                }
                await engine.writeToFile!(file);
            } finally {
                Object.defineProperty(process, 'platform', real);
                path.win32.toNamespacedPath = extended;
            }

            assert.equal(fs.statSync(file, { bigint: true }).ino === before, route === 'writes into the file');
            assert.equal(valueOf(file, 2), 'edited');
            // The engine reads and edits the saved file, and its history is still there.
            assert.deepEqual(await page(engine), [[1, 'one'], [2, 'edited']]);
            await engine.updateCell('entries', 1, 'value', 'after the save');
            assert.equal(valueOf(file, 1), 'after the save');
            assert.deepEqual(log.filter(line => /could not be reopened|replaced, moved, deleted/.test(line)), []);
        });
    }
});

const onWindows = { skip: process.platform === 'win32' ? false : 'Windows access lists' };

describe('saving twice onto a file that keeps its own access list', onWindows, () => {
    const listOf = (file: string): string => {
        const listFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'access-list-test-')), 'list');
        try {
            const saved = spawnSync('icacls', [file, '/save', listFile], { encoding: 'utf8' });
            assert.equal(saved.status, 0, `${saved.stdout}${saved.stderr}`);
            return fs.readFileSync(listFile, 'utf16le').split(/\r?\n/)[1].trim();
        } finally {
            fs.rmSync(path.dirname(listFile), { recursive: true, force: true });
        }
    };
    /** A database with a list cut off from its folder's, or with the folder's. */
    const fixture = (t: TestContext, own: boolean, journal: string): { file: string; closing: Array<() => unknown> } => {
        const { directory, closing } = scratch(t);
        const file = path.join(directory, own ? 'own.db' : 'plain.db');
        seed(file);
        const mode = new DatabaseSync(file);
        try {
            assert.equal(mode.prepare(`PRAGMA journal_mode=${journal}`).get()?.journal_mode, journal);
        } finally {
            mode.close();
        }
        if (own) {
            const cut = spawnSync('icacls', [file, '/inheritance:r', '/grant:r', '*S-1-5-18:(F)', '*S-1-3-4:(F)'], { encoding: 'utf8' });
            assert.equal(cut.status, 0, `${cut.stdout}${cut.stderr}`);
        }
        return { file, closing };
    };

    for (const [own, journal] of [[true, 'delete'], [true, 'wal'], [false, 'delete']] as const) {
        const kind = `${own ? 'a list of its own' : 'its folder\'s list (the file is replaced)'}${journal === 'wal' ? ', in WAL mode' : ''}`;

        it(`the native engine, Save As onto its own file with ${kind}`, async t => {
            const { file, closing } = fixture(t, own, journal);
            const before = { list: listOf(file), id: fs.statSync(file, { bigint: true }).ino };
            const log: string[] = [];
            const engine = await nativeEngine(t, file, log, closing);
            if (!engine) return;

            for (const [save, value] of [[1, 'first'], [2, 'second']] as const) {
                await engine.updateCell('entries', 2, 'value', value);
                await engine.writeToFile!(file);
                assert.equal(valueOf(file, 2), value, `save ${save}`);
                assert.deepEqual(await page(engine), [[1, 'one'], [2, value]], `save ${save}`);
            }

            assert.equal(listOf(file), before.list);
            assert.equal(fs.statSync(file, { bigint: true }).ino === before.id, own);
            assert.deepEqual(log.filter(line => /could not be reopened|replaced, moved, deleted|could not be verified/.test(line)), []);
        });

        it(`the WebAssembly engine, Save onto the file it opened with ${kind}`, async t => {
            const { file, closing } = fixture(t, own, journal);
            const before = { list: listOf(file), id: fs.statSync(file, { bigint: true }).ino };
            const warnings: string[] = [];
            const engine = (await createDatabaseEngine({ content: null, filePath: file, maxSize: 0, readOnlyMode: false },
                (level, ...args) => { if (level === 'warn') warnings.push(args.map(String).join(' ')); })).operations as WasmDatabaseEngine;
            closing.push(() => engine.shutdown());

            for (const [save, value] of [[1, 'first'], [2, 'second']] as const) {
                await engine.updateCell('entries', 2, 'value', value);
                // A second save is refused when the first could not vouch for the file it left.
                await engine.writeToFile(file);
                assert.equal(valueOf(file, 2), value, `save ${save}`);
            }

            assert.equal(listOf(file), before.list);
            assert.equal(fs.statSync(file, { bigint: true }).ino === before.id, own);
            assert.deepEqual(warnings.filter(message => !/durability/.test(message)), []);
        });
    }
});

describe('saving twice onto a file that has access-control entries of its own (macOS, Linux)', { skip: NO_REAL_ENTRIES }, () => {
    // The system's own programs, whatever the other tests in this file use.
    const before = accessEntryTools.use;
    // On macOS with `ls` and `chmod`, the route these tests were written for; `posix_access_entries.test.ts`
    // holds the route through the stored list.
    beforeEach(() => { accessEntryTools.use = undefined; accessEntryTools.storedLists = false; });
    afterEach(() => { accessEntryTools.use = before; accessEntryTools.storedLists = undefined; });

    /** A database that its owner shares with one other account through an entry on the file. */
    const fixture = (t: TestContext, journal: string): { file: string; closing: Array<() => unknown>; own: string[]; forgeable: boolean } => {
        const { directory, closing } = scratch(t);
        const file = path.join(directory, 'shared.db');
        seed(file);
        const mode = new DatabaseSync(file);
        try {
            assert.equal(mode.prepare(`PRAGMA journal_mode=${journal}`).get()?.journal_mode, journal);
        } finally {
            mode.close();
        }
        shareWithOther(file);
        const own = entriesForOther(file);
        assert.equal(own.length, 1);
        // macOS reads the old file's entries by its name, so there it matters who else can rename on the way to it.
        return { file, closing, own, forgeable: process.platform === 'darwin' && othersCanRenameIn(fs, directory) !== undefined };
    };
    const notKept = /entries that let accounts in were not kept/;

    for (const journal of ['delete', 'wal'] as const) {
        it(`the native engine, Save As onto its own file${journal === 'wal' ? ', in WAL mode' : ''}`, async t => {
            const { file, closing, own, forgeable } = fixture(t, journal);
            const log: string[] = [];
            const engine = await nativeEngine(t, file, log, closing);
            if (!engine) return;

            for (const [save, value] of [[1, 'first'], [2, 'second']] as const) {
                const id = fs.statSync(file, { bigint: true }).ino;
                await engine.updateCell('entries', 2, 'value', value);
                await engine.writeToFile!(file);
                assert.equal(valueOf(file, 2), value, `save ${save}`);
                assert.deepEqual(await page(engine), [[1, 'one'], [2, value]], `save ${save}`);
                // Replaced by a new file. Compared save by save: a filesystem can give a later file the number of one that is gone.
                assert.notEqual(fs.statSync(file, { bigint: true }).ino, id, `save ${save}`);
            }

            // The new file has the old one's entries.
            assert.deepEqual(entriesForOther(file), forgeable ? [] : own);
            assert.equal(log.some(line => notKept.test(line)), forgeable);
            assert.deepEqual(log.filter(line => /could not be reopened|replaced, moved, deleted|could not be verified|could not be looked at/.test(line)), []);
        });
    }

    it('the WebAssembly engine, Save onto the file it opened', async t => {
        const { file, closing, own, forgeable } = fixture(t, 'delete');
        const warnings: string[] = [];
        const engine = (await createDatabaseEngine({ content: null, filePath: file, maxSize: 0, readOnlyMode: false },
            (level, ...args) => { if (level === 'warn') warnings.push(args.map(String).join(' ')); })).operations as WasmDatabaseEngine;
        closing.push(() => engine.shutdown());

        for (const [save, value] of [[1, 'first'], [2, 'second']] as const) {
            const id = fs.statSync(file, { bigint: true }).ino;
            await engine.updateCell('entries', 2, 'value', value);
            // A second save is refused when the first could not vouch for the file it left.
            await engine.writeToFile(file);
            assert.equal(valueOf(file, 2), value, `save ${save}`);
            assert.notEqual(fs.statSync(file, { bigint: true }).ino, id, `save ${save}`);
        }

        assert.deepEqual(entriesForOther(file), forgeable ? [] : own);
        assert.deepEqual(warnings.filter(message => !/durability/.test(message) && !notKept.test(message)), []);
    });
});

describe('the native engine, Save As into a folder other accounts can rename in', { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
    it('has its snapshot written in the temporary folder, and saves', async t => {
        const { directory, closing } = scratch(t);
        const source = path.join(directory, 'source.db');
        seed(source);
        // Every account may write this folder, and it is not sticky.
        const shared = path.join(directory, 'shared');
        fs.mkdirSync(shared);
        fs.chmodSync(shared, 0o777);
        const target = path.join(shared, 'private.db');
        seed(target);
        fs.chmodSync(target, 0o600);
        const log: string[] = [];
        // Where the engine is told to write its snapshot.
        const written: string[] = [];
        const original = NativeWorkerProcess.prototype.call;
        t.mock.method(NativeWorkerProcess.prototype, 'call', function (this: NativeWorkerProcess, ...args: Parameters<typeof original>) {
            if (args[0] === 'vacuumInto') written.push(String((args[1] as unknown[])[0]));
            return original.apply(this, args);
        });
        // How the save makes the file it copies the snapshot into, and by which path it opens it.
        const made: string[] = [];
        const madeByHelper = fs.constants.O_RDWR | fs.constants.O_NOFOLLOW;
        const open = fs.promises.open;
        t.mock.method(fs.promises, 'open', function (this: unknown, ...args: Parameters<typeof open>) {
            if (args[1] === 'wx+' || args[1] === madeByHelper) made.push(String(args[0]));
            return open.apply(fs.promises, args);
        });
        let helpers = 0;
        const start = childProcess.spawnSync;
        t.mock.method(childProcess, 'spawnSync', ((...args: unknown[]) => {
            if (args[0] === process.execPath) helpers++;
            return (start as (...given: unknown[]) => unknown)(...args);
        }) as typeof childProcess.spawnSync);
        const engine = await nativeEngine(t, source, log, closing);
        if (!engine) return;
        await engine.updateCell('entries', 2, 'value', 'edited');

        await engine.writeToFile!(target);

        assert.equal(written.length, 1);
        assert.equal(fs.realpathSync(path.dirname(path.dirname(written[0]))), fs.realpathSync(os.tmpdir()), written[0]);
        // On Linux through a descriptor of the directory it made beside the destination. Elsewhere a
        // helper process makes the file from inside that directory, and the save opens it by name.
        assert.equal(made.length, 1);
        if (process.platform === 'linux') assert.match(made[0], /^\/proc\/self\/fd\/\d+\/private\.db$/);
        else assert.equal(path.basename(path.dirname(made[0])).startsWith('.private.db.sqlite-explorer-'), true, made[0]);
        assert.equal(helpers, process.platform === 'linux' ? 0 : 1);
        assert.equal(valueOf(target, 2), 'edited');
        assert.equal(fs.statSync(target).mode & 0o777, 0o600);
        assert.deepEqual(fs.readdirSync(shared), ['private.db']);

        // In a folder no other account can rename in, the snapshot is written beside the destination, as
        // before. Not this checkout's own folders: where new folders are group-writable by default they
        // count as open to others. A fresh folder under the temporary one is this account's alone.
        const mine = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'save-in-place-own-')));
        closing.push(() => fs.promises.rm(mine, { recursive: true, force: true }));
        const own = path.join(mine, 'own.db');
        await engine.writeToFile!(own);
        assert.equal(fs.realpathSync(path.dirname(path.dirname(written[1]))), mine, written[1]);
        assert.equal(valueOf(own, 2), 'edited');
    });
});
