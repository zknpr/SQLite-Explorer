import './vscode_mock_setup';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';

// A 5,000-row page of a 400-column table is 2,000,000 cells. The host's 16 MiB
// page budget then leaves too little per cell: wide pages arrived with short
// values clipped, and from about 400 columns failed with "Cell containment
// cannot fit this page". Wide tables load fewer rows per page instead.

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
    return elements;
}

async function loadHarness() {
    // Variable specifiers keep tsc from demanding declarations for the plain-JS
    // webview modules (the established pattern in grid_count_cache.test.ts).
    const stateModulePath = '../../core/ui/modules/state.js';
    const apiModulePath = '../../core/ui/modules/api.js';
    const gridDataModulePath = '../../core/ui/modules/grid-data.js';
    const dataUtilsModulePath = '../../core/ui/modules/data-utils.js';
    const countCacheModulePath = '../../core/ui/modules/count-cache.js';
    const { state } = await import(stateModulePath);
    const { backendApi } = await import(apiModulePath);
    const gridData = await import(gridDataModulePath);
    const { getRowId } = await import(dataUtilsModulePath);
    (await import(countCacheModulePath)).invalidateAllCounts();
    return { state, backendApi, gridData, getRowId };
}

function primeState(state: any, columnCount: number, type: 'table' | 'view', pageIndex = 0) {
    state.selectedTable = `wide_${columnCount}_${type}`;
    state.selectedTableType = type;
    state.renderedTable = null;
    state.tableColumns = Array.from({ length: columnCount }, (_, i) => ({ name: `c${i}`, type: 'TEXT' }));
    state.currentPageIndex = pageIndex;
    state.rowsPerPage = 5000;
    state.pageSize = undefined;
    state.columnFilters = {};
    state.filterQuery = '';
    state.sortedColumn = null;
    state.sortAscending = true;
    state.isLoadingData = false;
    state.isGridReloading = false;
    state.isReadOnly = false;
    state.editingCellInfo = null;
    state.keysetAnchors = null;
    state.gridData = [];
    state.countStatus = 'ready';
    state.selectedRowIds = new Set();
    state.selectedColumns = new Set();
    state.selectedCells = [];
}

function installBackend(backendApi: any, total: number, columnCount: number, offsetRow: number) {
    const requests: any[] = [];
    backendApi.fetchTableCount = async () => ({ count: total, isExact: true });
    backendApi.fetchTableData = async (_table: string, options: any) => {
        requests.push({ limit: options.limit, offset: options.offset, keyset: options.keyset });
        const rows = Math.max(0, Math.min(options.limit, total - options.offset));
        return {
            rows: Array.from({ length: rows }, (_, row) => [
                ...(offsetRow ? [options.offset + row + 1] : []),
                ...Array.from({ length: columnCount }, () => 'v')
            ])
        };
    };
    return requests;
}

describe('wide table page size', () => {
    afterEach(() => {
        delete (globalThis as any).document;
    });

    it('keeps the chosen page size up to 250,000 values and lowers it past that', async () => {
        const { gridData } = await loadHarness();
        const { pageSizeForColumns } = gridData;
        assert.strictEqual(pageSizeForColumns(5000, 50), 5000);
        assert.strictEqual(pageSizeForColumns(5000, 51), 4900);
        assert.strictEqual(pageSizeForColumns(5000, 101), 2400);
        assert.strictEqual(pageSizeForColumns(5000, 201), 1200);
        assert.strictEqual(pageSizeForColumns(5000, 301), 800);
        assert.strictEqual(pageSizeForColumns(5000, 501), 400);
        assert.strictEqual(pageSizeForColumns(5000, 2001), 100);
        assert.strictEqual(pageSizeForColumns(5000, 32768), 7);
        assert.strictEqual(pageSizeForColumns(10000, 52), 4800);
        assert.strictEqual(pageSizeForColumns(100, 2001), 100);
        assert.strictEqual(pageSizeForColumns(250, 0), 250);
    });

    it('pages a 500-column table by 400 rows and says so', async () => {
        const elements = installDocumentMock();
        const { state, backendApi, gridData } = await loadHarness();
        const originals = { fetchTableCount: backendApi.fetchTableCount, fetchTableData: backendApi.fetchTableData };
        try {
            primeState(state, 500, 'table', 2);
            const requests = installBackend(backendApi, 4500, 500, 1);
            assert.strictEqual(await gridData.loadTableData(false), true);

            // 500 columns and the rowid the table query adds.
            assert.deepStrictEqual(requests.map(r => [r.limit, r.offset]), [[400, 800]]);
            assert.strictEqual(state.pageSize, 400);
            assert.strictEqual(state.rowsPerPage, 5000, 'the chosen page size is kept');
            assert.strictEqual(state.totalPageCount, 12);
            assert.strictEqual(state.gridData.length, 400);
            assert.strictEqual(elements.pageIndicator.textContent, '3 / 12');
            assert.strictEqual(elements.statusText.textContent, '4500 records; 400 rows per page for 500 columns');
        } finally {
            Object.assign(backendApi, originals);
            state.selectedTable = null;
            state.gridData = [];
        }
    });

    it('numbers view rows by the page size that loaded them', async () => {
        installDocumentMock();
        const { state, backendApi, gridData, getRowId } = await loadHarness();
        const originals = { fetchTableCount: backendApi.fetchTableCount, fetchTableData: backendApi.fetchTableData };
        try {
            primeState(state, 500, 'view', 1);
            installBackend(backendApi, 4500, 500, 0);
            assert.strictEqual(await gridData.loadTableData(false), true);
            // A view query adds no rowid: 500 values a row, 500 rows a page.
            assert.strictEqual(getRowId(state.gridData[0], 0), 500);
        } finally {
            Object.assign(backendApi, originals);
            state.selectedTable = null;
            state.gridData = [];
        }
    });

    it('leaves a 49-column table at the chosen page size', async () => {
        const elements = installDocumentMock();
        const { state, backendApi, gridData } = await loadHarness();
        const originals = { fetchTableCount: backendApi.fetchTableCount, fetchTableData: backendApi.fetchTableData };
        try {
            primeState(state, 49, 'table', 1);
            const requests = installBackend(backendApi, 12000, 49, 1);
            assert.strictEqual(await gridData.loadTableData(false), true);
            assert.deepStrictEqual(requests.map(r => [r.limit, r.offset]), [[5000, 5000]]);
            assert.strictEqual(state.pageSize, 5000);
            assert.strictEqual(elements.statusText.textContent, '12000 records');
        } finally {
            Object.assign(backendApi, originals);
            state.selectedTable = null;
            state.gridData = [];
        }
    });

    it('counts the rowid of a table query as a column', async () => {
        installDocumentMock();
        const { state, backendApi, gridData } = await loadHarness();
        const originals = { fetchTableCount: backendApi.fetchTableCount, fetchTableData: backendApi.fetchTableData };
        try {
            primeState(state, 50, 'table', 0);
            const tableRequests = installBackend(backendApi, 12000, 50, 1);
            assert.strictEqual(await gridData.loadTableData(false), true);
            primeState(state, 50, 'view', 0);
            const viewRequests = installBackend(backendApi, 12000, 50, 0);
            assert.strictEqual(await gridData.loadTableData(false), true);
            assert.deepStrictEqual([tableRequests[0].limit, viewRequests[0].limit], [4900, 5000]);
        } finally {
            Object.assign(backendApi, originals);
            state.selectedTable = null;
            state.gridData = [];
        }
    });
});
