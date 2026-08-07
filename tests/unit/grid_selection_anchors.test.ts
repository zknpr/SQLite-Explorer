import './vscode_mock_setup';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';

// Shift-range anchors (lastSelectedRowIndex / lastSelectedColumnIndex /
// lastSelectedCell) are indices into the rendered rows and columns. They must
// be dropped whenever that set is replaced, and the range loops must clamp so
// a stale in-flight anchor degrades to a short range instead of a TypeError.
// The staged cell selection (selectedCells) is index-bearing the same way and
// additionally feeds batch Apply, so it must be dropped at the same commit
// points and the Batch Update panel must follow it.

const stateModulePath = '../../core/ui/modules/state.js';
const apiModulePath = '../../core/ui/modules/api.js';
const gridDataModulePath = '../../core/ui/modules/grid-data.js';
const gridActionsModulePath = '../../core/ui/modules/grid-actions.js';
const sidebarModulePath = '../../core/ui/modules/sidebar.js';

function makeClassListStub() {
    const classes = new Set<string>();
    return {
        add(...names: string[]) { for (const name of names) classes.add(name); },
        remove(...names: string[]) { for (const name of names) classes.delete(name); },
        contains(name: string) { return classes.has(name); }
    };
}

function installDocumentStub(
    { withBatchPanel = false, batchInputs = [] as any[] } = {}
) {
    const elements: Record<string, any> = {
        pageIndicator: { textContent: '' },
        btnFirst: { disabled: false },
        btnPrev: { disabled: false },
        btnNext: { disabled: false },
        btnLast: { disabled: false },
        statusText: { textContent: '' },
        filterMatchCounter: { textContent: '' }
    };
    if (withBatchPanel) {
        // Only the empty-selection path of updateBatchSidebar is exercised in
        // these tests, so the four guarded elements suffice (no createElement).
        elements.batchUpdateSectionTitle = { classList: makeClassListStub() };
        elements.batchUpdateList = { classList: makeClassListStub() };
        elements.batchUpdateCount = { textContent: '' };
        elements.batchUpdateFields = { replaceChildren() {} };
    }
    (globalThis as any).document = {
        getElementById(id: string) { return elements[id] ?? null; },
        querySelector() { return null; },
        querySelectorAll(selector: string) {
            return selector === '.batch-input' ? batchInputs : [];
        }
    };
    return elements;
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
    state.selectedTableIdentity = null;
    state.gridExactIntegerTexts = {};
    state.gridOversizedCells = {};
    state.gridReadOnlyRowReasons = {};
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

    it('drops the staged cell selection and hides the batch panel when loadTableData commits', async () => {
        const elements = installDocumentStub({ withBatchPanel: true });
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
        // Skip the render branch the way the existing grid-data tests do; the
        // selection must be dropped even on that kept-DOM path.
        state.editingCellInfo = { rowIdx: 0, colIdx: 0 };
        // Selection staged against the previous page/column set.
        state.selectedCells = [{ rowIdx: 3, colIdx: 2, rowId: 42, value: 'stale' }];

        try {
            assert.strictEqual(await loadTableData(false, false), true);
            assert.deepStrictEqual(state.selectedCells, []);
            assert.strictEqual(elements.batchUpdateSectionTitle.classList.contains('hidden'), true);
            assert.strictEqual(elements.batchUpdateList.classList.contains('hidden'), true);
        } finally {
            backendApi.fetchTableCount = originalFetchCount;
            backendApi.fetchTableData = originalFetchData;
        }
    });

    it('drops the staged cell selection when loadTableColumns replaces the column set', async () => {
        const elements = installDocumentStub({ withBatchPanel: true });
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
        // colIdx indexes the wider, since-replaced column set; rowId names a
        // row fetched with it. Left staged, a batch Apply would resolve the
        // index against the new columns while writing under the old row id.
        state.selectedCells = [{ rowIdx: 0, colIdx: 9, rowId: 7, value: 'stale' }];

        try {
            await loadTableColumns();
            assert.deepStrictEqual(state.tableColumns.map((c: any) => c.name), ['kept']);
            assert.deepStrictEqual(state.selectedCells, []);
            assert.strictEqual(elements.batchUpdateSectionTitle.classList.contains('hidden'), true);
        } finally {
            backendApi.getTableInfo = originalGetTableInfo;
        }
    });

    it('hides the batch panel immediately when the user switches tables', async () => {
        const elements = installDocumentStub({ withBatchPanel: true });
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { selectTableItem } = await import(sidebarModulePath);
        const originals = {
            getTableInfo: backendApi.getTableInfo,
            fetchTableCount: backendApi.fetchTableCount,
            fetchTableData: backendApi.fetchTableData
        };
        backendApi.getTableInfo = async () => ([
            {
                ordinal: 0,
                identifier: 'w',
                declaredType: 'TEXT',
                isRequired: 0,
                defaultExpression: null,
                primaryKeyPosition: 0
            }
        ]);
        backendApi.fetchTableCount = async () => 0;
        backendApi.fetchTableData = async () => ({ rows: [] });
        state.selectedTable = 'qa_items';
        state.selectedTableType = 'table';
        state.renderedTable = 'qa_items';
        state.tableColumns = [{ name: 'big', type: 'INTEGER' }];
        state.gridData = [[1, 5]];
        state.rowsPerPage = 500;
        // Panel is on screen for a staged selection in the previous table.
        state.selectedCells = [{ rowIdx: 0, colIdx: 0, rowId: 1, value: 5 }];

        try {
            await selectTableItem('qa_wr', 'table');
            assert.deepStrictEqual(state.selectedCells, []);
            // The stale panel was the observed bug: state was cleared but the
            // Batch Update section kept showing the previous table's column.
            assert.strictEqual(elements.batchUpdateSectionTitle.classList.contains('hidden'), true);
            assert.strictEqual(elements.batchUpdateList.classList.contains('hidden'), true);
        } finally {
            backendApi.getTableInfo = originals.getTableInfo;
            backendApi.fetchTableCount = originals.fetchTableCount;
            backendApi.fetchTableData = originals.fetchTableData;
        }
    });

    it('keeps the post-apply batch selection rebuild working across the reload', async () => {
        // applyBatchUpdate deliberately clears selectedCells, reloads, then
        // rebuilds the selection by row identity and column NAME. Clearing
        // inside loadTableData must not break that reconciliation.
        installDocumentStub({
            batchInputs: [{ value: 'updated', dataset: { colidx: '1' } }]
        });
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { applyBatchUpdate } = await import(sidebarModulePath);
        const originals = {
            updateCellBatch: backendApi.updateCellBatch,
            fetchTableCount: backendApi.fetchTableCount,
            fetchTableData: backendApi.fetchTableData
        };
        let sentUpdates: any = null;
        backendApi.updateCellBatch = async (_table: string, updates: any) => {
            sentUpdates = updates;
            return [];
        };
        backendApi.fetchTableCount = async () => 2;
        // The updated row comes back at a DIFFERENT index (moved by ordering),
        // which the identity-based rebuild must resolve.
        backendApi.fetchTableData = async () => ({
            rows: [[3, 'id3', 'zzz'], [7, 'id7', 'updated']]
        });
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.selectedTableIdentity = null;
        state.renderedTable = 'items';
        state.tableColumns = [
            { name: 'id', type: 'TEXT' },
            { name: 'value', type: 'TEXT' }
        ];
        state.gridData = [[7, 'id7', 'old']];
        state.currentPageIndex = 0;
        state.rowsPerPage = 500;
        state.columnFilters = {};
        state.filterQuery = '';
        state.editingCellInfo = null;
        state.selectedCells = [{ rowIdx: 0, colIdx: 1, rowId: 7, value: 'old' }];

        try {
            await applyBatchUpdate();
            assert.deepStrictEqual(sentUpdates, [{
                rowId: 7,
                column: 'value',
                value: 'updated',
                originalValue: 'old',
                operation: 'set'
            }]);
            assert.deepStrictEqual(state.selectedCells, [
                { rowIdx: 1, colIdx: 1, rowId: 7, value: 'updated' }
            ]);
            assert.deepStrictEqual(state.lastSelectedCell, { rowIdx: 1, colIdx: 1 });
            // The catch path reports through the status line; requiring the
            // success message proves the flow did not silently fail mid-way.
            assert.strictEqual(
                (globalThis as any).document.getElementById('statusText').textContent,
                'Batch update completed'
            );
        } finally {
            backendApi.updateCellBatch = originals.updateCellBatch;
            backendApi.fetchTableCount = originals.fetchTableCount;
            backendApi.fetchTableData = originals.fetchTableData;
        }
    });
});
