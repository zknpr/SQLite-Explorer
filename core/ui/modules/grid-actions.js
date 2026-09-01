import { createSafeColumnState, state, persistState } from './state.js';
import { backendApi } from './api.js';
import { RPC_TIMEOUT_MS } from './rpc-constants.js';
import { getGridReloadOwner, loadTableData } from './grid-data.js';
import {
    MAX_COLUMN_WIDTH,
    MIN_COLUMN_WIDTH,
    renderDataGrid
} from './grid-render.js';
import { updateSelectionStates } from './grid-selection.js';
import { updateStatus, updateToolbarButtons } from './ui.js';
import { updateBatchSidebar } from './sidebar.js';
import {
    getRowId,
    getCellValue,
    getCellValueForDisplay,
    getOversizedCellMetadata,
    getOrderedColumnIndices,
    getOrderedRowIndices
} from './data-utils.js';
import { openCellPreview, startCellEdit, openCellInVsCode } from './edit.js';
import {
    GLOBAL_MATCH_SCOPE,
    getPreferredMatchScope,
    navigateMatches,
    resetMatchNav
} from './match-nav.js';
import { getErrorMessage } from './utils.js';

const FILTER_DEBOUNCE_MS = 300;
const FILTER_RELOAD_RETRY_MS = 50;
// One grid load fetches count and data in parallel but may still issue one
// sequential follow-up data fetch (count-first 'last' navigation, a clamp
// correction, or the keyset OFFSET retry), so its legitimate lifetime can
// approach two RPC deadlines. A missing owner is an impossible production
// state, but still gets a short fail-safe bound instead of spinning.
const FILTER_RELOAD_OWNER_WAIT_MS = RPC_TIMEOUT_MS * 2;
const FILTER_RELOAD_FALLBACK_WAIT_MS = 5000;
const LARGE_SELECTION_WARNING_THRESHOLD = 10_000;
const LARGE_SELECTION_HARD_LIMIT = 100_000;
const SELECTION_ALLOWED_SYNCHRONOUSLY = Symbol('selection-allowed-synchronously');

let selectionRequestSequence = 0;

function captureSelectionContext(requestId) {
    return {
        requestId,
        table: state.selectedTable,
        gridData: state.gridData,
        tableColumns: state.tableColumns,
        selectedCells: state.selectedCells,
        selectedCellCount: state.selectedCells.length,
        selectedRowIds: state.selectedRowIds,
        selectedRowCount: state.selectedRowIds.size,
        selectedColumns: state.selectedColumns,
        selectedColumnCount: state.selectedColumns.size,
        lastSelectedCell: state.lastSelectedCell,
        lastSelectedRowIndex: state.lastSelectedRowIndex,
        lastSelectedColumnIndex: state.lastSelectedColumnIndex
    };
}

function isSelectionContextCurrent(context) {
    return selectionRequestSequence === context.requestId
        && state.selectedTable === context.table
        && state.gridData === context.gridData
        && state.tableColumns === context.tableColumns
        && state.selectedCells === context.selectedCells
        && state.selectedCells.length === context.selectedCellCount
        && state.selectedRowIds === context.selectedRowIds
        && state.selectedRowIds.size === context.selectedRowCount
        && state.selectedColumns === context.selectedColumns
        && state.selectedColumns.size === context.selectedColumnCount
        && state.lastSelectedCell === context.lastSelectedCell
        && state.lastSelectedRowIndex === context.lastSelectedRowIndex
        && state.lastSelectedColumnIndex === context.lastSelectedColumnIndex;
}

function formatSelectionCount(count, unit) {
    return `${count.toLocaleString()} ${unit}`;
}

function selectionErrorMessage(error) {
    return getErrorMessage(error);
}

/**
 * Refuse pathological allocations outright and require a host-owned modal for
 * merely large ones. The host receives numbers and strings only; callbacks do
 * not survive the webview RPC boundary. Any transport failure or stale grid
 * context leaves the current selection untouched.
 */
