/**
 * UI Helper Functions
 */
import { state } from './state.js';
import { escapeHtml } from './utils.js';

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
                <span class="empty-icon codicon codicon-error" style="color: var(--error-color)"></span>
                <span class="empty-title">Error</span>
                <span class="empty-desc">${escapeHtml(message)}</span>
            </div>
        `;
    }
}

export function updateToolbarButtons() {
    const hasTable = state.selectedTable && state.selectedTableType === 'table';
    const hasRowSelection = state.selectedRowIds.size > 0;
    const hasColumnSelection = state.selectedColumns.size > 0;

    const btnAddRow = document.getElementById('btnAddRow');
    const btnAddColumn = document.getElementById('btnAddColumn');
    const btnDeleteRows = document.getElementById('btnDeleteRows');
    const btnExport = document.getElementById('btnExport');

    if (btnAddRow) btnAddRow.disabled = !hasTable;
    if (btnAddColumn) btnAddColumn.disabled = !hasTable;
    // Enable delete button if rows OR columns are selected
    if (btnDeleteRows) btnDeleteRows.disabled = !hasTable || (!hasRowSelection && !hasColumnSelection);
    if (btnExport) btnExport.disabled = !state.selectedTable;
}

// Sidebar Resize Logic
export function initSidebarResize() {
    const sidebar = document.getElementById('sidebarPanel');
    const handle = document.getElementById('resizeHandle');

    if (!sidebar || !handle) return;

    let isResizing = false;

    handle.addEventListener('mousedown', e => {
        isResizing = true;
        document.body.style.cursor = 'col-resize';
        e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
        if (!isResizing) return;
        const newWidth = Math.max(150, Math.min(400, e.clientX));
        sidebar.style.width = newWidth + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            document.body.style.cursor = '';
        }
    });
}
