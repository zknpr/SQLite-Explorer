/**
 * Database tabs + the sidebar's "Open Databases" overview.
 *
 * DESKTOP ONLY — like the SQL console modules, this file may be imported by
 * `desktop-viewer.js` and nothing else (pinned by tests/unit/db_tabs.test.ts).
 * The markup it fills lives in the shared template and ships `hidden`, exactly
 * as #btnSqlConsole and #engineBadge do, so the VS Code webview and the web
 * demo carry inert elements and none of this code.
 *
 * Two presentations, ONE source of truth: `host.listDatabases()`. The host
 * pushes a fresh list through its `databasesChanged` hook on every open, close,
 * save (a dirty flag clearing) and switch, and the desktop entry re-renders
 * both from it. Neither presentation holds any REGISTRY state — nothing here
 * can drift from the host's answer; the one module-level variable below
 * remembers what the last render looked like, not what is open.
 *
 * Both appear only from the SECOND database on. At one open database the strip
 * and the sidebar section would carry nothing the window title and the engine
 * badge don't already say, and hiding them keeps the single-database window
 * pixel-identical to the one that shipped before multi-database support.
 */

/**
 * Below this, both presentations stay hidden. One threshold for the two, so
 * they can never disagree about whether this window is showing "a database" or
 * "several databases".
 */
import { confirmDestructiveAction } from './modals.js';

const MIN_DATABASES_FOR_CHROME = 2;

/** @type {import('./desktop-host.js').DesktopHost | null} */
let host = null;
let confirmClose = confirmDestructiveAction;

/**
 * The desktop entry's error surfacer (`(label) => (err) => …`), which puts the
 * message in the status line. The fallback only runs if a click arrives before
 * initDatabaseTabs, which nothing can do — it exists so this is never a silent
 * failure.
 */
let surface = (label) => (err) => console.error(label, err);

/**
 * @param {object} options
 * @param {import('./desktop-host.js').DesktopHost} options.host
 * @param {(label: string) => (err: Error) => void} [options.surface]
 * @param {typeof confirmDestructiveAction} [options.confirmClose]
 */
export function initDatabaseTabs(options) {
    host = options.host;
    confirmClose = options.confirmClose ?? confirmDestructiveAction;
    if (options.surface) surface = options.surface;
    renderDatabaseTabs();
}

/**
 * Renders both presentations from one registry snapshot.
 *
 * @param {import('./desktop-host.js').OpenDatabase[]} [list] the list the host
 *   just pushed; omitted callers read it from the host.
 */
export function renderDatabaseTabs(list) {
    const databases = list ?? host?.listDatabases();
    // No host yet (and no list handed in) means there is no registry to draw:
    // leave the template's hidden elements exactly as they ship rather than
    // rendering an empty strip over them.
    if (!databases) return;
    const visible = databases.length >= MIN_DATABASES_FOR_CHROME;
    renderStrip(databases, visible);
    renderOverview(databases, visible);
}

/**
 * ⌘1-9 and ⌘W, from the desktop entry's keydown handler.
 *
 * Page-level rather than menu accelerators on purpose: AppKit resolves menu key
 * equivalents against the ACTIVE keyboard layout and silently drops the ones it
 * cannot reach, and WKWebView hands key equivalents to the page before menu
 * dispatch anyway.
 *
 * @param {KeyboardEvent} event
 * @returns {Promise<unknown> | null} the action's promise when this event was
 *   HANDLED (`preventDefault` has already been called for it), or null when it
 *   is not ours — in which case the event is left untouched, which is what lets
 *   ⌘W still close the window at one open database.
 */
