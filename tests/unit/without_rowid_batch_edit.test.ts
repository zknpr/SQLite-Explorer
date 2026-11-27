import './vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as vscode from 'vscode';

import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { encodePrimaryKeyRecordId } from '../../src/core/row-identity';
import type { CellUpdate, DatabaseOperations } from '../../src/core/types';
import {
    createNativeDatabaseConnection,
    isNativeAvailable,
    nativePrimaryKeyBatch,
    NativeWorkerProcess
} from '../../src/nativeWorker';

// A WITHOUT ROWID batch edit on the native engine runs its rows together when
// no UPDATE can move a row or change another (nativePrimaryKeyBatch). Every
// case runs on two identical databases, together and row by row, and must
// return the same history, leave the same table and fail the same way.

const key = (columns: string[], values: unknown[]) => encodePrimaryKeyRecordId(
    columns.map((identifier, index) => ({ identifier, declaredType: '', position: index + 1 })),
    values as never[]
);

interface Case {
    name: string;
    setup: string;
    updates: CellUpdate[];
    /** Undo budget passed to updateCellBatch; undefined skips the history preflight. */
    budget?: number;
}

const big = 'x'.repeat(1024 * 1024);
const cases: Case[] = [
    {
        name: 'composite key with every storage class',
        setup: "CREATE TABLE t (k1 INTEGER, k2 TEXT, a, b BLOB, c REAL, PRIMARY KEY (k1, k2)) WITHOUT ROWID;" +
            "INSERT INTO t VALUES (1, 'é', 'one', x'00ff', 1.5), (9007199254740993, 'x', -0.0, NULL, 2), (2, '', '{\"a\":1}', x'', -0.0)",
        updates: [
            { rowId: key(['k1', 'k2'], [1n, 'é']), column: 'a', value: 'changed' },
            { rowId: key(['k1', 'k2'], [1n, 'é']), column: 'b', value: new Uint8Array([1, 2, 3]) },
            { rowId: key(['k1', 'k2'], [9007199254740993n, 'x']), column: 'a', value: 9007199254740993n },
            { rowId: key(['k1', 'k2'], [9007199254740993n, 'x']), column: 'c', value: null },
            { rowId: key(['k1', 'k2'], [2n, '']), column: 'c', value: 0.25 }
        ]
    },
    {
        name: 'NOCASE key named twice for one stored row',
        setup: "CREATE TABLE t (k TEXT COLLATE NOCASE PRIMARY KEY, a, b) WITHOUT ROWID; INSERT INTO t VALUES ('Abc', 'x', 1), ('d', 'y', 2)",
        updates: [
            { rowId: key(['k'], ['Abc']), column: 'a', value: 'first' },
            { rowId: key(['k'], ['ABC']), column: 'b', value: 'second' },
            { rowId: key(['k'], ['D']), column: 'a', value: 'third' }
        ]
    },
    {
        name: 'NOCASE key named twice, with an undo budget',
        setup: "CREATE TABLE t (k TEXT COLLATE NOCASE PRIMARY KEY, a, b) WITHOUT ROWID; INSERT INTO t VALUES ('Abc', 'x', 1)",
        updates: [
            { rowId: key(['k'], ['Abc']), column: 'a', value: 'first' },
            { rowId: key(['k'], ['abc']), column: 'b', value: 'second' }
        ],
        budget: 1 << 20
    },
    {
        name: 'JSON merges and JSON-looking text',
        setup: "CREATE TABLE t (k INTEGER PRIMARY KEY, j, s) WITHOUT ROWID;" +
            "INSERT INTO t VALUES (1, '{\"a\":1,\"b\":{\"c\":2}}', '[1,2]'), (2, NULL, 'plain')",
        updates: [
            { rowId: key(['k'], [1n]), column: 'j', value: '{"a":1,"b":{"c":3},"d":4}' },
            { rowId: key(['k'], [1n]), column: 's', value: '[1,2,3]' },
            { rowId: key(['k'], [2n]), column: 'j', value: '{"x":true}', operation: 'json_patch' }
        ]
    },
    {
        name: 'UNIQUE failure in the middle of the batch',
        setup: "CREATE TABLE t (k INTEGER PRIMARY KEY, u TEXT UNIQUE) WITHOUT ROWID; INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')",
        updates: [
            { rowId: key(['k'], [1n]), column: 'u', value: 'x' },
            { rowId: key(['k'], [2n]), column: 'u', value: 'c' },
            { rowId: key(['k'], [3n]), column: 'u', value: 'y' }
        ]
    },
    {
        name: 'a row that does not exist',
        setup: "CREATE TABLE t (k INTEGER PRIMARY KEY, a) WITHOUT ROWID; INSERT INTO t VALUES (1, 'a')",
        updates: [
            { rowId: key(['k'], [1n]), column: 'a', value: 'b' },
            { rowId: key(['k'], [99n]), column: 'a', value: 'c' }
        ]
    },
    {
        name: 'a key column edit',
        setup: "CREATE TABLE t (k INTEGER PRIMARY KEY, a) WITHOUT ROWID; INSERT INTO t VALUES (1, 'a'), (2, 'b')",
        updates: [
            { rowId: key(['k'], [1n]), column: 'k', value: 10 },
            { rowId: key(['k'], [2n]), column: 'a', value: 'c' }
        ]
    },
    {
        name: 'an ON UPDATE CASCADE within the table',
        setup: "PRAGMA foreign_keys = ON;" +
            "CREATE TABLE t (k INTEGER PRIMARY KEY, code TEXT UNIQUE, parent TEXT REFERENCES t(code) ON UPDATE CASCADE) WITHOUT ROWID;" +
            "INSERT INTO t VALUES (1, 'p', NULL), (2, 'q', 'p'), (3, 'r', 'p')",
        updates: [
            { rowId: key(['k'], [1n]), column: 'code', value: 'p2' },
            { rowId: key(['k'], [2n]), column: 'parent', value: 'r' }
        ]
    },
    {
        name: 'megabyte cells across several requests',
        setup: "CREATE TABLE t (k INTEGER PRIMARY KEY, big, n) WITHOUT ROWID;" +
            `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 12) INSERT INTO t SELECT x, '${big}', x FROM c`,
        updates: Array.from({ length: 12 }, (_, index) => [
            { rowId: key(['k'], [BigInt(index + 1)]), column: 'n', value: -index },
            { rowId: key(['k'], [BigInt(index + 1)]), column: 'big', value: index % 2 ? 'short' : big + index }
        ]).flat()
    }
];

