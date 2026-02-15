/**
 * Export Dialog Logic
 */
import { state } from './state.js';
import { backendApi } from './api.js';
import { updateStatus } from './ui.js';
import { openModal, closeModal } from './modals.js';
import { escapeHtml } from './utils.js';

export function initExport() {
    document.getElementById('btnExport')?.addEventListener('click', openExportModal);
    document.getElementById('btnSubmitExport')?.addEventListener('click', submitExport);
    document.getElementById('exportFormat')?.addEventListener('change', onExportFormatChange);
}

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
        columnsContainer.replaceChildren(); // Clear existing

        state.tableColumns.forEach(col => {
            const div = document.createElement('div');
            // Original code used labels directly inside container.

            const label = document.createElement('label');
            Object.assign(label.style, {
                display: 'flex',
                alignItems: 'center',
                gap: '3px',
                marginBottom: '4px',
                fontSize: '13px',
                cursor: 'pointer'
            });

            const input = document.createElement('input');
            input.type = 'checkbox';
            input.className = 'export-col-check';
            input.value = col.name;
            input.checked = true;
            input.style.margin = '0';

            label.appendChild(input);
            label.appendChild(document.createTextNode(col.name));

            columnsContainer.appendChild(label);
        });
    }

    // Update options based on default format
    onExportFormatChange();

    openModal('exportModal');
}

export function onExportFormatChange() {
    const format = document.getElementById('exportFormat').value;
    const optionsContainer = document.getElementById('exportOptions');

    // Clear existing
    optionsContainer.replaceChildren();

    if (format === 'csv' || format === 'excel') {
        const label = document.createElement('label');
        Object.assign(label.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '3px',
            marginBottom: '4px',
            fontSize: '13px',
            cursor: 'pointer'
        });

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = 'exportHeader';
        input.checked = true;
        input.style.margin = '0';

        label.appendChild(input);
        label.appendChild(document.createTextNode(' Include Headers'));
        optionsContainer.appendChild(label);

    } else if (format === 'sql') {
        const label = document.createElement('label');
        Object.assign(label.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '3px',
            marginBottom: '4px',
            fontSize: '13px',
            cursor: 'pointer'
        });

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = 'exportTableName';
        input.checked = true;
        input.style.margin = '0';

        label.appendChild(input);
        label.appendChild(document.createTextNode(' Include Table Name'));
        optionsContainer.appendChild(label);
    }
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
            { format, ...options } // exportOptions
        );

        updateStatus('Export initiated');
    } catch (err) {
        console.error('Export failed:', err);
        updateStatus(`Export failed: ${err.message}`);
    }
}
