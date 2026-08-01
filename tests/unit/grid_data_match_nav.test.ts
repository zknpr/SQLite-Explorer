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

    it('omits whitespace-only filters from both count and data requests', async () => {
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
        const calls: any[] = [];
        const originalFetchCount = backendApi.fetchTableCount;
        const originalFetchData = backendApi.fetchTableData;
        backendApi.fetchTableCount = async (_table: string, options: any) => {
            calls.push(options);
            return 1;
        };
        backendApi.fetchTableData = async (_table: string, options: any) => {
            calls.push(options);
            return { rows: [[1, ' needle ']] };
        };
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.renderedTable = null;
        state.tableColumns = [
            { name: 'blank', type: 'TEXT' },
            { name: 'padded', type: 'TEXT' }
        ];
        state.currentPageIndex = 0;
        state.rowsPerPage = 500;
        state.columnFilters = { blank: '   ', padded: ' needle ' };
        state.filterQuery = '\t ';
        state.isLoadingData = false;
        state.isGridReloading = false;

        try {
            assert.strictEqual(await loadTableData(false, false), true);
            assert.strictEqual(calls.length, 2);
            for (const options of calls) {
                assert.deepStrictEqual(options.filters, [
                    { column: 'padded', value: ' needle ' }
                ]);
                assert.strictEqual(options.globalFilter, undefined);
            }
        } finally {
            backendApi.fetchTableCount = originalFetchCount;
            backendApi.fetchTableData = originalFetchData;
            state.selectedTable = null;
            state.isLoadingData = false;
            state.isGridReloading = false;
            state.editingCellInfo = null;
        }
    });

    it('keeps data, count, and navigation aligned when only rowid matches', async () => {
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
        const matchNavModulePath = '../../core/ui/modules/match-nav.js';
        const sqliteModulePath = '../../src/core/sqlite-db';
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { loadTableData } = await import(gridDataModulePath);
        const { GLOBAL_MATCH_SCOPE, navigateMatches } = await import(matchNavModulePath);
        const { createDatabaseEngine } = await import(sqliteModulePath);
        const originalState = {
            selectedTable: state.selectedTable,
            selectedTableType: state.selectedTableType,
            renderedTable: state.renderedTable,
            tableColumns: state.tableColumns,
            gridData: state.gridData,
            currentPageIndex: state.currentPageIndex,
            totalRecordCount: state.totalRecordCount,
            rowsPerPage: state.rowsPerPage,
            columnFilters: state.columnFilters,
            filterQuery: state.filterQuery,
            isLoadingData: state.isLoadingData,
            isGridReloading: state.isGridReloading,
            editingCellInfo: state.editingCellInfo,
            matchNav: state.matchNav
        };
        const { operations } = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        await operations.executeQuery(
            "CREATE TABLE rowid_filter_items (value TEXT); " +
            "INSERT INTO rowid_filter_items(rowid, value) VALUES (12, 'visible text')"
        );
        const originalFetchCount = backendApi.fetchTableCount;
        const originalFetchData = backendApi.fetchTableData;
        backendApi.fetchTableCount = (table: string, options: any) =>
            operations.fetchTableCount(table, options);
        backendApi.fetchTableData = (table: string, options: any) =>
            operations.fetchTableData(table, options);
        state.selectedTable = 'rowid_filter_items';
        state.selectedTableType = 'table';
        state.renderedTable = 'rowid_filter_items';
        state.tableColumns = [{ name: 'value', type: 'TEXT' }];
        state.gridData = [];
        state.currentPageIndex = 0;
        state.rowsPerPage = 500;
        state.columnFilters = {};
        state.filterQuery = '12';
        state.isLoadingData = false;
        state.isGridReloading = false;
        state.editingCellInfo = { rowIdx: 0, colIdx: 0 };

        try {
            assert.strictEqual(await loadTableData(false, false), true);
            navigateMatches(GLOBAL_MATCH_SCOPE);

            assert.strictEqual(state.totalRecordCount, 0);
            assert.deepStrictEqual(state.gridData, []);
            assert.deepStrictEqual(state.matchNav.matches, []);
        } finally {
            backendApi.fetchTableCount = originalFetchCount;
            backendApi.fetchTableData = originalFetchData;
            Object.assign(state, originalState);
            (operations as any).shutdown?.();
        }
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
        const matchNavModulePath = '../../core/ui/modules/match-nav.js';
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { loadTableData } = await import(gridDataModulePath);
        const { GLOBAL_MATCH_SCOPE } = await import(matchNavModulePath);
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
        state.matchNav = {
            scope: GLOBAL_MATCH_SCOPE,
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
        state.editingCellInfo = { rowIdx: 0, colIdx: 0 };

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
            state.editingCellInfo = null;
        }
    });

    it('keeps visible column filters editable while their synchronous draft capture protects a reload', async () => {
        const filterInputs = [{ disabled: false }, { disabled: false }];
        const container = {
            scrollLeft: 0,
            scrollTop: 0,
            querySelector(selector: string) {
                return selector === '.data-grid' ? {} : null;
            }
        };
        const elements: Record<string, any> = {
            gridContainer: container,
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
            querySelectorAll(selector: string) {
                return selector === '.column-filter' ? filterInputs : [];
            }
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
        backendApi.fetchTableData = async () => ({ rows: [[1, 'fresh']] });
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.renderedTable = 'items';
        state.tableColumns = [{ name: 'value', type: 'TEXT' }];
        state.currentPageIndex = 0;
        state.rowsPerPage = 500;
        state.columnFilters = { value: 'draft filter' };
        state.filterQuery = '';
        state.isLoadingData = false;
        state.isGridReloading = false;
        state.editingCellInfo = { rowIdx: 0, colIdx: 0 };

        try {
            const pendingLoad = loadTableData(false, true);
            assert.deepStrictEqual(
                filterInputs.map(input => input.disabled),
                [false, false],
                'input handlers capture drafts before the eventual header rebuild'
            );

            count.resolve(1);
            await pendingLoad;
            assert.deepStrictEqual(filterInputs.map(input => input.disabled), [false, false]);
        } finally {
            backendApi.fetchTableCount = originalFetchCount;
            backendApi.fetchTableData = originalFetchData;
            state.isGridReloading = false;
            state.editingCellInfo = null;
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
            statusText: { textContent: '' },
            pageIndicator: { textContent: '' },
            btnFirst: { disabled: false },
            btnPrev: { disabled: false },
            btnNext: { disabled: false },
            btnLast: { disabled: false },
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
            state.editingCellInfo = null;
        }
    });

    it('lets the latest background load clear a superseded foreground spinner flag', async () => {
        const container = {
            innerHTML: '',
            scrollLeft: 0,
            scrollTop: 0,
            querySelector() { return null; }
        };
        const elements: Record<string, any> = {
            gridContainer: container,
            statusText: { textContent: '' },
            pageIndicator: { textContent: '' },
            btnFirst: { disabled: false },
            btnPrev: { disabled: false },
            btnNext: { disabled: false },
            btnLast: { disabled: false },
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
        const foregroundCount = createDeferred<number>();
        const backgroundCount = createDeferred<number>();
        const counts = [foregroundCount.promise, backgroundCount.promise];
        let countCall = 0;
        const originalFetchCount = backendApi.fetchTableCount;
        const originalFetchData = backendApi.fetchTableData;
        backendApi.fetchTableCount = async () => counts[countCall++];
        backendApi.fetchTableData = async () => ({ rows: [[1, 'fresh']] });
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
        state.editingCellInfo = { rowIdx: 0, colIdx: 0 };

        try {
            const foregroundLoad = loadTableData(true, false);
            assert.strictEqual(state.isLoadingData, true);

            const backgroundLoad = loadTableData(false, false);
            foregroundCount.resolve(1);
            await foregroundLoad;
            assert.strictEqual(state.isLoadingData, true);
            assert.strictEqual(state.isGridReloading, true);

            backgroundCount.resolve(1);
            await backgroundLoad;
            assert.strictEqual(
                state.isLoadingData,
                false,
                'the latest load must release spinner state inherited from a superseded load'
            );
            assert.strictEqual(state.isGridReloading, false);
        } finally {
            backendApi.fetchTableCount = originalFetchCount;
            backendApi.fetchTableData = originalFetchData;
            state.isLoadingData = false;
            state.isGridReloading = false;
            state.editingCellInfo = null;
        }
    });

    it('releases loading guards when selection clearing supersedes the latest load', async () => {
        const filterInputs = [{ disabled: false }, { disabled: false }];
        const container = {
            innerHTML: '',
            scrollLeft: 0,
            scrollTop: 0,
            querySelector() { return null; }
        };
        const elements: Record<string, any> = {
            gridContainer: container,
            statusText: { textContent: '' },
            pageIndicator: { textContent: '' },
            btnFirst: { disabled: false },
            btnPrev: { disabled: false },
            btnNext: { disabled: false },
            btnLast: { disabled: false },
            filterMatchCounter: { textContent: '' }
        };
        (globalThis as any).document = {
            getElementById(id: string) { return elements[id] ?? null; },
            querySelectorAll(selector: string) {
                return selector === '.column-filter' ? filterInputs : [];
            }
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
        backendApi.fetchTableData = async () => {
            throw new Error('a load superseded by cleared selection must not fetch rows');
        };
        state.selectedTable = 'dropped_view';
        state.selectedTableType = 'view';
        state.renderedTable = 'dropped_view';
        state.tableColumns = [{ name: 'value', type: 'TEXT' }];
        state.currentPageIndex = 0;
        state.rowsPerPage = 500;
        state.columnFilters = {};
        state.filterQuery = '';
        state.isLoadingData = false;
        state.isGridReloading = false;

        try {
            const pendingLoad = loadTableData(true, false);
            assert.strictEqual(state.isLoadingData, true);
            assert.strictEqual(state.isGridReloading, true);
            assert.deepStrictEqual(filterInputs.map(input => input.disabled), [false, false]);

            // Dropping the displayed view clears selection and starts no successor
            // data load, so this request remains responsible for releasing guards.
            state.selectedTable = null;
            count.resolve(1);
            assert.strictEqual(await pendingLoad, undefined);

            assert.strictEqual(state.isLoadingData, false);
            assert.strictEqual(state.isGridReloading, false);
            assert.deepStrictEqual(filterInputs.map(input => input.disabled), [false, false]);
        } finally {
            backendApi.fetchTableCount = originalFetchCount;
            backendApi.fetchTableData = originalFetchData;
            state.selectedTable = null;
            state.isLoadingData = false;
            state.isGridReloading = false;
            state.editingCellInfo = null;
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
