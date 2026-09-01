/**
 * Application State
 */
import { saveVsCodeState } from './api.js';

/**
 * Built-in rows-per-page default. Must match the `selected` option of
 * `#pageSizeSelect` in viewer.template.html: the two are the same default
 * expressed in state and in markup, and drifting apart would make the visible
 * selector disagree with the LIMIT actually queried.
 */
export const DEFAULT_ROWS_PER_PAGE = 5000;

/**
 * Create a dictionary whose keys may be arbitrary SQLite identifiers. A plain
 * object makes __proto__ an inherited setter and exposes constructor/toString
 * as fake pre-existing values, corrupting column filters and widths.
 */
export function createSafeColumnState(source) {
    const target = Object.create(null);
    if (!source || typeof source !== 'object' || Array.isArray(source)) return target;
    for (const key of Object.keys(source)) {
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        if (!descriptor || !('value' in descriptor)) continue;
        Object.defineProperty(target, key, {
            value: descriptor.value,
            enumerable: true,
            configurable: true,
            writable: true
        });
    }
    return target;
}

// Accepted page-size range. The upper bound mirrors the declared maximum of
// sqliteExplorer.defaultPageSize in package.json so a hand-edited setting
// cannot request a LIMIT that starves the per-page inline-cell byte budget
// into clipping literally everything; the lower bound only rejects nonsense
// (zero/negative), deliberately looser than the setting's declared minimum.
const MAX_PAGE_SIZE = 100000;

function toValidPageSize(value) {
    const parsed = typeof value === 'number' ? value : Number.parseInt(value ?? '', 10);
    return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_PAGE_SIZE
        ? parsed
        : undefined;
}

/**
 * Resolve the page size the webview starts with. Precedence: the user's
 * persisted in-grid selection, then a configured sqliteExplorer.defaultPageSize
 * (delivered as a string via the vscode-env meta dataset), then the built-in
 * default. The setting is a *default*, so an explicit in-grid choice outlives
 * it; invalid or absent values fall through to the next source.
 */
export function resolveStartupPageSize(configuredValue, persistedValue) {
    return toValidPageSize(persistedValue)
        ?? toValidPageSize(configuredValue)
        ?? DEFAULT_ROWS_PER_PAGE;
}

