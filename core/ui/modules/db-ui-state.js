/**
 * Per-database classification of the viewer's `state` singleton.
 *
 * DESKTOP ONLY. The desktop shell holds N open databases at once, but `state`
 * (state.js) stays ONE module-scoped object — every one of its importers keeps
 * rendering from the same reference. Switching databases therefore SNAPSHOTS
 * the outgoing database's fields out of `state` and RESTORES the incoming
 * database's fields back into it (desktop-host.js `setActiveDb`). Keeping this
 * here rather than in state.js keeps it out of the VS Code webview and web-demo
 * bundles, which have exactly one database and never call any of it.
 *
 * Every field of `state` belongs to exactly one of three classes, and the
 * classification is exhaustive BY TEST (`state field classification covers
 * every field of the state singleton exactly once`, tests/unit/
 * desktop_host.test.ts) — a field added to `state` later fails that test
 * instead of silently picking a class.
 *
 * A per-database field wrongly classified global (or simply forgotten) is the
 * defining defect of this design: one database's grid, filters or row selection
 * would be shown for another.
 */
import { createSafeColumnState, state } from './state.js';

/**
 * Fields owned by ONE open database. The factory returns FRESH container
 * instances every call — a new database must never share a Set/object/array
 * with `state`'s initial value or with another database's snapshot.
 */
const perDbStateDefaults = () => ({
    // Connection identity of the database being rendered.
    dbId: null,
    isDbConnected: false,
    isReadOnly: false,
    engine: null,
    // Host connection identity and content revision of the database being
    // rendered (state.js). Async UI intents capture both and refuse to
    // complete against a replaced connection or changed content. Per
    // database, because on the desktop each open database IS its own
    // connection with its own edit stream: the host reports one generation
    // per entry, and a global counter would let a reload of database A
    // invalidate what B's open modal captured, or carry B's content revision
    // into A's guards.
    connectionGeneration: 0,
    contentGeneration: 0,
    // Selection + the page of rows on screen.
    selectedTable: null,
    selectedTableType: 'table',
    selectedTableIdentity: null,
    renderedTable: null,
    currentPageIndex: 0,
    totalRecordCount: 0,
    totalRecordCountIsExact: true,
    // 'pending' while a cold-cache first page is on screen ahead of its
    // count, 'unavailable' when that count failed (grid-data.js). Per
    // database: it describes the rows this database has on screen, and a
    // switch mid-count leaves it for that database's next load to settle.
    countStatus: 'ready',
    totalPageCount: 1,
    tableColumns: [],
    sortedColumn: null,
    sortAscending: true,
    filterQuery: '',
    selectedRowIds: new Set(),
    gridData: [],
    gridExactIntegerTexts: {},
    gridOversizedCells: {},
    gridReadOnlyRowReasons: {},
    keysetAnchors: null,
    // The cell/column/row selection. (`editingCellInfo` is NOT here — see the
    // transient class below.)
    selectedCells: [],
    lastSelectedCell: null,
    lastSelectedColumnIndex: null,
    lastSelectedRowIndex: null,
    // Column layout and predicates: both are per-schema by construction.
    // Null-prototype dictionaries, as state.js seeds them: their keys are
    // column names read out of an untrusted file, and a plain object would
    // let a column literally named `__proto__` retarget the dictionary.
    columnWidths: createSafeColumnState(),
    columnFilters: createSafeColumnState(),
    lastSuccessfulFilterState: null,
    lastGridLoadError: null,
    pinnedColumns: new Set(),
    pinnedRowIds: new Set(),
    selectedColumns: new Set(),
    scrollPosition: { top: 0, left: 0 },
    // The schema tree and the name filter over it.
    schemaCache: { tables: [], views: [], indexes: [] },
    sidebarFilter: '',
    matchNav: { scope: null, term: null, matches: [], currentIndex: -1 }
});

/**
 * In-flight UI bookkeeping: mid-drag resize offsets, debounce timers, live DOM
 * input references, "a load is running" guards, the open cell-preview modal.
 * None of it survives a switch in either direction — it describes an
 * interaction with the OUTGOING database against DOM the switch replaces, so it
 * is RESET rather than carried (restoring a detached `activeCellInput`, or a
 * stale `isGridReloading` guard, would wedge the incoming database's grid).
 */
