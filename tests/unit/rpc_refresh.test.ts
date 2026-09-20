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
        { textContent: '', innerHTML: '', disabled: false }
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

it('expires the Drop View completion when Undo restores an unselected view', async () => {
    const apiModulePath = '../../core/ui/modules/api.js';
    const rpcModulePath = '../../core/ui/modules/rpc.js';
    const stateModulePath = '../../core/ui/modules/state.js';
    const viewsModulePath = '../../core/ui/modules/views.js';
    const { backendApi } = await import(apiModulePath);
    const { refreshContent } = await import(rpcModulePath);
    const { state } = await import(stateModulePath);
    const { dropViewFromSidebar } = await import(viewsModulePath);
    const originals = { dropView: backendApi.dropView, fetchSchema: backendApi.fetchSchema };
    const status = { textContent: '', innerHTML: '', disabled: false };
    paginationElements.set('statusText', status);
    paginationElements.set('tableNameLabel', { textContent: '', innerHTML: '', disabled: false });
    paginationElements.set('gridContainer', { textContent: '', innerHTML: '', disabled: false });
    let restored = false;
    backendApi.dropView = async () => ({});
    backendApi.fetchSchema = async () => ({
        tables: [], views: restored ? [{ identifier: 'editable_contacts' }] : [], indexes: []
    });
    state.isDbConnected = true;
    state.isReadOnly = false;
    state.selectedTable = 'editable_contacts';
    state.selectedTableType = 'view';
    try {
        await dropViewFromSidebar('editable_contacts');
        assert.strictEqual(state.selectedTable, null);
        assert.match(status.textContent, /View "editable_contacts" dropped/);

        restored = true;
        const result = await refreshContent('qa.db');
        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(state.schemaCache.views, [{ name: 'editable_contacts' }]);
        assert.strictEqual(state.selectedTable, null);
        assert.doesNotMatch(status.textContent, /dropped/,
            'Undo must not leave a completed drop message beside the restored view');
        assert.ok(status.textContent.length > 0, 'the unselected viewer retains a neutral status');
    } finally {
        Object.assign(backendApi, originals);
        for (const id of ['statusText', 'tableNameLabel', 'gridContainer']) paginationElements.delete(id);
        state.isDbConnected = false;
        state.selectedTable = null;
        state.selectedTableType = 'table';
    }
});

it('preserves in-flight operation and error feedback during a content refresh', async () => {
    const apiModulePath = '../../core/ui/modules/api.js';
    const rpcModulePath = '../../core/ui/modules/rpc.js';
    const stateModulePath = '../../core/ui/modules/state.js';
    const uiModulePath = '../../core/ui/modules/ui.js';
    const { backendApi } = await import(apiModulePath);
    const { refreshContent } = await import(rpcModulePath);
    const { state } = await import(stateModulePath);
    const { updateStatus } = await import(uiModulePath);
    const originalFetchSchema = backendApi.fetchSchema;
    const status = { textContent: '', innerHTML: '', disabled: false };
    paginationElements.set('statusText', status);
    backendApi.fetchSchema = async () => ({ tables: [], views: [], indexes: [] });
    state.isDbConnected = true;
    state.selectedTable = null;
    try {
        for (const message of ['Creating table...', 'Error: Save failed; retry required']) {
            updateStatus(message);
            await refreshContent('qa.db');
            assert.strictEqual(status.textContent, message);
        }
    } finally {
        backendApi.fetchSchema = originalFetchSchema;
        paginationElements.delete('statusText');
        state.isDbConnected = false;
    }
});

