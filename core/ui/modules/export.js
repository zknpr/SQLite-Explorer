/**
 * Export Dialog Logic
 */
import { state } from './state.js';
import { backendApi } from './api.js';
import { updateStatus } from './ui.js';
import { openModal, closeModal } from './modals.js';
import { escapeHtml } from './utils.js';

export function openExportModal() {
    if (!state.selectedTable) return;

    // Populate format options
    const formatSelect = document.getElementById('exportFormat');
    if (formatSelect) {
        formatSelect.value = 'csv';
    }

    // Populate columns list
    const columnsContainer = document.getElementById('exportColumns');
    if (columnsContainer) {
        columnsContainer.innerHTML = state.tableColumns.map(col => `
            <label style="display:flex; align-items:center; gap:3px; margin-bottom:4px; font-size:13px; cursor:pointer;">
                <input type="checkbox" class="export-col-check" value="${escapeHtml(col.name)}" checked style="margin:0;">
                ${escapeHtml(col.name)}
            </label>
        `).join('');
    }

    // Update options based on default format
    onExportFormatChange();

    openModal('exportModal');
}

export function onExportFormatChange() {
    const format = document.getElementById('exportFormat').value;
    const optionsContainer = document.getElementById('exportOptions');

    let html = '';
    if (format === 'csv' || format === 'excel') {
        html += `
            <label style="display:flex; align-items:center; gap:3px; margin-bottom:4px; font-size:13px; cursor:pointer;">
                <input type="checkbox" id="exportHeader" checked style="margin:0;"> Include Headers
            </label>
        `;
    } else if (format === 'sql') {
        html += `
            <label style="display:flex; align-items:center; gap:3px; margin-bottom:4px; font-size:13px; cursor:pointer;">
                <input type="checkbox" id="exportTableName" checked style="margin:0;"> Include Table Name
            </label>
        `;
    }

    optionsContainer.innerHTML = html;
}

export async function submitExport() {
    const format = document.getElementById('exportFormat').value;
    const colChecks = document.querySelectorAll('.export-col-check:checked');
    const columns = Array.from(colChecks).map(c => c.value);

    if (columns.length === 0) {
        updateStatus('Error: Select at least one column');
        return;
    }

    const options = {};
    if (format === 'csv' || format === 'excel') {
        options.header = document.getElementById('exportHeader')?.checked ?? true;
    } else if (format === 'sql') {
        options.includeTableName = document.getElementById('exportTableName')?.checked ?? true;
    }

    // Check for row selection (only for tables)
    if (state.selectedTableType === 'table') {
        const rowIds = Array.from(state.selectedRowIds);
        if (rowIds.length > 0) {
            options.rowIds = rowIds;
        }
    }

    try {
        updateStatus('Exporting...');
        closeModal('exportModal');

        await backendApi.exportTable(
            { table: state.selectedTable },
            columns,
            null, // dbOptions
            null, // tableStore
            { format, ...options } // exportOptions
        );

        updateStatus('Export initiated');
    } catch (err) {
        console.error('Export failed:', err);
        updateStatus(`Export failed: ${err.message}`);
    }
}
