import './vscode_mock_setup';

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { it, mock, type TestContext } from 'node:test';
import * as vscode from 'vscode';
import { createNativeDatabaseConnection, NativeWorkerProcess } from '../../src/nativeWorker';
import { runReadSnapshot } from '../../src/core/operation-serializer';
import { importRowsAtomically } from '../../src/core/bulk-import';
import type { DatabaseOperations } from '../../src/core/types';
import { createDeferred } from './helpers/deferred';
import { DatabaseSync } from 'node:sqlite';

const reloadRequired = /database file.*(?:replaced|moved|deleted|changed|unavailable).*Reload Database/i;

async function fixture(t: TestContext) {
    const platformDirectory = process.platform === 'darwin'
        ? process.arch === 'arm64' ? 'aarch64-macos' : 'x86_64-macos'
        : process.platform === 'linux'
            ? process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu'
            : 'x86_64-windows';
    const binary = path.join(process.cwd(), 'natives', platformDirectory, process.platform === 'win32' ? 'tjs.exe' : 'tjs');
    if (!fs.existsSync(binary)) {
        t.skip('Bundled native runtime is unavailable on this platform');
        return;
    }
    const temporaryRoot = path.join(process.cwd(), '.tmp');
    fs.mkdirSync(temporaryRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'native-replacement-'));
    const source = path.join(directory, 'source.sqlite');
    const replacement = path.join(directory, 'replacement.sqlite');
    const seed = new NativeWorkerProcess(binary, path.join(process.cwd(), 'natives/native-worker.js'));
    await seed.start();
    try {
        for (const [file, value] of [[source, 'original'], [replacement, 'replacement']]) {
            fs.writeFileSync(file, new Uint8Array());
            await seed.call('open', [file, false]);
            await seed.call('exec', [
                'CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT);'
                + `INSERT INTO entries VALUES (1, '${value}');`
                + 'CREATE VIEW entry_view AS SELECT value FROM entries;'
            ]);
            await seed.call('close');
        }
    } finally {
        seed.stop();
    }
    const bundle = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
    t.after(() => {
        bundle.workerMethods[Symbol.dispose]();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const open = (file = source, readOnly = false) => bundle.establishConnection(vscode.Uri.file(file), 'source.sqlite', readOnly);
    return { directory, source, replacement, bundle, open };
}

/** Windows may enforce the invariant itself by refusing to replace an open file. */
async function replaceOpenFile(t: TestContext, source: string, replacement: string, operations: DatabaseOperations): Promise<boolean> {
    const sourceBytes = fs.readFileSync(source);
    const replacementBytes = fs.readFileSync(replacement);
    try {
        fs.renameSync(replacement, source);
        return true;
    } catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        assert.deepEqual(fs.readFileSync(source), sourceBytes);
        assert.deepEqual(fs.readFileSync(replacement), replacementBytes);
        assert.deepEqual((await operations.executeQuery('SELECT value FROM entries'))[0].rows, [['original']]);
        t.diagnostic('The OS refused atomic replacement of the open native file; both files and the original connection remain intact.');
        return false;
    }
}

it('refuses native reads and view edits after atomic replacement without touching the replacement', async t => {
    const f = await fixture(t); if (!f) return;
    const { databaseOps: operations } = await f.open();
    const view = await operations.getViewDefinition('entry_view');
    const originalIdentity = fs.statSync(f.source, { bigint: true });
    if (!await replaceOpenFile(t, f.source, f.replacement, operations)) return;
    assert.notEqual(fs.statSync(f.source, { bigint: true }).ino, originalIdentity.ino);
    const replacementBytes = fs.readFileSync(f.source);

    await assert.rejects(operations.executeQuery('SELECT value FROM entries'), reloadRequired);
    await assert.rejects(operations.editView('entry_view', 'SELECT upper(value) AS value FROM entries', true, view.sql, view.triggers), reloadRequired);
    await assert.rejects(operations.serializeDatabase(), reloadRequired);
    await assert.rejects(f.bundle.workerMethods.exportDatabase(), reloadRequired);
    assert.deepEqual(fs.readFileSync(f.source), replacementBytes);
});

it('reports Reload Database when Edit View is the first operation after native file replacement', async t => {
    const f = await fixture(t); if (!f) return;
    const { databaseOps: operations } = await f.open();
    const view = await operations.getViewDefinition('entry_view');
    if (!await replaceOpenFile(t, f.source, f.replacement, operations)) return;
    const replacementBytes = fs.readFileSync(f.source);
    await assert.rejects(
        operations.editView('entry_view', 'SELECT upper(value) AS value FROM entries', true, view.sql, view.triggers),
        reloadRequired
    );
    assert.deepEqual(fs.readFileSync(f.source), replacementBytes);
});

