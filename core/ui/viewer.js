/**
 * SQLite Explorer - Main Entry Point
 */
import { state } from './modules/state.js';
import { initRpc } from './modules/rpc.js';
import { backendApi } from './modules/api.js';
import {
    initSidebar,
    refreshSchema
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

        updateStatus('Ready');
        showEmptyState();

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
