import './vscode_mock_setup';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';

// Shift-range anchors (lastSelectedRowIndex / lastSelectedColumnIndex /
// lastSelectedCell) are indices into the rendered rows and columns. They must
// be dropped whenever that set is replaced, and the range loops must clamp so
// a stale in-flight anchor degrades to a short range instead of a TypeError.

const stateModulePath = '../../core/ui/modules/state.js';
const apiModulePath = '../../core/ui/modules/api.js';
const gridDataModulePath = '../../core/ui/modules/grid-data.js';
const gridActionsModulePath = '../../core/ui/modules/grid-actions.js';

function installDocumentStub() {
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
        querySelector() { return null; },
        querySelectorAll() { return []; }
    };
}

function createMouseEvent(overrides: Record<string, unknown> = {}) {
    return {
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        stopPropagation() {},
        preventDefault() {},
        ...overrides
    };
}

async function resetSelectionState() {
    const { state } = await import(stateModulePath);
    state.selectedTable = null;
    state.selectedTableType = null;
    state.tableColumns = [];
    state.gridData = [];
    state.columnFilters = {};
    state.filterQuery = '';
    state.sortedColumn = null;
    state.isLoadingData = false;
    state.isGridReloading = false;
    state.editingCellInfo = null;
    state.selectedCells = [];
    state.selectedRowIds.clear();
    state.selectedColumns.clear();
    state.lastSelectedCell = null;
    state.lastSelectedColumnIndex = null;
    state.lastSelectedRowIndex = null;
}

describe('grid selection anchors', () => {
    afterEach(async () => {
        delete (globalThis as any).document;
        delete (globalThis as any).CSS;
        await resetSelectionState();
    });

    it('drops all shift-range anchors when loadTableData commits a new page', async () => {
        installDocumentStub();
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { loadTableData } = await import(gridDataModulePath);
        const originalFetchCount = backendApi.fetchTableCount;
        const originalFetchData = backendApi.fetchTableData;
        backendApi.fetchTableCount = async () => 1;
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
        // Skip the render branch the way the existing grid-data tests do.
        state.editingCellInfo = { rowIdx: 0, colIdx: 0 };
        state.lastSelectedRowIndex = 240;
        state.lastSelectedColumnIndex = 6;
        state.lastSelectedCell = { rowIdx: 240, colIdx: 6 };

        try {
            assert.strictEqual(await loadTableData(false, false), true);
            assert.strictEqual(state.lastSelectedRowIndex, null);
            assert.strictEqual(state.lastSelectedColumnIndex, null);
            assert.strictEqual(state.lastSelectedCell, null);
        } finally {
            backendApi.fetchTableCount = originalFetchCount;
            backendApi.fetchTableData = originalFetchData;
        }
    });

    it('drops all shift-range anchors when loadTableColumns replaces the column set', async () => {
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { loadTableColumns } = await import(gridDataModulePath);
        const originalGetTableInfo = backendApi.getTableInfo;
        backendApi.getTableInfo = async () => ([
            {
                ordinal: 0,
                identifier: 'kept',
                declaredType: 'TEXT',
                isRequired: 0,
                defaultExpression: null,
                primaryKeyPosition: 0
            }
        ]);
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.lastSelectedRowIndex = 4;
        state.lastSelectedColumnIndex = 9;
        state.lastSelectedCell = { rowIdx: 4, colIdx: 9 };

        try {
            await loadTableColumns();
            assert.deepStrictEqual(state.tableColumns.map((c: any) => c.name), ['kept']);
            assert.strictEqual(state.lastSelectedRowIndex, null);
            assert.strictEqual(state.lastSelectedColumnIndex, null);
            assert.strictEqual(state.lastSelectedCell, null);
        } finally {
            backendApi.getTableInfo = originalGetTableInfo;
        }
    });

    it('clamps a stale row anchor to the current page instead of throwing', async () => {
        installDocumentStub();
        const { state } = await import(stateModulePath);
        const { onRowNumberClick } = await import(gridActionsModulePath);
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'value', type: 'TEXT' }];
        state.gridData = [[1, 'a'], [2, 'b'], [3, 'c']];
        // Anchor left over from a larger, since-replaced page.
        state.lastSelectedRowIndex = 9;

        onRowNumberClick(createMouseEvent({ shiftKey: true }), 2, 1);

        assert.deepStrictEqual([...state.selectedRowIds].sort(), [2, 3]);
    });

    it('clamps a stale cell anchor in the shift cell-range instead of throwing', async () => {
        installDocumentStub();
        const { state } = await import(stateModulePath);
        const { onCellClick } = await import(gridActionsModulePath);
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [
            { name: 'first', type: 'TEXT' },
            { name: 'second', type: 'TEXT' }
        ];
        state.gridData = [[1, 'a', 'b'], [2, 'c', 'd']];
        // Anchor left over from a larger, since-replaced page and column set.
        state.lastSelectedCell = { rowIdx: 9, colIdx: 7 };

        onCellClick(createMouseEvent({ shiftKey: true }), 1, 0, 2);

        assert.deepStrictEqual(state.selectedCells, [
            { rowIdx: 1, colIdx: 0, rowId: 2, value: 'c' },
            { rowIdx: 1, colIdx: 1, rowId: 2, value: 'd' }
        ]);
    });

    it('clamps a stale cell anchor in the cmd+shift cell-range instead of throwing', async () => {
        installDocumentStub();
        const { state } = await import(stateModulePath);
        const { onCellClick } = await import(gridActionsModulePath);
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [
            { name: 'first', type: 'TEXT' },
            { name: 'second', type: 'TEXT' }
        ];
        state.gridData = [[1, 'a', 'b'], [2, 'c', 'd']];
        state.lastSelectedCell = { rowIdx: 9, colIdx: 7 };

        onCellClick(createMouseEvent({ shiftKey: true, metaKey: true }), 1, 0, 2);

        assert.deepStrictEqual(state.selectedCells, [
            { rowIdx: 1, colIdx: 0, rowId: 2, value: 'c' },
            { rowIdx: 1, colIdx: 1, rowId: 2, value: 'd' }
        ]);
    });

    it('clamps a stale column anchor to the current column set instead of throwing', async () => {
        installDocumentStub();
        (globalThis as any).CSS = { escape: (value: string) => value };
        const { state } = await import(stateModulePath);
        const { onColumnHeaderClick } = await import(gridActionsModulePath);
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [
            { name: 'first', type: 'TEXT' },
            { name: 'second', type: 'TEXT' }
        ];
        state.gridData = [[1, 'a', 'b']];
        // Anchor left over from a wider, since-replaced column set.
        state.lastSelectedColumnIndex = 7;

        onColumnHeaderClick(createMouseEvent({ shiftKey: true }), 'first');

        assert.deepStrictEqual([...state.selectedColumns].sort(), ['first', 'second']);
        assert.strictEqual(state.selectedCells.length, 2);
    });
});
