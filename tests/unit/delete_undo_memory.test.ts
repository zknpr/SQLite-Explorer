import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';
import { serializeOperations, runReadSnapshot } from '../../src/core/operation-serializer';
import { estimateUndoMemoryBytes, ModificationTracker, SharedStorageClassLists } from '../../src/core/undo-history';
import { encodePrimaryKeyRecordId } from '../../src/core/row-identity';
import type { DatabaseOperations, DeletedRow, LabeledModification, RecordId } from '../../src/core/types';

const ROWS = 2000;
// A NULL pattern from the low four bits of the id gives the snapshots
// sixteen storage-class lists, so a delete that counted one list for all of
// its rows would admit more than its entry holds.
const FILL = (table: string) => `WITH RECURSIVE s(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM s WHERE x < ${ROWS}) ` +
    `INSERT INTO ${table} SELECT x, CASE WHEN x & 1 THEN NULL ELSE 'user_' || x END, ` +
    `CASE WHEN x & 2 THEN NULL ELSE 'user' || x || '@example.com' END, ` +
    `CASE WHEN x & 4 THEN NULL ELSE x * 1.5 + 0.25 END, CASE WHEN x & 8 THEN NULL ELSE '2026-11-27' END FROM s`;
const TABLES = {
    rowid: {
        schema: 'CREATE TABLE t (id INTEGER, name TEXT, email TEXT, amount REAL, created TEXT)',
        rowIds: (): RecordId[] => Array.from({ length: ROWS }, (_, index) => index + 1)
    },
    primaryKey: {
        schema: 'CREATE TABLE t (id INTEGER NOT NULL PRIMARY KEY, name TEXT, email TEXT, amount REAL, created TEXT) WITHOUT ROWID',
        rowIds: (): RecordId[] => Array.from({ length: ROWS }, (_, index) => encodePrimaryKeyRecordId(
            [{ identifier: 'id', declaredType: 'INTEGER', position: 1 }], [BigInt(index + 1)]
        ))
    }
};

async function withBackend(backend: 'wasm' | 'native', schema: string, action: (ops: DatabaseOperations) => Promise<void>) {
    const wasm = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
    let native: Awaited<ReturnType<typeof createNativeDatabaseConnection>> | undefined;
    let directory: string | undefined;
    try {
        await wasm.executeQuery(schema);
        await wasm.executeQuery(FILL('t'));
        let ops: DatabaseOperations = serializeOperations(wasm);
        if (backend === 'native') {
            fs.mkdirSync('.tmp', { recursive: true });
            directory = fs.mkdtempSync(path.resolve('.tmp/delete-undo-memory-'));
            const file = path.join(directory, 'fixture.db');
            fs.writeFileSync(file, await wasm.serializeDatabase());
            native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
            ops = (await native.establishConnection(vscode.Uri.file(file), 'delete-undo-memory', false)).databaseOps;
        }
        await action(ops);
    } finally {
        native?.workerMethods[Symbol.dispose](); wasm.shutdown();
        if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
}

async function contents(ops: DatabaseOperations): Promise<unknown[][]> {
    const [result] = await ops.executeQuery('SELECT id, name, email, amount, created, typeof(amount) FROM t ORDER BY id');
    return result?.rows ?? [];
}

/** The snapshots a delete takes, in a savepoint that is then rolled back. */
async function snapshotsOf(ops: DatabaseOperations, rowIds: RecordId[]): Promise<DeletedRow[]> {
    let snapshots: DeletedRow[] = [];
    await runReadSnapshot(ops, async transaction => {
        snapshots = await transaction.deleteRows('t', rowIds);
        throw new Error('rollback');
    }).catch(error => { if ((error as Error).message !== 'rollback') throw error; });
    return snapshots;
}

for (const backend of ['wasm', 'native'] as const) {
    for (const [kind, table] of Object.entries(TABLES)) {
        it(`${backend} ${kind}: a delete is admitted at exactly the size its entry is counted, and refused one byte under it`, async () => {
            await withBackend(backend, table.schema, async ops => {
                const before = await contents(ops);
                const rowIds = table.rowIds();
                const lists = new SharedStorageClassLists();
                const snapshotBytes = (await snapshotsOf(ops, rowIds))
                    .reduce((sum, snapshot) => sum + lists.charge(snapshot), 0);
                assert.deepEqual(await contents(ops), before);

                await assert.rejects(ops.deleteRows('t', rowIds, snapshotBytes - 1), /Delete undo snapshot exceeds/);
                assert.deepEqual(await contents(ops), before, 'a refused delete removed rows');

                const modification = {
                    label: 'Delete Rows', description: `Delete ${ROWS} rows from t`, modificationType: 'row_delete',
                    targetTable: 't', affectedRowIds: rowIds, deletedRows: [] as DeletedRow[]
                } as LabeledModification;
                const base = estimateUndoMemoryBytes(modification);
                modification.deletedRows = await ops.deleteRows('t', rowIds, snapshotBytes);
                assert.deepEqual(await contents(ops), []);
                const tracker = new ModificationTracker<LabeledModification>(100, base + snapshotBytes);
                tracker.record(modification);
                assert.equal((tracker as unknown as { currentSize: number }).currentSize, base + snapshotBytes);

                await ops.undoModification(modification);
                assert.deepEqual(await contents(ops), before, 'undo');
                await ops.redoModification(modification);
                assert.deepEqual(await contents(ops), [], 'redo');
            });
        });
    }
}