async function withNative<T>(work: (ops: DatabaseOperations) => Promise<T>): Promise<T> {
    fs.mkdirSync('.tmp', { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('.tmp/native-pk-batch-'));
    const file = path.join(directory, 't.db');
    fs.closeSync(fs.openSync(file, 'w'));
    const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
    try {
        const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), 'native-pk-batch', false);
        return await work(databaseOps);
    } finally {
        native.workerMethods[Symbol.dispose]();
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
}

async function runCase(testCase: Case, together: boolean) {
    nativePrimaryKeyBatch.enabled = together;
    try {
        return await withNative(async ops => {
            await ops.executeQuery(testCase.setup);
            const table = async () => (await ops.executeQuery('SELECT * FROM t ORDER BY 1, 2'))[0].rows;
            let results: unknown;
            let error: string | undefined;
            try {
                results = await ops.updateCellBatch('t', testCase.updates, 4 << 20, testCase.budget);
            } catch (caught) {
                // Native errors name the worker request that failed ([run],
                // [execBatch], [queryHistoryBatch]); SQLite's text follows.
                error = (caught as Error).message.replace(/^\[\w+\] /, '');
            }
            const edited = await table();
            let undone, redone;
            if (!error) {
                const modification = { modificationType: 'cell_update' as const, targetTable: 't', description: 'Edit', affectedCells: results as never };
                await ops.undoModification(modification);
                undone = await table();
                await ops.redoModification(modification);
                redone = await table();
            }
            return { results, error, edited, undone, redone };
        });
    } finally {
        nativePrimaryKeyBatch.enabled = true;
    }
}

