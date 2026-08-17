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
// Desktop-only. This is the ONLY file allowed to import the console modules:
// console.js bundles CodeMirror 6, and an import from any shared module would
// drag it into the VS Code webview and web-demo bundles too. Pinned by
// tests/unit/console_desktop_wiring.test.ts.
import { createConsole } from './modules/console.js';
import { renderConsoleResults } from './modules/console-results.js';

// Like the demo, ordinary edits get no host-echoed refreshContent, so
// optimistic count reuse stays off.
setCountCacheDemoMode(true);

// ============================================================================
// SQL console (desktop only)
// ============================================================================

const READ_ONLY_CONSOLE_NOTICE =
    'This database is opened read-only; the SQL console is disabled.';

/**
 * The host closure's `surface` error helper, installed by initSqlConsole.
 * The fallback only ever runs if a console callback fires before init, which
 * nothing can do — it exists so this is never a silent failure.
 */
let consoleSurface = (label) => (err) => console.error(label, err);

/** Built on first open: CodeMirror is not worth constructing for a session that never uses it. */
let sqlConsole = null;

/** In-memory mirror of the persisted `consoleHistory` setting, newest first. */
let consoleHistory = [];

/**
 * Settles once the persisted settings (history included) have been read, or
 * failed to read. openConsole() waits on it so createConsole's first
 * loadHistory() sees the stored list — otherwise the first run would persist
 * a one-entry history over it.
 */
let consoleHistoryReady = Promise.resolve();

/**
 * Autocompletion schema for @codemirror/lang-sql: every table and view name,
 * plus real column names for the table currently loaded in the grid. That is
 * the only object whose columns are in memory — loadTableColumns fills
 * state.tableColumns for the selection alone, and fetching columns for every
 * object would cost one getTableInfo round trip each, per schema refresh.
 *
 * Null-prototype: table names are untrusted database content, and a table
 * literally named `__proto__` would otherwise reassign the object's prototype
 * instead of adding a key.
 */
function getConsoleSchema() {
    const schema = Object.create(null);
    for (const table of state.schemaCache.tables) schema[table.name] = [];
    for (const view of state.schemaCache.views) schema[view.name] = [];
    if (state.selectedTable && state.selectedTable in schema) {
        schema[state.selectedTable] = state.tableColumns.map(column => column.name);
    }
    return schema;
}

/**
 * Runs `sqlText` and renders the outcome into the results pane. Deliberately
 * never rejects: both failure modes (the read-only refusal and a worker
 * rejection) belong in the results area the user is already looking at, which
 * is also what keeps console.js's own fallback notice empty.
 */
async function runConsoleSql(sqlText) {
    const results = document.getElementById('consoleResults');
    if (!results) return;
    if (state.isReadOnly) {
        // The worker refuses runConsole outright on a read-only database; this
        // just says so without a round trip.
        renderConsoleResults(results, { error: READ_ONLY_CONSOLE_NOTICE });
        return;
    }
    try {
        renderConsoleResults(results, await backendApi.runConsole(sqlText));
    } catch (err) {
        renderConsoleResults(results, {
            error: err instanceof Error ? err.message : String(err),
            // Rough on purpose: a trailing semicolon over-reports, which only
            // adds the "statements before the error were applied" note to a
            // single-statement failure where nothing was applied.
            multiStatement: sqlText.includes(';')
        });
    }
}

function loadConsoleHistory() {
    return consoleHistory;
}

function saveConsoleHistory(list) {
    // pushHistory returns the SAME reference when there was nothing to record,
    // so this skips a settings write (and a disk write) for every such run.
    if (list === consoleHistory) return;
    consoleHistory = list;
    backendApi.updateExtensionSetting('consoleHistory', list)
        .catch(consoleSurface('History save failed'));
}

/** Console mode lives in one place: the class on .main-panel. */
function isConsoleOpen() {
    return document.querySelector('.main-panel')?.classList.contains('console-mode') === true;
}

/**
 * Read-only databases get the notice instead of the editor. Re-applied on
 * every refreshContent so opening a read-only file while the console is up
 * swaps it out immediately.
 */
function applyConsoleAvailability() {
    const notice = document.getElementById('consoleNotice');
    if (!sqlConsole || !notice) return;
    if (state.isReadOnly) {
        notice.textContent = READ_ONLY_CONSOLE_NOTICE;
        notice.hidden = false;
        sqlConsole.hide();
        // Nothing here can have come from THIS database — the console cannot
        // run against a read-only one — so leaving it would show another
        // file's output under the disabled notice.
        document.getElementById('consoleResults')?.replaceChildren();
    } else {
        notice.hidden = true;
        // Only on the transition: show() focuses the editor, and this also
        // runs on every refreshContent, which must not yank focus out of
        // whatever the user is doing.
        if (!sqlConsole.isOpen()) sqlConsole.show();
    }
}

