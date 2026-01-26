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
