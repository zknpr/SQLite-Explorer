import './vscode_mock_setup';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { createDeferred } from './helpers/deferred';

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
    // webview modules (the established pattern in keyset_grid_state.test.ts).
    const stateModulePath = '../../core/ui/modules/state.js';
    const apiModulePath = '../../core/ui/modules/api.js';
    const gridDataModulePath = '../../core/ui/modules/grid-data.js';
    const countCacheModulePath = '../../core/ui/modules/count-cache.js';
    const { state } = await import(stateModulePath);
    const { backendApi } = await import(apiModulePath);
    const { loadTableData } = await import(gridDataModulePath);
    const countCache = await import(countCacheModulePath);
    // The cache is module state shared by every test in this process; each
    // test starts from a cold cache so hits are only ever self-inflicted.
    countCache.invalidateAllCounts();
    return { state, backendApi, loadTableData, countCache };
}

function primeTableState(state: any, table: string, pageIndex = 0) {
    state.selectedTable = table;
    state.selectedTableType = 'table';
    state.renderedTable = null;
    state.tableColumns = [{ name: 'value', type: 'TEXT' }];
    state.currentPageIndex = pageIndex;
    state.rowsPerPage = 20;
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
    state.selectedRowIds = new Set();
    state.selectedColumns = new Set();
    state.selectedCells = [];
}

function resetHarness(state: any, backendApi: any, originals: Record<string, any>) {
    Object.assign(backendApi, originals);
    state.selectedTable = null;
    state.keysetAnchors = null;
    state.gridData = [];
    state.columnFilters = {};
    state.filterQuery = '';
    state.isLoadingData = false;
    state.isGridReloading = false;
    state.editingCellInfo = null;
    state.selectedRowIds.clear();
    state.selectedColumns.clear();
    state.selectedCells = [];
    state.lastGridLoadError = null;
}

/** A count mock that records calls and returns a (possibly evolving) value. */
function installCountSpy(backendApi: any, respond: (call: number) => any) {
    const calls: any[] = [];
    backendApi.fetchTableCount = async (table: string, options: any) => {
        calls.push({ table, options });
        return respond(calls.length);
    };
    return calls;
}