function guardSelectionAllocation(itemCount, currentItemCount, unit, applySelection) {
    const requestId = ++selectionRequestSequence;
    const context = captureSelectionContext(requestId);

    if (!Number.isSafeInteger(itemCount) || itemCount < 0) {
        updateStatus('Selection blocked because its size could not be calculated safely.');
        return false;
    }
    if (itemCount <= currentItemCount) return SELECTION_ALLOWED_SYNCHRONOUSLY;
    if (itemCount > LARGE_SELECTION_HARD_LIMIT) {
        updateStatus(
            `Selection blocked: ${formatSelectionCount(itemCount, unit)} would exceed the ` +
            `${LARGE_SELECTION_HARD_LIMIT.toLocaleString()}-item limit. Use Export instead.`
        );
        return false;
    }
    if (itemCount <= LARGE_SELECTION_WARNING_THRESHOLD) {
        return SELECTION_ALLOWED_SYNCHRONOUSLY;
    }

    let confirmation;
    try {
        confirmation = backendApi.confirmLargeSelection(itemCount, unit);
    } catch (error) {
        console.error('Large selection confirmation failed:', error);
        updateStatus(`Selection cancelled: ${selectionErrorMessage(error)}`);
        return false;
    }

    return Promise.resolve(confirmation).then(confirmed => {
        if (confirmed !== true || !isSelectionContextCurrent(context)) return false;
        applySelection();
        return true;
    }).catch(error => {
        console.error('Large selection confirmation failed:', error);
        if (isSelectionContextCurrent(context)) {
            updateStatus(`Selection cancelled: ${selectionErrorMessage(error)}`);
        }
        return false;
    });
}

function getOrderedRange(orderedIndices, firstIndex, lastIndex, sourceLength) {
    const firstVisualIndex = orderedIndices.indexOf(firstIndex);
    const lastVisualIndex = orderedIndices.indexOf(lastIndex);
    if (firstVisualIndex >= 0 && lastVisualIndex >= 0) {
        const start = Math.min(firstVisualIndex, lastVisualIndex);
        const end = Math.max(firstVisualIndex, lastVisualIndex);
        return orderedIndices.slice(start, end + 1);
    }

    // A stale anchor can survive only defensive/unit-level direct calls; keep
    // the established clamped source-order degradation instead of throwing.
    const start = Math.min(firstIndex, lastIndex);
    const end = Math.min(Math.max(firstIndex, lastIndex), sourceLength - 1);
    const range = [];
    for (let index = start; index <= end; index++) range.push(index);
    return range;
}

function countSelectedCellsInRanges(rowIndices, columnIndices) {
    const rows = new Set(rowIndices);
    const columns = new Set(columnIndices);
    let count = 0;
    for (const cell of state.selectedCells) {
        if (rows.has(cell.rowIdx) && columns.has(cell.colIdx)) {
            count++;
        }
    }
    return count;
}

function estimateColumnSelectionSize(event, colIdx) {
    const rowCount = state.gridData.length;
    if (event.shiftKey && state.lastSelectedColumnIndex !== null) {
        const columnIndices = getOrderedRange(
            getOrderedColumnIndices(),
            state.lastSelectedColumnIndex,
            colIdx,
            state.tableColumns.length
        );
        const rectangleSize = columnIndices.length * rowCount;
        if (!(event.metaKey || event.ctrlKey)) return rectangleSize;
        return state.selectedCells.length + rectangleSize
            - countSelectedCellsInRanges(
                Array.from({ length: rowCount }, (_unused, index) => index),
                columnIndices
            );
    }

    let selectedInColumn = 0;
    for (const cell of state.selectedCells) {
        if (cell.colIdx === colIdx) selectedInColumn++;
    }
    const isFullySelected = rowCount > 0 && selectedInColumn === rowCount;
    if (event.metaKey || event.ctrlKey) {
        return isFullySelected
            ? state.selectedCells.length - selectedInColumn
            : state.selectedCells.length + rowCount - selectedInColumn;
    }
    return isFullySelected
        && state.selectedColumns.size === 1
        && state.selectedColumns.has(state.tableColumns[colIdx].name)
        ? 0
        : rowCount;
}

