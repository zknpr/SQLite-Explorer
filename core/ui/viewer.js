/**
 * SQLite Explorer - Main Entry Point
 */
import { state } from './modules/state.js';
import { initRpc, backendApi } from './modules/rpc.js';
import {
    reloadFromDisk,
    toggleSection,
    selectTableItem,
    refreshSchema
} from './modules/sidebar.js';
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
    submitAddColumn,
    exportCurrentTable
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
    initGridInteraction
} from './modules/grid.js';
import {
    openCellPreview,
    closeCellPreview,
    saveCellPreview,
    formatCellPreviewJson,
    compactCellPreviewJson,
    toggleCellPreviewWrap
} from './modules/edit.js';
import {
    copyCellsToClipboard,
    copySelectedRowsToClipboard,
    clearSelectedCellValues
} from './modules/clipboard.js';

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
    exportCurrentTable,
    onFilterChange,
    onPageSizeChange,
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
    closeModal
});

// Main initialization
async function initializeApp() {
    try {
        updateStatus('Connecting to database...');

        const result = await backendApi.initialize();
        if (!result || !result.connected) {
            throw new Error('Failed to connect to database');
        }

        state.isDbConnected = true;
        console.log('Connected to database:', result.filename);

        // Test connection
        await backendApi.ping();

        // Load schema
        await refreshSchema();

        updateStatus('Ready');
        showEmptyState();

        // Initialize UI components
        initSidebarResize();
        initGridInteraction();

        // Global shortcuts
        document.addEventListener('keydown', async (event) => {
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
