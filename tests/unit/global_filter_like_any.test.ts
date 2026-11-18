import './vscode_mock_setup'; // Must be first

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import * as vscode from 'vscode';

import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { buildCountQuery, buildSelectQuery } from '../../src/core/query-builder';
import { createNativeDatabaseConnection, NativeWorkerProcess } from '../../src/nativeWorker';
import type { CellValue, DatabaseOperations, TableQueryOptions } from '../../src/core/types';

// One value per SQLite storage class and per rule sqlite_explorer_like_any
// relies on: ASCII-only case folding, the NUL stop, SQLite's own decoding of
// malformed UTF-8, BLOBs, and the INTEGER and REAL text alphabets.
const VALUES = [
    'NULL', '0', '-1', '9999', '19999', '1234567890123', '9223372036854775807', '-9223372036854775808',
    '0.0', '-0.0', '1.5', '-2.25', '1.0 / 3', '1e20', '1e-7', '1e308', '-1e308', '4.9e-324', '1e999', '-1e999',
    '123456789012345678.0', '9999.0', '0.0001', '2.2250738585072014e-308',
    "''", "'abc'", "'ABC'", "'Hello World'", "'john@example.com'", "'JOHN'", "'é'", "'É'", "'naïve'",
    "'中文'", "'😀'", "'a%b'", "'a_b'", "'a\\b'", "'inf'", "'Infinity'", "'1e5'", "'-1.5e+10'", "'nan'",
    "'  padded  '", "char(65533)",
    "CAST(x'610062' AS TEXT)", "CAST(x'efbbbf616263' AS TEXT)", "CAST(x'eda080' AS TEXT)",
    "CAST(x'efbfbe' AS TEXT)", "CAST(x'efbfbf' AS TEXT)", "CAST(x'c3a9a9' AS TEXT)", "CAST(x'c0af' AS TEXT)",
    "CAST(x'ff' AS TEXT)", "CAST(x'e282' AS TEXT)", "CAST(x'f4908080' AS TEXT)", "CAST(x'61ff62' AS TEXT)",
    "x''", "x'616263'", "x'00'", "x'ff'", "x'4a4f484e'"
];

const NEEDLES = [
    'a', 'A', 'b', 'abc', 'B', 'john', 'EXAMPLE', 'o W', '9', '99', '9999', '-', '+', '.', 'e', 'E', 'e+', 'e-0',
    'inf', 'INF', 'In', 'nf', 'nan', '1.5', '0.0', '-0', '.3333', '3', '1e', '1.0e+20', 'é', 'É', '中', '😀',
    '%', '_', '\\', 'a%', 'a_', ' ', '  padded  ', '�', '￾', '\uD800', 'a\u0000b', '﻿abc'
];

const SEARCH_COLUMNS = ['c0', 'c1', 'c2'];

function prng(seed: number) {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state;
    };
}

function fixtureSql(): string {
    const rows: string[] = [];
    let id = 0;
    for (const value of VALUES) rows.push(`(${++id}, ${value}, NULL, NULL)`);
    const next = prng(20261030);
    for (let i = 0; i < 400; i++) {
        const pick = () => VALUES[next() % VALUES.length];
        rows.push(`(${++id}, ${pick()}, ${pick()}, ${pick()})`);
    }
    // No declared types: every value keeps the storage class it was written with.
    return `CREATE TABLE t (id INTEGER PRIMARY KEY, c0, c1, c2); INSERT INTO t VALUES ${rows.join(', ')};`;
}

function filteredIds(needle: string, likeAny: boolean) {
    return buildSelectQuery('t', {
        columns: ['id'],
        globalFilter: needle,
        globalFilterColumns: SEARCH_COLUMNS,
        orderBy: 'id'
    } as TableQueryOptions, undefined, undefined, { likeAny });
}

