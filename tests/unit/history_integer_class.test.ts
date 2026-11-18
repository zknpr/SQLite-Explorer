import './vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as vscode from 'vscode';

import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection, isNativeAvailable } from '../../src/nativeWorker';
import { runReadSnapshot } from '../../src/core/operation-serializer';
import { importRowsAtomically, parseImport } from '../../src/core/bulk-import';
import type { DatabaseOperations } from '../../src/core/types';

// INTEGER values past int32, as millisecond timestamps are, in columns whose
// affinity keeps whatever class arrives. Both engines bind a whole number past
// int32 as a double, so history must say INTEGER itself.
const VALUES = ['7', '2147483648', '-2147483649', '3000000000', '1730000000000', '9007199254740991', '9223372036854775807'];

async function assertIntegerHistory(ops: DatabaseOperations) {
    await ops.executeQuery('CREATE TABLE t (id INTEGER PRIMARY KEY, a, b BLOB)');
    for (const [index, value] of VALUES.entries()) {
        await ops.executeQuery(`INSERT INTO t VALUES (${index + 1}, ${value}, ${value})`);
    }
    const read = async () => (await ops.executeQuery(
        'SELECT id, typeof(a) AS ta, CAST(a AS TEXT) AS va, typeof(b) AS tb, CAST(b AS TEXT) AS vb FROM t ORDER BY id'
    ))[0].rows;
    const stored = await read();
    assert.deepEqual(stored, VALUES.map((value, index) => [index + 1, 'integer', value, 'integer', value]));
    const ids = VALUES.map((_, index) => index + 1);

    const deletedRows = await ops.deleteRows('t', ids);
    const deletion = { modificationType: 'row_delete' as const, targetTable: 't', description: 'Delete', deletedRows };
    await ops.undoModification(deletion);
    assert.deepEqual(await read(), stored, 'undo of the delete');
    await ops.redoModification(deletion);
    assert.deepEqual(await read(), []);
    await ops.undoModification(deletion);
    assert.deepEqual(await read(), stored, 'second undo of the delete');

    const affectedCells = await ops.updateCellBatch('t', ids.flatMap(rowId => [
        { rowId, column: 'a', value: 'x' }, { rowId, column: 'b', value: 'y' }
    ]));
    const edit = { modificationType: 'cell_update' as const, targetTable: 't', description: 'Edit', affectedCells };
    await ops.undoModification(edit);
    assert.deepEqual(await read(), stored, 'undo of the edit');
    await ops.redoModification(edit);
    await ops.undoModification(edit);
    assert.deepEqual(await read(), stored, 'second undo of the edit');

    // A bigint past int32, as WebAssembly history holds every INTEGER, inserts
    // as INTEGER, not as the double sql.js binds for it.
    const insertedRow = await ops.insertRowWithHistory!('t', { id: 100, a: 3000000000n, b: -2147483649n });
    const inserted = [100, 'integer', '3000000000', 'integer', '-2147483649'];
    assert.deepEqual((await read()).at(-1), inserted);
    const insertion = {
        modificationType: 'row_insert' as const, targetTable: 't', targetRowId: insertedRow.rowId,
        description: 'Insert', rowData: insertedRow.row, insertedRow
    };
    await ops.undoModification(insertion);
    assert.deepEqual(await read(), stored);
    await ops.redoModification(insertion);
    assert.deepEqual((await read()).at(-1), inserted);

    // REAL -0.0 survives undo: sql.js binds -0 as INTEGER 0, so history writes
    // the literal.
    await ops.executeQuery('CREATE TABLE z (id INTEGER PRIMARY KEY, a); INSERT INTO z VALUES (1, -0.0)');
    const zeroCells = await ops.updateCellBatch('z', [{ rowId: 1, column: 'a', value: 'x' }]);
    await ops.undoModification({ modificationType: 'cell_update', targetTable: 'z', description: 'Edit', affectedCells: zeroCells });
    const [kind, zero] = (await ops.executeQuery('SELECT typeof(a) AS kind, a FROM z'))[0].rows[0];
    assert.equal(kind, 'real');
    assert.ok(Object.is(zero, -0), `restored ${String(zero)}`);
}

describe('INTEGER past int32 and REAL -0.0 history', () => {
    it('undoes deletes and edits exactly on WebAssembly', async () => {
        const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        try {
            await assertIntegerHistory(engine);
        } finally {
            engine.shutdown();
        }
    });

    it('undoes deletes and edits exactly on the native engine', async (context) => {
        if (!await isNativeAvailable(process.cwd())) {
            if (process.env.FUZZ_EXPECT_TARGET) throw new Error(`Missing native runtime for ${process.env.FUZZ_EXPECT_TARGET}`);
            return context.skip('Bundled native runtime unavailable');
        }
        fs.mkdirSync('.tmp', { recursive: true });
        const directory = fs.mkdtempSync(path.resolve('.tmp/history-integer-class-'));
        const file = path.join(directory, 'integers.db');
        fs.closeSync(fs.openSync(file, 'w'));
        const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
        try {
            const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), 'history-integer-class', false);
            await assertIntegerHistory(databaseOps);
        } finally {
            native.workerMethods[Symbol.dispose]();
            fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });
});

/** A JSON integer past int32 imports as INTEGER, as SQLite stores the literal. */
async function assertImportedIntegers(ops: DatabaseOperations) {
    await ops.executeQuery('CREATE TABLE imported (id INTEGER PRIMARY KEY, a, b TEXT, c REAL)');
    const rows = parseImport('[{"a": 1730000000000, "b": 1730000000000, "c": 1730000000000}, {"a": 7, "b": 7, "c": 0.5}]', 'json').rows;
    const modification = await runReadSnapshot(ops, tx => importRowsAtomically(tx, 'imported', rows, 64 * 1024 * 1024));
    const read = async () => (await ops.executeQuery(
        'SELECT typeof(a) AS ta, CAST(a AS TEXT) AS va, typeof(b) AS tb, b AS vb, typeof(c) AS tc FROM imported ORDER BY id'
    ))[0].rows;
    const expected = [['integer', '1730000000000', 'text', '1730000000000', 'real'], ['integer', '7', 'text', '7', 'real']];
    assert.deepEqual(await read(), expected);
    await ops.undoModification(modification);
    await ops.redoModification(modification);
    assert.deepEqual(await read(), expected);
}

describe('JSON import of integers past int32', () => {
    it('stores INTEGER on WebAssembly', async () => {
        const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        try {
            await assertImportedIntegers(engine);
        } finally {
            engine.shutdown();
        }
    });

    it('stores INTEGER on the native engine', async (context) => {
        if (!await isNativeAvailable(process.cwd())) {
            if (process.env.FUZZ_EXPECT_TARGET) throw new Error(`Missing native runtime for ${process.env.FUZZ_EXPECT_TARGET}`);
            return context.skip('Bundled native runtime unavailable');
        }
        fs.mkdirSync('.tmp', { recursive: true });
        const directory = fs.mkdtempSync(path.resolve('.tmp/history-integer-import-'));
        const file = path.join(directory, 'import.db');
        fs.closeSync(fs.openSync(file, 'w'));
        const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
        try {
            const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), 'history-integer-import', false);
            await assertImportedIntegers(databaseOps);
        } finally {
            native.workerMethods[Symbol.dispose]();
            fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });
});
