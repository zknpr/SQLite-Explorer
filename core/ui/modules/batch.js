/**
 * Batch Update Sidebar Logic
 */
import { state } from './state.js';
import { backendApi } from './api.js';
import { updateStatus, showErrorState } from './ui.js';
import { loadTableData } from './grid.js';
import { getRowId, getRowDataOffset } from './data-utils.js';
import { escapeHtml } from './utils.js';

export function updateBatchSidebar() {
    const title = document.getElementById('batchUpdateSectionTitle');
    const list = document.getElementById('batchUpdateList');
    const countBadge = document.getElementById('batchUpdateCount');

    if (!title || !list || !countBadge) return;

    // Only show if rows are selected in a table
    if (state.selectedTableType !== 'table' || state.selectedRowIds.size === 0) {
        title.classList.add('hidden');
        list.classList.add('hidden');
        title.classList.add('collapsed'); // Reset collapse state
        return;
    }

    title.classList.remove('hidden');

    // Auto-expand if first time showing?
    // Or just keep it accessible.
    // Let's auto-expand if hidden.
    if (title.classList.contains('collapsed')) {
        title.classList.remove('collapsed');
        list.classList.remove('hidden');
    }

    const count = state.selectedRowIds.size;
    countBadge.textContent = count;

    renderBatchForm();
}

function renderBatchForm() {
    const container = document.getElementById('batchUpdateFields');
    if (!container) return;

    // Avoid re-rendering if columns haven't changed to preserve inputs?
    // But selection might have changed, so maybe we want to reset inputs?
    // Usually batch update form clears when selection changes to avoid accidental apply.
    // So re-rendering is fine.

    container.innerHTML = state.tableColumns.map(col => `
        <div class="form-field batch-field" style="margin-bottom: 8px;">
            <label style="display:flex; justify-content:space-between;">
                <span>${escapeHtml(col.name)}</span>
                <span style="opacity:0.5; font-size:10px">${col.type}</span>
            </label>
            <div style="display:flex; gap:6px; align-items:center;">
                <input type="text" class="batch-input" data-column="${escapeHtml(col.name)}" placeholder="No change" style="flex:1;">
                <label style="font-size:11px; display:flex; align-items:center; gap:2px; cursor:pointer;" title="Set to NULL">
                    <input type="checkbox" class="batch-null-check" data-column="${escapeHtml(col.name)}" style="margin:0;"> NULL
                </label>
            </div>
        </div>
    `).join('');

    // Add listeners
    container.querySelectorAll('.batch-null-check').forEach(chk => {
        chk.addEventListener('change', e => {
            const col = e.target.dataset.column;
            const input = container.querySelector(`.batch-input[data-column="${CSS.escape(col)}"]`);
            if (input) {
                input.disabled = e.target.checked;
                if (e.target.checked) input.value = '';
            }
        });
    });
}

export async function applyBatchUpdate() {
    if (state.selectedRowIds.size === 0) return;

    const inputs = document.querySelectorAll('.batch-input');
    const nullChecks = document.querySelectorAll('.batch-null-check');
    const updates = {};
    let hasUpdates = false;

    // Collect updates
    inputs.forEach(input => {
        const colName = input.dataset.column;
        const nullCheck = document.querySelector(`.batch-null-check[data-column="${CSS.escape(colName)}"]`);

        if (nullCheck && nullCheck.checked) {
            updates[colName] = null;
            hasUpdates = true;
        } else if (input.value !== '') {
            // Type conversion similar to edit.js
            const val = input.value;
            if (!isNaN(Number(val)) && val.trim() !== '') {
                updates[colName] = Number(val);
            } else {
                updates[colName] = val;
            }
            hasUpdates = true;
        }
    });

    if (!hasUpdates) {
        updateStatus('No changes specified');
        return;
    }

    try {
        updateStatus('Applying batch update...');

        // We only support updating rows currently loaded in the grid
        // because we need original values for Undo and we rely on gridData.
        const rowIds = Array.from(state.selectedRowIds);
        const cellUpdates = [];

        for (const rowId of rowIds) {
            // Find row in gridData
            const rowIndex = state.gridData.findIndex((r, idx) => getRowId(r, idx) == rowId);
            if (rowIndex === -1) continue;

            const row = state.gridData[rowIndex];

            for (const [colName, newValue] of Object.entries(updates)) {
                const colIdx = state.tableColumns.findIndex(c => c.name === colName);
                if (colIdx === -1) continue;

                const originalValue = row[colIdx + getRowDataOffset()];

                // Loose equality to catch simple string/number matches
                if (originalValue != newValue) {
                     cellUpdates.push({
                        rowId: rowId,
                        column: colName,
                        value: newValue,
                        originalValue: originalValue
                     });
                }
            }
        }

        if (cellUpdates.length === 0) {
            updateStatus('No matching rows found on current page');
            return;
        }

        const label = `Batch update ${cellUpdates.length} cells`;
        await backendApi.updateCellBatch(state.selectedTable, cellUpdates, label);

        // Optimistic UI update
        for (const update of cellUpdates) {
             const rIdx = state.gridData.findIndex((r, idx) => getRowId(r, idx) == update.rowId);
             if (rIdx !== -1) {
                 const cIdx = state.tableColumns.findIndex(c => c.name === update.column);
                 if (cIdx !== -1) {
                     state.gridData[rIdx][cIdx + getRowDataOffset()] = update.value;
                 }
             }
        }

        await loadTableData(false);
        updateStatus(`Updated ${cellUpdates.length} cells`);

        // Clear selection or keep it?
        // Usually keeping it is better so they can see what they updated.
        // But maybe clear inputs?
        renderBatchForm(); // Resets inputs

    } catch (err) {
        console.error('Batch update failed:', err);
        showErrorState(`Batch update failed: ${err.message}`);
    }
}
