/**
 * SQLite Explorer - Desktop Entry Point
 *
 * Tauri desktop build of viewer.js. The webview page IS the host process
 * (see desktop-host.js's own header comment): there is no VS Code extension
 * host and no parent-window/iframe boundary to bridge. `window.__SQLITE_DESKTOP__`
 * (injected by the native shell) is what desktop-host.js uses for file I/O,
 * settings, and native menus.
 */
import { state, persistState } from './modules/state.js';
import { backendApi, initDesktopApi } from './modules/desktop-api.js';
import { createDesktopHost } from './modules/desktop-host.js';
import { applyTheme } from './modules/desktop-theme.js';
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

// Like the demo, ordinary edits get no host-echoed refreshContent, so
// optimistic count reuse stays off.
setCountCacheDemoMode(true);

// ============================================================================
// Webview methods the desktop host invokes directly
// ============================================================================

/**
 * Methods the desktop host (desktop-host.js) calls directly via
 * host.setWebviewMethods(webviewMethods) — no message channel involved.
 */
const webviewMethods = {
    async refreshContent(filename, connectionResult) {
        // Same contract as the VS Code twin in rpc.js: this broadcast means
        // the database changed in a way this webview didn't perform itself,
        // so no cached count survives it. (Currently unused by the demo
        // host, but the parity keeps it safe to wire.)
        invalidateAllCounts();
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

        // Initialize connection - the desktop host handles this
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

        window.__SQLITE_DESKTOP__?.viewerReady?.();

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

    host.start().then(() => {
        // Registered only after host.start() resolves. Both handlers reach
        // into the worker (openDatabaseViaDialog/saveToDisk/triggerUndo/...),
        // which doesn't exist until start() has booted it — registering
        // earlier would let an early menu click or Cmd+O land on a null
        // worker.
        bridge.onMenu(async (id) => {
            if (id === 'open-db') await host.openDatabaseViaDialog();
            else if (id === 'save-db') await host.saveToDisk();
            else if (id === 'refresh-db') await host.refreshFromDisk();
            else if (id.startsWith('theme:')) {
                const theme = applyTheme(id.slice('theme:'.length));
                await backendApi.updateExtensionSetting('theme', theme);
            }
        });

        // Native "Open With"/recents deliver a path directly, bypassing the
        // in-webview dialog flow above. Optional: older shells and the dev
        // harness don't implement onOpenFile.
        bridge.onOpenFile?.(async (path) => { await host.openFromShellPath(path); });

        // VS Code intercepts these outside the webview; the desktop wires them here.
        document.addEventListener('keydown', async (event) => {
            // Mirrors hasActiveTextEditor() in modules/global-shortcuts.js:12-21
            // (not exported, so replicated here) — keep this the one definition
            // of "user is typing" in this file if that function's logic changes.
            const inEditor = state.editingCellInfo
                || document.activeElement?.tagName === 'INPUT'
                || document.activeElement?.tagName === 'TEXTAREA'
                || event.target?.tagName === 'INPUT'
                || event.target?.tagName === 'TEXTAREA'
                || event.target?.isContentEditable === true;
            const primary = event.metaKey || event.ctrlKey;
            if (!primary || inEditor) return;
            const key = event.key.toLowerCase();
            if (key === 'z' && !event.shiftKey) { event.preventDefault(); await backendApi.triggerUndo(); }
            else if ((key === 'z' && event.shiftKey) || key === 'y') { event.preventDefault(); await backendApi.triggerRedo(); }
            else if (key === 's') { event.preventDefault(); await host.saveToDisk(); }
            else if (key === 'o') { event.preventDefault(); await host.openDatabaseViaDialog(); }
        });

        // Independent of worker boot: never blocks initializeApp() on the
        // settings round trip.
        backendApi.getExtensionSettings().then(s => applyTheme(s.theme)).catch(console.error);

        return initializeApp();
    }).catch(err => {
        console.error('Desktop init error:', err);
        showErrorState(err.message);
    });
}
