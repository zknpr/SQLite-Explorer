import './vscode_mock_setup';

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection, isNativeAvailable, NativeWorkerProcess } from '../../src/nativeWorker';
import {
    computeKeysetKey,
    computeKeysetQueryTag,
    encodeKeysetAnchor,
    keysetFallbackOrder,
    primaryKeyCollations,
    resolveKeysetPlan
} from '../../src/core/keyset-pagination';
import { buildSelectQuery } from '../../src/core/query-builder';
import { primaryKeyColumnsFromTableInfo } from '../../src/core/row-identity';
import type {
    DatabaseOperations,
    KeysetPaginationRequest,
    QueryResultSet,
    TableQueryOptions
} from '../../src/core/types';

interface SweepConfig {
    table: string;
    /** Grid-shaped projection: ['rowid', ...visible]. */
    columns: string[];
    orderBy?: string;
    orderDir?: 'ASC' | 'DESC';
    filters?: { column: string; value: string }[];
    pageSize: number;
}

let engine: DatabaseOperations;

function pageOptions(
    cfg: SweepConfig,
    pageIndex: number,
    keyset?: KeysetPaginationRequest,
    limitOverride?: number
): TableQueryOptions {
    return {
        columns: cfg.columns,
        globalFilterColumns: cfg.columns.slice(1),
        orderBy: cfg.orderBy,
        orderDir: cfg.orderDir ?? 'ASC',
        limit: limitOverride ?? cfg.pageSize,
        offset: pageIndex * (limitOverride ?? cfg.pageSize),
        ...(cfg.filters ? { filters: cfg.filters } : {}),
        ...(keyset ? { keyset } : {})
    };
}

function fetchPage(
    cfg: SweepConfig,
    pageIndex: number,
    keyset?: KeysetPaginationRequest
): Promise<QueryResultSet> {
    return engine.fetchTableData(cfg.table, pageOptions(cfg, pageIndex, keyset));
}

function requireAnchors(page: QueryResultSet, label: string): { first: string; last: string } {
    assert.ok(page.keysetAnchors?.first, `${label}: missing first anchor`);
    assert.ok(page.keysetAnchors?.last, `${label}: missing last anchor`);
    return { first: page.keysetAnchors.first, last: page.keysetAnchors.last };
}

/**
 * Drive all five keyset operations across the table and verify each page
 * against `expectedPages` (the authoritative slices of the display order).
 * The pages must also all carry engine-issued anchors.
 */
async function assertKeysetSweep(cfg: SweepConfig, expectedPages: QueryResultSet['rows'][]) {
    const pageCount = expectedPages.length;
    const totalRows = expectedPages.reduce((sum, rows) => sum + rows.length, 0);

    // Forward: first page, then an after-chain to the end (covers the short
    // remainder page arriving through 'after' exactly as OFFSET returns it).
    // Collect each page's own anchors for the refetch leg below.
    const pageAnchors: Array<{ first: string; last: string }> = [];
    let page = await fetchPage(cfg, 0, { mode: 'first' });
    assert.deepEqual(page.rows, expectedPages[0], `${cfg.table}: first page`);
    pageAnchors.push(requireAnchors(page, `${cfg.table}: forward page 0`));
    for (let index = 1; index < pageCount; index++) {
        page = await fetchPage(cfg, index, {
            mode: 'after',
            anchor: pageAnchors[index - 1].last
        });
        assert.deepEqual(page.rows, expectedPages[index], `${cfg.table}: after -> page ${index}`);
        pageAnchors.push(requireAnchors(page, `${cfg.table}: forward page ${index}`));
    }
    // Seeking past the final row yields an empty page.
    const beyond = await fetchPage(cfg, pageCount, {
        mode: 'after',
        anchor: requireAnchors(page, `${cfg.table}: final page`).last
    });
    assert.deepEqual(beyond.rows, [], `${cfg.table}: after final page`);

    // Backward: the reversed 'last' fetch must return the same short remainder
    // page as OFFSET (no phase shift), then a before-chain back to page 0.
    const remainder = totalRows - (pageCount - 1) * cfg.pageSize;
    page = await fetchPage(cfg, pageCount - 1, { mode: 'last', lastPageRowCount: remainder });
    assert.deepEqual(page.rows, expectedPages[pageCount - 1], `${cfg.table}: last page`);
    for (let index = pageCount - 2; index >= 0; index--) {
        const anchors = requireAnchors(page, `${cfg.table}: backward page ${index + 1}`);
        page = await fetchPage(cfg, index, { mode: 'before', anchor: anchors.first });
        assert.deepEqual(page.rows, expectedPages[index], `${cfg.table}: before -> page ${index}`);
    }

    // Refetch-current: every page reproduces itself at-or-after its own first
    // row, from the anchors that page minted (as the webview stores them).
    for (let index = 0; index < pageCount; index++) {
        const refetched = await fetchPage(cfg, index, {
            mode: 'atOrAfter',
            anchor: pageAnchors[index].first
        });
        assert.deepEqual(refetched.rows, expectedPages[index], `${cfg.table}: atOrAfter page ${index}`);
    }
}

/** A key whose BINARY collation is stricter than its NOCASE column, with ties across case twins in g. */
const COLLATED_KEY_TABLE_SQL =
    'CREATE TABLE cased_pk (a TEXT COLLATE NOCASE, g INTEGER, v TEXT, PRIMARY KEY (a COLLATE BINARY)) WITHOUT ROWID; ' +
    "INSERT INTO cased_pk VALUES ('A', 1, 'A'), ('a', 1, 'a'), ('B', 2, 'B'), ('b', 1, 'b'), " +
    "('c', 2, 'c'), ('C', 2, 'C'), ('d', 1, 'd')";

const COLLATED_KEY_SORTS: Array<[Pick<SweepConfig, 'orderBy' | 'orderDir'>, string]> = [
    [{}, 'a COLLATE BINARY ASC'],
    [{ orderBy: 'a', orderDir: 'ASC' }, 'a COLLATE BINARY ASC'],
    [{ orderBy: 'a', orderDir: 'DESC' }, 'a COLLATE BINARY DESC'],
    [{ orderBy: 'g', orderDir: 'ASC' }, 'g ASC, a COLLATE BINARY ASC'],
    [{ orderBy: 'g', orderDir: 'DESC' }, 'g DESC, a COLLATE BINARY DESC']
];

const LAST_PAGE_TABLE_SQL =
    'CREATE TABLE last_page (value TEXT); ' +
    'WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 23) ' +
    "INSERT INTO last_page(value) SELECT 'row-' || n FROM seq";

/**
 * A request as the grid sends it. `pageSize` is the rows per page the grid
 * pages by. `limit` is lower on a final page whose count this load fetched,
 * which Last always does.
 */