export function handleDatabaseShortcut(event) {
    if (!host) return null;
    // ⌥ is never ours (⌘⌥1 belongs to nobody here). ⇧ is rejected per branch
    // rather than globally: ⌘⇧W is Close All Windows, but ⌘⇧1 is how ⌘1
    // reaches a layout whose digits sit in the shifted position — see
    // shortcutIndex.
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;

    const databases = host.listDatabases();
    if (!event.shiftKey && typeof event.key === 'string' && event.key.toLowerCase() === 'w') {
        // At one database ⌘W keeps its old meaning — close the window. Leaving
        // the event un-prevented is what hands it back to the shell's menu.
        if (databases.length < MIN_DATABASES_FOR_CHROME) return null;
        const active = databases.find(database => database.isActive);
        if (!active) return null;
        event.preventDefault();
        return closeFromUi(active.dbId);
    }

    const index = shortcutIndex(event);
    if (index === null) return null;
    const target = databases[index];
    // Past the end: a no-op, and NOT prevented — the user pressed a chord this
    // window has no meaning for.
    if (!target) return null;
    event.preventDefault();
    return switchTo(target.dbId);
}

/**
 * Closes `dbId`, prompting first when it has unsaved changes.
 *
 * `host.closeDatabase` DISCARDS them without asking — this prompt is the only
 * thing between a stray click on a tab's × and losing the edits, which is why
 * an unavailable confirmation fails without closing the database.
 *
 * Not exported: every close in the UI goes through `closeFromUi`, which adds
 * the error surfacing the click and key handlers have no caller to do for them.
 *
 * @returns {Promise<boolean>} whether the database was closed.
 */
async function requestCloseDatabase(dbId) {
    if (!host) return false;
    const database = host.listDatabases().find(entry => entry.dbId === dbId);
    // Already gone (a double click on ×, a close raced with the shell's own):
    // closeDatabase would reject on the unknown id, which is right for a
    // programmatic caller and noise for this one.
    if (!database) return false;
    if (database.isDirty) {
        const askingHost = host;
        const activeId = host.activeDatabaseId();
        // Browser confirm is unavailable in the desktop webview. Reuse the
        // in-page dialog; cancellation and database switches settle it false.
        const discard = await confirmClose({
            title: 'Unsaved changes',
            message: `"${database.name}" has unsaved changes.\n\n`
                + 'Closing it discards them. Close without saving?',
            confirmLabel: 'Close without saving'
        });
        if (discard !== true) return false;
        // The prompt is asynchronous: a menu action can switch or close a
        // database before the answer. Never apply a stale close to a new view.
        if (host !== askingHost || host.activeDatabaseId() !== activeId
            || !host.listDatabases().some(entry => entry.dbId === dbId)) return false;
    }
    await host.closeDatabase(dbId);
    return true;
}

// ---- internals ------------------------------------------------------------

/**
 * 0-based position for ⌘1-9, or null.
 *
 * `event.code` is PRIMARY and layout-independent: it names the physical key,
 * so ⌘+the-1-key selects the first database whatever that key types. This is
 * not a preference — it is this project's most expensive recurring lesson.
 * AppKit resolves key equivalents against the ACTIVE keyboard layout and
 * silently drops the unreachable ones (a menu item bound to `CmdOrCtrl+=`
 * shipped dead on this machine's Italian-Pro layout), and matching on
 * `event.key` here would repeat it in the page handler: on an AZERTY-shaped
 * layout the digit row types `&é"…` unshifted, so `key` is never '1' without
 * Shift and is '1' only WITH it. Both of those are the same physical Digit1,
 * and both must select the first database. Shift is therefore ignored on this
 * path entirely (the ⌘⇧3/4/5 screenshot chords never reach the page — the OS
 * takes them first).
 *
 * `event.key` stays as an additional accept for events that carry no `code`
 * (synthetic events, older engines); it can only ever match a real digit.
 */
function shortcutIndex(event) {
    const physical = /^Digit([1-9])$/.exec(typeof event.code === 'string' ? event.code : '');
    if (physical) return Number(physical[1]) - 1;
    if (typeof event.key === 'string' && /^[1-9]$/.test(event.key)) return Number(event.key) - 1;
    return null;
}

/**
 * A switch is a real operation (it swaps the whole UI state and reloads the
 * grid), so its failure belongs in the status line, not in an unhandled
 * rejection behind chrome that now points at the wrong database.
 */
