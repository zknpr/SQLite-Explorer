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
    initCrud,
    submitDelete
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
    onSelectAllClick,
    initGridInteraction,
    initGridControls,
    clearSelection
} from './modules/grid.js';
import {
    initEdit
} from './modules/edit.js';
import {
    copyCellsToClipboard,
    copySelectedRowsToClipboard,
    clearSelectedCellValues
} from './modules/clipboard.js';
import {
    initSettings
} from './modules/settings.js';
import {
    initDragAndDrop
} from './modules/dnd.js';

// Initialize RPC system
initRpc();

// Main initialization
async function initializeApp() {
    try {
        // Initialize Modules (Event Listeners)
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

        // Read configuration from environment
        const vscodeEnv = document.getElementById('vscode-env');
        if (vscodeEnv) {
             if (vscodeEnv.dataset.cellEditBehavior) {
                 state.cellEditBehavior = vscodeEnv.dataset.cellEditBehavior;
             }
        }

        updateStatus('Connecting to database...');

        const result = await backendApi.initialize();
        if (!result || !result.connected) {
            throw new Error('Failed to connect to database');
        }

        state.isDbConnected = true;

        // Test connection
        await backendApi.ping();

        // Load schema
        await refreshSchema();

        // Restore state if available
        const savedState = getVsCodeState();
        if (savedState && savedState.selectedTable) {
            state.selectedTable = savedState.selectedTable;
            state.selectedTableType = savedState.selectedTableType;
            state.currentPageIndex = savedState.currentPageIndex;
            state.rowsPerPage = savedState.rowsPerPage;
            state.sortedColumn = savedState.sortedColumn;
            state.sortAscending = savedState.sortAscending;
            state.filterQuery = savedState.filterQuery;
            state.columnWidths = savedState.columnWidths || {};
            state.columnFilters = savedState.columnFilters || {};
            state.sidebarFilter = savedState.sidebarFilter || '';
            state.scrollPosition = savedState.scrollPosition || { top: 0, left: 0 };

            if (savedState.pinnedColumns) state.pinnedColumns = new Set(savedState.pinnedColumns);
            if (savedState.pinnedRowIds) state.pinnedRowIds = new Set(savedState.pinnedRowIds);
            if (savedState.selectedColumns) state.selectedColumns = new Set(savedState.selectedColumns);
            if (savedState.selectedRowIds) state.selectedRowIds = new Set(savedState.selectedRowIds);
            if (savedState.selectedCells) state.selectedCells = savedState.selectedCells;

            // Restore UI
            const tableNameLabel = document.getElementById('tableNameLabel');
            if (tableNameLabel) tableNameLabel.textContent = state.selectedTable;

            const filterInput = document.getElementById('filterInput');
            if (filterInput) filterInput.value = state.filterQuery;

            const sidebarFilterInput = document.getElementById('sidebarFilterInput');
            if (sidebarFilterInput) sidebarFilterInput.value = state.sidebarFilter;

            const pageSizeSelect = document.getElementById('pageSizeSelect');
            if (pageSizeSelect) pageSizeSelect.value = state.rowsPerPage;

            renderSidebar();
            await loadTableColumns();
            // Load data using saved scroll position (second arg false means don't overwrite from DOM which is 0)
            await loadTableData(true, false);

            updateStatus(`${state.totalRecordCount} records`);
        } else {
            updateStatus('Ready');
            showEmptyState();
        }

        // Global shortcuts
        document.addEventListener('keydown', async (event) => {
            // Undo / Redo - Handled natively by VS Code for Custom Editors

            // Escape
            if (event.key === 'Escape') {
                if (!state.editingCellInfo && !document.querySelector('.modal-overlay:not(.hidden)')) {
                    clearSelection();
                }
            }

            // Cmd+C / Ctrl+C
            if ((event.metaKey || event.ctrlKey) && event.key === 'c') {
                if (state.editingCellInfo || document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;

                if (state.selectedCells.length > 0) {
                    event.preventDefault();
                    await copyCellsToClipboard();
                } else if (state.selectedRowIds.size > 0) {
                    event.preventDefault();
                    await copySelectedRowsToClipboard();
                }
            }

            // Cmd+A / Ctrl+A
            if ((event.metaKey || event.ctrlKey) && event.key === 'a') {
                if (state.editingCellInfo || document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;

                if (state.selectedTable) {
                    event.preventDefault();
                    onSelectAllClick(event);
                }
            }

            // Delete / Backspace
            if ((event.metaKey || event.ctrlKey) && (event.key === 'Delete' || event.key === 'Backspace')) {
                if (state.editingCellInfo || document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;

                if (state.selectedTable && state.selectedTableType === 'table') {
                    event.preventDefault();
                    // Priority: Columns -> Rows -> Cells (Clear)
                    if (state.selectedColumns.size > 0) {
                        await submitDelete();
                    } else if (state.selectedRowIds.size > 0) {
                        await submitDelete();
                    } else if (state.selectedCells.length > 0) {
                        await clearSelectedCellValues();
                    }
                }
            }
        });

    } catch (err) {
        console.error('Init error:', err);
        showErrorState(err.message);
    }
}

// Start app
initializeApp();
