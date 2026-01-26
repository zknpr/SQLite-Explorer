/**
 * Clipboard Operations
 */
import { state } from './state.js';
import { backendApi } from './rpc.js';
import { updateStatus, updateToolbarButtons } from './ui.js';
import { loadTableData, getRowDataOffset } from './grid.js';
import { validateRowId, escapeIdentifier } from './utils.js';

export async function copyCellsToClipboard() {
    if (state.selectedCells.length === 0) return;

    try {
        let clipboardText;

        if (state.selectedCells.length === 1) {
            const value = state.selectedCells[0].value;
            if (value === null || value === undefined) {
                clipboardText = '';
            } else if (value instanceof Uint8Array) {
                clipboardText = '[BLOB]';
            } else {
                clipboardText = String(value);
            }
        } else {
            // Organize into grid
            const rows = [...new Set(state.selectedCells.map(c => c.rowIdx))].sort((a, b) => a - b);
            const cols = [...new Set(state.selectedCells.map(c => c.colIdx))].sort((a, b) => a - b);

            const cellMap = new Map();
            for (const cell of state.selectedCells) {
                cellMap.set(`${cell.rowIdx},${cell.colIdx}`, cell.value);
            }

            const lines = [];
            for (const rowIdx of rows) {
                const rowValues = [];
                for (const colIdx of cols) {
                    const key = `${rowIdx},${colIdx}`;
                    let val = cellMap.has(key) ? cellMap.get(key) : '';
                    if (val === null || val === undefined) val = '';
                    else if (val instanceof Uint8Array) val = '[BLOB]';
                    else val = String(val); // TODO: Escape tabs/newlines?
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
        updateStatus('Copy failed: ' + err.message);
    }
}

export async function copySelectedRowsToClipboard() {
    if (state.selectedRowIds.size === 0) return;

    try {
        // Collect rows
        const dataRows = [];
        for (let i = 0; i < state.gridData.length; i++) {
            // Use getRowId logic but we don't import it here directly, assume row[0] if table
            // Actually let's just use the selectedRowIds map against the grid data
            // We need to re-derive row IDs for checking
            const row = state.gridData[i];
            let rowId;
            if (state.selectedTableType === 'table') {
                rowId = row[0];
            } else {
                rowId = state.currentPageIndex * state.rowsPerPage + i;
            }

            if (state.selectedRowIds.has(rowId)) {
                // Get data columns only (skip rowid)
                const dataStart = state.selectedTableType === 'table' ? 1 : 0;
                const rowData = row.slice(dataStart).map(val => {
                    if (val === null || val === undefined) return '';
                    if (val instanceof Uint8Array) return '[BLOB]';
                    return String(val);
                });
                dataRows.push(rowData.join('\t'));
            }
        }

        const headers = state.tableColumns.map(c => c.name).join('\t');
        const clipboardText = [headers, ...dataRows].join('\n');

        await navigator.clipboard.writeText(clipboardText);
        updateStatus(`Copied ${dataRows.length} row${dataRows.length > 1 ? 's' : ''} to clipboard`);

    } catch (err) {
        console.error('Copy failed:', err);
        updateStatus('Copy failed: ' + err.message);
    }
}

export async function clearSelectedCellValues() {
    if (state.selectedCells.length === 0) return;
    if (state.selectedTableType !== 'table') {
        updateStatus('Views are read-only');
        return;
    }

    try {
        updateStatus('Clearing cells...');

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
                // Extra for local update
                rowIdx: cell.rowIdx,
                colIdx: cell.colIdx
            });
        }

        const label = `Clear ${updates.length} cell${updates.length > 1 ? 's' : ''}`;
        await backendApi.updateCellBatch(state.selectedTable, updates, label);

        // Update local grid
        for (const update of updates) {
            state.gridData[update.rowIdx][update.colIdx + getRowDataOffset()] = update.value;
        }

        state.selectedCells = [];
        state.lastSelectedCell = null;
        state.selectedColumns.clear();

        // Full reload or just local update?
        // Let's do loadTableData to be safe
        await loadTableData();
        updateToolbarButtons();
        updateStatus(`${label} - Ctrl+S to save`);

    } catch (err) {
        console.error('Clear cells failed:', err);
        updateStatus(`Clear failed: ${err.message}`);
    }
}