function switchTo(dbId) {
    // Only reachable before initDatabaseTabs if the host pushed a
    // `databasesChanged` during start() and the user clicked a tab in that
    // window — which the two-database threshold already makes impossible, since
    // start() boots exactly one. Guarded anyway: a TypeError here would be a
    // dead tab strip for the rest of the session.
    if (!host) return Promise.resolve(false);
    return host.setActiveDb(dbId).catch(surface('Database switch failed'));
}

function closeFromUi(dbId) {
    return requestCloseDatabase(dbId).catch(surface('Close failed'));
}

/**
 * The active database as of the last render. The only state this module keeps,
 * and it describes the RENDER, not the registry: it is what lets a switch
 * scroll the newly active tab into view without every other re-render doing
 * the same. Re-renders are frequent — a dirty flag flips on every edit — and
 * scrolling on each one would fight a user who has scrolled the strip.
 */
let scrolledActiveDbId = null;

/**
 * The two focusable roles a tab is built from, used both as the class name and
 * as the key half that survives a re-render.
 */
const TAB_SELECT = 'db-tab-select';
const TAB_CLOSE = 'db-tab-close';

/** Identity of one focusable button across a re-render that replaces it. */
const focusKey = (dbId, role) => `${role} ${dbId}`;

/**
 * Which of the strip's buttons currently holds focus, as {dbId, role}, or null.
 *
 * Keyed off the class name rather than a DOM walk: both roles are built here
 * and carry exactly one class, so this is precise without needing `closest`.
 * The sidebar overview's rows also carry `data-db-id` but are `<li>`s with a
 * different class, and are not focusable.
 */
function focusedStripTarget() {
    const active = document.activeElement;
    const role = active?.className;
    if (role !== TAB_SELECT && role !== TAB_CLOSE) return null;
    const dbId = active?.dataset?.dbId;
    return dbId ? { dbId, role } : null;
}