function estimateRowSelectionSize(event, rowId, rowIdx) {
    if (event.shiftKey && state.lastSelectedRowIndex !== null) {
        const rowIndices = getOrderedRange(
            getOrderedRowIndices(),
            state.lastSelectedRowIndex,
            rowIdx,
            state.gridData.length
        );
        if (!(event.metaKey || event.ctrlKey)) return rowIndices.length;

        let missing = 0;
        for (const index of rowIndices) {
            if (!state.selectedRowIds.has(getRowId(state.gridData[index], index))) missing++;
        }
        return state.selectedRowIds.size + missing;
    }
    if (event.ctrlKey || event.metaKey) {
        return state.selectedRowIds.size + (state.selectedRowIds.has(rowId) ? -1 : 1);
    }
    return state.selectedRowIds.has(rowId) && state.selectedRowIds.size === 1 ? 0 : 1;
}

function estimateSelectAllSize() {
    let missing = 0;
    for (let index = 0; index < state.gridData.length; index++) {
        if (!state.selectedRowIds.has(getRowId(state.gridData[index], index))) missing++;
    }
    return missing === 0 ? 0 : state.selectedRowIds.size + missing;
}

function estimateCellSelectionSize(event, rowIdx, colIdx) {
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && state.lastSelectedCell) {
        const rowIndices = getOrderedRange(
            getOrderedRowIndices(),
            state.lastSelectedCell.rowIdx,
            rowIdx,
            state.gridData.length
        );
        const columnIndices = getOrderedRange(
            getOrderedColumnIndices(),
            state.lastSelectedCell.colIdx,
            colIdx,
            state.tableColumns.length
        );
        const rectangleSize = rowIndices.length * columnIndices.length;
        return state.selectedCells.length + rectangleSize
            - countSelectedCellsInRanges(rowIndices, columnIndices);
    }
    if (event.metaKey || event.ctrlKey) {
        const isSelected = state.selectedCells.some(
            cell => cell.rowIdx === rowIdx && cell.colIdx === colIdx
        );
        return state.selectedCells.length + (isSelected ? -1 : 1);
    }
    if (event.shiftKey && state.lastSelectedCell) {
        const rowIndices = getOrderedRange(
            getOrderedRowIndices(),
            state.lastSelectedCell.rowIdx,
            rowIdx,
            state.gridData.length
        );
        const columnIndices = getOrderedRange(
            getOrderedColumnIndices(),
            state.lastSelectedCell.colIdx,
            colIdx,
            state.tableColumns.length
        );
        return rowIndices.length * columnIndices.length;
    }
    return 1;
}

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

function scheduleFilterApply(
    delay = FILTER_DEBOUNCE_MS,
    table = state.selectedTable,
    reloadWait = null
) {
    clearFilterTimer();
    state.filterTimer = setTimeout(() => {
        state.filterTimer = null;
        return processFilterQueue(table, reloadWait);
    }, delay);
}

function getReloadWait(owner, previousWait) {
    const ownerToken = owner?.token ?? null;
    if (previousWait?.ownerToken === ownerToken) return previousWait;
    return {
        ownerToken,
        deadline: (owner?.startedAt ?? Date.now()) + (
            owner ? FILTER_RELOAD_OWNER_WAIT_MS : FILTER_RELOAD_FALLBACK_WAIT_MS
        )
    };
}

