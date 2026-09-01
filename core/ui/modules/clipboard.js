/**
 * Clipboard Operations
 */
import { state } from './state.js';
import { backendApi } from './api.js';
import { updateStatus, updateToolbarButtons } from './ui.js';
import { loadTableData } from './grid.js';
import { noteCellValuesChanged } from './count-cache.js';
import {
    getCellValueForDisplay,
    getCellMutationBlockReason,
    getOrderedColumnIndices,
    getOrderedRowIndices,
    getOversizedCellMetadata,
    getRowDataOffset,
    remapDisplayedRowIdentity,
    resolveDisplayedCell
} from './data-utils.js';
import { validateRowId, escapeIdentifier, getErrorMessage } from './utils.js';

const TRUNCATED_COPY_NOTICE =
    'Copy blocked: selection contains truncated data. Use Open Full Content for one cell or Export for complete rows.';
let isClearingSelectedCellValues = false;

function cellSelectionSignature() {
    return state.selectedCells.map(cell => (
        `${typeof cell.rowId}:${String(cell.rowId)}\u0000${cell.colIdx}`
    )).join('\u0001');
}

function refuseTruncatedCellSelection() {
    if (state.selectedCells.some(cell => getOversizedCellMetadata(cell.rowIdx, cell.colIdx))) {
        updateStatus(TRUNCATED_COPY_NOTICE);
        return true;
    }
    return false;
}

function refuseTruncatedRowSelection() {
    for (let rowIdx = 0; rowIdx < state.gridData.length; rowIdx++) {
        const row = state.gridData[rowIdx];
        const rowId = state.selectedTableType === 'table'
            ? row[0]
            : state.currentPageIndex * state.rowsPerPage + rowIdx;
        if (!state.selectedRowIds.has(rowId)) continue;
        if (state.tableColumns.some((_column, colIdx) => (
            getOversizedCellMetadata(rowIdx, colIdx)
        ))) {
            updateStatus(TRUNCATED_COPY_NOTICE);
            return true;
        }
    }
    return false;
}

export async function copyCellsToClipboard() {
    if (state.selectedCells.length === 0) return;
    if (refuseTruncatedCellSelection()) return;

    try {
        let clipboardText;

        if (state.selectedCells.length === 1) {
            const cell = state.selectedCells[0];
            const row = state.gridData[cell.rowIdx];
            const value = row
                ? getCellValueForDisplay(row, cell.rowIdx, cell.colIdx)
                : cell.value;
            if (value === null || value === undefined) {
                clipboardText = '';
            } else if (value instanceof Uint8Array) {
                clipboardText = '[BLOB]';
            } else {
                clipboardText = String(value);
            }
        } else {
            // Organize into grid
            const selectedRows = new Set(state.selectedCells.map(c => c.rowIdx));
            const selectedColumns = new Set(state.selectedCells.map(c => c.colIdx));
            const rows = getOrderedRowIndices().filter(index => selectedRows.has(index));
            const cols = getOrderedColumnIndices().filter(index => selectedColumns.has(index));

            const cellMap = new Map();
            for (const cell of state.selectedCells) {
                const row = state.gridData[cell.rowIdx];
                cellMap.set(
                    `${cell.rowIdx},${cell.colIdx}`,
                    row ? getCellValueForDisplay(row, cell.rowIdx, cell.colIdx) : cell.value
                );
            }

            const lines = [];
            for (const rowIdx of rows) {
                const rowValues = [];
                for (const colIdx of cols) {
                    const key = `${rowIdx},${colIdx}`;
                    let val = cellMap.has(key) ? cellMap.get(key) : '';
                    if (val === null || val === undefined) val = '';
                    else if (val instanceof Uint8Array) val = '[BLOB]';
                    else {
                        val = String(val);
                        // Escape tabs and newlines to preserve grid structure in clipboard
                        val = val.replace(/\t/g, ' ').replace(/\n/g, ' ');
                    }
                    rowValues.push(val);
                }
                lines.push(rowValues.join('\t'));
            }
            clipboardText = lines.join('\n');
        }

        await navigator.clipboard.writeText(clipboardText);
        updateStatus(`Copied ${state.selectedCells.length} cell${state.selectedCells.length > 1 ? 's' : ''}`);

    } catch (err) {
        console.error('Copy failed:', err);
        updateStatus('Copy failed: ' + getErrorMessage(err));
    }
}