it('does not erase newer completion feedback when an older refresh settles', async () => {
    const apiModulePath = '../../core/ui/modules/api.js';
    const rpcModulePath = '../../core/ui/modules/rpc.js';
    const stateModulePath = '../../core/ui/modules/state.js';
    const uiModulePath = '../../core/ui/modules/ui.js';
    const { backendApi } = await import(apiModulePath);
    const { refreshContent } = await import(rpcModulePath);
    const { state } = await import(stateModulePath);
    const { updateStatus } = await import(uiModulePath);
    const originalFetchSchema = backendApi.fetchSchema;
    const status = { textContent: '', innerHTML: '', disabled: false };
    paginationElements.set('statusText', status);
    let resolveSchema!: (schema: { tables: []; views: []; indexes: [] }) => void;
    let refreshing: Promise<unknown> | undefined;
    backendApi.fetchSchema = () => new Promise(resolve => { resolveSchema = resolve; });
    state.isDbConnected = true;
    state.selectedTable = null;
    try {
        updateStatus('Older schema action completed', { clearOnRefresh: true });
        refreshing = refreshContent('qa.db');
        assert.notStrictEqual(status.textContent, 'Older schema action completed',
            'stale completion feedback must expire before the first asynchronous read');
        updateStatus('Newer schema action completed', { clearOnRefresh: true });
        resolveSchema({ tables: [], views: [], indexes: [] });
        await refreshing;
        assert.strictEqual(status.textContent, 'Newer schema action completed');

        backendApi.fetchSchema = async () => ({ tables: [], views: [], indexes: [] });
        await refreshContent('qa.db');
        assert.notStrictEqual(status.textContent, 'Newer schema action completed');
    } finally {
        resolveSchema?.({ tables: [], views: [], indexes: [] });
        await refreshing;
        backendApi.fetchSchema = originalFetchSchema;
        paginationElements.delete('statusText');
        state.isDbConnected = false;
    }
});

