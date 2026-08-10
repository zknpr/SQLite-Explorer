/**
 * Export Dialog Logic
 */
import { state } from './state.js';
import { backendApi } from './api.js';
import { updateStatus } from './ui.js';
import { openModal, closeModal } from './modals.js';
import { escapeHtml } from './utils.js';
import { getSelectedRowActionEligibility } from './data-utils.js';

let isSubmittingExport = false;

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

    const eligibility = getSelectedRowActionEligibility();
    const hasSelectedRows = state.selectedTableType === 'table'
        && state.selectedRowIds.size > 0;
    const selectedExportBlocked = hasSelectedRows
        && eligibility.rowIds.length === 0;
    if (hasSelectedRows && eligibility.readOnlyCount > 0) {
        const notice = document.createElement('div');
        notice.className = 'selection-notice';
        Object.assign(notice.style, {
            marginTop: '8px',
            color: 'var(--text-secondary)',
            fontSize: '12px'
        });
        notice.textContent = selectedExportBlocked
            ? `Selected-row export unavailable: ${eligibility.readOnlyReason} Deselect the row to export the full table.`
            : `${eligibility.readOnlyCount} read-only selected row${eligibility.readOnlyCount === 1 ? '' : 's'} will be skipped: ${eligibility.readOnlyReason}`;
        optionsContainer.appendChild(notice);
    }
    const submitButton = document.getElementById('btnSubmitExport');
    if (submitButton) {
        submitButton.disabled = selectedExportBlocked;
        submitButton.title = selectedExportBlocked
            ? `Selected-row export unavailable: ${eligibility.readOnlyReason}`
            : '';
    }
}

export async function submitExport() {
    if (isSubmittingExport) return;
    isSubmittingExport = true;
    try {
        return await submitExportOnce();
    } finally {
        isSubmittingExport = false;
    }
}

async function submitExportOnce() {
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

    let skippedReadOnlyRows = 0;
    // Check for row selection (only for tables)
    if (state.selectedTableType === 'table') {
        const eligibility = getSelectedRowActionEligibility();
        if (state.selectedRowIds.size > 0 && eligibility.rowIds.length === 0) {
            updateStatus(`Selected-row export unavailable: ${eligibility.readOnlyReason}`);
            return;
        }
        if (eligibility.rowIds.length > 0) {
            options.rowIds = eligibility.rowIds;
            skippedReadOnlyRows = eligibility.readOnlyCount;
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

        updateStatus(skippedReadOnlyRows > 0
            ? `Export initiated; skipped ${skippedReadOnlyRows} read-only selected row${skippedReadOnlyRows === 1 ? '' : 's'}`
            : 'Export initiated');
    } catch (err) {
        console.error('Export failed:', err);
        updateStatus(`Export failed: ${err.message}`);
    }
}
