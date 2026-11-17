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

// SQLite refuses an INSERT that names a generated column, so a SQL export
// leaves VIRTUAL and STORED columns out, as sqlite3's .dump does. CSV and JSON
// still carry every selected column.
const GENERATED_TABLE_SQL = 'CREATE TABLE g (a INTEGER, d INTEGER GENERATED ALWAYS AS (a * 2) VIRTUAL, ' +
    "s TEXT GENERATED ALWAYS AS ('s' || a) STORED, b TEXT)";

async function exportText(ops: DatabaseOperations, table: string, columns: string[], options: Partial<ExportOptions>) {
    const chunks: string[] = [];
    await streamTableExport(ops, table, columns, options as ExportOptions, { write: async (chunk: string) => { chunks.push(chunk); } });
    return chunks.join('');
}

async function assertGeneratedColumnsLeftOut(ops: DatabaseOperations, backend: 'wasm' | 'native') {
    await ops.executeQuery(GENERATED_TABLE_SQL);
    await ops.executeQuery("INSERT INTO g (a, b) VALUES (1, 'x'), (2, NULL)");
    const contents = async (db: DatabaseOperations) => (await db.executeQuery('SELECT a, d, s, b FROM g ORDER BY rowid'))[0].rows;
    const source = [[1, 2, 's1', 'x'], [2, 4, 's2', null]];
    assert.deepEqual(await contents(ops), source);
    // 'D' checks SQLite's case-insensitive names. [] is the SELECT * fallback.
    const selections: Array<[string[], unknown[][]]> = [
        [[], source],
        [['a', 'd', 's', 'b'], source],
        [['a', 'D'], [[1, 2, 's1', null], [2, 4, 's2', null]]]
    ];
    for (const [columns, expected] of selections) {
        const sql = await exportText(ops, 'g', columns, { format: 'sql', includeTableName: true });
        const fresh = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        try {
            await fresh.executeQuery(GENERATED_TABLE_SQL);
            await fresh.executeQuery(sql);
            assert.deepEqual(await contents(fresh), expected, JSON.stringify(columns));
        } finally {
            fresh.shutdown();
        }
    }
    const all = ['a', 'd', 's', 'b'];
    assert.equal(await exportText(ops, 'g', all, { format: 'csv', header: true }), 'a,d,s,b\n1,2,s1,x\n2,4,s2,');
    assert.deepEqual(JSON.parse(await exportText(ops, 'g', all, { format: 'json' })), [
        { a: 1, d: 2, s: 's1', b: 'x' }, { a: 2, d: 4, s: 's2', b: null }
    ]);
    await assert.rejects(exportText(ops, 'g', ['d', 's'], { format: 'sql' }), /generated/);
}

async function withEngine(backend: 'wasm' | 'native', context: { skip(message: string): void }, run: (ops: DatabaseOperations) => Promise<void>) {
    if (backend === 'wasm') {
        const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        try {
            await run(engine);
        } finally {
            engine.shutdown();
        }
        return;
    }
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
        await run(databaseOps);
    } finally {
        native.workerMethods[Symbol.dispose]();
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
}

describe('SQL exports replay to the same cells', () => {
    for (const encoding of ['UTF-8', 'UTF-16le'] as const) {
        it(`from WebAssembly in ${encoding}`, context => withEngine('wasm', context, ops => assertRoundTrip(ops, encoding)));
        it(`from the native engine in ${encoding}`, context => withEngine('native', context, ops => assertRoundTrip(ops, encoding)));
    }
});

describe('SQL exports leave generated columns out', () => {
    it('from WebAssembly', context => withEngine('wasm', context, ops => assertGeneratedColumnsLeftOut(ops, 'wasm')));
    it('from the native engine', context => withEngine('native', context, ops => assertGeneratedColumnsLeftOut(ops, 'native')));
});

// An empty column list exports the columns SELECT * names. The native engine
// takes a result's column names from its first row, so SELECT * ... LIMIT 0
// alone names none there.
const ALL_COLUMNS_SCHEMA = [
    'CREATE TABLE r (id INTEGER PRIMARY KEY, a TEXT, g TEXT GENERATED ALWAYS AS (upper(a)))',
    "INSERT INTO r (id, a) VALUES (1, 'x'), (2, NULL)",
    'CREATE TABLE p (k TEXT PRIMARY KEY, v) WITHOUT ROWID',
    "INSERT INTO p VALUES ('a', 1)",
    'CREATE TABLE e (id INTEGER PRIMARY KEY, a TEXT)',
    'CREATE VIEW vw AS SELECT id, a FROM r',
    // SELECT * leaves out FTS5's hidden table-name and rank columns, and
    // names a view's repeated column a:1.
    'CREATE VIRTUAL TABLE f USING fts5(title, body)',
    "INSERT INTO f VALUES ('t', 'b')",
    'CREATE VIEW twice AS SELECT a, a FROM r'
];

async function exportsWithoutColumnList(ops: DatabaseOperations): Promise<Record<string, string>> {
    for (const sql of ALL_COLUMNS_SCHEMA) await ops.executeQuery(sql);
    const outputs: Record<string, string> = {};
    for (const source of ['r', 'p', 'e', 'vw', 'f', 'twice']) {
        for (const format of ['csv', 'json', 'sql']) {
            outputs[`${source} ${format}`] = await exportText(ops, source, [], { format, header: true, includeTableName: true });
        }
    }
    return outputs;
}

describe('Exports without a column list', () => {
    it('write every column alike from both engines', async context => {
        let wasm: Record<string, string> | undefined;
        let native: Record<string, string> | undefined;
        await withEngine('wasm', context, async ops => { wasm = await exportsWithoutColumnList(ops); });
        await withEngine('native', context, async ops => { native = await exportsWithoutColumnList(ops); });
        assert.equal(wasm?.['r csv'], 'id,a,g\n1,x,X\n2,,');
        assert.equal(wasm?.['e csv'], 'id,a');
        assert.equal(wasm?.['f csv'], 'title,body\nt,b');
        assert.equal(wasm?.['twice csv'], 'a,a:1\nx,x\n,');
        assert.equal(wasm?.['vw sql'], 'INSERT INTO "vw" ("id", "a") VALUES (1, \'x\');\nINSERT INTO "vw" ("id", "a") VALUES (2, NULL);');
        if (native) assert.deepEqual(native, wasm);
    });
});
