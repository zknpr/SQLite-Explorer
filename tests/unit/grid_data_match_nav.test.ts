import './vscode_mock_setup';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';

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

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(resolvePromise => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

describe('grid data match cache', () => {
    afterEach(() => {
        delete (globalThis as any).document;
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
});
