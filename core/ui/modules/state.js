/**
 * Application State
 */
export const state = {
    isDbConnected: false,
    selectedTable: null,
    selectedTableType: 'table',
    currentPageIndex: 0,
    rowsPerPage: 500,
    totalRecordCount: 0,
    totalPageCount: 1,
    tableColumns: [],
    sortedColumn: null,
    sortAscending: true,
    filterQuery: '',
    filterTimer: null,
    selectedRowIds: new Set(),
    gridData: [],

    // Cell editing state
    editingCellInfo: null,
    activeCellInput: null,
    isSavingCell: false,
    isLoadingData: false,
    lastDoubleClickTime: 0,
    isTransitioningEdit: false,
    transitionLockTimeout: null,

    // Cell selection state
    selectedCells: [],
    lastSelectedCell: null,

    // Column resize state
    columnWidths: {},
    resizingColumn: null,
    resizeStartX: 0,
    resizeStartWidth: 0,

    // Column filters
    columnFilters: {},

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

    // Settings
    dateFormat: 'raw', // 'raw', 'local', 'iso', 'relative'
    cellEditBehavior: 'inline' // 'inline', 'modal', 'vscode'
};
