import './vscode_mock_setup';

/**
 * Operation-level retargeting across a database switch.
 *
 * The desktop host captures the target database ONCE PER `invoke` — so a UI
 * operation built from several RPCs can start against database A and finish
 * while database B is active. `state` is swapped wholesale on the switch
 * (desktop-host.js setActiveDb / db-ui-state.js), so anything the operation
 * commits after an await lands in the INCOMING database's state: A's columns,
 * A's schema tree or A's connection flags shown for B.
 *
 * Tabs make switching a single click, so every operation that commits fetched
 * data into `state` captures `state.dbId` at entry and refuses to commit if it
 * changed. loadTableData already did (grid-data.js `isSuperseded`); these are
 * the rest. All are inert off-desktop, where `state.dbId` is always null.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';

const stateModulePath = '../../core/ui/modules/state.js';
const apiModulePath = '../../core/ui/modules/api.js';
const gridDataModulePath = '../../core/ui/modules/grid-data.js';
const sidebarModulePath = '../../core/ui/modules/sidebar.js';

/** Enough of a document for updateStatus/renderSidebar/toolbar to no-op safely. */
function installDocumentStub(batchInputs: any[] = []) {
    (globalThis as any).document = {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: (selector: string) => (selector === '.batch-input' ? batchInputs : [])
    };
}

async function resetState() {
    const { state } = await import(stateModulePath);
    state.dbId = null;
    state.isDbConnected = false;
    state.isReadOnly = false;
    state.selectedTable = null;
    state.selectedTableType = 'table';
    state.selectedTableIdentity = null;
    state.tableColumns = [];
    state.gridData = [];
    state.gridExactIntegerTexts = {};
    state.gridOversizedCells = {};
    state.gridReadOnlyRowReasons = {};
    state.selectedCells = [];
    state.selectedColumns.clear();
    state.selectedRowIds.clear();
    state.pinnedRowIds.clear();
    state.lastSelectedCell = null;
    state.lastSelectedColumnIndex = null;
    state.lastSelectedRowIndex = null;
    state.schemaCache = { tables: [], views: [], indexes: [] };
    state.sidebarFilter = '';
    state.columnFilters = {};
    state.sortedColumn = null;
    state.currentPageIndex = 0;
    state.rowsPerPage = 500;
}

describe('a database switch mid-operation never commits the outgoing database\'s data', () => {
    afterEach(async () => {
        delete (globalThis as any).document;
        await resetState();
    });

    it('loadTableColumns drops columns fetched for the database the user left', async () => {
        installDocumentStub();
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { loadTableColumns } = await import(gridDataModulePath);
        const original = backendApi.getTableInfo;
        backendApi.getTableInfo = async () => {
            // The switch lands while getTableInfo is in flight.
            state.dbId = 'db#2';
            state.tableColumns = [{ cid: 0, name: 'b_only', type: 'TEXT' }];
            return [{
                ordinal: 0, identifier: 'a_only', declaredType: 'TEXT',
                isRequired: 0, defaultExpression: null, primaryKeyPosition: 0
            }];
        };
        state.dbId = 'db#1';
        state.selectedTable = 'items';
        state.lastSelectedCell = { rowIdx: 1, colIdx: 1 };

        try {
            await loadTableColumns();
            assert.deepStrictEqual(
                state.tableColumns.map((column: any) => column.name),
                ['b_only'],
                'database A\'s columns were committed into database B\'s state'
            );
            // The sanitization the commit performs belongs to the commit: it
            // must not run against the incoming database either.
            assert.deepStrictEqual(state.lastSelectedCell, { rowIdx: 1, colIdx: 1 });
        } finally {
            backendApi.getTableInfo = original;
        }
    });

    it('refreshSchema drops a schema fetched for the database the user left', async () => {
        installDocumentStub();
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { refreshSchema } = await import(sidebarModulePath);
        const original = backendApi.fetchSchema;
        backendApi.fetchSchema = async () => {
            state.dbId = 'db#2';
            return { tables: [{ identifier: 'a_table' }], views: [], indexes: [] };
        };
        state.dbId = 'db#1';
        state.isDbConnected = true;
        state.schemaCache = { tables: [{ name: 'b_table' }], views: [], indexes: [] };

        try {
            await refreshSchema();
            assert.deepStrictEqual(
                state.schemaCache.tables.map((table: any) => table.name),
                ['b_table'],
                'database A\'s schema tree was rendered for database B'
            );
        } finally {
            backendApi.fetchSchema = original;
        }
    });

    it('reloadFromDisk drops a connection result belonging to the database the user left', async () => {
        installDocumentStub();
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { reloadFromDisk } = await import(sidebarModulePath);
        const originalRefresh = backendApi.refreshFile;
        const originalSchema = backendApi.fetchSchema;
        let schemaFetches = 0;
        backendApi.refreshFile = async () => {
            state.dbId = 'db#2';
            return { connected: true, readOnly: true };
        };
        backendApi.fetchSchema = async () => {
            schemaFetches += 1;
            return { tables: [], views: [], indexes: [] };
        };
        state.dbId = 'db#1';
        state.isDbConnected = true;
        state.isReadOnly = false;

        try {
            await reloadFromDisk();
            // A's "this file is read-only" would disable B's editing controls.
            assert.strictEqual(state.isReadOnly, false);
            assert.strictEqual(schemaFetches, 0, 'the reload kept fetching against the incoming database');
        } finally {
            backendApi.refreshFile = originalRefresh;
            backendApi.fetchSchema = originalSchema;
        }
    });

    it('applyBatchUpdate does not write its results into the incoming database\'s grid', async () => {
        installDocumentStub([{ dataset: { colidx: '0' }, value: 'A-value' }]);
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { applyBatchUpdate } = await import(sidebarModulePath);
        const original = backendApi.updateCellBatch;
        backendApi.updateCellBatch = async () => {
            state.dbId = 'db#2';
            return [{ rowId: 1, newRowId: 99 }];
        };
        state.dbId = 'db#1';
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'value', type: 'TEXT' }];
        state.gridData = [[1, 'B-value']];
        state.selectedCells = [{ rowIdx: 0, colIdx: 0, rowId: 1 }];
        state.selectedRowIds.add(1);

        try {
            await applyBatchUpdate();
            assert.deepStrictEqual(state.gridData, [[1, 'B-value']], 'A\'s edit overwrote B\'s grid row');
            // The row-identity remap and the selection reset belong to A too.
            assert.deepStrictEqual([...state.selectedRowIds], [1]);
            assert.strictEqual(state.selectedCells.length, 1);
        } finally {
            backendApi.updateCellBatch = original;
        }
    });
});
