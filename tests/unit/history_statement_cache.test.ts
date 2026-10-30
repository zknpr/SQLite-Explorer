import './vscode_mock_setup'; // Must be first

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as vscode from 'vscode';

import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';
import { runReadSnapshot } from '../../src/core/operation-serializer';
import { importRowsAtomically } from '../../src/core/bulk-import';
import type { CellValue, DatabaseOperations } from '../../src/core/types';

const COLUMNS = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'];
const TABLE_SQL = `CREATE TABLE items (id INTEGER PRIMARY KEY, ${COLUMNS.join(', ')}, note TEXT DEFAULT 'n/a')`;

// Every NULL pattern over six columns, with each kept column's storage class
// rotating, so undo and redo generate more distinct statements than a call
// keeps prepared (MAX_HISTORY_STATEMENTS).
function patternRows(count: number): Record<string, CellValue>[] {
    return Array.from({ length: count }, (_, index) => {
        const row: Record<string, CellValue> = { id: index + 1 };
        COLUMNS.forEach((column, columnIndex) => {
            if (index & (1 << columnIndex)) {
                row[column] = null;
                return;
            }
            const kinds: CellValue[] = [index * 7 + columnIndex, index / 3 + columnIndex, `t${index}_${columnIndex}`,
                new Uint8Array([index & 0xff, columnIndex])];
            row[column] = kinds[(index + columnIndex) % kinds.length];
        });
        return row;
    });
}

async function contents(ops: DatabaseOperations) {
    const result = await ops.executeQuery(
        `SELECT id, ${COLUMNS.map(column => `typeof(${column}), quote(${column})`).join(', ')}, note FROM items ORDER BY id`
    );
    return result[0]?.rows ?? [];
}

async function assertHistoryRoundTrip(ops: DatabaseOperations) {
    await ops.executeQuery(TABLE_SQL);
    const empty = await contents(ops);
    const rows = patternRows(160);
    const modification = await runReadSnapshot(ops, tx => importRowsAtomically(tx, 'items', rows, 64 * 1024 * 1024));
    const imported = await contents(ops);
    assert.strictEqual(imported.length, 160);
    // Imported values keep their storage classes.
    assert.deepStrictEqual(imported[0].slice(1, 3), ['integer', '0']);
    assert.deepStrictEqual(imported[1].slice(1, 3), ['null', 'NULL']);
    await ops.undoModification(modification);
    assert.deepStrictEqual(await contents(ops), empty);
    await ops.redoModification(modification);
    assert.deepStrictEqual(await contents(ops), imported);
    // A late row changed outside history stops the whole undo, as itself.
    await ops.executeQuery("UPDATE items SET note = 'external' WHERE id = 150");
    await assert.rejects(ops.undoModification(modification), (error: Error & { code?: string }) => (
        error.code === 'SQLITE_EXPLORER_ROW_HISTORY_CONFLICT'
    ));
    await ops.executeQuery("UPDATE items SET note = 'n/a' WHERE id = 150");
    assert.deepStrictEqual(await contents(ops), imported);
    await ops.undoModification(modification);
    assert.deepStrictEqual(await contents(ops), empty);

    // A row that fails mid-batch rolls the batch back, and the next batch,
    // with new statements, still runs.
    const conflicting = patternRows(40);
    conflicting[25] = { ...conflicting[25], id: 3 };
    await assert.rejects(runReadSnapshot(ops, tx => importRowsAtomically(tx, 'items', conflicting, 64 * 1024 * 1024)));
    assert.deepStrictEqual(await contents(ops), empty);
    await runReadSnapshot(ops, tx => importRowsAtomically(tx, 'items', patternRows(40), 64 * 1024 * 1024));
    assert.strictEqual((await contents(ops)).length, 40);
}

// New values rotate through every storage class, against priors that rotate
// too, so replay generates more distinct UPDATE texts than a call keeps prepared.
function newCellValue(index: number, columnIndex: number): CellValue {
    const kinds: CellValue[] = [`n${index}_${columnIndex}`, index * 11 + columnIndex, index / 7 + columnIndex,
        new Uint8Array([columnIndex, index & 0xff]), null];
    return kinds[(index + 2 * columnIndex) % kinds.length];
}

