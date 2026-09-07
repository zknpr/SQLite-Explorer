/**
 * SQLite Explorer - Desktop Entry Point
 *
 * Tauri desktop build of viewer.js. The webview page IS the host process
 * (see desktop-host.js's own header comment): there is no VS Code extension
 * host and no parent-window/iframe boundary to bridge. `window.__SQLITE_DESKTOP__`
 * (injected by the native shell) is what desktop-host.js uses for file I/O,
 * settings, and native menus.
 */
import { state, persistState, resolveStartupPageSize } from './modules/state.js';
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
    showLoading,
    initSidebarResize,
    syncPageSizeSelect
} from './modules/ui.js';
import {
    closeAllModals,
    closeDatabaseTargetModals,
    initModals
} from './modules/modals.js';
import {
    clearSelection,
    loadTableColumns,
    loadTableData,
    initGridInteraction,
    initGridControls,
    updatePagination
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
// Desktop-only. This is the ONLY file allowed to import the console modules:
// console.js bundles CodeMirror 6, and an import from any shared module would
// drag it into the VS Code webview and web-demo bundles too. Pinned by
// tests/unit/console_desktop_wiring.test.ts.
import { createConsole, sanitizeHistory } from './modules/console.js';
import { renderConsoleResults } from './modules/console-results.js';
// The CSV writer dev's SQL workspace uses for its result documents, reused
// verbatim so a console export and an extension export of the same rows are
// the same bytes (quoting, NULL/blob spelling, spreadsheet-formula guard).
import { resultCsv } from '../../src/core/sql-workspace.ts';
// Desktop-only for a different reason than the console's: the tab strip and the
// Open Databases overview render a registry no other target has (VS Code and
// the web demo hold exactly one database). Their markup ships hidden in the
// shared template; this module is what fills it in. Pinned by
// tests/unit/db_tabs.test.ts.
import {
    handleDatabaseShortcut,
    initDatabaseTabs,
    renderDatabaseTabs
} from './modules/db-tabs.js';

// Like the demo, ordinary edits get no host-echoed refreshContent, so
// optimistic count reuse stays off.
setCountCacheDemoMode(true);

// ============================================================================
// Engine badge (desktop only)
// ============================================================================

/**
 * Status-bar badge naming the engine that serves the current open ('native'
 * tjs sidecar vs 'wasm' sql.js worker). The host reports it in every
 * connection result (initialize + refreshContent), so the badge tracks
 * fallbacks live — QA reads it to know which engine a step actually ran on.
 * The element ships hidden in the shared template; only this desktop entry
 * unhides it.
 */
function updateEngineBadge(engine) {
    if (engine !== 'native' && engine !== 'wasm') return;   // absent on non-desktop results
    state.engine = engine;
    const badge = document.getElementById('engineBadge');
    if (!badge) return;
    badge.textContent = engine;
    badge.dataset.engine = engine;
    badge.hidden = false;
}

/** The read-only reason currently on screen; null when the database is writable. */
let reportedReadOnlyReason = null;

/**
 * Say WHY a database opened read-only, in the engine's own words (an unwritable
 * file, a read-only mount, a read-only directory).
 *
 * Without this the only signals were disabled buttons and the console notice —
 * neither names a cause, and neither is anywhere near the grid the user is
 * looking at. `readOnlyReason` was already computed by the engine's open-time
 * write probe and already carried in every connection result; nothing read it.
 *
 * Reported on CHANGE only: refreshContent fires after every mutating operation
 * and every refresh, and re-posting the same line would keep wiping whatever
 * the user's last action put in the status bar. Switching databases legitimately
 * re-reports, because it is a different file.
 */
function reportReadOnlyReason(reason) {
    const current = typeof reason === 'string' && reason !== '' ? reason : null;
    if (current === reportedReadOnlyReason) return;
    reportedReadOnlyReason = current;
    if (current) updateStatus(current);
}

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
 * Export CSV, from the results pane: the set the user is looking at, as CSV,
 * through the same shell save dialog every other desktop export uses
 * (`saveFile` → bridge `saveFileAs`; the shell writes only where the user
 * picks). Page-side entirely — the rows are already here, so no engine round
 * trip and no second query. What is exported is what is displayed: a set the
 * worker capped exports its displayed rows, the same rule dev's SQL workspace
 * states for its result documents.
 */
async function exportConsoleCsv(set, payload) {
    const csv = resultCsv({ headers: set.headers, rows: set.rows }, set.rows.length);
    const filename = payload?.explain === true ? 'query-plan.csv' : 'query-results.csv';
    const result = await backendApi.saveFile(filename, new TextEncoder().encode(csv));
    updateStatus(result?.success === true
        ? `Exported ${set.rows.length} ${set.rows.length === 1 ? 'row' : 'rows'} to ${result.savedAs}`
        : 'CSV export cancelled');
}

/**
 * Runs `sqlText` and renders the outcome into the results pane. Deliberately
 * never rejects: both failure modes (the read-only refusal and a worker
 * rejection) belong in the results area the user is already looking at, which
 * is also what keeps console.js's own fallback notice empty.
 */
async function runConsoleSql(sqlText, options) {
    const results = document.getElementById('consoleResults');
    if (!results) return;
    if (state.isReadOnly) {
        // The worker refuses runConsole outright on a read-only database; this
        // just says so without a round trip.
        renderConsoleResults(results, { error: READ_ONLY_CONSOLE_NOTICE });
        return;
    }
    const renderOptions = {
        onExportCsv: (set, payload) => {
            exportConsoleCsv(set, payload).catch(consoleSurface('CSV export failed'));
        }
    };
    try {
        // Passed through untouched (`params`, `explain` included). A SQL
        // failure is not a rejection: runConsole resolves with `{ error,
        // multiStatement, mutated, changes }` once execution has begun, so the
        // renderer picks the error branch while the host has already recorded
        // the mutations a half-applied script made.
        renderConsoleResults(results, await backendApi.runConsole(sqlText, options), renderOptions);
    } catch (err) {
        // Only failures that never reached (or never left) the worker land here:
        // transport, RPC timeout, an unbooted database.
        renderConsoleResults(results, {
            error: err instanceof Error ? err.message : String(err),
            // Rough on purpose, and only used on this path: the worker computes
            // an exact `multiStatement` for the failures it can see.
            multiStatement: sqlText.includes(';')
        });
    }
}

function loadConsoleHistory() {
    // Choke point for a hand-edited settings.json: a non-string entry would
    // otherwise reach the module's dropdown builder and throw mid-construction,
    // leaving the console unopenable for the session. Reference-preserving when
    // the list is already clean, so saveConsoleHistory's "nothing recorded"
    // check below still works.
    return sanitizeHistory(consoleHistory);
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
    // Every open captures current state. The refreshContent hook alone is not
    // enough: picking a table in the sidebar goes straight to selectTableItem,
    // which reloads state.tableColumns without any host round trip — so a
    // console reopened after a table switch would otherwise autocomplete the
    // PREVIOUS table's columns and offer the new one none. Redundant by one
    // compartment reconfigure on the very first open (createConsole just read
    // the same getSchema()); that costs a single dispatch.
    refreshConsoleSchema();

    container.hidden = false;
    panel.classList.add('console-mode');
    applyConsoleAvailability();
}

function closeConsole() {
    const container = document.getElementById('consoleContainer');
    // The module keeps its own open/closed state (isOpen() mirrors its mount's
    // `hidden`), and applyConsoleAvailability reads it to decide whether an
    // open is a transition worth focusing. Hiding only the container would
    // leave the module believing it is still open, so the next open would skip
    // show() and never focus the editor. One notion of "open", two elements
    // kept in step.
    sqlConsole?.hide();
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
 * The body of webviewMethods.refreshContent. Split out so the method can
 * publish the in-flight broadcast on `state.contentRefreshPromise`, exactly as
 * the VS Code twin does (rpc.js refreshContent): edit.js's Tab-advance awaits
 * it, because a broadcast whose schema fetch outlives the post-edit row load
 * would otherwise supersede that load and drop the advance.
 */
async function refreshContentOnce(filename, connectionResult) {
    // Same contract as the VS Code twin in rpc.js: this broadcast means
    // the database changed in a way this webview didn't perform itself
    // (the host also echoes one after this page's own edits), so no
    // cached count survives it, every positional intent is dropped, and
    // the content revision advances so a delayed destructive intent
    // captured before it refuses to complete.
    invalidateAllCounts();
    const contentGeneration = ++state.contentGeneration;
    state.isRefreshingContent = true;
    updateMutationControlCapabilities();
    const priorConnectionGeneration = state.connectionGeneration;
    if (connectionResult) {
        applyConnectionResult(connectionResult);
        updateEngineBadge(connectionResult.engine);
        reportReadOnlyReason(connectionResult.readOnlyReason);
    }
    // The host advances its generation only on a real (re)open, so this
    // is true for a refresh/reload and false for an ordinary edit echo.
    const connectionReplaced = !!connectionResult
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
                // The reopen replaced the logical database even when table
                // names and rowids collide: nothing rendered from the old
                // one may survive into the reload below.
                state.pinnedColumns.clear();
                state.tableColumns = [];
                state.gridData = [];
                state.gridExactIntegerTexts = {};
                state.gridOversizedCells = {};
                state.gridReadOnlyRowReasons = {};
                state.keysetAnchors = null;
                state.renderedTable = null;
                showLoading();
                updateToolbarButtons();
                persistState();
            }
            // A broadcast view refresh may change projection and row order.
            if (state.selectedTable && state.selectedTableType === 'view') persistState();

            if (!await refreshSchema()) return { success: false, superseded: true };
            const tableExists = state.schemaCache.tables.some(t => t.name === state.selectedTable) ||
                                state.schemaCache.views.some(v => v.name === state.selectedTable);
            if (!tableExists && state.selectedTable) {
                clearSelection();
                state.selectedTable = null;
                state.selectedTableType = null;
                state.selectedTableIdentity = null;
                document.getElementById('tableNameLabel').textContent = 'No table selected';
                showEmptyState();
                persistState();
                updateToolbarButtons();
            } else if (state.selectedTable) {
                if (await loadTableColumns()) {
                    await loadTableData(false);
                } else if (connectionReplaced) {
                    showErrorState('Could not load table columns after reloading the database.');
                }
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
    } finally {
        // A newer broadcast owns the flag now; only the latest one clears it.
        if (state.contentGeneration === contentGeneration) {
            state.isRefreshingContent = false;
            updateMutationControlCapabilities();
            updateToolbarButtons();
        }
    }
}

/**
 * Methods the desktop host (desktop-host.js) calls directly via
 * host.setWebviewMethods(webviewMethods) — no message channel involved.
 */
const webviewMethods = {
    async refreshContent(filename, connectionResult) {
        const refresh = refreshContentOnce(filename, connectionResult);
        state.contentRefreshPromise = refresh;
        try {
            return await refresh;
        } finally {
            // Only the newest broadcast owns the slot (same rule as the
            // isRefreshingContent flag inside refreshContentOnce).
            if (state.contentRefreshPromise === refresh) state.contentRefreshPromise = null;
        }
    },

    /**
     * The registry changed: a database was opened or closed, a save cleared a
     * dirty mark, or the active pointer moved. The tab strip and the sidebar's
     * Open Databases overview both render from this one list.
     */
    async databasesChanged(list) {
        renderDatabaseTabs(list);
        return { success: true };
    },

    /**
     * A database switch replaced every per-database field of `state` (the host
     * swaps them wholesale — desktop-host.js `setActiveDb`). Everything the
     * swap cannot reach has to follow it here, before refreshContent repaints.
     *
     * The rule for what belongs in this handler: any DOM that mirrors
     * per-database state and is NOT re-rendered by the reload. Per-column
     * filter inputs and the sidebar tree are rebuilt from state, so they are
     * absent; the toolbar label, the two static filter inputs, the status line
     * and the pager are not, and each one left alone would describe the
     * OUTGOING database over the incoming one's content.
     */
    async databaseSwitched() {
        // The active tab and the highlighted overview row. `databasesChanged`
        // has already fired for this switch, so this is belt-and-braces on
        // purpose: the chrome must not depend on the host's notification ORDER
        // to end up pointing at the database the page is now showing.
        renderDatabaseTabs();

        // The toolbar's table name. Written only by the sidebar/rpc/views
        // selection paths, so a switch never touches it — it would keep naming
        // the outgoing database's table above the incoming one's rows.
        const label = document.getElementById('tableNameLabel');
        if (label) label.textContent = state.selectedTable ?? 'No table selected';

        const globalFilter = document.getElementById('filterInput');
        // Assigning an unchanged value moves the caret in some engines; only
        // write on a real divergence.
        if (globalFilter && globalFilter.value !== state.filterQuery) {
            globalFilter.value = state.filterQuery;
        }
        const clearFilter = document.getElementById('btnClearFilter');
        if (clearFilter) clearFilter.hidden = state.filterQuery.length === 0;
        const sidebarFilter = document.getElementById('sidebarFilterInput');
        if (sidebarFilter && sidebarFilter.value !== state.sidebarFilter) {
            sidebarFilter.value = state.sidebarFilter;
        }

        // A cell preview, a view editor or a BLOB inspector is showing content
        // from the database the user just left, and its Save would now target a
        // different file. Dismiss them all, running each one's cleanup.
        closeAllModals();

        if (!state.selectedTable) {
            // The reload has nothing to draw for this database, so nothing
            // would replace what is on screen: the grid keeps the outgoing
            // database's rows, and the status line and pager keep its record
            // count and page numbers. updatePagination reads the freshly
            // restored (zeroed) counters, so it resets the pager to 1 / 1 with
            // the arrows disabled.
            showEmptyState();
            updateStatus('Ready');
            updatePagination();
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
        // BEFORE the modules that consume them. host.start() has already loaded
        // the settings file, so this is a resolved in-page read, not I/O — and
        // `.catch` keeps a settings failure from costing the whole app: it falls
        // back to built-in defaults, which is what the desktop silently did with
        // these three keys until now.
        const startupSettings = await backendApi.getExtensionSettings().catch(err => {
            console.error('Settings unavailable at startup:', err);
            updateStatus(`Settings unavailable, using defaults: ${err.message}`);
            return {};
        });
        // sqliteExplorer.defaultPageSize was declared and inert on the desktop:
        // resolveStartupPageSize is called only from the VS Code entry, which
        // reads it off an HTML-template dataset this page does not have. There
        // is no persisted in-grid choice to outrank it here (see
        // desktop-api.js's getVsCodeState), so the setting IS the startup value.
        state.rowsPerPage = resolveStartupPageSize(startupSettings.defaultPageSize, undefined);
        syncPageSizeSelect(state.rowsPerPage);

        // Initialize Modules (Event Listeners)
        initSidebar();
        initCrud();
        initExport();
        initModals();
        initSettings();
        initEdit();
        initGridControls();
        initGridInteraction();
        initSidebarResize(
            startupSettings.sidebarWidth > 0 ? { initialWidth: startupSettings.sidebarWidth } : {}
        );
        initDragAndDrop();
        initViews();

        updateStatus('Connecting to database...');

        // Initialize connection - the desktop host handles this
        const result = await backendApi.initialize();
        if (!applyConnectionResult(result)) {
            throw new Error('Failed to connect to database');
        }
        updateEngineBadge(result.engine);

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

        // The status line is the app's only feedback channel, and every file
        // the app writes for the user answers the same { success, savedAs }
        // contract — where `success:false` means "the save dialog was
        // cancelled", NOT "it failed" (failures reject). Reporting it is what
        // stops a cancelled operation from reading as a completed one.
        const reportSave = (result) => {
            if (result?.success === true) updateStatus(`Saved ${result.savedAs}`);
            else if (result?.reason === 'cancelled') updateStatus('Save cancelled');
            // A read-only database cannot be saved and never had anything
            // pending; "Saved" there reads as a completed write of data the
            // file does not contain.
            else if (result?.reason === 'read-only') updateStatus(result.message);
            // 'no-database': nothing to save and nothing to tell the user —
            // the registry is only ever empty when the engine itself died, and
            // initializeApp has already put that on screen.
        };
        // ⌘S / File > Save. A database with no file yet routes to Save As
        // inside the host, so this one call covers both.
        const saveActiveDatabase = () => host.saveToDisk().then(reportSave, surface('Save failed'));

        // A refused undo/redo is not a failure, so it never rejects — and until
        // this reported it, ⌘Z after a column drop or a mutating console script
        // was indistinguishable from a dead keystroke. DDL and console runs
        // record a BARRIER (they cannot be replayed by the history engine), and
        // the barrier is what the user needs named.
        const reportHistoryStep = (label) => (result) => {
            if (result?.performed === true) return;
            if (result?.reason === 'barrier') {
                updateStatus(
                    `${label} stops here: "${result.barrierDescription}" cannot be reversed by the `
                    + 'history engine. Save, or use File > Refresh to reload the file from disk.'
                );
                return;
            }
            updateStatus(`Nothing to ${label.toLowerCase()}`);
        };

        // File > Export Database — the whole-database "save a copy" route. The
        // host picks the lane (native: sidecar VACUUM INTO → shell atomic move,
        // out of band so it is not bound by the 16 MiB stdio frame cap; WASM:
        // exported bytes → save dialog), and both answer the same contract.
        const exportDatabaseCopy = async () => {
            updateStatus('Exporting database…');
            const result = await backendApi.exportDb();
            updateStatus(result?.success === true
                ? `Exported to ${result.savedAs}`
                : 'Database export cancelled');
        };

        bridge.onMenu(async (id) => {
            if (id === 'open-db') await host.openDatabaseViaDialog().catch(surface('Open failed'));
            else if (id === 'save-db') await saveActiveDatabase();
            else if (id === 'export-db') await exportDatabaseCopy().catch(surface('Database export failed'));
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
        //
        // Sequential, for the same reasons the drop lane below is — but the
        // shell emits ONE event PER PATH here (a Finder multi-selection is N
        // `desktop-open-file` events, not one array), so the loop that
        // serialises the drop batch has no batch to loop over. The chain is
        // what carries the ordering ACROSS handler invocations: without it a
        // 14-file "Open With" starts 14 independent opens, which race the
        // registry's cap check and leave an arbitrary database active instead
        // of the last one the user asked for.
        //
        // Every link ends in a `.catch`, so the chain can never settle
        // rejected: a file that fails to open is reported and the next one is
        // still attempted.
        let shellOpenChain = Promise.resolve();
        bridge.onOpenFile?.((path) => {
            shellOpenChain = shellOpenChain
                .then(() => host.openFromShellPath(path))
                .catch(surface('Open failed'));
        });

        // Files dropped on the window. Tauri handles OS drag-and-drop natively,
        // so this arrives as PATHS from the shell rather than as an HTML5 drop
        // the page could see (dnd.js's cell-upload handlers are registered for
        // the VS Code and web builds and never fire here for that reason).
        //
        // Sequential, not Promise.all: openFromPath dedupes by canonical path
        // and each open activates the database it opened, so racing a multi-file
        // drop would leave the last one to RESOLVE active rather than the last
        // one dropped, and would boot every engine at once. (The cap itself no
        // longer depends on this: the host counts in-flight opens, because two
        // SEPARATE lanes racing each other cannot be serialised from inside
        // either one.) Every file is attempted even if an earlier one fails.
        bridge.onDragDropPaths?.(async (paths) => {
            for (const path of paths ?? []) {
                await host.openFromShellPath(path).catch(surface(`Could not open ${path}`));
            }
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
            if (!primary) return;
            // ⌘1-9 and ⌘W over the open databases. Two placements matter here.
            //
            // BEFORE the "user is typing" guard, unlike every shortcut below:
            // these are window-management chords, not text ones, and no text
            // control claims them. Deferring to `inEditor` would make ⌘W mean
            // "close this database" or "close the whole window" depending on
            // whether focus happened to be in the filter box — the more
            // destructive of the two being the accidental one. Closing a tab
            // with unsaved changes prompts, so the aggressive reading is safe.
            //
            // BEFORE the ⌘S/⌘O chain because ⌘W is only ours while a second
            // database is open: at one it returns null having touched nothing,
            // and the event falls through un-prevented to the shell's Close
            // Window accelerator. Page-level rather than a menu item for the
            // same reason ⌘S and ⌘O are — AppKit resolves menu key equivalents
            // against the active keyboard layout and silently drops the ones it
            // cannot reach.
            //
            // The .catch is a backstop: db-tabs.js already surfaces its own
            // failures (its click handlers have no caller to do it for them).
            const databaseAction = handleDatabaseShortcut(event);
            if (databaseAction) {
                await databaseAction.catch(surface('Database action failed'));
                return;
            }
            if (inEditor) return;
            const key = event.key.toLowerCase();
            // WKWebView hands key equivalents to the page BEFORE menu
            // dispatch and these preventDefault, so on macOS THIS path — not
            // the menu handler — is what actually runs on ⌘S/⌘O/⌘Z. It needs
            // the same failure surfacing the menu path has: a genuine COMMIT
            // failure (disk full, dead sidecar) or open failure must reach
            // the user, not die as an unhandled rejection behind a
            // still-dirty title.
            if (key === 'z' && !event.shiftKey) {
                event.preventDefault();
                await backendApi.triggerUndo().then(reportHistoryStep('Undo'), surface('Undo failed'));
            }
            else if ((key === 'z' && event.shiftKey) || key === 'y') {
                event.preventDefault();
                await backendApi.triggerRedo().then(reportHistoryStep('Redo'), surface('Redo failed'));
            }
            else if (key === 's') { event.preventDefault(); await saveActiveDatabase(); }
            else if (key === 'o') { event.preventDefault(); await host.openDatabaseViaDialog().catch(surface('Open failed')); }
        });

        // Independent of worker boot: never blocks initializeApp() on the
        // settings round trip. openConsole() does wait on it (the console's
        // history lives in the same payload); `.catch` makes that wait
        // unrejectable, so a settings failure costs an empty history, not a
        // console that refuses to open.
        consoleHistoryReady = backendApi.getExtensionSettings().then(s => {
            applyTheme(s.theme);
            consoleHistory = sanitizeHistory(s.consoleHistory);
        }).catch(console.error);

        initSqlConsole(surface);
        // After start(): the first render reads host.listDatabases(), which
        // only holds the boot database once start() has booted it. Both
        // presentations stay hidden at that one database anyway — this is what
        // arms them for the first databasesChanged.
        initDatabaseTabs({ host, surface });

        return initializeApp();
    }).catch(err => {
        console.error('Desktop init error:', err);
        showErrorState(err.message);
    });
}