describe('native WITHOUT ROWID batch edits run together', () => {
    for (const testCase of cases) {
        it(`matches the per-row sequence: ${testCase.name}`, async (context) => {
            if (!await isNativeAvailable(process.cwd())) return context.skip('Bundled native runtime unavailable');
            const together = await runCase(testCase, true);
            const perRow = await runCase(testCase, false);
            assert.deepStrictEqual(together, perRow);
        });
    }

    it('expects the cases above to cover success and refusal', async (context) => {
        if (!await isNativeAvailable(process.cwd())) return context.skip('Bundled native runtime unavailable');
        assert.match((await runCase(cases[4], true)).error ?? '', /UNIQUE constraint failed: t\.u/);
        assert.match((await runCase(cases[5], true)).error ?? '', /row identity no longer exists/);
        assert.equal((await runCase(cases[0], true)).error, undefined);
    });

    it('edits 400 rows in a few requests', async (context) => {
        if (!await isNativeAvailable(process.cwd())) return context.skip('Bundled native runtime unavailable');
        const actualCall = NativeWorkerProcess.prototype.call;
        let calls = 0;
        NativeWorkerProcess.prototype.call = function (this: NativeWorkerProcess, ...args: Parameters<typeof actualCall>) {
            calls++;
            return actualCall.apply(this, args);
        } as typeof actualCall;
        try {
            await withNative(async ops => {
                await ops.executeQuery("CREATE TABLE t (k INTEGER PRIMARY KEY, a) WITHOUT ROWID;" +
                    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 400) INSERT INTO t SELECT x, x FROM c");
                const updates = Array.from({ length: 400 }, (_, index) => ({ rowId: key(['k'], [BigInt(index + 1)]), column: 'a', value: 'v' }));
                calls = 0;
                await ops.updateCellBatch('t', updates, 4 << 20, 64 << 20);
                // Row by row this was about 2,000 requests: four a row and a metadata read a cell.
                assert.ok(calls <= 20, `${calls} requests`);
            });
        } finally {
            NativeWorkerProcess.prototype.call = actualCall;
        }
    });
});

describe('WITHOUT ROWID batch edits refuse an oversized prior value', () => {
    // The metadata check runs per column and identity chunk; a refusal names
    // the first oversized cell in request order, as the per-cell check did.
    async function refusal(ops: DatabaseOperations) {
        await ops.executeQuery("CREATE TABLE t (k INTEGER PRIMARY KEY, a, b) WITHOUT ROWID;" +
            "INSERT INTO t VALUES (1, printf('%.300c', 'x'), zeroblob(400)), (2, printf('%.200c', 'x'), 'small'), (3, 'small', 'small')");
        // The key order reaches row 1 first; the request names row 2 first.
        const updates = [
            { rowId: key(['k'], [3n]), column: 'a', value: 'v' },
            { rowId: key(['k'], [2n]), column: 'a', value: 'v' },
            { rowId: key(['k'], [1n]), column: 'a', value: 'v' },
            { rowId: key(['k'], [1n]), column: 'b', value: 'v' }
        ];
        const before = (await ops.executeQuery('SELECT * FROM t ORDER BY k'))[0].rows;
        await assert.rejects(() => ops.updateCellBatch('t', updates, 100, 64 << 20), (error: Error & Record<string, unknown>) => {
            assert.equal(error.name, 'OversizedCellReplacementRequiredError');
            assert.deepEqual([error.column, error.storageClass, error.actualBytes, error.limitBytes], ['a', 'text', 200, 100]);
            return true;
        });
        assert.deepEqual((await ops.executeQuery('SELECT * FROM t ORDER BY k'))[0].rows, before);
    }

    it('on WebAssembly', async () => {
        const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        try { await refusal(engine); } finally { engine.shutdown(); }
    });

    it('on the native engine', async (context) => {
        if (!await isNativeAvailable(process.cwd())) return context.skip('Bundled native runtime unavailable');
        await withNative(refusal);
    });
});

describe('WebAssembly WITHOUT ROWID batch edits', () => {
    it('compile the same statements for 20 rows as for 200', async () => {
        const compiled: number[] = [];
        for (const rows of [20, 200]) {
            const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
            try {
                await engine.executeQuery(`CREATE TABLE t (k INTEGER PRIMARY KEY, a) WITHOUT ROWID;` +
                    `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${rows}) INSERT INTO t SELECT x, x FROM c`);
                const database = (engine as unknown as { instance: Record<string, (...args: unknown[]) => unknown> }).instance;
                let count = 0;
                for (const name of ['prepare', 'exec', 'run', 'iterateStatements']) {
                    const original = database[name].bind(database);
                    database[name] = (...args: unknown[]) => { count++; return original(...args); };
                }
                const updates = Array.from({ length: rows }, (_, index) => ({ rowId: key(['k'], [BigInt(index + 1)]), column: 'a', value: 'v' }));
                await engine.updateCellBatch('t', updates, 4 << 20, 64 << 20);
                compiled.push(count);
            } finally {
                engine.shutdown();
            }
        }
        assert.equal(compiled[1], compiled[0], `statements compiled for 20 and 200 rows: ${compiled.join(', ')}`);
    });
});
