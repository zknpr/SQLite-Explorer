/**
 * Data Access Utilities
 * Shared helper functions for accessing grid data to avoid circular dependencies.
 */
import { state } from './state.js';
import { isReadOnlyPrimaryKeyRecordId } from '../../../src/core/row-identity.ts';

const READ_ONLY_IDENTITY_FALLBACK_REASON =
    'Primary-key identity was not transported, so the row cannot be targeted safely.';

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

function currentReadOnlyReasonsByRecordId() {
    const reasons = new Map();
    for (const [rawRowIdx, reason] of Object.entries(state.gridReadOnlyRowReasons ?? {})) {
        const rowIdx = Number(rawRowIdx);
        if (!reason || !state.gridData[rowIdx]) continue;
        reasons.set(getRowId(state.gridData[rowIdx], rowIdx), reason);
    }
    return reasons;
}

/**
 * Split row selection into bindable identities and server-authored read-only
 * tokens. Selection remains available for copy/highlight, but target-based
 * delete and export paths consume only `rowIds`.
 */
export function getSelectedRowActionEligibility() {
    const rowIds = [];
    let readOnlyCount = 0;
    let readOnlyReason;
    const currentReasons = currentReadOnlyReasonsByRecordId();
    for (const rowId of state.selectedRowIds) {
        const currentReason = currentReasons.get(rowId);
        if (isReadOnlyPrimaryKeyRecordId(rowId) || currentReason) {
            readOnlyCount++;
            readOnlyReason ??= currentReason;
        } else {
            rowIds.push(rowId);
        }
    }
    if (readOnlyCount > 0) {
        readOnlyReason ??= READ_ONLY_IDENTITY_FALLBACK_REASON;
    }
    return { rowIds, readOnlyCount, readOnlyReason };
}

/** Staged cells whose row identity can be bound by a batch mutation. */
export function getBatchSelectionEligibility() {
    const cells = [];
    let readOnlyCount = 0;
    let readOnlyReason;
    for (const cell of state.selectedCells) {
        const currentReason = getCellMutationBlockReason(cell.rowIdx, cell.colIdx);
        if (isReadOnlyPrimaryKeyRecordId(cell.rowId) || currentReason) {
            readOnlyCount++;
            readOnlyReason ??= currentReason;
        } else {
            cells.push(cell);
        }
    }
    if (readOnlyCount > 0) {
        readOnlyReason ??= READ_ONLY_IDENTITY_FALLBACK_REASON;
    }
    return { cells, readOnlyCount, readOnlyReason };
}

/**
 * Explain why a grid cell cannot enter a mutation workflow. Single-cell
 * replacement callers may opt into the Stage-D confirmation path; batch and
 * external-full-editor callers remain blocked because they cannot establish
 * one exact confirmed prior per update.
 */
export function getCellMutationBlockReason(
    rowIdx,
    colIdx,
    { allowOversizedReplacement = false } = {}
) {
    const rowReason = getReadOnlyRowReason(rowIdx);
    if (rowReason) return rowReason;
    const column = state.tableColumns[colIdx];
    if (column?.isGenerated) {
        return `Generated column ${column.name} is computed by SQLite and is read-only.`;
    }
    const oversized = getOversizedCellMetadata(rowIdx, colIdx);
    if (!oversized || allowOversizedReplacement) return undefined;
    const row = state.gridData?.[rowIdx];
    const value = row ? getCellValue(row, colIdx) : undefined;
    if (oversized.storageClass === 'text' && value instanceof Uint8Array) {
        const byteUnit = oversized.byteLength === 1 ? 'byte' : 'bytes';
        const retained = value.byteLength === oversized.byteLength
            ? 'The full byte-exact raw value is available in the Hex inspector.'
            : 'A byte-exact raw prefix is available in the Hex inspector.';
        return (
            `Inline text editing unavailable because the stored TEXT cannot be represented safely. ` +
            `${retained} Use Replace to overwrite it ` +
            `(TEXT, ${oversized.byteLength.toLocaleString()} ${byteUnit}).`
        );
    }
    // This sidecar covers size/page containment and byte-unrepresentable TEXT.
    // It has no reason discriminator, so describe the shared safety invariant
    // instead of falsely claiming that every contained value is too large.
    const byteUnit = oversized.byteLength === 1 ? 'byte' : 'bytes';
    return (
        `Inline editing unavailable because the grid does not contain the full byte-exact value. ` +
        `Use View Full Content and the Hex view ` +
        `(${oversized.storageClass.toUpperCase()}, ` +
        `${oversized.byteLength.toLocaleString()} ${byteUnit}).`
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
