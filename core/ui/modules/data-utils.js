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

export function resolveDisplayedCell(targetTable, rowId, columnName) {
    if (state.selectedTable !== targetTable) return null;
    const rowIdx = state.gridData.findIndex((row, index) => getRowId(row, index) === rowId);
    const colIdx = state.tableColumns.findIndex(column => column.name === columnName);
    return rowIdx >= 0 && colIdx >= 0 ? { rowIdx, colIdx } : null;
}

export function remapDisplayedRowIdentity(targetTable, oldRowId, newRowId, currentCell) {
    if (newRowId === undefined || newRowId === oldRowId || state.selectedTable !== targetTable) return;
    if (currentCell && state.selectedTableType === 'table') {
        state.gridData[currentCell.rowIdx][0] = newRowId;
    }
    for (const ids of [state.selectedRowIds, state.pinnedRowIds]) {
        if (ids.delete(oldRowId)) ids.add(newRowId);
    }
    for (const cell of state.selectedCells) {
        if (cell.rowId === oldRowId) cell.rowId = newRowId;
    }
}

export function getCellValue(row, colIdx) {
    return row[colIdx + getRowDataOffset()];
}

export function getExactIntegerText(rowIdx, colIdx) {
    return state.gridExactIntegerTexts?.[rowIdx]?.[colIdx + getRowDataOffset()];
}

export function getOversizedCellMetadata(rowIdx, colIdx) {
    return state.gridOversizedCells?.[rowIdx]?.[colIdx + getRowDataOffset()];
}

export function getReadOnlyRowReason(rowIdx) {
    return state.gridReadOnlyRowReasons?.[rowIdx];
}

/** Explain why a grid cell cannot enter any mutation workflow. */
export function getCellMutationBlockReason(rowIdx, colIdx) {
    const rowReason = getReadOnlyRowReason(rowIdx);
    if (rowReason) return rowReason;
    const oversized = getOversizedCellMetadata(rowIdx, colIdx);
    if (!oversized) return undefined;
    return (
        `Too large to edit inline — ${oversized.byteLength.toLocaleString()} bytes ` +
        `(${oversized.storageClass.toUpperCase()})`
    );
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

export function clearOversizedCellMetadata(rowIdx, colIdx) {
    const oversizedRow = state.gridOversizedCells?.[rowIdx];
    if (!oversizedRow) return;
    delete oversizedRow[colIdx + getRowDataOffset()];
    if (Object.keys(oversizedRow).length === 0) delete state.gridOversizedCells[rowIdx];
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
