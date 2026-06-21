import { state, persistState } from './state.js';
import { backendApi } from './api.js';
import { updateStatus, showLoading, showErrorState, updateToolbarButtons } from './ui.js';
import { updatePagination, renderDataGrid } from './grid-render.js';

export async function loadTableColumns() {
    if (!state.selectedTable) return;

    try {
        const columns = await backendApi.getTableInfo(state.selectedTable);
        state.tableColumns = columns.map(r => ({
            cid: r.ordinal,
            name: r.identifier,
            type: r.declaredType,
            notnull: r.isRequired,
            dflt_value: r.defaultExpression,
            isPrimaryKey: r.primaryKeyPosition > 0
        })).sort((a, b) => a.cid - b.cid);

        // Sanitize state based on new columns
        const colNames = new Set(state.tableColumns.map(c => c.name));

        // 1. Reset sort if column is gone
        if (state.sortedColumn && !colNames.has(state.sortedColumn)) {
            state.sortedColumn = null;
            state.sortAscending = true;
        }

        // 2. Clear filters for deleted columns
        for (const col of Object.keys(state.columnFilters)) {
            if (!colNames.has(col)) {
                delete state.columnFilters[col];
            }
        }
    } catch (err) {
        console.error('Error loading columns:', err);
        updateStatus('Error loading columns');
    }
}

// Monotonic token identifying the most recent loadTableData() call. Concurrent
// loads (e.g. a slow fetch followed by a filter/sort/page change or a table
// switch, triggered via toolbar controls the grid guard doesn't cover) compare
// this after each await and bail if a newer load has started — so a superseded
// request never writes state, renders stale rows, shows a stale error, or clears
// the loading flag out from under the in-flight one.
let activeLoadToken = 0;

export async function loadTableData(showSpinner = true, saveScrollPosition = true) {
    if (!state.selectedTable) return;

    const loadToken = ++activeLoadToken;
    // Snapshot the target table/type for the whole request so an in-flight load
    // can't pair this table's columns with a table the user switched to mid-fetch
    // (which would SELECT the old columns against the new table and error out).
    const requestedTable = state.selectedTable;
    const requestedTableType = state.selectedTableType;

    const container = document.getElementById('gridContainer');
    // Whether a data grid is currently rendered (vs. a spinner/error/empty state),
    // AND whether it belongs to the table we're loading. The renderedTable check is
    // what separates a same-table refetch (filter/sort/page — keep the grid, no
    // flicker) from a table switch, where the previous table's grid is still in the
    // DOM and must not be left on screen. Cached once instead of re-querying below.
    const hasRenderedGrid = !!(container && container.querySelector('.data-grid'));
    const isSameTableGrid = hasRenderedGrid && state.renderedTable === state.selectedTable;

    // Only capture scroll position if the current table's grid is visible (not a
    // loading/error state, and not a different table's grid mid-switch). This
    // prevents overwriting the saved position with 0 while a spinner is shown.
    if (saveScrollPosition && isSameTableGrid) {
        state.scrollPosition.left = container.scrollLeft;
        state.scrollPosition.top = container.scrollTop;
    }

    if (showSpinner) {
        state.isLoadingData = true;
        // Keep the existing grid visible during a same-table refetch (prevents
        // flicker); show the spinner on a true first load or a table switch, where
        // nothing valid for this table is on screen yet.
        if (!isSameTableGrid) {
            showLoading();
        }
    }

    updateToolbarButtons();

    try {
        // Build query options
        const filters = [];
        // Column filters
        for (const [colName, filterValue] of Object.entries(state.columnFilters)) {
            if (filterValue && filterValue.trim()) {
                filters.push({ column: colName, value: filterValue });
            }
        }

        // Column names are needed both for the global-filter count and the data query.
        const columnNames = state.tableColumns.map(c => c.name);

        const countOptions = {
            filters,
            globalFilter: state.filterQuery,
            columns: columnNames // Needed for global filter
        };

        // Get total count
        const totalRecordCount = await backendApi.fetchTableCount(requestedTable, countOptions);
        if (loadToken !== activeLoadToken) return; // a newer load superseded this one
        state.totalRecordCount = totalRecordCount;
        state.totalPageCount = Math.max(1, Math.ceil(state.totalRecordCount / state.rowsPerPage));

        if (state.currentPageIndex >= state.totalPageCount) {
            state.currentPageIndex = Math.max(0, state.totalPageCount - 1);
        }

        // Get data
        const isTable = requestedTableType === 'table';

        // For tables, we need to explicitly request the 'rowid' column to handle row identification.
        // The frontend expects rowid at index 0 for tables (see `getRowId` and `getRowDataOffset`).
        // Query builder handles the construction: SELECT "rowid", "col1", ...
        const queryColumns = isTable ? ['rowid', ...columnNames] : columnNames;

        const queryOptions = {
            columns: queryColumns,
            orderBy: state.sortedColumn,
            orderDir: state.sortAscending ? 'ASC' : 'DESC',
            limit: state.rowsPerPage,
            offset: state.currentPageIndex * state.rowsPerPage,
            filters,
            globalFilter: state.filterQuery
        };

        const dataResult = await backendApi.fetchTableData(requestedTable, queryOptions);
        if (loadToken !== activeLoadToken) return; // superseded while the data fetch was pending

        state.gridData = dataResult.rows || [];

        // When preserving scroll, re-capture the latest position right before
        // rendering. Covers the user scrolling during the fetch — including a
        // flicker-free refetch where the spinner was suppressed and the grid stayed
        // interactive — and edit operations that restored scroll while the fetch was
        // pending. Gated on saveScrollPosition (not !showSpinner) so callers that
        // intentionally reset scroll (page change, table switch) aren't clobbered.
        // Re-check the DOM here (not the cached flag): this runs after the await,
        // so the rendered state may differ from when the function started.
        if (saveScrollPosition && container && container.querySelector('.data-grid')) {
            state.scrollPosition.left = container.scrollLeft;
            state.scrollPosition.top = container.scrollTop;
        }

        // Optimization: If editing, skip render to avoid destroying the active editor
        if (!showSpinner && state.editingCellInfo) {
            // We updated gridData, so the data is fresh.
            // We skip the DOM update to keep the <textarea> alive.
            // updateCellDom in edit.js handles the visual update of the modified cell.
        } else {
            renderDataGrid(state.scrollPosition.top, state.scrollPosition.left);
            // The on-screen grid now reflects this table; remember it so the next
            // load can distinguish a same-table refetch from a table switch.
            state.renderedTable = requestedTable;
        }

        if (container) {
            container.scrollLeft = state.scrollPosition.left;
            container.scrollTop = state.scrollPosition.top;
        }

        updatePagination();
        updateStatus(`${state.totalRecordCount} records`);

    } catch (err) {
        console.error('Error loading data:', err);
        // Don't let a superseded load's error replace the current table's view.
        if (loadToken === activeLoadToken) {
            updateStatus(`Error: ${err.message}`);
            showErrorState(err.message);
        }
    } finally {
        // Only the most recent load owns the loading flag; an earlier, superseded
        // load must not clear it while the newer request is still in flight.
        if (showSpinner && loadToken === activeLoadToken) {
            state.isLoadingData = false;
        }
    }
}
