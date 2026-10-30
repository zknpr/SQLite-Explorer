import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import * as vscode from 'vscode';
import initSqlJs from '../../vendor/sql.js/sql-wasm.js';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection, NativeWorkerProcess } from '../../src/nativeWorker';
import { buildCellContainmentQuery } from '../../src/core/cell-containment';
import { buildExactNumericTextQuery } from '../../src/core/integer-utils';
import { prepareReadQuery, SQL_RESULT_BYTES, SQL_RESULT_ROWS } from '../../src/core/sql-workspace';
import type { CellValue, DatabaseOperations, QueryResultSet, TableQueryOptions } from '../../src/core/types';

// The runtime's grid cell helpers (src/runtime/query-plan.c) replace per-cell
// SQL in grid pages and query console results. These tests hold them to the
// SQL they replace: the C functions directly on sql.js, and whole pages and
// results on the real engines and the web demo worker with the helpers on and
// off.

const HELPER_NAME = 'sqlite_explorer_cell_preview';

// TEXT byte patterns the helpers must classify: NUL, BOMs, encoded surrogates,
// overlong and truncated sequences, code points past U+10FFFF, lone and
// invalid bytes, noncharacters, 4-byte characters, and multibyte text across
// the clip boundary.
const TEXT_BYTES = [
    '', '41', '00', '410042', 'efbbbf41', '41efbbbf', 'eda080', 'c080', 'e08280', 'f4908080',
    'e4b8', '80', 'ff', 'efbfbe', 'efbfbf', 'f09f9880', 'c3a9', 'c3a9'.repeat(200),
    'f09f9880'.repeat(100), '61'.repeat(301), '0000000000', 'c3a9'.repeat(149) + 'f09f9880',
    '8080' + '61'.repeat(400), 'c3' + '80'.repeat(400), '61'.repeat(100) + '00' + '62'.repeat(300)
];

// Both sides of every edge the UTF-8 check draws. Plain bytes skip the
// decoder's byte comparison, so a wrong "plain" would let a lossy string
// stand for the stored bytes.
const NOT_PLAIN_UTF8 = ['c1bf', 'e09fbf', 'edbfbf', 'f08fbfbf', 'f5808080', 'f09f98', '41c3'];
const PLAIN_UTF8 = ['c280', 'dfbf', 'e0a080', 'ed9fbf', 'ee8080', 'efbfbd', 'f0908080', 'f48fbfbf', 'efb790', 'f09fbfbe'];
TEXT_BYTES.push(...NOT_PLAIN_UTF8, ...PLAIN_UTF8);

const ROWID_FIXTURE_SQL = [
    'CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT, t TEXT, b BLOB, r REAL, i INTEGER, u)',
    ...TEXT_BYTES.map((hex, index) => {
        const blob = ["x''", "x'000102'", 'zeroblob(400)', 'NULL'][index % 4];
        const real = ['0.1', '1.0 / 3', '1e300', '-0.0', '2.0', 'NULL'][index % 6];
        const integer = ['9223372036854775807', '9007199254740993', '-1', 'NULL'][index % 4];
        const untyped = ["CAST(x'ff' AS TEXT)", '2.5', "'plain'", 'NULL'][index % 4];
        return `INSERT INTO t VALUES (${index + 1}, 'row ${index}', CAST(x'${hex}' AS TEXT), ` +
            `${blob}, ${real}, ${integer}, ${untyped})`;
    }),
    'CREATE VIEW vt AS SELECT label, t, b FROM t'
].join(';\n');
// UTF-16 conversion merges some malformed keys, so this table is UTF-8 only.
const FIXTURE_SQL = [
    ROWID_FIXTURE_SQL,
    'CREATE TABLE p (k TEXT PRIMARY KEY, v) WITHOUT ROWID',
    ...TEXT_BYTES.map((hex, index) => `INSERT INTO p VALUES (CAST(x'${hex}' AS TEXT), ${index})`)
].join(';\n');

