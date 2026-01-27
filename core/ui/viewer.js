/**
 * SQLite Explorer - Main Entry Point
 */
import { state } from './modules/state.js';
import { initRpc } from './modules/rpc.js';
import { backendApi } from './modules/api.js';
import {
    reloadFromDisk,
    toggleSection,
    selectTableItem,
    refreshSchema,
    updateBatchSidebar,
    applyBatchUpdate,
    setBatchNull,
    toggleBatchPatch
} from './modules/sidebar.js';
import {
    openExportModal,
    submitExport,
    onExportFormatChange
} from './modules/export.js';

import {
    openCreateTableModal,
    openAddRowModal,
    openAddColumnModal,
    openDeleteModal,
    submitAddRow,
    submitDelete,
    submitCreateTable,
    addColumnDefinition,
    removeColumnDefinition,
    submitAddColumn
} from './modules/crud.js';
import {
    updateStatus,
    showEmptyState,
    showErrorState,
    initSidebarResize
} from './modules/ui.js';
import {
    closeModal
} from './modules/modals.js';
import {
    onCellClick,
    onCellDoubleClick,
    loadTableData,
    onFilterChange,
    onPageSizeChange,
    onDateFormatChange,
    goToPage,
    onColumnSort,
    onColumnHeaderClick,
    toggleColumnPin,
    onColumnFilterKeydown,
    applyColumnFilter,
    startColumnResize,
    onRowClick,
    onRowNumberClick,
    toggleRowPin,
    onSelectAllClick,
    initGridInteraction,
    clearSelection
} from './modules/grid.js';
import {
    openCellPreview,
    closeCellPreview,
    saveCellPreview,
    formatCellPreviewJson,
    compactCellPreviewJson,
    toggleCellPreviewWrap,
    openCellInVsCode
} from './modules/edit.js';
import {
    copyCellsToClipboard,
    copySelectedRowsToClipboard,
    clearSelectedCellValues
} from './modules/clipboard.js';
import {
    openSettingsModal,
    updateExtensionSetting,
    updatePragma
} from './modules/settings.js';
import {
    initDragAndDrop
} from './modules/dnd.js';

// Initialize RPC system
initRpc();

// Attach functions to window for HTML event handlers
Object.assign(window, {
    reloadFromDisk,
    toggleSection,
    selectTableItem,
    openCreateTableModal,
    openAddRowModal,
    openAddColumnModal,
    openDeleteModal,
    submitAddRow,
    submitDelete,
    submitCreateTable,
    addColumnDefinition,
    removeColumnDefinition,
    submitAddColumn,
    openExportModal,
    submitExport,
    onExportFormatChange,
    onFilterChange,
    onPageSizeChange,
    onDateFormatChange,
    goToPage,
    onColumnSort,
    onColumnHeaderClick,
    toggleColumnPin,
    onColumnFilterKeydown,
    applyColumnFilter,
    startColumnResize,
    onRowClick,
    onRowNumberClick,
    toggleRowPin,
    onSelectAllClick,
    onCellClick,
    onCellDoubleClick,
    openCellPreview,
    closeCellPreview,
    saveCellPreview,
    formatCellPreviewJson,
    compactCellPreviewJson,
    toggleCellPreviewWrap,
    openCellInVsCode,
    openSettingsModal,
    updateExtensionSetting,
    updatePragma,
    applyBatchUpdate,
    setBatchNull,
    toggleBatchPatch,
    closeModal
});

// Main initialization
async function initializeApp() {
    try {
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

        // Initialize UI components
        initSidebarResize();
        initGridInteraction();
        initDragAndDrop();

        // Global shortcuts
        document.addEventListener('keydown', async (event) => {
            // Escape
            if (event.key === 'Escape') {
                if (!state.editingCellInfo && !document.querySelector('.modal:not(.hidden)')) {
                    clearSelection();
                }
            }

            // Cmd+C / Ctrl+C
            if ((event.metaKey || event.ctrlKey) && event.key === 'c') {
                if (state.editingCellInfo || document.activeElement.tagName === 'INPUT') return;

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
                if (state.editingCellInfo || document.activeElement.tagName === 'INPUT') return;

                if (state.selectedTable) {
                    event.preventDefault();
                    onSelectAllClick(event);
                }
            }

            // Delete / Backspace
            if ((event.metaKey || event.ctrlKey) && (event.key === 'Delete' || event.key === 'Backspace')) {
                if (state.editingCellInfo || document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;

                if (state.selectedTable && state.selectedTableType === 'table' && state.selectedCells.length > 0) {
                    event.preventDefault();
                    await clearSelectedCellValues();
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
