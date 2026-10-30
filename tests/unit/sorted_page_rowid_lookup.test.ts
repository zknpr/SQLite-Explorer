import './vscode_mock_setup'; // Must be first

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import * as vscode from 'vscode';

import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { buildSelectQuery } from '../../src/core/query-builder';
import { createNativeDatabaseConnection, NativeWorkerProcess } from '../../src/nativeWorker';
import type { CellValue, DatabaseOperations, KeysetPaginationRequest, QueryResultSet, TableQueryOptions } from '../../src/core/types';

const ROWS = 157;
const PAGE = 10;
const LOOKUP = 'AS "page_keys" CROSS JOIN';

// Sort keys with NULL runs, duplicates across page boundaries, mixed storage
// classes and a NOCASE column, in a rowid table and in an FTS5 table.
function fixtureSql(): string {
    const values: string[] = [];
    for (let id = 1; id <= ROWS; id++) {
        const s = id % 11 === 0 ? 'NULL'
            : id % 7 === 0 ? `${(id % 5) / 4}`
                : id % 3 === 0 ? `'k${id % 4}'`
                    : `${id % 6}`;
        values.push(`(${s}, '${id % 2 ? 'v' : 'V'}${(id * 37) % 23}', ${id % 9 === 0 ? 'NULL' : (id * 13) % 17})`);
    }
    // v's NOCASE ties 'v1' with 'V1': the outer sort must keep the column's collation.
    return `CREATE TABLE t (s, v TEXT COLLATE NOCASE, w INTEGER); INSERT INTO t (s, v, w) VALUES ${values.join(', ')}; ` +
        `CREATE VIRTUAL TABLE ft USING fts5(s, v); INSERT INTO ft (rowid, s, v) SELECT rowid, s, v FROM t;`;
}

interface Sweep {
    table: string;
    columns: string[];
    orderBy: string;
    orderDir: 'ASC' | 'DESC';
    globalFilter?: string;
}

function options(sweep: Sweep, pageIndex: number, keyset?: KeysetPaginationRequest): TableQueryOptions {
    return {
        columns: sweep.columns,
        globalFilterColumns: sweep.columns.slice(1),
        orderBy: sweep.orderBy,
        orderDir: sweep.orderDir,
        limit: PAGE,
        offset: pageIndex * PAGE,
        filters: [],
        ...(sweep.globalFilter ? { globalFilter: sweep.globalFilter } : {}),
        ...(keyset ? { keyset } : {})
    } as TableQueryOptions;
}

/** The display order from the plain page SQL, which reads every row's columns. */
async function expectedPages(ops: DatabaseOperations, sweep: Sweep): Promise<CellValue[][]> {
    const { sql, params } = buildSelectQuery(sweep.table, {
        ...options(sweep, 0),
        orderByColumns: [sweep.orderBy, 'rowid'],
        limit: 100000,
        offset: 0
    } as TableQueryOptions);
    const ids = ((await ops.executeQuery(sql, params))[0]?.rows ?? []).map(row => row[0]);
    const pages: CellValue[][] = [];
    for (let start = 0; start < ids.length; start += PAGE) pages.push(ids.slice(start, start + PAGE));
    return pages;
}

const ids = (page: QueryResultSet) => page.rows.map(row => row[0]);

async function assertSweep(ops: DatabaseOperations, sweep: Sweep) {
    const label = JSON.stringify(sweep);
    const expected = await expectedPages(ops, sweep);
    assert.ok(expected.length > 2, label);
    const fetch = (index: number, keyset?: KeysetPaginationRequest) => ops.fetchTableData!(sweep.table, options(sweep, index, keyset));
    for (let index = 0; index < expected.length; index++) {
        assert.deepStrictEqual(ids(await fetch(index)), expected[index], `${label} OFFSET page ${index}`);
    }
    const anchors: Array<{ first: string; last: string }> = [];
    let page = await fetch(0, { mode: 'first' });
    for (let index = 0; ; index++) {
        assert.deepStrictEqual(ids(page), expected[index], `${label} forward page ${index}`);
        assert.ok(page.keysetAnchors?.first && page.keysetAnchors.last, `${label} anchors ${index}`);
        anchors.push({ first: page.keysetAnchors.first, last: page.keysetAnchors.last });
        if (index === expected.length - 1) break;
        page = await fetch(index + 1, { mode: 'after', anchor: page.keysetAnchors.last });
    }
    const remainder = expected[expected.length - 1].length;
    page = await fetch(expected.length - 1, { mode: 'last', lastPageRowCount: remainder });
    for (let index = expected.length - 1; ; index--) {
        assert.deepStrictEqual(ids(page), expected[index], `${label} backward page ${index}`);
        if (index === 0) break;
        page = await fetch(index - 1, { mode: 'before', anchor: page.keysetAnchors!.first! });
    }
    for (let index = 0; index < expected.length; index++) {
        const refetched = await fetch(index, { mode: 'atOrAfter', anchor: anchors[index].first });
        assert.deepStrictEqual(ids(refetched), expected[index], `${label} atOrAfter page ${index}`);
    }
}

