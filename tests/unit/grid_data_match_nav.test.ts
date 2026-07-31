import './vscode_mock_setup';

import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { createDeferred } from './helpers/deferred';

function createClassList(initial: string[] = []) {
    const classes = new Set(initial);
    return {
        add: (...names: string[]) => names.forEach(name => classes.add(name)),
        remove: (...names: string[]) => names.forEach(name => classes.delete(name)),
        contains: (name: string) => classes.has(name),
        toggle: (name: string, force?: boolean) => {
            const enabled = force ?? !classes.has(name);
            if (enabled) classes.add(name);
            else classes.delete(name);
            return enabled;
        }
    };
}

describe('grid data match cache', () => {
    afterEach(() => {
        delete (globalThis as any).document;
        mock.restoreAll();
    });

    it('invalidates cached match coordinates after replacement data is applied', async () => {
        const activeCell = { classList: createClassList(['active-match-cell']) };
        const counter = { textContent: '1/1' };
        const elements: Record<string, any> = {
            pageIndicator: { textContent: '' },
            btnFirst: { disabled: false },
            btnPrev: { disabled: false },
            btnNext: { disabled: false },
            btnLast: { disabled: false },
            statusText: { textContent: '' },
            filterMatchCounter: counter
        };
        (globalThis as any).document = {
            getElementById(id: string) {
                return elements[id] ?? null;
            },
            querySelectorAll(selector: string) {
                if (selector === '.active-match-cell') {
                    return activeCell.classList.contains('active-match-cell') ? [activeCell] : [];
                }
                return [];
            }
        };

        const stateModulePath = '../../core/ui/modules/state.js';
        const apiModulePath = '../../core/ui/modules/api.js';
        const gridDataModulePath = '../../core/ui/modules/grid-data.js';
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { loadTableData } = await import(gridDataModulePath);
        const originalFetchCount = backendApi.fetchTableCount;
        const originalFetchData = backendApi.fetchTableData;

        backendApi.fetchTableCount = async () => 1;
        backendApi.fetchTableData = async () => ({ rows: [[7, 'new value']] });
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'value', type: 'TEXT' }];
        state.gridData = [[1, 'old value']];
        state.currentPageIndex = 0;
        state.totalPageCount = 1;
        state.rowsPerPage = 500;
        state.columnFilters = {};
        state.filterQuery = 'old';
        state.editingCellInfo = { rowIdx: 0, colIdx: 0 };
        state.matchNav = {
            scope: 'global',
            term: 'old',
            matches: [{ rowIdx: 0, colIdx: 0 }],
            currentIndex: 0
        };

        try {
            const applied = await loadTableData(false, false);

            assert.strictEqual(applied, true);
            assert.deepStrictEqual(state.gridData, [[7, 'new value']]);
            assert.deepStrictEqual(state.matchNav, {
                scope: null,
                term: null,
                matches: [],
                currentIndex: -1
            });
            assert.strictEqual(counter.textContent, '');
            assert.strictEqual(activeCell.classList.contains('active-match-cell'), false);
        } finally {
            backendApi.fetchTableCount = originalFetchCount;
            backendApi.fetchTableData = originalFetchData;
            state.editingCellInfo = null;
        }
    });

    it('guards the old grid during a background data replacement', async () => {
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
        const stateModulePath = '../../core/ui/modules/state.js';
        const apiModulePath = '../../core/ui/modules/api.js';
        const gridDataModulePath = '../../core/ui/modules/grid-data.js';
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { loadTableData } = await import(gridDataModulePath);
        const count = createDeferred<number>();
        const originalFetchCount = backendApi.fetchTableCount;
        const originalFetchData = backendApi.fetchTableData;
        backendApi.fetchTableCount = async () => count.promise;
        backendApi.fetchTableData = async () => ({ rows: [[7, 'fresh']] });
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'value', type: 'TEXT' }];
        state.currentPageIndex = 0;
        state.rowsPerPage = 500;
        state.columnFilters = {};
        state.filterQuery = '';
        state.isLoadingData = false;
        state.isGridReloading = false;

        try {
            const pendingLoad = loadTableData(false, false);
            assert.strictEqual(state.isGridReloading, true);
            assert.strictEqual(state.isLoadingData, false, 'background load must not show spinner state');
            count.resolve(1);
            await pendingLoad;
            assert.strictEqual(state.isGridReloading, false);
        } finally {
            backendApi.fetchTableCount = originalFetchCount;
            backendApi.fetchTableData = originalFetchData;
        }
    });

    it('does not let a superseded load clear the newer spinner loading state', async () => {
        const container = {
            innerHTML: '',
            scrollLeft: 0,
            scrollTop: 0,
            querySelector() { return null; }
        };
        const elements: Record<string, any> = {
            gridContainer: container,
            statusText: { textContent: '' }
        };
        (globalThis as any).document = {
            getElementById(id: string) { return elements[id] ?? null; },
            querySelectorAll() { return []; }
        };
        const stateModulePath = '../../core/ui/modules/state.js';
        const apiModulePath = '../../core/ui/modules/api.js';
        const gridDataModulePath = '../../core/ui/modules/grid-data.js';
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { loadTableData } = await import(gridDataModulePath);
        const firstCount = createDeferred<number>();
        const secondCount = createDeferred<number>();
        const counts = [firstCount.promise, secondCount.promise];
        let countCall = 0;
        const originalFetchCount = backendApi.fetchTableCount;
        const originalFetchData = backendApi.fetchTableData;
        mock.method(console, 'error', () => {});
        backendApi.fetchTableCount = async () => counts[countCall++];
        backendApi.fetchTableData = async () => {
            throw new Error('fetchTableData should not run in this test');
        };
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.renderedTable = null;
        state.tableColumns = [{ name: 'value', type: 'TEXT' }];
        state.currentPageIndex = 0;
        state.rowsPerPage = 500;
        state.columnFilters = {};
        state.filterQuery = '';
        state.isLoadingData = false;
        state.isGridReloading = false;

        try {
            const staleLoad = loadTableData(true, false);
            const currentLoad = loadTableData(true, false);
            assert.strictEqual(state.isLoadingData, true);
            assert.strictEqual(state.isGridReloading, true);

            firstCount.resolve(1);
            await staleLoad;

            assert.strictEqual(
                state.isLoadingData,
                true,
                'the superseded request must not clear the current spinner state'
            );
            assert.strictEqual(state.isGridReloading, true);

            secondCount.reject(new Error('current load stopped for test'));
            assert.strictEqual(await currentLoad, false);
            assert.strictEqual(state.isLoadingData, false);
            assert.strictEqual(state.isGridReloading, false);
        } finally {
            backendApi.fetchTableCount = originalFetchCount;
            backendApi.fetchTableData = originalFetchData;
            state.isLoadingData = false;
            state.isGridReloading = false;
        }
    });

    it('releases both loading guards when spinner rendering fails before the fetch', async () => {
        let renderedHtml = '';
        let htmlWrites = 0;
        const container = {
            scrollLeft: 0,
            scrollTop: 0,
            querySelector() { return null; },
            get innerHTML() { return renderedHtml; },
            set innerHTML(value: string) {
                htmlWrites++;
                if (htmlWrites === 1) throw new Error('spinner rendering failed');
                renderedHtml = value;
            }
        };
        const elements: Record<string, any> = {
            gridContainer: container,
            statusText: { textContent: '' }
        };
        (globalThis as any).document = {
            getElementById(id: string) { return elements[id] ?? null; },
            querySelectorAll() { return []; }
        };
        mock.method(console, 'error', () => {});

        const stateModulePath = '../../core/ui/modules/state.js';
        const gridDataModulePath = '../../core/ui/modules/grid-data.js';
        const { state } = await import(stateModulePath);
        const { loadTableData } = await import(gridDataModulePath);
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.renderedTable = null;
        state.tableColumns = [{ name: 'value', type: 'TEXT' }];
        state.currentPageIndex = 0;
        state.rowsPerPage = 500;
        state.columnFilters = {};
        state.filterQuery = '';
        state.isLoadingData = false;
        state.isGridReloading = false;

        let result: boolean | undefined;
        let thrown: unknown;
        try {
            result = await loadTableData(true, false);
        } catch (error) {
            thrown = error;
        }

        assert.strictEqual(thrown, undefined);
        assert.strictEqual(result, false);
        assert.strictEqual(state.isLoadingData, false);
        assert.strictEqual(state.isGridReloading, false);
    });
});
