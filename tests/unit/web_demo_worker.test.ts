import './vscode_mock_setup';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { Worker as NodeWorker } from 'node:worker_threads';
import esbuild from 'esbuild';
import initSqlJs from '../../vendor/sql.js/sql-wasm.js';
import {
    CellEditPolicyError,
    DEFAULT_MAX_CELL_EDIT_BYTES,
    fromCellEditRpcErrorData
} from '../../src/core/cell-edit-policy';
import { encodePrimaryKeyRecordId } from '../../src/core/row-identity';
import type { PrimaryKeyColumn, RecordId } from '../../src/core/types';

interface WorkerHarness {
    invoke(method: string, ...payload: unknown[]): Promise<any>;
}

const authoredWorkerPath = path.resolve(
    process.cwd(),
    'website/src/sqlite-viewer/worker.js'
);
const bundledWorkerPath = path.resolve(
    process.cwd(),
    'website/public/sqlite-viewer/worker.js'
);
const BUNDLED_SQLJS_SQLITE_VERSION = '3.49.1';
const DIVERGENT_REAL_TEXT_BY_SQLJS_SQLITE_VERSION: Record<string, string> = {
    '3.49.1': '9.6529377952985e+282'
};

let currentWorkerBundle: Promise<string> | undefined;

function readCurrentWorkerBundle(): Promise<string> {
    currentWorkerBundle ??= (async () => {
    assert.ok(
        existsSync(bundledWorkerPath),
        'website worker bundle is missing; run node scripts/build.mjs'
    );
    const rendered = await esbuild.build({
        entryPoints: [authoredWorkerPath],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        target: 'es2020',
        minify: true,
        write: false
    });
    assert.strictEqual(rendered.outputFiles.length, 1);
    const renderedSource = rendered.outputFiles[0].text;
    // Source-only development runs are explicit; the default/full-suite lane
    // continues to enforce the committed bundle byte-for-byte.
    if (process.env.SQLITE_EXPLORER_TEST_AUTHORED_WORKER === '1') {
        return renderedSource;
    }
    const expectedHash = createHash('sha256').update(renderedSource).digest('hex');
    const bundledSource = readFileSync(bundledWorkerPath, 'utf8');
    const bundledHash = bundledSource.match(
        /sqlite-viewer-bundle-sha256:([a-f0-9]{64})/
    )?.[1];
    const freshnessFailure =
        'website worker bundle is stale or esbuild output/version drifted; ' +
        'run node scripts/build.mjs';
    assert.strictEqual(
        bundledHash,
        expectedHash,
        freshnessFailure
    );
    assert.strictEqual(
        bundledSource,
        `/*! sqlite-viewer-bundle-sha256:${expectedHash} */\n${renderedSource}`,
        freshnessFailure
    );
    return bundledSource;
    })();
    return currentWorkerBundle;
}

async function createWorkerHarness(options: {
    content?: Uint8Array;
    queryTimeout?: number;
    now?: () => number;
    readOnlyMode?: boolean;
    cellReadSessionIdleTimeoutMs?: number;
    cellReadSessionAbsoluteTimeoutMs?: number;
    useBundledWasm?: boolean;
    initSqlJs?: (config: any) => Promise<any>;
    onImportScripts?: (url: string) => void;
    onSql?: (kind: 'exec' | 'prepare', sql: string) => void;
    onSqlResult?: (kind: 'exec' | 'prepare', sql: string, result: unknown) => void;
    coerceBigIntsToNumbers?: boolean;
} = {}): Promise<WorkerHarness> {
    const source = await readCurrentWorkerBundle();
    const responses: any[] = [];
    const initializeSqlJs = options.initSqlJs ?? initSqlJs;
    const workerGlobal: any = {
        initSqlJs: async (config: any) => {
            const sqlJs = await initializeSqlJs(config);
            if (!options.onSql && !options.onSqlResult && !options.coerceBigIntsToNumbers) return sqlJs;
            const ObservedDatabase = new Proxy(sqlJs.Database, {
                construct(Target: any, args: any[]): object {
                    const database = Reflect.construct(Target, args) as Record<string, any>;
                    for (const kind of ['exec', 'prepare'] as const) {
                        const original = database[kind].bind(database);
                        database[kind] = (sql: string, ...methodArgs: unknown[]) => {
                            options.onSql?.(kind, sql);
                            const result = original(sql, ...methodArgs);
                            options.onSqlResult?.(kind, sql, result);
                            if (kind !== 'exec' || !options.coerceBigIntsToNumbers) {
                                return result;
                            }
                            return result.map((resultSet: any) => ({
                                ...resultSet,
                                values: resultSet.values.map((row: unknown[]) => row.map(
                                    value => typeof value === 'bigint' ? Number(value) : value
                                ))
                            }));
                        };
                    }
                    return database;
                }
            });
            return { ...sqlJs, Database: ObservedDatabase };
        },
        postMessage(message: unknown) {
            responses.push(message);
        }
    };
    const context = vm.createContext({
        self: workerGlobal,
        importScripts(url: string) { options.onImportScripts?.(url); },
        console: { log() {}, warn() {}, error() {} },
        Uint8Array,
        Int32Array,
        ArrayBuffer,
        SharedArrayBuffer,
        Atomics,
        DataView,
        crypto: webcrypto,
        TextEncoder,
        TextDecoder,
        Date: options.now ? { now: options.now } : Date,
        setTimeout,
        clearTimeout
    });
    new vm.Script(source, { filename: 'website/public/sqlite-viewer/worker.js' })
        .runInContext(context);

    let messageId = 0;
    const invoke = async (method: string, ...payload: unknown[]) => {
        const id = `test_${++messageId}`;
        await workerGlobal.onmessage({
            data: {
                channel: 'rpc',
                content: {
                    kind: 'invoke',
                    messageId: id,
                    targetMethod: method,
                    payload
                }
            }
        });
        const responseIndex = responses.findIndex(message => message.content?.messageId === id);
        assert.notStrictEqual(responseIndex, -1, `worker did not respond to ${method}`);
        const [response] = responses.splice(responseIndex, 1);
        if (!response.content.success) {
            throw fromCellEditRpcErrorData(response.content.error)
                ?? new Error(response.content.errorMessage);
        }
        return response.content.data;
    };

    const initConfig: Record<string, unknown> = {
        content: options.content ?? null,
        queryTimeout: options.queryTimeout,
        readOnlyMode: options.readOnlyMode,
        cellReadSessionIdleTimeoutMs: options.cellReadSessionIdleTimeoutMs,
        cellReadSessionAbsoluteTimeoutMs: options.cellReadSessionAbsoluteTimeoutMs
    };
    if (options.useBundledWasm !== false) {
        initConfig.wasmBinary = new Uint8Array(readFileSync(
            path.resolve(process.cwd(), 'assets/sqlite3.wasm')
        ));
    }
    await invoke('initializeDatabase', 'test.db', initConfig);
    return { invoke };
}

async function workerScalar(worker: WorkerHarness, sql: string): Promise<unknown> {
    const result = await worker.invoke('runQuery', sql);
    return result[0]?.rows?.[0]?.[0];
}

