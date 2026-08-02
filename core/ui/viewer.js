/**
 * SQLite Explorer - Main Entry Point
 */
import { state } from './modules/state.js';
import { initRpc } from './modules/rpc.js';
import { backendApi, getVsCodeState } from './modules/api.js';
import {
    initSidebar,
    refreshSchema,
    renderSidebar
} from './modules/sidebar.js';
import {
    initExport
} from './modules/export.js';

import {
    initCrud
} from './modules/crud.js';
import {
    updateStatus,
    showEmptyState,
    showErrorState,
    initSidebarResize
} from './modules/ui.js';
import {
    initModals
} from './modules/modals.js';
import {
    loadTableData,
    loadTableColumns,
    initGridInteraction,
    initGridControls
} from './modules/grid.js';
import {
    initEdit
} from './modules/edit.js';
import {
    initSettings
} from './modules/settings.js';
import {
    initDragAndDrop
} from './modules/dnd.js';
import { initViews } from './modules/views.js';
import { applyConnectionResult } from './modules/connection-state.js';
import { setupGlobalShortcuts } from './modules/global-shortcuts.js';

// Initialize RPC system
initRpc();

function initializeModules() {
    initSidebar();
    initCrud();
    initExport();
    initModals();
    initSettings();
    initEdit();
    initGridControls();
    initGridInteraction();
    initSidebarResize();
    initDragAndDrop();
    initViews();
}

async function connectAndLoadSchema() {
    updateStatus('Connecting to database...');

    const result = await backendApi.initialize();
    if (!applyConnectionResult(result)) {
        throw new Error('Failed to connect to database');
    }

    // Test connection
    await backendApi.ping();

    // Load schema
    await refreshSchema();
}

async function restoreSavedState() {
    const savedState = getVsCodeState();
    if (savedState && savedState.selectedTable) {
        // Restore scalar state fields
        state.selectedTable = savedState.selectedTable;
        state.selectedTableType = savedState.selectedTableType || 'table';
        state.currentPageIndex = savedState.currentPageIndex || 0;
        state.rowsPerPage = savedState.rowsPerPage || 500;
        state.sortedColumn = savedState.sortedColumn || null;
        state.sortAscending = savedState.sortAscending !== false;
        state.filterQuery = savedState.filterQuery || '';
        state.columnWidths = savedState.columnWidths || {};
        state.columnFilters = savedState.columnFilters || {};
        state.sidebarFilter = savedState.sidebarFilter || '';
        state.dateFormat = savedState.dateFormat || 'raw';
        state.cellEditBehavior = savedState.cellEditBehavior || 'inline';

        // Restore Set-based state (serialized as arrays)
        state.pinnedColumns = new Set(savedState.pinnedColumns || []);
        state.pinnedRowIds = new Set(savedState.pinnedRowIds || []);
        state.selectedColumns = new Set(savedState.selectedColumns || []);

        // Capture scroll position before rendering (will be applied after grid render)
        const savedScroll = savedState.scrollPosition || { top: 0, left: 0 };
        state.scrollPosition = { ...savedScroll };

        // Restore sidebar filter input value
        const sidebarFilterInput = document.getElementById('sidebarFilterInput');
        if (sidebarFilterInput) sidebarFilterInput.value = state.sidebarFilter;

        // Restore global filter input value
        const filterInput = document.getElementById('filterInput');
        if (filterInput) filterInput.value = state.filterQuery;
        const clearFilterButton = document.getElementById('btnClearFilter');
        if (clearFilterButton) clearFilterButton.hidden = state.filterQuery.length === 0;

        // Restore date format dropdown
        const dateFormatSelect = document.getElementById('dateFormatSelect');
        if (dateFormatSelect) dateFormatSelect.value = state.dateFormat;

        // Restore page size dropdown
        const pageSizeSelect = document.getElementById('pageSizeSelect');
        if (pageSizeSelect) pageSizeSelect.value = String(state.rowsPerPage);

        // Update table name label
        const tableNameLabel = document.getElementById('tableNameLabel');
        if (tableNameLabel) tableNameLabel.textContent = state.selectedTable;

        // Re-render sidebar with restored selection highlight
        renderSidebar();

        // Load column metadata and table data, then restore scroll position
        await loadTableColumns();
        await loadTableData(true, false);

        // Restore scroll position after the grid has been rendered.
        // loadTableData already uses state.scrollPosition for its render call,
        // but we also explicitly set it here to handle any race with the DOM update.
        const container = document.getElementById('gridContainer');
        if (container) {
            container.scrollLeft = savedScroll.left;
            container.scrollTop = savedScroll.top;
        }

        updateStatus(`${state.totalRecordCount} records`);
    } else {
        updateStatus('Ready');
        showEmptyState();
    }
}

function applyVsCodeSettings() {
    const vscodeEnv = document.getElementById('vscode-env');
    if (vscodeEnv) {
        if (vscodeEnv.dataset.cellEditBehavior) {
            state.cellEditBehavior = vscodeEnv.dataset.cellEditBehavior;
        }
    }
}

// Main initialization
async function initializeApp() {
    try {
        initializeModules();
        await connectAndLoadSchema();
        await restoreSavedState();
        applyVsCodeSettings();
        setupGlobalShortcuts();
    } catch (err) {
        console.error('Init error:', err);
        showErrorState(err.message);
    }
}

// Start app
initializeApp();
