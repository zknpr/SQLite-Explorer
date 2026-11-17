import './vscode_mock_setup';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { createDeferred } from './helpers/deferred';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';

function installDocumentMock() {
    const elements: Record<string, any> = {
        pageIndicator: { textContent: '' },
        btnFirst: { disabled: false },
        btnPrev: { disabled: false },
        btnNext: { disabled: false },
        btnLast: { disabled: false },
        statusText: { textContent: '' },
        filterMatchCounter: { textContent: '' }
    };
    (globalThis as any).document = {
        getElementById(id: string) { return elements[id] ?? null; },
        querySelectorAll() { return []; }
    };
}

async function loadHarness() {
    // Variable specifiers keep tsc from demanding declarations for the plain-JS
    // webview modules (the established pattern in grid_data_match_nav.test.ts).
    const stateModulePath = '../../core/ui/modules/state.js';
    const apiModulePath = '../../core/ui/modules/api.js';
    const gridDataModulePath = '../../core/ui/modules/grid-data.js';
    const countCacheModulePath = '../../core/ui/modules/count-cache.js';
    const { state } = await import(stateModulePath);
    const { backendApi } = await import(apiModulePath);
    const { loadTableData } = await import(gridDataModulePath);
    const { invalidateAllCounts } = await import(countCacheModulePath);
    // The count cache is module state shared across this process; start each
    // test cold so per-test count mocks always get their first fetch.
    invalidateAllCounts();
    return { state, backendApi, loadTableData, invalidateAllCounts };
}

/**
 * Serve the grid from a real engine, which mints and checks anchors. The SQL
 * it prepares shows whether a page sought from its anchor or scanned to its
 * OFFSET. `wrap` adjusts each data request the way the host would.
 */
async function installEngine(backendApi: any, setupSql: string, wrap: (options: any) => any = options => options) {
    const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
    await engine.executeQuery(setupSql);
    const prepared: string[] = [];
    const instance = (engine as unknown as { instance: { prepare(sql: string, ...rest: unknown[]): unknown } }).instance;
    const prepare = instance.prepare;
    instance.prepare = (sql: string, ...rest: unknown[]) => {
        prepared.push(sql);
        return prepare.call(instance, sql, ...rest);
    };
    backendApi.fetchTableCount = (table: string, options: any) => engine.fetchTableCount(table, options);
    backendApi.fetchTableData = (table: string, options: any) => engine.fetchTableData(table, wrap(options));
    const scannedTo = (offset: number) => prepared.some(sql => new RegExp(`\\bOFFSET ${offset}\\b`).test(sql));
    const sought = () => prepared.some(sql => /\bOFFSET 0\b/.test(sql));
    return { engine, prepared, scannedTo, sought };
}

