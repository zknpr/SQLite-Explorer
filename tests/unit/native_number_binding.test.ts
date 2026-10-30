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
import type { CellUpdateResult, DatabaseOperations } from '../../src/core/types';

/**
 * V8 serializes a number in an array of doubles as a double even when it is
 * integral, so [28, 2.5] reaches txiki as two floats. Both engines must still
 * bind an int32 value as INTEGER, as sql.js does, whatever else the array holds.
 */
async function storedValues(ops: DatabaseOperations): Promise<unknown[][]> {
    await ops.executeQuery('CREATE TABLE t (id INTEGER PRIMARY KEY, a, b, c TEXT)');
    await ops.executeQuery('INSERT INTO t VALUES (?, ?, ?, ?)', [1, 28, 2.5, 7]);
    await ops.executeQuery('INSERT INTO t VALUES (?, ?, ?, ?)', [2, 3000000000, 1.25, 9]);
    await ops.insertRow!('t', { id: 3, a: 28, b: 2.5, c: 7 });
    await runReadSnapshot(ops, tx => importRowsAtomically(tx, 't', [
        { id: 4, a: 28, b: 2.5, c: 7 },
        { id: 5, a: 3000000000, b: 1, c: 8 }
    ], 64 * 1024 * 1024));
    await ops.executeQuery("INSERT INTO t VALUES (6, 1, 1.5, 'x')");
    await ops.updateCellBatch('t', [
        { rowId: 6, column: 'a', value: 29 },
        { rowId: 6, column: 'b', value: 3.5 },
        { rowId: 6, column: 'c', value: 11 }
    ]);
    // A rowid past int32 makes each edit's [value, rowid] an array of doubles.
    await ops.executeQuery('INSERT INTO t (id) VALUES (3000000000)');
    await ops.updateCellBatch('t', [
        { rowId: 3000000000, column: 'a', value: 29 },
        { rowId: 3000000000, column: 'c', value: 11 }
    ]);
    // Undo writes the INTEGER prior beside a fractional REAL one.
    await ops.executeQuery('INSERT INTO t VALUES (7, 28, 2.333333333333333, NULL)');
    const affectedCells = await ops.updateCellBatch('t', [
        { rowId: 7, column: 'a', value: null },
        { rowId: 7, column: 'b', value: 45 },
        { rowId: 7, column: 'c', value: 't' }
    ]);
    const undo = await ops.undoModification(
        { modificationType: 'cell_update', targetTable: 't', description: 'Batch edit', affectedCells }
    ).then(() => 'applied', (error: Error) => error.message);
    const rows = (await ops.executeQuery(
        'SELECT id, typeof(a), quote(a), typeof(b), quote(b), typeof(c), quote(c) FROM t ORDER BY id'
    ))[0].rows;
    // Native executeQuery keys row values by column name, so each needs its own.
    const bound = (await ops.executeQuery(
        'SELECT typeof(?) AS p1, typeof(?) AS p2, typeof(?) AS p3, typeof(?) AS p4',
        [28, 2.5, 7, 3000000000]
    ))[0].rows;
    const consoleTypes = (await ops.executeReadQuery('SELECT typeof(?), typeof(?), typeof(?)', [28, 2.5, 7])).rows;
    return [...rows, ...bound, ...consoleTypes, [undo]];
}

const EXPECTED = [
    [1, 'integer', '28', 'real', '2.5', 'text', "'7'"],
    [2, 'real', '3000000000.0', 'real', '1.25', 'text', "'9'"],
    [3, 'integer', '28', 'real', '2.5', 'text', "'7'"],
    [4, 'integer', '28', 'real', '2.5', 'text', "'7'"],
    // Imports bind whole numbers past int32 as INTEGER (bindIntegersExactly).
    [5, 'integer', '3000000000', 'integer', '1', 'text', "'8'"],
    [6, 'integer', '29', 'real', '3.5', 'text', "'11'"],
    [7, 'integer', '28', 'real', '2.333333333333333', 'null', 'NULL'],
    [3000000000, 'integer', '29', 'null', 'NULL', 'text', "'11'"],
    ['integer', 'real', 'integer', 'real'],
    ['integer', 'real', 'integer'],
    ['applied']
];

