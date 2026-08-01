import { state, persistState } from './state.js';
import { loadTableData } from './grid-data.js';
import { renderDataGrid } from './grid-render.js';
import { updateSelectionStates } from './grid-selection.js';
import { updateToolbarButtons } from './ui.js';
import { updateBatchSidebar } from './sidebar.js';
import { getRowId, getCellValue } from './data-utils.js';
import { openCellPreview, startCellEdit, openCellInVsCode } from './edit.js';
import {
    GLOBAL_MATCH_SCOPE,
    getPreferredMatchScope,
    navigateMatches,
    resetMatchNav
} from './match-nav.js';

const FILTER_DEBOUNCE_MS = 300;
const FILTER_RELOAD_RETRY_MS = 50;

function getColumnFilterInput(columnName) {
    return [...document.querySelectorAll('.column-filter')]
        .find(input => input.dataset.column === columnName) || null;
}

function updateFilterClearButton(input) {
    if (!input) return;
    const isGlobal = input === document.getElementById('filterInput');
    const button = isGlobal
        ? document.getElementById('btnClearFilter')
        : input.closest?.('.column-filter-wrap')?.querySelector?.('.filter-clear-btn');
    if (button) button.hidden = input.value.length === 0;
}

function markFilterDraftChanged() {
    state.currentPageIndex = 0;
    state.filterApplyPending = true;
    state.filterApplyTable = state.selectedTable;
    // A newer draft supersedes navigation requested for older text.
    state.filterPendingAction = null;
    resetMatchNav();
}

/**
 * Capture every live filter input as one coherent draft. This must happen
 * synchronously in the input event, before a reload can rebuild the header.
 */
export function syncFilterInputsToState() {
    let changed = false;
    const globalInput = document.getElementById('filterInput');
    if (globalInput) {
        updateFilterClearButton(globalInput);
        if (state.filterQuery !== globalInput.value) {
            state.filterQuery = globalInput.value;
            changed = true;
        }
    }

    document.querySelectorAll('.column-filter').forEach(input => {
        const columnName = input.dataset.column;
        if (columnName === undefined) return;
        updateFilterClearButton(input);
        const previous = state.columnFilters[columnName] || '';
        if (previous === input.value) return;
        if (input.value === '') delete state.columnFilters[columnName];
        else state.columnFilters[columnName] = input.value;
        changed = true;
    });

    if (changed) markFilterDraftChanged();
    return changed;
}

function clearFilterTimer() {
    if (state.filterTimer !== null) {
        clearTimeout(state.filterTimer);
        state.filterTimer = null;
    }
}

function focusFilterInput(scope) {
    const input = scope === GLOBAL_MATCH_SCOPE
        ? document.getElementById('filterInput')
        : getColumnFilterInput(scope);
    if (!input) return;
    input.focus();
    input.setSelectionRange?.(input.value.length, input.value.length);
}

function scheduleFilterApply(delay = FILTER_DEBOUNCE_MS, table = state.selectedTable) {
    clearFilterTimer();
    state.filterTimer = setTimeout(() => {
        state.filterTimer = null;
        return processFilterQueue(table);
    }, delay);
}