async function processFilterQueue(table = state.selectedTable, reloadWait = null) {
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
        const nextReloadWait = getReloadWait(getGridReloadOwner(), reloadWait);
        if (Date.now() >= nextReloadWait.deadline) {
            state.filterApplyPending = false;
            state.filterApplyTable = null;
            state.filterPendingAction = null;
            updateStatus('Filter draft retained; it will apply on the next grid reload.');
            return false;
        }
        scheduleFilterApply(FILTER_RELOAD_RETRY_MS, table, nextReloadWait);
        return undefined;
    }

    if (state.filterApplyPending) {
        state.filterApplyPending = false;
        const result = await loadTableData(false);
        if (result !== true) {
            // Text typed during the failed request is a distinct successor and
            // should still be tried immediately against the retained grid.
            if (result === false && state.filterApplyPending) {
                clearFilterTimer();
                return processFilterQueue(table);
            }

            // A superseded request has another load in progress; retry when that
            // owner releases the guard.
            if (result === undefined) {
                if (table === state.selectedTable && !state.filterApplyPending) {
                    state.filterApplyPending = true;
                    state.filterApplyTable = table;
                }
                scheduleFilterApply(FILTER_RELOAD_RETRY_MS, table);
                return result;
            }

            // A genuine query failure must not become the persisted/current
            // predicate. Restore the filter identity paired with the grid that
            // loadTableData deliberately kept mounted; the failed draft remains
            // in the live input for correction and another debounce/Enter.
            const successful = state.lastSuccessfulFilterState;
            if (successful?.table === table) {
                state.filterQuery = successful.filterQuery;
                state.columnFilters = createSafeColumnState(successful.columnFilters);
            }
            state.filterApplyPending = false;
            state.filterApplyTable = null;
            state.filterPendingAction = null;
            persistState();
            const details = state.lastGridLoadError ? `: ${state.lastGridLoadError}` : '';
            updateStatus(`Filter failed and was reverted${details}`);
            return result;
        }
        persistState();
    }

    // Text typed during the fetch scheduled a later application. The first load
    // rebuilt the header from the latest captured draft but returned rows for its
    // older snapshot. Start the successor immediately so that mismatch is never
    // left interactive for the remainder of the debounce window.
    if (state.filterApplyPending) {
        const pendingAction = state.filterPendingAction;
        if (pendingAction?.table === table && pendingAction.focusScope !== null) {
            focusFilterInput(pendingAction.focusScope);
        }
        clearFilterTimer();
        return processFilterQueue(table);
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

export function goToPage(pageIndex, navIntent) {
    if (pageIndex >= 0 && pageIndex < state.totalPageCount) {
        state.currentPageIndex = pageIndex;
        state.scrollPosition = { top: 0, left: 0 };
        resetMatchNav();
        // Callers without an intent (arbitrary jumps) load via OFFSET.
        loadTableData(true, false, navIntent);
        persistState();
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
export function onColumnHeaderClick(event, columnName, allocationConfirmed = false) {
    event.stopPropagation();
    const colIdx = state.tableColumns.findIndex(c => c.name === columnName);
    if (colIdx === -1) return;

    // Prevent default to avoid text selection highlight
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
        event.preventDefault();
    }

    if (!allocationConfirmed) {
        const guardResult = guardSelectionAllocation(
            estimateColumnSelectionSize(event, colIdx),
            state.selectedCells.length,
            'cells',
            () => onColumnHeaderClick(event, columnName, true)
        );
        if (guardResult !== SELECTION_ALLOWED_SYNCHRONOUSLY) return guardResult;
    }

    state.selectedRowIds.clear();

    // Range Selection (Shift)
    if (event.shiftKey && state.lastSelectedColumnIndex !== null) {
        if (!(event.metaKey || event.ctrlKey)) {
            // Clear previous if not adding to selection
            state.selectedCells = [];
            state.selectedColumns.clear();
        }

        const columnIndices = getOrderedRange(
            getOrderedColumnIndices(),
            state.lastSelectedColumnIndex,
            colIdx,
            state.tableColumns.length
        );
        const rangeColumns = new Set(columnIndices);

        const existingRows = new Array();
        // If appending, index existing selected cells for efficiency
        if (state.selectedCells.length > 0) {
            for (const sc of state.selectedCells) {
                if (rangeColumns.has(sc.colIdx)) {
                    if (!existingRows[sc.rowIdx]) existingRows[sc.rowIdx] = new Set();
                    existingRows[sc.rowIdx].add(sc.colIdx);
                }
            }
        }

        for (const c of columnIndices) {
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
    const newWidth = Math.max(MIN_COLUMN_WIDTH, state.resizeStartWidth + deltaX);
    applyColumnWidth(state.resizingColumn, newWidth);
}

function applyColumnWidth(columnName, newWidth) {
    state.columnWidths[columnName] = newWidth;

    const colIdx = state.tableColumns.findIndex(c => c.name === columnName);
    if (colIdx === -1) return;

    // Direct DOM update for performance
    const headerCell = [...document.querySelectorAll('th[data-column]')]
        .find(cell => cell.dataset.column === columnName);
    if (headerCell) {
        headerCell.style.width = `${newWidth}px`;
        headerCell.style.minWidth = `${newWidth}px`;
        headerCell.style.maxWidth = `${newWidth}px`;
    }

    // Need to account for pinned columns offsets potentially changing if we resize a pinned column
    // Pinned columns render before unpinned columns, so source nth-child no
    // longer identifies a column. The stable source index travels on each td.
    const dataCells = document.querySelectorAll(
        `.data-row td.data-cell[data-colidx="${colIdx}"]`
    );
    for (const cell of dataCells) {
        cell.style.width = `${newWidth}px`;
        cell.style.minWidth = `${newWidth}px`;
        cell.style.maxWidth = `${newWidth}px`;
        // Overflow was measured against the old width. Remove both the cache
        // marker and its derived UI state so the next hover measures again.
        cell.classList?.remove?.('checked-overflow', 'has-overflow');
    }

}

export function onColumnResizeKeydown(event, columnName) {
    const step = event.shiftKey ? 1 : 10;
    const currentWidth = state.columnWidths[columnName] || 120;
    let nextWidth;
    if (event.key === 'ArrowLeft') nextWidth = currentWidth - step;
    else if (event.key === 'ArrowRight') nextWidth = currentWidth + step;
    else if (event.key === 'Home') nextWidth = MIN_COLUMN_WIDTH;
    else if (event.key === 'End') nextWidth = MAX_COLUMN_WIDTH;
    else return false;

    event.preventDefault();
    event.stopPropagation();
    nextWidth = Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, nextWidth));
    applyColumnWidth(columnName, nextWidth);
    if (state.pinnedColumns.has(columnName)) {
        renderDataGrid();
        const header = [...document.querySelectorAll('th[data-column]')]
            .find(cell => cell.dataset.column === columnName);
        header?.querySelector?.('.resize-handle')?.focus?.();
    } else {
        event.target?.setAttribute?.('aria-valuenow', String(nextWidth));
    }
    persistState();
    return true;
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
    persistState();
}

// Row Selection
export function onRowNumberClick(event, rowId, rowIdx, allocationConfirmed = false) {
    event.stopPropagation();
    // Prevent default to avoid text selection highlight
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
        event.preventDefault();
    }

    if (!allocationConfirmed) {
        const guardResult = guardSelectionAllocation(
            estimateRowSelectionSize(event, rowId, rowIdx),
            state.selectedRowIds.size,
            'rows',
            () => onRowNumberClick(event, rowId, rowIdx, true)
        );
        if (guardResult !== SELECTION_ALLOWED_SYNCHRONOUSLY) return guardResult;
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

        const rowIndices = getOrderedRange(
            getOrderedRowIndices(),
            state.lastSelectedRowIndex,
            rowIdx,
            state.gridData.length
        );

        for (const i of rowIndices) {
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

export function onSelectAllClick(event, allocationConfirmed = false) {
    event.stopPropagation();
    if (state.gridData.length === 0) return;

    if (!allocationConfirmed) {
        const guardResult = guardSelectionAllocation(
            estimateSelectAllSize(),
            state.selectedRowIds.size,
            'rows',
            () => onSelectAllClick(event, true)
        );
        if (guardResult !== SELECTION_ALLOWED_SYNCHRONOUSLY) return guardResult;
    }

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
export function onCellClick(event, rowIdx, colIdx, rowId, allocationConfirmed = false) {
    event.stopPropagation();
    if (state.isLoadingData || state.isSavingCell || state.isTransitioningEdit || state.editingCellInfo) return;

    if (!allocationConfirmed) {
        const guardResult = guardSelectionAllocation(
            estimateCellSelectionSize(event, rowIdx, colIdx),
            state.selectedCells.length,
            'cells',
            () => onCellClick(event, rowIdx, colIdx, rowId, true)
        );
        if (guardResult !== SELECTION_ALLOWED_SYNCHRONOUSLY) return guardResult;
    }

    const value = state.gridData[rowIdx] ? getCellValue(state.gridData[rowIdx], colIdx) : null;
    // A cell gesture changes the selection into non-destructive cell mode.
    // Keeping a prior column marker here lets the Delete action continue to
    // target the whole column even though the user is now manipulating cells.
    state.selectedColumns.clear();
    state.lastSelectedColumnIndex = null;

    // Range selection
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && state.lastSelectedCell) {
        event.preventDefault(); // Prevent text selection
        state.selectedRowIds.clear();

        const rowIndices = getOrderedRange(
            getOrderedRowIndices(),
            state.lastSelectedCell.rowIdx,
            rowIdx,
            state.gridData.length
        );
        const columnIndices = getOrderedRange(
            getOrderedColumnIndices(),
            state.lastSelectedCell.colIdx,
            colIdx,
            state.tableColumns.length
        );
        const rangeRows = new Set(rowIndices);
        const rangeColumns = new Set(columnIndices);

        // Optimization: Map rowIdx -> Set of colIdx using a sparse array
        const existingRows = new Array();
        for (const sc of state.selectedCells) {
            if (rangeRows.has(sc.rowIdx) && rangeColumns.has(sc.colIdx)) {
                if (!existingRows[sc.rowIdx]) existingRows[sc.rowIdx] = new Set();
                existingRows[sc.rowIdx].add(sc.colIdx);
            }
        }

        for (const r of rowIndices) {
            const rowCols = existingRows[r];
            for (const c of columnIndices) {
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

        const rowIndices = getOrderedRange(
            getOrderedRowIndices(),
            state.lastSelectedCell.rowIdx,
            rowIdx,
            state.gridData.length
        );
        const columnIndices = getOrderedRange(
            getOrderedColumnIndices(),
            state.lastSelectedCell.colIdx,
            colIdx,
            state.tableColumns.length
        );

        for (const r of rowIndices) {
            for (const c of columnIndices) {
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
    }

    updateSelectionStates();
    updateToolbarButtons();
    updateBatchSidebar();
}


// Cell Double Click (Edit)
export function onCellDoubleClick(event, rowIdx, colIdx, rowId) {
    // Containment marks a value as non-editable in the grid, not non-viewable.
    // Route every bounded preview to the recovery UI before edit preferences.
    if (getOversizedCellMetadata(rowIdx, colIdx)) {
        return openCellPreview(rowIdx, colIdx, rowId);
    }
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
            originalValue: value,
            originalText: String(getCellValueForDisplay(row, rowIdx, colIdx) ?? '')
        };
        openCellInVsCode();

    } else if (state.cellEditBehavior === 'modal') {
        openCellPreview(rowIdx, colIdx, rowId);
    } else {
        startCellEdit(rowIdx, colIdx, rowId);
    }
}