async function assertCellHistoryRoundTrip(ops: DatabaseOperations, rowCount = 160) {
    await ops.executeQuery(TABLE_SQL);
    await runReadSnapshot(ops, tx => importRowsAtomically(tx, 'items', patternRows(rowCount), 64 * 1024 * 1024));
    const before = await contents(ops);
    const updates = Array.from({ length: rowCount }, (_, index) => COLUMNS.slice(0, 3).map((column, columnIndex) => (
        { rowId: index + 1, column, value: newCellValue(index, columnIndex) }
    ))).flat();
    const affectedCells = await ops.updateCellBatch('items', updates);
    const after = await contents(ops);
    assert.notDeepStrictEqual(after, before);
    const modification = { modificationType: 'cell_update' as const, targetTable: 'items', description: 'Batch edit', affectedCells };
    await ops.undoModification(modification);
    assert.deepStrictEqual(await contents(ops), before);
    await ops.redoModification(modification);
    assert.deepStrictEqual(await contents(ops), after);

    // A conflict on a late row rolls the whole replay back, and the next
    // replay, after the cell is restored, still runs.
    const conflictIndex = [...Array(rowCount).keys()].reverse().find(index => typeof newCellValue(index, 0) === 'string')!;
    await ops.executeQuery('UPDATE items SET c0 = ? WHERE id = ?', ['external', conflictIndex + 1]);
    const external = await contents(ops);
    // The conflict leaves the synchronous replay as itself, not as a query failure.
    await assert.rejects(ops.undoModification(modification), (error: Error & { code?: string }) => (
        error.code === 'SQLITE_EXPLORER_CELL_HISTORY_CONFLICT' && /changed outside SQLite Explorer history/i.test(error.message)
    ));
    assert.deepStrictEqual(await contents(ops), external);
    await ops.executeQuery('UPDATE items SET c0 = ? WHERE id = ?', [newCellValue(conflictIndex, 0), conflictIndex + 1]);
    assert.deepStrictEqual(await contents(ops), after);
    await ops.undoModification(modification);
    assert.deepStrictEqual(await contents(ops), before);
}

describe('batched row-history statements', () => {
    it('round-trip import, undo and redo past the statement cache on WebAssembly', async () => {
        const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        try {
            await assertHistoryRoundTrip(engine);
        } finally {
            engine.shutdown();
        }
    });

    it('round-trip a cell batch\'s undo and redo past the statement cache on WebAssembly', async () => {
        const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        try {
            await assertCellHistoryRoundTrip(engine);
        } finally {
            engine.shutdown();
        }
    });

    it('prepare a WebAssembly cell batch\'s undo statements once per call, not once per row', async () => {
        const counts: number[] = [];
        for (const count of [50, 400]) {
            const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
            const instance = (engine as unknown as { instance: { prepare(sql: string, ...rest: unknown[]): unknown } }).instance;
            const prepare = instance.prepare.bind(instance);
            let prepares = 0;
            instance.prepare = (sql: string, ...rest: unknown[]) => { prepares++; return prepare(sql, ...rest); };
            try {
                await engine.executeQuery(TABLE_SQL);
                await engine.executeQuery(
                    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count}) ` +
                    'INSERT INTO items (id, c0, c1) SELECT i, i, \'v\' || i FROM n'
                );
                const affectedCells = await engine.updateCellBatch('items', Array.from({ length: count }, (_, index) => (
                    { rowId: index + 1, column: 'c1', value: `w${index}` }
                )));
                prepares = 0;
                await engine.undoModification({ modificationType: 'cell_update', targetTable: 'items', description: 'Batch edit', affectedCells });
                counts.push(prepares);
            } finally {
                engine.shutdown();
            }
        }
        assert.strictEqual(counts[1], counts[0], `prepares grew with rows: ${counts}`);
        assert.ok(counts[0] < 30, `prepares per call: ${counts[0]}`);
    });

    it('prepare a WebAssembly import\'s statements once per call, not once per row', async () => {
        const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        const instance = (engine as unknown as { instance: { prepare(sql: string, ...rest: unknown[]): unknown } }).instance;
        const prepare = instance.prepare.bind(instance);
        let prepares = 0;
        instance.prepare = (sql: string, ...rest: unknown[]) => { prepares++; return prepare(sql, ...rest); };
        try {
            await engine.executeQuery(TABLE_SQL);
            const counts: number[] = [];
            for (const count of [50, 400]) {
                const rows = Array.from({ length: count }, (_, index) => ({ c0: index, c1: `v${index}` }));
                prepares = 0;
                await engine.insertRowsWithHistory('items', rows);
                counts.push(prepares);
            }
            assert.strictEqual(counts[1], counts[0], `prepares grew with rows: ${counts}`);
            assert.ok(counts[0] < 30, `prepares per call: ${counts[0]}`);
        } finally {
            engine.shutdown();
        }
    });

    it('round-trip an import and a cell batch past the statement cache on the native engine', async (context) => {
        const platformDir = process.platform === 'darwin'
            ? (process.arch === 'arm64' ? 'aarch64-macos' : 'x86_64-macos')
            : process.platform === 'linux'
                ? (process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu')
                : process.platform === 'win32' && process.arch === 'x64' ? 'x86_64-windows' : undefined;
        if (!platformDir || !fs.existsSync(path.join('natives', platformDir, process.platform === 'win32' ? 'tjs.exe' : 'tjs'))) {
            return context.skip(`no bundled txiki worker for ${process.platform}-${process.arch}`);
        }
        fs.mkdirSync('.tmp', { recursive: true });
        const directory = fs.mkdtempSync(path.resolve('.tmp/history-statement-cache-'));
        const file = path.join(directory, 'history.db');
        fs.closeSync(fs.openSync(file, 'w'));
        const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
        try {
            const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), 'history-statement-cache', false);
            await assertHistoryRoundTrip(databaseOps);
            await databaseOps.executeQuery('DROP TABLE items');
            await assertCellHistoryRoundTrip(databaseOps);
        } finally {
            native.workerMethods[Symbol.dispose]();
            fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });
});