async function rows(ops: DatabaseOperations, query: { sql: string; params: CellValue[] }): Promise<CellValue[][]> {
    return (await ops.executeQuery(query.sql, query.params))[0]?.rows ?? [];
}

const REAL_ALPHABET = /^[0-9.+\-eInf]+$/;
const INTEGER_ALPHABET = /^-?[0-9]+$/;

function realLiterals(): string[] {
    const literals = ['0.0', '-0.0', '1e999', '-1e999', '4.9e-324', '-4.9e-324', '2.2250738585072014e-308',
        '1.7976931348623157e308', '-1.7976931348623157e308', '0.1', '1.0 / 3', '9007199254740993.0', '1e15', '1e16',
        '1e17', '123456.789', '1e-5', '1e-4', '0.001'];
    const next = prng(42);
    for (let i = 0; i < 300; i++) {
        const mantissa = (next() / 0x100000000) * (next() % 2 ? 1 : -1);
        const exponent = (next() % 617) - 308;
        literals.push(`${mantissa.toExponential(16)} * 1e${exponent}`);
    }
    return literals;
}

/** The checks every engine must pass; `ops` has its runtime functions prepared. */
async function assertLikeAnyMatchesLike(ops: DatabaseOperations) {
    const typed = await rows(ops, {
        sql: `SELECT ${['NULL', '9', '9.5', "'x'", "x'00'"].map(value => `typeof(${value})`).join(', ')}`,
        params: []
    });
    assert.deepStrictEqual(typed, [['null', 'integer', 'real', 'text', 'blob']]);

    for (const needle of NEEDLES) {
        const expected = await rows(ops, filteredIds(needle, false));
        const actual = await rows(ops, filteredIds(needle, true));
        assert.deepStrictEqual(actual, expected, `needle ${JSON.stringify(needle)}`);
    }

    // The count query carries the same condition.
    for (const needle of ['john', '9', 'É', '�']) {
        const options = { columns: SEARCH_COLUMNS, globalFilter: needle };
        assert.deepStrictEqual(
            await rows(ops, buildCountQuery('t', options, { likeAny: true })),
            await rows(ops, buildCountQuery('t', options, { likeAny: false })),
            `count for ${JSON.stringify(needle)}`
        );
    }

    // LIKE refuses a pattern past SQLITE_LIMIT_LIKE_PATTERN_LENGTH (50000 bytes);
    // the function hands any needle it could exceed to LIKE.
    for (const repeat of [24999, 25000]) {
        const needle = 'a'.repeat(repeat);
        assert.deepStrictEqual(await rows(ops, filteredIds(needle, true)), await rows(ops, filteredIds(needle, false)));
    }
    await assert.rejects(rows(ops, filteredIds('a'.repeat(50000), false)));
    await assert.rejects(rows(ops, filteredIds('a'.repeat(50000), true)));

    // PRAGMA case_sensitive_like replaces LIKE; the constant guard keeps the
    // function out of that connection's filters.
    await ops.executeQuery('PRAGMA case_sensitive_like = 1');
    try {
        const insensitive = await rows(ops, { sql: "SELECT 'a' LIKE 'A'", params: [] });
        assert.deepStrictEqual(insensitive, [[0]]);
        for (const needle of ['ABC', 'abc', 'JOHN', 'inf', 'In']) {
            assert.deepStrictEqual(await rows(ops, filteredIds(needle, true)), await rows(ops, filteredIds(needle, false)), needle);
        }
    } finally {
        await ops.executeQuery('PRAGMA case_sensitive_like = 0');
    }

    // The alphabets the function uses to skip INTEGER and REAL conversion.
    for (const literal of realLiterals()) {
        const [[type, text]] = await rows(ops, { sql: `SELECT typeof(${literal}), CAST(${literal} AS TEXT)`, params: [] });
        assert.strictEqual(type, 'real', literal);
        assert.match(String(text), REAL_ALPHABET, literal);
    }
    for (const literal of ['0', '-1', '9223372036854775807', '-9223372036854775808', '1234567890123456789']) {
        const [[type, text]] = await rows(ops, { sql: `SELECT typeof(${literal}), CAST(${literal} AS TEXT)`, params: [] });
        assert.strictEqual(type, 'integer', literal);
        assert.match(String(text), INTEGER_ALPHABET, literal);
    }
}

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
    if (!platformDir) return undefined;
    const binary = path.join('natives', platformDir, process.platform === 'win32' ? 'tjs.exe' : 'tjs');
    if (expected && !fs.existsSync(binary)) throw new Error(`Missing native runtime ${binary}`);
    return fs.existsSync(binary) ? binary : undefined;
}

