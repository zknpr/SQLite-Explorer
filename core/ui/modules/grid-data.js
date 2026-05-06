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

export async function loadTableData(showSpinner = true, saveScrollPosition = true) {
    if (!state.selectedTable) return;

    const container = document.getElementById('gridContainer');

    // Only capture scroll position if the grid is currently visible (not loading/error state)
    // This prevents overwriting the saved position with 0 when reloading data while a spinner is shown.
    if (saveScrollPosition && container && container.querySelector('.data-grid')) {
        state.scrollPosition.left = container.scrollLeft;
        state.scrollPosition.top = container.scrollTop;
    }

    if (showSpinner) {
        state.isLoadingData = true;
        showLoading();
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

        const countOptions = {
            filters,
            globalFilter: state.filterQuery,
            columns: state.tableColumns.map(c => c.name) // Needed for global filter
        };

        // Get total count
        state.totalRecordCount = await backendApi.fetchTableCount(state.selectedTable, countOptions);
        state.totalPageCount = Math.max(1, Math.ceil(state.totalRecordCount / state.rowsPerPage));

        if (state.currentPageIndex >= state.totalPageCount) {
            state.currentPageIndex = Math.max(0, state.totalPageCount - 1);
        }

        // Get data
        const isTable = state.selectedTableType === 'table';
        const columnNames = state.tableColumns.map(c => c.name);

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

        const dataResult = await backendApi.fetchTableData(state.selectedTable, queryOptions);

        state.gridData = dataResult.rows || [];

        // If not showing spinner (background refresh), capture the current scroll position
        // right before rendering. This ensures we use the latest scroll position,
        // which covers cases where the user scrolled during fetch or if an edit operation
        // updated the view (and restored scroll) while the fetch was pending.
        if (!showSpinner && container && container.querySelector('.data-grid')) {
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
        }

        if (container) {
            container.scrollLeft = state.scrollPosition.left;
            container.scrollTop = state.scrollPosition.top;
        }

        updatePagination();
        updateStatus(`${state.totalRecordCount} records`);

    } catch (err) {
        console.error('Error loading data:', err);
        updateStatus(`Error: ${err.message}`);
        showErrorState(err.message);
    } finally {
        if (showSpinner) {
            state.isLoadingData = false;
        }
    }
}