async function processFilterQueue(table = state.selectedTable) {
    // A table switch resets the filter state. Never let an old debounce reload or
    // focus a different table's controls.
    if (table !== state.selectedTable) {
        if (state.filterApplyTable === table) {
            state.filterApplyPending = false;
            state.filterApplyTable = null;
        }
        if (state.filterPendingAction?.table === table) state.filterPendingAction = null;
        return;
    }

    if (!table) {
        state.filterApplyPending = false;
        state.filterApplyTable = null;
        const action = state.filterPendingAction;
        state.filterPendingAction = null;
        if (action?.focusScope !== null && action?.focusScope !== undefined) {
            focusFilterInput(action.focusScope);
        }
        persistState();
        return false;
    }

    // Queue behind the owner of the reload guard instead of starting a competing
    // request. Input events still update state immediately while we wait.
    if (state.isGridReloading) {
        scheduleFilterApply(FILTER_RELOAD_RETRY_MS, table);
        return;
    }

    if (state.filterApplyPending) {
        state.filterApplyPending = false;
        const result = await loadTableData(false);
        if (result !== true) {
            if (table === state.selectedTable && !state.filterApplyPending) {
                state.filterApplyPending = true;
                state.filterApplyTable = table;
            }
            // A superseded request has another load in progress; retry when that
            // owner releases the guard. A real query failure remains retryable by
            // the next input/Enter without an automatic error loop.
            if (result === undefined) scheduleFilterApply(FILTER_RELOAD_RETRY_MS, table);
            return result;
        }
        persistState();
    }

    // Text typed during the fetch scheduled a later application. The first load
    // rebuilt the header from the latest captured draft, so restore that input's
    // focus immediately; defer only navigation until the successor rows arrive.
    if (state.filterApplyPending) {
        const pendingAction = state.filterPendingAction;
        if (pendingAction?.table === table && pendingAction.focusScope !== null) {
            focusFilterInput(pendingAction.focusScope);
        }
        return true;
    }

    state.filterApplyTable = null;
    const action = state.filterPendingAction;
    if (!action || action.table !== table) return true;
    state.filterPendingAction = null;
    if (action.focusScope !== null) focusFilterInput(action.focusScope);
    if (action.navigate) navigateMatches(action.scope, action.direction);
    return true;
}

function requestFilterAction({ scope, direction = 1, navigate = true, focusScope = scope }) {
    clearFilterTimer();
    state.filterPendingAction = {
        table: state.selectedTable,
        scope,
        direction,
        navigate,
        focusScope
    };
    return processFilterQueue(state.selectedTable);
}

function scopeForInput(input) {
    if (input === document.getElementById('filterInput')) return GLOBAL_MATCH_SCOPE;
    return input?.dataset?.column ?? null;
}

/** Capture a draft on every keystroke and debounce its data reload. */
export function onFilterInput(event) {
    const changed = syncFilterInputsToState();
    if (changed) {
        const focusScope = scopeForInput(event.target);
        state.filterPendingAction = {
            table: state.selectedTable,
            scope: focusScope,
            direction: 1,
            navigate: false,
            focusScope
        };
    }

    // Do not submit a partially composed IME value. compositionend is wired to
    // this same handler and starts the normal debounce.
    if (event.isComposing) {
        clearFilterTimer();
        return;
    }
    if (state.filterApplyPending) scheduleFilterApply();
}

export async function applyGlobalFilter(direction = 1) {
    const input = document.getElementById('filterInput');
    if (!input) return;
    syncFilterInputsToState();
    return requestFilterAction({ scope: GLOBAL_MATCH_SCOPE, direction });
}

export function onFilterEnter(event) {
    // Enter jumps to the next match, Shift+Enter to the previous one. Ignore the
    // Enter that confirms an IME composition candidate (isComposing) so we don't
    // submit the filter / preventDefault before the composed text is committed.
    if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        return applyGlobalFilter(event.shiftKey ? -1 : 1);
    }
}

export function onPageSizeChange() {
    state.rowsPerPage = parseInt(document.getElementById('pageSizeSelect').value, 10);
    state.currentPageIndex = 0;
    resetMatchNav();
    loadTableData();
    persistState();
}

export function onDateFormatChange() {
    const select = document.getElementById('dateFormatSelect');
    if (select) {
        state.dateFormat = select.value;
        // Cached matches were computed against the previous formatted text, so they
        // (and the highlighted active cell) are stale once the format changes.
        resetMatchNav();
        renderDataGrid();
        persistState();
    }
}

export function goToPage(pageIndex) {
    if (pageIndex >= 0 && pageIndex < state.totalPageCount) {
        state.currentPageIndex = pageIndex;
        state.scrollPosition = { top: 0, left: 0 };
        resetMatchNav();
        loadTableData(true, false);
    }
}

