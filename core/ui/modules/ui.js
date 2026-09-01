/**
 * UI Helper Functions
 */
import { state } from './state.js';
import { backendApi } from './api.js';
import { escapeHtml, getErrorMessage } from './utils.js';
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
    const hasActionableTable = hasTable
        && !state.isLoadingColumns
        && !state.isGridReloading
        && !state.isRefreshingContent
        && state.renderedTable === state.selectedTable;
    const rowEligibility = getSelectedRowActionEligibility();
    const hasRowSelection = rowEligibility.rowIds.length > 0;
    const hasColumnSelection = state.selectedColumns.size > 0;

    const btnAddRow = document.getElementById('btnAddRow');
    const btnAddColumn = document.getElementById('btnAddColumn');
    const btnDeleteRows = document.getElementById('btnDeleteRows');
    const btnExport = document.getElementById('btnExport');

    if (btnAddRow) btnAddRow.disabled = state.isReadOnly || !hasActionableTable;
    if (btnAddColumn) btnAddColumn.disabled = state.isReadOnly || !hasActionableTable;
    // Enable delete button if rows OR columns are selected
    if (btnDeleteRows) {
        btnDeleteRows.disabled = state.isReadOnly
            || state.isGridReloading
            || state.isRefreshingContent
            || !hasActionableTable
            || (!hasRowSelection && !hasColumnSelection);
        if (!hasColumnSelection && rowEligibility.readOnlyCount > 0) {
            btnDeleteRows.title = hasRowSelection
                ? `${rowEligibility.readOnlyCount} read-only selected row${rowEligibility.readOnlyCount === 1 ? '' : 's'} will be skipped: ${rowEligibility.readOnlyReason}`
                : `Delete unavailable: ${rowEligibility.readOnlyReason}`;
        } else {
            btnDeleteRows.title = 'Delete selected rows or columns';
        }
    }
    if (btnExport) btnExport.disabled = !state.selectedTable
        || state.isLoadingColumns
        || state.isGridReloading
        || state.isRefreshingContent
        || state.renderedTable !== state.selectedTable;
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
    const applyWidth = width => {
        sidebar.style.width = width + 'px';
        handle.setAttribute?.('aria-valuenow', String(width));
    };
    let persistQueue = Promise.resolve();
    const persistWidth = width => {
        // Key repeat can issue a second save before the first RPC resolves.
        // Serialize them so an older completion cannot overwrite the latest width.
        persistQueue = persistQueue.then(async () => {
            try {
                await backendApi.saveSidebarState('left', width);
            } catch (err) {
                console.error('Failed to persist sidebar width:', err);
                updateStatus(`Failed to persist sidebar width: ${getErrorMessage(err)}`);
            }
        });
        return persistQueue;
    };
    if (persistedWidth !== undefined) applyWidth(persistedWidth);

    let isResizing = false;
    let resizedWidth = persistedWidth ?? 220;

    handle.addEventListener('mousedown', e => {
        isResizing = true;
        document.body.style.cursor = 'col-resize';
        e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
        if (!isResizing) return;
        resizedWidth = normalizeWidth(e.clientX);
        if (resizedWidth !== undefined) applyWidth(resizedWidth);
    });

    document.addEventListener('mouseup', async () => {
        if (isResizing) {
            isResizing = false;
            document.body.style.cursor = '';
            if (resizedWidth === undefined) return;
            await persistWidth(resizedWidth);
        }
    });

    handle.addEventListener('keydown', async event => {
        const step = event.shiftKey ? 1 : 10;
        let nextWidth;
        if (event.key === 'ArrowLeft') nextWidth = resizedWidth - step;
        else if (event.key === 'ArrowRight') nextWidth = resizedWidth + step;
        else if (event.key === 'Home') nextWidth = 150;
        else if (event.key === 'End') nextWidth = 400;
        else return;

        event.preventDefault();
        resizedWidth = normalizeWidth(nextWidth);
        if (resizedWidth === undefined) return;
        applyWidth(resizedWidth);
        await persistWidth(resizedWidth);
    });
}