function gridRequest(
    pageIndex: number,
    pageSize: number,
    limit: number,
    keyset?: KeysetPaginationRequest
): TableQueryOptions {
    return {
        columns: ['rowid', 'value'],
        globalFilterColumns: ['value'],
        orderDir: 'ASC',
        limit,
        offset: pageIndex * pageSize,
        pageSize,
        ...(keyset ? { keyset } : {})
    } as TableQueryOptions;
}

/**
 * Runs grid requests against LAST_PAGE_TABLE_SQL's 23 rows. `captured`
 * collects the SQL the engine runs, so a step shows whether it sought from
 * its anchor or scanned to its OFFSET.
 */
function lastPageHarness(ops: DatabaseOperations, captured: string[]) {
    const ids = (page: QueryResultSet) => page.rows.map(row => Number(row[0]));
    const run = async (options: TableQueryOptions) => {
        captured.length = 0;
        const page = await ops.fetchTableData!('last_page', options);
        return { page, sql: captured.join('\n') };
    };
    const scansTo = (sql: string, offset: number) => new RegExp(`\\bOFFSET ${offset}\\b`).test(sql);
    const assertSeek = (step: { page: QueryResultSet; sql: string }, offset: number, want: number[], label: string) => {
        assert.deepEqual(ids(step.page), want, `${label}: rows`);
        assert.ok(!scansTo(step.sql, offset), `${label}: scanned to OFFSET ${offset}:\n${step.sql}`);
        assert.ok(/\bOFFSET 0\b/.test(step.sql), `${label}: no seek:\n${step.sql}`);
    };
    const assertScan = (step: { page: QueryResultSet; sql: string }, offset: number, want: number[], label: string) => {
        assert.deepEqual(ids(step.page), want, `${label}: rows`);
        assert.ok(scansTo(step.sql, offset), `${label}: did not fall back to OFFSET ${offset}:\n${step.sql}`);
    };
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
    return { ids, run, assertSeek, assertScan, range };
}

/**
 * Last, then Prev or a refetch of that page, as the grid sends them, must seek
 * from the Last page's anchors instead of scanning to the OFFSET.
 */
async function assertLastPageAnchorsSeek(ops: DatabaseOperations, captured: string[]) {
    const { ids, run, assertSeek, range } = lastPageHarness(ops, captured);

    // 23 rows at 5 a page: Last is page 4 and holds 3 rows.
    // Control: anchors minted under a LIMIT of the full page size seek on
    // every engine version, so a failure below is the bounded LIMIT.
    const unbounded = await run(gridRequest(4, 5, 5, { mode: 'last', lastPageRowCount: 3 }));
    assert.deepEqual(ids(unbounded.page), range(21, 23));
    const unboundedAnchors = requireAnchors(unbounded.page, 'control');
    assertSeek(
        await run(gridRequest(3, 5, 5, { mode: 'before', anchor: unboundedAnchors.first })),
        15, range(16, 20), 'control Prev'
    );

    // Last fetches its count, so its LIMIT is the 3-row remainder.
    const last = await run(gridRequest(4, 5, 3, { mode: 'last', lastPageRowCount: 3 }));
    assert.deepEqual(ids(last.page), range(21, 23));
    const lastAnchors = requireAnchors(last.page, 'Last');
    // Prev and a refetch of the Last page read the count from the cache, so
    // they ask for a full page.
    assertSeek(
        await run(gridRequest(3, 5, 5, { mode: 'before', anchor: lastAnchors.first })),
        15, range(16, 20), 'Last then Prev'
    );
    assertSeek(
        await run(gridRequest(4, 5, 5, { mode: 'atOrAfter', anchor: lastAnchors.first })),
        20, range(21, 23), 'Last then refetch'
    );
    // A clipped cell retries at the bounded LIMIT, from anchors minted either way.
    assertSeek(
        await run(gridRequest(4, 5, 3, { mode: 'atOrAfter', anchor: lastAnchors.first })),
        20, range(21, 23), 'Last then clipped retry'
    );
    assertSeek(
        await run(gridRequest(4, 5, 3, { mode: 'atOrAfter', anchor: unboundedAnchors.first })),
        20, range(21, 23), 'full-LIMIT anchors then clipped retry'
    );
}

/**
 * A column change lowers the page size from 5 to 3, the old Last page's
 * remainder. Anchors minted for pages of 5 must not seek a page of 3.
 */
async function assertOtherPageSizeFallsBack(ops: DatabaseOperations, captured: string[]) {
    const { ids, run, assertScan, range } = lastPageHarness(ops, captured);
    const last = await run(gridRequest(4, 5, 3, { mode: 'last', lastPageRowCount: 3 }));
    assert.deepEqual(ids(last.page), range(21, 23));
    const lastAnchors = requireAnchors(last.page, 'Last');
    // Page 6 of 3 is rows 19-21; seeking from row 21 would show 21-23.
    assertScan(
        await run(gridRequest(6, 3, 3, { mode: 'atOrAfter', anchor: lastAnchors.first })),
        18, range(19, 21), 'old page size refetch'
    );
    // Page 5 of 3 is rows 16-18; seeking before row 21 would show 18-20.
    assertScan(
        await run(gridRequest(5, 3, 3, { mode: 'before', anchor: lastAnchors.first })),
        15, range(16, 18), 'old page size Prev'
    );
}

/**
 * Walk a table the way the webview does and return the `v` label of every
 * row each walk displayed, in display order: Next from 'first' to the end,
 * Prev from 'last' back to the start, and a refetch of every page from the
 * first anchor an OFFSET load minted for it. Callers compare each walk with a
 * raw ORDER BY, so a skipped or repeated row shows up as a label diff.
 */
async function walkKeysetLabels(cfg: SweepConfig, totalRows: number) {
    const pageCount = Math.ceil(totalRows / cfg.pageSize);
    const labelIndex = cfg.columns.indexOf('v');
    const labels = (pages: QueryResultSet[]) => pages.flatMap(page => page.rows.map(row => row[labelIndex]));

    const forward: QueryResultSet[] = [await fetchPage(cfg, 0, { mode: 'first' })];
    for (let index = 1; index < pageCount; index++) {
        const anchor = forward[index - 1].keysetAnchors?.last;
        if (!anchor) break;
        forward.push(await fetchPage(cfg, index, { mode: 'after', anchor }));
    }

    const remainder = totalRows - (pageCount - 1) * cfg.pageSize;
    const backward: QueryResultSet[] = [
        await fetchPage(cfg, pageCount - 1, { mode: 'last', lastPageRowCount: remainder })
    ];
    for (let index = pageCount - 2; index >= 0; index--) {
        const anchor = backward[0].keysetAnchors?.first;
        if (!anchor) break;
        backward.unshift(await fetchPage(cfg, index, { mode: 'before', anchor }));
    }

    const refetched: QueryResultSet[] = [];
    for (const [index, offsetPage] of (await fetchOffsetPages(cfg, pageCount)).entries()) {
        refetched.push(await fetchPage(cfg, index, {
            mode: 'atOrAfter',
            anchor: requireAnchors(offsetPage, `${cfg.table}: offset page ${index}`).first
        }));
    }
    return { forward: labels(forward), backward: labels(backward), refetched: labels(refetched) };
}