export function onColumnSort(columnName) {
    // Cycle through three states on repeated clicks of the same column:
    // none (original order) -> ascending -> descending -> none ...
    if (state.sortedColumn !== columnName) {
        state.sortedColumn = columnName;
        state.sortAscending = true;
    } else if (state.sortAscending) {
        state.sortAscending = false;
    } else {
        // Back to the original, unsorted order.
        state.sortedColumn = null;
        state.sortAscending = true;
    }
    resetMatchNav();
    loadTableData();
    persistState();
}

export async function applyColumnFilter(columnName, direction = 1) {
    const input = getColumnFilterInput(columnName);
    if (!input) return;
    syncFilterInputsToState();
    return requestFilterAction({ scope: columnName, direction });
}

export function onColumnFilterKeydown(event, columnName) {
    // Enter jumps to the next match, Shift+Enter to the previous one. Ignore the
    // IME composition-confirm Enter (isComposing) so CJK input isn't broken.
    if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        return applyColumnFilter(columnName, event.shiftKey ? -1 : 1);
    }
}

/** Apply/navigate the currently active filter from a non-editor grid cell. */
export function applyCurrentFilter(direction = 1) {
    syncFilterInputsToState();
    const scope = getPreferredMatchScope();
    if (scope === null) return null;
    return requestFilterAction({ scope, direction });
}

export function clearGlobalFilter() {
    const input = document.getElementById('filterInput');
    if (!input) return;
    input.value = '';
    syncFilterInputsToState();
    focusFilterInput(GLOBAL_MATCH_SCOPE);
    return requestFilterAction({
        scope: GLOBAL_MATCH_SCOPE,
        navigate: false,
        focusScope: GLOBAL_MATCH_SCOPE
    });
}

export function clearColumnFilter(columnName) {
    const input = getColumnFilterInput(columnName);
    if (!input) return;
    input.value = '';
    syncFilterInputsToState();
    focusFilterInput(columnName);
    return requestFilterAction({
        scope: columnName,
        navigate: false,
        focusScope: columnName
    });
}