it('offers Reload Database without querying a retired connection', async () => {
    const apiModulePath = '../../core/ui/modules/api.js';
    const rpcModulePath = '../../core/ui/modules/rpc.js';
    const stateModulePath = '../../core/ui/modules/state.js';
    const { backendApi } = await import(apiModulePath);
    const { refreshContent } = await import(rpcModulePath);
    const { state } = await import(stateModulePath);
    const originalFetchSchema = backendApi.fetchSchema;
    let schemaReads = 0;
    backendApi.fetchSchema = async () => { schemaReads++; throw new Error('retired connection'); };
    const grid = { textContent: '', innerHTML: '', disabled: false };
    paginationElements.set('gridContainer', grid);
    state.isDbConnected = true;
    state.selectedTable = 'items';
    try {
        const result = await refreshContent('changed.db', {
            connected: true, readOnly: true, connectionGeneration: 20,
            reloadRequiredReason: 'The database file was replaced. Reload to open the current file.'
        });
        assert.equal(schemaReads, 0);
        assert.equal(result.reloadRequired, true);
        assert.match(grid.innerHTML, /Reload Database/);
        assert.match(grid.innerHTML, /database file was replaced/);
        assert.equal(state.isReadOnly, true);
    } finally {
        backendApi.fetchSchema = originalFetchSchema;
        paginationElements.delete('gridContainer');
        state.isDbConnected = false;
        state.selectedTable = null;
        state.isReadOnly = false;
        state.reloadRequiredReason = null;
    }
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

it('clears table identities, pins, and an active editor across a connection generation', async () => {
    const apiModulePath = '../../core/ui/modules/api.js';
    const rpcModulePath = '../../core/ui/modules/rpc.js';
    const stateModulePath = '../../core/ui/modules/state.js';
    const { backendApi } = await import(apiModulePath);
    const { refreshContent } = await import(rpcModulePath);
    const { state } = await import(stateModulePath);
    const originals = {
        fetchSchema: backendApi.fetchSchema,
        getTableInfo: backendApi.getTableInfo
    };
    let observedClearedState = false;
    backendApi.fetchSchema = async () => ({
        tables: [{ identifier: 'items', identity: { kind: 'rowid' } }],
        views: [],
        indexes: []
    });
    backendApi.getTableInfo = async () => {
        observedClearedState = state.selectedRowIds.size === 0
            && state.selectedColumns.size === 0
            && state.selectedCells.length === 0
            && state.pinnedRowIds.size === 0
            && state.pinnedColumns.size === 0
            && state.editingCellInfo === null
            && state.activeCellInput === null
            && state.renderedTable === null;
        throw new Error('stop after ownership assertion');
    };
    paginationElements.set('gridContainer', {
        textContent: '',
        innerHTML: '<table class="data-grid"></table>',
        disabled: false
    });
    state.isDbConnected = true;
    state.connectionGeneration = 5;
    state.selectedTable = 'items';
    state.selectedTableType = 'table';
    state.renderedTable = 'items';
    state.tableColumns = [{ name: 'value', type: 'TEXT' }];
    state.gridData = [[1, 'old']];
    state.selectedRowIds = new Set([1]);
    state.selectedColumns = new Set(['value']);
    state.selectedCells = [{ rowIdx: 0, colIdx: 0, rowId: 1, value: 'old' }];
    state.pinnedRowIds = new Set([1]);
    state.pinnedColumns = new Set(['value']);
    state.editingCellInfo = { rowIdx: 0, colIdx: 0 };
    state.activeCellInput = { value: 'draft' };

    try {
        await refreshContent('shared.db', {
            connected: true,
            readOnly: false,
            connectionGeneration: 6
        });
        assert.strictEqual(observedClearedState, true);
        assert.deepStrictEqual([...state.selectedRowIds], []);
        assert.deepStrictEqual([...state.pinnedRowIds], []);
        assert.strictEqual(state.connectionGeneration, 6);
    } finally {
        Object.assign(backendApi, originals);
        paginationElements.delete('gridContainer');
        state.isDbConnected = false;
        state.selectedTable = null;
        state.selectedTableType = 'table';
        state.renderedTable = null;
        state.selectedRowIds.clear();
        state.selectedColumns.clear();
        state.selectedCells = [];
        state.pinnedRowIds.clear();
        state.pinnedColumns.clear();
        state.editingCellInfo = null;
        state.activeCellInput = null;
    }
});

it('clears and persists selection when refresh removes the selected table', async () => {
    const apiModulePath = '../../core/ui/modules/api.js';
    const rpcModulePath = '../../core/ui/modules/rpc.js';
    const stateModulePath = '../../core/ui/modules/state.js';
    const { backendApi } = await import(apiModulePath);
    const { refreshContent } = await import(rpcModulePath);
    const { state } = await import(stateModulePath);
    const originalFetchSchema = backendApi.fetchSchema;
    const persistCountBefore = persistedStates.length;

    backendApi.fetchSchema = async () => ({ tables: [], views: [], indexes: [] });
    paginationElements.set('tableNameLabel', { textContent: '', innerHTML: '', disabled: false });
    paginationElements.set('gridContainer', { textContent: '', innerHTML: '', disabled: false });
    state.isDbConnected = true;
    state.selectedTable = 'removed_table';
    state.selectedTableType = 'table';
    state.selectedCells = [{ rowIdx: 0, colIdx: 0, rowId: 1, value: 'stale' }];
    state.selectedRowIds = new Set([1]);
    state.selectedColumns = new Set(['stale_column']);
    state.lastSelectedCell = { rowIdx: 0, colIdx: 0 };
    state.lastSelectedColumnIndex = 0;
    state.lastSelectedRowIndex = 0;

    try {
        await refreshContent('shared.db');

        assert.strictEqual(state.selectedTable, null);
        assert.deepStrictEqual(state.selectedCells, []);
        assert.deepStrictEqual([...state.selectedRowIds], []);
        assert.deepStrictEqual([...state.selectedColumns], []);
        assert.strictEqual(persistedStates.length, persistCountBefore + 1,
            'removal must persist before VS Code can hide and discard the webview');
        assert.strictEqual((persistedStates.at(-1) as any).selectedTable, null);
    } finally {
        backendApi.fetchSchema = originalFetchSchema;
        paginationElements.delete('tableNameLabel');
        paginationElements.delete('gridContainer');
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
