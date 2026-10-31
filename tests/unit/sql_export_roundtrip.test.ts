import './vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as vscode from 'vscode';

import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection, isNativeAvailable } from '../../src/nativeWorker';
import { streamTableExport } from '../../src/tableExportStreaming';
import type { DatabaseOperations, ExportOptions } from '../../src/core/types';

// A SQL export replayed into a fresh table with the same schema must give back
// every cell's storage class and bytes: integral and infinite REALs, int64
// extremes, and TEXT that is not plain in the database's encoding.
const LITERALS = [
    '0', '-1', '2147483648', '9007199254740993', '-9223372036854775808', '9223372036854775807',
    '0.5', '1.0/3', '1e300', '-1e-300', '0.1+0.2', '5.0', '100.0', '1e16', '-0.0', '1e308*10', '-1e308*10',
    "''", "'a'", "'ünï'", "'😀'", "'it''s'", "'a' || char(0) || 'b'", "char(55296) || 'x'",
    "CAST(X'FF61' AS TEXT)", "CAST(X'EFBBBF61' AS TEXT)", "'a' || char(13) || char(10) || 'b'",
    "X''", "X'00FF'", 'zeroblob(3)', 'NULL',
    // Past SQLite's expression depth limit of 1000 as one || chain: 600 NULs
    // alone, 600 between letters, and NULs beside U+E000 and the letters a, b.
    "replace(hex(zeroblob(600)), '00', char(0))", "replace(hex(zeroblob(600)), '00', 'a' || char(0))",
    "replace(hex(zeroblob(300)), '00', char(57344) || char(0) || char(57344) || 'b' || char(57344) || 'a' || char(57344))"
];
const COLUMNS = ['n', 'i', 'r', 's', 'b'];
const TABLE_SQL = 'CREATE TABLE t (id INTEGER PRIMARY KEY, n, i INTEGER, r REAL, s TEXT, b BLOB)';

async function cells(ops: DatabaseOperations) {
    const projection = ['id', ...COLUMNS].map(column => (
        `typeof(${column}) AS t_${column}, CASE typeof(${column}) WHEN 'real' THEN printf('%!.17g', ${column}) ` +
        `ELSE hex(CAST(${column} AS BLOB)) END AS v_${column}`
    )).join(', ');
    return (await ops.executeQuery(`SELECT ${projection} FROM t ORDER BY id`))[0].rows;
}

async function assertRoundTrip(ops: DatabaseOperations, encoding: 'UTF-8' | 'UTF-16le') {
    await ops.executeQuery(`PRAGMA encoding = '${encoding}'`);
    await ops.executeQuery(TABLE_SQL);
    for (const [index, literal] of LITERALS.entries()) {
        await ops.executeQuery(`INSERT INTO t VALUES (${index + 1}, ${COLUMNS.map(() => literal).join(', ')})`);
    }
    const chunks: Buffer[] = [];
    const sink = {
        write: async (chunk: string) => { chunks.push(Buffer.from(chunk, 'utf8')); },
        writeBytes: async (bytes: Uint8Array) => { chunks.push(Buffer.from(bytes)); }
    };
    await streamTableExport(ops, 't', ['id', ...COLUMNS], { format: 'sql', includeTableName: true, header: true } as ExportOptions, sink);
    const fresh = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
    try {
        await fresh.executeQuery(`PRAGMA encoding = '${encoding}'`);
        await fresh.executeQuery(TABLE_SQL);
        await fresh.executeQuery(Buffer.concat(chunks).toString('utf8'));
        assert.deepEqual(await cells(fresh), await cells(ops), encoding);
    } finally {
        fresh.shutdown();
    }
}

describe('SQL exports replay to the same cells', () => {
    for (const encoding of ['UTF-8', 'UTF-16le'] as const) {
        it(`from WebAssembly in ${encoding}`, async () => {
            const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
            try {
                await assertRoundTrip(engine, encoding);
            } finally {
                engine.shutdown();
            }
        });

        it(`from the native engine in ${encoding}`, async (context) => {
            if (!await isNativeAvailable(process.cwd())) {
                if (process.env.FUZZ_EXPECT_TARGET) throw new Error(`Missing native runtime for ${process.env.FUZZ_EXPECT_TARGET}`);
                return context.skip('Bundled native runtime unavailable');
            }
            fs.mkdirSync('.tmp', { recursive: true });
            const directory = fs.mkdtempSync(path.resolve('.tmp/sql-export-roundtrip-'));
            const file = path.join(directory, 'export.db');
            fs.closeSync(fs.openSync(file, 'w'));
            const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
            try {
                const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), 'sql-export-roundtrip', false);
                await assertRoundTrip(databaseOps, encoding);
            } finally {
                native.workerMethods[Symbol.dispose]();
                fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            }
        });
    }
});
