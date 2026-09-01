import './vscode_mock_setup';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { createDeferred } from './helpers/deferred';

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
const dataUtilsModulePath = '../../core/ui/modules/data-utils.js';

function makeClassListStub() {
    const classes = new Set<string>();
    return {
        add(...names: string[]) { for (const name of names) classes.add(name); },
        remove(...names: string[]) { for (const name of names) classes.delete(name); },
        contains(name: string) { return classes.has(name); }
    };
}

function installDocumentStub(
    { withBatchPanel = false, withGrid = false, batchInputs = [] as any[] } = {}
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
    if (withGrid) {
        elements.gridContainer = {
            innerHTML: '<table class="data-grid"><tbody><tr><td>stale</td></tr></tbody></table>',
            querySelector() { return null; }
        };
    }
    if (withBatchPanel) {
        // Only the empty-selection path of updateBatchSidebar is exercised in
        // these tests, so no document fragment or element factory is needed.
        elements.batchUpdateSectionTitle = {
            classList: makeClassListStub(),
            title: '',
            setAttribute() {}
        };
        elements.batchUpdateList = { classList: makeClassListStub() };
        elements.batchUpdateCount = { textContent: '' };
        elements.batchUpdateFields = {
            children: [] as unknown[],
            replaceChildren(...children: unknown[]) { this.children = children; }
        };
        elements.btnApplyBatchUpdate = { disabled: false };
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
    state.pinnedRowIds.clear();
    state.selectedColumns.clear();
    state.lastSelectedCell = null;
    state.lastSelectedColumnIndex = null;
    state.lastSelectedRowIndex = null;
    state.selectedTableIdentity = null;
    state.gridExactIntegerTexts = {};
    state.gridOversizedCells = {};
    state.gridReadOnlyRowReasons = {};
    state.keysetAnchors = null;
    state.renderedTable = null;
    state.schemaCache = { tables: [], views: [], indexes: [] };
    state.isDbConnected = false;
}

describe('grid selection anchors', () => {
    afterEach(async () => {
        delete (globalThis as any).document;
        delete (globalThis as any).CSS;
        await resetSelectionState();
        // The count cache is module state shared across this process; clear it
        // so the next test's count mock always gets its first fetch.
        const countCacheModulePath = '../../core/ui/modules/count-cache.js';
        const { invalidateAllCounts } = await import(countCacheModulePath);
        invalidateAllCounts();
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

    it('clears ordinal view row selections and pins when a reload replaces their rows', async () => {
        installDocumentStub();
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { loadTableData } = await import(gridDataModulePath);
        const originalFetchCount = backendApi.fetchTableCount;
        const originalFetchData = backendApi.fetchTableData;
        backendApi.fetchTableCount = async () => 2;
        backendApi.fetchTableData = async () => ({ rows: [['B'], ['A']] });
        state.selectedTable = 'sorted_view';
        state.selectedTableType = 'view';
        state.renderedTable = 'sorted_view';
        state.tableColumns = [{ name: 'value', type: 'TEXT' }];
        state.gridData = [['A'], ['B']];
        state.currentPageIndex = 0;
        state.rowsPerPage = 500;
        state.columnFilters = {};
        state.filterQuery = '';
        state.editingCellInfo = { rowIdx: 0, colIdx: 0 };
        // View row IDs are only current-page ordinals. Keeping ordinal 0 after
        // the replacement would silently retarget A's selection/pin to B.
        state.selectedRowIds = new Set([0]);
        state.pinnedRowIds = new Set([0]);

        try {
            assert.strictEqual(await loadTableData(false, false), true);
            assert.deepStrictEqual([...state.selectedRowIds], []);
            assert.deepStrictEqual([...state.pinnedRowIds], []);
        } finally {
            backendApi.fetchTableCount = originalFetchCount;
            backendApi.fetchTableData = originalFetchData;
        }
    });

    it('drops all shift-range anchors when loadTableColumns replaces the column set', async () => {
        installDocumentStub();
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

    it('selects shift ranges in pinned-first visual order', async () => {
        installDocumentStub();
        (globalThis as any).CSS = { escape: (value: string) => value };
        const { state } = await import(stateModulePath);
        const {
            onCellClick,
            onColumnHeaderClick,
            onRowNumberClick
        } = await import(gridActionsModulePath);
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [
            { name: 'a', type: 'TEXT' },
            { name: 'b', type: 'TEXT' },
            { name: 'c', type: 'TEXT' }
        ];
        state.gridData = [
            [1, '1a', '1b', '1c'],
            [2, '2a', '2b', '2c'],
            [3, '3a', '3b', '3c']
        ];
        state.pinnedColumns.add('c');
        state.pinnedRowIds.add(3);

        state.lastSelectedColumnIndex = 2;
        onColumnHeaderClick(createMouseEvent({ shiftKey: true }), 'b');
        assert.deepStrictEqual([...state.selectedColumns], ['c', 'a', 'b']);

        state.lastSelectedRowIndex = 2;
        onRowNumberClick(createMouseEvent({ shiftKey: true }), 2, 1);
        assert.deepStrictEqual([...state.selectedRowIds], [3, 1, 2]);

        state.lastSelectedCell = { rowIdx: 2, colIdx: 2 };
        onCellClick(createMouseEvent({ shiftKey: true }), 1, 1, 2);
        assert.strictEqual(state.selectedCells.length, 9);
        assert.deepStrictEqual(
            state.selectedCells.map((cell: any) => [cell.rowIdx, cell.colIdx]),
            [
                [2, 2], [2, 0], [2, 1],
                [0, 2], [0, 0], [0, 1],
                [1, 2], [1, 0], [1, 1]
            ]
        );
    });

    it('drops column-delete intent when a cell-selection gesture takes over', async () => {
        installDocumentStub();
        (globalThis as any).CSS = { escape: (value: string) => value };
        const { state } = await import(stateModulePath);
        const { onCellClick } = await import(gridActionsModulePath);
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [
            { name: 'first', type: 'TEXT' },
            { name: 'second', type: 'TEXT' }
        ];
        state.gridData = [
            [1, '1a', '1b'],
            [2, '2a', '2b']
        ];
        state.selectedColumns.add('first');
        state.selectedCells = [
            { rowIdx: 0, colIdx: 0, rowId: 1, value: '1a' },
            { rowIdx: 1, colIdx: 0, rowId: 2, value: '2a' }
        ];
        state.lastSelectedColumnIndex = 0;

        onCellClick(createMouseEvent({ metaKey: true }), 0, 1, 1);

        assert.deepStrictEqual(
            [...state.selectedColumns],
            [],
            'an individual-cell gesture must not retain destructive column selection'
        );
        assert.strictEqual(state.lastSelectedColumnIndex, null);
        assert.deepStrictEqual(
            state.selectedCells.map((cell: any) => [cell.rowIdx, cell.colIdx]),
            [[0, 0], [1, 0], [0, 1]],
            'the non-destructive cell selection itself remains intact'
        );
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

    it('clears every staged-cell batch affordance when the user switches tables', async () => {
        const elements = installDocumentStub({ withBatchPanel: true });
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { selectTableItem } = await import(sidebarModulePath);
        const { getBatchSelectionEligibility } = await import(dataUtilsModulePath);
        const originals = {
            getTableInfo: backendApi.getTableInfo,
            fetchTableCount: backendApi.fetchTableCount,
            fetchTableData: backendApi.fetchTableData
        };
        let clearedBeforeNewTableMetadata = false;
        backendApi.getTableInfo = async () => {
            assert.deepStrictEqual(state.selectedCells, []);
            assert.deepStrictEqual(getBatchSelectionEligibility(), {
                cells: [],
                readOnlyCount: 0,
                readOnlyReason: undefined
            });
            assert.strictEqual(state.lastSelectedCell, null);
            assert.strictEqual(state.lastSelectedRowIndex, null);
            assert.strictEqual(state.lastSelectedColumnIndex, null);
            assert.deepStrictEqual([...state.selectedRowIds], []);
            assert.deepStrictEqual([...state.selectedColumns], []);
            assert.deepStrictEqual([...state.pinnedRowIds], []);
            assert.deepStrictEqual([...state.pinnedColumns], []);
            assert.strictEqual(elements.batchUpdateCount.textContent, '0');
            assert.strictEqual(elements.batchUpdateSectionTitle.title, '');
            assert.deepStrictEqual(elements.batchUpdateFields.children, []);
            assert.strictEqual(elements.btnApplyBatchUpdate.disabled, true);
            clearedBeforeNewTableMetadata = true;
            return [{
                ordinal: 0,
                identifier: 'w',
                declaredType: 'TEXT',
                isRequired: 0,
                defaultExpression: null,
                primaryKeyPosition: 0
            }];
        };
        backendApi.fetchTableCount = async () => 0;
        backendApi.fetchTableData = async () => ({ rows: [] });
        state.selectedTable = 'qa_items';
        state.selectedTableType = 'table';
        state.renderedTable = 'qa_items';
        state.tableColumns = [
            { name: 'note', type: 'TEXT' },
            { name: 'big', type: 'TEXT' }
        ];
        state.gridData = [[5, 'target', 'bounded preview']];
        state.gridOversizedCells = {
            0: { 2: { storageClass: 'text', byteLength: 1_200_000 } }
        };
        state.rowsPerPage = 500;
        // One editable cell and one contained read-only cell are staged against
        // the previous table, with every range anchor and pin kind populated.
        state.selectedCells = [
            { rowIdx: 0, colIdx: 0, rowId: 5, value: 'target' },
            { rowIdx: 0, colIdx: 1, rowId: 5, value: 'bounded preview' }
        ];
        state.selectedRowIds.add(5);
        state.selectedColumns.add('note');
        state.lastSelectedCell = { rowIdx: 0, colIdx: 1 };
        state.lastSelectedRowIndex = 0;
        state.lastSelectedColumnIndex = 1;
        state.pinnedRowIds.add(5);
        state.pinnedColumns.add('note');
        const initialEligibility = getBatchSelectionEligibility();
        assert.strictEqual(initialEligibility.cells.length, 1);
        assert.strictEqual(initialEligibility.readOnlyCount, 1);
        assert.match(initialEligibility.readOnlyReason, /1,200,000 bytes/);
        const staleReason =
            '1 read-only selected cell excluded: Too large to edit inline — 1,200,000 bytes (TEXT)';
        elements.batchUpdateCount.textContent = '1';
        elements.batchUpdateSectionTitle.title = staleReason;
        elements.batchUpdateFields.replaceChildren(
            { className: 'batch-selection-notice', textContent: staleReason },
            { className: 'batch-input', value: 'wrong-table write' }
        );

        try {
            await selectTableItem('qa_wr', 'table');
            assert.strictEqual(clearedBeforeNewTableMetadata, true);
            assert.deepStrictEqual(state.selectedCells, []);
            assert.strictEqual(elements.batchUpdateSectionTitle.classList.contains('hidden'), true);
            assert.strictEqual(elements.batchUpdateList.classList.contains('hidden'), true);
            assert.strictEqual(elements.batchUpdateCount.textContent, '0');
            assert.strictEqual(elements.batchUpdateSectionTitle.title, '');
            assert.deepStrictEqual(elements.batchUpdateFields.children, []);
            assert.strictEqual(elements.btnApplyBatchUpdate.disabled, true);
        } finally {
            backendApi.getTableInfo = originals.getTableInfo;
            backendApi.fetchTableCount = originals.fetchTableCount;
            backendApi.fetchTableData = originals.fetchTableData;
        }
    });

    it('does not let an older table selection commit columns or query after a newer selection', async () => {
        installDocumentStub();
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { selectTableItem } = await import(sidebarModulePath);
        const originals = {
            getTableInfo: backendApi.getTableInfo,
            fetchTableCount: backendApi.fetchTableCount,
            fetchTableData: backendApi.fetchTableData
        };
        const tableAInfo = createDeferred<any[]>();
        const tableBInfo = createDeferred<any[]>();
        const dataCalls: Array<{ table: string; columns: string[] }> = [];
        backendApi.getTableInfo = async (table: string) => (
            table === 'table_a' ? tableAInfo.promise : tableBInfo.promise
        );
        backendApi.fetchTableCount = async () => 0;
        backendApi.fetchTableData = async (table: string, options: any) => {
            dataCalls.push({ table, columns: [...options.columns] });
            return { rows: [] };
        };
        state.schemaCache = {
            tables: [
                { name: 'table_a', identity: { kind: 'rowid' } },
                { name: 'table_b', identity: { kind: 'rowid' } }
            ],
            views: [],
            indexes: []
        };
        state.rowsPerPage = 500;

        try {
            const firstSelection = selectTableItem('table_a', 'table');
            const secondSelection = selectTableItem('table_b', 'table');

            tableBInfo.resolve([{
                ordinal: 0,
                identifier: 'b_value',
                declaredType: 'TEXT',
                isRequired: 0,
                defaultExpression: null,
                primaryKeyPosition: 0
            }]);
            await secondSelection;

            tableAInfo.resolve([{
                ordinal: 0,
                identifier: 'a_value',
                declaredType: 'TEXT',
                isRequired: 0,
                defaultExpression: null,
                primaryKeyPosition: 0
            }]);
            await firstSelection;

            assert.strictEqual(state.selectedTable, 'table_b');
            assert.deepStrictEqual(state.tableColumns.map((column: any) => column.name), ['b_value']);
            assert.deepStrictEqual(dataCalls, [{
                table: 'table_b',
                columns: ['rowid', 'b_value']
            }]);
        } finally {
            backendApi.getTableInfo = originals.getTableInfo;
            backendApi.fetchTableCount = originals.fetchTableCount;
            backendApi.fetchTableData = originals.fetchTableData;
        }
    });

    it('quarantines the previous grid while a new table metadata load is pending or fails', async () => {
        const elements = installDocumentStub({ withGrid: true });
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { selectTableItem } = await import(sidebarModulePath);
        const originalGetTableInfo = backendApi.getTableInfo;
        const tableInfo = createDeferred<any[]>();
        backendApi.getTableInfo = async () => tableInfo.promise;
        state.selectedTable = 'table_a';
        state.selectedTableType = 'table';
        state.renderedTable = 'table_a';
        state.tableColumns = [{ name: 'shared', type: 'TEXT' }];
        state.gridData = [[1, 'old value']];
        state.gridExactIntegerTexts = { 0: { 1: '9007199254740993' } };
        state.gridOversizedCells = {
            0: { 1: { storageClass: 'text', byteLength: 1_000_000 } }
        };
        state.gridReadOnlyRowReasons = { 0: 'old identity' };
        state.keysetAnchors = { table: 'table_a', pageIndex: 0, first: 'a', last: 'b' };

        try {
            const selection = selectTableItem('table_b', 'table');

            assert.deepStrictEqual(state.tableColumns, []);
            assert.deepStrictEqual(state.gridData, []);
            assert.deepStrictEqual(state.gridExactIntegerTexts, {});
            assert.deepStrictEqual(state.gridOversizedCells, {});
            assert.deepStrictEqual(state.gridReadOnlyRowReasons, {});
            assert.strictEqual(state.keysetAnchors, null);
            assert.strictEqual(state.renderedTable, null);
            assert.match(elements.gridContainer.innerHTML, /Loading/);

            tableInfo.reject(new Error('metadata unavailable'));
            await selection;
            assert.match(elements.gridContainer.innerHTML, /Unable to load table columns/);
        } finally {
            backendApi.getTableInfo = originalGetTableInfo;
        }
    });

    it('commits only the newest overlapping schema refresh', async () => {
        installDocumentStub();
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { refreshSchema } = await import(sidebarModulePath);
        const originalFetchSchema = backendApi.fetchSchema;
        const first = createDeferred<any>();
        const second = createDeferred<any>();
        let callCount = 0;
        backendApi.fetchSchema = async () => (++callCount === 1 ? first.promise : second.promise);
        state.isDbConnected = true;

        try {
            const olderRefresh = refreshSchema();
            const newerRefresh = refreshSchema();
            second.resolve({
                tables: [
                    { identifier: 'table_a' },
                    { identifier: 'table_b' }
                ],
                views: [],
                indexes: []
            });
            assert.strictEqual(await newerRefresh, true);
            first.resolve({ tables: [{ identifier: 'table_a' }], views: [], indexes: [] });
            assert.strictEqual(await olderRefresh, false);
            assert.deepStrictEqual(
                state.schemaCache.tables.map((table: any) => table.name),
                ['table_a', 'table_b']
            );
        } finally {
            backendApi.fetchSchema = originalFetchSchema;
        }
    });

    it('propagates a schema refresh failure instead of allowing a success status', async () => {
        const elements = installDocumentStub();
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { refreshSchema } = await import(sidebarModulePath);
        const originalFetchSchema = backendApi.fetchSchema;
        backendApi.fetchSchema = async () => { throw new Error('schema offline'); };
        state.isDbConnected = true;

        try {
            await assert.rejects(refreshSchema(), /schema offline/);
            assert.strictEqual(elements.statusText.textContent, 'Error loading schema');
        } finally {
            backendApi.fetchSchema = originalFetchSchema;
        }
    });

    it('coalesces Reload and clears colliding selections and pins before reopening', async () => {
        const elements = installDocumentStub({ withGrid: true });
        elements['blob-inspector-modal'] = { classList: makeClassListStub() };
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { reloadFromDisk } = await import(sidebarModulePath);
        const originals = {
            refreshFile: backendApi.refreshFile,
            fetchSchema: backendApi.fetchSchema,
            getTableInfo: backendApi.getTableInfo,
            fetchTableCount: backendApi.fetchTableCount,
            fetchTableData: backendApi.fetchTableData
        };
        const refresh = createDeferred<any>();
        const schema = createDeferred<any>();
        let refreshCalls = 0;
        backendApi.refreshFile = async () => {
            refreshCalls++;
            return refresh.promise;
        };
        backendApi.fetchSchema = async () => schema.promise;
        backendApi.getTableInfo = async () => ([{
            ordinal: 0,
            identifier: 'value',
            declaredType: 'TEXT',
            isRequired: 0,
            defaultExpression: null,
            primaryKeyPosition: 0
        }]);
        backendApi.fetchTableCount = async () => 1;
        backendApi.fetchTableData = async () => ({ rows: [[1, 'replacement']] });
        state.isDbConnected = true;
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.renderedTable = 'items';
        state.tableColumns = [{ name: 'value', type: 'TEXT' }];
        state.gridData = [[1, 'original']];
        state.selectedRowIds.add(1);
        state.selectedColumns.add('value');
        state.selectedCells = [{ rowIdx: 0, colIdx: 0, rowId: 1, value: 'original' }];
        state.pinnedRowIds.add(1);
        state.pinnedColumns.add('value');

        try {
            const firstReload = reloadFromDisk();
            const duplicateReload = reloadFromDisk();
            assert.strictEqual(refreshCalls, 1);
            // A cancelled/failed host reload leaves the still-current grid
            // usable; generation-bound state clears only after success.
            assert.deepStrictEqual([...state.selectedRowIds], [1]);
            assert.deepStrictEqual([...state.pinnedRowIds], [1]);

            refresh.resolve({ connected: true, readOnly: false });
            await new Promise(resolve => setTimeout(resolve, 0));
            assert.deepStrictEqual([...state.selectedRowIds], []);
            assert.deepStrictEqual([...state.selectedColumns], []);
            assert.deepStrictEqual(state.selectedCells, []);
            assert.deepStrictEqual([...state.pinnedRowIds], []);
            assert.deepStrictEqual([...state.pinnedColumns], []);
            assert.strictEqual(state.renderedTable, null);
            assert.strictEqual(
                elements['blob-inspector-modal'].classList.contains('hidden'),
                true,
                'database-targeted modals must close when Reload replaces the connection'
            );
            assert.match(elements.gridContainer.innerHTML, /Loading/);
            // The grid renderer itself is covered elsewhere; omit the minimal
            // markup stub before the successful data commit in this ownership test.
            delete elements.gridContainer;

            schema.resolve({
                tables: [{ identifier: 'items', identity: { kind: 'rowid' } }],
                views: [],
                indexes: []
            });
            await Promise.all([firstReload, duplicateReload]);
            assert.deepStrictEqual(state.gridData, [[1, 'replacement']]);
            assert.deepStrictEqual([...state.selectedRowIds], []);
            assert.deepStrictEqual([...state.pinnedRowIds], []);
        } finally {
            backendApi.refreshFile = originals.refreshFile;
            backendApi.fetchSchema = originals.fetchSchema;
            backendApi.getTableInfo = originals.getTableInfo;
            backendApi.fetchTableCount = originals.fetchTableCount;
            backendApi.fetchTableData = originals.fetchTableData;
        }
    });

    it('keeps the current grid and selections usable when Reload is cancelled', async () => {
        const elements = installDocumentStub({ withGrid: true });
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { reloadFromDisk } = await import(sidebarModulePath);
        const originalRefreshFile = backendApi.refreshFile;
        backendApi.refreshFile = async () => { throw new Error('Canceled'); };
        state.isDbConnected = true;
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.renderedTable = 'items';
        state.tableColumns = [{ name: 'value', type: 'TEXT' }];
        state.gridData = [[1, 'original']];
        state.selectedRowIds.add(1);
        state.selectedColumns.add('value');
        state.pinnedRowIds.add(1);
        state.pinnedColumns.add('value');
        const originalMarkup = elements.gridContainer.innerHTML;

        try {
            await reloadFromDisk();
            assert.deepStrictEqual(state.gridData, [[1, 'original']]);
            assert.deepStrictEqual([...state.selectedRowIds], [1]);
            assert.deepStrictEqual([...state.selectedColumns], ['value']);
            assert.deepStrictEqual([...state.pinnedRowIds], [1]);
            assert.deepStrictEqual([...state.pinnedColumns], ['value']);
            assert.strictEqual(state.renderedTable, 'items');
            assert.strictEqual(elements.gridContainer.innerHTML, originalMarkup);
            assert.strictEqual(elements.statusText.textContent, 'Reload cancelled');
        } finally {
            backendApi.refreshFile = originalRefreshFile;
        }
    });

    it('clears the cell and column-header selection after applying a batch update', async () => {
        installDocumentStub({
            batchInputs: [{ value: 'updated', dataset: { colidx: '1' } }]
        });
        const selectedHeader = { classList: makeClassListStub() };
        selectedHeader.classList.add('column-selected');
        const documentStub = (globalThis as any).document;
        const originalQuerySelectorAll = documentStub.querySelectorAll;
        documentStub.querySelectorAll = (selector: string) => {
            if (selector === '.header-cell.column-selected') return [selectedHeader];
            return originalQuerySelectorAll(selector);
        };
        documentStub.querySelector = (selector: string) => (
            selector === '.header-cell[data-column="value"]' ? selectedHeader : null
        );
        (globalThis as any).CSS = { escape: (value: string) => value };
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { applyBatchUpdate } = await import(sidebarModulePath);
        const originals = {
            updateCellBatch: backendApi.updateCellBatch,
            fetchTableCount: backendApi.fetchTableCount,
            fetchTableData: backendApi.fetchTableData
        };
        let sentUpdates: any = null;
        let sentLabel: string | undefined;
        backendApi.updateCellBatch = async (_table: string, updates: any, label?: string) => {
            sentUpdates = updates;
            sentLabel = label;
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
        state.selectedColumns.add('value');

        try {
            await applyBatchUpdate();
            assert.deepStrictEqual(sentUpdates, [{
                rowId: 7,
                column: 'value',
                value: 'updated',
                originalValue: 'old',
                operation: 'set'
            }]);
            assert.strictEqual(sentLabel, 'Batch update 1 cell');
            assert.deepStrictEqual(state.selectedCells, []);
            assert.deepStrictEqual([...state.selectedColumns], []);
            assert.strictEqual(state.lastSelectedCell, null);
            assert.strictEqual(selectedHeader.classList.contains('column-selected'), false);
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

    it('does not remap another table\'s colliding selections after a batch RPC completes', async () => {
        installDocumentStub({
            batchInputs: [{ value: 'updated', dataset: { colidx: '0' } }]
        });
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { applyBatchUpdate } = await import(sidebarModulePath);
        const originals = {
            updateCellBatch: backendApi.updateCellBatch,
            fetchTableCount: backendApi.fetchTableCount,
            fetchTableData: backendApi.fetchTableData
        };
        const collidingIdentity = 'pk:shared-opaque-identity';
        const tableANewIdentity = 'pk:table-a-new-identity';
        backendApi.updateCellBatch = async () => {
            // The user switches to table B while table A's mutation is in flight.
            state.selectedTable = 'table_b';
            state.renderedTable = 'table_b';
            state.tableColumns = [{ name: 'value', type: 'TEXT' }];
            state.gridData = [[collidingIdentity, 'table-b-value']];
            return [{
                rowId: collidingIdentity,
                newRowId: tableANewIdentity,
                columnName: 'value'
            }];
        };
        backendApi.fetchTableCount = async () => 1;
        backendApi.fetchTableData = async () => ({
            rows: [[collidingIdentity, 'table-b-value']]
        });
        state.selectedTable = 'table_a';
        state.selectedTableType = 'table';
        state.selectedTableIdentity = { kind: 'primaryKey' };
        state.renderedTable = 'table_a';
        state.tableColumns = [{ name: 'value', type: 'TEXT' }];
        state.gridData = [[collidingIdentity, 'old']];
        state.currentPageIndex = 0;
        state.rowsPerPage = 500;
        state.columnFilters = {};
        state.filterQuery = '';
        state.editingCellInfo = null;
        state.selectedCells = [{
            rowIdx: 0,
            colIdx: 0,
            rowId: collidingIdentity,
            value: 'old'
        }];
        state.selectedRowIds = new Set([collidingIdentity]);
        state.pinnedRowIds = new Set([collidingIdentity]);

        try {
            await applyBatchUpdate();
            assert.strictEqual(state.selectedTable, 'table_b');
            assert.deepStrictEqual([...state.selectedRowIds], [collidingIdentity]);
            assert.deepStrictEqual([...state.pinnedRowIds], [collidingIdentity]);
        } finally {
            backendApi.updateCellBatch = originals.updateCellBatch;
            backendApi.fetchTableCount = originals.fetchTableCount;
            backendApi.fetchTableData = originals.fetchTableData;
        }
    });

    it('coalesces duplicate Batch Apply clicks and leaves a newly selected table untouched', async () => {
        const elements = installDocumentStub({
            batchInputs: [{ value: 'updated', dataset: { colidx: '0' } }]
        });
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { applyBatchUpdate } = await import(sidebarModulePath);
        const originals = {
            updateCellBatch: backendApi.updateCellBatch,
            fetchTableCount: backendApi.fetchTableCount,
            fetchTableData: backendApi.fetchTableData
        };
        const update = createDeferred<any[]>();
        let updateCalls = 0;
        let reloadCalls = 0;
        backendApi.updateCellBatch = async () => {
            updateCalls += 1;
            return update.promise;
        };
        backendApi.fetchTableCount = async () => {
            reloadCalls += 1;
            return 1;
        };
        backendApi.fetchTableData = async () => ({ rows: [[90, 'from reload']] });
        state.selectedTable = 'table_a';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'value', type: 'TEXT' }];
        state.gridData = [[1, 'one'], [2, 'two'], [3, 'three']];
        state.selectedCells = [{ rowIdx: 2, colIdx: 0, rowId: 3, value: 'three' }];
        state.selectedColumns = new Set(['value']);
        state.lastSelectedCell = { rowIdx: 2, colIdx: 0 };

        try {
            const first = applyBatchUpdate();
            const duplicate = applyBatchUpdate();
            assert.strictEqual(updateCalls, 1);

            state.selectedTable = 'table_b';
            state.tableColumns = [{ name: 'other', type: 'TEXT' }];
            state.gridData = [[99, 'table-b-value']];
            state.selectedCells = [{ rowIdx: 0, colIdx: 0, rowId: 99, value: 'table-b-value' }];
            state.selectedColumns = new Set(['other']);
            state.lastSelectedCell = { rowIdx: 0, colIdx: 0 };
            elements.statusText.textContent = 'Table B ready';

            update.resolve([]);
            await Promise.all([first, duplicate]);

            assert.strictEqual(updateCalls, 1);
            assert.strictEqual(reloadCalls, 0);
            assert.deepStrictEqual(state.gridData, [[99, 'table-b-value']]);
            assert.deepStrictEqual(state.selectedCells, [
                { rowIdx: 0, colIdx: 0, rowId: 99, value: 'table-b-value' }
            ]);
            assert.deepStrictEqual([...state.selectedColumns], ['other']);
            assert.deepStrictEqual(state.lastSelectedCell, { rowIdx: 0, colIdx: 0 });
            assert.strictEqual(elements.statusText.textContent, 'Table B ready');
        } finally {
            backendApi.updateCellBatch = originals.updateCellBatch;
            backendApi.fetchTableCount = originals.fetchTableCount;
            backendApi.fetchTableData = originals.fetchTableData;
        }
    });
});
