import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection, isNativeAvailable, NativeWorkerProcess } from '../../src/nativeWorker';
import { serializeOperations, runReadSnapshot } from '../../src/core/operation-serializer';
import { estimateUndoMemoryBytes, ModificationTracker, SharedStorageClassLists } from '../../src/core/undo-history';
import { encodePrimaryKeyRecordId } from '../../src/core/row-identity';
import { projectDeleteSnapshotBytes } from '../../src/core/delete-history';
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

/** Skips a native case where no bundled runtime runs, as the other native tests do. */
async function skipWithoutNative(context: TestContext): Promise<boolean> {
    if (await isNativeAvailable(process.cwd())) return false;
    if (process.env.FUZZ_EXPECT_TARGET) throw new Error(`Missing native runtime for ${process.env.FUZZ_EXPECT_TARGET}`);
    context.skip('Bundled native runtime unavailable');
    return true;
}

async function withBackend(backend: 'wasm' | 'native', schema: string, action: (ops: DatabaseOperations) => Promise<void>, fill = FILL('t')) {
    const wasm = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
    let native: Awaited<ReturnType<typeof createNativeDatabaseConnection>> | undefined;
    let directory: string | undefined;
    try {
        await wasm.executeQuery(schema);
        await wasm.executeQuery(fill);
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
        it(`${backend} ${kind}: a delete is admitted at exactly the size its entry is counted, and refused one byte under it`, async (context) => {
            if (backend === 'native' && await skipWithoutNative(context)) return;
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

/**
 * Every SQL text the engines send while action runs. A snapshot read projects
 * each TEXT value as its bytes (buildStoredCellStateProjection); the size
 * query does not.
 */
async function sqlSent(action: () => Promise<unknown>): Promise<string[]> {
    const sent: string[] = [];
    const engine = WasmDatabaseEngine.prototype as unknown as { queryRaw: (sql: string, params?: unknown[]) => unknown };
    const queryRaw = engine.queryRaw;
    const call = NativeWorkerProcess.prototype.call;
    engine.queryRaw = function (this: unknown, sql: string, params?: unknown[]) { sent.push(sql); return queryRaw.call(this, sql, params); };
    NativeWorkerProcess.prototype.call = function (this: NativeWorkerProcess, ...args: Parameters<typeof call>) {
        const [, payload] = args as unknown as [string, unknown[]];
        if (typeof payload?.[0] === 'string') sent.push(payload[0]);
        return call.apply(this, args);
    } as typeof call;
    try {
        await action();
    } finally {
        engine.queryRaw = queryRaw;
        NativeWorkerProcess.prototype.call = call;
    }
    return sent;
}

// Twelve columns that are NULL by the bits of the id: each of 2,000 rows has a
// storage-class list of its own.
const LISTS_SCHEMA = 'CREATE TABLE t (id INTEGER PRIMARY KEY, ' +
    Array.from({ length: 12 }, (_, k) => `c${k} TEXT`).join(', ') + ')';
const LISTS_FILL = `WITH RECURSIVE s(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM s WHERE x < ${ROWS}) ` +
    'INSERT INTO t SELECT x, ' + Array.from({ length: 12 }, (_, k) => `CASE WHEN x & ${1 << k} THEN NULL ELSE 'v' END`).join(', ') + ' FROM s';

for (const backend of ['wasm', 'native'] as const) {
    it(`${backend}: a delete whose rows hold many storage-class lists is refused before its rows are read, and admitted at its entry's size`, async (context) => {
        if (backend === 'native' && await skipWithoutNative(context)) return;
        await withBackend(backend, LISTS_SCHEMA, async ops => {
            const rowIds = TABLES.rowid.rowIds();
            const lists = new SharedStorageClassLists();
            const snapshots = await snapshotsOf(ops, rowIds);
            assert.equal(new Set(snapshots.map(snapshot => JSON.stringify(snapshot.storageClasses))).size, ROWS);
            const snapshotBytes = snapshots.reduce((sum, snapshot) => sum + lists.charge(snapshot), 0);

            // Half the entry: a projection that counted one list for every row
            // would pass it and read every row before the exact charge refused.
            const sent = await sqlSent(() => assert.rejects(ops.deleteRows('t', rowIds, Math.floor(snapshotBytes / 2)), /Delete undo snapshot exceeds/));
            assert.ok(sent.some(sql => sql.includes('COUNT(*)')), 'the size query ran');
            assert.deepEqual(sent.filter(sql => sql.includes('AS BLOB) ELSE')), [], 'rows were read before the refusal');
            assert.equal((await ops.executeQuery('SELECT count(*) FROM t'))[0].rows[0][0], ROWS);

            await assert.rejects(ops.deleteRows('t', rowIds, snapshotBytes - 1), /Delete undo snapshot exceeds/);
            assert.equal((await ops.deleteRows('t', rowIds, snapshotBytes)).length, ROWS);
            assert.equal((await ops.executeQuery('SELECT count(*) FROM t'))[0].rows[0][0], 0);
        }, LISTS_FILL);
    });
}

// Two identity chunks (32,765 rowids each at most) whose rows hold different
// lists: 2,000 rows of each spell twelve bits in c0..c11, and c12 is NULL only
// in the second chunk.
const CHUNK_ROWS = 32_765;
const SPLIT_ROWS = CHUNK_ROWS + 2000;
const SPLIT_SCHEMA = 'CREATE TABLE t (id INTEGER PRIMARY KEY, ' +
    Array.from({ length: 13 }, (_, k) => `c${k} TEXT`).join(', ') + ')';
const SPLIT_FILL = `WITH RECURSIVE s(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM s WHERE x < ${SPLIT_ROWS}) ` +
    'INSERT INTO t SELECT x, ' + Array.from({ length: 12 }, (_, k) =>
        `CASE WHEN x <= 2000 AND x & ${1 << k} THEN NULL WHEN x > ${CHUNK_ROWS} AND (x - ${CHUNK_ROWS}) & ${1 << k} THEN NULL ELSE 'v' END`
    ).join(', ') + `, CASE WHEN x > ${CHUNK_ROWS} THEN NULL ELSE 'v' END FROM s`;

for (const backend of ['wasm', 'native'] as const) {
    it(`${backend}: a delete whose identity chunks hold different lists counts them all before it reads its rows`, async (context) => {
        if (backend === 'native' && await skipWithoutNative(context)) return;
        await withBackend(backend, SPLIT_SCHEMA, async ops => {
            const rowIds: RecordId[] = Array.from({ length: SPLIT_ROWS }, (_, index) => index + 1);
            const snapshots = await snapshotsOf(ops, rowIds);
            const listsIn = (rows: DeletedRow[]) => new Set(rows.map(row => JSON.stringify(row.storageClasses))).size;
            const [first, second] = [snapshots.filter(row => Number(row.rowId) <= CHUNK_ROWS), snapshots.filter(row => Number(row.rowId) > CHUNK_ROWS)];
            assert.equal(listsIn(snapshots), listsIn(first) + listsIn(second), 'the chunks share no list');
            const columns = Object.keys(snapshots[0].row);
            const valueBytes = snapshots.reduce((sum, snapshot) => sum + snapshot.storageClasses!.reduce((bytes, { column, storageClass }) =>
                bytes + (storageClass === 'text' ? 2 * Buffer.byteLength(snapshot.row[column] as string, 'utf8') : storageClass === 'null' ? 0 : 8), 0), 0);
            const projected = (storageClassListCount: number) => projectDeleteSnapshotBytes({
                insertableColumns: columns, rowIds, rowCount: SPLIT_ROWS, valueBytes, storageClassListCount
            });
            // A budget the lists of the larger chunk fit and those of both do not.
            const low = projected(Math.max(listsIn(first), listsIn(second)));
            const high = projected(listsIn(first) + listsIn(second));
            const budget = Math.floor((low + high) / 2);
            assert.ok(low <= budget && budget < high);

            const sent = await sqlSent(() => assert.rejects(ops.deleteRows('t', rowIds, budget), /Delete undo snapshot exceeds/));
            assert.deepEqual(sent.filter(sql => sql.includes('AS BLOB) ELSE')), [], 'rows were read before the refusal');
            assert.equal((await ops.executeQuery('SELECT count(*) FROM t'))[0].rows[0][0], SPLIT_ROWS);
        }, SPLIT_FILL);
    });
}
