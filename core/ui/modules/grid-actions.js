import { state, persistState } from './state.js';
import { loadTableData } from './grid-data.js';
import { renderDataGrid } from './grid-render.js';
import { updateSelectionStates } from './grid-selection.js';
import { updateToolbarButtons } from './ui.js';
import { updateBatchSidebar } from './sidebar.js';
import { getRowId, getCellValue } from './data-utils.js';
import { openCellPreview, startCellEdit, openCellInVsCode } from './edit.js';
import { navigateMatches, resetMatchNav } from './match-nav.js';

/**
 * Apply the global filter and jump to a match. The filter is only run when the
 * user submits (Enter / Search button) — there is no filter-as-you-type. If the
 * term is unchanged the grid already reflects it, so we skip the refetch and
 * just advance to the next match.
 */
export async function applyGlobalFilter(direction = 1) {
    // The toolbar filter input bypasses the #gridContainer guards, so block here
    // while a reload is in flight to avoid a concurrent refetch / acting on the
    // stale grid (the column filter is already covered by handleKeydown/handleClick).
    if (state.isGridReloading) return;
    const input = document.getElementById('filterInput');
    if (!input) return;
    const value = input.value;
    if (value !== state.filterQuery) {
        const previous = state.filterQuery;
        state.filterQuery = value;
        state.currentPageIndex = 0;
        resetMatchNav();
        const ok = await loadTableData();
        if (ok !== true) {
            // Only a fully-applied load (true) should persist/navigate. false = a
            // genuine failure: revert so the same query can be retried. undefined =
            // superseded by a newer load (pagination/page-size/table switch); leave
            // the term (that load is using it) and don't navigate against the stale
            // grid while it's still in flight.
            if (ok === false) state.filterQuery = previous;
            return;
        }
        persistState();
    }
    navigateMatches('global', direction);
}

export function onFilterEnter(event) {
    // Enter jumps to the next match, Shift+Enter to the previous one. Ignore the
    // Enter that confirms an IME composition candidate (isComposing) so we don't
    // submit the filter / preventDefault before the composed text is committed.
    if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        applyGlobalFilter(event.shiftKey ? -1 : 1);
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

/**
 * Apply a column filter and jump to a match. Like the global filter, this only
 * runs on submit (Enter / Search button). When the term changed we refetch and
 * restore focus to the (rebuilt) input so the user can keep pressing Enter to
 * cycle through matches; when unchanged we just advance to the next match.
 */
export async function applyColumnFilter(columnName, direction = 1) {
    if (state.isGridReloading) return; // don't stack a refetch/navigate on an in-flight reload
    const input = document.querySelector(`.column-filter[data-column="${columnName}"]`);
    if (!input) return;

    const changed = input.value !== (state.columnFilters[columnName] || '');
    if (changed) {
        const previous = state.columnFilters[columnName];
        state.columnFilters[columnName] = input.value;
        state.currentPageIndex = 0;
        resetMatchNav();
        const ok = await loadTableData();
        if (ok !== true) {
            // Only a fully-applied load (true) proceeds. false = genuine failure:
            // restore the prior value so the query can be retried. undefined =
            // superseded by a newer load; leave the value and don't navigate.
            if (ok === false) {
                if (previous === undefined) delete state.columnFilters[columnName];
                else state.columnFilters[columnName] = previous;
            }
            return;
        }
        // loadTableData() rebuilds the header, so the input we focused is gone.
        // Re-focus the freshly rendered one and place the caret at the end.
        const newInput = document.querySelector(`.column-filter[data-column="${columnName}"]`);
        if (newInput) {
            newInput.focus();
            newInput.setSelectionRange(newInput.value.length, newInput.value.length);
        }
    }
    navigateMatches(columnName, direction);
}

export function onColumnFilterKeydown(event, columnName) {
    // Enter jumps to the next match, Shift+Enter to the previous one. Ignore the
    // IME composition-confirm Enter (isComposing) so CJK input isn't broken.
    if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        applyColumnFilter(columnName, event.shiftKey ? -1 : 1);
    }
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