// Column Selection
export function onColumnHeaderClick(event, columnName) {
    event.stopPropagation();
    const colIdx = state.tableColumns.findIndex(c => c.name === columnName);
    if (colIdx === -1) return;

    // Prevent default to avoid text selection highlight
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
        event.preventDefault();
    }

    state.selectedRowIds.clear();

    // Range Selection (Shift)
    if (event.shiftKey && state.lastSelectedColumnIndex !== null) {
        if (!(event.metaKey || event.ctrlKey)) {
            // Clear previous if not adding to selection
            state.selectedCells = [];
            state.selectedColumns.clear();
        }

        const start = Math.min(state.lastSelectedColumnIndex, colIdx);
        const end = Math.max(state.lastSelectedColumnIndex, colIdx);

        const existingRows = new Array();
        // If appending, index existing selected cells for efficiency
        if (state.selectedCells.length > 0) {
            for (const sc of state.selectedCells) {
                if (sc.colIdx >= start && sc.colIdx <= end) {
                    if (!existingRows[sc.rowIdx]) existingRows[sc.rowIdx] = new Set();
                    existingRows[sc.rowIdx].add(sc.colIdx);
                }
            }
        }

        for (let c = start; c <= end; c++) {
            const colName = state.tableColumns[c].name;
            state.selectedColumns.add(colName);

            for (let r = 0; r < state.gridData.length; r++) {
                const rowCols = existingRows[r];
                if (!rowCols || !rowCols.has(c)) {
                    const rowId = getRowId(state.gridData[r], r);
                    const value = getCellValue(state.gridData[r], c);
                    state.selectedCells.push({ rowIdx: r, colIdx: c, rowId, value });
                }
            }
        }
    }
    // Multi Selection (Cmd/Ctrl)
    else if ((event.metaKey || event.ctrlKey)) {
        // Toggle add/remove column

        // Check if this specific column is fully selected
        const columnCellCount = state.gridData.length;
        let selectedInColumn = 0;
        for (const sc of state.selectedCells) {
            if (sc.colIdx === colIdx) selectedInColumn++;
        }
        const isColumnFullySelected = columnCellCount > 0 && selectedInColumn === columnCellCount;

        if (isColumnFullySelected) {
            state.selectedCells = state.selectedCells.filter(sc => sc.colIdx !== colIdx);
            state.selectedColumns.delete(columnName);
        } else {
            // Add missing cells - Optimization: Use Set for fast lookup of rows in this column
            const existingRows = new Set();
            for (const sc of state.selectedCells) {
                if (sc.colIdx === colIdx) {
                    existingRows.add(sc.rowIdx);
                }
            }

            for (let r = 0; r < state.gridData.length; r++) {
                if (!existingRows.has(r)) {
                    const rowId = getRowId(state.gridData[r], r);
                    const value = getCellValue(state.gridData[r], colIdx);
                    state.selectedCells.push({ rowIdx: r, colIdx, rowId, value });
                }
            }
            state.selectedColumns.add(columnName);
        }
        state.lastSelectedColumnIndex = colIdx;
    } else {
        // Check if this specific column is fully selected
        const columnCellCount = state.gridData.length;
        let selectedInColumn = 0;
        for (const sc of state.selectedCells) {
            if (sc.colIdx === colIdx) selectedInColumn++;
        }
        const isColumnFullySelected = columnCellCount > 0 && selectedInColumn === columnCellCount;

        // Toggle selection if this column is already fully selected and is the only column selected
        if (isColumnFullySelected && state.selectedColumns.size === 1 && state.selectedColumns.has(columnName)) {
            state.selectedCells = [];
            state.selectedColumns.clear();
            state.lastSelectedColumnIndex = null;
        } else {
            // Select only this column
            state.selectedCells = [];
            state.selectedColumns.clear();
            for (let r = 0; r < state.gridData.length; r++) {
                const rowId = getRowId(state.gridData[r], r);
                const value = getCellValue(state.gridData[r], colIdx);
                state.selectedCells.push({ rowIdx: r, colIdx, rowId, value });
            }
            state.selectedColumns.add(columnName);
            state.lastSelectedColumnIndex = colIdx;
        }
    }

    state.lastSelectedCell = null;
    updateSelectionStates();
    updateToolbarButtons();
    updateBatchSidebar();
}

// Column Pinning
export function toggleColumnPin(event, columnName) {
    event.stopPropagation();
    if (state.pinnedColumns.has(columnName)) {
        state.pinnedColumns.delete(columnName);
    } else {
        state.pinnedColumns.add(columnName);
    }
    resetMatchNav();
    renderDataGrid();
    persistState();
}

// Row Pinning
export function toggleRowPin(event, rowId) {
    event.stopPropagation();
    if (state.pinnedRowIds.has(rowId)) {
        state.pinnedRowIds.delete(rowId);
    } else {
        state.pinnedRowIds.add(rowId);
    }
    resetMatchNav();
    renderDataGrid();
    persistState();
}

// Column Resizing
export function startColumnResize(event, columnName) {
    event.stopPropagation();
    state.resizingColumn = columnName;
    state.resizeStartX = event.clientX;
    state.resizeStartWidth = state.columnWidths[columnName] || 120;

    const handle = event.target;
    handle.classList.add('resizing');

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    document.addEventListener('mousemove', onColumnResize);
    document.addEventListener('mouseup', stopColumnResize);
}

export function onColumnResize(event) {
    if (!state.resizingColumn) return;
    const deltaX = event.clientX - state.resizeStartX;
    const newWidth = Math.max(30, state.resizeStartWidth + deltaX);
    state.columnWidths[state.resizingColumn] = newWidth;

    const colIdx = state.tableColumns.findIndex(c => c.name === state.resizingColumn);
    if (colIdx === -1) return;

    // Direct DOM update for performance
    const headerCell = document.querySelector(`th[data-column="${state.resizingColumn}"]`);
    if (headerCell) {
        headerCell.style.width = `${newWidth}px`;
        headerCell.style.minWidth = `${newWidth}px`;
        headerCell.style.maxWidth = `${newWidth}px`;
    }

    // Need to account for pinned columns offsets potentially changing if we resize a pinned column
    const dataCells = document.querySelectorAll(`.data-row td:nth-child(${colIdx + 2})`); // +2 because nth-child is 1-based and we have row number column
    for (const cell of dataCells) {
        cell.style.width = `${newWidth}px`;
        cell.style.minWidth = `${newWidth}px`;
        cell.style.maxWidth = `${newWidth}px`;
    }

    // If we are resizing a pinned column, subsequent pinned columns' offsets might change.
    // We defer the full re-render to stopColumnResize to avoid performance degradation during drag.
    if (state.pinnedColumns.has(state.resizingColumn)) {
    }
}

