/**
 * Data Access Utilities
 * Shared helper functions for accessing grid data to avoid circular dependencies.
 */
import { state } from './state.js';

export function getRowDataOffset() {
    return state.selectedTableType === 'table' ? 1 : 0;
}

export function getRowId(row, rowIdx) {
    if (state.selectedTableType === 'table') {
        return row[0]; // SQLite rowid
    }
    return state.currentPageIndex * state.rowsPerPage + rowIdx;
}

export function getCellValue(row, colIdx) {
    return row[colIdx + getRowDataOffset()];
}

export function getExactIntegerText(rowIdx, colIdx) {
    return state.gridExactIntegerTexts?.[rowIdx]?.[colIdx + getRowDataOffset()];
}

/** Return the authoritative user-visible value when SQLite supplied one. */
export function getCellValueForDisplay(row, rowIdx, colIdx) {
    return getExactIntegerText(rowIdx, colIdx) ?? getCellValue(row, colIdx);
}

export function clearExactIntegerText(rowIdx, colIdx) {
    const exactRow = state.gridExactIntegerTexts?.[rowIdx];
    if (!exactRow) return;
    delete exactRow[colIdx + getRowDataOffset()];
    if (Object.keys(exactRow).length === 0) delete state.gridExactIntegerTexts[rowIdx];
}

/** Return original column indices in the same pinned-first order as the grid. */
export function getOrderedColumnIndices() {
    const pinned = [];
    const unpinned = [];
    state.tableColumns.forEach((column, index) => {
        (state.pinnedColumns.has(column.name) ? pinned : unpinned).push(index);
    });
    return [...pinned, ...unpinned];
}

/** Return original row indices in the same pinned-first order as the grid. */
export function getOrderedRowIndices() {
    const pinned = [];
    const unpinned = [];
    state.gridData.forEach((row, index) => {
        (state.pinnedRowIds.has(getRowId(row, index)) ? pinned : unpinned).push(index);
    });
    return [...pinned, ...unpinned];
}