const nativeQueries: string[] = [];
const originalNativeCall = NativeWorkerProcess.prototype.call;
(NativeWorkerProcess.prototype as any).call = async function (method: string, args: unknown[] = [], ...rest: unknown[]) {
    if (typeof args[0] === 'string') nativeQueries.push(args[0]);
    return (originalNativeCall as any).call(this, method, args, ...rest);
};
after(() => { NativeWorkerProcess.prototype.call = originalNativeCall; });

const PAGE_OPTIONS = {
    columns: ['rowid', 'c0', 'c1', 'c2'],
    globalFilterColumns: SEARCH_COLUMNS,
    orderBy: null,
    orderDir: 'ASC',
    limit: 5000,
    offset: 0,
    filters: []
} as unknown as TableQueryOptions;

// More columns than one call takes: the condition ORs one COALESCE per chunk
// of 100, each with its own needle and patterns in parameter order.
const WIDE_COLUMNS = Array.from({ length: 150 }, (_, index) => `c${index}`);
function wideFixtureSql(): string {
    const row = (id: number, cells: Record<number, string>) =>
        `(${id}, ${WIDE_COLUMNS.map((_, index) => cells[index] ?? 'NULL').join(', ')})`;
    const rows = [
        row(1, { 120: "'has needle here'" }),
        // Not plain UTF-8, so the second chunk's LIKE decides: it matches 'é'.
        row(2, { 140: "CAST(x'ffc3a9' AS TEXT)", 3: "'x'" }),
        row(3, { 5: "'é'" }),
        row(4, { 0: "'nothing'", 149: "'NEEDLE at the end'" }),
        row(5, { 99: "'needle at 99'", 100: "'e'" }),
        row(6, {})
    ];
    return `CREATE TABLE wide (id INTEGER PRIMARY KEY, ${WIDE_COLUMNS.join(', ')}); INSERT INTO wide VALUES ${rows.join(', ')};`;
}

async function assertWideChunks(ops: DatabaseOperations) {
    await ops.executeQuery(wideFixtureSql());
    for (const needle of ['needle', 'NEEDLE', 'é', 'zzz', 'e']) {
        const query = (likeAny: boolean) => buildSelectQuery('wide', {
            columns: ['id'], globalFilter: needle, globalFilterColumns: WIDE_COLUMNS, orderBy: 'id'
        } as TableQueryOptions, undefined, undefined, { likeAny });
        const sql = query(true).sql;
        assert.strictEqual(sql.split('sqlite_explorer_like_any(').length - 1, 2, 'two chunks');
        assert.deepStrictEqual(await rows(ops, query(true)), await rows(ops, query(false)), `needle ${needle}`);
    }
    const ids = async (needle: string) => (await rows(ops, buildSelectQuery('wide', {
        columns: ['id'], globalFilter: needle, globalFilterColumns: WIDE_COLUMNS, orderBy: 'id'
    } as TableQueryOptions, undefined, undefined, { likeAny: true }))).map(row => row[0]);
    assert.deepStrictEqual(await ids('needle'), [1, 4, 5]);
    assert.deepStrictEqual(await ids('é'), [2, 3]);
}

