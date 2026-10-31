import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';
import { serializeOperations } from '../../src/core/operation-serializer';
import { importRowsAtomically } from '../../src/core/bulk-import';
import type { DatabaseOperations } from '../../src/core/types';

// The native worker builds result rows from objects keyed by column name, and
// JavaScript lists integer-like keys first. A WITHOUT ROWID key read back by
// position must not depend on its column names.

const SETUP = 'CREATE TABLE t ("b" TEXT, "1" TEXT, v TEXT, PRIMARY KEY ("b", "1")) WITHOUT ROWID; ' +
    "INSERT INTO t VALUES ('b0', 'one0', 'seed'); " +
    'CREATE TABLE r ("z" TEXT, "2" TEXT, "1" TEXT); ' +
    "INSERT INTO r VALUES ('z1', 'two1', 'one1'), ('z2', 'two2', 'one2');";

async function withBackend(backend: 'wasm' | 'native', action: (ops: DatabaseOperations) => Promise<void>) {
    const opened = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
    const wasm = opened.operations as WasmDatabaseEngine;
    let native: Awaited<ReturnType<typeof createNativeDatabaseConnection>> | undefined;
    let directory: string | undefined;
    try {
        await wasm.executeQuery(SETUP);
        let ops: DatabaseOperations = serializeOperations(wasm);
        if (backend === 'native') {
            fs.mkdirSync('.tmp', { recursive: true });
            directory = fs.mkdtempSync(path.resolve('.tmp/primary-key-names-'));
            const file = path.join(directory, 'fixture.db');
            fs.writeFileSync(file, await wasm.serializeDatabase());
            native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
            ops = (await native.establishConnection(vscode.Uri.file(file), 'primary-key-names', false)).databaseOps;
        }
        await action(ops);
    } finally {
        native?.workerMethods[Symbol.dispose](); wasm.shutdown();
        if (directory) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
}

// Aliased, because the native executeQuery orders its own result columns the
// same way.
const rows = async (ops: DatabaseOperations) => (
    (await ops.executeQuery('SELECT "b" AS kb, "1" AS k1, v FROM t ORDER BY "b"'))[0]?.rows ?? []
);
const rowidRows = async (ops: DatabaseOperations) => (
    (await ops.executeQuery('SELECT rowid AS id, "z" AS cz, "2" AS c2, "1" AS c1 FROM r ORDER BY rowid'))[0]?.rows ?? []
);

for (const backend of ['wasm', 'native'] as const) {
    it(`${backend} imports, adds and edits rows keyed by a column named like a number`, async () => {
        await withBackend(backend, async ops => {
            await importRowsAtomically(ops, 't', [{ b: 'b1', 1: 'one1', v: 'imported' }], 1 << 20);
            const added = await ops.insertRow('t', { b: 'b2', 1: 'one2', v: 'added' });
            assert.ok(added !== undefined, 'the added row has an identity');
            await ops.updateCellBatch('t', [{ rowId: added, column: 'v', value: 'edited' }]);
            assert.deepEqual(await rows(ops), [
                ['b0', 'one0', 'seed'],
                ['b1', 'one1', 'imported'],
                ['b2', 'one2', 'edited']
            ]);
        });
    });
}

for (const backend of ['wasm', 'native'] as const) {
    it(`${backend} undoes and redoes deletes and edits of columns named like numbers`, async () => {
        await withBackend(backend, async ops => {
            const keyed = await ops.insertRow('t', { b: 'b9', 1: 'one9', v: 'nine' });
            assert.ok(keyed !== undefined);
            for (const [table, read, rowIds] of [
                ['r', rowidRows, [1, 2]],
                ['t', rows, [keyed]]
            ] as const) {
                const stored = await read(ops);
                const deletedRows = await ops.deleteRows(table, [...rowIds]);
                const deletion = { modificationType: 'row_delete' as const, targetTable: table, description: 'Delete', deletedRows };
                await ops.undoModification(deletion);
                assert.deepEqual(await read(ops), stored, `${table}: undo of the delete`);
                await ops.redoModification(deletion);
                await ops.undoModification(deletion);
                assert.deepEqual(await read(ops), stored, `${table}: second undo of the delete`);
            }
            const affectedCells = await ops.updateCellBatch('r', [
                { rowId: 1, column: '1', value: 'x' }, { rowId: 1, column: '2', value: 'y' }, { rowId: 2, column: 'z', value: 'w' }
            ]);
            assert.deepEqual(await rowidRows(ops), [[1, 'z1', 'y', 'x'], [2, 'w', 'two2', 'one2']]);
            await ops.undoModification({ modificationType: 'cell_update', targetTable: 'r', description: 'Edit', affectedCells });
            assert.deepEqual(await rowidRows(ops), [[1, 'z1', 'two1', 'one1'], [2, 'z2', 'two2', 'one2']]);
        });
    });
}