export function stopColumnResize() {
    if (!state.resizingColumn) return;

    const handle = document.querySelector('.resize-handle.resizing');
    if (handle) handle.classList.remove('resizing');

    state.resizingColumn = null;
    document.removeEventListener('mousemove', onColumnResize);
    document.removeEventListener('mouseup', stopColumnResize);

    document.body.style.userSelect = '';
    document.body.style.cursor = '';

    // Full re-render to ensure pinned columns are correct
    renderDataGrid();
}

// Row Selection
export function onRowNumberClick(event, rowId, rowIdx) {
    event.stopPropagation();
    // Prevent default to avoid text selection highlight
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
        event.preventDefault();
    }

    // Clear cell selection
    state.selectedCells = [];
    state.lastSelectedCell = null;
    state.selectedColumns.clear();

    // Range Selection (Shift)
    if (event.shiftKey && state.lastSelectedRowIndex !== null) {
        if (!(event.metaKey || event.ctrlKey)) {
            state.selectedRowIds.clear();
        }

        const start = Math.min(state.lastSelectedRowIndex, rowIdx);
        const end = Math.max(state.lastSelectedRowIndex, rowIdx);

        for (let i = start; i <= end; i++) {
            const id = getRowId(state.gridData[i], i);
            state.selectedRowIds.add(id);
        }
    }
    // Multi Selection (Cmd/Ctrl)
    else if (event.ctrlKey || event.metaKey) {
        if (state.selectedRowIds.has(rowId)) {
            state.selectedRowIds.delete(rowId);
        } else {
            state.selectedRowIds.add(rowId);
        }
        state.lastSelectedRowIndex = rowIdx;
    }
    // Single Selection
    else {
        if (state.selectedRowIds.has(rowId) && state.selectedRowIds.size === 1) {
            state.selectedRowIds.delete(rowId);
            state.lastSelectedRowIndex = null;
        } else {
            state.selectedRowIds.clear();
            state.selectedRowIds.add(rowId);
            state.lastSelectedRowIndex = rowIdx;
        }
    }

    updateSelectionStates();
    updateToolbarButtons();
    updateBatchSidebar();
}

export function onSelectAllClick(event) {
    event.stopPropagation();
    if (state.gridData.length === 0) return;

    state.selectedCells = [];
    state.lastSelectedCell = null;
    state.selectedColumns.clear();

    // Check if all rows on current page are selected
    let allSelected = true;
    for (let i = 0; i < state.gridData.length; i++) {
        const id = getRowId(state.gridData[i], i);
        if (!state.selectedRowIds.has(id)) {
            allSelected = false;
            break;
        }
    }

    if (allSelected) {
        // If all selected, deselect all
        state.selectedRowIds.clear();
    } else {
        // Otherwise, select all (union)
        for (let i = 0; i < state.gridData.length; i++) {
            const id = getRowId(state.gridData[i], i);
            state.selectedRowIds.add(id);
        }
    }

    updateSelectionStates();
    updateToolbarButtons();
    updateBatchSidebar();
}