for (const boundary of ['open', 'query'] as const) {
    it(`refuses native results when replacement occurs during ${boundary}`, async t => {
        const f = await fixture(t); if (!f) return;
        const opened = boundary === 'query' ? await f.open() : undefined;
        const replacementBytes = fs.readFileSync(f.replacement);
        const originalCall = NativeWorkerProcess.prototype.call;
        let replaced = false, osRefused = false;
        const hook = mock.method(NativeWorkerProcess.prototype, 'call', async function (this: NativeWorkerProcess, ...args: Parameters<typeof originalCall>) {
            const result = await originalCall.apply(this, args);
            if (args[0] === boundary && !replaced && !osRefused) {
                try { fs.renameSync(f.replacement, f.source); replaced = true; }
                catch (error) {
                    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
                    osRefused = true;
                }
            }
            return result;
        });
        t.after(() => hook.mock.restore());
        const request = opened
            ? opened.databaseOps.executeQuery('SELECT value FROM entries')
            : f.open();
        const outcome = await Promise.resolve(request).then(value => ({ value }), error => ({ error }));
        hook.mock.restore();
        if (osRefused) {
            assert.ok('value' in outcome);
            assert.deepEqual(fs.readFileSync(f.replacement), replacementBytes);
            const operations = opened?.databaseOps ?? (outcome.value as Awaited<ReturnType<typeof f.open>>).databaseOps;
            assert.deepEqual((await operations.executeQuery('SELECT value FROM entries'))[0].rows, [['original']]);
            t.diagnostic(`The OS refused replacement during native ${boundary}; the original connection remains valid.`);
        } else {
            assert.equal(replaced, true);
            assert.ok('error' in outcome, 'native results from the retired inode must not escape their post-operation check');
            assert.match(String(outcome.error), reloadRequired);
            assert.deepEqual(fs.readFileSync(f.source), replacementBytes);
        }
    });
}

it('refuses native access after the open file is renamed away without recreating its path', async t => {
    const f = await fixture(t); if (!f) return;
    const { databaseOps: operations } = await f.open();
    const moved = path.join(f.directory, 'moved.sqlite');
    try { fs.renameSync(f.source, moved); }
    catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        assert.deepEqual((await operations.executeQuery('SELECT value FROM entries'))[0].rows, [['original']]);
        t.diagnostic('The OS refused to rename the open native database.');
        return;
    }
    const movedBytes = fs.readFileSync(moved);
    await assert.rejects(operations.executeQuery('UPDATE entries SET value = ? WHERE id = 1', ['lost write']), reloadRequired);
    assert.equal(fs.existsSync(f.source), false);
    assert.deepEqual(fs.readFileSync(moved), movedBytes);
});

it('refuses a retargeted symlink even when its original native file remains writable', async t => {
    const f = await fixture(t); if (!f) return;
    const alias = path.join(f.directory, 'alias.sqlite');
    try { fs.symlinkSync(f.source, alias); }
    catch (error) {
        if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
        t.diagnostic('The OS refused file symlink creation without privilege.');
        return;
    }
    const { databaseOps: operations } = await f.open(alias);
    const sourceBytes = fs.readFileSync(f.source), replacementBytes = fs.readFileSync(f.replacement);
    fs.unlinkSync(alias);
    fs.symlinkSync(f.replacement, alias);
    await assert.rejects(operations.executeQuery('UPDATE entries SET value = ? WHERE id = 1', ['lost write']), reloadRequired);
    assert.deepEqual(fs.readFileSync(f.source), sourceBytes);
    assert.deepEqual(fs.readFileSync(f.replacement), replacementBytes);
});

it('checks native snapshot callbacks again after a replacement between reads', async t => {
    const f = await fixture(t); if (!f) return;
    const { databaseOps: operations } = await f.open();
    let replaced = false;
    const snapshot = runReadSnapshot(operations, async transaction => {
        assert.deepEqual((await transaction.executeQuery('SELECT value FROM entries'))[0].rows, [['original']]);
        replaced = await replaceOpenFile(t, f.source, f.replacement, transaction);
        return transaction.executeQuery('SELECT value FROM entries');
    });
    const outcome = await snapshot.then(value => ({ value }), error => ({ error }));
    if (replaced) {
        assert.ok('error' in outcome);
        assert.match(String(outcome.error), reloadRequired);
    } else {
        assert.ok('value' in outcome);
        assert.deepEqual(outcome.value[0].rows, [['original']]);
    }
});

it('checks native operations after queue admission when replacement happens behind a snapshot', async t => {
    const f = await fixture(t); if (!f) return;
    const { databaseOps: operations } = await f.open();
    const started = createDeferred<void>(), resume = createDeferred<void>();
    t.after(() => resume.resolve());
    const snapshot = runReadSnapshot(operations, async transaction => {
        assert.deepEqual((await transaction.executeQuery('SELECT value FROM entries'))[0].rows, [['original']]);
        started.resolve();
        await resume.promise;
    });
    const settledSnapshot = snapshot.then(() => undefined, error => error);
    await started.promise;
    const queued = operations.executeQuery('SELECT value FROM entries');
    const settledQueued = queued.then(value => ({ value }), error => ({ error }));
    let replaced = false;
    const replacementBytes = fs.readFileSync(f.replacement);
    try { fs.renameSync(f.replacement, f.source); replaced = true; }
    catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        assert.deepEqual(fs.readFileSync(f.replacement), replacementBytes);
        t.diagnostic('The OS refused atomic replacement while a native snapshot was open.');
    } finally { resume.resolve(); }
    const [snapshotError, result] = await Promise.all([settledSnapshot, settledQueued]);
    if (replaced) {
        assert.match(String(snapshotError), reloadRequired);
        assert.ok('error' in result);
        assert.match(String(result.error), reloadRequired);
    } else {
        assert.equal(snapshotError, undefined);
        assert.ok('value' in result);
        assert.deepEqual(result.value[0].rows, [['original']]);
    }
});