async function openConsole() {
    const panel = document.querySelector('.main-panel');
    const container = document.getElementById('consoleContainer');
    const host = document.getElementById('consoleHost');
    if (!panel || !container || !host) return;

    await consoleHistoryReady;
    sqlConsole ??= createConsole({
        container: host,
        runSql: runConsoleSql,
        loadHistory: loadConsoleHistory,
        saveHistory: saveConsoleHistory,
        getSchema: getConsoleSchema
    });

    container.hidden = false;
    panel.classList.add('console-mode');
    applyConsoleAvailability();
}

function closeConsole() {
    const container = document.getElementById('consoleContainer');
    document.querySelector('.main-panel')?.classList.remove('console-mode');
    if (container) container.hidden = true;
}

function toggleConsole() {
    if (!isConsoleOpen()) return openConsole();
    closeConsole();
    return Promise.resolve();
}

/** No-op until the console has been opened, since createConsole is lazy. */
function refreshConsoleSchema() {
    sqlConsole?.refreshSchema();
}

/**
 * Desktop-only console wiring. `surface` is the host closure's error helper.
 */
function initSqlConsole(surface) {
    consoleSurface = surface;

    const button = document.getElementById('btnSqlConsole');
    if (button) {
        // Ships hidden in the shared template: VS Code and the web demo have
        // no console, and neither runs this init.
        button.hidden = false;
        button.addEventListener('click', () => {
            toggleConsole().catch(surface('SQL console failed'));
        });
    }

    // Picking a table or view means "show me that data", so it leaves console
    // mode. Delegated on the same element and matched with the same selector
    // sidebar.js uses for selection (a `.list-item` carrying both data-name and
    // data-type), registered separately so neither module knows about the other.
    document.getElementById('sidebarPanel')?.addEventListener('click', (event) => {
        const item = event.target?.closest?.('.list-item');
        if (item?.dataset.name && item.dataset.type) closeConsole();
    });
}

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
        // Closes the console-DDL loop: a mutating console run makes the host
        // call back here, and the autocompletion schema rebuilds from the
        // freshly loaded schemaCache. Placed after loadTableColumns rather
        // than immediately after refreshSchema() so the selected table's
        // columns are the new ones too.
        refreshConsoleSchema();
        if (isConsoleOpen()) applyConsoleAvailability();
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
        // A no-op on a cold boot (the console is built lazily on first open,
        // from this same cache); it matters on a re-init, and keeps the schema
        // feed in one place with the refreshContent hook above.
        refreshConsoleSchema();

        updateStatus('Ready');
        showEmptyState();

        setupGlobalShortcuts();

        // `surface` (used by the handlers below) is a local of the
        // host.start().then() closure and isn't in scope here — initializeApp
        // is a top-level function only *called* from inside that closure, so
        // this inlines the same no-silent-failures handling. Plain .catch
        // (no `?.`) is safe: the optional chain above already short-circuits
        // the whole expression, including this .catch, when viewerReady is
        // absent (older shells); when present, both the dev harness mock and
        // bridge.js's real invoke() always return a genuine Promise.
        window.__SQLITE_DESKTOP__?.viewerReady?.().catch((err) => {
            console.error(err);
            updateStatus(`Ready signal failed: ${err.message}`);
        });

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
    state.isDesktop = true;
    document.body.classList.add('desktop-app');

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
        //
        // No-silent-failures: there is no VS Code host to log a swallowed
        // rejection to here, so menu/file-open failures must reach the user,
        // not just the console.
        const surface = (label) => (err) => {
            console.error(err);
            updateStatus(`${label}: ${err.message}`);
        };

        bridge.onMenu(async (id) => {
            if (id === 'open-db') await host.openDatabaseViaDialog().catch(surface('Open failed'));
            else if (id === 'save-db') await host.saveToDisk().catch(surface('Save failed'));
            else if (id === 'refresh-db') await host.refreshFromDisk().catch(surface('Refresh failed'));
            else if (id === 'sql-console') await toggleConsole().catch(surface('SQL console failed'));
            else if (id.startsWith('theme:')) {
                const theme = applyTheme(id.slice('theme:'.length));
                await backendApi.updateExtensionSetting('theme', theme).catch(surface('Theme change failed'));
            }
        });

        // Native "Open With"/recents deliver a path directly, bypassing the
        // in-webview dialog flow above. Optional: older shells and the dev
        // harness don't implement onOpenFile.
        bridge.onOpenFile?.(async (path) => {
            await host.openFromShellPath(path).catch(surface('Open failed'));
        });

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
        // settings round trip. openConsole() does wait on it (the console's
        // history lives in the same payload); `.catch` makes that wait
        // unrejectable, so a settings failure costs an empty history, not a
        // console that refuses to open.
        consoleHistoryReady = backendApi.getExtensionSettings().then(s => {
            applyTheme(s.theme);
            consoleHistory = Array.isArray(s.consoleHistory) ? s.consoleHistory : [];
        }).catch(console.error);

        initSqlConsole(surface);

        return initializeApp();
    }).catch(err => {
        console.error('Desktop init error:', err);
        showErrorState(err.message);
    });
}
