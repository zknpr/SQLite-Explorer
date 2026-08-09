/**
 * UI Helper Functions
 */
import { state } from './state.js';
import { backendApi } from './api.js';
import { escapeHtml } from './utils.js';
import { getSelectedRowActionEligibility } from './data-utils.js';

export function updateStatus(message) {
    const el = document.getElementById('statusText');
    if (el) el.textContent = message;
}

export function showLoading() {
    const container = document.getElementById('gridContainer');
    if (container) {
        container.innerHTML = `
            <div class="loading-view">
                <div class="loading-spinner"></div>
                <span>Loading...</span>
            </div>
        `;
    }
}

export function showEmptyState() {
    const container = document.getElementById('gridContainer');
    if (container) {
        container.innerHTML = `
            <div class="empty-view">
                <span class="empty-icon codicon codicon-database"></span>
                <span class="empty-title">Select a table</span>
                <span class="empty-desc">Choose a table from the sidebar to view data</span>
            </div>
        `;
    }
}

export function showErrorState(message) {
    const container = document.getElementById('gridContainer');
    if (container) {
        container.innerHTML = `
            <div class="empty-view">
                <span class="empty-icon codicon codicon-error error-icon"></span>
                <span class="empty-title">Error</span>
                <span class="empty-desc">${escapeHtml(message)}</span>
            </div>
        `;
    }
}

export function updateToolbarButtons() {
    const hasTable = state.selectedTable && state.selectedTableType === 'table';
    const rowEligibility = getSelectedRowActionEligibility();
    const hasRowSelection = rowEligibility.rowIds.length > 0;
    const hasColumnSelection = state.selectedColumns.size > 0;

    const btnAddRow = document.getElementById('btnAddRow');
    const btnAddColumn = document.getElementById('btnAddColumn');
    const btnDeleteRows = document.getElementById('btnDeleteRows');
    const btnExport = document.getElementById('btnExport');

    if (btnAddRow) btnAddRow.disabled = state.isReadOnly || !hasTable;
    if (btnAddColumn) btnAddColumn.disabled = state.isReadOnly || !hasTable;
    // Enable delete button if rows OR columns are selected
    if (btnDeleteRows) {
        btnDeleteRows.disabled = state.isReadOnly
            || state.isGridReloading
            || !hasTable
            || (!hasRowSelection && !hasColumnSelection);
        if (!hasColumnSelection && rowEligibility.readOnlyCount > 0) {
            btnDeleteRows.title = hasRowSelection
                ? `${rowEligibility.readOnlyCount} read-only selected row${rowEligibility.readOnlyCount === 1 ? '' : 's'} will be skipped: ${rowEligibility.readOnlyReason}`
                : `Delete unavailable: ${rowEligibility.readOnlyReason}`;
        } else {
            btnDeleteRows.title = 'Delete selected rows or columns';
        }
    }
    if (btnExport) btnExport.disabled = !state.selectedTable;
}

// Sidebar Resize Logic
export function initSidebarResize() {
    const sidebar = document.getElementById('sidebarPanel');
    const handle = document.getElementById('resizeHandle');

    if (!sidebar || !handle) return;

    const normalizeWidth = value => {
        const width = Number(value);
        return Number.isFinite(width)
            ? Math.max(150, Math.min(400, width))
            : undefined;
    };
    const persistedWidth = normalizeWidth(
        document.getElementById('vscode-env')?.dataset.sidebarLeft
    );
    if (persistedWidth !== undefined) {
        sidebar.style.width = persistedWidth + 'px';
    }

    let isResizing = false;
    let resizedWidth = persistedWidth;

    handle.addEventListener('mousedown', e => {
        isResizing = true;
        document.body.style.cursor = 'col-resize';
        e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
        if (!isResizing) return;
        resizedWidth = normalizeWidth(e.clientX);
        if (resizedWidth !== undefined) {
            sidebar.style.width = resizedWidth + 'px';
        }
    });

    document.addEventListener('mouseup', async () => {
        if (isResizing) {
            isResizing = false;
            document.body.style.cursor = '';
            if (resizedWidth === undefined) return;
            try {
                await backendApi.saveSidebarState('left', resizedWidth);
            } catch (err) {
                console.error('Failed to persist sidebar width:', err);
                updateStatus(`Failed to persist sidebar width: ${err.message}`);
            }
        }
    });
}