async function assertKeysetWalks(cfg: SweepConfig, oracleSql: string, label: string) {
    const oracle = (await engine.executeQuery(oracleSql))[0].rows.map(row => row[0]);
    const walks = await walkKeysetLabels(cfg, oracle.length);
    assert.deepEqual(walks.forward, oracle, `${label}: Next walk`);
    assert.deepEqual(walks.backward, oracle, `${label}: Prev walk`);
    assert.deepEqual(walks.refetched, oracle, `${label}: refetch walk`);
}

/** Production OFFSET pages (no keyset field) — the byte-parity baseline. */
async function fetchOffsetPages(cfg: SweepConfig, pageCount: number) {
    const pages: QueryResultSet[] = [];
    for (let index = 0; index < pageCount; index++) {
        pages.push(await fetchPage(cfg, index));
    }
    return pages;
}

/** Run `body` while collecting the SQL the WASM engine prepares. */
async function withPreparedSql(ops: DatabaseOperations, body: (prepared: string[]) => Promise<void>) {
    const prepared: string[] = [];
    const instance = (ops as unknown as { instance: { prepare(sql: string, ...rest: unknown[]): unknown } }).instance;
    const prepare = instance.prepare;
    instance.prepare = (sql: string, ...rest: unknown[]) => {
        prepared.push(sql);
        return prepare.call(instance, sql, ...rest);
    };
    try {
        await body(prepared);
    } finally {
        instance.prepare = prepare;
    }
}

