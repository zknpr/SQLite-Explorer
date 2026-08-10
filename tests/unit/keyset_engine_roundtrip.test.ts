import './vscode_mock_setup';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import {
    computeKeysetKey,
    computeKeysetQueryTag,
    encodeKeysetAnchor,
    keysetFallbackOrder,
    resolveKeysetPlan
} from '../../src/core/keyset-pagination';
import { buildSelectQuery } from '../../src/core/query-builder';
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

/** Production OFFSET pages (no keyset field) — the byte-parity baseline. */
async function fetchOffsetPages(cfg: SweepConfig, pageCount: number) {
    const pages: QueryResultSet[] = [];
    for (let index = 0; index < pageCount; index++) {
        pages.push(await fetchPage(cfg, index));
    }
    return pages;
}

describe('keyset engine round-trip (WASM)', () => {
    before(async () => {
        const result = await createDatabaseEngine({ content: null, maxSize: 0 });
        engine = result.operations!;
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
        // silently. The CAST(? AS INTEGER) predicate restores exact int64
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
            'CREATE TABLE eqp_comp (a TEXT, b INTEGER, v TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID'
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

        // Forward seeks and 'first' must not sort the table at all.
        const forwardCases: Array<[string, TableQueryOptions, typeof rowidIdentity | typeof compIdentity]> = [
            ['eqp_rowid', { columns: ['rowid', 'v'], limit: 5, orderDir: 'ASC', keyset: { mode: 'first' } }, rowidIdentity],
            ['eqp_rowid', { columns: ['rowid', 'v'], limit: 5, orderDir: 'ASC', keyset: { mode: 'after', anchor: anchorRowid } }, rowidIdentity],
            ['eqp_comp', { columns: ['rowid', 'a', 'b', 'v'], limit: 5, orderDir: 'ASC', keyset: { mode: 'first' } }, compIdentity],
            ['eqp_comp', { columns: ['rowid', 'a', 'b', 'v'], limit: 5, orderDir: 'ASC', keyset: { mode: 'after', anchor: anchorComp } }, compIdentity]
        ];
        for (const [table, options, identity] of forwardCases) {
            const detail = await explain(table, options, identity);
            assert.ok(!detail.includes('TEMP B-TREE'), `unexpected sort step:\n${detail}`);
            if (options.keyset?.mode === 'after') {
                // The CAST(? AS INTEGER) anchor binding must not defeat the
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
        assert.ok(/SCAN eqp_fallback$/m.test(unsorted), `expected a plain scan:\n${unsorted}`);
        assert.ok(!unsorted.includes('TEMP B-TREE'), `unexpected sort step:\n${unsorted}`);
    });
});