describe('web demo view worker', () => {
    it('returns bounded exports as chunks while preserving CSV, JSON, and SQL bytes', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_stage_e_export (id INTEGER, note TEXT, payload BLOB)'
        );
        await worker.invoke(
            'runQuery',
            'INSERT INTO demo_stage_e_export VALUES (?, ?, ?), (?, ?, ?)',
            [
                1,
                'comma, "quote"\nline',
                new Uint8Array([1, 2, 3, 4]),
                2,
                null,
                new Uint8Array()
            ]
        );
        const invokeExport = (format: string, options: Record<string, unknown> = {}) => worker.invoke(
            'exportTable',
            { table: 'demo_stage_e_export' },
            ['id', 'note', 'payload'],
            {},
            {},
            { format, ...options }
        );

        const csv = await invokeExport('csv');
        assert.strictEqual('content' in csv, false);
        assert.ok(Array.isArray(csv.contentChunks));
        assert.strictEqual(
            Array.from(csv.contentChunks).join(''),
            'id,note,payload\n' +
            '1,"comma, ""quote""\nline",[BLOB]\n' +
            '2,,[BLOB]'
        );

        const json = await invokeExport('json');
        assert.strictEqual('content' in json, false);
        assert.strictEqual(
            Array.from(json.contentChunks).join(''),
            JSON.stringify([
                { id: 1, note: 'comma, "quote"\nline', payload: 'AQIDBA==' },
                { id: 2, note: null, payload: '' }
            ], null, 2)
        );

        const sql = await invokeExport('sql', { includeTableName: false });
        assert.strictEqual('content' in sql, false);
        assert.strictEqual(
            Array.from(sql.contentChunks).join(''),
            'INSERT INTO "table_name" ("id", "note", "payload") VALUES ' +
            '(1, \'comma, "quote"\nline\', X\'01020304\');\n' +
            'INSERT INTO "table_name" ("id", "note", "payload") VALUES (2, NULL, X\'\');'
        );

        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_export_int64 (value); ' +
            'INSERT INTO demo_export_int64 VALUES ' +
            '(9007199254740993), (9223372036854775807), (-9223372036854775808)'
        );
        const invokeInt64Export = (format: string) => worker.invoke(
            'exportTable',
            { table: 'demo_export_int64' },
            ['value'],
            {},
            {},
            { format }
        );
        const decimalLines =
            '9007199254740993\n' +
            '9223372036854775807\n' +
            '-9223372036854775808';
        for (const format of ['csv', 'excel']) {
            const exported = await invokeInt64Export(format);
            assert.strictEqual(Array.from(exported.contentChunks).join(''), `value\n${decimalLines}`);
        }
        const int64Json = await invokeInt64Export('json');
        assert.strictEqual(
            Array.from(int64Json.contentChunks).join(''),
            '[\n' +
            '  {\n    "value": 9007199254740993\n  },\n' +
            '  {\n    "value": 9223372036854775807\n  },\n' +
            '  {\n    "value": -9223372036854775808\n  }\n' +
            ']'
        );
        const int64Sql = await invokeInt64Export('sql');
        const int64SqlText = Array.from(int64Sql.contentChunks).join('');
        assert.strictEqual(
            int64SqlText,
            'INSERT INTO "demo_export_int64" ("value") VALUES (9007199254740993);\n' +
            'INSERT INTO "demo_export_int64" ("value") VALUES (9223372036854775807);\n' +
            'INSERT INTO "demo_export_int64" ("value") VALUES (-9223372036854775808);'
        );
        await worker.invoke('runQuery', 'CREATE TABLE demo_export_int64_copy (value)');
        await worker.invoke(
            'runQuery',
            int64SqlText.replaceAll('"demo_export_int64"', '"demo_export_int64_copy"')
        );
        const restoredInt64 = await worker.invoke(
            'runQuery',
            'SELECT typeof(value), CAST(value AS TEXT) FROM demo_export_int64_copy ORDER BY rowid'
        );
        assert.deepStrictEqual(
            Array.from(restoredInt64[0].rows, (row: unknown[]) => Array.from(row)),
            [
                ['integer', '9007199254740993'],
                ['integer', '9223372036854775807'],
                ['integer', '-9223372036854775808']
            ]
        );
    });

    it('neutralizes formula-bearing TEXT values and headers in bundled CSV exports', async () => {
        const worker = await createWorkerHarness();
        const dangerousHeader = '=WEBSERVICE(A1)';
        const dangerousText = '\uFEFF+SUM(A1:A2)';
        await worker.invoke(
            'runQuery',
            `CREATE TABLE demo_csv_formula ("${dangerousHeader}" TEXT)`
        );
        await worker.invoke(
            'runQuery',
            'INSERT INTO demo_csv_formula VALUES (?)',
            [dangerousText]
        );

        const exported = await worker.invoke(
            'exportTable',
            { table: 'demo_csv_formula' },
            [dangerousHeader],
            {},
            {},
            { format: 'csv' }
        );

        assert.strictEqual(
            Array.from(exported.contentChunks).join(''),
            `"'${dangerousHeader}"\n"'${dangerousText}"`
        );
    });

    it('exports a 2000-column demo table within SQLite result width', async () => {
        const worker = await createWorkerHarness();
        const columns = Array.from({ length: 2000 }, (_, index) => `c${index}`);
        await worker.invoke(
            'runQuery',
            `CREATE TABLE demo_wide_export (` +
            columns.map(column => `"${column}"`).join(', ') +
            ')'
        );
        await worker.invoke(
            'runQuery',
            'INSERT INTO demo_wide_export ("c0", "c1999") VALUES (?, ?)',
            ['first', 'last']
        );

        const exported = await worker.invoke(
            'exportTable',
            { table: 'demo_wide_export' },
            columns,
            {},
            {},
            { format: 'csv' }
        );
        const [header, row] = Array.from(exported.contentChunks).join('').split('\n');

        assert.deepStrictEqual(header.split(','), columns);
        const values = row.split(',');
        assert.strictEqual(values.length, 2000);
        assert.strictEqual(values[0], 'first');
        assert.strictEqual(values[1999], 'last');
        assert.strictEqual(values.slice(1, -1).every(value => value === ''), true);
    });

    it('exports malformed TEXT bytes faithfully in all four demo formats', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_invalid_text_export (value TEXT); ' +
            "INSERT INTO demo_invalid_text_export VALUES (CAST(X'80' AS TEXT))"
        );
        const expected: Record<string, string> = {
            csv: 'value\n[SQLite TEXT bytes; encoding=utf-8; base64=gA==]',
            excel: 'value\n[SQLite TEXT bytes; encoding=utf-8; base64=gA==]',
            json:
                '[\n' +
                '  {\n' +
                '    "value": {"$sqliteExplorerTextBytes":{"encoding":"utf-8","base64":"gA=="}}\n' +
                '  }\n' +
                ']',
            sql: 'INSERT INTO "demo_invalid_text_export" ("value") VALUES (CAST(X\'80\' AS TEXT));'
        };

        for (const format of ['csv', 'excel', 'json', 'sql']) {
            const exported = await worker.invoke(
                'exportTable',
                { table: 'demo_invalid_text_export' },
                ['value'],
                {},
                {},
                { format }
            );
            assert.strictEqual(Array.from(exported.contentChunks).join(''), expected[format]);
        }
    });

    it('round-trips demo SQL exports without losing BLOB, embedded NUL text, or int64 values', async () => {
        const worker = await createWorkerHarness({ coerceBigIntsToNumbers: true });
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_sql_roundtrip (payload BLOB, nul_text TEXT, exact_int INTEGER)'
        );
        await worker.invoke(
            'runQuery',
            'INSERT INTO demo_sql_roundtrip VALUES (?, CAST(? AS TEXT), 9007199254740993)',
            [new Uint8Array([0, 1, 2, 253, 254]), new TextEncoder().encode('before\0after')]
        );

        const exported = await worker.invoke(
            'exportTable',
            { table: 'demo_sql_roundtrip' },
            ['payload', 'nul_text', 'exact_int'],
            {},
            {},
            { format: 'sql' }
        );
        const sql = Array.from(exported.contentChunks).join('');
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_sql_roundtrip_copy ' +
            '(payload BLOB, nul_text TEXT, exact_int INTEGER)'
        );
        await worker.invoke(
            'runQuery',
            sql.replaceAll('"demo_sql_roundtrip"', '"demo_sql_roundtrip_copy"')
        );

        const restored = await worker.invoke(
            'runQuery',
            'SELECT hex(payload), hex(CAST(nul_text AS BLOB)), typeof(exact_int), ' +
            'CAST(exact_int AS TEXT) FROM demo_sql_roundtrip_copy'
        );
        assert.deepStrictEqual(Array.from(restored[0].rows[0]), [
            '000102FDFE',
            '6265666F7265006166746572',
            'integer',
            '9007199254740993'
        ]);
    });

    it('round-trips demo JSON exports without losing BLOB, embedded NUL text, or int64 values', async () => {
        const worker = await createWorkerHarness({ coerceBigIntsToNumbers: true });
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_json_roundtrip (payload BLOB, nul_text TEXT, exact_int INTEGER)'
        );
        await worker.invoke(
            'runQuery',
            'INSERT INTO demo_json_roundtrip VALUES (?, CAST(? AS TEXT), 9007199254740993)',
            [new Uint8Array([0, 1, 2, 253, 254]), new TextEncoder().encode('before\0after')]
        );

        const exported = await worker.invoke(
            'exportTable',
            { table: 'demo_json_roundtrip' },
            ['payload', 'nul_text', 'exact_int'],
            {},
            {},
            { format: 'json' }
        );
        const json = Array.from(exported.contentChunks).join('');
        assert.match(json, /"exact_int": 9007199254740993/);
        const [row] = JSON.parse(json);
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_json_roundtrip_copy ' +
            '(payload BLOB, nul_text TEXT, exact_int INTEGER)'
        );
        await worker.invoke(
            'runQuery',
            'INSERT INTO demo_json_roundtrip_copy VALUES ' +
            '(?, CAST(? AS TEXT), json_extract(?, \'$[0].exact_int\'))',
            [
                new Uint8Array(Buffer.from(row.payload, 'base64')),
                new TextEncoder().encode(row.nul_text),
                json
            ]
        );

        const restored = await worker.invoke(
            'runQuery',
            'SELECT hex(payload), hex(CAST(nul_text AS BLOB)), typeof(exact_int), ' +
            'CAST(exact_int AS TEXT) FROM demo_json_roundtrip_copy'
        );
        assert.deepStrictEqual(Array.from(restored[0].rows[0]), [
            '000102FDFE',
            '6265666F7265006166746572',
            'integer',
            '9007199254740993'
        ]);
    });

    it('splits bounded web-demo output into assembly chunks instead of one response string', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE TABLE demo_stage_e_chunks (value TEXT)');
        await worker.invoke(
            'runQuery',
            'INSERT INTO demo_stage_e_chunks VALUES (?)',
            ['x'.repeat(160 * 1024)]
        );

        const exported = await worker.invoke(
            'exportTable',
            { table: 'demo_stage_e_chunks' },
            ['value'],
            {},
            {},
            { format: 'json' }
        );

        assert.strictEqual('content' in exported, false);
        assert.ok(exported.contentChunks.length > 1);
        assert.ok(Array.from(exported.contentChunks).every(
            (chunk: unknown) => typeof chunk === 'string' && chunk.length <= 64 * 1024
        ));
        assert.strictEqual(
            JSON.parse(Array.from(exported.contentChunks).join(''))[0].value.length,
            160 * 1024
        );
    });

    it('refuses oversized web-demo exports before fetching whole cell content', async () => {
        const observedSql: string[] = [];
        const worker = await createWorkerHarness({
            onSql: (_kind, sql) => observedSql.push(sql)
        });
        await worker.invoke('runQuery', 'CREATE TABLE demo_stage_e_cap (payload BLOB)');
        await worker.invoke(
            'runQuery',
            `INSERT INTO demo_stage_e_cap VALUES (zeroblob(${16 * 1024 * 1024 + 1}))`
        );

        await assert.rejects(
            worker.invoke(
                'exportTable',
                { table: 'demo_stage_e_cap' },
                ['payload'],
                {},
                {},
                { format: 'json' }
            ),
            /limited to 16 MiB \(16,777,216 bytes\).*worker RPC cannot stream downloads/i
        );
        assert.ok(
            observedSql.every(sql => !/^SELECT\s+"payload"\s+FROM\s+"demo_stage_e_cap"/i.test(sql)),
            `oversized export fetched the whole cell: ${observedSql.join('\n')}`
        );
    });

    it('exports oversized CSV/Excel BLOB placeholders without transporting source bytes', async () => {
        const projectionResults: unknown[] = [];
        const worker = await createWorkerHarness({
            onSqlResult: (kind, sql, result) => {
                if (
                    kind === 'exec'
                    && sql.includes('FROM "demo_format_blob_placeholder"')
                    && !/COUNT\s*\(\s*\*\s*\)/i.test(sql)
                ) {
                    projectionResults.push(result);
                }
            }
        });
        await worker.invoke('runQuery', 'CREATE TABLE demo_format_blob_placeholder (payload BLOB)');
        await worker.invoke(
            'runQuery',
            `INSERT INTO demo_format_blob_placeholder VALUES (zeroblob(${16 * 1024 * 1024 + 1}))`
        );

        for (const format of ['csv', 'excel']) {
            const exported = await worker.invoke(
                'exportTable',
                { table: 'demo_format_blob_placeholder' },
                ['payload'],
                {},
                {},
                { format }
            );
            assert.strictEqual(
                Array.from(exported.contentChunks).join(''),
                'payload\n[BLOB]'
            );
        }
        assert.strictEqual(projectionResults.length, 2);
        const containsBlobBytes = (value: unknown): boolean => {
            if (value instanceof Uint8Array) return value.byteLength > 0;
            if (Array.isArray(value)) return value.some(containsBlobBytes);
            if (value && typeof value === 'object') {
                return Object.values(value as Record<string, unknown>).some(containsBlobBytes);
            }
            return false;
        };
        assert.strictEqual(projectionResults.some(containsBlobBytes), false);
    });

    it('rejects JSON base64 and SQL hex expansion before fetching BLOB bytes', async () => {
        const observedSql: string[] = [];
        const worker = await createWorkerHarness({
            onSql: (kind, sql) => {
                if (kind === 'exec') observedSql.push(sql);
            }
        });
        await worker.invoke('runQuery', 'CREATE TABLE demo_format_blob_expansion (payload BLOB)');
        await worker.invoke(
            'runQuery',
            `INSERT INTO demo_format_blob_expansion VALUES (zeroblob(${13 * 1024 * 1024}))`
        );

        for (const format of ['json', 'sql']) {
            const projectionCountBefore = observedSql.filter(
                sql => /^SELECT\s+CASE\s+typeof\("payload"\)/i.test(sql)
            ).length;
            await assert.rejects(
                worker.invoke(
                    'exportTable',
                    { table: 'demo_format_blob_expansion' },
                    ['payload'],
                    {},
                    {},
                    { format }
                ),
                /limited to 16 MiB \(16,777,216 bytes\)/i
            );
            const projectionCountAfter = observedSql.filter(
                sql => /^SELECT\s+CASE\s+typeof\("payload"\)/i.test(sql)
            ).length;
            assert.strictEqual(
                projectionCountAfter,
                projectionCountBefore,
                `${format} fetched BLOB bytes before enforcing encoded output size`
            );
        }
    });

    it('chunks a 5000-row seven-column selected export below the SQLite bind limit', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_wide_selected_export (' +
            'a INTEGER, b INTEGER, c INTEGER, d INTEGER, e INTEGER, f INTEGER, g INTEGER, ' +
            'value TEXT, PRIMARY KEY (a, b, c, d, e, f, g)' +
            ') WITHOUT ROWID; ' +
            'WITH RECURSIVE ids(value) AS (' +
            'VALUES(1) UNION ALL SELECT value + 1 FROM ids WHERE value < 5000' +
            ') INSERT INTO demo_wide_selected_export ' +
            "SELECT value, 0, 0, 0, 0, 0, 0, printf('row-%d', value) FROM ids"
        );
        const keyColumns: PrimaryKeyColumn[] = 'abcdefg'.split('').map((identifier, index) => ({
            identifier,
            declaredType: 'INTEGER',
            position: index + 1
        }));
        const rowIds = Array.from({ length: 5000 }, (_, index) => (
            encodePrimaryKeyRecordId(keyColumns, [index + 1, 0, 0, 0, 0, 0, 0])
        ));

        const exported = await worker.invoke(
            'exportTable',
            { table: 'demo_wide_selected_export' },
            ['value'],
            {},
            {},
            { format: 'csv', rowIds }
        );
        const values = Array.from(exported.contentChunks).join('').split('\n').slice(1);
        assert.strictEqual(values.length, 5000);
        assert.strictEqual(new Set(values).size, 5000);
        assert.ok(values.includes('row-1'));
        assert.ok(values.includes('row-5000'));
    });

    it('chunks a demo rowid delete above the SQLite bind limit', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_bulk_rowid_delete (value INTEGER); ' +
            'WITH RECURSIVE ids(value) AS (' +
            'VALUES(1) UNION ALL SELECT value + 1 FROM ids WHERE value < 32768' +
            ') INSERT INTO demo_bulk_rowid_delete SELECT value FROM ids'
        );
        const rowIds = Array.from({ length: 32_768 }, (_, index) => index + 1);

        const deleted = await worker.invoke('deleteRows', 'demo_bulk_rowid_delete', rowIds);
        assert.strictEqual(deleted.length, 32_768);
        assert.strictEqual(new Set(deleted.map((row: { rowId: RecordId }) => (
            String(row.rowId)
        ))).size, 32_768);
        const remaining = await worker.invoke(
            'runQuery',
            'SELECT count(*) FROM demo_bulk_rowid_delete'
        );
        assert.deepStrictEqual(remaining[0].rows, [[0]]);
    });

    it('preserves an untouched unsafe typeless key member across guarded replacement and PK edits', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_typeless_key_update (' +
            'id, shard TEXT, payload BLOB, PRIMARY KEY (id, shard)' +
            ') WITHOUT ROWID; ' +
            "INSERT INTO demo_typeless_key_update VALUES (9007199254740993, 'a', X'01020304')"
        );
        const keyColumns: PrimaryKeyColumn[] = [
            { identifier: 'id', declaredType: '', position: 1 },
            { identifier: 'shard', declaredType: 'TEXT', position: 2 }
        ];
        const rowId = encodePrimaryKeyRecordId(keyColumns, [9007199254740993n, 'a']);

        assert.strictEqual(
            await worker.invoke(
                'replaceOversizedCell',
                'demo_typeless_key_update',
                rowId,
                'payload',
                new Uint8Array([9]),
                { storageClass: 'blob', byteLength: 4 },
                2
            ),
            rowId
        );
        const changedRowId = await worker.invoke(
            'updateCell',
            'demo_typeless_key_update',
            rowId,
            'shard',
            'b'
        );
        assert.match(changedRowId, /^pk:/);
        const row = await worker.invoke(
            'runQuery',
            'SELECT typeof(id), CAST(id AS TEXT), shard, hex(payload) ' +
            'FROM demo_typeless_key_update'
        );
        assert.deepStrictEqual(row[0].rows, [[
            'integer',
            '9007199254740993',
            'b',
            '09'
        ]]);
    });

    it('enforces typed new-value limits and guarded oversized replacement', async () => {
        const observedSql: string[] = [];
        const worker = await createWorkerHarness({
            onSql: (_kind, sql) => observedSql.push(sql)
        });
        const limit = 1024;
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_stage_d (payload BLOB); ' +
            `INSERT INTO demo_stage_d VALUES (zeroblob(${limit + 1}))`
        );

        await assert.rejects(
            worker.invoke(
                'updateCell',
                'demo_stage_d',
                1,
                'payload',
                new Uint8Array(limit + 1),
                undefined,
                limit
            ),
            error => {
                assert.ok(error instanceof CellEditPolicyError);
                assert.strictEqual(error.actualBytes, limit + 1);
                assert.strictEqual(error.limitBytes, limit);
                return true;
            }
        );

        observedSql.length = 0;
        await worker.invoke(
            'replaceOversizedCell',
            'demo_stage_d',
            1,
            'payload',
            'bounded',
            { storageClass: 'blob', byteLength: limit + 1 },
            limit
        );
        assert.ok(
            observedSql.every(sql => !/^\s*SELECT\s+"payload"\b/i.test(sql)),
            `demo replacement selected the prior payload: ${observedSql.join('\n')}`
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT payload FROM demo_stage_d'),
            'bounded'
        );

        const legacyValue = new Uint8Array(DEFAULT_MAX_CELL_EDIT_BYTES + 1);
        await assert.rejects(
            worker.invoke('updateCell', 'demo_stage_d', 1, 'payload', legacyValue),
            CellEditPolicyError
        );
        const legacyModification = {
            modificationType: 'cell_update',
            description: 'legacy oversized prior',
            targetTable: 'demo_stage_d',
            targetRowId: 1,
            targetColumn: 'payload',
            priorValue: legacyValue,
            newValue: 'bounded'
        };
        await worker.invoke('undoModification', legacyModification);
        assert.strictEqual(
            await workerScalar(worker, 'SELECT length(payload) FROM demo_stage_d'),
            legacyValue.byteLength
        );
        await worker.invoke('redoModification', legacyModification);
        assert.strictEqual(
            await workerScalar(worker, 'SELECT payload FROM demo_stage_d'),
            'bounded'
        );
    });

    it('rejects a demo JSON patch whose resulting stored value is oversized', async () => {
        const worker = await createWorkerHarness();
        const prior = JSON.stringify({ a: 'x'.repeat(32) });
        const patch = JSON.stringify({ b: 'y'.repeat(32) });
        const limit = 64;
        await worker.invoke('runQuery', 'CREATE TABLE demo_patch_limits (payload TEXT)');
        await worker.invoke('insertRow', 'demo_patch_limits', { payload: prior }, limit);

        await assert.rejects(
            worker.invoke(
                'updateCellBatch',
                'demo_patch_limits',
                [{ rowId: 1, column: 'payload', value: patch, operation: 'json_patch' }],
                undefined,
                limit
            ),
            error => {
                assert.ok(error instanceof CellEditPolicyError);
                assert.strictEqual(error.storageClass, 'text');
                assert.ok(error.actualBytes > limit);
                return true;
            }
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT payload FROM demo_patch_limits'),
            prior
        );
    });

    it('loads the patched sql.js release from self-hosted files', async () => {
        const importedUrls: string[] = [];
        let wasmUrl = '';

        await createWorkerHarness({
            useBundledWasm: false,
            onImportScripts: url => importedUrls.push(url),
            initSqlJs: async config => {
                wasmUrl = config.locateFile('sql-wasm.wasm');
                return { Database: class {} };
            }
        });

        assert.deepStrictEqual(importedUrls, [
            './sql-wasm.js'
        ]);
        assert.strictEqual(
            wasmUrl,
            './sql-wasm.wasm'
        );
    });

    it('deletes a column using the demo worker table-info shape', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE TABLE demo_delete (id INTEGER, kept TEXT, removed TEXT); " +
            "INSERT INTO demo_delete VALUES (1, 'survives', 'gone')"
        );

        await worker.invoke('deleteColumns', 'demo_delete', ['removed']);

        const tableInfo = await worker.invoke('getTableInfo', 'demo_delete');
        assert.deepStrictEqual(
            Array.from(tableInfo, (column: any) => column.identifier),
            ['id', 'kept']
        );
        const rows = await worker.invoke('runQuery', 'SELECT id, kept FROM demo_delete');
        assert.deepStrictEqual(Array.from(rows[0].rows[0]), [1, 'survives']);
    });

    it('drops a demo column without changing surviving schema contracts', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'PRAGMA foreign_keys = ON; ' +
            'CREATE TABLE demo_parent (id INTEGER PRIMARY KEY); ' +
            'CREATE TABLE demo_audit (message TEXT); ' +
            'CREATE TABLE demo_constraints (' +
            'id INTEGER PRIMARY KEY, ' +
            'code TEXT NOT NULL UNIQUE, ' +
            'qty INTEGER NOT NULL CHECK (qty > 0), ' +
            'parent_id INTEGER REFERENCES demo_parent(id), ' +
            'removed TEXT, ' +
            'generated TEXT GENERATED ALWAYS AS (code || \':\' || qty) STORED' +
            ') WITHOUT ROWID; ' +
            'CREATE INDEX demo_constraints_qty ON demo_constraints(qty); ' +
            'CREATE INDEX demo_constraints_removed ON demo_constraints(removed); ' +
            'CREATE TRIGGER demo_constraints_audit AFTER UPDATE OF qty ON demo_constraints ' +
            'BEGIN INSERT INTO demo_audit VALUES (NEW.code); END; ' +
            "INSERT INTO demo_parent VALUES (1); " +
            "INSERT INTO demo_constraints(id, code, qty, parent_id, removed) " +
            "VALUES (1, 'kept', 2, 1, 'gone')"
        );
        const untouchedBefore = await worker.invoke(
            'runQuery',
            "SELECT type, name, sql FROM sqlite_master " +
            "WHERE name IN ('demo_constraints_qty', 'demo_constraints_audit') ORDER BY type, name"
        );

        await worker.invoke(
            'deleteColumns',
            'demo_constraints',
            ['removed'],
            ['demo_constraints_removed']
        );

        const untouchedAfter = await worker.invoke(
            'runQuery',
            "SELECT type, name, sql FROM sqlite_master " +
            "WHERE name IN ('demo_constraints_qty', 'demo_constraints_audit') ORDER BY type, name"
        );
        assert.deepStrictEqual(
            Array.from(untouchedAfter[0]?.rows ?? [], (row: unknown[]) => Array.from(row)),
            Array.from(untouchedBefore[0].rows, (row: unknown[]) => Array.from(row))
        );
        assert.strictEqual(
            await workerScalar(
                worker,
                "SELECT count(*) FROM sqlite_master " +
                "WHERE type = 'index' AND name = 'demo_constraints_removed'"
            ),
            0
        );
        const tableSql = String(await workerScalar(
            worker,
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'demo_constraints'"
        ));
        assert.match(tableSql, /PRIMARY KEY/i);
        assert.match(tableSql, /UNIQUE/i);
        assert.match(tableSql, /CHECK\s*\(qty\s*>\s*0\)/i);
        assert.match(tableSql, /REFERENCES\s+demo_parent/i);
        assert.match(tableSql, /GENERATED ALWAYS/i);
        assert.match(tableSql, /WITHOUT ROWID/i);
        assert.doesNotMatch(tableSql, /\bremoved\b/i);

        await worker.invoke(
            'runQuery',
            'UPDATE demo_constraints SET qty = 3 WHERE id = 1'
        );
        assert.strictEqual(await workerScalar(worker, 'SELECT message FROM demo_audit'), 'kept');
        assert.strictEqual(
            await workerScalar(worker, 'SELECT generated FROM demo_constraints WHERE id = 1'),
            'kept:3'
        );
        await assert.rejects(
            worker.invoke(
                'runQuery',
                "INSERT INTO demo_constraints(id, code, qty, parent_id) VALUES (2, 'kept', 1, 1)"
            ),
            /UNIQUE constraint failed/i
        );
        await assert.rejects(
            worker.invoke(
                'runQuery',
                "INSERT INTO demo_constraints(id, code, qty, parent_id) VALUES (2, 'bad-check', 0, 1)"
            ),
            /CHECK constraint failed/i
        );
        await assert.rejects(
            worker.invoke(
                'runQuery',
                "INSERT INTO demo_constraints(id, code, qty, parent_id) VALUES (2, 'bad-fk', 1, 99)"
            ),
            /FOREIGN KEY constraint failed/i
        );
    });

    it('does not execute a trailing statement smuggled through preview', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE TABLE preview_sentinel (id INTEGER)');

        await assert.rejects(() => worker.invoke(
            'previewViewDefinition',
            'unsafe_preview',
            'SELECT 1) LIMIT 1; DROP TABLE preview_sentinel; --',
            10,
            'create'
        ));

        assert.strictEqual(await workerScalar(
            worker,
            "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = 'preview_sentinel'"
        ), 1);
    });

    it('preserves duplicate explicit columns through an edit', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE VIEW duplicate_names (a, a) AS SELECT 1, 2');

        await worker.invoke('editView', 'duplicate_names', 'SELECT 3, 4', true);

        const storedSql = await workerScalar(
            worker,
            "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = 'duplicate_names'"
        );
        assert.match(String(storedSql), /\(a, a\)/);
        assert.doesNotMatch(String(storedSql), /a:1/);
    });

    it('rejects a stale expected view definition without replacing the newer demo view', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE VIEW shared_view AS SELECT 1 AS value');
        const stale = await worker.invoke('getViewDefinition', 'shared_view');
        await worker.invoke(
            'runQuery',
            'DROP VIEW shared_view; CREATE VIEW shared_view AS SELECT 2 AS value'
        );

        await assert.rejects(
            worker.invoke(
                'editView',
                'shared_view',
                'SELECT 3 AS value',
                true,
                stale.sql
            ),
            /changed outside this editor/i
        );
        assert.strictEqual(await workerScalar(worker, 'SELECT value FROM shared_view'), 2);
    });

    it('rejects a stale trigger snapshot before discarding demo triggers', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE VIEW trigger_cas_view AS SELECT 1 AS value');
        await worker.invoke(
            'runQuery',
            'CREATE TRIGGER trigger_cas_first INSTEAD OF INSERT ON trigger_cas_view ' +
            'BEGIN SELECT 1; END'
        );
        const stale = await worker.invoke('getViewDefinition', 'trigger_cas_view');
        await worker.invoke(
            'runQuery',
            'CREATE TRIGGER trigger_cas_second INSTEAD OF UPDATE ON trigger_cas_view ' +
            'BEGIN SELECT 2; END'
        );

        await assert.rejects(
            worker.invoke(
                'editView',
                'trigger_cas_view',
                'SELECT 2 AS value',
                false,
                stale.sql,
                stale.triggers
            ),
            /changed outside this editor/i
        );
        const current = await worker.invoke('getViewDefinition', 'trigger_cas_view');
        assert.strictEqual(current.selectSql, 'SELECT 1 AS value');
        assert.deepStrictEqual(
            Array.from(current.triggers, (trigger: any) => trigger.identifier),
            ['trigger_cas_first', 'trigger_cas_second']
        );
    });

    it('rejects demo view-history undo and redo when the installed state changed', async () => {
        const worker = await createWorkerHarness();
        const before = await worker.invoke('createView', 'demo_history_cas', 'SELECT 1 AS value');
        const edit = await worker.invoke(
            'editView',
            'demo_history_cas',
            'SELECT 2 AS value',
            true
        );
        const modification = {
            description: 'Edit demo_history_cas',
            modificationType: 'view_edit',
            targetTable: 'demo_history_cas',
            viewDefBefore: before,
            viewDefAfter: edit.after
        };

        await worker.invoke(
            'runQuery',
            'CREATE TRIGGER demo_history_undo_external ' +
            'INSTEAD OF INSERT ON demo_history_cas BEGIN SELECT 1; END'
        );
        await assert.rejects(
            worker.invoke('undoModification', modification),
            /changed outside this editor/i
        );
        let current = await worker.invoke('getViewDefinition', 'demo_history_cas');
        assert.strictEqual(current.selectSql, 'SELECT 2 AS value');
        assert.deepStrictEqual(
            Array.from(current.triggers, (trigger: any) => trigger.identifier),
            ['demo_history_undo_external']
        );

        await worker.invoke('runQuery', 'DROP TRIGGER demo_history_undo_external');
        await worker.invoke('undoModification', modification);
        await worker.invoke(
            'runQuery',
            'CREATE TRIGGER demo_history_redo_external ' +
            'INSTEAD OF UPDATE ON demo_history_cas BEGIN SELECT 2; END'
        );
        await assert.rejects(
            worker.invoke('redoModification', modification),
            /changed outside this editor/i
        );
        current = await worker.invoke('getViewDefinition', 'demo_history_cas');
        assert.strictEqual(current.selectSql, 'SELECT 1 AS value');
        assert.deepStrictEqual(
            Array.from(current.triggers, (trigger: any) => trigger.identifier),
            ['demo_history_redo_external']
        );
    });

    it('rejects a demo drop whose confirmed trigger snapshot became stale', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('createView', 'demo_drop_cas', 'SELECT 1 AS value');
        await worker.invoke(
            'runQuery',
            'CREATE TRIGGER demo_drop_first ' +
            'INSTEAD OF INSERT ON demo_drop_cas BEGIN SELECT 1; END'
        );
        const confirmed = await worker.invoke('getViewDefinition', 'demo_drop_cas');
        await worker.invoke(
            'runQuery',
            'CREATE TRIGGER demo_drop_second ' +
            'INSTEAD OF UPDATE ON demo_drop_cas BEGIN SELECT 2; END'
        );

        await assert.rejects(
            worker.invoke(
                'dropView',
                'demo_drop_cas',
                confirmed.sql,
                confirmed.triggers
            ),
            /changed outside this editor/i
        );
        const current = await worker.invoke('getViewDefinition', 'demo_drop_cas');
        assert.deepStrictEqual(
            Array.from(current.triggers, (trigger: any) => trigger.identifier),
            ['demo_drop_first', 'demo_drop_second']
        );
    });

    it('previews an edited view through its preserved explicit column list', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE VIEW preview_columns (public_id, public_name) AS " +
            "SELECT 1 AS internal_id, 'before' AS internal_name"
        );

        const preview = await worker.invoke(
            'previewViewDefinition',
            'preview_columns',
            "SELECT 2 AS replacement_id, 'after' AS replacement_name",
            10
        );

        assert.deepStrictEqual(Array.from(preview.headers), ['public_id', 'public_name']);
        assert.deepStrictEqual(
            Array.from(preview.rows, (row: unknown[]) => Array.from(row)),
            [[2, 'after']]
        );
    });

    it('previews an edit in the target-name context instead of reading the old demo view', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('createView', 'self_shadowed_view', 'SELECT 7 AS value');

        await assert.rejects(
            worker.invoke(
                'previewViewDefinition',
                'self_shadowed_view',
                'SELECT value FROM main.self_shadowed_view',
                10
            ),
            /circular/i
        );
        assert.strictEqual(await workerScalar(worker, 'SELECT value FROM self_shadowed_view'), 7);
    });

    it('edits and drops main views without touching same-named TEMP views', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('createView', 'demo_shadowed_view', "SELECT 'main-before' AS value");
        await worker.invoke(
            'runQuery',
            "CREATE TEMP VIEW demo_shadowed_view AS SELECT 'temp-value' AS value"
        );

        await worker.invoke(
            'editView',
            'demo_shadowed_view',
            "SELECT 'main-after' AS value",
            true
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM main.demo_shadowed_view'),
            'main-after'
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM temp.demo_shadowed_view'),
            'temp-value'
        );

        await worker.invoke('dropView', 'demo_shadowed_view');
        assert.strictEqual(await workerScalar(
            worker,
            "SELECT count(*) FROM sqlite_schema WHERE type = 'view' AND name = 'demo_shadowed_view'"
        ), 0);
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM temp.demo_shadowed_view'),
            'temp-value'
        );
    });

    it('compiles created and edited main views through broken TEMP shadows', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TEMP VIEW demo_create_compile_shadow AS ' +
            'SELECT value FROM missing_demo_create_source'
        );

        await worker.invoke(
            'createView',
            'demo_create_compile_shadow',
            "SELECT 'main-created' AS value"
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM main.demo_create_compile_shadow'),
            'main-created'
        );

        await worker.invoke(
            'createView',
            'demo_edit_compile_shadow',
            "SELECT 'main-before' AS value"
        );
        await worker.invoke(
            'runQuery',
            'CREATE TEMP VIEW demo_edit_compile_shadow AS ' +
            'SELECT value FROM missing_demo_edit_source'
        );
        await worker.invoke(
            'editView',
            'demo_edit_compile_shadow',
            "SELECT 'main-after' AS value",
            true
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM main.demo_edit_compile_shadow'),
            'main-after'
        );
    });

    it('validates and previews the main demo view through a same-named TEMP shadow', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('createView', 'demo_dry_run_shadow', "SELECT 'main-before' AS value");
        await worker.invoke(
            'runQuery',
            "CREATE TEMP VIEW demo_dry_run_shadow AS SELECT 'temp-value' AS value"
        );

        await worker.invoke(
            'validateViewDefinition',
            'demo_dry_run_shadow',
            "SELECT 'candidate' AS value",
            'edit'
        );
        const preview = await worker.invoke(
            'previewViewDefinition',
            'demo_dry_run_shadow',
            "SELECT 'candidate' AS value",
            10,
            'edit'
        );

        assert.deepStrictEqual(Array.from(preview.headers), ['value']);
        assert.deepStrictEqual(
            Array.from(preview.rows, (row: unknown[]) => Array.from(row)),
            [['candidate']]
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM main.demo_dry_run_shadow'),
            'main-before'
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM temp.demo_dry_run_shadow'),
            'temp-value'
        );
    });

    it('treats percent and underscore filters as literal LIKE text', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE TABLE literal_filters (value TEXT); " +
            "INSERT INTO literal_filters VALUES ('100% literal'), ('1000 literal'), " +
            "('under_score'), ('underXscore')"
        );

        const percent = await worker.invoke('fetchTableData', 'literal_filters', {
            columns: ['value'],
            filters: [{ column: 'value', value: '%' }],
            limit: 100,
            offset: 0
        });
        const underscore = await worker.invoke('fetchTableData', 'literal_filters', {
            columns: ['value'],
            globalFilter: '_',
            limit: 100,
            offset: 0
        });
        const underscoreCount = await worker.invoke('fetchTableCount', 'literal_filters', {
            columns: ['value'],
            globalFilter: '_'
        });

        assert.deepStrictEqual(
            Array.from(percent.rows, (row: unknown[]) => Array.from(row)),
            [['100% literal']]
        );
        assert.deepStrictEqual(
            Array.from(underscore.rows, (row: unknown[]) => Array.from(row)),
            [['under_score']]
        );
        assert.deepStrictEqual({ ...underscoreCount }, { count: 1, isExact: true });
    });

    it('matches native/WASM bounded TEXT and BLOB grid previews', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_contained_cells (text_value TEXT, blob_value BLOB); ' +
            "INSERT INTO demo_contained_cells VALUES ('😀😀😀', x'000102030405060708090a0b'); " +
            "INSERT INTO demo_contained_cells VALUES ('ok', x'0102')"
        );

        const page = await worker.invoke('fetchTableData', 'demo_contained_cells', {
            columns: ['rowid', 'text_value', 'blob_value'],
            orderBy: 'rowid',
            limit: 2,
            offset: 0,
            maxInlineCellBytes: 8,
            maxPageResponseBytes: 64
        });

        assert.deepStrictEqual(Array.from(page.rows[0].slice(0, 2)), [1, '😀😀']);
        assert.deepStrictEqual(Array.from(page.rows[0][2]), [0, 1, 2, 3, 4, 5, 6, 7]);
        assert.deepStrictEqual(Array.from(page.rows[1].slice(0, 2)), [2, 'ok']);
        assert.deepStrictEqual(Array.from(page.rows[1][2]), [1, 2]);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(page.oversizedCells)), {
            0: {
                1: { storageClass: 'text', byteLength: 12 },
                2: { storageClass: 'blob', byteLength: 12 }
            }
        });

        const small = await worker.invoke('fetchTableData', 'demo_contained_cells', {
            columns: ['rowid', 'text_value', 'blob_value'],
            filters: [{ column: 'text_value', value: 'ok' }],
            limit: 1,
            offset: 0,
            maxInlineCellBytes: 8,
            maxPageResponseBytes: 64
        });
        assert.deepStrictEqual(Array.from(small.rows[0].slice(0, 2)), [2, 'ok']);
        assert.deepStrictEqual(Array.from(small.rows[0][2]), [1, 2]);
        assert.strictEqual(small.oversizedCells, undefined);
    });

    it('clips aggregate BLOB previews before demo worker transport', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_predecode_page_bound (a BLOB, b BLOB, c BLOB, d BLOB); ' +
            'INSERT INTO demo_predecode_page_bound VALUES ' +
            '(zeroblob(300), zeroblob(300), zeroblob(300), zeroblob(300)), ' +
            '(zeroblob(300), zeroblob(300), zeroblob(300), zeroblob(300)), ' +
            '(zeroblob(300), zeroblob(300), zeroblob(300), zeroblob(300)), ' +
            '(zeroblob(300), zeroblob(300), zeroblob(300), zeroblob(300))'
        );
        const page = await worker.invoke('fetchTableData', 'demo_predecode_page_bound', {
            columns: ['rowid', 'a', 'b', 'c', 'd'],
            orderBy: 'rowid',
            limit: 4,
            offset: 0,
            maxInlineCellBytes: 1024 * 1024,
            maxPageResponseBytes: 80
        });

        assert.strictEqual(page.rows.length, 4);
        for (let rowIndex = 0; rowIndex < page.rows.length; rowIndex++) {
            for (let columnIndex = 1; columnIndex < 5; columnIndex++) {
                assert.strictEqual(page.rows[rowIndex][columnIndex].byteLength, 4);
                assert.deepStrictEqual(
                    JSON.parse(JSON.stringify(page.oversizedCells[rowIndex][columnIndex])),
                    { storageClass: 'blob', byteLength: 300 }
                );
            }
        }
    });

    it('keeps demo cell chunks on one snapshot and preserves multibyte byte boundaries', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_cell_read_sessions (blob_value BLOB, text_value TEXT); ' +
            "INSERT INTO demo_cell_read_sessions VALUES (x'4141414142424242', 'A😀Bé𝄞Z')"
        );

        const blobSession = await worker.invoke('openCellReadSession', {
            table: 'demo_cell_read_sessions',
            rowId: 1,
            column: 'blob_value'
        });
        assert.deepStrictEqual(JSON.parse(JSON.stringify(blobSession.metadata)), {
            storageClass: 'blob',
            byteLength: 8
        });
        assert.deepStrictEqual(
            Array.from((await worker.invoke('readCellChunk', blobSession.sessionId, 0, 4)).bytes),
            [65, 65, 65, 65]
        );
        await assert.rejects(
            worker.invoke(
                'updateCell',
                'demo_cell_read_sessions',
                1,
                'blob_value',
                Uint8Array.from([67, 67, 67, 67, 68, 68, 68, 68])
            ),
            /cell read snapshot is active/i
        );
        assert.deepStrictEqual(
            Array.from((await worker.invoke('readCellChunk', blobSession.sessionId, 4, 4)).bytes),
            [66, 66, 66, 66]
        );
        await worker.invoke('closeCellReadSession', blobSession.sessionId);

        const textSession = await worker.invoke('openCellReadSession', {
            table: 'demo_cell_read_sessions',
            rowId: 1,
            column: 'text_value'
        });
        const expected = new TextEncoder().encode('A😀Bé𝄞Z');
        const assembled: number[] = [];
        for (let offset = 0; offset < expected.byteLength; offset += 2) {
            const chunk = await worker.invoke('readCellChunk', textSession.sessionId, offset, 2);
            assembled.push(...Array.from(chunk.bytes as Uint8Array));
        }
        assert.deepStrictEqual(Uint8Array.from(assembled), expected);
        await worker.invoke('closeCellReadSession', textSession.sessionId);
    });

    it('expires demo cell read sessions and releases their savepoint', async () => {
        const worker = await createWorkerHarness({
            cellReadSessionIdleTimeoutMs: 20,
            cellReadSessionAbsoluteTimeoutMs: 100
        });
        await worker.invoke(
            'runQuery',
            "CREATE TABLE demo_expiring_cell (value TEXT); INSERT INTO demo_expiring_cell VALUES ('old')"
        );
        const session = await worker.invoke('openCellReadSession', {
            table: 'demo_expiring_cell',
            rowId: 1,
            column: 'value'
        });

        await new Promise(resolve => setTimeout(resolve, 40));
        await assert.rejects(
            worker.invoke('readCellChunk', session.sessionId, 0, 2),
            /closed or expired/i
        );
        await worker.invoke('updateCell', 'demo_expiring_cell', 1, 'value', 'new');
        assert.strictEqual(await workerScalar(
            worker,
            'SELECT value FROM demo_expiring_cell WHERE rowid = 1'
        ), 'new');
    });

    it('marks an oversized demo WITHOUT ROWID primary key read-only', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_oversized_identity ' +
            '(key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID; ' +
            "INSERT INTO demo_oversized_identity VALUES ('abcdefghijklmnopqrstuvwxyz012345', 'visible')"
        );
        const page = await worker.invoke('fetchTableData', 'demo_oversized_identity', {
            columns: ['rowid', 'key', 'value'],
            limit: 1,
            offset: 0,
            maxInlineCellBytes: 8,
            maxPageResponseBytes: 64
        });
        const identity = page.rows[0][0];

        assert.match(String(identity), /^readonly-pk:/);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(page.oversizedCells)), {
            0: { 1: { storageClass: 'text', byteLength: 32 } }
        });
        assert.match(
            page.readOnlyRowReasons?.[0] ?? '',
            /WITHOUT ROWID primary-key column "key".*32 bytes.*identity was not transported/
        );
        await assert.rejects(
            worker.invoke('updateCell', 'demo_oversized_identity', identity, 'value', 'changed'),
            /WITHOUT ROWID primary-key column "key".*32 bytes.*identity was not transported/
        );
    });

    it('orders a declared demo rowid column as data across keyset pages', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_declared_rowid_order (' +
            'pk INTEGER PRIMARY KEY, rowid TEXT NOT NULL, value TEXT' +
            ') WITHOUT ROWID; ' +
            "INSERT INTO demo_declared_rowid_order VALUES " +
            "(1, 'zulu', 'one'), (2, 'alpha', 'two'), (3, 'alpha', 'three')"
        );
        const options = {
            columns: ['rowid', 'pk', 'rowid', 'value'],
            orderBy: 'rowid',
            orderDir: 'ASC',
            limit: 2,
            offset: 0
        };

        const offsetPage = await worker.invoke(
            'fetchTableData',
            'demo_declared_rowid_order',
            options
        );
        assert.deepStrictEqual(
            Array.from(offsetPage.rows, (row: unknown[]) => [row[1], row[2]]),
            [[2, 'alpha'], [3, 'alpha']]
        );
        const first = await worker.invoke('fetchTableData', 'demo_declared_rowid_order', {
            ...options,
            keyset: { mode: 'first' }
        });
        assert.deepStrictEqual(
            Array.from(first.rows, (row: unknown[]) => [row[1], row[2]]),
            [[2, 'alpha'], [3, 'alpha']]
        );
        assert.ok(first.keysetAnchors?.last);
        const second = await worker.invoke('fetchTableData', 'demo_declared_rowid_order', {
            ...options,
            offset: 2,
            keyset: { mode: 'after', anchor: first.keysetAnchors.last }
        });
        assert.deepStrictEqual(
            Array.from(second.rows, (row: unknown[]) => [row[1], row[2]]),
            [[1, 'zulu']]
        );
    });

    it('round-trips signed infinite REAL identities in the demo', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_infinite_real_identity (' +
            'key REAL PRIMARY KEY, value TEXT' +
            ') WITHOUT ROWID; ' +
            "INSERT INTO demo_infinite_real_identity VALUES " +
            "(-1e999, 'negative'), (1e999, 'positive')"
        );
        const options = {
            columns: ['rowid', 'key', 'value'],
            orderBy: 'key',
            orderDir: 'ASC',
            limit: 1,
            offset: 0
        };

        const first = await worker.invoke('fetchTableData', 'demo_infinite_real_identity', {
            ...options,
            keyset: { mode: 'first' }
        });
        assert.strictEqual(first.rows[0][1], Number.NEGATIVE_INFINITY);
        assert.ok(first.keysetAnchors?.last);
        const second = await worker.invoke('fetchTableData', 'demo_infinite_real_identity', {
            ...options,
            offset: 1,
            keyset: { mode: 'after', anchor: first.keysetAnchors.last }
        });
        assert.strictEqual(second.rows[0][1], Number.POSITIVE_INFINITY);
        await worker.invoke(
            'updateCell',
            'demo_infinite_real_identity',
            second.rows[0][0],
            'value',
            'edited'
        );
        assert.strictEqual(
            await workerScalar(
                worker,
                'SELECT value FROM demo_infinite_real_identity WHERE key = 1e999'
            ),
            'edited'
        );
        assert.deepStrictEqual(
            Array.from((await worker.invoke(
                'runQuery',
                'SELECT typeof(0.0/0.0), 0.0/0.0 IS NULL'
            ))[0].rows[0]),
            ['null', 1]
        );
        await assert.rejects(
            worker.invoke(
                'runQuery',
                "INSERT INTO demo_infinite_real_identity VALUES (0.0/0.0, 'nan')"
            ),
            /NOT NULL constraint failed/
        );
    });

    it('keeps malformed UTF-8 demo TEXT identities viewable but read-only', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_malformed_text_identity (' +
            'key TEXT PRIMARY KEY, value TEXT' +
            ') WITHOUT ROWID; ' +
            "INSERT INTO demo_malformed_text_identity VALUES " +
            "(CAST(X'80' AS TEXT), 'malformed'), " +
            "(CAST(X'EFBFBD' AS TEXT), 'replacement-character')"
        );
        const page = await worker.invoke('fetchTableData', 'demo_malformed_text_identity', {
            columns: ['rowid', 'key', 'value'],
            limit: 10,
            offset: 0,
            keyset: { mode: 'first' }
        });
        const rows = Array.from(page.rows, (row: unknown[]) => Array.from(row));
        const malformedIndex = rows.findIndex(row => row[2] === 'malformed');
        const validIndex = rows.findIndex(row => row[2] === 'replacement-character');
        assert.notStrictEqual(malformedIndex, -1);
        assert.notStrictEqual(validIndex, -1);
        const malformedIdentity = rows[malformedIndex][0];
        const validIdentity = rows[validIndex][0];

        assert.match(String(malformedIdentity), /^readonly-pk:/);
        assert.match(String(validIdentity), /^pk:/);
        assert.notStrictEqual(malformedIdentity, validIdentity);
        assert.match(page.readOnlyRowReasons?.[malformedIndex] ?? '', /not valid UTF-8/i);
        if (malformedIndex === 0) assert.strictEqual(page.keysetAnchors?.first, undefined);
        if (malformedIndex === rows.length - 1) {
            assert.strictEqual(page.keysetAnchors?.last, undefined);
        }

        await assert.rejects(
            worker.invoke(
                'updateCell',
                'demo_malformed_text_identity',
                malformedIdentity,
                'value',
                'bad-edit'
            ),
            /not valid UTF-8/i
        );
        await worker.invoke(
            'updateCell',
            'demo_malformed_text_identity',
            validIdentity,
            'value',
            'valid-edit'
        );
        const stored = await worker.invoke(
            'runQuery',
            'SELECT hex(CAST(key AS BLOB)), value FROM demo_malformed_text_identity ORDER BY 1'
        );
        assert.deepStrictEqual(
            Array.from(stored[0].rows, (row: unknown[]) => Array.from(row)),
            [['80', 'malformed'], ['EFBFBD', 'valid-edit']]
        );
    });

    it('suppresses demo keyset anchors for malformed ordinary TEXT sort keys', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_malformed_text_sort (' +
            'id INTEGER PRIMARY KEY, sort_value TEXT NOT NULL' +
            ') WITHOUT ROWID; ' +
            "INSERT INTO demo_malformed_text_sort VALUES " +
            "(1, CAST(X'80' AS TEXT)), " +
            "(2, CAST(X'C0' AS TEXT)), " +
            "(3, CAST(X'EFBFBD' AS TEXT))"
        );
        const first = await worker.invoke('fetchTableData', 'demo_malformed_text_sort', {
            columns: ['rowid', 'id', 'sort_value'],
            orderBy: 'sort_value',
            orderDir: 'ASC',
            limit: 1,
            offset: 0,
            keyset: { mode: 'first' }
        });
        assert.strictEqual(first.rows[0][1], 1);
        assert.strictEqual(first.keysetAnchors, undefined);
        const second = await worker.invoke('fetchTableData', 'demo_malformed_text_sort', {
            columns: ['rowid', 'id', 'sort_value'],
            orderBy: 'sort_value',
            orderDir: 'ASC',
            limit: 1,
            offset: 1
        });
        assert.strictEqual(second.rows[0][1], 2);
        assert.strictEqual(second.keysetAnchors, undefined);
    });

    it('rolls back a demo insert whose generated TEXT key is not byte-faithful', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_generated_malformed_identity (' +
            "key TEXT PRIMARY KEY DEFAULT (CAST(X'80' AS TEXT)), value TEXT" +
            ') WITHOUT ROWID; ' +
            "INSERT INTO demo_generated_malformed_identity(key, value) " +
            "VALUES (CAST(X'EFBFBD' AS TEXT), 'existing-valid')"
        );

        await assert.rejects(
            worker.invoke(
                'insertRow',
                'demo_generated_malformed_identity',
                { value: 'must-rollback' }
            ),
            /byte-faithful editable identity cannot be minted/i
        );
        const stored = await worker.invoke(
            'runQuery',
            'SELECT hex(CAST(key AS BLOB)), value FROM demo_generated_malformed_identity'
        );
        assert.deepStrictEqual(
            Array.from(stored[0].rows, (row: unknown[]) => Array.from(row)),
            [['EFBFBD', 'existing-valid']]
        );
    });

    it('excludes the hidden rowid from demo data and count global filters', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE TABLE rowid_filters (value TEXT); " +
            "INSERT INTO rowid_filters(rowid, value) VALUES (12, 'visible text')"
        );

        const data = await worker.invoke('fetchTableData', 'rowid_filters', {
            columns: ['rowid', 'value'],
            globalFilterColumns: ['value'],
            globalFilter: '12',
            limit: 100,
            offset: 0
        });
        const count = await worker.invoke('fetchTableCount', 'rowid_filters', {
            columns: ['value'],
            globalFilterColumns: ['value'],
            globalFilter: '12'
        });

        assert.deepStrictEqual(Array.from(data.rows), []);
        assert.deepStrictEqual({ ...count }, { count: 0, isExact: true });
    });

    it('pages the demo grid by keyset and re-anchors every page', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_keyset (value TEXT); ' +
            'WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 11) ' +
            "INSERT INTO demo_keyset(value) SELECT 'row-' || n FROM seq"
        );
        const options = (pageIndex: number, keyset?: object) => ({
            columns: ['rowid', 'value'],
            globalFilterColumns: ['value'],
            limit: 4,
            offset: pageIndex * 4,
            ...(keyset ? { keyset } : {})
        });
        const offsetPages = [];
        for (let index = 0; index < 3; index++) {
            offsetPages.push(await worker.invoke('fetchTableData', 'demo_keyset', options(index)));
        }
        assert.strictEqual(offsetPages[2].rows.length, 3, 'short remainder page expected');

        // Forward after-chain, reversed 'last', and 'before' must reproduce
        // the OFFSET pages exactly through the real bundled worker.
        let page = await worker.invoke('fetchTableData', 'demo_keyset', options(0, { mode: 'first' }));
        assert.deepStrictEqual(Array.from(page.rows), Array.from(offsetPages[0].rows));
        for (let index = 1; index < 3; index++) {
            assert.ok(page.keysetAnchors?.last, `missing anchor for page ${index - 1}`);
            page = await worker.invoke(
                'fetchTableData',
                'demo_keyset',
                options(index, { mode: 'after', anchor: page.keysetAnchors.last })
            );
            assert.deepStrictEqual(Array.from(page.rows), Array.from(offsetPages[index].rows));
        }
        const last = await worker.invoke(
            'fetchTableData',
            'demo_keyset',
            options(2, { mode: 'last', lastPageRowCount: 3 })
        );
        assert.deepStrictEqual(Array.from(last.rows), Array.from(offsetPages[2].rows));
        assert.ok(last.keysetAnchors?.first);
        const previous = await worker.invoke(
            'fetchTableData',
            'demo_keyset',
            options(1, { mode: 'before', anchor: last.keysetAnchors.first })
        );
        assert.deepStrictEqual(Array.from(previous.rows), Array.from(offsetPages[1].rows));

        // A stale anchor (minted under a sort) falls back to the OFFSET page.
        const sorted = await worker.invoke('fetchTableData', 'demo_keyset', {
            ...options(0, { mode: 'first' }),
            orderBy: 'value',
            orderDir: 'ASC'
        });
        assert.ok(sorted.keysetAnchors?.last);
        const fallback = await worker.invoke(
            'fetchTableData',
            'demo_keyset',
            options(1, { mode: 'after', anchor: sorted.keysetAnchors.last })
        );
        assert.deepStrictEqual(Array.from(fallback.rows), Array.from(offsetPages[1].rows));

        // A declared rowid column shadows real row identity: such tables never
        // anchor, and their keyset requests degrade to the OFFSET query.
        await worker.invoke(
            'runQuery',
            "CREATE TABLE demo_keyset_shadow (rowid TEXT); " +
            "INSERT INTO demo_keyset_shadow(rowid) VALUES ('a'), ('b')"
        );
        const shadow = await worker.invoke('fetchTableData', 'demo_keyset_shadow', {
            columns: ['rowid', 'rowid'],
            globalFilterColumns: ['rowid'],
            limit: 1,
            offset: 0,
            keyset: { mode: 'first' }
        });
        assert.strictEqual(shadow.rows.length, 1);
        assert.strictEqual(shadow.keysetAnchors, undefined);
    });

    it('seeks int64 anchors beyond 2^53 exactly on NONE-affinity sort columns', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_none_affinity (x, v TEXT); ' +
            'INSERT INTO demo_none_affinity(x, v) VALUES ' +
            "(9007199254740992, 'a'), (9007199254740993, 'b'), (9007199254740995, 'c'), " +
            "(2, 'small'), (9007199254740997, 'd'), (12, 'safe')"
        );
        const options = (pageIndex: number, keyset?: object) => ({
            columns: ['rowid', 'x', 'v'],
            globalFilterColumns: ['x', 'v'],
            orderBy: 'x',
            orderDir: 'ASC',
            limit: 2,
            offset: pageIndex * 2,
            ...(keyset ? { keyset } : {})
        });
        const offsetPages = [];
        for (let index = 0; index < 3; index++) {
            offsetPages.push(
                await worker.invoke('fetchTableData', 'demo_none_affinity', options(index))
            );
        }
        // 'after' across the 2^53 boundary used to return an empty page: the
        // anchor value decoded to a decimal string, and a TEXT bind never
        // compares equal-class with INTEGER storage on a NONE-affinity column.
        assert.ok(offsetPages[1].keysetAnchors?.last);
        const next = await worker.invoke(
            'fetchTableData',
            'demo_none_affinity',
            options(2, { mode: 'after', anchor: offsetPages[1].keysetAnchors.last })
        );
        assert.deepStrictEqual(Array.from(next.rows), Array.from(offsetPages[2].rows));
        // 'before' was worse: its predicate held for every INTEGER row, so it
        // returned a full-length WRONG page that passed the grid retry check.
        assert.ok(offsetPages[1].keysetAnchors?.first);
        const previous = await worker.invoke(
            'fetchTableData',
            'demo_none_affinity',
            options(0, { mode: 'before', anchor: offsetPages[1].keysetAnchors.first })
        );
        assert.deepStrictEqual(Array.from(previous.rows), Array.from(offsetPages[0].rows));
    });

    it('orders anchorable OFFSET pages by the full keyset key and leaves shadowed tables unchanged', async () => {
        const observed: string[] = [];
        const worker = await createWorkerHarness({
            onSql: (kind, sql) => { if (kind === 'prepare') observed.push(sql); }
        });
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_ties (s TEXT, v TEXT); ' +
            'WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 12) ' +
            "INSERT INTO demo_ties(s, v) SELECT 'dup-' || (n % 2), 'v' || n FROM seq"
        );
        const options = (pageIndex: number, keyset?: object) => ({
            columns: ['rowid', 's', 'v'],
            globalFilterColumns: ['s', 'v'],
            orderBy: 's',
            orderDir: 'DESC',
            limit: 4,
            offset: pageIndex * 4,
            ...(keyset ? { keyset } : {})
        });
        // Mixed session on duplicate DESC sort values: OFFSET pages, then a
        // keyset Next from the OFFSET page's anchor, must continue the same
        // total order (no skipped and no repeated rows).
        const offsetPages = [];
        for (let index = 0; index < 3; index++) {
            offsetPages.push(await worker.invoke('fetchTableData', 'demo_ties', options(index)));
        }
        assert.ok(offsetPages[1].keysetAnchors?.last);
        const next = await worker.invoke(
            'fetchTableData',
            'demo_ties',
            options(2, { mode: 'after', anchor: offsetPages[1].keysetAnchors.last })
        );
        assert.deepStrictEqual(Array.from(next.rows), Array.from(offsetPages[2].rows));
        // The fallback SELECT itself carries the full deterministic key order.
        assert.ok(
            observed.some(sql => sql.includes(
                'FROM "demo_ties" ORDER BY "s" DESC, "rowid" DESC LIMIT 4 OFFSET 4'
            )),
            `expected the deterministic fallback ORDER BY, saw:\n${observed.join('\n')}`
        );

        // A declared rowid column shadows real identity: no key derives, and
        // the emitted SQL stays byte-identical to the pre-keyset shape.
        await worker.invoke(
            'runQuery',
            "CREATE TABLE demo_shadow_order (rowid TEXT); " +
            "INSERT INTO demo_shadow_order(rowid) VALUES ('b'), ('a')"
        );
        observed.length = 0;
        const shadow = await worker.invoke('fetchTableData', 'demo_shadow_order', {
            columns: ['rowid', 'rowid'],
            globalFilterColumns: ['rowid'],
            limit: 10,
            offset: 0
        });
        assert.strictEqual(shadow.keysetAnchors, undefined);
        assert.ok(
            observed.some(sql =>
                sql === 'SELECT "rowid", "rowid" FROM "demo_shadow_order" LIMIT 10 OFFSET 0'
            ),
            `expected the unchanged shadowed-table SQL, saw:\n${observed.join('\n')}`
        );
    });

    it('keeps a declared rowid column in demo data and count global filters', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE TABLE declared_rowid_filters (rowid TEXT); " +
            "INSERT INTO declared_rowid_filters(rowid) VALUES ('needle'), ('other')"
        );
        const options = {
            // Match the table-grid request shape: the first entry is its identity
            // projection and globalFilterColumns is the displayed schema.
            columns: ['rowid', 'rowid'],
            globalFilterColumns: ['rowid'],
            globalFilter: 'needle'
        };

        const data = await worker.invoke('fetchTableData', 'declared_rowid_filters', {
            ...options,
            limit: 100,
            offset: 0
        });
        const count = await worker.invoke('fetchTableCount', 'declared_rowid_filters', {
            columns: ['rowid'],
            globalFilterColumns: ['rowid'],
            globalFilter: 'needle'
        });

        assert.deepStrictEqual(
            Array.from(data.rows, (row: unknown[]) => Array.from(row)),
            [['needle', 'needle']]
        );
        assert.deepStrictEqual({ ...count }, { count: 1, isExact: true });
    });

    it('returns exact unsafe INTEGER text alongside rounded demo grid values', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE unsafe_integers (value INTEGER); ' +
            'INSERT INTO unsafe_integers(value) VALUES (9007199254740993)'
        );

        const data = await worker.invoke('fetchTableData', 'unsafe_integers', {
            columns: ['value'],
            globalFilterColumns: ['value'],
            globalFilter: '993',
            limit: 100,
            offset: 0
        });

        assert.strictEqual(data.rows[0][0], 9007199254740992);
        assert.strictEqual(data.exactIntegerTexts[0][0], '9007199254740993');
    });

    it('keeps adjacent unsafe demo table rowids distinct and editable', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE unsafe_demo_rowids (value TEXT); ' +
            "INSERT INTO unsafe_demo_rowids(rowid, value) VALUES " +
            "(7, 'safe'), (9007199254740992, 'lower'), (9007199254740993, 'higher')"
        );

        const data = await worker.invoke('fetchTableData', 'unsafe_demo_rowids', {
            columns: ['rowid', 'value'],
            orderBy: 'rowid',
            limit: 10,
            offset: 0
        });
        assert.strictEqual(data.rows[0][0], 7);
        assert.deepStrictEqual(
            data.rows.slice(1).map((row: unknown[]) => row[0]),
            ['9007199254740992', '9007199254740993']
        );

        await worker.invoke(
            'updateCell',
            'unsafe_demo_rowids',
            data.rows[2][0],
            'value',
            'edited'
        );
        const values = await worker.invoke('fetchTableData', 'unsafe_demo_rowids', {
            columns: ['rowid', 'value'],
            orderBy: 'rowid',
            limit: 10,
            offset: 0
        });
        assert.deepStrictEqual(
            values.rows.slice(1).map((row: unknown[]) => Array.from(row)),
            [
                ['9007199254740992', 'lower'],
                ['9007199254740993', 'edited']
            ]
        );
    });

    it('treats a declared demo rowid column with duplicate unsafe values as data', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_declared_rowid_dupes ("rowid" INTEGER, value TEXT); ' +
            'INSERT INTO demo_declared_rowid_dupes("rowid", value) VALUES ' +
            "(9007199254740993, 'first'), (9007199254740993, 'second')"
        );

        const data = await worker.invoke('fetchTableData', 'demo_declared_rowid_dupes', {
            columns: ['rowid', 'value'],
            limit: 10,
            offset: 0
        });

        // The declared column shadows the intrinsic rowid, so it must never be
        // promoted to an exact row identity; both rows keep the rounded number
        // plus sidecar text.
        assert.deepStrictEqual(
            data.rows.map((row: unknown[]) => row[0]),
            [9007199254740992, 9007199254740992]
        );
        assert.strictEqual(data.exactIntegerTexts[0][0], '9007199254740993');
        assert.strictEqual(data.exactIntegerTexts[1][0], '9007199254740993');
    });

    it('fails clearly when a demo UPDATE trigger rewrites the primary key', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_trigger_rekey_identity (' +
            'tenant TEXT, sequence INTEGER, value TEXT, PRIMARY KEY (tenant, sequence)' +
            ') WITHOUT ROWID; ' +
            "INSERT INTO demo_trigger_rekey_identity VALUES ('north', 1, 'before'); " +
            'CREATE TRIGGER demo_trigger_rekey_identity_after ' +
            'AFTER UPDATE OF value ON demo_trigger_rekey_identity BEGIN ' +
            'UPDATE demo_trigger_rekey_identity SET sequence = sequence + 1 ' +
            'WHERE tenant = NEW.tenant AND sequence = NEW.sequence; END'
        );
        const page = await worker.invoke('fetchTableData', 'demo_trigger_rekey_identity', {
            columns: ['rowid', 'tenant', 'sequence', 'value'],
            limit: 1,
            offset: 0
        });

        await assert.rejects(
            worker.invoke(
                'updateCell',
                'demo_trigger_rekey_identity',
                page.rows[0][0],
                'value',
                'after'
            ),
            /UPDATE trigger changed or removed.*primary-key identity.*rolled back.*cannot safely identify/is
        );
        await assert.rejects(
            worker.invoke(
                'replaceOversizedCell',
                'demo_trigger_rekey_identity',
                page.rows[0][0],
                'value',
                'after',
                { storageClass: 'text', byteLength: 6 },
                5
            ),
            /UPDATE trigger changed or removed.*primary-key identity.*rolled back.*cannot safely identify/is
        );
        assert.deepStrictEqual(
            Array.from(
                (await worker.invoke(
                    'runQuery',
                    'SELECT tenant, sequence, value FROM demo_trigger_rekey_identity'
                ))[0].rows[0]
            ),
            ['north', 1, 'before']
        );
    });

    it('edits and deletes rows through WITHOUT ROWID primary-key identities', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_without_rowid (' +
            'tenant TEXT, sequence INTEGER, value TEXT, ' +
            'PRIMARY KEY (tenant, sequence)' +
            ') WITHOUT ROWID; ' +
            "INSERT INTO demo_without_rowid VALUES " +
            "('north', 9007199254740993, 'before')"
        );
        const page = await worker.invoke('fetchTableData', 'demo_without_rowid', {
            columns: ['rowid', 'tenant', 'sequence', 'value'],
            limit: 10,
            offset: 0
        });
        const oldIdentity = page.rows[0][0];
        assert.match(oldIdentity, /^pk:/);
        assert.strictEqual(page.exactIntegerTexts[0][2], '9007199254740993');

        const outcomes = await worker.invoke('updateCellBatch', 'demo_without_rowid', [
            { rowId: oldIdentity, column: 'tenant', value: 'south' },
            { rowId: oldIdentity, column: 'value', value: 'after' }
        ]);
        const newIdentity = outcomes[0].newRowId;
        assert.ok(newIdentity);
        assert.deepStrictEqual(
            (await worker.invoke(
                'runQuery',
                'SELECT tenant, CAST(sequence AS TEXT), value FROM demo_without_rowid'
            ))[0].rows,
            [['south', '9007199254740993', 'after']]
        );

        const updateModification = {
            modificationType: 'cell_update',
            targetTable: 'demo_without_rowid',
            affectedCells: outcomes
        };
        await worker.invoke('undoModification', updateModification);
        assert.deepStrictEqual(
            (await worker.invoke(
                'runQuery',
                'SELECT tenant, CAST(sequence AS TEXT), value FROM demo_without_rowid'
            ))[0].rows,
            [['north', '9007199254740993', 'before']]
        );
        await worker.invoke('redoModification', updateModification);
        assert.deepStrictEqual(
            (await worker.invoke(
                'runQuery',
                'SELECT tenant, CAST(sequence AS TEXT), value FROM demo_without_rowid'
            ))[0].rows,
            [['south', '9007199254740993', 'after']]
        );

        const deletedRows = await worker.invoke('deleteRows', 'demo_without_rowid', [newIdentity]);
        assert.strictEqual(
            await workerScalar(worker, 'SELECT count(*) FROM demo_without_rowid'),
            0
        );
        const deleteModification = {
            modificationType: 'row_delete',
            targetTable: 'demo_without_rowid',
            affectedRowIds: [newIdentity],
            deletedRows
        };
        await worker.invoke('undoModification', deleteModification);
        assert.strictEqual(
            await workerScalar(worker, 'SELECT count(*) FROM demo_without_rowid'),
            1
        );
        await worker.invoke('redoModification', deleteModification);
        assert.strictEqual(
            await workerScalar(worker, 'SELECT count(*) FROM demo_without_rowid'),
            0
        );
    });

    it('undoes dependent demo composite-key changes in reverse transition order', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_dependent_identity (' +
            'tenant INTEGER, sequence INTEGER, value TEXT, ' +
            'PRIMARY KEY (tenant, sequence)' +
            ') WITHOUT ROWID; ' +
            "INSERT INTO demo_dependent_identity VALUES (1, 1, 'first'), (1, 2, 'second')"
        );
        const page = await worker.invoke('fetchTableData', 'demo_dependent_identity', {
            columns: ['rowid', 'tenant', 'sequence', 'value'],
            orderBy: 'sequence',
            limit: 10,
            offset: 0
        });
        const affectedCells = await worker.invoke('updateCellBatch', 'demo_dependent_identity', [
            { rowId: page.rows[0][0], column: 'tenant', value: 2 },
            { rowId: page.rows[1][0], column: 'sequence', value: 1 }
        ]);

        await worker.invoke('undoModification', {
            modificationType: 'cell_update',
            targetTable: 'demo_dependent_identity',
            affectedCells
        });

        assert.deepStrictEqual(
            (await worker.invoke(
                'runQuery',
                'SELECT tenant, sequence, value FROM demo_dependent_identity ORDER BY sequence'
            ))[0].rows,
            [[1, 1, 'first'], [1, 2, 'second']]
        );
    });

    it('restores a deleted demo WITHOUT ROWID row without inserting generated columns', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_generated_pk_row (' +
            'id INTEGER PRIMARY KEY, base INTEGER, ' +
            'stored_value INTEGER GENERATED ALWAYS AS (base * 2) STORED, ' +
            'virtual_value INTEGER GENERATED ALWAYS AS (base * 3) VIRTUAL' +
            ') WITHOUT ROWID; ' +
            'INSERT INTO demo_generated_pk_row (id, base) VALUES (7, 5)'
        );
        const page = await worker.invoke('fetchTableData', 'demo_generated_pk_row', {
            columns: ['rowid', 'id', 'base', 'stored_value', 'virtual_value'],
            limit: 10,
            offset: 0
        });
        const deletedRows = await worker.invoke(
            'deleteRows',
            'demo_generated_pk_row',
            [page.rows[0][0]]
        );

        await worker.invoke('undoModification', {
            modificationType: 'row_delete',
            targetTable: 'demo_generated_pk_row',
            deletedRows
        });

        assert.deepStrictEqual(
            (await worker.invoke(
                'runQuery',
                'SELECT id, base, stored_value, virtual_value FROM demo_generated_pk_row'
            ))[0].rows,
            [[7, 5, 10, 15]]
        );
    });

    it('restores a deleted demo rowid row without inserting generated columns', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_generated_rowid_row (' +
            'base INTEGER, ' +
            'stored_value INTEGER GENERATED ALWAYS AS (base * 2) STORED, ' +
            'virtual_value INTEGER GENERATED ALWAYS AS (base * 3) VIRTUAL' +
            '); ' +
            'INSERT INTO demo_generated_rowid_row (rowid, base) VALUES (9, 5)'
        );
        const deletedRows = await worker.invoke(
            'deleteRows',
            'demo_generated_rowid_row',
            [9]
        );
        assert.ok(deletedRows);

        await worker.invoke('undoModification', {
            modificationType: 'row_delete',
            targetTable: 'demo_generated_rowid_row',
            deletedRows
        });

        assert.deepStrictEqual(
            (await worker.invoke(
                'runQuery',
                'SELECT rowid, base, stored_value, virtual_value FROM demo_generated_rowid_row'
            ))[0].rows,
            [[9, 5, 10, 15]]
        );
    });

    it('preserves an unsafe demo INTEGER prior storage class when undoing a typeless cell', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_typeless_undo (' +
            'id INTEGER PRIMARY KEY, value' +
            ') WITHOUT ROWID; ' +
            'INSERT INTO demo_typeless_undo VALUES (1, 9007199254740993)'
        );
        const page = await worker.invoke('fetchTableData', 'demo_typeless_undo', {
            columns: ['rowid', 'id', 'value'],
            limit: 10,
            offset: 0
        });
        const affectedCells = await worker.invoke('updateCellBatch', 'demo_typeless_undo', [{
            rowId: page.rows[0][0],
            column: 'value',
            value: 'changed'
        }]);
        assert.strictEqual(typeof affectedCells[0].priorValue, 'bigint');

        await worker.invoke('undoModification', {
            modificationType: 'cell_update',
            targetTable: 'demo_typeless_undo',
            affectedCells
        });

        assert.deepStrictEqual(
            (await worker.invoke(
                'runQuery',
                'SELECT typeof(value), CAST(value AS TEXT) FROM demo_typeless_undo'
            ))[0].rows,
            [['integer', '9007199254740993']]
        );
    });

    it('preserves an unsafe demo INTEGER storage class when restoring a deleted typeless row', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_typeless_restore (value); ' +
            'INSERT INTO demo_typeless_restore (rowid, value) VALUES (11, 9007199254740993)'
        );
        const deletedRows = await worker.invoke('deleteRows', 'demo_typeless_restore', [11]);
        assert.strictEqual(typeof deletedRows[0].row.value, 'bigint');

        await worker.invoke('undoModification', {
            modificationType: 'row_delete',
            targetTable: 'demo_typeless_restore',
            deletedRows
        });

        assert.deepStrictEqual(
            (await worker.invoke(
                'runQuery',
                'SELECT rowid, typeof(value), CAST(value AS TEXT) FROM demo_typeless_restore'
            ))[0].rows,
            [[11, 'integer', '9007199254740993']]
        );
    });

    it('loads and edits rowid-addressable demo FTS virtual and shadow tables', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE VIRTUAL TABLE demo_fts4_identity USING fts4(body); " +
            "INSERT INTO demo_fts4_identity(body) VALUES ('before')"
        );

        const schema = await worker.invoke('fetchSchema');
        assert.strictEqual(
            schema.tables.find((table: any) => table.identifier === 'demo_fts4_identity')?.identity?.kind,
            'rowid'
        );
        const shadows = schema.tables.filter((table: any) => (
            table.identifier.startsWith('demo_fts4_identity_')
        ));
        assert.ok(shadows.length > 0);
        assert.ok(shadows.every((table: any) => table.identity?.kind === 'rowid'));

        const page = await worker.invoke('fetchTableData', 'demo_fts4_identity', {
            columns: ['rowid', 'body'],
            limit: 10,
            offset: 0
        });
        await worker.invoke(
            'updateCell',
            'demo_fts4_identity',
            page.rows[0][0],
            'body',
            'after'
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT body FROM demo_fts4_identity'),
            'after'
        );

        const shadowPage = await worker.invoke(
            'fetchTableData',
            'demo_fts4_identity_content',
            { columns: ['rowid', 'c0body'], limit: 10, offset: 0 }
        );
        await worker.invoke(
            'updateCell',
            'demo_fts4_identity_content',
            shadowPage.rows[0][0],
            'c0body',
            'shadow-after'
        );
        assert.strictEqual(
            await workerScalar(
                worker,
                'SELECT c0body FROM demo_fts4_identity_content'
            ),
            'shadow-after'
        );
    });

    it('loads and edits demo FTS5 when the bundled SQLite provides FTS5', async t => {
        const worker = await createWorkerHarness();
        try {
            await worker.invoke(
                'runQuery',
                "CREATE VIRTUAL TABLE demo_fts5_identity USING fts5(body); " +
                "INSERT INTO demo_fts5_identity(body) VALUES ('before')"
            );
        } catch (error) {
            if (/no such module: fts5/i.test(String(error))) {
                t.skip('bundled sql.js does not include FTS5');
                return;
            }
            throw error;
        }

        const schema = await worker.invoke('fetchSchema');
        assert.strictEqual(
            schema.tables.find((table: any) => table.identifier === 'demo_fts5_identity')?.identity?.kind,
            'rowid'
        );
        const page = await worker.invoke('fetchTableData', 'demo_fts5_identity', {
            columns: ['rowid', 'body'],
            limit: 10,
            offset: 0
        });
        await worker.invoke(
            'updateCell',
            'demo_fts5_identity',
            page.rows[0][0],
            'body',
            'after'
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT body FROM demo_fts5_identity'),
            'after'
        );
    });

    it('loads all demo table identities with one bulk metadata query', async () => {
        const observedSql: string[] = [];
        const worker = await createWorkerHarness({
            onSql: (kind, sql) => {
                if (kind === 'exec') observedSql.push(sql);
            }
        });
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_schema_rowid (value TEXT); ' +
            'CREATE TABLE demo_schema_pk_a (id TEXT PRIMARY KEY) WITHOUT ROWID; ' +
            'CREATE TABLE demo_schema_pk_b (' +
            'tenant TEXT, sequence INTEGER, PRIMARY KEY (tenant, sequence)' +
            ') WITHOUT ROWID'
        );
        observedSql.length = 0;

        const schema = await worker.invoke('fetchSchema');

        assert.strictEqual(schema.tables.length, 3);
        assert.strictEqual(
            observedSql.filter(sql => sql.includes('pragma_table_list')).length,
            1
        );
        assert.strictEqual(
            observedSql.filter(sql => /PRAGMA\s+(?:main\.)?table_info/i.test(sql)).length,
            0,
            'schema identity must use one set-based metadata query'
        );
    });

    it('enumerates and loads demo tables that shadow PRAGMA virtual-table names', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_pragma_shadow_target (id INTEGER PRIMARY KEY, value TEXT); ' +
            "INSERT INTO demo_pragma_shadow_target VALUES (1, 'before'); " +
            'CREATE TABLE pragma_table_info (dummy TEXT)'
        );

        const infoShadowSchema = await worker.invoke('fetchSchema');
        assert.ok(
            infoShadowSchema.tables.some(
                (table: any) => table.identifier === 'demo_pragma_shadow_target'
            )
        );

        await worker.invoke(
            'runQuery',
            'CREATE TABLE pragma_table_list (dummy TEXT); ' +
            'CREATE TABLE pragma_table_xinfo (dummy TEXT)'
        );
        const fullyShadowedSchema = await worker.invoke('fetchSchema');
        const identifiers = new Set(
            fullyShadowedSchema.tables.map((table: any) => table.identifier)
        );
        for (const table of [
            'demo_pragma_shadow_target',
            'pragma_table_info',
            'pragma_table_list',
            'pragma_table_xinfo'
        ]) {
            assert.ok(identifiers.has(table), `schema omitted ${table}`);
        }

        const page = await worker.invoke('fetchTableData', 'demo_pragma_shadow_target', {
            columns: ['rowid', 'id', 'value'],
            limit: 10,
            offset: 0
        });
        assert.deepStrictEqual(Array.from(page.rows[0]), [1, 1, 'before']);

        await worker.invoke('insertRow', 'demo_pragma_shadow_target', { value: 'after' });
        const rows = await worker.invoke(
            'runQuery',
            'SELECT id, value FROM demo_pragma_shadow_target ORDER BY id'
        );
        assert.deepStrictEqual(
            Array.from(rows[0].rows, (row: any) => Array.from(row)),
            [[1, 'before'], [2, 'after']]
        );
    });

    it('returns exact unsafe INTEGER text from demo view previews', async () => {
        const worker = await createWorkerHarness();

        const preview = await worker.invoke(
            'previewViewDefinition',
            'unsafe_integer_preview',
            'SELECT 9007199254740993 AS value',
            10,
            'create'
        );

        assert.strictEqual(preview.rows[0][0], 9007199254740992);
        assert.strictEqual(preview.exactIntegerTexts[0][0], '9007199254740993');
    });

    it('returns integral REAL storage text from demo table fetches and previews', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_integral_reals (value); ' +
            'INSERT INTO demo_integral_reals(value) VALUES (CAST(1 AS REAL))'
        );

        const data = await worker.invoke('fetchTableData', 'demo_integral_reals', {
            columns: ['value'],
            globalFilterColumns: ['value'],
            globalFilter: '.',
            limit: 100,
            offset: 0
        });
        assert.strictEqual(data.rows[0][0], 1);
        assert.strictEqual(data.exactIntegerTexts[0][0], '1.0');

        const preview = await worker.invoke(
            'previewViewDefinition',
            'demo_integral_real_preview',
            'SELECT CAST(1 AS REAL) AS value',
            10,
            'create'
        );
        assert.strictEqual(preview.rows[0][0], 1);
        assert.strictEqual(preview.exactIntegerTexts[0][0], '1.0');
    });

    it('returns authoritative SQLite text for divergent non-integral demo REALs', async () => {
        const worker = await createWorkerHarness();
        assert.strictEqual(
            await workerScalar(worker, 'SELECT sqlite_version()'),
            BUNDLED_SQLJS_SQLITE_VERSION,
            'the REAL text expectation below is pinned to the bundled SQLite version'
        );
        const expectedText = DIVERGENT_REAL_TEXT_BY_SQLJS_SQLITE_VERSION[
            BUNDLED_SQLJS_SQLITE_VERSION
        ];
        assert.ok(expectedText, 'record the REAL rendering when bundled sql.js SQLite changes');
        const preview = await worker.invoke(
            'previewViewDefinition',
            'demo_divergent_real_preview',
            'SELECT 9.652937795298495e282 AS value',
            10,
            'create'
        );

        assert.strictEqual(preview.rows[0][0], 9.652937795298495e282);
        assert.strictEqual(
            preview.exactIntegerTexts[0][0],
            expectedText
        );
    });

    it('degrades exact REAL companions without failing a 1001-column demo preview', async () => {
        const worker = await createWorkerHarness();
        const expressions = Array.from({ length: 1001 }, (_, index) => {
            if (index === 0) return '9007199254740993 AS c0';
            if (index === 1) return 'CAST(1 AS REAL) AS c1';
            return `0 AS c${index}`;
        });
        const preview = await worker.invoke(
            'previewViewDefinition',
            'demo_wide_numeric_preview',
            `SELECT ${expressions.join(', ')}`,
            1,
            'create'
        );

        assert.strictEqual(preview.headers.length, 1001);
        assert.strictEqual(preview.rows[0].length, 1001);
        assert.strictEqual(preview.rows[0][0], 9007199254740992);
        assert.strictEqual(preview.exactIntegerTexts[0][0], '9007199254740993');
        assert.strictEqual(preview.exactIntegerTexts[0][1], undefined);
    });

    it('loads rowid and WITHOUT ROWID demo tables at both maximum-width boundaries', async () => {
        const worker = await createWorkerHarness();
        for (const declaredColumnCount of [1999, 2000]) {
            for (const withoutRowId of [false, true]) {
                const columns = Array.from(
                    { length: declaredColumnCount },
                    (_, index) => `c${index}`
                );
                const table = `demo_containment_width_${declaredColumnCount}_${withoutRowId ? 'pk' : 'rowid'}`;
                const definitions = columns.map((column, index) => (
                    withoutRowId && index === 0
                        ? `"${column}" INTEGER PRIMARY KEY`
                        : `"${column}" TEXT`
                ));
                await worker.invoke(
                    'runQuery',
                    `CREATE TABLE "${table}" (${definitions.join(', ')})` +
                    `${withoutRowId ? ' WITHOUT ROWID' : ''}; ` +
                    `INSERT INTO "${table}" ("c0", "c${declaredColumnCount - 1}") ` +
                    `VALUES (1, 'last')`
                );

                const page = await worker.invoke('fetchTableData', table, {
                    columns: ['rowid', ...columns],
                    globalFilterColumns: columns,
                    limit: 1,
                    offset: 0
                });

                assert.strictEqual(page.headers.length, declaredColumnCount + 1);
                assert.strictEqual(page.rows[0].length, declaredColumnCount + 1);
                assert.strictEqual(page.rows[0][1], withoutRowId ? 1 : '1');
                assert.strictEqual(page.rows[0][declaredColumnCount], 'last');
                assert.match(
                    String(page.rows[0][0]),
                    withoutRowId ? /^(?:pk|readonly-pk):/ : /^1$/
                );
            }
        }
    });

    it('restores divergent REAL text for a 1001-column rowid-keyed demo table', async () => {
        const worker = await createWorkerHarness();
        const columnNames = Array.from({ length: 1000 }, (_, index) => `c${index}`);
        await worker.invoke(
            'runQuery',
            `CREATE TABLE demo_wide_real_rows (${columnNames.map(name => `"${name}"`).join(', ')}); ` +
            'INSERT INTO demo_wide_real_rows(c0) VALUES (9.652937795298495e282)'
        );

        const result = await worker.invoke('fetchTableData', 'demo_wide_real_rows', {
            columns: ['rowid', ...columnNames],
            globalFilterColumns: columnNames,
            limit: 1,
            offset: 0
        });
        assert.strictEqual(result.rows[0].length, 1001);
        assert.strictEqual(typeof result.exactIntegerTexts?.[0]?.[1], 'string');
        assert.notStrictEqual(
            result.exactIntegerTexts[0][1],
            String(result.rows[0][1])
        );
    });

    it('does not issue rowid companions for a wide demo view named rowid', async () => {
        const observedSql: string[] = [];
        const worker = await createWorkerHarness({
            onSql(_kind, sql) { observedSql.push(sql); }
        });
        const dataColumnNames = Array.from({ length: 1000 }, (_, index) => `c${index}`);
        const viewExpressions = [
            '1 AS rowid',
            '9.652937795298495e282 AS c0',
            ...dataColumnNames.slice(1).map(name => `0 AS "${name}"`)
        ];
        await worker.invoke(
            'runQuery',
            `CREATE VIEW demo_wide_named_rowid AS SELECT ${viewExpressions.join(', ')}`
        );
        observedSql.length = 0;

        const result = await worker.invoke('fetchTableData', 'demo_wide_named_rowid', {
            columns: ['rowid', ...dataColumnNames],
            globalFilterColumns: dataColumnNames,
            limit: 1,
            offset: 0
        });
        assert.strictEqual(result.rows[0].length, 1001);
        assert.strictEqual(result.exactIntegerTexts?.[0]?.[1], undefined);
        assert.strictEqual(
            observedSql.filter(sql => sql.includes('__sqlite_explorer_numeric_rowid')).length,
            0
        );
    });

    it('loads a wide demo view with a null first column without rowid companions', async () => {
        const observedSql: string[] = [];
        const worker = await createWorkerHarness({
            onSql(_kind, sql) { observedSql.push(sql); }
        });
        const dataColumnNames = Array.from({ length: 1000 }, (_, index) => `c${index}`);
        const viewExpressions = [
            'NULL AS first_value',
            ...dataColumnNames.map(name => `0 AS "${name}"`)
        ];
        await worker.invoke(
            'runQuery',
            `CREATE VIEW demo_wide_null_first AS SELECT ${viewExpressions.join(', ')}`
        );
        observedSql.length = 0;

        const result = await worker.invoke('fetchTableData', 'demo_wide_null_first', {
            columns: ['first_value', ...dataColumnNames],
            globalFilterColumns: dataColumnNames,
            limit: 1,
            offset: 0
        });
        assert.strictEqual(result.rows[0].length, 1001);
        assert.strictEqual(result.rows[0][0], null);
        assert.strictEqual(result.exactIntegerTexts, undefined);
        assert.strictEqual(
            observedSql.filter(sql => sql.includes('__sqlite_explorer_numeric_rowid')).length,
            0
        );
    });

    it('does not issue rowid companions for a wide demo WITHOUT ROWID table', async () => {
        const observedSql: string[] = [];
        const worker = await createWorkerHarness({
            onSql(_kind, sql) { observedSql.push(sql); }
        });
        const dataColumnNames = Array.from({ length: 1000 }, (_, index) => `c${index}`);
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_wide_without_rowid (' +
            '"rowid" INTEGER PRIMARY KEY, ' +
            dataColumnNames.map(name => `"${name}"`).join(', ') +
            ') WITHOUT ROWID; ' +
            'INSERT INTO demo_wide_without_rowid(rowid, c0) VALUES ' +
            '(1, 9.652937795298495e282)'
        );
        observedSql.length = 0;

        const result = await worker.invoke('fetchTableData', 'demo_wide_without_rowid', {
            columns: ['rowid', ...dataColumnNames],
            globalFilterColumns: dataColumnNames,
            limit: 1,
            offset: 0
        });
        assert.strictEqual(result.rows[0].length, 1001);
        assert.strictEqual(result.exactIntegerTexts?.[0]?.[1], undefined);
        assert.strictEqual(
            observedSql.filter(sql => sql.includes('__sqlite_explorer_numeric_rowid')).length,
            0
        );
    });

    it('derives demo numeric sidecars from one evaluation of random expressions', async () => {
        const worker = await createWorkerHarness();
        const preview = await worker.invoke(
            'previewViewDefinition',
            'demo_random_numeric_preview',
            'WITH RECURSIVE sequence(n) AS (' +
            'SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 24' +
            ') SELECT CAST(random() % 1000000 AS REAL) AS value FROM sequence',
            24,
            'create'
        );

        assert.strictEqual(preview.rows.length, 24);
        for (let rowIndex = 0; rowIndex < preview.rows.length; rowIndex++) {
            const exactText = preview.exactIntegerTexts?.[rowIndex]?.[0];
            assert.strictEqual(typeof exactText, 'string', `missing sidecar for row ${rowIndex}`);
            assert.strictEqual(Number(exactText), preview.rows[rowIndex][0]);
        }
    });

    it('uses the same narrowed global-filter columns for demo data and counts', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE TABLE scoped_filters (visible TEXT, hidden TEXT); " +
            "INSERT INTO scoped_filters VALUES ('shown', 'secret')"
        );
        const options = {
            columns: ['visible', 'hidden'],
            globalFilterColumns: ['visible'],
            globalFilter: 'secret'
        };

        const data = await worker.invoke('fetchTableData', 'scoped_filters', {
            ...options,
            limit: 100,
            offset: 0
        });
        const count = await worker.invoke('fetchTableCount', 'scoped_filters', options);

        assert.deepStrictEqual(Array.from(data.rows), []);
        assert.deepStrictEqual({ ...count }, { count: 0, isExact: true });
    });

    it('falls back to selected columns when count globalFilterColumns is null', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE TABLE null_scoped_filters (visible TEXT, hidden TEXT); " +
            "INSERT INTO null_scoped_filters VALUES ('shown', 'secret')"
        );

        const count = await worker.invoke('fetchTableCount', 'null_scoped_filters', {
            columns: ['visible'],
            globalFilterColumns: null,
            globalFilter: 'secret'
        });

        assert.deepStrictEqual({ ...count }, { count: 0, isExact: true });
    });

    it('treats whitespace-only filters as inactive but preserves padded terms', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE TABLE whitespace_filters (value TEXT); " +
            "INSERT INTO whitespace_filters VALUES ('needle'), (' needle '), ('other')"
        );

        for (const options of [
            { columns: ['value'], globalFilter: '   ' },
            { columns: ['value'], filters: [{ column: 'value', value: '   ' }] }
        ]) {
            const data = await worker.invoke('fetchTableData', 'whitespace_filters', {
                ...options,
                limit: 100,
                offset: 0
            });
            const count = await worker.invoke('fetchTableCount', 'whitespace_filters', options);
            assert.strictEqual(data.rows.length, 3);
            assert.deepStrictEqual({ ...count }, { count: 3, isExact: true });
        }

        const padded = await worker.invoke('fetchTableData', 'whitespace_filters', {
            columns: ['value'],
            globalFilter: ' needle ',
            limit: 100,
            offset: 0
        });
        const paddedCount = await worker.invoke('fetchTableCount', 'whitespace_filters', {
            columns: ['value'],
            globalFilter: ' needle '
        });
        assert.deepStrictEqual(
            Array.from(padded.rows, (row: unknown[]) => Array.from(row)),
            [[' needle ']]
        );
        assert.deepStrictEqual({ ...paddedCount }, { count: 1, isExact: true });
    });

    it('validates the CREATE VIEW construct and leaves the schema unchanged', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE VIEW validation_target (a, b) AS SELECT 1, 2');
        const originalSql = await workerScalar(
            worker,
            "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = 'validation_target'"
        );

        await assert.rejects(
            worker.invoke(
                'validateViewDefinition',
                'parameter_view',
                'SELECT ? AS value',
                'create'
            ),
            /parameters are not allowed in views/
        );
        await assert.rejects(
            worker.invoke('validateViewDefinition', 'validation_target', 'SELECT 1'),
            /expected 2 columns/
        );

        assert.strictEqual(await workerScalar(
            worker,
            "SELECT count(*) FROM sqlite_schema WHERE type = 'view' AND name = 'parameter_view'"
        ), 0);
        assert.strictEqual(await workerScalar(
            worker,
            "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = 'validation_target'"
        ), originalSql);
    });

    it('enforces create and edit intent against the installed schema', async () => {
        const worker = await createWorkerHarness();

        await assert.rejects(
            worker.invoke(
                'validateViewDefinition',
                'missing_intent_target',
                'SELECT 2 AS value',
                'edit'
            ),
            /view no longer exists/i
        );
        await assert.rejects(
            worker.invoke(
                'previewViewDefinition',
                'missing_intent_target',
                'SELECT 2 AS value',
                10,
                'edit'
            ),
            /view no longer exists/i
        );

        await worker.invoke('createView', 'intent_target', 'SELECT 1 AS value');

        await assert.rejects(
            worker.invoke(
                'validateViewDefinition',
                'intent_target',
                'SELECT 2 AS value',
                'create'
            ),
            /view already exists/i
        );
        await assert.rejects(
            worker.invoke(
                'previewViewDefinition',
                'intent_target',
                'SELECT 2 AS value',
                10,
                'create'
            ),
            /view already exists/i
        );

        await worker.invoke(
            'validateViewDefinition',
            'intent_target',
            'SELECT 2 AS value',
            'edit'
        );
        const preview = await worker.invoke(
            'previewViewDefinition',
            'intent_target',
            'SELECT 2 AS value',
            10,
            'edit'
        );
        assert.deepStrictEqual(Array.from(preview.headers), ['value']);
        assert.deepStrictEqual(
            Array.from(preview.rows, (row: unknown[]) => Array.from(row)),
            [[2]]
        );
        assert.strictEqual(await workerScalar(worker, 'SELECT value FROM intent_target'), 1);
    });

    it('does not run validation DDL in demo read-only mode', async () => {
        const worker = await createWorkerHarness({ readOnlyMode: true });

        await assert.rejects(
            worker.invoke(
                'validateViewDefinition',
                'read_only_view',
                'SELECT 1 AS value',
                'create'
            ),
            /View validation is unavailable because the database is read-only/
        );
        const preview = await worker.invoke(
            'previewViewDefinition',
            'read_only_view',
            'SELECT 1 AS value',
            10,
            'create'
        );
        assert.deepStrictEqual(Array.from(preview.headers), ['value']);
        assert.deepStrictEqual(
            Array.from(preview.rows, (row: unknown[]) => Array.from(row)),
            [[1]]
        );
        const schema = await worker.invoke('fetchSchema');
        assert.strictEqual(
            schema.views.some((view: { identifier: string }) => view.identifier === 'read_only_view'),
            false
        );
    });

    it('rejects every demo mutation when initialized read-only', async () => {
        const writable = await createWorkerHarness();
        await writable.invoke(
            'runQuery',
            "CREATE TABLE read_only_rows (value TEXT, spare TEXT); " +
            "INSERT INTO read_only_rows VALUES ('original', 'keep')"
        );
        await writable.invoke('createView', 'read_only_existing', 'SELECT 1 AS value');
        const content = await writable.invoke('exportDatabase', 'test.db');
        const worker = await createWorkerHarness({
            content: Uint8Array.from(content),
            readOnlyMode: true
        });

        const mutations: Array<[string, ...unknown[]]> = [
            ['runQuery', "UPDATE read_only_rows SET value = 'raw-sql'"],
            ['setPragma', 'foreign_keys', 1],
            ['updateCell', 'read_only_rows', 1, 'value', 'changed'],
            ['insertRow', 'read_only_rows', { value: 'inserted' }],
            ['deleteRows', 'read_only_rows', [1]],
            ['deleteColumns', 'read_only_rows', ['spare']],
            ['createTable', 'read_only_new_table', [{ name: 'id', type: 'INTEGER' }]],
            ['updateCellBatch', 'read_only_rows', [{ rowId: 1, column: 'value', value: 'batch' }]],
            ['addColumn', 'read_only_rows', 'added', 'TEXT'],
            ['createView', 'read_only_new', 'SELECT 2 AS value'],
            ['editView', 'read_only_existing', 'SELECT 2 AS value'],
            ['dropView', 'read_only_existing']
        ];
        for (const [method, ...args] of mutations) {
            await assert.rejects(
                worker.invoke(method, ...args),
                /unavailable because the database is read-only/i,
                method
            );
        }

        const rows = await worker.invoke('fetchTableData', 'read_only_rows', {
            columns: ['value', 'spare'],
            limit: 10,
            offset: 0
        });
        assert.deepStrictEqual(
            Array.from(rows.rows, (row: unknown[]) => Array.from(row)),
            [['original', 'keep']]
        );
        const tableInfo = await worker.invoke('getTableInfo', 'read_only_rows');
        assert.deepStrictEqual(
            Array.from(tableInfo, (column: { identifier: string }) => column.identifier),
            ['value', 'spare']
        );
        const schema = await worker.invoke('fetchSchema');
        assert.strictEqual(
            schema.tables.some((table: { identifier: string }) => table.identifier === 'read_only_new_table'),
            false
        );
        assert.strictEqual(
            schema.views.some((view: { identifier: string }) => view.identifier === 'read_only_new'),
            false
        );
        assert.strictEqual(
            schema.views.some((view: { identifier: string }) => view.identifier === 'read_only_existing'),
            true
        );
    });

    it('rejects unsafe demo PRAGMA assignments before execution', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE TABLE pragma_sentinel (id INTEGER)');

        await worker.invoke('setPragma', 'foreign_keys', true);
        await worker.invoke('setPragma', 'cache_size', 64);
        await worker.invoke('setPragma', 'journal_mode', 'memory');
        await assert.rejects(
            worker.invoke(
                'setPragma',
                'foreign_keys',
                'OFF; DROP TABLE pragma_sentinel; --'
            ),
            /Invalid PRAGMA string value/
        );
        await assert.rejects(
            worker.invoke('setPragma', 'foreign_keys; DROP TABLE pragma_sentinel', 'OFF'),
            /Invalid or disallowed PRAGMA/
        );
        await assert.rejects(
            worker.invoke('setPragma', 'cache_size', Number.POSITIVE_INFINITY),
            /Invalid PRAGMA numeric value/
        );

        assert.strictEqual(
            await workerScalar(
                worker,
                "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = 'pragma_sentinel'"
            ),
            1
        );
    });

    it('reports locking_mode and temp_store in the demo pragma snapshot', async () => {
        const worker = await createWorkerHarness();

        const pragmas = await worker.invoke('getPragmas');

        assert.ok(Object.prototype.hasOwnProperty.call(pragmas, 'locking_mode'));
        assert.ok(Object.prototype.hasOwnProperty.call(pragmas, 'temp_store'));
        assert.strictEqual(typeof pragmas.locking_mode, 'string');
        assert.strictEqual(typeof pragmas.temp_store, 'number');
    });

    it('nests demo batch updates inside an existing savepoint', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE TABLE nested_batch (value TEXT); " +
            "INSERT INTO nested_batch VALUES ('before'); " +
            'SAVEPOINT outer_batch'
        );

        const outcomes = await worker.invoke('updateCellBatch', 'nested_batch', [
            { rowId: 1, column: 'value', value: 'after' }
        ]);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(outcomes)), [{
            rowId: 1,
            columnName: 'value',
            priorValue: 'before',
            newValue: 'after',
            operation: 'set'
        }]);
        await worker.invoke('runQuery', 'RELEASE outer_batch');

        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM nested_batch WHERE rowid = 1'),
            'after'
        );
    });

    it('keeps the outer savepoint in control of a nested demo batch update', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE TABLE nested_batch_rollback (value TEXT); " +
            "INSERT INTO nested_batch_rollback VALUES ('before'); " +
            'SAVEPOINT outer_batch_rollback'
        );

        await worker.invoke('updateCellBatch', 'nested_batch_rollback', [
            { rowId: 1, column: 'value', value: 'after' }
        ]);
        await worker.invoke(
            'runQuery',
            'ROLLBACK TO outer_batch_rollback; RELEASE outer_batch_rollback'
        );

        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM nested_batch_rollback WHERE rowid = 1'),
            'before'
        );
    });

    it('nests demo column deletion and lets the outer savepoint restore the schema', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE TABLE nested_delete (kept TEXT, removed TEXT); " +
            "INSERT INTO nested_delete VALUES ('keep', 'restore'); " +
            'SAVEPOINT outer_delete'
        );

        await worker.invoke('deleteColumns', 'nested_delete', ['removed']);
        await worker.invoke('runQuery', 'ROLLBACK TO outer_delete; RELEASE outer_delete');

        const schema = await worker.invoke('getTableInfo', 'nested_delete');
        assert.deepStrictEqual(
            Array.from(schema, (column: { identifier: string }) => column.identifier),
            ['kept', 'removed']
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT removed FROM nested_delete'),
            'restore'
        );
    });

    it('interrupts a long-running preview before its first row is produced', async () => {
        const worker = await createWorkerHarness({
            queryTimeout: 20
        });
        const startedAt = performance.now();

        await assert.rejects(
            worker.invoke(
                'previewViewDefinition',
                'slow_preview',
                'WITH RECURSIVE counter(value) AS (' +
                'VALUES(1) UNION ALL SELECT value + 1 FROM counter WHERE value < 10000000' +
                ') SELECT sum(value) AS value FROM counter',
                10,
                'create'
            ),
            /Query execution timed out after 20ms/
        );
        assert.ok(
            performance.now() - startedAt < 500,
            'demo preview completed before timeout rejection instead of being interrupted'
        );
    });

    it('interrupts a long-running ad hoc query at the configured deadline', async () => {
        const worker = await createWorkerHarness({ queryTimeout: 20 });
        const startedAt = performance.now();

        await assert.rejects(
            worker.invoke(
                'runQuery',
                'WITH RECURSIVE counter(value) AS (' +
                'VALUES(1) UNION ALL SELECT value + 1 FROM counter WHERE value < 10000000' +
                ') SELECT sum(value) FROM counter'
            ),
            /Query execution timed out after 20ms/
        );
        assert.ok(performance.now() - startedAt < 500);
    });

    it('preempts a running query through a shared cancellation flag', async () => {
        const worker = await createWorkerHarness({ queryTimeout: 200 });
        const cancellationFlag = new Int32Array(
            new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
        );
        const flagSetter = new NodeWorker(
            `const { parentPort, workerData } = require('node:worker_threads');
             setTimeout(() => {
               Atomics.store(workerData, 0, 1);
               parentPort.postMessage('cancelled');
             }, 20);`,
            { eval: true, workerData: cancellationFlag }
        );
        const startedAt = performance.now();

        try {
            await assert.rejects(
                worker.invoke(
                    'runQuery',
                    'WITH RECURSIVE counter(value) AS (' +
                    'VALUES(1) UNION ALL SELECT value + 1 FROM counter WHERE value < 10000000' +
                    ') SELECT sum(value) FROM counter',
                    [],
                    cancellationFlag
                ),
                /Query execution cancelled/
            );
            assert.ok(performance.now() - startedAt < 150);
        } finally {
            await flagSetter.terminate();
        }
    });

    it('drops a view whose stored SQL cannot be extracted for editing', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE VIEW opaque_view AS SELECT 1 AS value');
        await worker.invoke('runQuery', 'PRAGMA writable_schema = ON');
        await worker.invoke(
            'runQuery',
            "UPDATE sqlite_schema SET sql = 'opaque stored view text' " +
            "WHERE type = 'view' AND name = 'opaque_view'"
        );
        await worker.invoke('runQuery', 'PRAGMA writable_schema = OFF');

        const dropped = await worker.invoke('dropView', 'opaque_view');

        assert.strictEqual(dropped.sql, 'opaque stored view text');
        assert.strictEqual(dropped.selectSql, '');
        assert.strictEqual(await workerScalar(
            worker,
            "SELECT count(*) FROM sqlite_schema WHERE type = 'view' AND name = 'opaque_view'"
        ), 0);
    });

    it('captures the demo drop snapshot inside the drop savepoint', async () => {
        const order: string[] = [];
        const worker = await createWorkerHarness({
            initSqlJs: async config => {
                const SQL = await initSqlJs(config);
                const BaseDatabase = SQL.Database;
                class RecordingDatabase extends BaseDatabase {
                    exec(sql: string, params?: any) {
                        if (
                            sql.startsWith("SELECT sql FROM sqlite_schema WHERE type = 'view'") &&
                            params?.[0] === 'drop_order_view'
                        ) {
                            order.push('snapshot');
                        }
                        return super.exec(sql, params);
                    }

                    prepare(sql: string, params?: any) {
                        if (!sql.includes('sqlite_explorer_boundary_')) {
                            if (/^SAVEPOINT "sp_drop_view_/.test(sql)) order.push('savepoint');
                            if (sql === 'DROP VIEW main."drop_order_view"') order.push('drop');
                            if (/^RELEASE "sp_drop_view_/.test(sql)) order.push('release');
                        }
                        return super.prepare(sql, params);
                    }
                }
                return { ...SQL, Database: RecordingDatabase };
            }
        });
        await worker.invoke(
            'runQuery',
            'CREATE VIEW drop_order_view AS SELECT 1 AS value'
        );
        order.length = 0;

        const dropped = await worker.invoke('dropView', 'drop_order_view');

        assert.strictEqual(dropped.selectSql, 'SELECT 1 AS value');
        assert.deepStrictEqual(order, ['savepoint', 'snapshot', 'drop', 'release']);
    });

    it('recreates same-event triggers in schema order', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE TABLE trigger_log (label TEXT)');
        await worker.invoke('runQuery', 'CREATE VIEW trigger_order AS SELECT 1 AS value');
        await worker.invoke(
            'runQuery',
            "CREATE TRIGGER z_created_first INSTEAD OF INSERT ON TRIGGER_ORDER BEGIN INSERT INTO trigger_log VALUES ('z'); END"
        );
        await worker.invoke(
            'runQuery',
            "CREATE TRIGGER a_created_second INSTEAD OF INSERT ON TRIGGER_ORDER BEGIN INSERT INTO trigger_log VALUES ('a'); END"
        );

        const before = await worker.invoke('getViewDefinition', 'trigger_order');
        assert.deepStrictEqual(
            Array.from(before.triggers, (trigger: any) => trigger.identifier),
            ['z_created_first', 'a_created_second']
        );

        await worker.invoke('runQuery', 'INSERT INTO trigger_order VALUES (1)');
        const originalOrder = await worker.invoke('runQuery', 'SELECT label FROM trigger_log ORDER BY rowid');
        await worker.invoke('runQuery', 'DELETE FROM trigger_log');
        await worker.invoke('editView', 'trigger_order', 'SELECT 2 AS value', true);
        await worker.invoke('runQuery', 'INSERT INTO trigger_order VALUES (2)');
        const recreatedOrder = await worker.invoke('runQuery', 'SELECT label FROM trigger_log ORDER BY rowid');

        assert.deepStrictEqual(
            Array.from(recreatedOrder[0].rows, (row: unknown[]) => Array.from(row)),
            Array.from(originalOrder[0].rows, (row: unknown[]) => Array.from(row))
        );
    });

    it('rejects a preserved demo trigger that references a removed view column', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE TABLE demo_trigger_column_source (a TEXT, b TEXT); " +
            "INSERT INTO demo_trigger_column_source VALUES ('old-a', 'old-b'); " +
            'CREATE TABLE demo_trigger_column_log (value TEXT); ' +
            'CREATE VIEW demo_trigger_column_view AS SELECT a FROM demo_trigger_column_source; ' +
            'CREATE TRIGGER demo_trigger_column_update ' +
            'INSTEAD OF UPDATE ON demo_trigger_column_view ' +
            "BEGIN INSERT INTO demo_trigger_column_log VALUES (NEW.\"a\" || ':' || OLD.[a]); END"
        );

        await assert.rejects(
            worker.invoke(
                'editView',
                'demo_trigger_column_view',
                'SELECT b FROM demo_trigger_column_source',
                true
            ),
            /demo_trigger_column_update.*missing view column.*\ba\b/i
        );

        const definition = await worker.invoke('getViewDefinition', 'demo_trigger_column_view');
        assert.strictEqual(definition.selectSql, 'SELECT a FROM demo_trigger_column_source');
        await worker.invoke(
            'runQuery',
            "UPDATE demo_trigger_column_view SET a = 'new-a'"
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM demo_trigger_column_log'),
            'new-a:old-a'
        );
    });

    it('preserves a demo trigger whose quoted references match the renamed column', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE TABLE demo_matching_trigger_source (a TEXT, b TEXT); " +
            "INSERT INTO demo_matching_trigger_source VALUES ('old-a', 'old-b'); " +
            'CREATE TABLE demo_matching_trigger_log (value TEXT); ' +
            'CREATE VIEW demo_matching_trigger_view AS SELECT a FROM demo_matching_trigger_source; ' +
            'CREATE TRIGGER demo_matching_trigger_update ' +
            'INSTEAD OF UPDATE OF b ON demo_matching_trigger_view ' +
            'BEGIN INSERT INTO demo_matching_trigger_log VALUES (' +
            "NEW.[b] || ':' || OLD.\"b\" || ':NEW.a' /* OLD.a */); END"
        );

        await worker.invoke(
            'editView',
            'demo_matching_trigger_view',
            'SELECT b FROM demo_matching_trigger_source',
            true
        );
        await worker.invoke(
            'runQuery',
            "UPDATE demo_matching_trigger_view SET b = 'new-b'"
        );

        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM demo_matching_trigger_log'),
            'new-b:old-b:NEW.a'
        );
    });

    it('preserves a TEMP trigger when editing a main-schema view', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE TABLE demo_temp_trigger_rows (value INTEGER)');
        await worker.invoke('runQuery', 'CREATE TABLE demo_temp_trigger_log (value INTEGER)');
        await worker.invoke(
            'runQuery',
            'CREATE VIEW demo_temp_trigger_view AS SELECT value FROM demo_temp_trigger_rows'
        );
        await worker.invoke(
            'runQuery',
            'CREATE TEMP TRIGGER demo_temp_trigger_insert ' +
            'INSTEAD OF INSERT ON DEMO_TEMP_TRIGGER_VIEW ' +
            'BEGIN INSERT INTO demo_temp_trigger_log VALUES (NEW.value); END'
        );

        const before = await worker.invoke('getViewDefinition', 'demo_temp_trigger_view');
        assert.strictEqual(before.triggers.length, 1);
        assert.strictEqual(before.triggers[0].temporary, true);

        const edit = await worker.invoke(
            'editView',
            'demo_temp_trigger_view',
            'SELECT value * 2 AS value FROM demo_temp_trigger_rows',
            true
        );
        assert.strictEqual(edit.after.triggers[0].temporary, true);
        assert.strictEqual(await workerScalar(
            worker,
            "SELECT count(*) FROM sqlite_temp_schema " +
            "WHERE type = 'trigger' AND name = 'demo_temp_trigger_insert'"
        ), 1);
        assert.strictEqual(await workerScalar(
            worker,
            "SELECT count(*) FROM sqlite_schema " +
            "WHERE type = 'trigger' AND name = 'demo_temp_trigger_insert'"
        ), 0);

        await worker.invoke('runQuery', 'INSERT INTO demo_temp_trigger_view VALUES (17)');
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM demo_temp_trigger_log'),
            17
        );
    });

    it('rejects a shadowed unqualified demo TEMP trigger before editing the main view', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE TABLE demo_shadow_trigger_main_rows (value INTEGER)');
        await worker.invoke('runQuery', 'INSERT INTO demo_shadow_trigger_main_rows VALUES (3)');
        await worker.invoke(
            'runQuery',
            'CREATE VIEW demo_shadow_trigger_view AS ' +
            'SELECT value FROM demo_shadow_trigger_main_rows'
        );
        await worker.invoke('runQuery', 'CREATE TEMP TABLE demo_shadow_trigger_temp_rows (value INTEGER)');
        await worker.invoke('runQuery', 'INSERT INTO demo_shadow_trigger_temp_rows VALUES (7)');
        await worker.invoke(
            'runQuery',
            'CREATE TEMP VIEW demo_shadow_trigger_view AS ' +
            'SELECT value FROM demo_shadow_trigger_temp_rows'
        );
        await worker.invoke('runQuery', 'CREATE TEMP TABLE demo_shadow_trigger_log (value INTEGER)');
        await worker.invoke(
            'runQuery',
            'CREATE TEMP TRIGGER demo_shadow_trigger_insert ' +
            'INSTEAD OF INSERT ON demo_shadow_trigger_view ' +
            'BEGIN INSERT INTO demo_shadow_trigger_log VALUES (NEW.value); END'
        );

        const browsed = await worker.invoke('getViewDefinition', 'demo_shadow_trigger_view');
        assert.deepStrictEqual(Array.from(browsed.triggers), []);
        assert.deepStrictEqual(
            Array.from(browsed.ambiguousTemporaryTriggerNames),
            ['demo_shadow_trigger_insert']
        );
        await assert.rejects(
            worker.invoke(
                'editView',
                'demo_shadow_trigger_view',
                'SELECT value * 2 AS value FROM demo_shadow_trigger_main_rows',
                true
            ),
            /demo_shadow_trigger_insert.*drop the TEMP shadow view.*schema-qualified target/is
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM main.demo_shadow_trigger_view'),
            3
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM temp.demo_shadow_trigger_view'),
            7
        );
        await worker.invoke('runQuery', 'INSERT INTO demo_shadow_trigger_view VALUES (11)');
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM demo_shadow_trigger_log'),
            11
        );
    });

    it('rejects demo edit and drop when a main-bound TEMP trigger becomes ambiguous', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_ambiguous_main_rows (value INTEGER); ' +
            'INSERT INTO demo_ambiguous_main_rows VALUES (3); ' +
            'CREATE TABLE demo_ambiguous_main_log (value INTEGER); ' +
            'CREATE VIEW demo_ambiguous_trigger_view AS ' +
            'SELECT value FROM demo_ambiguous_main_rows; ' +
            'CREATE TEMP TRIGGER demo_ambiguous_main_insert ' +
            'INSTEAD OF INSERT ON demo_ambiguous_trigger_view ' +
            'BEGIN INSERT INTO demo_ambiguous_main_log VALUES (NEW.value); END; ' +
            'CREATE TEMP TABLE demo_ambiguous_temp_rows (value INTEGER); ' +
            'INSERT INTO demo_ambiguous_temp_rows VALUES (7); ' +
            'CREATE TEMP VIEW demo_ambiguous_trigger_view AS ' +
            'SELECT value FROM demo_ambiguous_temp_rows'
        );

        const browsed = await worker.invoke(
            'getViewDefinition',
            'demo_ambiguous_trigger_view'
        );
        assert.strictEqual(browsed.selectSql, 'SELECT value FROM demo_ambiguous_main_rows');
        assert.deepStrictEqual(Array.from(browsed.triggers), []);
        assert.deepStrictEqual(
            Array.from(browsed.ambiguousTemporaryTriggerNames),
            ['demo_ambiguous_main_insert']
        );

        const expectedError = /demo_ambiguous_main_insert.*drop the TEMP shadow view.*TEMP trigger.*schema-qualified target/is;
        await assert.rejects(
            worker.invoke(
                'editView',
                'demo_ambiguous_trigger_view',
                'SELECT value * 2 AS value FROM demo_ambiguous_main_rows',
                true
            ),
            expectedError
        );
        await assert.rejects(
            worker.invoke('dropView', 'demo_ambiguous_trigger_view'),
            expectedError
        );

        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM main.demo_ambiguous_trigger_view'),
            3
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM temp.demo_ambiguous_trigger_view'),
            7
        );
        assert.strictEqual(await workerScalar(
            worker,
            "SELECT count(*) FROM sqlite_temp_schema " +
            "WHERE type = 'trigger' AND name = 'demo_ambiguous_main_insert'"
        ), 1);
        await worker.invoke(
            'runQuery',
            'INSERT INTO main.demo_ambiguous_trigger_view VALUES (19)'
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM demo_ambiguous_main_log'),
            19
        );
    });

    it('preserves a quoted-main TEMP trigger through a same-named TEMP view shadow', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE TABLE demo_qualified_main_rows (value INTEGER)');
        await worker.invoke('runQuery', 'INSERT INTO demo_qualified_main_rows VALUES (3)');
        await worker.invoke(
            'runQuery',
            'CREATE VIEW demo_qualified_trigger_view AS SELECT value FROM demo_qualified_main_rows'
        );
        await worker.invoke('runQuery', 'CREATE TEMP TABLE demo_qualified_temp_rows (value INTEGER)');
        await worker.invoke('runQuery', 'INSERT INTO demo_qualified_temp_rows VALUES (7)');
        await worker.invoke(
            'runQuery',
            'CREATE TEMP VIEW demo_qualified_trigger_view AS ' +
            'SELECT value FROM demo_qualified_temp_rows'
        );
        await worker.invoke(
            'runQuery',
            'CREATE TEMP TABLE demo_qualified_trigger_log (target TEXT, value INTEGER)'
        );
        await worker.invoke(
            'runQuery',
            'CREATE TEMP TRIGGER demo_qualified_main_insert ' +
            'INSTEAD OF INSERT ON "main"."demo_qualified_trigger_view" ' +
            "BEGIN INSERT INTO demo_qualified_trigger_log VALUES ('main', NEW.value); END"
        );
        await worker.invoke(
            'runQuery',
            'CREATE TEMP TRIGGER demo_qualified_temp_insert ' +
            'INSTEAD OF INSERT ON temp.demo_qualified_trigger_view ' +
            "BEGIN INSERT INTO demo_qualified_trigger_log VALUES ('temp', NEW.value); END"
        );

        const edit = await worker.invoke(
            'editView',
            'demo_qualified_trigger_view',
            'SELECT value * 2 AS value FROM demo_qualified_main_rows',
            true
        );

        assert.deepStrictEqual(
            Array.from(edit.before.triggers, (trigger: any) => trigger.identifier),
            ['demo_qualified_main_insert']
        );
        assert.deepStrictEqual(
            Array.from(edit.after.triggers, (trigger: any) => trigger.identifier),
            ['demo_qualified_main_insert']
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM temp.demo_qualified_trigger_view'),
            7
        );
        await worker.invoke('runQuery', 'INSERT INTO main.demo_qualified_trigger_view VALUES (13)');
        await worker.invoke('runQuery', 'INSERT INTO temp.demo_qualified_trigger_view VALUES (17)');
        assert.strictEqual(
            await workerScalar(
                worker,
                "SELECT value FROM demo_qualified_trigger_log WHERE target = 'main'"
            ),
            13
        );
        assert.strictEqual(
            await workerScalar(
                worker,
                "SELECT value FROM demo_qualified_trigger_log WHERE target = 'temp'"
            ),
            17
        );
    });
});
