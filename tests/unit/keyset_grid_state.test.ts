import './vscode_mock_setup';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { createDeferred } from './helpers/deferred';

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
    const { state } = await import(stateModulePath);
    const { backendApi } = await import(apiModulePath);
    const { loadTableData } = await import(gridDataModulePath);
    return { state, backendApi, loadTableData };
}

function primeTableState(state: any, table: string, pageIndex = 0) {
    state.selectedTable = table;
    state.selectedTableType = 'table';
    state.renderedTable = null;
    state.tableColumns = [{ name: 'value', type: 'TEXT' }];
    state.currentPageIndex = pageIndex;
    state.rowsPerPage = 20;
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
                table: 'items', pageIndex: 0, first: 'F1', last: 'L1'
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
            state.keysetAnchors = { table: 'items', pageIndex: 3, first: 'Fx', last: 'Lx' };
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
            state.keysetAnchors = { table: 'items', pageIndex: 0, first: 'F0', last: 'L0' };
            await loadTableData(false, false, 'next');
            assert.strictEqual(requests[6], undefined);

            // Anchors from another table never travel.
            state.currentPageIndex = 1;
            state.keysetAnchors = { table: 'elsewhere', pageIndex: 1, first: 'F9', last: 'L9' };
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
                table: 'report_view', pageIndex: 0, first: null, last: null
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
        state.keysetAnchors = { table: 'items', pageIndex: 1, first: 'F1', last: 'L1' };

        try {
            assert.strictEqual(await loadTableData(false, false), true);
            assert.strictEqual(requests.length, 2);
            assert.deepStrictEqual(requests[0], { mode: 'atOrAfter', anchor: 'F1' });
            assert.strictEqual(requests[1], undefined); // the OFFSET fallback
            assert.deepStrictEqual(state.gridData, [[7, 'offset-row']]);
            // Re-anchored from the fallback result.
            assert.deepStrictEqual(state.keysetAnchors, {
                table: 'items', pageIndex: 1, first: 'FR', last: 'LR'
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
                table: 'items', pageIndex: 0, first: 'F-B', last: 'L-B'
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
});