function renderStrip(databases, visible) {
    const strip = document.getElementById('dbTabStrip');
    if (!strip) return;
    strip.hidden = !visible;
    // Every render replaces the whole subtree, and renders are FREQUENT — the
    // host notifies on every dirty-flag flip, i.e. on every edit. Without this,
    // a user navigating the strip by keyboard would silently lose focus to the
    // body the moment they typed into a cell.
    const focused = focusedStripTarget();
    const focusables = new Map();
    const tabs = databases.map(database => buildTab(database, focusables));
    strip.replaceChildren(...tabs);

    const activeIndex = databases.findIndex(database => database.isActive);
    const activeDbId = activeIndex === -1 ? null : databases[activeIndex].dbId;
    if (visible && activeDbId !== null && activeDbId !== scrolledActiveDbId) {
        // At the open cap the strip is wider than any window, so ⌘7 could
        // otherwise select a tab that never comes into view. Optional-called:
        // it is a nicety, and the unit runner's DOM stand-in has no layout.
        tabs[activeIndex].scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
    scrolledActiveDbId = activeDbId;

    if (!focused) return;
    // The database that held focus may be gone — the close button the user just
    // pressed Enter on is the ordinary way that happens. Fall back to the now
    // active tab so keyboard navigation survives its own close instead of
    // dumping focus on the body.
    const restored = focusables.get(focusKey(focused.dbId, focused.role))
        ?? (activeDbId === null ? undefined : focusables.get(focusKey(activeDbId, TAB_SELECT)));
    restored?.focus?.();
}

/**
 * One tab: a select button and a close button, siblings rather than nested
 * (a button inside a button is invalid HTML and unfocusable in practice), so
 * both are natively keyboard-operable without a roving-tabindex implementation.
 */
function buildTab(database, focusables) {
    const tab = document.createElement('div');
    tab.className = database.isActive ? 'db-tab active' : 'db-tab';
    tab.dataset.dbId = database.dbId;

    const select = document.createElement('button');
    select.type = 'button';
    select.className = TAB_SELECT;
    select.dataset.dbId = database.dbId;
    focusables.set(focusKey(database.dbId, TAB_SELECT), select);
    // Two open files can share a basename; the path is what tells them apart.
    select.title = database.path ?? database.name;
    // A group of toggle buttons rather than an ARIA tablist: a tablist promises
    // arrow-key navigation between tabs and a labelled panel per tab, and a
    // half-kept promise reads worse to a screen reader than an honest one.
    select.setAttribute('aria-pressed', database.isActive ? 'true' : 'false');
    select.addEventListener('click', () => { void switchTo(database.dbId); });

    // textContent throughout: a database name is a filename, i.e. arbitrary
    // user-controlled text.
    const name = document.createElement('span');
    name.className = 'db-tab-name';
    name.textContent = database.name;
    select.appendChild(name);

    const engine = document.createElement('span');
    engine.className = 'db-tab-engine';
    engine.dataset.engine = database.engine;
    engine.textContent = database.engine;
    select.appendChild(engine);

    if (database.isDirty) select.appendChild(dirtyMarker('db-tab-dirty'));
    tab.appendChild(select);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = TAB_CLOSE;
    close.dataset.dbId = database.dbId;
    focusables.set(focusKey(database.dbId, TAB_CLOSE), close);
    close.title = `Close ${database.name}`;
    close.setAttribute('aria-label', `Close ${database.name}`);
    const icon = document.createElement('span');
    icon.className = 'codicon codicon-close';
    close.appendChild(icon);
    close.addEventListener('click', () => { void closeFromUi(database.dbId); });
    tab.appendChild(close);

    return tab;
}

function renderOverview(databases, visible) {
    const title = document.getElementById('sectionOpenDatabases');
    const badge = document.getElementById('openDatabasesBadge');
    const list = document.getElementById('openDatabasesList');
    if (title) title.hidden = !visible;
    if (badge) badge.textContent = String(databases.length);
    if (!list) return;
    // The `hidden` ATTRIBUTE is the desktop gate; the `hidden` CLASS is the
    // user's collapse (sidebar.js toggleSection). Two mechanisms on purpose:
    // re-rendering must not un-collapse a section the user closed.
    list.hidden = !visible;
    list.replaceChildren(...databases.map(buildOverviewItem));
}

function buildOverviewItem(database) {
    const item = document.createElement('li');
    // `list-item` for the sidebar's shared hover/selected styling — but
    // deliberately NO data-name/data-type. sidebar.js's delegated handler reads
    // that pair as "a table was clicked" (and desktop-viewer.js's console
    // wiring closes the console on it); an entry carrying them would select a
    // table that does not exist.
    item.className = database.isActive
        ? 'list-item db-list-item selected'
        : 'list-item db-list-item';
    item.dataset.dbId = database.dbId;
    item.title = database.path ?? database.name;

    // The row's content lives in a real button, like the schema tree's rows
    // (sidebar.js renderSidebarList): `.list-item` is a bare flex container
    // now and `.list-item-select` carries the padding, the hover target and
    // the keyboard focus. The click listener stays on the row, where a click
    // on the button bubbles to it — including the synthetic click a keyboard
    // activation fires.
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'list-item-select';
    select.setAttribute('aria-label', `Switch to ${database.name}`);
    if (database.isActive) select.setAttribute('aria-current', 'true');

    const icon = document.createElement('span');
    icon.className = 'item-icon codicon codicon-database';
    select.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'item-name';
    name.textContent = database.name;
    select.appendChild(name);

    const engine = document.createElement('span');
    engine.className = 'db-item-engine';
    engine.dataset.engine = database.engine;
    engine.textContent = database.engine;
    select.appendChild(engine);

    if (database.isDirty) select.appendChild(dirtyMarker('db-item-dirty'));
    item.appendChild(select);

    item.addEventListener('click', () => { void switchTo(database.dbId); });
    return item;
}

function dirtyMarker(className) {
    const dirty = document.createElement('span');
    dirty.className = className;
    dirty.title = 'Unsaved changes';
    // aria-hidden: the dot is decorative, and `title` already carries the fact
    // for anyone who hovers.
    dirty.setAttribute('aria-hidden', 'true');
    dirty.textContent = '●';
    return dirty;
}
