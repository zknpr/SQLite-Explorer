import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { mockVscode } from './mocks/vscode';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { runReadSnapshot } from '../../src/core/operation-serializer';
import { estimateUndoMemoryBytes, ModificationTracker, SharedStorageClassLists } from '../../src/core/undo-history';
import { importRowsAtomically } from '../../src/core/bulk-import';
import type { DatabaseConnectionBundle } from '../../src/connectionTypes';
import type { CellValue, DeletedRow, LabeledModification } from '../../src/core/types';

/**
 * Import and delete history through the WebAssembly engine in a real worker
 * thread, as the desktop host runs it: snapshots cross the worker boundary by
 * structured clone, and a refusal arrives as a message the host must still
 * recognize. The worker runs src/databaseWorker.ts.
 */

const repoRoot = path.resolve(__dirname, '../..');
const vendorWasm = path.join(repoRoot, 'vendor', 'sql.js', 'sql-wasm.wasm');
const wasmAssetPath = path.join(repoRoot, 'assets', 'sqlite3.wasm');

const originalRequire = Module.prototype.require;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module.prototype as any).require = function (this: unknown, id: string) {
    if (id === './main') return { GlobalOutputChannel: { appendLine: () => undefined } };
    if (id === './platform/threadPool') {
        const threadPool = originalRequire.call(this, id) as typeof import('../../src/platform/threadPool');
        const RealWorker = threadPool.Worker as unknown as new (file: string) => object;
        return {
            ...threadPool,
            Worker: class extends RealWorker {
                constructor() { super(path.join(repoRoot, 'src', 'databaseWorker.ts')); }
            }
        };
    }
    return originalRequire.call(this, id);
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const factory = require('../../src/workerFactory') as typeof import('../../src/workerFactory');
Module.prototype.require = originalRequire;

function fileUri(fsPath: string): import('vscode').Uri {
    return {
        scheme: 'file', authority: '', path: fsPath, query: '', fragment: '', fsPath,
        with({ path: nextPath }: { path: string }) { return fileUri(nextPath); },
        toString: () => `file://${fsPath}`
    } as unknown as import('vscode').Uri;
}

const originalFs = mockVscode.workspace.fs;
let directory: string;
let bundle: DatabaseConnectionBundle | undefined;

before(() => {
    fs.mkdirSync(path.join(repoRoot, '.tmp'), { recursive: true });
    directory = fs.mkdtempSync(path.join(repoRoot, '.tmp', 'wasm-worker-history-'));
    Object.defineProperty(mockVscode.workspace, 'fs', {
        value: {
            ...originalFs,
            stat: async (uri: { fsPath: string }) => {
                const stats = await fs.promises.stat(uri.fsPath);
                return { type: stats.isFile() ? 1 : 2, ctime: stats.ctimeMs, mtime: stats.mtimeMs, size: stats.size };
            },
            // The mock's joinPath joins with '/', so compare resolved paths.
            readFile: async (uri: { fsPath: string }) => new Uint8Array(
                await fs.promises.readFile(path.resolve(uri.fsPath) === wasmAssetPath ? vendorWasm : uri.fsPath)
            )
        },
        writable: true,
        configurable: true
    });
    factory.setDesktopTestDatabaseBackend('wasm');
});

after(() => {
    try { bundle?.workerMethods[Symbol.dispose](); } catch { /* already disposed */ }
    factory.setDesktopTestDatabaseBackend(undefined);
    Object.defineProperty(mockVscode.workspace, 'fs', { value: originalFs, writable: true, configurable: true });
    fs.rmSync(directory, { recursive: true, force: true });
});

it('an import and a delete are held to their undo budgets through the worker, and a restored entry replays there', async () => {
    const seed = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
    const file = path.join(directory, 'history.db');
    try {
        await seed.executeQuery('CREATE TABLE t (id INTEGER, name TEXT, email TEXT, amount REAL, created TEXT)');
        fs.writeFileSync(file, await seed.serializeDatabase());
    } finally {
        seed.shutdown();
    }
    bundle = await factory.createDatabaseConnection(fileUri(repoRoot));
    const connection = await bundle.establishConnection(fileUri(file), 'history.db', false, false);
    const ops = connection.databaseOps;
    assert.equal(await ops.engineKind, 'wasm');
    assert.notEqual(connection.isReadOnly, true);
    const count = async () => Number((await ops.executeQuery('SELECT count(*) FROM t'))[0].rows[0][0]);

    const rows: Record<string, CellValue>[] = Array.from({ length: 5000 }, (_, i) => ({
        id: i, name: i % 7 === 0 ? null : 'user_' + i, email: 'user' + i + '@example.com', amount: i * 1.5 + 0.25, created: '2026-11-27'
    }));
    const budget = 52_428_800 / 20;
    const modification = await importRowsAtomically(ops, 't', rows, budget);
    assert.ok(estimateUndoMemoryBytes(modification) <= budget);
    assert.equal(new Set(modification.insertedRows!.map(row => row.storageClasses)).size, 2);

    // The engine's refusal crosses the worker as text and is still read as one.
    await ops.undoModification(modification);
    await assert.rejects(importRowsAtomically(ops, 't', rows, budget / 20),
        /Import needs more undo memory than sqliteExplorer\.maxUndoMemory allows \(131,072 bytes\): the history of [\d,]+ of its 5,000 rows fit/);
    assert.equal(await count(), 0);
    await ops.redoModification(modification);
    assert.equal(await count(), 5000);

    const rowIds = Array.from({ length: 5000 }, (_, i) => i + 1);
    let snapshots: DeletedRow[] = [];
    await runReadSnapshot(ops, async transaction => {
        snapshots = await transaction.deleteRows('t', rowIds);
        throw new Error('rollback');
    }).catch(error => { if ((error as Error).message !== 'rollback') throw error; });
    const lists = new SharedStorageClassLists();
    const snapshotBytes = snapshots.reduce((sum, snapshot) => sum + lists.charge(snapshot), 0);
    await assert.rejects(ops.deleteRows('t', rowIds, snapshotBytes - 1), /Delete undo snapshot exceeds/);
    assert.equal(await count(), 5000);
    const deletedRows = await ops.deleteRows('t', rowIds, snapshotBytes);
    assert.equal(await count(), 0);

    const entry = { label: 'Delete Rows', modificationType: 'row_delete', targetTable: 't', affectedRowIds: rowIds, deletedRows } as LabeledModification;
    const tracker = new ModificationTracker<LabeledModification>(100, 1 << 30);
    tracker.record(entry);
    const restored = ModificationTracker.deserialize<LabeledModification>(tracker.serialize('wasm'), 100, 1 << 30);
    await ops.undoModification(restored.stepBack()!);
    assert.equal(await count(), 5000);
});
