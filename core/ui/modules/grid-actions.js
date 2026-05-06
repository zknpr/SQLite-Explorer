import { state, persistState } from './state.js';
import { loadTableData } from './grid-data.js';
import { renderDataGrid } from './grid-render.js';
import { updateSelectionStates } from './grid-selection.js';
import { updateToolbarButtons } from './ui.js';
import { updateBatchSidebar } from './sidebar.js';
import { getRowId, getCellValue } from './data-utils.js';
import { openCellPreview, startCellEdit, openCellInVsCode } from './edit.js';

export function onFilterChange() {
    clearTimeout(state.filterTimer);
    state.filterTimer = setTimeout(() => {
        state.filterQuery = document.getElementById('filterInput').value;
        state.currentPageIndex = 0;
        loadTableData();
        persistState();
    }, 300);
}

export function onPageSizeChange() {
    state.rowsPerPage = parseInt(document.getElementById('pageSizeSelect').value, 10);
    state.currentPageIndex = 0;
    loadTableData();
    persistState();
}

export function onDateFormatChange() {
    const select = document.getElementById('dateFormatSelect');
    if (select) {
        state.dateFormat = select.value;
        renderDataGrid();
        persistState();
    }
}

export function goToPage(pageIndex) {
    if (pageIndex >= 0 && pageIndex < state.totalPageCount) {
        state.currentPageIndex = pageIndex;
        state.scrollPosition = { top: 0, left: 0 };
        loadTableData(true, false);
    }
}

export function onColumnSort(columnName) {
    if (state.sortedColumn === columnName) {
        state.sortAscending = !state.sortAscending;
    } else {
        state.sortedColumn = columnName;
        state.sortAscending = true;
    }
    loadTableData();
    persistState();
}

export function applyColumnFilter(columnName) {
    const input = document.querySelector(`.column-filter[data-column="${columnName}"]`);
    if (input) {
        state.columnFilters[columnName] = input.value;
        state.currentPageIndex = 0;
        loadTableData();
    }
}

export function onColumnFilterKeydown(event, columnName) {
    if (event.key === 'Enter') {
        applyColumnFilter(columnName);
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

        const existingSet = new Set();
        // If appending, index existing selected cells for efficiency
        if (state.selectedCells.length > 0) {
            for (const sc of state.selectedCells) {
                existingSet.add(`${sc.rowIdx},${sc.colIdx}`);
            }
        }

        for (let c = start; c <= end; c++) {
            const colName = state.tableColumns[c].name;
            state.selectedColumns.add(colName);

            for (let r = 0; r < state.gridData.length; r++) {
                if (!existingSet.has(`${r},${c}`)) {
                    const rowId = getRowId(state.gridData[r], r);
                    const value = getCellValue(state.gridData[r], c);
                    state.selectedCells.push({ rowIdx: r, colIdx: c, rowId, value });
                    existingSet.add(`${r},${c}`);
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
            // Add missing cells - Optimization: Use Set for fast lookup
            const existingSet = new Set();
            for (const sc of state.selectedCells) {
                existingSet.add(`${sc.rowIdx},${sc.colIdx}`);
            }

            for (let r = 0; r < state.gridData.length; r++) {
                if (!existingSet.has(`${r},${colIdx}`)) {
                    const rowId = getRowId(state.gridData[r], r);
                    const value = getCellValue(state.gridData[r], colIdx);
                    state.selectedCells.push({ rowIdx: r, colIdx, rowId, value });
                    existingSet.add(`${r},${colIdx}`);
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

        // Optimization: Use Set for fast lookup of existing selected cells
        const existingSet = new Set();
        for (const sc of state.selectedCells) {
            existingSet.add(`${sc.rowIdx},${sc.colIdx}`);
        }

        for (let r = minRow; r <= maxRow; r++) {
            for (let c = minCol; c <= maxCol; c++) {
                // Check against Set instead of Array.some()
                if (!existingSet.has(`${r},${c}`)) {
                    const rId = getRowId(state.gridData[r], r);
                    const val = getCellValue(state.gridData[r], c);
                    state.selectedCells.push({ rowIdx: r, colIdx: c, rowId: rId, value: val });
                    existingSet.add(`${r},${c}`);
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
