import './vscode_mock_setup';

import assert from 'node:assert';
import { after, it } from 'node:test';

const persistedStates: unknown[] = [];
(globalThis as any).acquireVsCodeApi = () => ({
    getState: () => undefined,
    setState: (value: unknown) => persistedStates.push(value),
    postMessage() {}
});

const paginationElements = new Map(
    ['pageIndicator', 'btnFirst', 'btnPrev', 'btnNext', 'btnLast', 'btnOpenCreateView'].map(id => [
        id,
        { textContent: '', disabled: false }
    ])
);
(globalThis as any).document = {
    getElementById(id: string) {
        return paginationElements.get(id) ?? null;
    },
    querySelectorAll() {
        return [];
    }
};

after(() => {
    delete (globalThis as any).acquireVsCodeApi;
    delete (globalThis as any).document;
});

it('clears positional selection before externally refreshing a displayed view', async () => {
    const apiModulePath = '../../core/ui/modules/api.js';
    const rpcModulePath = '../../core/ui/modules/rpc.js';
    const stateModulePath = '../../core/ui/modules/state.js';
    const { backendApi } = await import(apiModulePath);
    const { refreshContent } = await import(rpcModulePath);
    const { state } = await import(stateModulePath);
    const originalApi = {
        fetchSchema: backendApi.fetchSchema,
        getTableInfo: backendApi.getTableInfo,
        fetchTableCount: backendApi.fetchTableCount,
        fetchTableData: backendApi.fetchTableData
    };

    state.isDbConnected = true;
    state.selectedTable = 'shared_view';
    state.selectedTableType = 'view';
    state.selectedCells = [{ rowIdx: 2, colIdx: 1, rowId: 2, value: 'old' }];
    state.selectedRowIds = new Set([2]);
    state.selectedColumns = new Set(['old_column']);
    state.lastSelectedCell = { rowIdx: 2, colIdx: 1 };
    state.lastSelectedColumnIndex = 1;
    state.lastSelectedRowIndex = 2;

    let columnsLoadedAfterClear = false;
    backendApi.fetchSchema = async () => ({
        tables: [],
        views: [{ identifier: 'shared_view' }],
        indexes: []
    });
    backendApi.getTableInfo = async () => {
        columnsLoadedAfterClear = state.selectedCells.length === 0
            && state.selectedRowIds.size === 0
            && state.selectedColumns.size === 0
            && state.lastSelectedCell === null
            && state.lastSelectedColumnIndex === null
            && state.lastSelectedRowIndex === null;
        return [{
            ordinal: 0,
            identifier: 'new_column',
            declaredType: 'TEXT',
            isRequired: false,
            defaultExpression: null,
            primaryKeyPosition: 0
        }];
    };
    backendApi.fetchTableCount = async () => 0;
    backendApi.fetchTableData = async () => ({ rows: [] });

    try {
        await refreshContent('shared.db');

        assert.strictEqual(columnsLoadedAfterClear, true);
        assert.deepStrictEqual(state.selectedCells, []);
        assert.deepStrictEqual([...state.selectedRowIds], []);
        assert.deepStrictEqual([...state.selectedColumns], []);
    } finally {
        Object.assign(backendApi, originalApi);
        state.isDbConnected = false;
        state.selectedTable = null;
        state.selectedTableType = 'table';
        state.selectedCells = [];
        state.selectedRowIds.clear();
        state.selectedColumns.clear();
        state.lastSelectedCell = null;
        state.lastSelectedColumnIndex = null;
        state.lastSelectedRowIndex = null;
    }
});

it('re-applies read-only capabilities carried by a reload refresh', async () => {
    const apiModulePath = '../../core/ui/modules/api.js';
    const rpcModulePath = '../../core/ui/modules/rpc.js';
    const stateModulePath = '../../core/ui/modules/state.js';
    const { backendApi } = await import(apiModulePath);
    const { refreshContent } = await import(rpcModulePath);
    const { state } = await import(stateModulePath);
    const originalFetchSchema = backendApi.fetchSchema;

    backendApi.fetchSchema = async () => ({ tables: [], views: [], indexes: [] });
    state.isDbConnected = true;
    state.isReadOnly = false;
    state.selectedTable = null;
    const createViewButton = paginationElements.get('btnOpenCreateView')!;
    createViewButton.disabled = false;

    try {
        await refreshContent('shared.db', { connected: true, readOnly: true });
        assert.strictEqual(state.isReadOnly, true);
        assert.strictEqual(createViewButton.disabled, true);

        await refreshContent('shared.db', { connected: true, readOnly: false });
        assert.strictEqual(state.isReadOnly, false);
        assert.strictEqual(createViewButton.disabled, false);
    } finally {
        backendApi.fetchSchema = originalFetchSchema;
        state.isDbConnected = false;
        state.isReadOnly = false;
        state.selectedTable = null;
    }
});