export const state = {
    isDbConnected: false,
    isReadOnly: false,
    // Host connection identity. Async UI intents capture this so a reload
    // cannot retarget them to an unrelated row with the same table/rowid.
    connectionGeneration: 0,
    // Advances for every external content broadcast, including same-engine
    // edits. Row identities can be deleted and reused without changing the
    // connection generation, so delayed destructive intents bind to both.
    contentGeneration: 0,
    selectedTable: null,
    selectedTableType: 'table',
    selectedTableIdentity: null,
    // Name of the table whose grid is currently rendered on screen. Lets
    // loadTableData tell a same-table refetch (keep the grid, no flicker) apart
    // from a table switch (show the spinner instead of the previous table's rows).
    renderedTable: null,
    currentPageIndex: 0,
    rowsPerPage: DEFAULT_ROWS_PER_PAGE,
    totalRecordCount: 0,
    totalRecordCountIsExact: true,
    totalPageCount: 1,
    tableColumns: [],
    sortedColumn: null,
    sortAscending: true,
    filterQuery: '',
    selectedRowIds: new Set(),
    gridData: [],
    // Sparse row/data-column exact text for SQLite INTEGERs outside JS's safe
    // range. General grid values stay numbers for backward compatibility.
    gridExactIntegerTexts: {},
    // Sparse row/source-column metadata for TEXT/BLOB values that were bounded
    // at the query boundary. Source-column indexing includes the identity slot
    // used by tables, matching gridExactIntegerTexts.
    gridOversizedCells: {},
    // Sparse reasons for WITHOUT ROWID rows whose complete primary-key identity
    // was intentionally not transported because a key member was oversized.
    gridReadOnlyRowReasons: {},
    // Engine-issued keyset anchors describing the committed grid page:
    // { table, pageIndex, first, last }. Owned by loadTableData, which commits
    // them atomically with gridData inside its superseded-load gate, so they
    // always describe the rows on screen. Deliberately NOT persisted: restored
    // webviews re-anchor from their first OFFSET load.
    keysetAnchors: null,

    // Cell editing state
    editingCellInfo: null,
    activeCellInput: null,
    isSavingCell: false,
    isLoadingData: false,
    isLoadingColumns: false,
    isRefreshingContent: false,
    // Dedicated guard for "a grid data reload is in flight", owned solely by
    // loadTableData. Kept separate from isLoadingData (which BLOB uploads also set)
    // so the grid-interaction guards can't be cleared by an unrelated upload. The
    // grid event handlers and the global delete/select-all shortcuts key on this to
    // avoid acting on rows that are about to be replaced.
    isGridReloading: false,
    lastDoubleClickTime: 0,
    isTransitioningEdit: false,
    transitionLockTimeout: null,

    // Cell selection state
    selectedCells: [],
    lastSelectedCell: null,
    lastSelectedColumnIndex: null, // For column range selection
    lastSelectedRowIndex: null,    // For row range selection

    // Column resize state
    columnWidths: createSafeColumnState(),
    resizingColumn: null,
    resizeStartX: 0,
    resizeStartWidth: 0,

    // Column filters
    columnFilters: createSafeColumnState(),
    // Filter drafts are copied from every visible input before asynchronous work.
    // A single debounce queue prevents overlapping reloads while preserving text
    // typed into the still-visible header during an in-flight replacement.
    filterTimer: null,
    filterApplyPending: false,
    filterApplyTable: null,
    filterPendingAction: null,
    // The filter state paired with the currently retained successful grid.
    // Draft input remains in the DOM on query failure while state rolls back
    // to this snapshot, so refresh/persistence never adopts a failed predicate.
    lastSuccessfulFilterState: null,
    lastGridLoadError: null,

    // Pinned items
    pinnedColumns: new Set(),
    pinnedRowIds: new Set(),

    // Cell preview modal state
    cellPreviewInfo: null,
    cellPreviewWrapEnabled: true,

    // Selected columns state
    selectedColumns: new Set(),

    // Scroll position persistence
    scrollPosition: { top: 0, left: 0 },

    // Schema cache
    schemaCache: { tables: [], views: [], indexes: [] },

    // Sidebar filter (filters tables, views, indexes by name)
    sidebarFilter: '',

    // Settings
    dateFormat: 'raw', // 'raw', 'local', 'iso', 'relative'
    cellEditBehavior: 'inline', // 'inline', 'modal', 'vscode'

    // Filter match navigation (Enter-to-jump on global/column filters)
    matchNav: {
        scope: null,       // GLOBAL_MATCH_SCOPE Symbol or a column name
        term: null,        // the ASCII-folded term the cached matches were computed for
        matches: [],       // [{ rowIdx, colIdx }] in row/column order
        currentIndex: -1
    }
};

/**
 * Debounced state persistence to VS Code.
 * Saves a snapshot of user-facing state so it survives tab switches
 * when retainContextWhenHidden is false.
 */
let _persistTimer;
export function persistState() {
    if (_persistTimer) clearTimeout(_persistTimer);
    _persistTimer = setTimeout(() => {
        saveVsCodeState({
            connectionGeneration: state.connectionGeneration,
            selectedTable: state.selectedTable,
            selectedTableType: state.selectedTableType,
            currentPageIndex: state.currentPageIndex,
            rowsPerPage: state.rowsPerPage,
            sortedColumn: state.sortedColumn,
            sortAscending: state.sortAscending,
            filterQuery: state.filterQuery,
            columnWidths: state.columnWidths,
            columnFilters: state.columnFilters,
            pinnedColumns: Array.from(state.pinnedColumns),
            pinnedRowIds: Array.from(state.pinnedRowIds),
            selectedColumns: Array.from(state.selectedColumns),
            sidebarFilter: state.sidebarFilter,
            scrollPosition: state.scrollPosition,
            dateFormat: state.dateFormat,
        });
    }, 500);
}