const transientStateDefaults = () => ({
    // An inline edit is a <textarea> the incoming database's render destroys,
    // and `editingCellInfo`/`activeCellInput` are set and cleared TOGETHER
    // (edit.js startCellEdit). Carrying the descriptor per database while its
    // input is transient would restore a non-null editingCellInfo with a null
    // activeCellInput on the way back, and the codebase reads that pair as "an
    // editor is live": loadTableData would skip renderDataGrid (leaving the
    // OUTGOING database's rows on screen over the incoming one's gridData),
    // grid-render's editorHoldsWindow() would return true forever so the
    // virtual window stops updating, and clicks/Enter/shortcuts would be
    // swallowed. So the descriptor is transient too — an inline edit simply
    // cannot survive a switch, because its DOM cannot.
    editingCellInfo: null,
    activeCellInput: null,
    isSavingCell: false,
    isLoadingData: false,
    // "A column-metadata fetch / a host content broadcast is in flight" —
    // guards over async work against the OUTGOING database's DOM, which the
    // switch abandons (the fetch itself is refused by the dbId gate).
    isLoadingColumns: false,
    isRefreshingContent: false,
    // The in-flight host broadcast itself (rpc.js refreshContent publishes it
    // so edit.js's Tab-advance can await it). Transient like the flag above:
    // its `finally` clears the slot only if it still holds THIS promise, so an
    // outgoing database's late completion cannot null out the incoming one's.
    contentRefreshPromise: null,
    isGridReloading: false,
    lastDoubleClickTime: 0,
    isTransitioningEdit: false,
    transitionLockTimeout: null,
    resizingColumn: null,
    resizeStartX: 0,
    resizeStartWidth: 0,
    filterTimer: null,
    filterApplyPending: false,
    filterApplyTable: null,
    filterPendingAction: null,
    cellPreviewInfo: null
});

/** @type {readonly string[]} */
export const PER_DB_STATE_FIELDS = Object.freeze(Object.keys(perDbStateDefaults()));
/** @type {readonly string[]} */
export const TRANSIENT_STATE_FIELDS = Object.freeze(Object.keys(transientStateDefaults()));

/**
 * Fields that are genuinely app-wide and must survive a database switch
 * untouched.
 * - `rowsPerPage` is a user PREFERENCE (seeded from the defaultPageSize
 *   setting, persisted with the webview state) and its only control,
 *   `#pageSizeSelect`, is a single static element the switch does not
 *   re-render — making it per-database would leave that control reporting a
 *   LIMIT other than the one actually queried, exactly the divergence
 *   state.js's DEFAULT_ROWS_PER_PAGE comment guards against.
 * - `dateFormat` and `cellPreviewWrapEnabled` are display preferences; the
 *   first is likewise bound to one static `#dateFormatSelect`.
 * - `cellEditBehavior` mirrors the host's persisted setting, pushed app-wide.
 * - `isDesktop` is a build fact.
 * - `collapsedSections` and `sidebarWidth` are sidebar LAYOUT preferences
 *   (state.js; VS Code persists them in its webview snapshot). The sidebar is
 *   one static panel the switch re-renders in place — renderSidebar() applies
 *   `collapsedSections` to the section DOM on every render — so making them
 *   per-database would snap the Tables/Views/Indexes groups open or closed,
 *   or resize the panel, every time the user changes tabs.
 */
export const GLOBAL_STATE_FIELDS = Object.freeze([
    'rowsPerPage',
    'dateFormat',
    'cellPreviewWrapEnabled',
    'cellEditBehavior',
    'isDesktop',
    'collapsedSections',
    'sidebarWidth'
]);

/** A brand-new database's UI state: every per-database field at its default. */
export function createPerDbStateSnapshot() {
    return perDbStateDefaults();
}

/**
 * Lift the per-database fields out of the live `state`. References (not
 * copies) — while another database is active nothing else holds these
 * containers, and preserving identity is what lets the restore be a plain
 * reassignment.
 */
export function snapshotPerDbState() {
    const snapshot = {};
    for (const field of PER_DB_STATE_FIELDS) snapshot[field] = state[field];
    return snapshot;
}

/**
 * Put a snapshot back into the SAME `state` object (identity preserved, so
 * every importer keeps working) and reset the transient class.
 *
 * Only fields named in the classification are written: a snapshot can never
 * reach across and overwrite a global field.
 */
export function restorePerDbState(snapshot) {
    // Timers belong to the OUTGOING database's in-flight UI work. A debounced
    // filter apply left armed here would fire AFTER the switch and query the
    // INCOMING database with the outgoing one's draft predicate.
    if (state.filterTimer !== null) clearTimeout(state.filterTimer);
    if (state.transitionLockTimeout !== null) clearTimeout(state.transitionLockTimeout);
    const transient = transientStateDefaults();
    for (const field of TRANSIENT_STATE_FIELDS) state[field] = transient[field];
    for (const field of PER_DB_STATE_FIELDS) state[field] = snapshot[field];
}