describe('keyset engine round-trip (WASM)', () => {
    before(async () => {
        const result = await createDatabaseEngine({ content: null, maxSize: 0 });
        engine = result.operations!;
        await engine.executeQuery(LAST_PAGE_TABLE_SQL);
    });
    after(() => {
        (engine as WasmDatabaseEngine).shutdown();
    });

    it('pages a rowid table identically to OFFSET in all five operations', async () => {
        await engine.executeQuery(
            'CREATE TABLE nums (value TEXT); ' +
            'WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 23) ' +
            "INSERT INTO nums(value) SELECT 'row-' || n FROM seq"
        );
        const cfg: SweepConfig = { table: 'nums', columns: ['rowid', 'value'], pageSize: 5 };
        const offsetPages = await fetchOffsetPages(cfg, 5);
        // OFFSET loads re-anchor too: a restored session's first plain load
        // seeds the anchors for its next navigation.
        offsetPages.forEach((page, index) => requireAnchors(page, `nums offset page ${index}`));
        assert.equal(offsetPages[4].rows.length, 3, 'short remainder page expected');
        await assertKeysetSweep(cfg, offsetPages.map(page => page.rows));
    });

    it('keeps keyset active when only oid or _rowid_ is declared, but not when rowid is declared', async () => {
        await engine.executeQuery(
            'CREATE TABLE alias_oid ("oid" TEXT, value TEXT); ' +
            'INSERT INTO alias_oid(rowid, "oid", value) VALUES ' +
            "(2, 'declared-a', 'a'), (9, 'declared-b', 'b'), (15, 'declared-c', 'c'); " +
            'CREATE TABLE alias__rowid_ ("_rowid_" TEXT, value TEXT); ' +
            'INSERT INTO alias__rowid_(rowid, "_rowid_", value) VALUES ' +
            "(3, 'declared-a', 'a'), (8, 'declared-b', 'b'), (20, 'declared-c', 'c'); " +
            'CREATE TABLE alias_rowid ("rowid" TEXT, value TEXT); ' +
            'INSERT INTO alias_rowid("rowid", value) VALUES ' +
            "('declared-a', 'a'), ('declared-b', 'b'), ('declared-c', 'c')"
        );

        for (const [table, declaredAlias] of [
            ['alias_oid', 'oid'],
            ['alias__rowid_', '_rowid_']
        ] as const) {
            const cfg: SweepConfig = {
                table,
                columns: ['rowid', declaredAlias, 'value'],
                pageSize: 2
            };
            const first = await fetchPage(cfg, 0, { mode: 'first' });
            const anchors = requireAnchors(first, table);
            const second = await fetchPage(cfg, 1, { mode: 'after', anchor: anchors.last });
            assert.deepEqual(second.rows, (await fetchPage(cfg, 1)).rows);
        }

        const shadowed = await fetchPage(
            { table: 'alias_rowid', columns: ['rowid', 'value'], pageSize: 2 },
            0,
            { mode: 'first' }
        );
        assert.strictEqual(shadowed.keysetAnchors, undefined);
    });

    it('pages WITHOUT ROWID and composite-PK tables through pk: identities', async () => {
        await engine.executeQuery(
            'CREATE TABLE wr_single (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID; ' +
            'WITH RECURSIVE seq(n) AS (SELECT 10 UNION ALL SELECT n + 1 FROM seq WHERE n < 20) ' +
            "INSERT INTO wr_single SELECT 'k' || n, 'v' || n FROM seq"
        );
        const single: SweepConfig = { table: 'wr_single', columns: ['rowid', 'k', 'v'], pageSize: 4 };
        const singlePages = await fetchOffsetPages(single, 3);
        assert.match(String(singlePages[0].rows[0][0]), /^pk:/);
        await assertKeysetSweep(single, singlePages.map(page => page.rows));

        await engine.executeQuery(
            'CREATE TABLE wr_comp (tenant TEXT, seq INTEGER, v TEXT, ' +
            'PRIMARY KEY (tenant, seq)) WITHOUT ROWID; ' +
            'WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 13) ' +
            "INSERT INTO wr_comp SELECT CASE WHEN n % 2 THEN 'north' ELSE 'south' END, n, 'v' || n FROM s"
        );
        const comp: SweepConfig = { table: 'wr_comp', columns: ['rowid', 'tenant', 'seq', 'v'], pageSize: 4 };
        const compPages = await fetchOffsetPages(comp, 4);
        assert.equal(compPages[3].rows.length, 1, 'short remainder page expected');
        await assertKeysetSweep(comp, compPages.map(page => page.rows));
    });

    it('pages NULL runs spanning page boundaries correctly in both sort directions', async () => {
        // s: five NULLs, four 'a', two 'b', one 'c' (12 rows, pages of 4).
        // ASC crosses the NULL run at page 0/1 and the 'a' run at page 1/2;
        // DESC crosses NULL at the other end. Insertion order interleaves the
        // runs so the rowid tiebreak actually decides within equal values.
        await engine.executeQuery(
            'CREATE TABLE sorted_nulls (s TEXT, v TEXT); ' +
            'INSERT INTO sorted_nulls(s, v) VALUES ' +
            "(NULL,'n1'),('a','a1'),(NULL,'n2'),('b','b1'),('a','a2'),(NULL,'n3')," +
            "('c','c1'),(NULL,'n4'),('a','a3'),('b','b2'),(NULL,'n5'),('a','a4')"
        );
        for (const orderDir of ['ASC', 'DESC'] as const) {
            const cfg: SweepConfig = {
                table: 'sorted_nulls',
                columns: ['rowid', 's', 'v'],
                orderBy: 's',
                orderDir,
                pageSize: 4
            };
            // Sorted-with-duplicates baseline: the OFFSET fallback of an
            // anchorable query adopts the exact keyset (sort, identity) ORDER
            // BY, so production OFFSET pages ARE the reference — hard byte
            // equality on every leg, including DESC through the duplicate and
            // NULL runs (previously an "accepted delta").
            const offsetPages = await fetchOffsetPages(cfg, 3);
            const allRows = offsetPages.flatMap(page => page.rows);
            assert.equal(allRows.length, 12);
            const sortValues = allRows.map(row => row[1]);
            const nullRun = sortValues.map(value => value === null ? 'N' : 'x').join('');
            assert.equal(nullRun, orderDir === 'ASC' ? 'NNNNNxxxxxxx' : 'xxxxxxxNNNNN');
            await assertKeysetSweep(cfg, offsetPages.map(page => page.rows));
        }
    });

    it('carries int64 identities beyond 2^53 through anchors exactly', async () => {
        await engine.executeQuery(
            'CREATE TABLE big_ids (value TEXT); ' +
            'INSERT INTO big_ids(rowid, value) VALUES ' +
            "(1,'small'), (5,'five'), (9007199254740991,'safe-max')," +
            "(9007199254740992,'edge'), (9007199254740993,'unsafe')," +
            "(9223372036854775806,'huge'), (9223372036854775807,'int64-max')"
        );
        const cfg: SweepConfig = { table: 'big_ids', columns: ['rowid', 'value'], pageSize: 3 };
        const offsetPages = await fetchOffsetPages(cfg, 3);
        // Adjacent unsafe rowids must stay distinct across the page boundary;
        // 2^53 - 1 itself is still safe and travels as a number.
        assert.deepEqual(
            offsetPages.flatMap(page => page.rows.map(row => row[0])).slice(2),
            [9007199254740991, '9007199254740992', '9007199254740993',
             '9223372036854775806', '9223372036854775807']
        );
        await assertKeysetSweep(cfg, offsetPages.map(page => page.rows));
    });

    it('pages BLOB primary keys and REAL sort columns', async () => {
        await engine.executeQuery(
            'CREATE TABLE blob_pk (k BLOB PRIMARY KEY, v TEXT) WITHOUT ROWID; ' +
            "INSERT INTO blob_pk VALUES (x'00','a'), (x'0001','b'), (x'01','c'), (x'0100','d'), (x'ff','e')"
        );
        const blobCfg: SweepConfig = { table: 'blob_pk', columns: ['rowid', 'k', 'v'], pageSize: 2 };
        const blobPages = await fetchOffsetPages(blobCfg, 3);
        await assertKeysetSweep(blobCfg, blobPages.map(page => page.rows));

        await engine.executeQuery(
            'CREATE TABLE real_sort (s REAL, v TEXT); ' +
            'INSERT INTO real_sort(s, v) VALUES ' +
            "(1.5,'a'), (1.5,'b'), (-0.25,'c'), (9.652937795298495e282,'d')," +
            "(0.1,'e'), (0.1,'f'), (2,'g')"
        );
        for (const orderDir of ['ASC', 'DESC'] as const) {
            const realCfg: SweepConfig = {
                table: 'real_sort',
                columns: ['rowid', 's', 'v'],
                orderBy: 's',
                orderDir,
                pageSize: 3
            };
            const offsetPages = await fetchOffsetPages(realCfg, 3);
            await assertKeysetSweep(realCfg, offsetPages.map(page => page.rows));
        }
    });

    it('pages sorted WITHOUT ROWID tables identically to OFFSET through duplicates and NULLs', async () => {
        await engine.executeQuery(
            'CREATE TABLE wr_nulls (tenant TEXT, seq INTEGER, s TEXT, ' +
            'PRIMARY KEY (tenant, seq)) WITHOUT ROWID; ' +
            'WITH RECURSIVE q(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM q WHERE n < 14) ' +
            "INSERT INTO wr_nulls SELECT CASE WHEN n % 2 THEN 'north' ELSE 'south' END, n, " +
            "CASE WHEN n % 4 = 0 THEN NULL ELSE 'dup-' || (n % 2) END FROM q"
        );
        for (const orderDir of ['ASC', 'DESC'] as const) {
            const cfg: SweepConfig = {
                table: 'wr_nulls',
                columns: ['rowid', 'tenant', 'seq', 's'],
                orderBy: 's',
                orderDir,
                pageSize: 4
            };
            const offsetPages = await fetchOffsetPages(cfg, 4);
            assert.equal(offsetPages[3].rows.length, 2, 'short remainder page expected');
            await assertKeysetSweep(cfg, offsetPages.map(page => page.rows));
        }
    });

    it('interleaves OFFSET and keyset pages in one total order under duplicate sort values', async () => {
        // Heavy duplicate sort values with interleaved insertion so the
        // identity tiebreak decides inside every tie run. Covers both SQLite
        // plans whose tie orders used to disagree: the unindexed sorter
        // (stable — identity-ASC even for DESC) and the index scan
        // (identity-DESC for DESC). The grid treats OFFSET and keyset pages
        // as one phase-continuous sequence, so an OFFSET page's anchors must
        // seek in exactly the order the OFFSET page was produced in.
        await engine.executeQuery(
            'CREATE TABLE mixed_ties (s TEXT, v TEXT); ' +
            'WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 24) ' +
            "INSERT INTO mixed_ties(s, v) SELECT 'dup-' || (n % 3), 'v' || n FROM seq"
        );
        for (const indexed of [false, true]) {
            if (indexed) {
                await engine.executeQuery('CREATE INDEX idx_mixed_ties_s ON mixed_ties(s)');
            }
            const sorts: Array<Pick<SweepConfig, 'orderBy' | 'orderDir'>> = [
                { orderBy: 's', orderDir: 'DESC' },
                { orderBy: 's', orderDir: 'ASC' },
                {} // unsorted: scan order vs the explicit identity-ASC order
            ];
            for (const sort of sorts) {
                const label = `${indexed ? 'indexed' : 'unindexed'} ${sort.orderDir ?? 'unsorted'}`;
                const cfg: SweepConfig = {
                    table: 'mixed_ties',
                    columns: ['rowid', 's', 'v'],
                    ...sort,
                    pageSize: 5
                };
                const offsetPages = await fetchOffsetPages(cfg, 5);
                const pure = offsetPages.flatMap(page => page.rows);
                assert.equal(pure.length, 24, `${label}: baseline row count`);
                // Mixed session: page 1 arrived via plain OFFSET (fallback),
                // its anchors were minted, then the user hits Next (keyset).
                // The concatenation must equal the pure OFFSET sequence with
                // no row skipped and none repeated.
                const anchors = requireAnchors(offsetPages[1], `${label}: offset page 1`);
                const nextPage = await fetchPage(cfg, 2, { mode: 'after', anchor: anchors.last });
                assert.deepEqual(
                    [...offsetPages[0].rows, ...offsetPages[1].rows, ...nextPage.rows],
                    pure.slice(0, 15),
                    `${label}: OFFSET pages then keyset Next diverged`
                );
                // And Prev from the same OFFSET page's first anchor.
                const prevPage = await fetchPage(cfg, 0, { mode: 'before', anchor: anchors.first });
                assert.deepEqual(
                    prevPage.rows,
                    offsetPages[0].rows,
                    `${label}: OFFSET page then keyset Prev diverged`
                );
            }
        }
    });

    it('seeks int64 anchor values beyond 2^53 exactly on NONE-affinity sort columns', async () => {
        // CREATE TABLE none_affinity(x, ...): x carries NO affinity, so an
        // anchor value decoded to a decimal string and bound as TEXT never
        // compares equal-class with INTEGER storage. 'after' returned an
        // empty page (healed by the grid retry); 'before' returned a
        // full-length WRONG page that passed the retry check and committed
        // silently. The +CAST(? AS INTEGER) predicate restores exact int64
        // seeks for values the decoder range-checked into int64.
        await engine.executeQuery(
            'CREATE TABLE none_affinity (x, v TEXT); ' +
            'INSERT INTO none_affinity(x, v) VALUES ' +
            "(9007199254740992, 'a'), (9007199254740993, 'b'), (9007199254740995, 'c'), " +
            "(2, 'small'), (9007199254740997, 'd'), (12, 'safe')"
        );
        for (const orderDir of ['ASC', 'DESC'] as const) {
            const cfg: SweepConfig = {
                table: 'none_affinity',
                columns: ['rowid', 'x', 'v'],
                orderBy: 'x',
                orderDir,
                pageSize: 2
            };
            const offsetPages = await fetchOffsetPages(cfg, 3);
            await assertKeysetSweep(cfg, offsetPages.map(page => page.rows));
        }
    });

    // INTEGER 1..100, then 50 TEXT values, then TEXT 'z000'..'z199'. ORDER BY
    // puts every INTEGER before every TEXT; with numericText the 50 TEXT
    // values are '1'..'50', which a comparison under NUMERIC affinity would
    // read as the numbers 1..50.
    const mixedSortRows = (table: string, numericText: boolean) =>
        'WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 100) ' +
        `INSERT INTO ${table}(c, v) SELECT n, 'int-' || n FROM s; ` +
        'WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 50) ' +
        `INSERT INTO ${table}(c, v) SELECT ${numericText ? 'CAST(n AS TEXT)' : "'n' || n"}, 'text-' || n FROM s; ` +
        'WITH RECURSIVE s(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM s WHERE n < 199) ' +
        `INSERT INTO ${table}(c, v) SELECT printf('z%03d', n), 'z-' || n FROM s`;

    it('seeks INTEGER anchors past numeric-looking TEXT on typeless, BLOB and STRICT ANY sort columns', async () => {
        // None of these columns has a numeric affinity, so ORDER BY and a
        // correct seek both keep TEXT '7' after every INTEGER. Page size 100
        // is where it showed (Next from INTEGER 100 skipped all 50 TEXT
        // rows); page size 40 also puts INTEGER anchors at 40/41 and 80/81,
        // with numeric TEXT on both sides of the anchor value.
        for (const [table, ddl] of [
            ['mixed_typeless', 'CREATE TABLE mixed_typeless (c, v TEXT)'],
            ['mixed_blob', 'CREATE TABLE mixed_blob (c BLOB, v TEXT)'],
            ['mixed_any', 'CREATE TABLE mixed_any (c ANY, v TEXT) STRICT']
        ] as const) {
            await engine.executeQuery(`${ddl}; ${mixedSortRows(table, true)}`);
            assert.deepEqual(
                (await engine.executeQuery(
                    `SELECT typeof(c), count(*) FROM ${table} GROUP BY 1 ORDER BY 1`
                ))[0].rows,
                [['integer', 100], ['text', 250]],
                `${table}: the numeric-looking TEXT must stay TEXT`
            );
            for (const pageSize of [100, 40]) {
                for (const orderDir of ['ASC', 'DESC'] as const) {
                    await assertKeysetWalks(
                        { table, columns: ['rowid', 'c', 'v'], orderBy: 'c', orderDir, pageSize },
                        `SELECT v FROM ${table} ORDER BY c ${orderDir}, rowid ${orderDir}`,
                        `${table} ${orderDir} page size ${pageSize}`
                    );
                }
            }
        }
    });

    it('seeks INTEGER anchors on a typeless sort column whose TEXT is not numeric (control)', async () => {
        await engine.executeQuery(
            `CREATE TABLE mixed_control (c, v TEXT); ${mixedSortRows('mixed_control', false)}`
        );
        for (const pageSize of [100, 40]) {
            for (const orderDir of ['ASC', 'DESC'] as const) {
                await assertKeysetWalks(
                    { table: 'mixed_control', columns: ['rowid', 'c', 'v'], orderBy: 'c', orderDir, pageSize },
                    `SELECT v FROM mixed_control ORDER BY c ${orderDir}, rowid ${orderDir}`,
                    `mixed_control ${orderDir} page size ${pageSize}`
                );
            }
        }
    });

    it('seeks INTEGER anchors on INTEGER and NUMERIC sort columns holding REAL, TEXT and NULL', async () => {
        // A numeric-affinity column converts numeric TEXT on write, so what
        // stays TEXT is non-numeric, and its comparisons with an INTEGER
        // anchor are NUMERIC however the anchor is written.
        for (const type of ['INTEGER', 'NUMERIC']) {
            const table = `typed_${type.toLowerCase()}`;
            await engine.executeQuery(
                `CREATE TABLE ${table} (c ${type}, v TEXT); ` +
                'WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 60) ' +
                `INSERT INTO ${table}(c, v) SELECT CASE n % 6 ` +
                "WHEN 0 THEN n + 0.5 WHEN 1 THEN 'n' || n WHEN 2 THEN NULL ELSE n % 9 END, 'row-' || n FROM s"
            );
            assert.deepEqual(
                (await engine.executeQuery(
                    `SELECT typeof(c), count(*) FROM ${table} GROUP BY 1 ORDER BY 1`
                ))[0].rows,
                [['integer', 30], ['null', 10], ['real', 10], ['text', 10]]
            );
            for (const orderDir of ['ASC', 'DESC'] as const) {
                await assertKeysetWalks(
                    { table, columns: ['rowid', 'c', 'v'], orderBy: 'c', orderDir, pageSize: 7 },
                    `SELECT v FROM ${table} ORDER BY c ${orderDir}, rowid ${orderDir}`,
                    `${table} ${orderDir}`
                );
            }
        }
    });

    it('pages a typeless WITHOUT ROWID key holding INTEGER and numeric-looking TEXT', async () => {
        for (const [table, ddl] of [
            ['typeless_pk', 'CREATE TABLE typeless_pk (k PRIMARY KEY, v TEXT) WITHOUT ROWID'],
            ['any_pk', 'CREATE TABLE any_pk (k ANY PRIMARY KEY, v TEXT) STRICT, WITHOUT ROWID']
        ] as const) {
            await engine.executeQuery(
                `${ddl}; ` +
                'WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 30) ' +
                `INSERT INTO ${table}(k, v) SELECT n, 'int-' || n FROM s ` +
                "UNION ALL SELECT CAST(n AS TEXT), 'text-' || n FROM s " +
                "UNION ALL SELECT printf('k%02d', n), 'k-' || n FROM s WHERE n <= 10"
            );
            const sorts: Array<[Pick<SweepConfig, 'orderBy' | 'orderDir'>, string]> = [
                [{}, 'k ASC'],
                [{ orderBy: 'k', orderDir: 'ASC' }, 'k ASC'],
                [{ orderBy: 'k', orderDir: 'DESC' }, 'k DESC']
            ];
            for (const [sort, oracleOrder] of sorts) {
                await assertKeysetWalks(
                    { table, columns: ['rowid', 'k', 'v'], ...sort, pageSize: 7 },
                    `SELECT v FROM ${table} ORDER BY ${oracleOrder}`,
                    `${table} ${sort.orderDir ?? 'unsorted'}`
                );
            }
        }
    });

    it('pages a WITHOUT ROWID key whose collation is stricter than its column', async () => {
        // 'A' and 'a' are distinct keys under the key's BINARY collation and
        // equal under the column's NOCASE. Ordering and seeking by the column
        // collation left their order open and a seek past one skipped the other.
        await engine.executeQuery(COLLATED_KEY_TABLE_SQL);
        for (const [sort, oracleOrder] of COLLATED_KEY_SORTS) {
            for (const pageSize of [1, 2, 3]) {
                const cfg: SweepConfig = { table: 'cased_pk', columns: ['rowid', 'a', 'g', 'v'], ...sort, pageSize };
                const label = `cased_pk ${sort.orderBy ?? 'unsorted'} ${sort.orderDir ?? ''} by ${pageSize}`;
                const oracleSql = `SELECT v FROM cased_pk ORDER BY ${oracleOrder}`;
                await assertKeysetWalks(cfg, oracleSql, label);
                const oracle = (await engine.executeQuery(oracleSql))[0].rows.map(row => row[0]);
                const offsetPages = await fetchOffsetPages(cfg, Math.ceil(oracle.length / pageSize));
                assert.deepEqual(offsetPages.flatMap(page => page.rows.map(row => row[3])), oracle, `${label}: OFFSET pages`);
                // A Next from an OFFSET page continues the same order.
                const next = await fetchPage(cfg, 2, {
                    mode: 'after',
                    anchor: requireAnchors(offsetPages[1], `${label}: offset page 1`).last
                });
                assert.deepEqual(next.rows, offsetPages[2].rows, `${label}: after an OFFSET page`);
            }
        }
    });

    it('composes keyset paging with active filters', async () => {
        await engine.executeQuery(
            'CREATE TABLE filtered (v TEXT); ' +
            'WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 30) ' +
            "INSERT INTO filtered(v) SELECT CASE WHEN n % 3 THEN 'skip-' || n ELSE 'needle-' || n END FROM seq"
        );
        const cfg: SweepConfig = {
            table: 'filtered',
            columns: ['rowid', 'v'],
            filters: [{ column: 'v', value: 'needle' }],
            pageSize: 4
        };
        const offsetPages = await fetchOffsetPages(cfg, 3);
        assert.equal(offsetPages.flatMap(page => page.rows).length, 10);
        await assertKeysetSweep(cfg, offsetPages.map(page => page.rows));
    });

    it('handles single-page and empty tables', async () => {
        await engine.executeQuery(
            "CREATE TABLE tiny (v TEXT); INSERT INTO tiny(v) VALUES ('a'), ('b'), ('c')"
        );
        const cfg: SweepConfig = { table: 'tiny', columns: ['rowid', 'v'], pageSize: 10 };
        const offsetPage = await fetchPage(cfg, 0);
        await assertKeysetSweep(cfg, [offsetPage.rows]);

        await engine.executeQuery('CREATE TABLE hollow (v TEXT)');
        const emptyCfg: SweepConfig = { table: 'hollow', columns: ['rowid', 'v'], pageSize: 10 };
        const empty = await fetchPage(emptyCfg, 0, { mode: 'first' });
        assert.deepEqual(empty.rows, []);
        assert.equal(empty.keysetAnchors, undefined);
    });

    it('falls back to the OFFSET result on a query-identity tag mismatch', async () => {
        await engine.executeQuery(
            'CREATE TABLE tag_drift (v TEXT); ' +
            'WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 12) ' +
            "INSERT INTO tag_drift(v) SELECT 'r' || n FROM seq"
        );
        const sortedCfg: SweepConfig = {
            table: 'tag_drift', columns: ['rowid', 'v'], orderBy: 'v', pageSize: 4
        };
        const sortedPage = await fetchPage(sortedCfg, 0, { mode: 'first' });
        const staleAnchor = requireAnchors(sortedPage, 'tag_drift sorted').last;

        // Same anchor replayed after the sort was cleared: the engine must
        // ignore it and serve exactly the OFFSET page for the request, while
        // still re-anchoring for the new query identity.
        const unsortedCfg: SweepConfig = { table: 'tag_drift', columns: ['rowid', 'v'], pageSize: 4 };
        const offsetPage1 = await fetchPage(unsortedCfg, 1);
        const fallback = await fetchPage(unsortedCfg, 1, { mode: 'after', anchor: staleAnchor });
        assert.deepEqual(fallback.rows, offsetPage1.rows);
        requireAnchors(fallback, 'tag_drift fallback');
    });

    it('seeks from a Last page bounded to its remainder', async () => {
        await withPreparedSql(engine, prepared => assertLastPageAnchorsSeek(engine, prepared));
    });

    it('does not seek from anchors minted under another page size', async () => {
        await withPreparedSql(engine, prepared => assertOtherPageSizeFallsBack(engine, prepared));
    });

    it('rejects hostile anchors loudly', async () => {
        await engine.executeQuery(
            "CREATE TABLE hostile (v TEXT); INSERT INTO hostile(v) VALUES ('a'), ('b')"
        );
        const cfg: SweepConfig = { table: 'hostile', columns: ['rowid', 'v'], pageSize: 1 };
        await assert.rejects(
            fetchPage(cfg, 1, { mode: 'after', anchor: 'ksa:garbage' }),
            /keyset anchor/i
        );
        // A structurally valid token forging NULL into the identity slot can
        // never be minted; matching tag makes it reach the shape validation.
        const forged = encodeKeysetAnchor(
            computeKeysetQueryTag('hostile', pageOptions(cfg, 1)),
            [null]
        );
        await assert.rejects(
            fetchPage(cfg, 1, { mode: 'after', anchor: forged }),
            /NULL in an identity slot/
        );
    });

    it('seeks without a table-order sort step (EXPLAIN QUERY PLAN)', async () => {
        await engine.executeQuery(
            'CREATE TABLE eqp_rowid (v TEXT); ' +
            'CREATE TABLE eqp_comp (a TEXT, b INTEGER, v TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID; ' +
            'CREATE TABLE eqp_typeless_pk (k PRIMARY KEY, v TEXT) WITHOUT ROWID'
        );
        const explain = async (table: string, options: TableQueryOptions, identity: Parameters<typeof resolveKeysetPlan>[2]) => {
            const plan = resolveKeysetPlan(table, options, identity);
            assert.ok(plan, 'plan must resolve');
            const { sql, params } = buildSelectQuery(table, options, plan);
            const rows = (await engine.executeQuery(`EXPLAIN QUERY PLAN ${sql}`, params))[0].rows;
            return rows.map(row => String(row[3])).join('\n');
        };
        const rowidIdentity = { kind: 'rowid' } as const;
        const compIdentity = {
            kind: 'primaryKey' as const,
            columns: [
                { identifier: 'a', declaredType: 'TEXT', position: 1 },
                { identifier: 'b', declaredType: 'INTEGER', position: 2 }
            ]
        };
        const anchorRowid = encodeKeysetAnchor(
            computeKeysetQueryTag('eqp_rowid', { columns: ['rowid', 'v'], limit: 5, orderDir: 'ASC' }),
            [100n]
        );
        const anchorComp = encodeKeysetAnchor(
            computeKeysetQueryTag('eqp_comp', { columns: ['rowid', 'a', 'b', 'v'], limit: 5, orderDir: 'ASC' }),
            ['x', 7n]
        );
        const typelessIdentity = {
            kind: 'primaryKey' as const,
            columns: [{ identifier: 'k', declaredType: '', position: 1 }]
        };
        const anchorTypeless = encodeKeysetAnchor(
            computeKeysetQueryTag('eqp_typeless_pk', { columns: ['rowid', 'k', 'v'], limit: 5, orderDir: 'ASC' }),
            [7n]
        );

        // Forward seeks and 'first' must not sort the table at all.
        const forwardCases: Array<[string, TableQueryOptions, typeof rowidIdentity | typeof compIdentity]> = [
            ['eqp_rowid', { columns: ['rowid', 'v'], limit: 5, orderDir: 'ASC', keyset: { mode: 'first' } }, rowidIdentity],
            ['eqp_rowid', { columns: ['rowid', 'v'], limit: 5, orderDir: 'ASC', keyset: { mode: 'after', anchor: anchorRowid } }, rowidIdentity],
            ['eqp_comp', { columns: ['rowid', 'a', 'b', 'v'], limit: 5, orderDir: 'ASC', keyset: { mode: 'first' } }, compIdentity],
            ['eqp_comp', { columns: ['rowid', 'a', 'b', 'v'], limit: 5, orderDir: 'ASC', keyset: { mode: 'after', anchor: anchorComp } }, compIdentity],
            // A typeless key has BLOB affinity; the anchor comparison must
            // not apply a numeric affinity, which would also bar the index.
            ['eqp_typeless_pk', { columns: ['rowid', 'k', 'v'], limit: 5, orderDir: 'ASC', keyset: { mode: 'after', anchor: anchorTypeless } }, typelessIdentity]
        ];
        for (const [table, options, identity] of forwardCases) {
            const detail = await explain(table, options, identity);
            assert.ok(!detail.includes('TEMP B-TREE'), `unexpected sort step:\n${detail}`);
            if (options.keyset?.mode === 'after') {
                // The +CAST(? AS INTEGER) anchor binding must not defeat the
                // B-tree seek on the rowid / declared primary key.
                assert.ok(detail.includes('SEARCH'), `expected an index seek:\n${detail}`);
            }
        }

        // Reversed executions ('before'/'last') seek or reverse-scan the table
        // and may re-sort only the bounded page in the outer wrapper.
        const beforeDetail = await explain(
            'eqp_rowid',
            { columns: ['rowid', 'v'], limit: 5, orderDir: 'ASC', keyset: { mode: 'before', anchor: anchorRowid } },
            rowidIdentity
        );
        assert.ok(beforeDetail.includes('SEARCH'), `expected an index seek:\n${beforeDetail}`);
        assert.ok(
            beforeDetail.split('TEMP B-TREE').length - 1 <= 1,
            `more than the bounded outer sort:\n${beforeDetail}`
        );
        const lastDetail = await explain(
            'eqp_comp',
            { columns: ['rowid', 'a', 'b', 'v'], limit: 5, orderDir: 'ASC', keyset: { mode: 'last', lastPageRowCount: 3 } },
            compIdentity
        );
        assert.ok(
            lastDetail.split('TEMP B-TREE').length - 1 <= 1,
            `more than the bounded outer sort:\n${lastDetail}`
        );
    });

    it('keeps key-collation pages on the key index (EXPLAIN QUERY PLAN)', async () => {
        // The key collation must not cost the seek: on the anchor value it
        // keeps a row-value comparison on the index, and the ORDER BY matches
        // the index, also where it differs from the column's collation.
        await engine.executeQuery(
            'CREATE TABLE eqp_cased (a TEXT COLLATE NOCASE, b INTEGER, v TEXT, PRIMARY KEY (a COLLATE BINARY, b)) WITHOUT ROWID; ' +
            'CREATE TABLE eqp_nocase (k TEXT COLLATE NOCASE PRIMARY KEY, v TEXT) WITHOUT ROWID'
        );
        for (const [table, columns, anchorValues] of [
            ['eqp_cased', ['rowid', 'a', 'b', 'v'], ['x', 7n]],
            ['eqp_nocase', ['rowid', 'k', 'v'], ['x']]
        ] as const) {
            const identity = {
                kind: 'primaryKey' as const,
                columns: primaryKeyColumnsFromTableInfo(await engine.getTableInfo(table))
            };
            assert.ok(identity.columns.every(column => column.collation), `${table}: key collations`);
            const explain = async (options: TableQueryOptions) => {
                const plan = resolveKeysetPlan(table, options, identity);
                const key = computeKeysetKey(options, identity);
                const fallback = plan ? undefined : keysetFallbackOrder(key, undefined);
                const { sql, params } = buildSelectQuery(
                    table,
                    fallback ? { ...options, orderBy: undefined, ...fallback } : options,
                    plan,
                    undefined,
                    { keyCollations: primaryKeyCollations(identity) }
                );
                const rows = (await engine.executeQuery(`EXPLAIN QUERY PLAN ${sql}`, params))[0].rows;
                return rows.map(row => String(row[3])).join('\n');
            };
            const base = { columns: [...columns], limit: 5, orderDir: 'ASC' as const };
            const anchor = encodeKeysetAnchor(computeKeysetQueryTag(table, base), [...anchorValues]);
            for (const options of [
                { ...base, keyset: { mode: 'first' as const } },
                { ...base, keyset: { mode: 'after' as const, anchor } },
                { ...base, offset: 500 }
            ]) {
                const detail = await explain(options);
                assert.ok(!detail.includes('TEMP B-TREE'), `${table}: unexpected sort step:\n${detail}`);
                if ('keyset' in options && options.keyset.mode === 'after') {
                    assert.ok(/^SEARCH (main\.)?\w+ USING PRIMARY KEY/m.test(detail), `${table}: expected a seek:\n${detail}`);
                }
            }
            const beforeDetail = await explain({ ...base, keyset: { mode: 'before', anchor } });
            assert.ok(/^SEARCH (main\.)?\w+ USING PRIMARY KEY/m.test(beforeDetail), `${table}: expected a seek:\n${beforeDetail}`);
            assert.ok(beforeDetail.split('TEMP B-TREE').length - 1 <= 1, `${table}: more than the bounded outer sort:\n${beforeDetail}`);
        }
    });

    it('keeps OFFSET fallback ordering on the index in both directions (EXPLAIN QUERY PLAN)', async () => {
        await engine.executeQuery(
            'CREATE TABLE eqp_fallback (s TEXT, v TEXT); ' +
            'CREATE INDEX idx_eqp_fallback_s ON eqp_fallback(s)'
        );
        const explainFallback = async (options: TableQueryOptions) => {
            const key = computeKeysetKey(options, { kind: 'rowid' });
            assert.ok(key, 'keyset key must derive');
            const order = keysetFallbackOrder(key, undefined);
            assert.ok(order, 'fallback order must apply');
            const { sql, params } = buildSelectQuery(
                'eqp_fallback',
                { ...options, orderBy: undefined, ...order }
            );
            const rows = (await engine.executeQuery(`EXPLAIN QUERY PLAN ${sql}`, params))[0].rows;
            return rows.map(row => String(row[3])).join('\n');
        };
        // Indexed sort column: the deterministic tiebreak matches the index's
        // implicit rowid suffix, so both directions stay on the index (DESC
        // is a backward scan) with no sorter step.
        for (const orderDir of ['ASC', 'DESC'] as const) {
            const detail = await explainFallback({
                columns: ['rowid', 's', 'v'],
                orderBy: 's',
                orderDir,
                limit: 5,
                offset: 500
            });
            assert.ok(
                detail.includes('USING INDEX idx_eqp_fallback_s'),
                `expected the sort-column index (${orderDir}):\n${detail}`
            );
            assert.ok(!detail.includes('TEMP B-TREE'), `unexpected sort step (${orderDir}):\n${detail}`);
        }
        // Unsorted anchorable: the explicit identity order is satisfied by
        // the table b-tree scan itself — no index, no sorter.
        const unsorted = await explainFallback({
            columns: ['rowid', 's', 'v'],
            limit: 5,
            offset: 500
        });
        assert.ok(/SCAN (?:main\.)?eqp_fallback$/m.test(unsorted), `expected a plain scan:\n${unsorted}`);
        assert.ok(!unsorted.includes('TEMP B-TREE'), `unexpected sort step:\n${unsorted}`);
    });
});

