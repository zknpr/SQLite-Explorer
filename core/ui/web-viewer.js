/**
 * SQLite Explorer - Web Demo Entry Point
 *
 * Modified version of viewer.js that uses parent window communication
 * instead of VS Code API. This enables the viewer to run standalone
 * in a browser iframe.
 */
import { state } from './modules/state.js';
import { handleRpcResponse, sendRpcResult, sendRpcError, backendApi } from './modules/web-api.js';
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
    toggleCellPreviewWrap
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

// ============================================================================
// Web-specific RPC initialization
// ============================================================================

/**
 * Methods that can be called by the parent window.
 */
const webviewMethods = {
    async refreshContent(filename) {
        if (state.isDbConnected) {
            await refreshSchema();
            const tableExists = state.schemaCache.tables.some(t => t.name === state.selectedTable) ||
                                state.schemaCache.views.some(v => v.name === state.selectedTable);
            if (!tableExists && state.selectedTable) {
                state.selectedTable = null;
                state.selectedTableType = null;
                document.getElementById('tableNameLabel').textContent = 'No table selected';
                showEmptyState();
            } else if (state.selectedTable) {
                await loadTableData(false);
            }
        }
        return { success: true };
    },

    async updateColorScheme(scheme) {
        document.documentElement.style.colorScheme = scheme;
        return { success: true };
    },

    async updateCellEditBehavior(value) {
        state.cellEditBehavior = value;
        return { success: true };
    },
};

/**
 * Initialize message listener for parent window communication.
 */
function initWebRpc() {
    window.addEventListener('message', event => {
        const envelope = event.data;

        // Handle RPC invocation from parent
        if (envelope && envelope.kind === 'invoke') {
            const { correlationId, methodName, parameters } = envelope;
            const method = webviewMethods[methodName];

            if (typeof method === 'function') {
                Promise.resolve(method.apply(webviewMethods, parameters || []))
                    .then(result => {
                        sendRpcResult(correlationId, result);
                    })
                    .catch(err => {
                        sendRpcError(correlationId, err instanceof Error ? err.message : String(err));
                    });
            } else {
                sendRpcError(correlationId, `Unknown method: ${methodName}`);
            }
            return;
        }

        // Handle RPC responses from parent
        if (!envelope || envelope.channel !== 'rpc') return;

        const message = envelope.content;
        if (message && message.kind === 'response') {
            handleRpcResponse(message);
        }
    });
}

// Initialize web RPC
initWebRpc();

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
    // openCellInVsCode - not available in web mode
    openSettingsModal,
    updateExtensionSetting,
    updatePragma,
    applyBatchUpdate,
    setBatchNull,
    toggleBatchPatch,
    closeModal
});

// ============================================================================
// Main initialization
// ============================================================================

async function initializeApp() {
    try {
        updateStatus('Connecting to database...');

        // Initialize connection - parent window handles this
        const result = await backendApi.initialize();
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

        // Hide VS Code-specific buttons
        const vscodeBtn = document.getElementById('openInVsCodeBtn');
        if (vscodeBtn) vscodeBtn.style.display = 'none';

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

                if (state.selectedTable && state.selectedTableType === 'table') {
                    event.preventDefault();
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