const PAGES: Array<[string, string, TableQueryOptions]> = [
    ['rowid order', 't', {
        columns: ['rowid', 'id', 'label', 't', 'b', 'r', 'i', 'u'], limit: 100, offset: 0, maxInlineCellBytes: 300
    }],
    ['a TEXT sort with keyset anchors', 't', {
        columns: ['rowid', 'id', 'label', 't', 'b', 'r', 'i', 'u'], orderBy: 't', limit: 100, offset: 0,
        maxInlineCellBytes: 300
    }],
    ['an exhausted page budget', 't', {
        columns: ['rowid', 'id', 'label', 't', 'b', 'r', 'i', 'u'], limit: 100, offset: 0,
        maxInlineCellBytes: 300, maxPageResponseBytes: 600
    }],
    ['a WITHOUT ROWID TEXT key', 'p', { columns: ['rowid', 'k', 'v'], limit: 100, offset: 0, maxInlineCellBytes: 300 }],
    ['an identityless view', 'vt', { columns: ['label', 't', 'b'], limit: 100, offset: 0, maxInlineCellBytes: 300 }]
];

// Fourteen result columns narrow the console's cell window to 299 bytes, so
// the fixture's 400-byte TEXT and BLOB values clip.
const CONSOLE_QUERIES: Array<[string, string, CellValue[]]> = [
    ['clipped TEXT and BLOB cells, REAL and big integers',
        'SELECT id, label, t, b, r, i, u, t AS t2, b AS b2, u AS u2, r AS r2, i AS i2, t AS t3, b AS b3 FROM t ORDER BY id', []],
    ['a WITHOUT ROWID TEXT key', 'SELECT k, v FROM p ORDER BY v', []],
    ['the row cap with clipped multibyte TEXT',
        'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 1200) ' +
        "SELECT x, zeroblob(x % 7 * 1000) AS b, replace(hex(zeroblob(x % 5 * 300)), '0', 'é') AS t, x * 0.1 AS r FROM n", []],
    ['bound parameters', 'SELECT ? AS a, CAST(? AS INTEGER) AS big, ? AS r, t FROM t WHERE id <= ? ORDER BY id',
        ['x', '9223372036854775807', 0.1, 5]],
    // REAL text packs one column per 100 values, so this spans two.
    ['REAL text past the first 100 columns',
        `SELECT ${Array.from({ length: 120 }, (_, index) => `${['r', 't', 'i', 'b'][index % 4]} AS c${index}`).join(', ')} FROM t ORDER BY id`, []]
];

/** The console's transport SQL before the helpers, which the fallback keeps. */
function legacyReadTransportSql(sql: string, columnCount: number): string {
    const containment = buildCellContainmentQuery(prepareReadQuery(sql).sql, columnCount, {
        limit: SQL_RESULT_ROWS + 1, maxInlineCellBytes: 64 * 1024, maxPageResponseBytes: SQL_RESULT_BYTES
    });
    return buildExactNumericTextQuery(containment.sql, containment.primaryTransportColumnCount).sql;
}

async function buildImage(sql: string, encoding?: string): Promise<Uint8Array> {
    const opened = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
    const engine = opened.operations as WasmDatabaseEngine;
    try {
        if (encoding) await engine.executeQuery(`PRAGMA encoding = '${encoding}'`);
        await engine.executeQuery(sql);
        return await engine.serializeDatabase();
    } finally {
        engine.shutdown();
    }
}

interface PageBackend {
    ops: DatabaseOperations;
    setHelpers(enabled: boolean): void;
    pageSql: string[];
    logs: string[];
    dispose(): void;
}

async function openWasm(image: Uint8Array): Promise<PageBackend> {
    const logs: string[] = [];
    const opened = await createDatabaseEngine({ content: image, maxSize: 0, readOnlyMode: false },
        (_level, ...args) => { logs.push(args.map(String).join(' ')); });
    const engine = opened.operations as WasmDatabaseEngine;
    const pageSql: string[] = [];
    const instance = (engine as any).instance;
    const prepare = instance.prepare.bind(instance);
    instance.prepare = (sql: string, ...rest: unknown[]) => { pageSql.push(sql); return prepare(sql, ...rest); };
    return {
        ops: engine,
        setHelpers: enabled => { (engine as any).hasCellHelpers = enabled; },
        pageSql,
        logs,
        dispose: () => engine.shutdown()
    };
}