// Cell Click (Selection)
export function onCellClick(event, rowIdx, colIdx, rowId) {
    event.stopPropagation();
    if (state.isLoadingData || state.isSavingCell || state.isTransitioningEdit || state.editingCellInfo) return;

    const value = state.gridData[rowIdx] ? getCellValue(state.gridData[rowIdx], colIdx) : null;

    // Range selection
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && state.lastSelectedCell) {
        event.preventDefault(); // Prevent text selection
        state.selectedRowIds.clear();

        const minRow = Math.min(state.lastSelectedCell.rowIdx, rowIdx);
        const maxRow = Math.max(state.lastSelectedCell.rowIdx, rowIdx);
        const minCol = Math.min(state.lastSelectedCell.colIdx, colIdx);
        const maxCol = Math.max(state.lastSelectedCell.colIdx, colIdx);

        // Optimization: Map rowIdx -> Set of colIdx using a sparse array
        const existingRows = new Array();
        for (const sc of state.selectedCells) {
            if (sc.rowIdx >= minRow && sc.rowIdx <= maxRow && sc.colIdx >= minCol && sc.colIdx <= maxCol) {
                if (!existingRows[sc.rowIdx]) existingRows[sc.rowIdx] = new Set();
                existingRows[sc.rowIdx].add(sc.colIdx);
            }
        }

        for (let r = minRow; r <= maxRow; r++) {
            const rowCols = existingRows[r];
            for (let c = minCol; c <= maxCol; c++) {
                if (!rowCols || !rowCols.has(c)) {
                    const rId = getRowId(state.gridData[r], r);
                    const val = getCellValue(state.gridData[r], c);
                    state.selectedCells.push({ rowIdx: r, colIdx: c, rowId: rId, value: val });
                }
            }
        }
    }
    // Multi selection
    else if (event.metaKey || event.ctrlKey) {
        event.preventDefault(); // Prevent text selection
        state.selectedRowIds.clear();
        const existingIdx = state.selectedCells.findIndex(sc => sc.rowIdx === rowIdx && sc.colIdx === colIdx);
        if (existingIdx >= 0) {
            state.selectedCells.splice(existingIdx, 1);
        } else {
            state.selectedCells.push({ rowIdx, colIdx, rowId, value });
            state.lastSelectedCell = { rowIdx, colIdx };
        }
    }
    // Shift selection (range from last)
    else if (event.shiftKey && state.lastSelectedCell) {
        event.preventDefault(); // Prevent text selection
        state.selectedRowIds.clear();
        state.selectedCells = []; // Reset and select range

        const minRow = Math.min(state.lastSelectedCell.rowIdx, rowIdx);
        const maxRow = Math.max(state.lastSelectedCell.rowIdx, rowIdx);
        const minCol = Math.min(state.lastSelectedCell.colIdx, colIdx);
        const maxCol = Math.max(state.lastSelectedCell.colIdx, colIdx);

        for (let r = minRow; r <= maxRow; r++) {
            for (let c = minCol; c <= maxCol; c++) {
                const rId = getRowId(state.gridData[r], r);
                const val = getCellValue(state.gridData[r], c);
                state.selectedCells.push({ rowIdx: r, colIdx: c, rowId: rId, value: val });
            }
        }
    }
    // Single selection
    else {
        state.selectedRowIds.clear();
        state.selectedCells = [{ rowIdx, colIdx, rowId, value }];
        state.lastSelectedCell = { rowIdx, colIdx };
        state.selectedColumns.clear();
    }

    updateSelectionStates();
    updateToolbarButtons();
    updateBatchSidebar();
}


// Cell Double Click (Edit)
export function onCellDoubleClick(event, rowIdx, colIdx, rowId) {
    if (state.cellEditBehavior === 'vscode') {
        // Prepare preview info for VS Code editor
        const column = state.tableColumns[colIdx];
        if (!column) return;
        const row = state.gridData[rowIdx];
        if (!row) return;
        const value = getCellValue(row, colIdx);

        state.cellPreviewInfo = {
            rowIdx,
            colIdx,
            rowId,
            columnName: column.name,
            originalValue: value
        };
        openCellInVsCode();

    } else if (state.cellEditBehavior === 'modal') {
        openCellPreview(rowIdx, colIdx, rowId);
    } else {
        startCellEdit(rowIdx, colIdx, rowId);
    }
}