describe('number binding', () => {
    it('binds int32 values as INTEGER on WebAssembly', async () => {
        const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        try {
            assert.deepStrictEqual(await storedValues(engine), EXPECTED);
        } finally {
            engine.shutdown();
        }
    });

    it('binds int32 values as INTEGER on the native engine, whatever else the array holds', async (context) => {
        if (!bundledNativeBinary()) return context.skip(`no bundled txiki worker for ${process.platform}-${process.arch}`);
        await withNativeDatabase(undefined, async databaseOps => {
            assert.deepStrictEqual(await storedValues(databaseOps), EXPECTED);
            // -0 stays txiki's REAL -0.0, so undo writes back the exact prior.
            await databaseOps.executeQuery('CREATE TABLE z (id INTEGER PRIMARY KEY, a); INSERT INTO z VALUES (1, -0.0)');
            const affectedCells = await databaseOps.updateCellBatch('z', [{ rowId: 1, column: 'a', value: 'x' }]);
            await databaseOps.undoModification({ modificationType: 'cell_update', targetTable: 'z', description: 'Edit', affectedCells });
            const restored = (await databaseOps.executeQuery('SELECT typeof(a) AS kind, a FROM z'))[0].rows[0];
            assert.strictEqual(restored[0], 'real');
            assert.ok(Object.is(restored[1], -0), `restored ${String(restored[1])}`);
        });
    });

    it('undoes a WebAssembly cell edit, whose small integers are BigInts, on the native engine', async (context) => {
        if (!bundledNativeBinary()) return context.skip(`no bundled txiki worker for ${process.platform}-${process.arch}`);
        // A hot-exit backup carries history recorded on one engine to the next.
        const wasm = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        let image: Uint8Array;
        let affectedCells: CellUpdateResult[];
        try {
            await wasm.executeQuery('CREATE TABLE t (id INTEGER PRIMARY KEY, a, b)');
            await wasm.executeQuery('INSERT INTO t VALUES (1, 5, -2147483648), (2, 2147483647, 2147483648)');
            affectedCells = await wasm.updateCellBatch('t', ['a', 'b'].flatMap(column => [1, 2].map(rowId => (
                { rowId, column, value: `${column}${rowId}` }
            ))));
            assert.ok(affectedCells.every(cell => typeof cell.priorState?.value === 'bigint'));
            image = await wasm.serializeDatabase();
        } finally {
            wasm.shutdown();
        }
        await withNativeDatabase(image, async databaseOps => {
            await databaseOps.undoModification({ modificationType: 'cell_update', targetTable: 't', description: 'Edit', affectedCells });
            assert.deepStrictEqual(
                (await databaseOps.executeQuery('SELECT id, typeof(a) AS ta, a, typeof(b) AS tb, b FROM t ORDER BY id'))[0].rows,
                [[1, 'integer', 5, 'integer', -2147483648], [2, 'integer', 2147483647, 'integer', 2147483648]]
            );
            const bound = (await databaseOps.executeQuery(
                'SELECT typeof(?) AS p1, typeof(?) AS p2, typeof(?) AS p3, typeof(?) AS p4',
                [5n, -2147483648n, 2147483647n, 2147483648n]
            ))[0].rows;
            assert.deepStrictEqual(bound, [['integer', 'integer', 'integer', 'integer']]);
        });
    });
});

/** The bundled worker for this platform; under FUZZ_EXPECT_TARGET a missing one fails. */
function bundledNativeBinary(): string | undefined {
    const platformDir = process.platform === 'darwin'
        ? (process.arch === 'arm64' ? 'aarch64-macos' : 'x86_64-macos')
        : process.platform === 'linux'
            ? (process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu')
            : process.platform === 'win32' && process.arch === 'x64' ? 'x86_64-windows' : undefined;
    const expected = process.env.FUZZ_EXPECT_TARGET;
    if (expected && expected !== platformDir) {
        throw new Error(`Expected native target ${expected}, resolved ${platformDir ?? 'none'}`);
    }
    const binary = platformDir && path.join('natives', platformDir, process.platform === 'win32' ? 'tjs.exe' : 'tjs');
    if (binary && fs.existsSync(binary)) return binary;
    if (expected) throw new Error(`Missing native runtime ${binary}`);
    return undefined;
}

async function withNativeDatabase(image: Uint8Array | undefined, work: (ops: DatabaseOperations) => Promise<void>) {
    fs.mkdirSync('.tmp', { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('.tmp/native-number-binding-'));
    const file = path.join(directory, 'numbers.db');
    if (image) fs.writeFileSync(file, image);
    else fs.closeSync(fs.openSync(file, 'w'));
    const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
    try {
        const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), 'native-number-binding', false);
        await work(databaseOps);
    } finally {
        native.workerMethods[Symbol.dispose]();
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
}
