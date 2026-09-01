/**
 * SQLite Explorer - Web Demo Entry Point
 *
 * Modified version of viewer.js that uses parent window communication
 * instead of VS Code API. This enables the viewer to run standalone
 * in a browser iframe.
 */
import { state, persistState } from './modules/state.js';
import {
    handleRpcResponse,
    isTrustedParentMessage,
    sendRpcResult,
    sendRpcError,
    backendApi
} from './modules/web-api.js';
import {
    initSidebar,
    refreshSchema
} from './modules/sidebar.js';
import {
    initExport
} from './modules/export.js';
import {
    invalidateAllCounts,
    setCountCacheDemoMode
} from './modules/count-cache.js';

import {
    initCrud
} from './modules/crud.js';
import {
    updateStatus,
    showEmptyState,
    showErrorState,
    showLoading,
    updateToolbarButtons,
    initSidebarResize
} from './modules/ui.js';
import {
    closeDatabaseTargetModals,
    initModals
} from './modules/modals.js';
import {
    clearSelection,
    loadTableColumns,
    loadTableData,
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
import {
    applyConnectionResult,
    updateMutationControlCapabilities
} from './modules/connection-state.js';
import { setupGlobalShortcuts } from './modules/global-shortcuts.js';

// Uploaded databases may contain UPDATE triggers that change row cardinality,
// and unlike the VS Code host the demo has no refreshContent echo after edits.
setCountCacheDemoMode(true);

// ============================================================================
// Web-specific RPC initialization
// ============================================================================

/**
 * Methods that can be called by the parent window.
 */
const webviewMethods = {
    async refreshContent(filename, connectionResult) {
        // Same contract as the VS Code twin in rpc.js: this broadcast means
        // the database changed in a way this webview didn't perform itself,
        // so no cached count survives it. (Currently unused by the demo
        // host, but the parity keeps it safe to wire.)
        invalidateAllCounts();
        const contentGeneration = ++state.contentGeneration;
        state.isRefreshingContent = true;
        updateMutationControlCapabilities();
        const priorConnectionGeneration = state.connectionGeneration;
        if (connectionResult) {
            applyConnectionResult(connectionResult);
        }
        const connectionReplaced = connectionResult
            && state.connectionGeneration !== priorConnectionGeneration;
        closeDatabaseTargetModals({ connectionReplaced });
        clearSelection();
        state.pinnedRowIds.clear();
        state.editingCellInfo = null;
        state.activeCellInput = null;
        updateToolbarButtons();
        try {
          if (state.isDbConnected) {
            if (connectionReplaced) {
                clearSelection();
                state.pinnedRowIds.clear();
                state.pinnedColumns.clear();
                state.tableColumns = [];
                state.gridData = [];
                state.gridExactIntegerTexts = {};
                state.gridOversizedCells = {};
                state.gridReadOnlyRowReasons = {};
                state.keysetAnchors = null;
                state.renderedTable = null;
                state.editingCellInfo = null;
                state.activeCellInput = null;
                showLoading();
                updateToolbarButtons();
                persistState();
            }
            // A broadcast view refresh may change projection and row order.
            // Clear positional state before the first await so controls cannot
            // target cells from the previous result while schema reloads.
            if (state.selectedTable && state.selectedTableType === 'view') persistState();

            if (!await refreshSchema()) return { success: false, superseded: true };
            const tableExists = state.schemaCache.tables.some(t => t.name === state.selectedTable) ||
                                state.schemaCache.views.some(v => v.name === state.selectedTable);
            if (!tableExists && state.selectedTable) {
                clearSelection();
                state.selectedTable = null;
                state.selectedTableType = null;
                document.getElementById('tableNameLabel').textContent = 'No table selected';
                showEmptyState();
                persistState();
                updateToolbarButtons();
            } else if (state.selectedTable) {
                if (await loadTableColumns()) await loadTableData(false);
                else if (connectionReplaced) {
                    showErrorState('Could not load table columns after reloading the database.');
                }
            }
          }
          return { success: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          showErrorState(`Refresh failed: ${message}`);
          updateStatus(`Refresh failed: ${message}`);
          throw error;
        } finally {
          if (state.contentGeneration === contentGeneration) {
            state.isRefreshingContent = false;
            updateMutationControlCapabilities();
            updateToolbarButtons();
          }
        }
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
        if (!isTrustedParentMessage(event)) return;
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
                        sendRpcError(correlationId, err);
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

// ============================================================================
// Main initialization
// ============================================================================

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
        initViews();

        // Hide VS Code-specific buttons
        const vscodeBtn = document.getElementById('openInVsCodeBtn');
        if (vscodeBtn) vscodeBtn.style.display = 'none';

        updateStatus('Connecting to database...');

        // Initialize connection - parent window handles this
        const result = await backendApi.initialize();
        if (!applyConnectionResult(result)) {
            throw new Error('Failed to connect to database');
        }

        // Test connection
        await backendApi.ping();

        // Load schema
        await refreshSchema();

        updateStatus('Ready');
        showEmptyState();

        setupGlobalShortcuts();

    } catch (err) {
        console.error('Init error:', err);
        showErrorState(err.message);
    }
}

// Start app
initializeApp();