const SWEEPS: Sweep[] = [];
for (const orderBy of ['s', 'v', 'w']) {
    for (const orderDir of ['ASC', 'DESC'] as const) {
        SWEEPS.push({ table: 't', columns: ['rowid', 's', 'v', 'w'], orderBy, orderDir });
    }
}
SWEEPS.push({ table: 't', columns: ['rowid', 's', 'v', 'w'], orderBy: 's', orderDir: 'DESC', globalFilter: '1' });

/** Every sweep, then which page SQL took the rowid lookup. */
async function assertEngine(ops: DatabaseOperations, captured: string[]) {
    for (const sweep of SWEEPS) {
        captured.length = 0;
        await assertSweep(ops, sweep);
        assert.ok(captured.some(sql => sql.includes(LOOKUP)), `${JSON.stringify(sweep)} did not take the rowid lookup`);
    }
    // Rowid order is the table's own order: no lookup.
    captured.length = 0;
    await ops.fetchTableData!('t', { columns: ['rowid', 's'], limit: PAGE, offset: 0, keyset: { mode: 'first' } } as TableQueryOptions);
    assert.ok(captured.length > 0 && !captured.some(sql => sql.includes(LOOKUP)));
    // A virtual table keeps the plain page, with the same rows.
    captured.length = 0;
    const virtualSweep: Sweep = { table: 'ft', columns: ['rowid', 's', 'v'], orderBy: 'v', orderDir: 'DESC' };
    const expected = await expectedPages(ops, virtualSweep);
    const first = await ops.fetchTableData!('ft', options(virtualSweep, 0, { mode: 'first' }));
    assert.deepStrictEqual(ids(first), expected[0]);
    assert.ok(captured.length > 0 && !captured.some(sql => sql.includes(LOOKUP)));
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

const nativeSql: string[] = [];
const originalNativeCall = NativeWorkerProcess.prototype.call;
(NativeWorkerProcess.prototype as any).call = async function (method: string, args: unknown[] = [], ...rest: unknown[]) {
    if (typeof args[0] === 'string') nativeSql.push(args[0]);
    return (originalNativeCall as any).call(this, method, args, ...rest);
};
after(() => { NativeWorkerProcess.prototype.call = originalNativeCall; });

describe('sorted pages through a rowid lookup', () => {
    it('match the plain page SQL on WebAssembly', async () => {
        const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        const prepared: string[] = [];
        const instance = (engine as unknown as { instance: { prepare(sql: string, ...rest: unknown[]): unknown } }).instance;
        const prepare = instance.prepare.bind(instance);
        instance.prepare = (sql: string, ...rest: unknown[]) => { prepared.push(sql); return prepare(sql, ...rest); };
        try {
            await engine.executeQuery(fixtureSql());
            await assertEngine(engine, prepared);
        } finally {
            engine.shutdown();
        }
    });

    it('match the plain page SQL on the native engine', async (context) => {
        if (!bundledNativeBinary()) return context.skip(`no bundled txiki worker for ${process.platform}-${process.arch}`);
        const seed = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        await seed.executeQuery(fixtureSql());
        const image = await seed.serializeDatabase();
        seed.shutdown();
        fs.mkdirSync('.tmp', { recursive: true });
        const directory = fs.mkdtempSync(path.resolve('.tmp/sorted-page-rowid-lookup-'));
        const file = path.join(directory, 'fixture.db');
        fs.writeFileSync(file, image);
        const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
        try {
            const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), 'sorted-page-rowid-lookup', false);
            await assertEngine(databaseOps, nativeSql);
        } finally {
            native.workerMethods[Symbol.dispose]();
            fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });
});