describe('keyset engine round-trip (native)', () => {
    let native: Awaited<ReturnType<typeof createNativeDatabaseConnection>> | undefined;
    let databaseOps: DatabaseOperations | undefined;
    let directory: string | undefined;
    // The SQL text reaches the worker as the first argument of each call.
    const sent: string[] = [];
    const call = NativeWorkerProcess.prototype.call;

    before(async () => {
        if (!await isNativeAvailable(process.cwd())) {
            if (process.env.FUZZ_EXPECT_TARGET) throw new Error(`Missing native runtime for ${process.env.FUZZ_EXPECT_TARGET}`);
            return;
        }
        (NativeWorkerProcess.prototype as any).call = async function (method: string, args: unknown[] = [], ...rest: unknown[]) {
            if (typeof args[0] === 'string') sent.push(args[0]);
            return (call as any).call(this, method, args, ...rest);
        };
        fs.mkdirSync('.tmp', { recursive: true });
        directory = fs.mkdtempSync(path.resolve('.tmp/keyset-last-page-'));
        const file = path.join(directory, 'last-page.db');
        fs.closeSync(fs.openSync(file, 'w'));
        native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
        databaseOps = (await native.establishConnection(vscode.Uri.file(file), 'keyset-last-page', false)).databaseOps;
        await databaseOps.executeQuery(LAST_PAGE_TABLE_SQL);
    });
    after(() => {
        NativeWorkerProcess.prototype.call = call;
        native?.workerMethods[Symbol.dispose]();
        if (directory) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    it('seeks from a Last page bounded to its remainder', async (context) => {
        if (!databaseOps) return context.skip('Bundled native runtime unavailable');
        await assertLastPageAnchorsSeek(databaseOps, sent);
    });

    it('does not seek from anchors minted under another page size', async (context) => {
        if (!databaseOps) return context.skip('Bundled native runtime unavailable');
        await assertOtherPageSizeFallsBack(databaseOps, sent);
    });
});
