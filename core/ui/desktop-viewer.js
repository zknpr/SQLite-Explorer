/**
 * SQLite Explorer - Web Demo Entry Point
 *
 * Modified version of viewer.js that uses parent window communication
 * instead of VS Code API. This enables the viewer to run standalone
 * in a browser iframe.
 */
import { state, persistState } from './modules/state.js';
import { backendApi, initDesktopApi } from './modules/desktop-api.js';
import { createDesktopHost } from './modules/desktop-host.js';
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
import { applyConnectionResult } from './modules/connection-state.js';
import { setupGlobalShortcuts } from './modules/global-shortcuts.js';

// ============================================================================
// Web-specific RPC initialization
// ============================================================================

/**
 * Methods that can be called by the parent window.
 */
const webviewMethods = {
    async refreshContent(filename, connectionResult) {
        if (connectionResult) {
            applyConnectionResult(connectionResult);
        }
        if (state.isDbConnected) {
            // A broadcast view refresh may change projection and row order.
            // Clear positional state before the first await so controls cannot
            // target cells from the previous result while schema reloads.
            if (state.selectedTable && state.selectedTableType === 'view') {
                clearSelection();
                persistState();
            }

            await refreshSchema();
            const tableExists = state.schemaCache.tables.some(t => t.name === state.selectedTable) ||
                                state.schemaCache.views.some(v => v.name === state.selectedTable);
            if (!tableExists && state.selectedTable) {
                clearSelection();
                state.selectedTable = null;
                state.selectedTableType = null;
                document.getElementById('tableNameLabel').textContent = 'No table selected';
                showEmptyState();
                persistState();
            } else if (state.selectedTable) {
                await loadTableColumns();
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

const bridge = window.__SQLITE_DESKTOP__;
if (!bridge) {
    document.body.innerHTML = '<p style="padding:2em;font-family:sans-serif">'
        + 'Desktop bridge missing: this page must run inside the SQLite Explorer shell '
        + 'or the dev harness.</p>';
} else {
    const host = createDesktopHost({
        bridge,
        createWorker: () => new Worker('./worker.js')
    });
    initDesktopApi(host);
    host.setWebviewMethods(webviewMethods);

    bridge.onMenu(async (id) => {
        if (id === 'open-db') await host.openDatabaseViaDialog();
        else if (id === 'save-db') await host.saveToDisk();
        else if (id === 'refresh-db') await host.refreshFromDisk();
    });

    // VS Code intercepts these outside the webview; the desktop wires them here.
    document.addEventListener('keydown', async (event) => {
        const inEditor = document.activeElement?.tagName === 'INPUT'
            || document.activeElement?.tagName === 'TEXTAREA';
        const primary = event.metaKey || event.ctrlKey;
        if (!primary || inEditor) return;
        const key = event.key.toLowerCase();
        if (key === 'z' && !event.shiftKey) { event.preventDefault(); await backendApi.triggerUndo(); }
        else if ((key === 'z' && event.shiftKey) || key === 'y') { event.preventDefault(); await backendApi.triggerRedo(); }
        else if (key === 's') { event.preventDefault(); await host.saveToDisk(); }
        else if (key === 'o') { event.preventDefault(); await host.openDatabaseViaDialog(); }
    });

    // Follow the OS theme; VS Code pushes updateColorScheme, the desktop asks the OS.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const applyScheme = () => { document.documentElement.style.colorScheme = media.matches ? 'dark' : 'light'; };
    applyScheme();
    media.addEventListener('change', applyScheme);

    host.start().then(initializeApp).catch(err => {
        console.error('Desktop init error:', err);
        showErrorState(err.message);
    });
}