function itemsSql(rowCount: number, value = "'row-' || x") {
    return 'CREATE TABLE items (value TEXT); ' +
        `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < ${rowCount}) ` +
        `INSERT INTO items SELECT ${value} FROM n`;
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

function primeTableState(state: any, table: string, pageIndex = 0) {
    state.selectedTable = table;
    state.selectedTableType = 'table';
    state.renderedTable = null;
    state.tableColumns = [{ name: 'value', type: 'TEXT' }];
    state.currentPageIndex = pageIndex;
    state.rowsPerPage = 20;
    state.pageSize = undefined;
    state.sortedColumn = null;
    state.sortAscending = true;
    state.columnFilters = {};
    state.filterQuery = '';
    state.isLoadingData = false;
    state.isGridReloading = false;
    state.editingCellInfo = null;
    state.keysetAnchors = null;
}

function resetHarness(state: any, backendApi: any, originals: { count: any; data: any }) {
    backendApi.fetchTableCount = originals.count;
    backendApi.fetchTableData = originals.data;
    state.selectedTable = null;
    state.keysetAnchors = null;
    state.gridData = [];
    state.isLoadingData = false;
    state.isGridReloading = false;
    state.editingCellInfo = null;
}

describe('grid keyset anchor state', () => {
    afterEach(() => {
        delete (globalThis as any).document;
    });

    it('sends intent-shaped keyset requests and commits anchors with the page', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData } = await loadHarness();
        const originals = { count: backendApi.fetchTableCount, data: backendApi.fetchTableData };
        const requests: any[] = [];
        let anchorTick = 0;
        backendApi.fetchTableCount = async () => 60; // 3 pages of 20
        backendApi.fetchTableData = async (_table: string, options: any) => {
            requests.push(options.keyset);
            anchorTick += 1;
            return {
                // Full pages, consistent with the count: a short 'before' page
                // would (correctly) trigger the OFFSET retry and shift the
                // captured request indices.
                rows: Array.from({ length: 20 }, (_, row) => [row, 'row']),
                keysetAnchors: { first: `F${anchorTick}`, last: `L${anchorTick}` }
            };
        };
        primeTableState(state, 'items');

        try {
            // Page 0 always loads as 'first' (no anchor needed).
            assert.strictEqual(await loadTableData(false, false), true);
            assert.deepStrictEqual(requests[0], { mode: 'first' });
            assert.deepStrictEqual(state.keysetAnchors, {
                table: 'items', pageIndex: 0, pageSize: 20, first: 'F1', last: 'L1'
            });

            // Next: identity-after-last-row of the committed page.
            state.currentPageIndex = 1;
            await loadTableData(false, false, 'next');
            assert.deepStrictEqual(requests[1], { mode: 'after', anchor: 'L1' });
            assert.strictEqual(state.keysetAnchors.pageIndex, 1);

            // Refetch-current: at-or-after-first-row of the committed page.
            await loadTableData(false, false);
            assert.deepStrictEqual(requests[2], { mode: 'atOrAfter', anchor: 'F2' });

            // Prev: identity-before-first-row; landing on page 0 is 'first'.
            state.currentPageIndex = 2;
            state.keysetAnchors = { table: 'items', pageIndex: 3, pageSize: 20, first: 'Fx', last: 'Lx' };
            await loadTableData(false, false, 'prev');
            assert.deepStrictEqual(requests[3], { mode: 'before', anchor: 'Fx' });
            state.currentPageIndex = 0;
            await loadTableData(false, false, 'prev');
            assert.deepStrictEqual(requests[4], { mode: 'first' });

            // Last: reversed remainder page from the fresh count.
            state.currentPageIndex = 2;
            await loadTableData(false, false, 'last');
            assert.deepStrictEqual(requests[5], { mode: 'last', lastPageRowCount: 20 });

            // Anchors describing a different page than the intent expects
            // (rapid double-next whose first load never committed) -> OFFSET.
            state.currentPageIndex = 2;
            state.keysetAnchors = { table: 'items', pageIndex: 0, pageSize: 20, first: 'F0', last: 'L0' };
            await loadTableData(false, false, 'next');
            assert.strictEqual(requests[6], undefined);

            // Anchors from another table never travel.
            state.currentPageIndex = 1;
            state.keysetAnchors = { table: 'elsewhere', pageIndex: 1, pageSize: 20, first: 'F9', last: 'L9' };
            await loadTableData(false, false);
            assert.strictEqual(requests[7], undefined);
        } finally {
            resetHarness(state, backendApi, originals);
        }
    });

    it('never sends keyset requests for views and stores null anchors', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData } = await loadHarness();
        const originals = { count: backendApi.fetchTableCount, data: backendApi.fetchTableData };
        const requests: any[] = [];
        backendApi.fetchTableCount = async () => 5;
        backendApi.fetchTableData = async (_table: string, options: any) => {
            requests.push(options.keyset);
            return { rows: [['v']] }; // views return no anchors
        };
        primeTableState(state, 'report_view');
        state.selectedTableType = 'view';

        try {
            await loadTableData(false, false);
            assert.strictEqual(requests[0], undefined);
            assert.deepStrictEqual(state.keysetAnchors, {
                table: 'report_view', pageIndex: 0, pageSize: 20, first: null, last: null
            });
        } finally {
            resetHarness(state, backendApi, originals);
        }
    });

    it('retries one load via OFFSET when a keyset page comes back inconsistently empty', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData } = await loadHarness();
        const originals = { count: backendApi.fetchTableCount, data: backendApi.fetchTableData };
        const requests: any[] = [];
        backendApi.fetchTableCount = async () => 60;
        backendApi.fetchTableData = async (_table: string, options: any) => {
            requests.push(options.keyset);
            if (options.keyset) return { rows: [] }; // rows past the anchor were deleted
            return {
                rows: [[7, 'offset-row']],
                keysetAnchors: { first: 'FR', last: 'LR' }
            };
        };
        primeTableState(state, 'items', 1);
        state.keysetAnchors = { table: 'items', pageIndex: 1, pageSize: 20, first: 'F1', last: 'L1' };

        try {
            assert.strictEqual(await loadTableData(false, false), true);
            assert.strictEqual(requests.length, 2);
            assert.deepStrictEqual(requests[0], { mode: 'atOrAfter', anchor: 'F1' });
            assert.strictEqual(requests[1], undefined); // the OFFSET fallback
            assert.deepStrictEqual(state.gridData, [[7, 'offset-row']]);
            // Re-anchored from the fallback result.
            assert.deepStrictEqual(state.keysetAnchors, {
                table: 'items', pageIndex: 1, pageSize: 20, first: 'FR', last: 'LR'
            });
        } finally {
            resetHarness(state, backendApi, originals);
        }
    });

    it('never lets a superseded load commit its anchors', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData } = await loadHarness();
        const originals = { count: backendApi.fetchTableCount, data: backendApi.fetchTableData };
        const slowData = createDeferred<any>();
        let call = 0;
        backendApi.fetchTableCount = async () => 40;
        backendApi.fetchTableData = async () => {
            call += 1;
            if (call === 1) return slowData.promise; // load A stalls
            return {
                rows: [[2, 'fresh']],
                keysetAnchors: { first: 'F-B', last: 'L-B' }
            };
        };
        primeTableState(state, 'items');

        try {
            const loadA = loadTableData(false, false);
            await Promise.resolve();
            const loadB = loadTableData(false, false);
            assert.strictEqual(await loadB, true);
            const committed = state.keysetAnchors;
            assert.deepStrictEqual(committed, {
                table: 'items', pageIndex: 0, pageSize: 20, first: 'F-B', last: 'L-B'
            });

            // Load A finally resolves with stale anchors; it must not commit.
            slowData.resolve({
                rows: [[1, 'stale']],
                keysetAnchors: { first: 'F-A', last: 'L-A' }
            });
            assert.strictEqual(await loadA, undefined);
            assert.deepStrictEqual(state.keysetAnchors, committed);
            assert.deepStrictEqual(state.gridData, [[2, 'fresh']]);
        } finally {
            resetHarness(state, backendApi, originals);
        }
    });

    it('seeks from the Last page on Prev and on a refetch', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData } = await loadHarness();
        const originals = { count: backendApi.fetchTableCount, data: backendApi.fetchTableData };
        // 50 rows at 20 a page: Last is page 2 and holds 10 rows.
        const { engine, prepared, scannedTo, sought } = await installEngine(backendApi, itemsSql(50));
        const ids = () => state.gridData.map((row: unknown[]) => row[0]);
        primeTableState(state, 'items');

        try {
            assert.strictEqual(await loadTableData(false, false), true);
            state.currentPageIndex = 2;
            assert.strictEqual(await loadTableData(false, false, 'last'), true);
            assert.deepStrictEqual(ids(), range(41, 50));

            prepared.length = 0;
            state.currentPageIndex = 1;
            assert.strictEqual(await loadTableData(false, false, 'prev'), true);
            assert.deepStrictEqual(ids(), range(21, 40));
            assert.ok(!scannedTo(20) && sought(), `Prev scanned instead of seeking:\n${prepared.join('\n')}`);

            state.currentPageIndex = 2;
            assert.strictEqual(await loadTableData(false, false, 'last'), true);
            // The refetch that follows an edit, from the cached count.
            prepared.length = 0;
            assert.strictEqual(await loadTableData(false, false), true);
            assert.deepStrictEqual(ids(), range(41, 50));
            assert.ok(!scannedTo(40) && sought(), `refetch scanned instead of seeking:\n${prepared.join('\n')}`);
        } finally {
            engine.shutdown();
            resetHarness(state, backendApi, originals);
        }
    });

    it('does not send anchors committed under another page size', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData } = await loadHarness();
        const originals = { count: backendApi.fetchTableCount, data: backendApi.fetchTableData };
        const requests: any[] = [];
        backendApi.fetchTableCount = async () => ({ count: 14900, isExact: true });
        backendApi.fetchTableData = async (_table: string, options: any) => {
            requests.push(options);
            return {
                rows: Array.from(
                    { length: Math.max(0, Math.min(options.limit, 14900 - options.offset)) },
                    (_, row) => [options.offset + row + 1]
                ),
                keysetAnchors: { first: `F${options.offset}`, last: `L${options.offset}` }
            };
        };
        primeTableState(state, 'wide');
        // 49 columns and the rowid fill 5,000 rows a page; a 50th lowers it to 4,900.
        state.tableColumns = Array.from({ length: 49 }, (_, i) => ({ name: `c${i}`, type: 'TEXT' }));
        state.rowsPerPage = 5000;

        try {
            assert.strictEqual(await loadTableData(false, false), true);
            state.currentPageIndex = 2;
            assert.strictEqual(await loadTableData(false, false, 'last'), true);
            assert.strictEqual(state.keysetAnchors.pageIndex, 2);

            state.tableColumns = [...state.tableColumns, { name: 'c49', type: 'TEXT' }];
            requests.length = 0;
            assert.strictEqual(await loadTableData(false, true), true);
            assert.deepStrictEqual(
                requests.map(r => [r.limit, r.offset, r.keyset]),
                [[4900, 9800, undefined]]
            );
        } finally {
            resetHarness(state, backendApi, originals);
        }
    });

    it('shows the rows the page index names after a column lowers the page size', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData, invalidateAllCounts } = await loadHarness();
        const originals = { count: backendApi.fetchTableCount, data: backendApi.fetchTableData };
        const columns = Array.from({ length: 49 }, (_, i) => `c${i}`);
        const { engine } = await installEngine(
            backendApi,
            `CREATE TABLE wide (${columns.join(', ')}); ` +
            'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 14900) ' +
            `INSERT INTO wide SELECT ${columns.map(() => 'x').join(', ')} FROM n`
        );
        const ids = () => state.gridData.map((row: unknown[]) => row[0]);
        primeTableState(state, 'wide');
        state.tableColumns = columns.map(name => ({ name, type: '' }));
        state.rowsPerPage = 5000;

        try {
            assert.strictEqual(await loadTableData(false, false), true);
            // Last: rows 10,001-14,900, 4,900 of them, at 5,000 a page.
            state.currentPageIndex = 2;
            assert.strictEqual(await loadTableData(false, false, 'last'), true);
            assert.deepStrictEqual([ids()[0], ids().length], [10001, 4900]);

            // Adding a column lowers the page size to 4,900 and keeps index 2,
            // which now names rows 9,801-14,700 of four pages.
            await engine.executeQuery('ALTER TABLE wide ADD COLUMN c49');
            state.tableColumns = [...state.tableColumns, { name: 'c49', type: '' }];
            invalidateAllCounts();
            assert.strictEqual(await loadTableData(false, true), true);
            assert.strictEqual(state.pageSize, 4900);
            assert.strictEqual(state.currentPageIndex, 2);
            assert.strictEqual(state.totalPageCount, 4);
            assert.deepStrictEqual([ids()[0], ids().at(-1), ids().length], [9801, 14700, 4900]);
            assert.deepStrictEqual(ids(), range(9801, 14700));
        } finally {
            engine.shutdown();
            resetHarness(state, backendApi, originals);
        }
    });

    it('seeks on a clipped final-page retry, judging the anchor on the full page first', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData, invalidateAllCounts } = await loadHarness();
        const originals = { count: backendApi.fetchTableCount, data: backendApi.fetchTableData };
        // 1,004-byte values: a 20,000-byte page budget clips them at 20 rows
        // a page, not at 5.
        const { engine, prepared, scannedTo } = await installEngine(
            backendApi,
            itemsSql(50, "printf('%04d', x) || hex(zeroblob(500))"),
            options => ({ ...options, maxPageResponseBytes: 20000 })
        );
        const ids = () => state.gridData.map((row: unknown[]) => row[0]);
        primeTableState(state, 'items');

        try {
            assert.strictEqual(await loadTableData(false, false), true);
            state.currentPageIndex = 2;
            assert.strictEqual(await loadTableData(false, false, 'last'), true);
            assert.deepStrictEqual(ids(), range(41, 50));

            // A refetch from the cached count asks for 20 rows, clips, and
            // retries bounded to the 10 left. Both requests seek.
            prepared.length = 0;
            assert.strictEqual(await loadTableData(false, false), true);
            assert.deepStrictEqual(ids(), range(41, 50));
            assert.ok(
                !scannedTo(40)
                    && prepared.some(sql => /\bLIMIT 20 OFFSET 0\b/.test(sql))
                    && prepared.some(sql => /\bLIMIT 10 OFFSET 0\b/.test(sql)),
                `clipped refetch did not seek twice:\n${prepared.join('\n')}`
            );

            // Another connection deletes five rows before the page's first row,
            // so page 2 now holds rows 46-50. Seeking from row 41 for the full
            // page returns ten rows, more than the five the count leaves; the
            // retry bounded to five must not take that anchor.
            await engine.executeQuery('DELETE FROM items WHERE rowid <= 5');
            invalidateAllCounts();
            assert.strictEqual(await loadTableData(false, false), true);
            assert.strictEqual(state.totalRecordCount, 45);
            assert.strictEqual(state.currentPageIndex, 2);
            assert.deepStrictEqual(ids(), range(46, 50));
            assert.deepStrictEqual(state.gridOversizedCells, {});
        } finally {
            engine.shutdown();
            resetHarness(state, backendApi, originals);
        }
    });
});
