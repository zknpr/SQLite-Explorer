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

/**
 * Did the backend report that the user dismissed a save dialog?
 *
 * Every desktop path that writes a file for the user (table export, blob
 * download, whole-database export, Save As) answers one contract:
 * `{ success, savedAs }`, where a genuine failure REJECTS and `success:false`
 * means exactly "the save dialog was cancelled". This is the single definition
 * of that reading, for the call sites that see only the flag — each of them
 * previously invented its own, and both reported a cancelled dialog as a
 * completed save. (`host.saveToDisk` adds a `reason` on top of the same
 * contract, so desktop-viewer.js discriminates on that instead.)
 *
 * Strictly `=== false`: the VS Code host resolves these to `undefined` and the
 * web demo resolves them to the worker's `{contentChunks, filename}`, so
 * "no flag" must never be read as a cancellation on those lanes.
 */
export function wasSaveCancelled(result) {
    return result?.success === false;
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

/**
 * Point the page-size selector at `size`.
 *
 * A configured or previously persisted size that is not one of the preset
 * options gets its own numerically ordered option, so the visible control
 * always reports the LIMIT queries actually use. Shared because BOTH entry
 * points resolve a startup page size (VS Code from the vscode-env dataset, the
 * desktop from its settings store) and a second copy would be a second chance
 * for the control and `state.rowsPerPage` to disagree.
 */
export function syncPageSizeSelect(size) {
    const pageSizeSelect = document.getElementById('pageSizeSelect');
    if (!pageSizeSelect) return;
    const value = String(size);
    const options = Array.from(pageSizeSelect.options);
    if (!options.some(option => option.value === value)) {
        const custom = document.createElement('option');
        custom.value = value;
        custom.textContent = value;
        const next = options.find(option => Number(option.value) > size);
        pageSizeSelect.insertBefore(custom, next ?? null);
    }
    pageSizeSelect.value = value;
}

// Sidebar Resize Logic
/**
 * @param {{initialWidth?: number}} [options] `initialWidth` is the desktop's
 *   persisted width from its settings store. VS Code has no such store and
 *   delivers the width through the `#vscode-env` meta dataset its HTML template
 *   writes — an element the desktop page does not have at all, which is why the
 *   restored width has to be able to arrive as an argument.
 */
export function initSidebarResize(options = {}) {
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
        options.initialWidth ?? document.getElementById('vscode-env')?.dataset.sidebarLeft
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