it('refuses native atomic save when the source is replaced after save admission', async t => {
    const f = await fixture(t); if (!f) return;
    const { databaseOps: operations } = await f.open();
    const replacementBytes = fs.readFileSync(f.replacement);
    const originalStat = fs.promises.stat;
    let replaced = false, osRefused = false;
    const statHook = mock.method(fs.promises, 'stat', async (...args: Parameters<typeof fs.promises.stat>) => {
        if (String(args[0]) === `${f.source}-wal` && !replaced && !osRefused) {
            try { fs.renameSync(f.replacement, f.source); replaced = true; }
            catch (error) {
                if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
                osRefused = true;
            }
        }
        return originalStat(...args);
    });
    t.after(() => statHook.mock.restore());
    const outcome = await operations.writeToFile(f.source).then(value => ({ value }), error => ({ error }));
    if (osRefused) {
        assert.ok('value' in outcome);
        assert.deepEqual(fs.readFileSync(f.replacement), replacementBytes);
        assert.deepEqual((await operations.executeQuery('SELECT value FROM entries'))[0].rows, [['original']]);
        t.diagnostic('The OS refused replacement during native save; the source remains authoritative.');
    } else {
        assert.equal(replaced, true);
        assert.ok('error' in outcome, 'a save must not adopt and overwrite a file that replaced its native source');
        assert.match(String(outcome.error), reloadRequired);
        assert.deepEqual(fs.readFileSync(f.source), replacementBytes);
    }
});

it('refuses previously opened native cell sessions and imports after replacement', async t => {
    const f = await fixture(t); if (!f) return;
    const { databaseOps: operations } = await f.open();
    const session = await operations.openCellReadSession!({ table: 'entries', column: 'value', rowId: 1 });
    if (!await replaceOpenFile(t, f.source, f.replacement, operations)) return;
    const replacementBytes = fs.readFileSync(f.source);
    await assert.rejects(operations.readCellChunk!(session.sessionId, 0, 64), reloadRequired);
    await assert.rejects(importRowsAtomically(operations, 'entries', [{ value: 'lost import' }], 1024 * 1024), reloadRequired);
    assert.deepEqual(fs.readFileSync(f.source), replacementBytes);
});

it('keeps same-inode native DML and owned atomic save reopening usable', async t => {
    const f = await fixture(t); if (!f) return;
    const { databaseOps: operations } = await f.open();
    const initialIdentity = fs.statSync(f.source, { bigint: true });
    await operations.executeQuery('UPDATE entries SET value = ? WHERE id = 1', ['edited']);
    assert.equal(fs.statSync(f.source, { bigint: true }).ino, initialIdentity.ino);
    assert.deepEqual((await operations.executeQuery('SELECT value FROM entries'))[0].rows, [['edited']]);
    await operations.writeToFile(f.source);
    await operations.executeQuery('UPDATE entries SET value = ? WHERE id = 1', ['after save']);
    assert.deepEqual((await operations.executeQuery('SELECT value FROM entries'))[0].rows, [['after save']]);
});

it('accepts an external SQLite write that changes size and timestamps without replacing the file', async t => {
    const f = await fixture(t); if (!f) return;
    const { databaseOps: operations } = await f.open();
    const before = fs.statSync(f.source, { bigint: true });
    const writer = new DatabaseSync(f.source);
    try { writer.prepare('UPDATE entries SET value = ? WHERE id = 1').run('external '.repeat(100_000)); }
    finally { writer.close(); }
    const after = fs.statSync(f.source, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.ok(after.size > before.size);
    assert.deepEqual((await operations.executeQuery('SELECT length(value) FROM entries'))[0].rows, [[900_000]]);
    await operations.executeQuery('UPDATE entries SET value = ? WHERE id = 1', ['still usable']);
    assert.deepEqual((await operations.executeQuery('SELECT value FROM entries'))[0].rows, [['still usable']]);
});

it('keeps an explicitly read-only native connection read-only with identity checks', async t => {
    const f = await fixture(t); if (!f) return;
    const { databaseOps: operations, isReadOnly } = await f.open(f.source, true);
    assert.equal(isReadOnly, true);
    const sourceBytes = fs.readFileSync(f.source);
    assert.deepEqual((await operations.executeQuery('SELECT value FROM entries'))[0].rows, [['original']]);
    await assert.rejects(operations.executeQuery('UPDATE entries SET value = ? WHERE id = 1', ['forbidden']), /readonly|read-only/i);
    assert.deepEqual(fs.readFileSync(f.source), sourceBytes);
});
