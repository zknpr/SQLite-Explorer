import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';
import { serializeOperations, runReadSnapshot } from '../../src/core/operation-serializer';
import { estimateUndoMemoryBytes } from '../../src/core/undo-history';
import { importRowsAtomically } from '../../src/core/bulk-import';
import type { CellValue, DatabaseOperations, DeletedRow } from '../../src/core/types';

async function withBackend(
    backend: 'wasm' | 'native',
    setup: string,
    action: (ops: DatabaseOperations) => Promise<void>
) {
    const opened = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
    const wasm = opened.operations as WasmDatabaseEngine;
    let native: Awaited<ReturnType<typeof createNativeDatabaseConnection>> | undefined;
    let directory: string | undefined;
    try {
        await wasm.executeQuery(setup);
        let ops: DatabaseOperations = serializeOperations(wasm);
        if (backend === 'native') {
            fs.mkdirSync('.tmp', { recursive: true });
            directory = fs.mkdtempSync(path.resolve('.tmp/import-batch-'));
            const file = path.join(directory, 'fixture.db');
            fs.writeFileSync(file, await wasm.serializeDatabase());
            native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
            ops = (await native.establishConnection(vscode.Uri.file(file), 'batch', false)).databaseOps;
        }
        await action(ops);
    } finally {
        native?.workerMethods[Symbol.dispose](); wasm.shutdown();
        if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
}

/** The pre-batch import loop: one guarded single-row call per row against the remaining budget. */
async function insertOneByOne(
    ops: DatabaseOperations, table: string, rows: Record<string, CellValue>[], budget: number
): Promise<DeletedRow[]> {
    let remaining = budget;
    const snapshots: DeletedRow[] = [];
    for (const row of rows) {
        const snapshot = await ops.insertRowWithHistory!(table, row, undefined, remaining);
        remaining -= estimateUndoMemoryBytes(snapshot);
        if (remaining < 0) throw new Error('over budget');
        snapshots.push(snapshot);
    }
    return snapshots;
}

async function attempt(ops: DatabaseOperations, insert: (ops: DatabaseOperations) => Promise<DeletedRow[]>) {
    // Roll back every attempt so each budget starts from the same empty table.
    let outcome: { snapshots?: DeletedRow[]; error?: unknown } = {};
    await runReadSnapshot(ops, async transaction => {
        try { outcome = { snapshots: await insert(transaction) }; } catch (error) { outcome = { error }; }
        throw new Error('rollback');
    }).catch(error => { if ((error as Error).message !== 'rollback') throw error; });
    return outcome;
}

const SCHEMAS = {
    rowid: "CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT DEFAULT 'default', doubled INTEGER GENERATED ALWAYS AS (id * 2) STORED)",
    primaryKey: "CREATE TABLE items (id INTEGER NOT NULL, value TEXT DEFAULT 'default', doubled INTEGER GENERATED ALWAYS AS (id * 2) STORED, PRIMARY KEY (id)) WITHOUT ROWID"
};

for (const backend of ['wasm', 'native'] as const) {
    for (const [kind, schema] of Object.entries(SCHEMAS)) {
        it(`${backend} ${kind} batch history matches successive single-row inserts at every budget near the cutoff`, async () => {
            // Non-ASCII TEXT makes the projected preflight size differ from the
            // exact tracker size, which is where a batched check could diverge.
            const rows = Array.from({ length: 30 }, (_, index) => ({ id: index + 1, value: 'é'.repeat(index * 7) + 'x'.repeat(index % 5) }));
            await withBackend(backend, schema, async ops => {
                const reference = await attempt(ops, transaction => insertOneByOne(transaction, 'items', rows, 1 << 30));
                assert.ok(reference.snapshots, String(reference.error));
                const total = reference.snapshots.reduce((sum, snapshot) => sum + estimateUndoMemoryBytes(snapshot), 0);
                const firstRows = reference.snapshots.slice(0, 3).reduce((sum, snapshot) => sum + estimateUndoMemoryBytes(snapshot), 0);
                const budgets = [0, 1, firstRows - 1, firstRows, firstRows + 1];
                for (let budget = total - 400; budget <= total + 40; budget += 9) budgets.push(budget);
                budgets.push(total - 1, total, total + 1);
                for (const budget of budgets) {
                    const single = await attempt(ops, transaction => insertOneByOne(transaction, 'items', rows, budget));
                    const batch = await attempt(ops, async transaction => {
                        const snapshots = await transaction.insertRowsWithHistory!('items', rows, undefined, budget);
                        const used = snapshots.reduce((sum, snapshot) => sum + estimateUndoMemoryBytes(snapshot), 0);
                        if (used > budget) throw new Error('batch returned history beyond its budget');
                        return snapshots;
                    });
                    assert.equal(batch.error === undefined, single.error === undefined,
                        `budget ${budget}: single ${single.error ?? 'accepted'}, batch ${batch.error ?? 'accepted'}`);
                    if (batch.snapshots) assert.deepEqual(batch.snapshots, single.snapshots);
                }
            });
        });
    }

    it(`${backend} import applies each row's own columns within one batch and round-trips undo/redo`, async () => {
        await withBackend(backend, SCHEMAS.rowid, async ops => {
            const rows: Record<string, CellValue>[] = [
                { id: 1 }, { id: 2, value: 'two' }, { value: 'auto' }, {}, { id: 9, value: null }, { id: 10 }
            ];
            const modification = await importRowsAtomically(ops, 'items', rows, 1024 * 1024);
            const read = async () => (await ops.executeQuery('SELECT id, value, doubled FROM items ORDER BY id'))[0]?.rows ?? [];
            const imported = [[1, 'default', 2], [2, 'two', 4], [3, 'auto', 6], [4, 'default', 8], [9, null, 18], [10, 'default', 20]];
            assert.deepEqual(await read(), imported);
            assert.deepEqual(modification.insertedRows!.map(snapshot => snapshot.row.value), ['default', 'two', 'auto', 'default', null, 'default']);
            await ops.undoModification(modification);
            assert.deepEqual(await read(), []);
            await ops.redoModification(modification);
            assert.deepEqual(await read(), imported);
        });
    });

    it(`${backend} import spanning several batches keeps row order, history and progress`, async () => {
        await withBackend(backend, SCHEMAS.primaryKey, async ops => {
            const rows = Array.from({ length: 1234 }, (_, index) => ({ id: 1234 - index, value: index % 3 ? `v${index}` : null }));
            const reported: number[] = [];
            const modification = await importRowsAtomically(ops, 'items', rows, 16 * 1024 * 1024, undefined, completed => reported.push(completed));
            assert.deepEqual(reported, rows.map((_, index) => index + 1));
            // WASM history keeps INTEGER as bigint; native returns numbers.
            assert.deepEqual(modification.insertedRows!.map(snapshot => Number(snapshot.row.id)), rows.map(row => row.id));
            const count = async () => (await ops.executeQuery('SELECT count(*), sum(doubled) FROM items'))[0].rows[0];
            assert.deepEqual(await count(), [1234, 1234 * 1235]);
            await ops.undoModification(modification);
            assert.deepEqual(await count(), [0, null]);
            await ops.redoModification(modification);
            assert.deepEqual(await count(), [1234, 1234 * 1235]);
        });
    });
}