describe('sqlite_explorer_like_any', () => {
    it('matches the LIKE chain on WebAssembly', async () => {
        const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        try {
            await engine.executeQuery(fixtureSql());
            await assertLikeAnyMatchesLike(engine);
            await assertWideChunks(engine);
        } finally {
            engine.shutdown();
        }
    });

    it('serves WebAssembly table pages and counts with a global filter', async () => {
        const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        const prepared: string[] = [];
        const instance = (engine as unknown as { instance: { prepare(sql: string, ...rest: unknown[]): unknown } }).instance;
        const prepare = instance.prepare.bind(instance);
        instance.prepare = (sql: string, ...rest: unknown[]) => { prepared.push(sql); return prepare(sql, ...rest); };
        try {
            await engine.executeQuery(fixtureSql());
            for (const needle of ['john', '9', 'É']) {
                const expected = await rows(engine, filteredIds(needle, false));
                prepared.length = 0;
                const page = await engine.fetchTableData('t', { ...PAGE_OPTIONS, globalFilter: needle });
                assert.ok(prepared.some(sql => sql.includes('sqlite_explorer_like_any(')), needle);
                assert.deepStrictEqual(page.rows.map(row => [row[0]]), expected, needle);
                const count = await engine.fetchTableCount('t', { columns: SEARCH_COLUMNS, globalFilter: needle });
                assert.strictEqual(count.count, expected.length, needle);
            }
            prepared.length = 0;
            await engine.fetchTableData('t', PAGE_OPTIONS);
            assert.ok(!prepared.some(sql => sql.includes('sqlite_explorer_like_any(')));
        } finally {
            engine.shutdown();
        }
    });

    it('matches the LIKE chain on the native engine and serves its pages and counts', async (context) => {
        if (!bundledNativeBinary()) return context.skip(`no bundled txiki worker for ${process.platform}-${process.arch}`);
        const seed = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        await seed.executeQuery(fixtureSql());
        const image = await seed.serializeDatabase();
        seed.shutdown();
        fs.mkdirSync('.tmp', { recursive: true });
        const directory = fs.mkdtempSync(path.resolve('.tmp/global-filter-like-any-'));
        const file = path.join(directory, 'fixture.db');
        fs.writeFileSync(file, image);
        const logs: string[] = [];
        const outputChannel = { appendLine: (line: string) => { logs.push(line); } } as unknown as vscode.OutputChannel;
        const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()), undefined, outputChannel);
        try {
            const { databaseOps: ops } = await native.establishConnection(vscode.Uri.file(file), 'global-filter-like-any', false);
            // A count with a global filter loads the runtime before any page has.
            nativeQueries.length = 0;
            const firstCount = await ops.fetchTableCount!('t', { columns: SEARCH_COLUMNS, globalFilter: 'john' });
            assert.ok(nativeQueries.some(sql => sql.includes('sqlite_explorer_like_any(')));
            assert.strictEqual(firstCount.count, (await rows(ops, filteredIds('john', false))).length);
            assert.strictEqual(await ops.prepareCellHelpers!(), true);
            await assertLikeAnyMatchesLike(ops);
            await assertWideChunks(ops);
            for (const needle of ['john', '9', 'É']) {
                const expected = await rows(ops, filteredIds(needle, false));
                nativeQueries.length = 0;
                const page = await ops.fetchTableData!('t', { ...PAGE_OPTIONS, globalFilter: needle });
                assert.ok(nativeQueries.some(sql => sql.includes('sqlite_explorer_like_any(')), needle);
                assert.deepStrictEqual(page.rows.map(row => [row[0]]), expected, needle);
            }
            nativeQueries.length = 0;
            await ops.fetchTableCount!('t', { columns: SEARCH_COLUMNS });
            assert.ok(!nativeQueries.some(sql => sql.includes('sqlite_explorer_like_any(')));
            assert.deepStrictEqual(logs.filter(line => /filter function/.test(line)), []);
        } finally {
            native.workerMethods[Symbol.dispose]();
            fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });
});
