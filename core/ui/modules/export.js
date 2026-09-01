/**
 * Export Dialog Logic
 */
import { state } from './state.js';
import { backendApi } from './api.js';
import { updateStatus } from './ui.js';
import { openModal, closeModal, registerModalCloseHandler } from './modals.js';
import { escapeHtml, getErrorMessage } from './utils.js';
import { getSelectedRowActionEligibility } from './data-utils.js';

let nextExportSessionId = 0;
let exportSession = null;
let isSubmittingExport = false;

registerModalCloseHandler('exportModal', () => {
    exportSession = null;
});

function snapshotExportSession() {
    const eligibility = getSelectedRowActionEligibility();
    return {
        id: ++nextExportSessionId,
        table: state.selectedTable,
        tableType: state.selectedTableType,
        connectionGeneration: state.connectionGeneration,
        contentGeneration: state.contentGeneration,
        columns: state.tableColumns.map(column => column.name),
        hadSelectedRows: state.selectedTableType === 'table' && state.selectedRowIds.size > 0,
        rowIds: state.selectedTableType === 'table' ? [...eligibility.rowIds] : [],
        readOnlyCount: state.selectedTableType === 'table' ? eligibility.readOnlyCount : 0,
        readOnlyReason: eligibility.readOnlyReason
    };
}

export function initExport() {
    document.getElementById('btnExport')?.addEventListener('click', openExportModal);
    document.getElementById('btnSubmitExport')?.addEventListener('click', submitExport);
    document.getElementById('exportFormat')?.addEventListener('change', onExportFormatChange);
}

export function openExportModal() {
    if (!state.selectedTable || state.isRefreshingContent) return;
    exportSession = snapshotExportSession();

    // Populate format options
    const formatSelect = document.getElementById('exportFormat');
    if (formatSelect) {
        formatSelect.value = 'csv';
    }

    // Populate columns list
    const columnsContainer = document.getElementById('exportColumns');
    if (columnsContainer) {
        columnsContainer.replaceChildren(); // Clear existing

        exportSession.columns.forEach(columnName => {
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
            input.value = columnName;
            input.checked = true;
            input.style.margin = '0';

            label.appendChild(input);
            label.appendChild(document.createTextNode(columnName));

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

    const eligibility = exportSession ?? snapshotExportSession();
    const hasSelectedRows = eligibility.hadSelectedRows;
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
    // closeModal() clears exportSession synchronously before exportTable settles.
    // A second click from the same double-click must therefore be guarded across
    // all sessions, not reclassified as an unrelated direct submission.
    if (isSubmittingExport) return;
    const ownedSession = exportSession;
    const session = ownedSession ?? snapshotExportSession();
    isSubmittingExport = true;
    try {
        return await submitExportOnce(session, ownedSession);
    } finally {
        isSubmittingExport = false;
    }
}

async function submitExportOnce(session, ownedSession) {
    const isCurrentSession = () => (
        session.connectionGeneration === state.connectionGeneration
        && session.contentGeneration === state.contentGeneration
        && (ownedSession === null
            ? exportSession === null
            : exportSession === session
              || (exportSession === null && nextExportSessionId === session.id))
    );
    if (!session.table) return;
    if (session.connectionGeneration !== state.connectionGeneration
        || session.contentGeneration !== state.contentGeneration) {
        if (isCurrentSession()) updateStatus('Export cancelled because the database content changed');
        return;
    }
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
    if (session.tableType === 'table') {
        if (session.hadSelectedRows && session.rowIds.length === 0) {
            updateStatus(`Selected-row export unavailable: ${session.readOnlyReason}`);
            return;
        }
        if (session.rowIds.length > 0) {
            options.rowIds = session.rowIds;
            skippedReadOnlyRows = session.readOnlyCount;
        }
    }

    try {
        updateStatus('Exporting...');
        closeModal('exportModal');

        const result = await backendApi.exportTable(
            { table: session.table },
            columns,
            null, // dbOptions
            null, // tableStore
            { format, ...options } // exportOptions
        );

        if (!isCurrentSession()) return;
        if (result?.success === false) {
            updateStatus(result.cancelled
                ? 'Export cancelled'
                : `Export failed${result.message ? `: ${result.message}` : ''}`);
            return;
        }

        const completed = result?.success === true && Number.isSafeInteger(result.rowCount)
            ? `Exported ${result.rowCount} row${result.rowCount === 1 ? '' : 's'}`
            : 'Export initiated';
        updateStatus(skippedReadOnlyRows > 0
            ? `${completed}; skipped ${skippedReadOnlyRows} read-only selected row${skippedReadOnlyRows === 1 ? '' : 's'}`
            : completed);
    } catch (err) {
        console.error('Export failed:', err);
        if (isCurrentSession()) updateStatus(`Export failed: ${getErrorMessage(err)}`);
    }
}