const originalCall = NativeWorkerProcess.prototype.call;
let nativeHelpersEnabled = true;
const nativePageSql: string[] = [];
(NativeWorkerProcess.prototype as any).call = async function (method: string, args: unknown[] = [], ...rest: unknown[]) {
    if (method === 'queryNumeric' || method === 'workspaceQuery') nativePageSql.push(String(args[0]));
    const result = await (originalCall as any).call(this, method, args, ...rest);
    return method === 'prepareGridPage' && !nativeHelpersEnabled ? { ...result, cellHelpers: false } : result;
};
after(() => { NativeWorkerProcess.prototype.call = originalCall; });

function bundledNativeBinary(): string | undefined {
    const platformDir = process.platform === 'darwin'
        ? (process.arch === 'arm64' ? 'aarch64-macos' : 'x86_64-macos')
        : process.platform === 'linux'
            ? (process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu')
            : process.platform === 'win32' && process.arch === 'x64' ? 'x86_64-windows' : undefined;
    // The five-target CI workflow names the runtime each runner must use.
    const expected = process.env.FUZZ_EXPECT_TARGET;
    if (expected && expected !== platformDir) {
        throw new Error(`Expected native target ${expected}, resolved ${platformDir ?? 'none'}`);
    }
    if (!platformDir) return undefined;
    const binary = path.join('natives', platformDir, process.platform === 'win32' ? 'tjs.exe' : 'tjs');
    if (expected && !fs.existsSync(binary)) throw new Error(`Missing native runtime ${binary}`);
    return fs.existsSync(binary) ? binary : undefined;
}

async function openNative(image: Uint8Array): Promise<PageBackend> {
    fs.mkdirSync('.tmp', { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('.tmp/grid-cell-helpers-'));
    const file = path.join(directory, 'fixture.db');
    fs.writeFileSync(file, image);
    const logs: string[] = [];
    const outputChannel = { appendLine: (line: string) => { logs.push(line); } } as unknown as vscode.OutputChannel;
    const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()), undefined, outputChannel);
    const connection = await native.establishConnection(vscode.Uri.file(file), 'grid-cell-helpers', false);
    nativePageSql.length = 0;
    return {
        ops: connection.databaseOps,
        setHelpers: enabled => { nativeHelpersEnabled = enabled; },
        pageSql: nativePageSql,
        logs,
        dispose: () => {
            nativeHelpersEnabled = true;
            native.workerMethods[Symbol.dispose]();
            // Windows can hold the file briefly after the worker exits.
            fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    };
}

// The demo worker probes each database once, so each arm is its own worker.
// sql.js caches one module per process and the runtime registers with it as
// an automatic extension, so the off arm fails the worker's probe instead.
async function openDemoWorker(image: Uint8Array, helpers: boolean, pageSql: string[], logs: string[]) {
    const responses: any[] = [];
    const workerGlobal: any = {
        initSqlJs: async (config: Parameters<typeof initSqlJs>[0]) => {
            const sqlJs = await initSqlJs(config);
            const Database = new Proxy(sqlJs.Database, {
                construct(Target: any, args: any[]): object {
                    const database = Reflect.construct(Target, args) as Record<string, any>;
                    const exec = database.exec.bind(database);
                    database.exec = (sql: string, ...rest: unknown[]) => {
                        if (sql.includes('__sqlite_explorer_cell_source')) pageSql.push(sql);
                        if (!helpers && sql.includes(HELPER_NAME)) throw new Error(`no such function: ${HELPER_NAME}`);
                        return exec(sql, ...rest);
                    };
                    return database;
                }
            });
            return { ...sqlJs, Database, ...(helpers ? {} : { _sqlite_explorer_register_query_plan: undefined }) };
        },
        postMessage(message: unknown) { responses.push(message); }
    };
    const log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    const context = vm.createContext({
        self: workerGlobal, importScripts() {}, console: { log() {}, warn: log, error: log },
        Uint8Array, Int32Array, ArrayBuffer, SharedArrayBuffer, Atomics, DataView, crypto: webcrypto,
        TextEncoder, TextDecoder, Date, setTimeout, clearTimeout
    });
    // web_demo_worker.test.ts holds this bundle to the authored source.
    new vm.Script(fs.readFileSync('website/public/sqlite-viewer/worker.js', 'utf8'), {
        filename: 'website/public/sqlite-viewer/worker.js'
    }).runInContext(context);
    let messageId = 0;
    const invoke = async (method: string, ...payload: unknown[]) => {
        const id = `helpers_${++messageId}`;
        await workerGlobal.onmessage({ data: { channel: 'rpc', content: { kind: 'invoke', messageId: id, targetMethod: method, payload } } });
        const index = responses.findIndex(message => message.content?.messageId === id);
        assert.notEqual(index, -1, `worker did not respond to ${method}`);
        const [response] = responses.splice(index, 1);
        if (!response.content.success) throw new Error(response.content.errorMessage);
        return response.content.data;
    };
    await invoke('initializeDatabase', 'fixture.db', {
        // The tracked runtime; assets/sqlite3.wasm is a build output the native CI lane lacks.
        content: image, wasmBinary: new Uint8Array(fs.readFileSync('vendor/sql.js/sql-wasm.wasm'))
    });
    return invoke;
}

async function openDemo(image: Uint8Array): Promise<PageBackend> {
    const pageSql: string[] = [];
    const logs: string[] = [];
    const arms = {
        on: await openDemoWorker(image, true, pageSql, logs),
        off: await openDemoWorker(image, false, pageSql, logs)
    };
    let arm = arms.on;
    return {
        // Each worker has its own realm; cloning lets deepStrictEqual compare values, not prototypes.
        ops: {
            fetchTableData: async (table: string, options: TableQueryOptions) => structuredClone(await arm('fetchTableData', table, options))
        } as DatabaseOperations,
        setHelpers: enabled => { arm = enabled ? arms.on : arms.off; },
        pageSql,
        logs,
        dispose: () => {}
    };
}

async function fetchBoth(backend: PageBackend, table: string, options: TableQueryOptions) {
    backend.setHelpers(false);
    backend.pageSql.length = 0;
    const sqlPage = await backend.ops.fetchTableData!(table, options);
    const sqlUsedHelpers = backend.pageSql.some(sql => sql.includes(HELPER_NAME));
    backend.setHelpers(true);
    backend.pageSql.length = 0;
    const helperPage = await backend.ops.fetchTableData!(table, options);
    const helperUsedHelpers = backend.pageSql.some(sql => sql.includes(HELPER_NAME));
    return { sqlPage, helperPage, sqlUsedHelpers, helperUsedHelpers };
}

describe('grid cell helpers on sql.js', () => {
    it('match the SQL previews, metadata and a strict UTF-8 check for generated values', async () => {
        const opened = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
        const engine = opened.operations as WasmDatabaseEngine;
        const instance = (engine as any).instance;
        const one = (sql: string, params: unknown[]) => {
            const statement = instance.prepare(sql, params);
            try {
                assert.ok(statement.step());
                return statement.get();
            } finally {
                statement.free();
            }
        };
        const fragments = [[0x41], [0x00], [0xc3, 0xa9], [0xe2, 0x82, 0xac], [0xf0, 0x9f, 0x98, 0x80],
            [0xef, 0xbb, 0xbf], [0xed, 0xa0, 0x80], [0xc0, 0x80], [0xe0, 0x82, 0x80], [0xf4, 0x90, 0x80, 0x80],
            [0xef, 0xbf, 0xbe], [0xef, 0xbf, 0xbf], [0xe4, 0xb8], [0x80], [0xff], [0x7f], [0x0a],
            ...[...NOT_PLAIN_UTF8, ...PLAIN_UTF8].map(hex => [...Buffer.from(hex, 'hex')])];
        const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
        const plainUtf8 = (bytes: Uint8Array) => {
            if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return false;
            try {
                const text = strict.decode(bytes);
                return !/[\0￾￿]/.test(text);
            } catch {
                return false;
            }
        };
        let seed = 0x5eed;
        const next = (bound: number) => {
            seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
            return seed % bound;
        };
        const distinct = new Set<string>();
        try {
            for (let round = 0; round < 3000; round++) {
                const bytes = Uint8Array.from(Array.from({ length: next(8) }, () => fragments[next(fragments.length)]).flat());
                const limit = next(14);
                const characters = next(5);
                distinct.add(`${Buffer.from(bytes).toString('hex')}:${limit}:${characters}`);
                const [sqlText, helperText, helperType] = one(
                    "SELECT CASE WHEN octet_length(t) > ?2 THEN hex(substr(t, 1, ?3)) ELSE hex(t) END, " +
                    'hex(sqlite_explorer_cell_preview(t, ?2, ?3)), typeof(sqlite_explorer_cell_preview(t, ?2, ?3)) ' +
                    'FROM (SELECT CAST(?1 AS TEXT) AS t)', [bytes, limit, characters]);
                assert.equal(helperText, sqlText, `TEXT preview of ${Buffer.from(bytes).toString('hex')}`);
                assert.equal(helperType, 'text');
                const [sqlBlob, helperBlob] = one(
                    'SELECT CASE WHEN octet_length(?1) > ?2 THEN hex(substr(?1, 1, ?2)) ELSE hex(?1) END, ' +
                    'hex(sqlite_explorer_cell_preview(?1, ?2, ?3))', [bytes, limit, characters]);
                assert.equal(helperBlob, sqlBlob);
                const [check] = one('SELECT sqlite_explorer_cell_text_check(CAST(?1 AS TEXT), ?2)', [bytes, limit]);
                const expected = bytes.length > limit ? 0 : plainUtf8(bytes) ? null : bytes;
                assert.deepEqual(check, expected, `TEXT check of ${Buffer.from(bytes).toString('hex')}`);
            }
            assert.ok(distinct.size > 2000, `only ${distinct.size} distinct generated inputs`);

            const token = (column: string) => `CASE WHEN typeof(${column}) IN ('text', 'blob') AND octet_length(${column}) > ?6 ` +
                `THEN CASE typeof(${column}) WHEN 'text' THEN 't' ELSE 'b' END || CAST(octet_length(${column}) AS TEXT) ELSE '' END`;
            const metadataSql = `SELECT ${['?1', '?2', '?3', '?4', '?5'].map(token).join(" || '|' || ")}, ` +
                'sqlite_explorer_cell_metadata(?6, ?1, ?2, ?3, ?4, ?5)';
            const values = [null, 3, 1.5, 'x'.repeat(9), 'é'.repeat(5), new Uint8Array(12), ''];
            for (let round = 0; round < 2000; round++) {
                const row = Array.from({ length: 5 }, () => values[next(values.length)]);
                const [sqlTokens, helperTokens] = one(metadataSql, [...row, next(16)]);
                assert.equal(helperTokens, sqlTokens === '||||' ? null : sqlTokens);
            }

            for (const [hex, plain] of [...NOT_PLAIN_UTF8.map(hex => [hex, false] as const),
                ...PLAIN_UTF8.map(hex => [hex, true] as const)]) {
                const bytes = new Uint8Array(Buffer.from(hex, 'hex'));
                const [check] = one('SELECT sqlite_explorer_cell_text_check(CAST(?1 AS TEXT), 100)', [bytes]);
                assert.deepEqual(check, plain ? null : bytes, `${hex} should ${plain ? '' : 'not '}be plain UTF-8`);
            }

            for (const [label, value, limit] of [['a negative limit', "'x'", '-1'], ['a REAL limit', "'x'", '1.5']]) {
                assert.throws(() => instance.exec(`SELECT sqlite_explorer_cell_preview(${value}, ${limit}, 1)`),
                    /limits must be integers/, label);
            }
        } finally {
            engine.shutdown();
        }
    });

    it('pack the same REAL text CAST produces, for every argument chunk', async () => {
        const { parsePackedRealTexts } = await import('../../src/core/integer-utils.ts');
        const opened = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
        const engine = opened.operations as WasmDatabaseEngine;
        const instance = (engine as any).instance;
        try {
            const reals = ['0.1', '1.0 / 3', '1e300', '-0.0', '2.0', '-2.5e-308', '4.9e-324', '1e999', '-1e999',
                '9007199254740993.0', '123456789012345678.0', '0.000001', '1.7976931348623157e308', 'CAST(5 AS REAL)'];
            const others = ['NULL', '7', "'text'", "x'00'", "CAST('1.5' AS TEXT)"];
            let seed = 0x7ea1;
            const next = (bound: number) => {
                seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
                return seed % bound;
            };
            for (let round = 0; round < 300; round++) {
                const values = Array.from({ length: 1 + next(6) }, () => next(3) ? reals[next(reals.length)] : others[next(others.length)]);
                const base = next(50);
                const [packed, ...casts] = instance.exec(
                    `SELECT sqlite_explorer_real_texts(${base}, ${values.join(', ')}), ` +
                    values.map(value => `CASE WHEN typeof(${value}) = 'real' THEN CAST(${value} AS TEXT) END`).join(', ')
                )[0].values[0];
                const expected = casts.flatMap((text: string | null, index: number) => text === null ? [] : [`${base + index}:${text}`]);
                assert.equal(packed, expected.length ? expected.join('|') : null, values.join(', '));
            }
            for (const bad of ['1', ':1', '1:', '01:1', '2:1|1:1', '1:1|1:1', '9:1']) {
                assert.throws(() => parsePackedRealTexts([bad], 5, 0), /Packed REAL text/, bad);
            }
            assert.deepEqual([...parsePackedRealTexts(['0:0.1|4:2.0', null], 5, 0)!], [[0, '0.1'], [4, '2.0']]);
        } finally {
            engine.shutdown();
        }
    });

    it('cannot be called from schema code', async () => {
        const opened = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
        const engine = opened.operations as WasmDatabaseEngine;
        try {
            await engine.executeQuery('CREATE VIEW helper_view AS SELECT sqlite_explorer_cell_text_check(1, 1) AS value');
            await assert.rejects(engine.executeQuery('SELECT * FROM helper_view'), /unsafe use of sqlite_explorer_cell_text_check/);
        } finally {
            engine.shutdown();
        }
    });
});

const openBackend = { wasm: openWasm, native: openNative, demo: openDemo };

for (const backendName of ['wasm', 'native', 'demo'] as const) {
    describe(`${backendName} grid pages with and without the cell helpers`, () => {
        for (const [label, table, options] of PAGES) {
            it(`match for ${label}`, async (context) => {
                if (backendName === 'native' && !bundledNativeBinary()) {
                    context.skip(`no bundled txiki worker for ${process.platform}-${process.arch}`);
                    return;
                }
                const image = await buildImage(FIXTURE_SQL);
                const backend = await openBackend[backendName](image);
                try {
                    const { sqlPage, helperPage, sqlUsedHelpers, helperUsedHelpers } = await fetchBoth(backend, table, options);
                    assert.equal(sqlUsedHelpers, false);
                    assert.equal(helperUsedHelpers, true);
                    assert.deepStrictEqual(helperPage, sqlPage);
                    if (backendName === 'demo') {
                        assert.ok(backend.logs.some(line => line.includes('did not register')), backend.logs.join('\n'));
                        assert.ok(backend.logs.some(line => line.includes('Grid cell helpers are unavailable')), backend.logs.join('\n'));
                    }
                } finally {
                    backend.dispose();
                }
            });
        }

        it('keep SQL containment for a UTF-16 database', async (context) => {
            if (backendName === 'native' && !bundledNativeBinary()) {
                context.skip(`no bundled txiki worker for ${process.platform}-${process.arch}`);
                return;
            }
            const image = await buildImage(ROWID_FIXTURE_SQL, 'UTF-16le');
            const backend = await openBackend[backendName](image);
            try {
                const [, table, options] = PAGES[0];
                const { sqlPage, helperPage, helperUsedHelpers } = await fetchBoth(backend, table, options);
                assert.equal(helperUsedHelpers, false);
                assert.deepStrictEqual(helperPage, sqlPage);
                assert.equal(backend.logs.filter(line => line.includes('read UTF-8 only')).length, 1, backend.logs.join('\n'));
            } finally {
                backend.dispose();
            }
        });
    });
}

// assert's diff of two 1,001-row results takes minutes to render, so a
// mismatch is reported at its first differing row or sidecar entry.
function assertSameResult(actual: QueryResultSet, expected: QueryResultSet) {
    if (isDeepStrictEqual(actual, expected)) return;
    for (let index = 0; index < Math.max(actual.rows.length, expected.rows.length); index++) {
        assert.deepStrictEqual(actual.rows[index], expected.rows[index], `row ${index}`);
    }
    const fields = actual as unknown as Record<string, Record<string, unknown> | undefined>;
    const expectedFields = expected as unknown as Record<string, Record<string, unknown> | undefined>;
    for (const key of new Set([...Object.keys(actual), ...Object.keys(expected)])) {
        const entries = new Set([...Object.keys(fields[key] ?? {}), ...Object.keys(expectedFields[key] ?? {})]);
        for (const entry of entries) assert.deepStrictEqual(fields[key]?.[entry], expectedFields[key]?.[entry], `${key}[${entry}]`);
    }
    assert.fail('results differ outside their rows and sidecars');
}

async function readBoth(backend: PageBackend, sql: string, params: CellValue[]) {
    backend.setHelpers(false);
    backend.pageSql.length = 0;
    const sqlResult = await backend.ops.executeReadQuery!(sql, params);
    const sqlRun = [...backend.pageSql];
    backend.setHelpers(true);
    backend.pageSql.length = 0;
    const helperResult = await backend.ops.executeReadQuery!(sql, params);
    const helperRun = [...backend.pageSql];
    // WASM appends a boundary comment to the statement it prepares.
    const legacy = legacyReadTransportSql(sql, sqlResult.headers.length);
    const ranLegacy = (run: string[]) => run.some(text => text === legacy || text.startsWith(`${legacy}\n/*sqlite_explorer_boundary_`));
    return {
        sqlResult,
        helperResult,
        sqlRanLegacy: ranLegacy(sqlRun),
        sqlUsedHelpers: sqlRun.some(text => text.includes(HELPER_NAME)),
        helperUsedHelpers: helperRun.some(text => text.includes(HELPER_NAME))
    };
}

for (const backendName of ['wasm', 'native'] as const) {
    describe(`${backendName} query console results with and without the cell helpers`, () => {
        for (const [label, sql, params] of CONSOLE_QUERIES) {
            it(`match for ${label}`, async (context) => {
                if (backendName === 'native' && !bundledNativeBinary()) {
                    context.skip(`no bundled txiki worker for ${process.platform}-${process.arch}`);
                    return;
                }
                const backend = await openBackend[backendName](await buildImage(FIXTURE_SQL));
                try {
                    const result = await readBoth(backend, sql, params);
                    assert.equal(result.sqlRanLegacy, true, 'the fallback keeps the SQL it had before the helpers');
                    assert.equal(result.sqlUsedHelpers, false);
                    assert.equal(result.helperUsedHelpers, true);
                    assertSameResult(result.helperResult, result.sqlResult);
                    if (label.startsWith('clipped') || label.startsWith('the row cap')) {
                        assert.ok(Object.keys(result.sqlResult.oversizedCells ?? {}).length > 0, 'the query clips cells');
                    }
                    if (label.startsWith('the row cap')) assert.equal(result.sqlResult.rows.length, SQL_RESULT_ROWS + 1);
                    if (label.startsWith('REAL text past')) {
                        const columns = Object.values(result.sqlResult.exactIntegerTexts ?? {}).flatMap(row => Object.keys(row).map(Number));
                        assert.ok(columns.some(column => column >= 100), 'the result has exact REAL text past column 100');
                    }
                } finally {
                    backend.dispose();
                }
            });
        }

        it('keep SQL containment for a UTF-16 database', async (context) => {
            if (backendName === 'native' && !bundledNativeBinary()) {
                context.skip(`no bundled txiki worker for ${process.platform}-${process.arch}`);
                return;
            }
            const backend = await openBackend[backendName](await buildImage(ROWID_FIXTURE_SQL, 'UTF-16le'));
            try {
                const [, sql, params] = CONSOLE_QUERIES[0];
                const first = await readBoth(backend, sql, params);
                const second = await readBoth(backend, sql, params);
                for (const result of [first, second]) {
                    assert.equal(result.sqlRanLegacy, true);
                    assert.equal(result.helperUsedHelpers, false);
                    assertSameResult(result.helperResult, result.sqlResult);
                }
                assert.ok(Object.keys(first.sqlResult.oversizedCells ?? {}).length > 0, 'the query clips cells');
                assert.equal(backend.logs.filter(line => line.includes('read UTF-8 only')).length, 1, backend.logs.join('\n'));
            } finally {
                backend.dispose();
            }
        });
    });
}
