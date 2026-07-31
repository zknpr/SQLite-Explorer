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
    initSidebar,
    refreshSchema
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