export async function copySelectedRowsToClipboard() {
    if (state.selectedRowIds.size === 0) return;
    if (refuseTruncatedRowSelection()) return;

    try {
        // Collect rows
        const dataRows = [];
        for (const i of getOrderedRowIndices()) {
            // Derive row ID to check against the selection set.
            // For tables, the row ID is always at index 0.
            // For views (which lack rowid), use the calculated pagination index.
            const row = state.gridData[i];
            let rowId;
            if (state.selectedTableType === 'table') {
                rowId = row[0];
            } else {
                rowId = state.currentPageIndex * state.rowsPerPage + i;
            }

            if (state.selectedRowIds.has(rowId)) {
                const rowData = getOrderedColumnIndices().map(colIdx => {
                    const val = getCellValueForDisplay(row, i, colIdx);
                    if (val === null || val === undefined) return '';
                    if (val instanceof Uint8Array) return '[BLOB]';
                    return String(val);
                });
                dataRows.push(rowData.join('\t'));
            }
        }

        const headers = getOrderedColumnIndices()
            .map(colIdx => state.tableColumns[colIdx].name)
            .join('\t');
        const clipboardText = [headers, ...dataRows].join('\n');

        await navigator.clipboard.writeText(clipboardText);
        updateStatus(`Copied ${dataRows.length} row${dataRows.length > 1 ? 's' : ''} to clipboard`);

    } catch (err) {
        console.error('Copy failed:', err);
        updateStatus('Copy failed: ' + getErrorMessage(err));
    }
}

export async function clearSelectedCellValues() {
    if (isClearingSelectedCellValues || state.selectedCells.length === 0) return;
    if (state.isReadOnly || state.selectedTableType !== 'table') {
        updateStatus('Views are read-only');
        return;
    }
    for (const cell of state.selectedCells) {
        const mutationBlockReason = getCellMutationBlockReason(cell.rowIdx, cell.colIdx);
        if (mutationBlockReason) {
            updateStatus(mutationBlockReason);
            return;
        }
    }

    const updates = [];
    for (const cell of state.selectedCells) {
        const column = state.tableColumns[cell.colIdx];
        if (!column) continue;

        const isNotNull = column.notnull === 1;
        const newValue = isNotNull ? '' : null;

        updates.push({
            rowId: cell.rowId,
            column: column.name,
            value: newValue,
            originalValue: cell.value,
            rowIdx: cell.rowIdx,
            colIdx: cell.colIdx
        });
    }

    const label = `Clear ${updates.length} cell${updates.length > 1 ? 's' : ''}`;
    const targetTable = state.selectedTable;
    const targetSelectionSignature = cellSelectionSignature();
    isClearingSelectedCellValues = true;
    try {
        updateStatus('Clearing cells...');
        const outcomes = await backendApi.updateCellBatch(targetTable, updates, label);
        // Cleared values may leave an active filter's match set, so the
        // table's cached filtered counts are no longer trustworthy.
        noteCellValuesChanged(targetTable);
        const stillOnTargetTable = state.selectedTable === targetTable;
        for (const outcome of stillOnTargetTable ? outcomes ?? [] : []) {
            const currentCell = resolveDisplayedCell(
                targetTable,
                outcome.rowId,
                outcome.columnName
            ) ?? (outcome.newRowId !== undefined
                ? resolveDisplayedCell(
                    targetTable,
                    outcome.newRowId,
                    outcome.columnName
                )
                : null);
            remapDisplayedRowIdentity(
                targetTable,
                outcome.rowId,
                outcome.newRowId,
                currentCell
            );
        }

        // Resolve the live cell by identity: a sort or reload may have moved
        // both indices while the mutation was pending.
        for (const update of stillOnTargetTable ? updates : []) {
            const currentCell = resolveDisplayedCell(targetTable, update.rowId, update.column);
            if (!currentCell) continue;
            state.gridData[currentCell.rowIdx][currentCell.colIdx + getRowDataOffset()] = update.value;
        }

        if (stillOnTargetTable && cellSelectionSignature() === targetSelectionSignature) {
            state.selectedCells = [];
            state.lastSelectedCell = null;
            state.selectedColumns.clear();
        }

        if (stillOnTargetTable) {
            await loadTableData();
            updateToolbarButtons();
            updateStatus(`${label} - Ctrl+S to save`);
        }

    } catch (err) {
        console.error('Clear cells failed:', err);
        if (state.selectedTable === targetTable) updateStatus(`Clear failed: ${getErrorMessage(err)}`);
    } finally {
        isClearingSelectedCellValues = false;
    }
}
