import { state } from './state.js';
import { getRowId } from './data-utils.js';
import { updateToolbarButtons } from './ui.js';
import { updateBatchSidebar } from './sidebar.js';

let lastSelectedCellIds = new Set();
let lastSelectedRowIds = new Set();

export function syncSelectionDOM() {
    lastSelectedCellIds.clear();
    if (state.selectedCells.length > 0) {
        state.selectedCells.forEach(cell => {
            lastSelectedCellIds.add(`cell-${cell.rowIdx}-${cell.colIdx}`);
        });
    }

    lastSelectedRowIds.clear();
    if (state.selectedRowIds.size > 0) {
        const rows = document.querySelectorAll('.data-row.selected');
        rows.forEach(row => {
            if (row.id) lastSelectedRowIds.add(row.id);
        });
    }
}

export function updateSelectionStates() {
    // --- Cells Diffing ---
    const newCellIds = new Set();
    for (const cell of state.selectedCells) {
        newCellIds.add(`cell-${cell.rowIdx}-${cell.colIdx}`);
    }

    // Remove from Deselected
    for (const id of lastSelectedCellIds) {
        if (!newCellIds.has(id)) {
            const el = document.getElementById(id);
            if (el) el.classList.remove('cell-selected');
        }
    }

    // Add to Newly Selected
    for (const id of newCellIds) {
        if (!lastSelectedCellIds.has(id)) {
            const el = document.getElementById(id);
            if (el) el.classList.add('cell-selected');
        }
    }
    lastSelectedCellIds = newCellIds;

    // --- Rows Diffing ---
    const newRowDomIds = new Set();
    // Efficiently calculate which DOM rows should be selected based on gridData
    // This avoids querying the DOM to find rows
    for (let i = 0; i < state.gridData.length; i++) {
        const rowId = getRowId(state.gridData[i], i);
        // Check fuzzy match (string/number) to align with dataset behavior
        const isSelected = state.selectedRowIds.has(rowId) ||
                          (typeof rowId !== 'string' && state.selectedRowIds.has(String(rowId)));

        if (isSelected) {
            newRowDomIds.add(`row-${i}`);
        }
    }

    // Remove from Deselected
    for (const id of lastSelectedRowIds) {
        if (!newRowDomIds.has(id)) {
            const el = document.getElementById(id);
            if (el) el.classList.remove('selected');
        }
    }

    // Add to Newly Selected
    for (const id of newRowDomIds) {
        if (!lastSelectedRowIds.has(id)) {
            const el = document.getElementById(id);
            if (el) el.classList.add('selected');
        }
    }
    lastSelectedRowIds = newRowDomIds;

    // --- Columns (Small number, simple update is fine) ---
    document.querySelectorAll('.header-cell.column-selected').forEach(el => el.classList.remove('column-selected'));
    if (state.selectedColumns.size > 0) {
        state.selectedColumns.forEach(colName => {
            const safeColName = CSS.escape(colName);
            const header = document.querySelector(`.header-cell[data-column="${safeColName}"]`);
            if (header) header.classList.add('column-selected');
        });
    }
}

export function clearSelection() {
    state.selectedCells = [];
    state.selectedRowIds.clear();
    state.selectedColumns.clear();
    state.lastSelectedCell = null;
    state.lastSelectedColumnIndex = null;
    state.lastSelectedRowIndex = null;

    updateSelectionStates();
    updateToolbarButtons();
    updateBatchSidebar();
}