describe('grid count cache', () => {
    afterEach(() => {
        delete (globalThis as any).document;
    });

    it('serves page turns from the cached count with no count fetch, keyset and OFFSET alike', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData } = await loadHarness();
        const originals = { fetchTableCount: backendApi.fetchTableCount, fetchTableData: backendApi.fetchTableData };
        const countCalls = installCountSpy(backendApi, () => 60); // 3 pages of 20
        const dataRequests: any[] = [];
        let anchorTick = 0;
        backendApi.fetchTableData = async (_table: string, options: any) => {
            dataRequests.push({ keyset: options.keyset, offset: options.offset });
            anchorTick += 1;
            return {
                rows: Array.from({ length: 20 }, (_, row) => [row, 'row']),
                keysetAnchors: { first: `F${anchorTick}`, last: `L${anchorTick}` }
            };
        };
        primeTableState(state, 'items');

        try {
            // First load is the only count fetch of the whole sequence.
            assert.strictEqual(await loadTableData(false, false), true);
            assert.strictEqual(countCalls.length, 1);
            assert.strictEqual(state.totalRecordCount, 60);
            assert.strictEqual(state.totalPageCount, 3);

            // next with a valid anchor
            state.currentPageIndex = 1;
            await loadTableData(false, false, 'next');
            assert.deepStrictEqual(dataRequests.at(-1).keyset, { mode: 'after', anchor: 'L1' });
            assert.strictEqual(countCalls.length, 1);

            // refetch-current (atOrAfter)
            await loadTableData(false, false);
            assert.deepStrictEqual(dataRequests.at(-1).keyset, { mode: 'atOrAfter', anchor: 'F2' });
            assert.strictEqual(countCalls.length, 1);

            // last: remainder computed from the cached count
            state.currentPageIndex = 2;
            await loadTableData(false, false, 'last');
            assert.deepStrictEqual(dataRequests.at(-1).keyset, { mode: 'last', lastPageRowCount: 20 });
            assert.strictEqual(countCalls.length, 1);

            // prev with a valid anchor (anchors describe page 2 after 'last')
            state.currentPageIndex = 1;
            await loadTableData(false, false, 'prev');
            assert.deepStrictEqual(dataRequests.at(-1).keyset, { mode: 'before', anchor: 'F4' });
            assert.strictEqual(countCalls.length, 1);

            // first
            state.currentPageIndex = 0;
            await loadTableData(false, false, 'first');
            assert.deepStrictEqual(dataRequests.at(-1).keyset, { mode: 'first' });
            assert.strictEqual(countCalls.length, 1);

            // OFFSET fallback: anchors describing a different page than the
            // intent expects still turn the page without a count fetch.
            state.currentPageIndex = 2;
            state.keysetAnchors = { table: 'items', pageIndex: 0, first: 'F0', last: 'L0' };
            await loadTableData(false, false, 'next');
            assert.strictEqual(dataRequests.at(-1).keyset, undefined);
            assert.strictEqual(dataRequests.at(-1).offset, 40);
            assert.strictEqual(countCalls.length, 1);

            // Arbitrary jump without intent (goToPage default): OFFSET, no count.
            state.currentPageIndex = 1;
            state.keysetAnchors = null;
            await loadTableData(false, false);
            assert.strictEqual(dataRequests.at(-1).keyset, undefined);
            assert.strictEqual(countCalls.length, 1);
        } finally {
            resetHarness(state, backendApi, originals);
        }
    });

    it('fetches a missing count in parallel with the data query', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData } = await loadHarness();
        const originals = { fetchTableCount: backendApi.fetchTableCount, fetchTableData: backendApi.fetchTableData };
        const count = createDeferred<number>();
        let countRequested = 0;
        let dataRequested = 0;
        backendApi.fetchTableCount = async () => {
            countRequested += 1;
            return count.promise;
        };
        backendApi.fetchTableData = async () => {
            dataRequested += 1;
            return { rows: [[1, 'row']] };
        };
        primeTableState(state, 'items');

        try {
            const load = loadTableData(false, false);
            // Both RPCs are dispatched in the same synchronous section: the
            // data query does not wait for the count to resolve.
            assert.strictEqual(countRequested, 1);
            assert.strictEqual(dataRequested, 1);

            count.resolve(40);
            assert.strictEqual(await load, true);
            assert.strictEqual(state.totalRecordCount, 40);
            assert.strictEqual(state.totalPageCount, 2);
        } finally {
            resetHarness(state, backendApi, originals);
        }
    });

    it('does not let a cached exact count hide rows added by an external writer', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData } = await loadHarness();
        const originals = { fetchTableCount: backendApi.fetchTableCount, fetchTableData: backendApi.fetchTableData };
        const dataLimits: number[] = [];
        let countCalls = 0;
        let databaseRows = 1;
        backendApi.fetchTableCount = async () => {
            countCalls += 1;
            return { count: databaseRows, isExact: true };
        };
        backendApi.fetchTableData = async (_table: string, options: any) => {
            dataLimits.push(options.limit);
            return {
                rows: Array.from(
                    { length: Math.min(databaseRows, options.limit) },
                    (_, row) => [row + 1, `row-${row + 1}`]
                )
            };
        };
        primeTableState(state, 'externally_changed');
        state.rowsPerPage = 5000;

        try {
            assert.strictEqual(await loadTableData(false, false), true);
            assert.strictEqual(state.gridData.length, 1);
            assert.strictEqual(countCalls, 1);

            databaseRows = 100;
            assert.strictEqual(await loadTableData(false, false), true);

            assert.strictEqual(state.gridData.length, 100);
            assert.strictEqual(countCalls, 1);
            assert.deepStrictEqual(dataLimits, [5000, 5000]);
        } finally {
            resetHarness(state, backendApi, originals);
        }
    });

    it('refetches a clipped short exact page at its real row bound', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData } = await loadHarness();
        const originals = { fetchTableCount: backendApi.fetchTableCount, fetchTableData: backendApi.fetchTableData };
        const fullPayload = JSON.stringify({ payload: 'x'.repeat(710) });
        assert.strictEqual(Buffer.byteLength(fullPayload, 'utf8'), 724);
        const clippedPayload = fullPayload.slice(0, 671);
        const dataLimits: number[] = [];
        let countCalls = 0;

        backendApi.fetchTableCount = async () => {
            countCalls += 1;
            return { count: 46, isExact: true };
        };
        backendApi.fetchTableData = async (_table: string, options: any) => {
            dataLimits.push(options.limit);
            if (options.limit === 5000) {
                return {
                    rows: [[1, clippedPayload]],
                    oversizedCells: {
                        0: { 1: { storageClass: 'text', byteLength: 724 } }
                    }
                };
            }
            assert.strictEqual(options.limit, 46);
            return { rows: [[1, fullPayload]] };
        };
        primeTableState(state, 'events');
        state.rowsPerPage = 5000;

        try {
            assert.strictEqual(await loadTableData(false, false), true);
            // Consumer-visible proof: the normal 724-byte value is complete
            // and editable, rather than retaining the containment preview.
            assert.strictEqual(state.gridData[0][1], fullPayload);
            assert.deepStrictEqual(state.gridOversizedCells, {});
            assert.deepStrictEqual(dataLimits, [5000, 46]);

            // A cached count cannot safely shorten the first query because an
            // external writer may have changed the table. If the unbounded
            // query clips a cell, refresh the count and retry against the new
            // load's exact bound.
            assert.strictEqual(await loadTableData(false, false), true);
            assert.strictEqual(state.gridData[0][1], fullPayload);
            assert.deepStrictEqual(state.gridOversizedCells, {});
            assert.strictEqual(countCalls, 2);
            assert.deepStrictEqual(dataLimits, [5000, 46, 5000, 46]);
        } finally {
            resetHarness(state, backendApi, originals);
        }
    });

    it('keys the cache by filter identity, not page size', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData } = await loadHarness();
        const originals = { fetchTableCount: backendApi.fetchTableCount, fetchTableData: backendApi.fetchTableData };
        const countCalls: any[] = [];
        // Unfiltered identity counts 60; filtered identities count 10.
        backendApi.fetchTableCount = async (table: string, options: any) => {
            countCalls.push({ table, options });
            const filtered = (options.filters?.length ?? 0) > 0 || options.globalFilter !== undefined;
            return filtered ? 10 : 60;
        };
        backendApi.fetchTableData = async () => ({ rows: [[1, 'row']] });
        primeTableState(state, 'items');

        try {
            // First load: one fetch for the unfiltered identity.
            await loadTableData(false, false);
            assert.strictEqual(countCalls.length, 1);
            assert.strictEqual(state.totalRecordCount, 60);

            // A filter change is a new identity: exactly one more fetch.
            state.columnFilters = { value: 'abc' };
            await loadTableData(false, false);
            assert.strictEqual(countCalls.length, 2);
            assert.strictEqual(state.totalRecordCount, 10);

            // The same filter again: cache hit.
            await loadTableData(false, false);
            assert.strictEqual(countCalls.length, 2);

            // A page-size change keeps the identity: no fetch, page count is
            // recomputed from the cached count.
            state.rowsPerPage = 4;
            state.currentPageIndex = 0;
            await loadTableData(false, false);
            assert.strictEqual(countCalls.length, 2);
            assert.strictEqual(state.totalPageCount, 3); // ceil(10 / 4)

            // Clearing the filter returns to the still-cached unfiltered identity.
            state.columnFilters = {};
            state.rowsPerPage = 20;
            await loadTableData(false, false);
            assert.strictEqual(countCalls.length, 2);
            assert.strictEqual(state.totalRecordCount, 60);

            // A global filter is another identity: exactly one more fetch.
            state.filterQuery = 'needle';
            await loadTableData(false, false);
            assert.strictEqual(countCalls.length, 3);
            assert.strictEqual(state.totalRecordCount, 10);
        } finally {
            resetHarness(state, backendApi, originals);
        }
    });

    it('adjusts the unfiltered count without refetching or double-counting duplicate inserts', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData } = await loadHarness();
        const crudModulePath = '../../core/ui/modules/crud.js';
        const { submitAddRow, submitDelete } = await import(crudModulePath);
        const originals = {
            fetchTableCount: backendApi.fetchTableCount,
            fetchTableData: backendApi.fetchTableData,
            insertRow: backendApi.insertRow,
            deleteRows: backendApi.deleteRows
        };
        const countCalls = installCountSpy(backendApi, () => 60);
        backendApi.fetchTableData = async () => ({ rows: [[1, 'row']] });
        let inserted = 0;
        let deletedIds: any[] = [];
        backendApi.insertRow = async () => { inserted += 1; return 99; };
        backendApi.deleteRows = async (_table: string, rowIds: any[]) => { deletedIds = rowIds; };
        primeTableState(state, 'items');

        try {
            await loadTableData(false, false);
            assert.strictEqual(countCalls.length, 1);
            assert.strictEqual(state.totalRecordCount, 60);

            // Delete two selected rows through the real crud path: the reload
            // it triggers commits the adjusted count with no count fetch.
            state.selectedRowIds = new Set([7, 9]);
            await submitDelete();
            assert.deepStrictEqual(deletedIds, [7, 9]);
            assert.strictEqual(countCalls.length, 1);
            assert.strictEqual(state.totalRecordCount, 58);
            assert.strictEqual(state.totalPageCount, 3); // ceil(58 / 20)

            // Insert through the real crud path (+1, still no fetch).
            const insert = submitAddRow();
            const duplicateInsert = submitAddRow();
            await Promise.all([insert, duplicateInsert]);
            assert.strictEqual(inserted, 1);
            assert.strictEqual(countCalls.length, 1);
            assert.strictEqual(state.totalRecordCount, 59);
        } finally {
            resetHarness(state, backendApi, originals);
        }
    });

    it('invalidates filtered identities on mutations while keeping the unfiltered delta', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData, countCache } = await loadHarness();
        const originals = { fetchTableCount: backendApi.fetchTableCount, fetchTableData: backendApi.fetchTableData };
        const countCalls: any[] = [];
        backendApi.fetchTableCount = async (table: string, options: any) => {
            countCalls.push({ table, options });
            const filtered = (options.filters?.length ?? 0) > 0;
            return filtered ? 10 : 60;
        };
        backendApi.fetchTableData = async () => ({ rows: [[1, 'row']] });
        primeTableState(state, 'items');

        try {
            // Seed both identities.
            await loadTableData(false, false);
            state.columnFilters = { value: 'abc' };
            await loadTableData(false, false);
            assert.strictEqual(countCalls.length, 2);

            // A row mutation drops the filtered identity (its effect on the
            // filtered count is unknowable) but adjusts the unfiltered one.
            countCache.noteRowCountChanged('items', -1);
            await loadTableData(false, false); // filtered identity active
            assert.strictEqual(countCalls.length, 3, 'filtered identity must refetch after a row mutation');
            state.columnFilters = {};
            await loadTableData(false, false);
            assert.strictEqual(countCalls.length, 3, 'unfiltered identity must serve the adjusted delta');
            assert.strictEqual(state.totalRecordCount, 59);

            // A cell edit keeps the unfiltered identity but drops filtered ones.
            state.columnFilters = { value: 'abc' };
            await loadTableData(false, false); // hit: fetch 3 re-cached this identity
            assert.strictEqual(countCalls.length, 3);
            countCache.noteCellValuesChanged('items');
            await loadTableData(false, false);
            assert.strictEqual(countCalls.length, 4, 'filtered identity must refetch after a cell edit');
            state.columnFilters = {};
            await loadTableData(false, false);
            assert.strictEqual(countCalls.length, 4, 'cell edits must not evict the unfiltered identity');
            assert.strictEqual(state.totalRecordCount, 59);
        } finally {
            resetHarness(state, backendApi, originals);
        }
    });

    it('refetches the demo unfiltered count after a trigger-bearing cell edit', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData, countCache } = await loadHarness();
        const originals = {
            fetchTableCount: backendApi.fetchTableCount,
            fetchTableData: backendApi.fetchTableData
        };
        const countCalls = installCountSpy(
            backendApi,
            call => call === 1 ? 40 : 41
        );
        backendApi.fetchTableData = async () => ({ rows: [[1, 'row']] });
        primeTableState(state, 'triggered_items');
        countCache.setCountCacheDemoMode?.(true);

        try {
            await loadTableData(false, false);
            assert.strictEqual(state.totalRecordCount, 40);

            // An uploaded database can carry an AFTER UPDATE trigger that inserts
            // another row. The demo has no host refresh echo to invalidate this.
            countCache.noteCellValuesChanged('triggered_items');
            await loadTableData(false, false);

            assert.strictEqual(countCalls.length, 2);
            assert.strictEqual(state.totalRecordCount, 41);
        } finally {
            countCache.setCountCacheDemoMode?.(false);
            resetHarness(state, backendApi, originals);
        }
    });

    it('refetches the demo unfiltered count after trigger-sensitive deletes and inserts', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData, countCache } = await loadHarness();
        const crudModulePath = '../../core/ui/modules/crud.js';
        const { submitAddRow, submitDelete } = await import(crudModulePath);
        const originals = {
            fetchTableCount: backendApi.fetchTableCount,
            fetchTableData: backendApi.fetchTableData,
            insertRow: backendApi.insertRow,
            deleteRows: backendApi.deleteRows
        };
        const countCalls = installCountSpy(backendApi, () => 40);
        backendApi.fetchTableData = async () => ({ rows: [[1, 'row']] });
        backendApi.deleteRows = async () => {};
        backendApi.insertRow = async () => 99;
        primeTableState(state, 'triggered_items');
        countCache.setCountCacheDemoMode?.(true);

        try {
            await loadTableData(false, false);
            assert.strictEqual(state.totalRecordCount, 40);

            // Model BEFORE DELETE RAISE(IGNORE): the RPC resolves but the real
            // cardinality stays at 40, so applying the selected-id delta lies.
            state.selectedRowIds = new Set([7]);
            await submitDelete();
            assert.strictEqual(countCalls.length, 2);
            assert.strictEqual(state.totalRecordCount, 40);

            // INSERT triggers have the same exposure (IGNORE, or extra rows).
            // The demo must refetch rather than assume the RPC added one row.
            await submitAddRow();
            assert.strictEqual(countCalls.length, 3);
            assert.strictEqual(state.totalRecordCount, 40);
        } finally {
            countCache.setCountCacheDemoMode?.(false);
            resetHarness(state, backendApi, originals);
        }
    });

    it('invalidates filtered counts across column DDL so a re-add cannot revive them', async () => {
        // Column drop/re-add changes what a filter matches without changing
        // the identity key (identities name filters, not schema) — the DDL
        // flows must bump the cache or a re-typed filter revives a count
        // computed against the old column's values.
        const elements = installDocumentMock();
        elements.newColumnName = { value: 'value' };
        elements.newColumnType = { value: 'TEXT' };
        elements.newColumnDefault = { value: '' };
        const { state, backendApi, loadTableData } = await loadHarness();
        const crudModulePath = '../../core/ui/modules/crud.js';
        // submitDelete dispatches to the (non-exported) column branch when
        // selectedColumns is non-empty and no rows are selected.
        const { submitAddColumn, submitDelete } = await import(crudModulePath);
        const originals = {
            fetchSchema: backendApi.fetchSchema,
            fetchTableCount: backendApi.fetchTableCount,
            fetchTableData: backendApi.fetchTableData,
            deleteColumns: backendApi.deleteColumns,
            addColumn: backendApi.addColumn,
            getTableInfo: backendApi.getTableInfo
        };
        backendApi.fetchSchema = async () => ({
            tables: [{ identifier: 'items', identity: { kind: 'rowid' } }],
            views: [],
            indexes: []
        });
        const countCalls = installCountSpy(backendApi, call => (call === 1 ? 10 : 0));
        backendApi.fetchTableData = async () => ({ rows: [] });
        let droppedColumns: string[] = [];
        let addedColumn: string | null = null;
        backendApi.deleteColumns = async (_table: string, columns: string[]) => {
            droppedColumns = columns;
            return {};
        };
        backendApi.addColumn = async (_table: string, column: string) => { addedColumn = column; };
        backendApi.getTableInfo = async () => ([
            { ordinal: 0, identifier: 'value', declaredType: 'TEXT', isRequired: 0, defaultExpression: null, primaryKeyPosition: 0 }
        ]);
        primeTableState(state, 'items');
        state.isDbConnected = true;
        state.columnFilters = { value: 'abc' };

        try {
            await loadTableData(false, false);
            assert.strictEqual(countCalls.length, 1);
            assert.strictEqual(state.totalRecordCount, 10);

            // Drop the filtered column through the real crud flow. Its internal
            // reload must refetch the filtered identity, not serve the stale 10.
            state.selectedColumns = new Set(['value']);
            await submitDelete();
            assert.deepStrictEqual(droppedColumns, ['value']);
            assert.strictEqual(
                countCalls.length, 2,
                'column drop must invalidate the filtered identity (revive bug)'
            );
            assert.strictEqual(state.totalRecordCount, 0);

            // Re-add the column: the add flow must bump the cache the same way.
            await submitAddColumn();
            assert.strictEqual(addedColumn, 'value');
            assert.strictEqual(
                countCalls.length, 3,
                'column add must invalidate the filtered identity'
            );
        } finally {
            state.isDbConnected = false;
            resetHarness(state, backendApi, originals);
        }
    });

    it('reloads dropped columns when the host refresh closes the confirmation first', async () => {
        const elements = installDocumentMock();
        const modalClasses = new Set(['hidden']);
        elements.deleteModal = {
            classList: {
                add: (name: string) => modalClasses.add(name),
                remove: (name: string) => modalClasses.delete(name),
                contains: (name: string) => modalClasses.has(name)
            },
            querySelector() { return null; }
        };
        elements.deleteConfirmText = { textContent: '' };

        const { state, backendApi } = await loadHarness();
        const crudModulePath = '../../core/ui/modules/crud.js';
        const modalsModulePath = '../../core/ui/modules/modals.js';
        const { openDeleteModal, submitDelete } = await import(crudModulePath);
        const { closeDatabaseTargetModals } = await import(modalsModulePath);
        const originals = {
            fetchSchema: backendApi.fetchSchema,
            fetchTableCount: backendApi.fetchTableCount,
            fetchTableData: backendApi.fetchTableData,
            deleteColumns: backendApi.deleteColumns,
            getTableInfo: backendApi.getTableInfo
        };
        let tableInfoCalls = 0;
        backendApi.fetchSchema = async () => ({
            tables: [{ identifier: 'items', identity: { kind: 'rowid' } }],
            views: [],
            indexes: []
        });
        backendApi.getTableInfo = async () => {
            tableInfoCalls += 1;
            return [{
                ordinal: 0,
                identifier: 'id',
                declaredType: 'INTEGER',
                isRequired: false,
                defaultExpression: null,
                primaryKeyPosition: 0
            }];
        };
        backendApi.fetchTableCount = async () => 1;
        backendApi.fetchTableData = async () => ({ rows: [[1, 1]] });
        backendApi.deleteColumns = async () => {
            // DatabaseDocument broadcasts its edit synchronously. The host-side
            // refresh closes database-bound modals before this RPC response is
            // delivered back to the initiating webview.
            closeDatabaseTargetModals();
            return {};
        };
        primeTableState(state, 'items');
        state.isDbConnected = true;
        state.selectedColumns = new Set(['value']);

        try {
            openDeleteModal();
            assert.strictEqual(
                elements.deleteConfirmText.textContent,
                'Are you sure you want to delete 1 column (value)? This will permanently remove the column and its data.'
            );
            await submitDelete();

            assert.strictEqual(tableInfoCalls, 1);
            assert.deepStrictEqual(state.tableColumns.map((column: any) => column.name), ['id']);
        } finally {
            state.isDbConnected = false;
            resetHarness(state, backendApi, originals);
        }
    });

    it('never lets a superseded load poison the cache', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData } = await loadHarness();
        const originals = { fetchTableCount: backendApi.fetchTableCount, fetchTableData: backendApi.fetchTableData };
        const staleCount = createDeferred<number>();
        const countCalls: any[] = [];
        backendApi.fetchTableCount = async () => {
            countCalls.push({});
            return countCalls.length === 1 ? staleCount.promise : 40;
        };
        backendApi.fetchTableData = async () => ({ rows: [[1, 'row']] });
        primeTableState(state, 'items');

        try {
            const loadA = loadTableData(false, false); // count stalls
            await Promise.resolve();
            const loadB = loadTableData(false, false);
            assert.strictEqual(await loadB, true);
            assert.strictEqual(state.totalRecordCount, 40);
            assert.strictEqual(countCalls.length, 2);

            // A's count finally lands with a value that is no longer truth; the
            // superseded load must neither commit it nor store it.
            staleCount.resolve(999);
            assert.strictEqual(await loadA, undefined);
            assert.strictEqual(state.totalRecordCount, 40);

            // The identity still serves B's committed value with no refetch.
            await loadTableData(false, false);
            assert.strictEqual(countCalls.length, 2);
            assert.strictEqual(state.totalRecordCount, 40);
        } finally {
            resetHarness(state, backendApi, originals);
        }
    });

    it('drops a count that was in flight across a mutation instead of storing it', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData, countCache } = await loadHarness();
        const originals = { fetchTableCount: backendApi.fetchTableCount, fetchTableData: backendApi.fetchTableData };
        const pending = createDeferred<number>();
        const countCalls: any[] = [];
        backendApi.fetchTableCount = async () => {
            countCalls.push({});
            return countCalls.length === 1 ? pending.promise : 41;
        };
        backendApi.fetchTableData = async () => ({ rows: [[1, 'row']] });
        primeTableState(state, 'items');

        try {
            const load = loadTableData(false, false);
            // A mutation lands while the count RPC is in flight: the eventual
            // value is ambiguous (pre- or post-mutation) and must not be cached.
            countCache.noteRowCountChanged('items', 1);
            pending.resolve(40);
            assert.strictEqual(await load, true); // the load itself still commits
            assert.strictEqual(state.totalRecordCount, 40);

            // Next load must fetch again: nothing was stored.
            await loadTableData(false, false);
            assert.strictEqual(countCalls.length, 2);
            assert.strictEqual(state.totalRecordCount, 41);
        } finally {
            resetHarness(state, backendApi, originals);
        }
    });

    it('clamps the page from a cached count after a last-page delete, without a refetch', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData, countCache } = await loadHarness();
        const originals = { fetchTableCount: backendApi.fetchTableCount, fetchTableData: backendApi.fetchTableData };
        const countCalls = installCountSpy(backendApi, () => 21); // 2 pages of 20
        const dataRequests: any[] = [];
        backendApi.fetchTableData = async (_table: string, options: any) => {
            dataRequests.push({ offset: options.offset, keyset: options.keyset });
            return { rows: [[1, 'row']] };
        };
        primeTableState(state, 'items', 1);

        try {
            await loadTableData(false, false);
            assert.strictEqual(state.totalPageCount, 2);
            assert.strictEqual(state.currentPageIndex, 1);

            // The last remaining row of page 1 is deleted; the cached count
            // shrinks to 20 and the next load clamps back to page 0 from it.
            countCache.noteRowCountChanged('items', -1);
            await loadTableData(false, false);
            assert.strictEqual(countCalls.length, 1, 'the clamp must run from the cached count');
            assert.strictEqual(state.totalRecordCount, 20);
            assert.strictEqual(state.totalPageCount, 1);
            assert.strictEqual(state.currentPageIndex, 0);
            assert.strictEqual(dataRequests.at(-1).offset, 0);
            assert.deepStrictEqual(dataRequests.at(-1).keyset, { mode: 'first' });
        } finally {
            resetHarness(state, backendApi, originals);
        }
    });

    it('invalidates an inexact rowid-span bound instead of applying a row delta', async () => {
        const { countCache } = await loadHarness();
        const identity = countCache.buildCountIdentity('items', [], undefined, []);
        countCache.prepareCountStore(identity)({ count: 1_000_000, isExact: false });

        // An explicit inserted rowid could extend the span by much more than
        // one, so arithmetic adjustment would no longer be a safe upper bound.
        countCache.noteRowCountChanged('items', 1);
        assert.strictEqual(countCache.getCachedCount(identity), undefined);
    });

    it('handles an empty table and floors deltas at zero', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData, countCache } = await loadHarness();
        const originals = { fetchTableCount: backendApi.fetchTableCount, fetchTableData: backendApi.fetchTableData };
        const countCalls = installCountSpy(backendApi, () => 0);
        backendApi.fetchTableData = async () => ({ rows: [] });
        primeTableState(state, 'items');

        try {
            assert.strictEqual(await loadTableData(false, false), true);
            assert.strictEqual(state.totalRecordCount, 0);
            assert.strictEqual(state.totalPageCount, 1);
            assert.strictEqual(state.currentPageIndex, 0);
            assert.deepStrictEqual(state.gridData, []);

            // A defensive over-delete cannot drive the cached count negative.
            countCache.noteRowCountChanged('items', -5);
            await loadTableData(false, false);
            assert.strictEqual(countCalls.length, 1);
            assert.strictEqual(state.totalRecordCount, 0);
        } finally {
            resetHarness(state, backendApi, originals);
        }
    });

    it('fails the load on a count fetch error without caching or committing anything', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData } = await loadHarness();
        const originals = { fetchTableCount: backendApi.fetchTableCount, fetchTableData: backendApi.fetchTableData };
        const countCalls: any[] = [];
        backendApi.fetchTableCount = async () => {
            countCalls.push({});
            if (countCalls.length === 1) throw new Error('count exploded');
            return 40;
        };
        backendApi.fetchTableData = async () => ({ rows: [[1, 'fresh']] });
        primeTableState(state, 'items');
        state.gridData = [['old']];
        state.totalRecordCount = 7;

        try {
            assert.strictEqual(await loadTableData(false, false), false);
            assert.strictEqual(state.lastGridLoadError, 'count exploded');
            // Nothing committed: the failed load's data result never surfaces.
            assert.deepStrictEqual(state.gridData, [['old']]);
            assert.strictEqual(state.totalRecordCount, 7);

            // Nothing cached either: the retry fetches the count again.
            assert.strictEqual(await loadTableData(false, false), true);
            assert.strictEqual(countCalls.length, 2);
            assert.strictEqual(state.totalRecordCount, 40);
        } finally {
            resetHarness(state, backendApi, originals);
        }
    });

    it('keeps a successfully fetched count when only the data query fails', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData } = await loadHarness();
        const originals = { fetchTableCount: backendApi.fetchTableCount, fetchTableData: backendApi.fetchTableData };
        const countCalls = installCountSpy(backendApi, () => 40);
        let dataCalls = 0;
        backendApi.fetchTableData = async () => {
            dataCalls += 1;
            if (dataCalls === 1) throw new Error('data exploded');
            return { rows: [[1, 'fresh']] };
        };
        primeTableState(state, 'items');

        try {
            assert.strictEqual(await loadTableData(false, false), false);
            assert.strictEqual(state.lastGridLoadError, 'data exploded');

            // The count was engine truth for this identity; the follow-up load
            // reuses it and only re-runs the data query.
            assert.strictEqual(await loadTableData(false, false), true);
            assert.strictEqual(countCalls.length, 1);
            assert.strictEqual(state.totalRecordCount, 40);
            assert.deepStrictEqual(state.gridData, [[1, 'fresh']]);
        } finally {
            resetHarness(state, backendApi, originals);
        }
    });

    it('discards the speculative page and refetches clamped when a restored index overshoots', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData } = await loadHarness();
        const originals = { fetchTableCount: backendApi.fetchTableCount, fetchTableData: backendApi.fetchTableData };
        const countCalls = installCountSpy(backendApi, () => 20); // 1 page of 20
        const dataRequests: any[] = [];
        backendApi.fetchTableData = async (_table: string, options: any) => {
            dataRequests.push({ offset: options.offset });
            // The overshooting speculative query legitimately finds nothing.
            if (options.offset > 0) return { rows: [] };
            return { rows: [[1, 'real-first-page']] };
        };
        // A restored webview can come back with a page index the shrunken
        // table no longer has; the cache is deliberately not persisted.
        primeTableState(state, 'items', 5);

        try {
            assert.strictEqual(await loadTableData(false, false), true);
            assert.strictEqual(countCalls.length, 1);
            assert.deepStrictEqual(
                dataRequests.map(request => request.offset),
                [100, 0],
                'the speculative fetch is followed by exactly one clamped fetch'
            );
            assert.strictEqual(state.currentPageIndex, 0);
            assert.strictEqual(state.totalPageCount, 1);
            assert.deepStrictEqual(state.gridData, [[1, 'real-first-page']]);
        } finally {
            resetHarness(state, backendApi, originals);
        }
    });

    it("resolves the count before the data query for 'last' navigation on a cold cache", async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData } = await loadHarness();
        const originals = { fetchTableCount: backendApi.fetchTableCount, fetchTableData: backendApi.fetchTableData };
        let countResolved = false;
        const countCalls: any[] = [];
        backendApi.fetchTableCount = async () => {
            countCalls.push({});
            countResolved = true;
            return 60;
        };
        const dataRequests: any[] = [];
        backendApi.fetchTableData = async (_table: string, options: any) => {
            dataRequests.push({ keyset: options.keyset, countWasResolved: countResolved });
            return { rows: Array.from({ length: 20 }, (_, row) => [row, 'row']) };
        };
        primeTableState(state, 'items', 2);

        try {
            assert.strictEqual(await loadTableData(false, false, 'last'), true);
            assert.strictEqual(countCalls.length, 1);
            assert.strictEqual(dataRequests.length, 1);
            // Sequential parity: the remainder needs the count, so 'last'
            // never speculates.
            assert.strictEqual(dataRequests[0].countWasResolved, true);
            assert.deepStrictEqual(dataRequests[0].keyset, { mode: 'last', lastPageRowCount: 20 });
        } finally {
            resetHarness(state, backendApi, originals);
        }
    });

    it('uses an inexact rowid-span count only as a bound when seeking the sparse last page', async () => {
        const elements = installDocumentMock();
        const { state, backendApi, loadTableData } = await loadHarness();
        const originals = { fetchTableCount: backendApi.fetchTableCount, fetchTableData: backendApi.fetchTableData };
        const dataRequests: any[] = [];
        backendApi.fetchTableCount = async () => ({ count: 1_000_000, isExact: false });
        backendApi.fetchTableData = async (_table: string, options: any) => {
            dataRequests.push(options);
            return {
                rows: [[1, 'one'], [1_000_000, 'million']],
                keysetAnchors: { first: 'F1', last: 'L1000000' }
            };
        };
        primeTableState(state, 'sparse_items', 199);
        state.rowsPerPage = 5000;

        try {
            assert.strictEqual(await loadTableData(false, false, 'last'), true);
            assert.strictEqual(dataRequests.length, 1);
            assert.deepStrictEqual(dataRequests[0].keyset, { mode: 'last' });
            assert.strictEqual(dataRequests[0].offset, 995000);
            // A short reverse seek proves the whole table fits on one page, so
            // replace the loose span bound with the exact result we just read.
            assert.strictEqual(state.totalRecordCount, 2);
            assert.strictEqual(state.totalRecordCountIsExact, true);
            assert.strictEqual(state.totalPageCount, 1);
            assert.strictEqual(state.currentPageIndex, 0);
            assert.strictEqual(elements.pageIndicator.textContent, '1 / 1');
            assert.strictEqual(elements.statusText.textContent, '2 records');
        } finally {
            resetHarness(state, backendApi, originals);
        }
    });

    it('collapses an inexact rowid-span bound when the first page proves the real end', async () => {
        const elements = installDocumentMock();
        const { state, backendApi, loadTableData } = await loadHarness();
        const originals = { fetchTableCount: backendApi.fetchTableCount, fetchTableData: backendApi.fetchTableData };
        const dataRequests: any[] = [];
        backendApi.fetchTableCount = async () => ({ count: 1_000_000, isExact: false });
        backendApi.fetchTableData = async (_table: string, options: any) => {
            dataRequests.push(options);
            return {
                rows: [[1, 'one'], [1_000_000, 'million']],
                keysetAnchors: { first: 'F1', last: 'L1000000' }
            };
        };
        primeTableState(state, 'sparse_forward_items');
        state.rowsPerPage = 5000;

        try {
            assert.strictEqual(await loadTableData(false, false, 'first'), true);
            assert.strictEqual(dataRequests.length, 1);
            assert.deepStrictEqual(dataRequests[0].keyset, { mode: 'first' });
            assert.strictEqual(state.totalRecordCount, 2);
            assert.strictEqual(state.totalRecordCountIsExact, true);
            assert.strictEqual(state.totalPageCount, 1);
            assert.strictEqual(state.currentPageIndex, 0);
            assert.strictEqual(elements.btnNext.disabled, true);
            assert.strictEqual(elements.pageIndicator.textContent, '1 / 1');
        } finally {
            resetHarness(state, backendApi, originals);
        }
    });

    it('collapses an inexact forward walk when a short after seek proves the real last page', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData } = await loadHarness();
        const originals = { fetchTableCount: backendApi.fetchTableCount, fetchTableData: backendApi.fetchTableData };
        const dataRequests: any[] = [];
        backendApi.fetchTableCount = async () => ({ count: 1_000_000, isExact: false });
        backendApi.fetchTableData = async (_table: string, options: any) => {
            dataRequests.push(options);
            if (options.keyset?.mode === 'first') {
                return {
                    rows: Array.from({ length: 5000 }, (_, index) => [index + 1, 'head']),
                    keysetAnchors: { first: 'F1', last: 'L5000' }
                };
            }
            if (options.keyset?.mode === 'after') {
                return {
                    rows: Array.from({ length: 1000 }, (_, index) => [5001 + index, 'tail']),
                    keysetAnchors: { first: 'F5001', last: 'L6000' }
                };
            }
            throw new Error('forward walk must not fall back to a deep OFFSET');
        };
        primeTableState(state, 'two_sparse_forward_pages');
        state.rowsPerPage = 5000;

        try {
            assert.strictEqual(await loadTableData(false, false, 'first'), true);
            assert.strictEqual(state.totalRecordCountIsExact, false);

            state.currentPageIndex = 1;
            assert.strictEqual(await loadTableData(false, false, 'next'), true);
            assert.deepStrictEqual(dataRequests[1].keyset, { mode: 'after', anchor: 'L5000' });
            assert.strictEqual(state.totalRecordCount, 6000);
            assert.strictEqual(state.totalRecordCountIsExact, true);
            assert.strictEqual(state.totalPageCount, 2);
            assert.strictEqual(state.currentPageIndex, 1);
            assert.strictEqual(state.gridData.length, 1000);
        } finally {
            resetHarness(state, backendApi, originals);
        }
    });

    it('retains the prior page when an empty after seek proves an exact page boundary', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData } = await loadHarness();
        const originals = { fetchTableCount: backendApi.fetchTableCount, fetchTableData: backendApi.fetchTableData };
        backendApi.fetchTableCount = async () => ({ count: 1_000_000, isExact: false });
        backendApi.fetchTableData = async (_table: string, options: any) => {
            if (options.keyset?.mode === 'first') {
                return {
                    rows: Array.from({ length: 5000 }, (_, index) => [index + 1, 'only-page']),
                    keysetAnchors: { first: 'F1', last: 'L5000' }
                };
            }
            if (options.keyset?.mode === 'after') return { rows: [] };
            throw new Error('empty forward boundary must not fall back to a deep OFFSET');
        };
        primeTableState(state, 'one_sparse_forward_page');
        state.rowsPerPage = 5000;

        try {
            assert.strictEqual(await loadTableData(false, false, 'first'), true);
            state.currentPageIndex = 1;
            assert.strictEqual(await loadTableData(false, false, 'next'), true);

            assert.strictEqual(state.totalRecordCount, 5000);
            assert.strictEqual(state.totalRecordCountIsExact, true);
            assert.strictEqual(state.totalPageCount, 1);
            assert.strictEqual(state.currentPageIndex, 0);
            assert.strictEqual(state.gridData.length, 5000);
            assert.deepStrictEqual(state.gridData[0], [1, 'only-page']);
            assert.deepStrictEqual(state.keysetAnchors, {
                table: 'one_sparse_forward_page',
                pageIndex: 0,
                first: 'F1',
                last: 'L5000'
            });
        } finally {
            resetHarness(state, backendApi, originals);
        }
    });

    it('collapses an inexact reverse walk when a short seek proves the real first page', async () => {
        installDocumentMock();
        const { state, backendApi, loadTableData } = await loadHarness();
        const originals = { fetchTableCount: backendApi.fetchTableCount, fetchTableData: backendApi.fetchTableData };
        const dataRequests: any[] = [];
        backendApi.fetchTableCount = async () => ({ count: 1_000_000, isExact: false });
        backendApi.fetchTableData = async (_table: string, options: any) => {
            dataRequests.push(options);
            if (options.keyset?.mode === 'last') {
                return {
                    rows: Array.from({ length: 5000 }, (_, index) => [5001 + index, 'tail']),
                    keysetAnchors: { first: 'F5001', last: 'L10000' }
                };
            }
            if (options.keyset?.mode === 'before') {
                return {
                    rows: Array.from({ length: 1000 }, (_, index) => [1 + index, 'head']),
                    keysetAnchors: { first: 'F1', last: 'L1000' }
                };
            }
            throw new Error('reverse walk must not fall back to a deep OFFSET');
        };
        primeTableState(state, 'two_sparse_pages', 199);
        state.rowsPerPage = 5000;

        try {
            assert.strictEqual(await loadTableData(false, false, 'last'), true);
            assert.strictEqual(state.totalRecordCountIsExact, false);

            state.currentPageIndex = 198;
            assert.strictEqual(await loadTableData(false, false, 'prev'), true);
            assert.deepStrictEqual(dataRequests[1].keyset, { mode: 'before', anchor: 'F5001' });
            assert.strictEqual(state.totalRecordCount, 6000);
            assert.strictEqual(state.totalRecordCountIsExact, true);
            assert.strictEqual(state.totalPageCount, 2);
            assert.strictEqual(state.currentPageIndex, 0);
            assert.strictEqual(state.gridData.length, 1000);
        } finally {
            resetHarness(state, backendApi, originals);
        }
    });

    it('builds count identities that canonicalize filter order and scope columns to global filters', async () => {
        const countCacheModulePath = '../../core/ui/modules/count-cache.js';
        const { buildCountIdentity } = await import(countCacheModulePath);

        // Unfiltered: the bare table identity.
        assert.deepStrictEqual(
            buildCountIdentity('items', [], undefined, ['a', 'b']),
            { table: 'items', subKey: '' }
        );

        // Column filter order (typing order) must not split the identity.
        const forward = buildCountIdentity(
            'items',
            [{ column: 'a', value: 'x' }, { column: 'b', value: 'y' }],
            undefined,
            ['a', 'b']
        );
        const reversed = buildCountIdentity(
            'items',
            [{ column: 'b', value: 'y' }, { column: 'a', value: 'x' }],
            undefined,
            ['a', 'b']
        );
        assert.deepStrictEqual(forward, reversed);

        // Column-filter identities ignore the column set (their predicates
        // name their columns), so schema growth does not re-key them.
        const beforeColumnAdd = buildCountIdentity('items', [{ column: 'a', value: 'x' }], undefined, ['a', 'b']);
        const afterColumnAdd = buildCountIdentity('items', [{ column: 'a', value: 'x' }], undefined, ['a', 'b', 'c']);
        assert.deepStrictEqual(beforeColumnAdd, afterColumnAdd);

        // Global-filter identities scan every displayed column, so the column
        // set is part of the identity and schema changes re-key it.
        const globalBefore = buildCountIdentity('items', [], 'needle', ['a', 'b']);
        const globalAfter = buildCountIdentity('items', [], 'needle', ['a', 'b', 'c']);
        assert.notStrictEqual(globalBefore.subKey, globalAfter.subKey);

        // Padded filter text is a distinct predicate and a distinct identity.
        const padded = buildCountIdentity('items', [{ column: 'a', value: ' x ' }], undefined, ['a']);
        assert.notStrictEqual(padded.subKey, beforeColumnAdd.subKey);
    });
});
