/**
 * SQLite Explorer - Webview JavaScript
 *
 * This file contains all JavaScript logic for the SQLite Explorer webview UI.
 * It handles:
 * - Database connection and RPC communication with the extension host
 * - Data grid rendering and cell editing
 * - Row/column selection and clipboard operations
 * - Table/schema navigation in the sidebar
 * - Pagination, sorting, and filtering
 * - Modal dialogs for CRUD operations
 *
 * This file is bundled into viewer.html at build time.
 */

// ================================================================
// APPLICATION STATE
// ================================================================
let isDbConnected = false;
let selectedTable = null;
let selectedTableType = 'table';
let currentPageIndex = 0;
let rowsPerPage = 500;
let totalRecordCount = 0;
let totalPageCount = 1;
let tableColumns = [];
let sortedColumn = null;
let sortAscending = true;
let filterQuery = '';
let filterTimer = null;
let selectedRowIds = new Set();
let gridData = [];

// Cell editing state
let editingCellInfo = null;
let activeCellInput = null;
let isSavingCell = false; // Guard against concurrent save operations
let isLoadingData = false; // Guard against interactions during data loading
let lastDoubleClickTime = 0; // Debounce double-clicks
let isTransitioningEdit = false; // Guard during edit mode transition (prevents border click issues)
let transitionLockTimeout = null; // Failsafe timeout to release stuck lock

// Cell selection state (for copying individual values)
// Supports multi-cell selection with Cmd+Click
let selectedCells = []; // Array of { rowIdx, colIdx, rowId, value }
let lastSelectedCell = null; // For Shift+Click range selection

// Column resize state
let columnWidths = {}; // Map of column name -> width in pixels
let resizingColumn = null;
let resizeStartX = 0;
let resizeStartWidth = 0;

// Column filters state (per-column filtering)
let columnFilters = {}; // Map of column name -> filter value

// Pinned rows and columns
let pinnedColumns = new Set(); // Set of column names
let pinnedRowIds = new Set(); // Set of row IDs

// Cell preview modal state
// Stores info about the cell being previewed/edited in the floating window
let cellPreviewInfo = null; // { rowIdx, colIdx, rowId, columnName, originalValue }
let cellPreviewWrapEnabled = true; // Whether word wrap is enabled in the preview textarea

// Selected columns state - tracks which columns are fully selected (all cells in column selected)
// Used for column deletion feature
let selectedColumns = new Set(); // Set of column names that are fully selected

// Schema cache
let schemaCache = { tables: [], views: [], indexes: [] };

// RPC proxy (will be set up during init)
let backendApi = null;

// ================================================================
// ROW DATA ACCESSORS
// ================================================================
// Tables include rowid at index 0, views do not.
// These helpers abstract the offset difference.

/**
 * Get the offset for column data in a row array.
 * Tables: row[0] = rowid, data starts at index 1
 * Views: no rowid, data starts at index 0
 * @returns {number} The offset to add to column index
 */
function getRowDataOffset() {
    return selectedTableType === 'table' ? 1 : 0;
}

/**
 * Get the row ID for a given row. For tables, this is the SQLite rowid.
 * For views, we use a synthetic ID based on page offset + row index.
 * @param {Array} row - The row data array
 * @param {number} rowIdx - The index of the row in gridData
 * @returns {number|string} The row identifier
 */
function getRowId(row, rowIdx) {
    if (selectedTableType === 'table') {
        return row[0]; // SQLite rowid
    }
    // For views: use page-adjusted row index as synthetic ID
    // This provides a stable identifier within the current view
    return currentPageIndex * rowsPerPage + rowIdx;
}

/**
 * Get a cell value from a row by column index.
 * @param {Array} row - The row data array
 * @param {number} colIdx - The column index (0-based, matching tableColumns)
 * @returns {*} The cell value
 */
function getCellValue(row, colIdx) {
    return row[colIdx + getRowDataOffset()];
}

// ================================================================
// RPC SETUP
// ================================================================
const vscodeApi = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : null;

// Message ID tracking for RPC
let rpcMessageId = 0;
const pendingRpcCalls = new Map();

function sendRpcRequest(method, args) {
    return new Promise((resolve, reject) => {
        const messageId = `rpc_${++rpcMessageId}_${Date.now()}`;

        const timeoutId = setTimeout(() => {
            if (pendingRpcCalls.has(messageId)) {
                pendingRpcCalls.delete(messageId);
                reject(new Error(`RPC timeout: ${method}`));
            }
        }, 30000);

        pendingRpcCalls.set(messageId, { resolve, reject, timeoutId });

        if (vscodeApi) {
            vscodeApi.postMessage({
                channel: 'rpc',
                content: {
                    kind: 'invoke',
                    messageId,
                    targetMethod: method,
                    payload: args
                }
            });
        }
    });
}

// ================================================================
// LOCAL METHODS FOR EXTENSION TO CALL
// These methods are called BY the extension via RPC (extension -> webview)
// ================================================================
const webviewMethods = {
    // Called when document content changes and we need to reload data
    async refreshContent(filename) {
        if (isDbConnected && selectedTable) {
            await loadTableData();
        }
        return { success: true };
    },

    // Called when VS Code color scheme changes
    async updateColorScheme(scheme) {
        document.documentElement.style.colorScheme = scheme;
        return { success: true };
    },

    // Called when auto-commit setting changes
    async updateAutoCommit(value) {
        // Store for later use if needed
        return { success: true };
    },

    // Called when cell edit behavior setting changes
    async updateCellEditBehavior(value) {
        // Store for later use if needed
        return { success: true };
    },

    // Called when webview visibility/active state changes
    async updateViewState(state) {
        // Handle visibility changes if needed
        return { success: true };
    },

    // Called when Copilot becomes active/inactive
    async updateCopilotActive(active) {
        // Handle Copilot state if needed
        return { success: true };
    }
};

// Handle messages from extension
window.addEventListener('message', event => {
    const envelope = event.data;

    // Handle RPC protocol messages (from core/rpc.ts)
    if (envelope && envelope.kind === 'invoke') {
        // This is an incoming invocation from the extension
        const { correlationId, methodName, parameters } = envelope;
        const method = webviewMethods[methodName];

        if (typeof method === 'function') {
            Promise.resolve(method.apply(webviewMethods, parameters || []))
                .then(result => {
                    if (vscodeApi) {
                        vscodeApi.postMessage({
                            kind: 'result',
                            correlationId,
                            payload: result
                        });
                    }
                })
                .catch(err => {
                    if (vscodeApi) {
                        vscodeApi.postMessage({
                            kind: 'result',
                            correlationId,
                            errorText: err instanceof Error ? err.message : String(err)
                        });
                    }
                });
        } else {
            // Method not found
            if (vscodeApi) {
                vscodeApi.postMessage({
                    kind: 'result',
                    correlationId,
                    errorText: `Unknown method: ${methodName}`
                });
            }
        }
        return;
    }

    // Handle RPC responses (from our requests to the extension)
    if (!envelope || envelope.channel !== 'rpc') return;

    const message = envelope.content;
    if (message && message.kind === 'response') {
        const pending = pendingRpcCalls.get(message.messageId);
        if (pending) {
            clearTimeout(pending.timeoutId);
            pendingRpcCalls.delete(message.messageId);

            if (message.success) {
                pending.resolve(message.data);
            } else {
                pending.reject(new Error(message.errorMessage || 'RPC failed'));
            }
        }
    }
});

// Create backend API proxy
backendApi = {
    initialize: () => sendRpcRequest('initialize', []),
    exec: (sql, params) => sendRpcRequest('exec', [sql, params]),
    exportDb: (filename) => sendRpcRequest('exportDb', [filename]),
    refreshFile: () => sendRpcRequest('refreshFile', []),
    fireEditEvent: (edit) => sendRpcRequest('fireEditEvent', [edit]),
    exportTable: (dbParams, columns) => sendRpcRequest('exportTable', [dbParams, columns])
};

// ================================================================
// INITIALIZATION
// ================================================================
async function initializeApp() {
    try {
        updateStatus('Connecting to database...');

        const result = await backendApi.initialize();
        if (!result || !result.connected) {
            throw new Error('Failed to connect to database');
        }

        isDbConnected = true;
        console.log('Connected to database:', result.filename);

        // Test connection
        await backendApi.exec('SELECT 1');

        // Load schema
        await refreshSchema();

        updateStatus('Ready');
        showEmptyState();

    } catch (err) {
        console.error('Init error:', err);
        showErrorState(err.message);
    }
}

// ================================================================
// SCHEMA LOADING
// ================================================================
async function refreshSchema() {
    if (!isDbConnected) return;

    try {
        const tablesResult = await backendApi.exec(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        );
        const viewsResult = await backendApi.exec(
            "SELECT name FROM sqlite_schema WHERE type='view' ORDER BY name"
        );
        const indexesResult = await backendApi.exec(
            "SELECT name, tbl_name FROM sqlite_schema WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        );

        schemaCache.tables = (tablesResult[0]?.records || []).map(r => ({ name: r[0] }));
        schemaCache.views = (viewsResult[0]?.records || []).map(r => ({ name: r[0] }));
        schemaCache.indexes = (indexesResult[0]?.records || []).map(r => ({ name: r[0], table: r[1] }));

        renderSidebar();

    } catch (err) {
        console.error('Error loading schema:', err);
        updateStatus('Error loading schema');
    }
}

// ================================================================
// SIDEBAR RENDERING
// ================================================================
function renderSidebar() {
    document.getElementById('tablesBadge').textContent = schemaCache.tables.length;
    document.getElementById('viewsBadge').textContent = schemaCache.views.length;
    document.getElementById('indexesBadge').textContent = schemaCache.indexes.length;

    const tablesList = document.getElementById('tablesList');
    if (schemaCache.tables.length === 0) {
        tablesList.innerHTML = '<li class="list-item" style="opacity:0.5">No tables</li>';
    } else {
        tablesList.innerHTML = schemaCache.tables.map(t => `
            <li class="list-item ${selectedTable === t.name && selectedTableType === 'table' ? 'selected' : ''}"
                onclick="selectTableItem('${escapeHtml(t.name)}', 'table')"
                title="${escapeHtml(t.name)}">
                <span class="item-icon codicon codicon-table"></span>
                <span class="item-name">${escapeHtml(t.name)}</span>
            </li>
        `).join('');
    }

    const viewsList = document.getElementById('viewsList');
    if (schemaCache.views.length === 0) {
        viewsList.innerHTML = '<li class="list-item" style="opacity:0.5">No views</li>';
    } else {
        viewsList.innerHTML = schemaCache.views.map(v => `
            <li class="list-item ${selectedTable === v.name && selectedTableType === 'view' ? 'selected' : ''}"
                onclick="selectTableItem('${escapeHtml(v.name)}', 'view')"
                title="${escapeHtml(v.name)}">
                <span class="item-icon codicon codicon-eye"></span>
                <span class="item-name">${escapeHtml(v.name)}</span>
            </li>
        `).join('');
    }

    const indexesList = document.getElementById('indexesList');
    if (schemaCache.indexes.length === 0) {
        indexesList.innerHTML = '<li class="list-item" style="opacity:0.5">No indexes</li>';
    } else {
        indexesList.innerHTML = schemaCache.indexes.map(i => `
            <li class="list-item" title="${escapeHtml(i.name)} on ${escapeHtml(i.table)}">
                <span class="item-icon codicon codicon-list-tree"></span>
                <span class="item-name">${escapeHtml(i.name)}</span>
            </li>
        `).join('');
    }
}

function toggleSection(section) {
    const title = document.querySelector(`[data-section="${section}"]`);
    const list = document.getElementById(`${section}List`);

    title.classList.toggle('collapsed');
    list.classList.toggle('hidden');
}

// ================================================================
// TABLE SELECTION & DATA LOADING
// ================================================================
async function selectTableItem(tableName, tableType = 'table') {
    selectedTable = tableName;
    selectedTableType = tableType;
    currentPageIndex = 0;
    sortedColumn = null;
    sortAscending = true;
    columnWidths = {}; // Reset column widths for new table
    columnFilters = {}; // Reset column filters
    pinnedColumns.clear(); // Reset pinned columns
    pinnedRowIds.clear(); // Reset pinned rows
    filterQuery = '';
    selectedRowIds.clear();
    selectedCells = []; // Clear cell selection
    selectedColumns.clear(); // Clear column selection
    lastSelectedCell = null;
    document.getElementById('filterInput').value = '';

    document.getElementById('tableNameLabel').textContent = tableName;
    updateToolbarButtons();
    renderSidebar();

    await loadTableColumns();
    await loadTableData();
}

async function loadTableColumns() {
    if (!selectedTable) return;

    try {
        const result = await backendApi.exec(`PRAGMA table_info("${selectedTable}")`);
        tableColumns = (result[0]?.records || []).map(r => ({
            cid: r[0],
            name: r[1],
            type: r[2] || 'TEXT',
            notnull: r[3],
            defaultValue: r[4],
            isPrimaryKey: r[5]
        }));
    } catch (err) {
        console.error('Error loading columns:', err);
        tableColumns = [];
    }
}

async function loadTableData() {
    if (!selectedTable || !isDbConnected) return;

    // Prevent concurrent load operations
    if (isLoadingData) return;
    isLoadingData = true;

    // Save scroll position BEFORE showLoading() destroys the content.
    // This allows us to restore the user's view after re-rendering,
    // which is especially important when filtering columns on the right side.
    const container = document.getElementById('gridContainer');
    const savedScrollLeft = container.scrollLeft;
    const savedScrollTop = container.scrollTop;

    showLoading();

    try {
        // Build WHERE clause from global filter and column filters
        const whereConditions = [];

        // Global filter (searches all columns)
        if (filterQuery) {
            const globalConditions = tableColumns.map(c => `"${c.name}" LIKE '%${filterQuery.replace(/'/g, "''")}%'`).join(' OR ');
            whereConditions.push(`(${globalConditions})`);
        }

        // Column-specific filters (AND logic between columns)
        for (const [colName, filterValue] of Object.entries(columnFilters)) {
            if (filterValue && filterValue.trim()) {
                const escaped = filterValue.replace(/'/g, "''");
                whereConditions.push(`"${colName}" LIKE '%${escaped}%'`);
            }
        }

        const whereClause = whereConditions.length > 0 ? ` WHERE ${whereConditions.join(' AND ')}` : '';

        // Get total count
        const countSql = `SELECT COUNT(*) FROM "${selectedTable}"${whereClause}`;
        const countResult = await backendApi.exec(countSql);
        totalRecordCount = countResult[0]?.records?.[0]?.[0] || 0;
        totalPageCount = Math.max(1, Math.ceil(totalRecordCount / rowsPerPage));

        if (currentPageIndex >= totalPageCount) {
            currentPageIndex = Math.max(0, totalPageCount - 1);
        }

        // Build data query with explicit column names for consistent ordering
        // Use alias for rowid to prevent deduplication with INTEGER PRIMARY KEY columns
        // This ensures native SQLite backend returns columns in the same order as PRAGMA table_info
        // Note: Views don't have a rowid column - only include rowid for tables
        const columnNames = tableColumns.map(c => `"${c.name}"`).join(', ');
        const isTable = selectedTableType === 'table';
        let dataSql = isTable
            ? `SELECT rowid AS _rowid_, ${columnNames} FROM "${selectedTable}"${whereClause}`
            : `SELECT ${columnNames} FROM "${selectedTable}"${whereClause}`;
        if (sortedColumn) {
            dataSql += ` ORDER BY "${sortedColumn}" ${sortAscending ? 'ASC' : 'DESC'}`;
        }
        dataSql += ` LIMIT ${rowsPerPage} OFFSET ${currentPageIndex * rowsPerPage}`;

        const dataResult = await backendApi.exec(dataSql);
        gridData = dataResult[0]?.records || [];

        renderDataGrid();

        // Restore scroll position after rendering.
        // The scroll position was saved before showLoading() destroyed the content.
        container.scrollLeft = savedScrollLeft;
        container.scrollTop = savedScrollTop;

        updatePagination();
        updateStatus(`${totalRecordCount} records`);

    } catch (err) {
        console.error('Error loading data:', err);
        updateStatus(`Error: ${err.message}`);
        showErrorState(err.message);
    } finally {
        isLoadingData = false;
    }
}

// ================================================================
// DATA GRID RENDERING
// ================================================================
function renderDataGrid() {
    const container = document.getElementById('gridContainer');

    // Save scroll position before re-rendering to preserve user's view
    const savedScrollLeft = container.scrollLeft;
    const savedScrollTop = container.scrollTop;

    // Check if any column filters are active
    const hasActiveFilters = Object.values(columnFilters).some(v => v && v.trim() !== '');

    // Only show empty state if table is truly empty (no filters active)
    // If filters are active but no results, still show headers so user can clear filters
    if (gridData.length === 0 && !hasActiveFilters && tableColumns.length === 0) {
        container.innerHTML = `
            <div class="empty-view">
                <span class="empty-icon codicon codicon-database"></span>
                <span class="empty-title">No data</span>
                <span class="empty-desc">This table is empty</span>
            </div>
        `;
        return;
    }

    let html = '<table class="data-grid"><thead class="grid-header"><tr>';

    // Calculate initial column widths if not already set
    if (Object.keys(columnWidths).length === 0 && gridData.length > 0) {
        for (const col of tableColumns) {
            // Calculate width based on column title length.
            // Uses ~8px per character as an approximation for the font width.
            // Add padding for: key icon (16px if primary key), sort indicator (14px),
            // pin/select icons (40px), and cell padding (16px) = ~70px extra for icons.
            const headerLen = col.name.length;
            const iconPadding = col.isPrimaryKey ? 86 : 70;

            // Calculate width to fit the column title.
            // Min: 80px for very short names (ensures filter input is usable).
            // Max: 250px - truncate column names longer than ~22 characters.
            const titleWidth = headerLen * 8 + iconPadding;
            columnWidths[col.name] = Math.max(80, Math.min(250, titleWidth));
        }
    }

    // Reorder columns: pinned columns first, then non-pinned columns
    // This ensures pinned columns are always rendered on the left side
    const orderedColumns = [
        ...tableColumns.filter(col => pinnedColumns.has(col.name)),
        ...tableColumns.filter(col => !pinnedColumns.has(col.name))
    ];

    // Calculate cumulative left offsets for pinned columns based on their DOM order
    // Row number column is always at left: 0 with width 50px
    const pinnedColumnOffsets = new Map();
    let cumulativeLeft = 50; // Start after row number column
    for (const col of orderedColumns) {
        if (pinnedColumns.has(col.name)) {
            pinnedColumnOffsets.set(col.name, cumulativeLeft);
            cumulativeLeft += (columnWidths[col.name] || 120);
        }
    }

    // Create a mapping from column name to original index for data access
    const columnIndexMap = new Map();
    tableColumns.forEach((col, idx) => columnIndexMap.set(col.name, idx));

    // Header cells - '#' column is clickable for select all
    // Row number header has same height but no filter
    html += '<th class="header-cell row-number-header" style="width:50px;position:sticky;left:0;z-index:11;background:var(--bg-secondary)" onclick="onSelectAllClick(event)" title="Click to select all rows"><div class="header-content"><div class="header-top" style="height:100%;justify-content:center">#</div></div></th>';
    for (const col of orderedColumns) {
        const isSorted = sortedColumn === col.name;
        const isPinned = pinnedColumns.has(col.name);
        const pinnedClass = isPinned ? 'pinned' : '';
        const leftOffset = pinnedColumnOffsets.get(col.name);
        const pinnedStyle = isPinned ? `position:sticky;left:${leftOffset}px;` : '';
        // Use stored width (now always set)
        const colWidth = columnWidths[col.name] || 120;
        const filterValue = columnFilters[col.name] || '';
        // Build sort indicator HTML - shown next to column name
        const sortIndicator = isSorted ? `<span class="sort-indicator">${sortAscending ? '▲' : '▼'}</span>` : '';
        // Build primary key icon - shown before column name
        const keyIcon = col.isPrimaryKey ? '<span class="key-icon codicon codicon-key" title="Primary Key"></span>' : '';
        html += `<th class="header-cell ${pinnedClass}" style="width:${colWidth}px;min-width:${colWidth}px;max-width:${colWidth}px;${pinnedStyle}" data-column="${escapeHtml(col.name)}">`;
        html += `<div class="header-content">`;
        // Top row: key icon + column name + sort indicator + icons (select, pin)
        html += `<div class="header-top" onclick="onColumnSort('${escapeHtml(col.name)}')">`;
        html += `${keyIcon}<span class="header-text">${escapeHtml(col.name)}${sortIndicator}</span>`;
        html += `<span class="select-column-icon codicon codicon-selection" onclick="event.stopPropagation(); onColumnHeaderClick(event, '${escapeHtml(col.name)}')" title="Select entire column"></span>`;
        html += `<span class="pin-icon codicon codicon-pin ${isPinned ? 'pinned' : ''}" onclick="event.stopPropagation(); toggleColumnPin(event, '${escapeHtml(col.name)}')" title="${isPinned ? 'Unpin column' : 'Pin column'}"></span>`;
        html += `</div>`;
        // Bottom row: filter input with apply button
        html += `<div class="header-bottom" onclick="event.stopPropagation()">`;
        html += `<input type="text" class="column-filter" data-column="${escapeHtml(col.name)}" value="${escapeHtml(filterValue)}" placeholder="Filter..." onclick="event.stopPropagation()" onkeydown="onColumnFilterKeydown(event, '${escapeHtml(col.name)}')">`;
        html += `<button class="filter-apply-btn" onclick="event.stopPropagation(); applyColumnFilter('${escapeHtml(col.name)}')" title="Apply filter (Enter)"><span class="codicon codicon-search"></span></button>`;
        html += `</div>`;
        html += `</div>`; // End header-content
        html += `<div class="resize-handle" onmousedown="event.stopPropagation(); startColumnResize(event, '${escapeHtml(col.name)}')"></div>`;
        html += `</th>`;
    }
    html += '</tr></thead><tbody>';

    // Calculate cumulative top offsets for pinned rows
    // Use CSS variable values - header height is 52px (CSS --header-height)
    // With border-collapse, the 1px bottom border is shared with the first row
    // So effective offset is 51px to attach pinned rows directly to header
    // Row: 26px (CSS --row-height), but border-collapse shares the 1px border
    // So effective row offset is 25px to attach pinned rows to each other
    const headerHeight = 51;
    const rowHeight = 25;
    const rowNumWidth = 50;

    // Count pinned rows to calculate offsets
    const pinnedRowsList = [];
    for (let rowIdx = 0; rowIdx < gridData.length; rowIdx++) {
        const rowId = getRowId(gridData[rowIdx], rowIdx);
        if (pinnedRowIds.has(rowId)) {
            pinnedRowsList.push({ rowIdx, rowId, row: gridData[rowIdx] });
        }
    }

    // Calculate top offset for each pinned row
    // All pinned rows stack starting from header height
    // Each subsequent pinned row is offset by the row height
    const pinnedRowOffsets = new Map();
    for (let i = 0; i < pinnedRowsList.length; i++) {
        const topOffset = headerHeight + (i * rowHeight);
        pinnedRowOffsets.set(pinnedRowsList[i].rowId, topOffset);
    }

    // Helper function to render a single row
    function renderRow(rowIdx, row, rowId) {
        const isSelected = selectedRowIds.has(rowId);
        const isRowPinned = pinnedRowIds.has(rowId);
        const topOffset = pinnedRowOffsets.get(rowId);
        const pinnedRowStyle = isRowPinned ? `top:${topOffset}px;` : '';

        let rowHtml = `<tr class="data-row ${isSelected ? 'selected' : ''} ${isRowPinned ? 'pinned' : ''}" style="${pinnedRowStyle}" data-rowid="${rowId}" data-rowidx="${rowIdx}" onclick="onRowClick(event, ${rowId}, ${rowIdx})">`;

        // Row number cell with pin icon - always sticky left
        const rowNumZIndex = isRowPinned ? 8 : 2;
        rowHtml += `<td class="data-cell row-number" style="width:50px;position:sticky;left:0;z-index:${rowNumZIndex};" onclick="onRowNumberClick(event, ${rowId})">`;
        rowHtml += `${currentPageIndex * rowsPerPage + rowIdx + 1}`;
        rowHtml += `<span class="pin-icon codicon codicon-pin ${isRowPinned ? 'pinned' : ''}" onclick="toggleRowPin(event, ${rowId})" title="${isRowPinned ? 'Unpin row' : 'Pin row'}"></span>`;
        rowHtml += `</td>`;

        // Iterate over reordered columns (pinned first, then non-pinned)
        for (let displayColIdx = 0; displayColIdx < orderedColumns.length; displayColIdx++) {
            const col = orderedColumns[displayColIdx];
            const originalColIdx = columnIndexMap.get(col.name);
            const value = getCellValue(row, originalColIdx);
            const displayValue = formatCellValue(value);
            const isNull = value === null || value === undefined;
            const isCellSelected = selectedCells.some(sc => sc.rowIdx === rowIdx && sc.colIdx === originalColIdx);
            const isColPinned = pinnedColumns.has(col.name);
            const leftOffset = pinnedColumnOffsets.get(col.name);
            const pinnedStyle = isColPinned ? `position:sticky;left:${leftOffset}px;` : '';

            // Check if this cell has content that could potentially overflow
            // We add the expand icon to all non-null, non-blob cells
            // The actual visibility is controlled dynamically based on real overflow detection
            const hasContent = !isNull && !(value instanceof Uint8Array);

            // Use originalColIdx for data operations (edit, select) to maintain correct mapping
            // Add position:relative for cells with content to position the expand icon
            const colWidth = columnWidths[col.name] || 120;
            const cellStyle = `width:${colWidth}px;min-width:${colWidth}px;max-width:${colWidth}px;${hasContent ? 'position:relative;' : ''}${pinnedStyle}`;
            rowHtml += `<td class="data-cell ${isNull ? 'null-value' : ''} ${isCellSelected ? 'cell-selected' : ''} ${isColPinned ? 'pinned' : ''}" style="${cellStyle}" data-rowidx="${rowIdx}" data-colidx="${originalColIdx}" onclick="onCellClick(event, ${rowIdx}, ${originalColIdx}, ${rowId})" ondblclick="onCellDoubleClick(event, ${rowIdx}, ${originalColIdx}, ${rowId})">`;
            rowHtml += `<span class="cell-text">${displayValue}</span>`;
            // Add expand icon for all cells with content - visibility controlled by CSS/JS based on overflow
            if (hasContent) {
                rowHtml += `<span class="expand-icon codicon codicon-link-external" onclick="event.stopPropagation(); openCellPreview(${rowIdx}, ${originalColIdx}, ${rowId})" title="View full content"></span>`;
            }
            rowHtml += `</td>`;
        }
        rowHtml += '</tr>';
        return rowHtml;
    }

    // Reorder rows: pinned rows first, then non-pinned rows
    // This ensures pinned rows are always rendered at the top
    const orderedRowIndices = [
        ...gridData.map((row, idx) => ({ idx, rowId: getRowId(row, idx) })).filter(r => pinnedRowIds.has(r.rowId)),
        ...gridData.map((row, idx) => ({ idx, rowId: getRowId(row, idx) })).filter(r => !pinnedRowIds.has(r.rowId))
    ];

    // Render all rows in reordered order (pinned rows first)
    for (const { idx: rowIdx, rowId } of orderedRowIndices) {
        const row = gridData[rowIdx];
        html += renderRow(rowIdx, row, rowId);
    }

    // Show "no results" message when filters are active but no data matches
    if (gridData.length === 0 && hasActiveFilters) {
        const colSpan = orderedColumns.length + 1; // +1 for row number column
        html += `<tr class="no-results-row"><td colspan="${colSpan}" style="text-align:center;padding:20px;color:var(--text-secondary);">No rows match the current filter. Modify or clear filters above.</td></tr>`;
    }

    html += '</tbody></table>';
    container.innerHTML = html;

    // Restore scroll position after rendering to preserve user's view.
    // This is especially important when filtering columns - user expects to stay
    // at the same horizontal scroll position after the table re-renders.
    container.scrollLeft = savedScrollLeft;
    container.scrollTop = savedScrollTop;

    // After rendering, detect which cells have overflow and add the has-overflow class
    updateCellOverflowStates();
}

/**
 * Detect which cells have text overflow and update their has-overflow class.
 * This is called after rendering and after column resize operations.
 * Uses scrollWidth vs clientWidth comparison on the .cell-text span.
 */
function updateCellOverflowStates() {
    // Get all data cells that have a cell-text span (non-null, non-blob cells)
    const cells = document.querySelectorAll('.data-cell');
    for (const cell of cells) {
        const textSpan = cell.querySelector('.cell-text');
        if (!textSpan) {
            // No text span means null or blob value - no overflow possible
            cell.classList.remove('has-overflow');
            continue;
        }

        // Check if text overflows the cell
        // scrollWidth > clientWidth means the text is wider than the visible area
        const hasOverflow = textSpan.scrollWidth > textSpan.clientWidth;
        cell.classList.toggle('has-overflow', hasOverflow);
    }
}

function formatCellValue(value) {
    // Handle null and undefined as NULL display
    if (value === null || value === undefined) return 'NULL';
    if (value instanceof Uint8Array) return '[BLOB]';
    if (typeof value === 'string' && value.length > 100) {
        return escapeHtml(value.substring(0, 100)) + '...';
    }
    return escapeHtml(String(value));
}

// ================================================================
// CELL SELECTION & EDITING
// ================================================================

// Debounce timer for cell click to allow double-click to fire first
let cellClickTimer = null;

/**
 * Handle single click on a data cell - select the cell for copying.
 * Uses debounce to allow double-click (edit) to take precedence.
 */
function onCellClick(event, rowIdx, colIdx, rowId) {
    try {
        event.stopPropagation(); // Prevent row click from firing

        // Ignore clicks during loading, saving, edit transition, OR while editing
        // When a cell is being edited, clicks should only trigger blur on the input
        if (isLoadingData || isSavingCell || isTransitioningEdit || editingCellInfo) return;

        // Get the cell value for selection
        const value = gridData[rowIdx] ? getCellValue(gridData[rowIdx], colIdx) : null;
        const cellInfo = { rowIdx, colIdx, rowId, value };

        // Handle Cmd+Shift+Click (Mac) or Ctrl+Shift+Click (Windows/Linux) for range selection
        // Selects all cells from last selected cell to this one, adding to existing selection
        if ((event.metaKey || event.ctrlKey) && event.shiftKey && lastSelectedCell) {
            // Clear row selection when selecting cells
            selectedRowIds.clear();

            // Calculate range bounds
            const minRow = Math.min(lastSelectedCell.rowIdx, rowIdx);
            const maxRow = Math.max(lastSelectedCell.rowIdx, rowIdx);
            const minCol = Math.min(lastSelectedCell.colIdx, colIdx);
            const maxCol = Math.max(lastSelectedCell.colIdx, colIdx);

            // Add all cells in the range to selection
            for (let r = minRow; r <= maxRow; r++) {
                for (let c = minCol; c <= maxCol; c++) {
                    const rId = gridData[r] ? getRowId(gridData[r], r) : null;
                    const val = gridData[r] ? getCellValue(gridData[r], c) : null;
                    // Check if cell is already selected
                    const existsIdx = selectedCells.findIndex(sc => sc.rowIdx === r && sc.colIdx === c);
                    if (existsIdx === -1) {
                        selectedCells.push({ rowIdx: r, colIdx: c, rowId: rId, value: val });
                    }
                }
            }

            updateCellSelectionUI();
            updateRowSelectionUI();
            updateToolbarButtons();
            return;
        }

        // Handle Shift+Click for range selection (replaces current selection with range)
        if (event.shiftKey && lastSelectedCell) {
            // Clear row selection when selecting cells
            selectedRowIds.clear();

            // Clear current selection and select range
            selectedCells = [];
            selectedColumns.clear(); // Clear column selection when doing range select

            // Calculate range bounds
            const minRow = Math.min(lastSelectedCell.rowIdx, rowIdx);
            const maxRow = Math.max(lastSelectedCell.rowIdx, rowIdx);
            const minCol = Math.min(lastSelectedCell.colIdx, colIdx);
            const maxCol = Math.max(lastSelectedCell.colIdx, colIdx);

            // Add all cells in the range to selection
            for (let r = minRow; r <= maxRow; r++) {
                for (let c = minCol; c <= maxCol; c++) {
                    const rId = gridData[r] ? getRowId(gridData[r], r) : null;
                    const val = gridData[r] ? getCellValue(gridData[r], c) : null;
                    selectedCells.push({ rowIdx: r, colIdx: c, rowId: rId, value: val });
                }
            }

            updateCellSelectionUI();
            updateRowSelectionUI();
            updateToolbarButtons();
            return;
        }

        // Handle Cmd+Click (Mac) or Ctrl+Click (Windows/Linux) for multi-cell selection
        // Toggles individual cell in the selection
        if (event.metaKey || event.ctrlKey) {
            // Clear row selection when selecting cells
            selectedRowIds.clear();

            // Check if this cell is already selected
            const existingIdx = selectedCells.findIndex(
                sc => sc.rowIdx === rowIdx && sc.colIdx === colIdx
            );

            if (existingIdx !== -1) {
                // Already selected - remove from selection
                selectedCells.splice(existingIdx, 1);
            } else {
                // Add to selection
                selectedCells.push(cellInfo);
                lastSelectedCell = cellInfo;
            }

            updateCellSelectionUI();
            updateRowSelectionUI();
            updateToolbarButtons();
            return;
        }

        // Clear any pending cell click timer
        if (cellClickTimer) {
            clearTimeout(cellClickTimer);
            cellClickTimer = null;
        }

        // Delay selection to allow double-click to fire
        cellClickTimer = setTimeout(() => {
            try {
                cellClickTimer = null;

                // Don't select if we're now in editing mode (double-click happened)
                if (editingCellInfo) return;

                // Ignore if state changed during timeout
                if (isLoadingData || isSavingCell || isTransitioningEdit) return;

                // Guard against stale data
                if (!gridData[rowIdx]) return;

                const cellValue = getCellValue(gridData[rowIdx], colIdx);
                const cell = { rowIdx, colIdx, rowId, value: cellValue };

                // Check if clicking on the only selected cell - deselect it
                if (selectedCells.length === 1 &&
                    selectedCells[0].rowIdx === rowIdx &&
                    selectedCells[0].colIdx === colIdx) {
                    selectedCells = [];
                    lastSelectedCell = null;
                    selectedColumns.clear(); // Clear column selection
                } else {
                    // Single click - select only this cell (clear previous selection)
                    selectedCells = [cell];
                    lastSelectedCell = cell;
                    // Clear row selection when selecting a cell
                    selectedRowIds.clear();
                    selectedColumns.clear(); // Clear column selection
                }

                // Update UI efficiently
                updateCellSelectionUI();
                updateRowSelectionUI();
                updateToolbarButtons();
            } catch (err) {
                console.error('Error in cell click timeout:', err);
            }
        }, 80);
    } catch (err) {
        console.error('Error in onCellClick:', err);
    }
}

/**
 * Update cell selection UI without full re-render.
 * Supports multi-cell selection.
 * Optimized for performance with large selections.
 */
function updateCellSelectionUI() {
    // Build a Set of selected cell keys for O(1) lookup
    const selectedSet = new Set();
    const selectedByColumn = new Map();
    for (const sc of selectedCells) {
        selectedSet.add(`${sc.rowIdx},${sc.colIdx}`);
        // Count cells per column for header highlighting
        selectedByColumn.set(sc.colIdx, (selectedByColumn.get(sc.colIdx) || 0) + 1);
    }

    // Update all data cells in one pass
    const allDataCells = document.querySelectorAll('.data-cell[data-rowidx]');
    for (const cell of allDataCells) {
        const rowIdx = cell.dataset.rowidx;
        const colIdx = cell.dataset.colidx;
        const key = `${rowIdx},${colIdx}`;
        if (selectedSet.has(key)) {
            cell.classList.add('cell-selected');
        } else {
            cell.classList.remove('cell-selected');
        }
    }

    // Update column headers - highlight if entire column is selected
    const allHeaders = document.querySelectorAll('.header-cell[data-column]');
    for (const header of allHeaders) {
        const colName = header.dataset.column;
        const colIdx = tableColumns.findIndex(c => c.name === colName);
        const count = selectedByColumn.get(colIdx) || 0;
        if (gridData.length > 0 && count === gridData.length) {
            header.classList.add('column-selected');
        } else {
            header.classList.remove('column-selected');
        }
    }
}

async function onCellDoubleClick(event, rowIdx, colIdx, rowId) {
    // Wrap entire function in try-catch to prevent UI from breaking
    try {
        event.stopPropagation();
        event.preventDefault(); // Prevent text selection on rapid clicks

        // CRITICAL: If we're already editing a cell, ignore double-clicks entirely
        // This prevents issues when clicking on cell borders while the text cursor is active
        // The only way to exit edit mode should be Enter, Escape, or blur (click outside)
        if (editingCellInfo) {
            return;
        }

        // CRITICAL: Set transition guard IMMEDIATELY at entry point
        // This must be the FIRST check to prevent border-click race conditions
        // where multiple cells fire events simultaneously
        if (isTransitioningEdit) {
            return;
        }
        // Lock immediately - before ANY other checks
        isTransitioningEdit = true;

        // Clear any existing failsafe timeout
        if (transitionLockTimeout) {
            clearTimeout(transitionLockTimeout);
        }
        // Set failsafe timeout - if lock is held for more than 500ms, force release
        // This prevents the UI from getting stuck if something goes wrong
        transitionLockTimeout = setTimeout(() => {
            if (isTransitioningEdit) {
                console.warn('Transition lock was stuck - force releasing');
                isTransitioningEdit = false;
            }
            transitionLockTimeout = null;
        }, 500);

        // Helper to release lock safely
        const releaseLock = (delay = 50) => {
            if (transitionLockTimeout) {
                clearTimeout(transitionLockTimeout);
                transitionLockTimeout = null;
            }
            setTimeout(() => { isTransitioningEdit = false; }, delay);
        };

        // Debounce rapid double-clicks (300ms minimum between double-clicks)
        const now = Date.now();
        if (now - lastDoubleClickTime < 300) {
            releaseLock();
            return;
        }
        lastDoubleClickTime = now;

        // Prevent interactions during save or load operations
        if (isSavingCell || isLoadingData) {
            releaseLock();
            return;
        }

        // Cancel any pending cell click timer since we're handling a double-click
        if (cellClickTimer) {
            clearTimeout(cellClickTimer);
            cellClickTimer = null;
        }

        // Cancel any pending row click since we're handling a double-click
        if (rowClickTimer) {
            clearTimeout(rowClickTimer);
            rowClickTimer = null;
        }

        // Only allow editing for tables, not views
        // Views in SQLite are read-only unless they have INSTEAD OF triggers
        if (selectedTableType !== 'table') {
            updateStatus('Views are read-only');
            releaseLock();
            return;
        }

        // Clear any existing cell selection when entering edit mode
        // Must also update UI to remove the visual selection class
        selectedCells = [];
        lastSelectedCell = null;
        selectedRowIds.clear();
        selectedColumns.clear(); // Clear column selection
        updateCellSelectionUI();
        updateRowSelectionUI();

        // Use closest() to ensure we get the <td> cell, not a child element
        // This is important because event.target could be an inner element
        const cell = event.target.closest('td.data-cell');
        if (!cell) {
            releaseLock();
            return;
        }

        // Validate cell matches expected indices (prevents wrong cell from border clicks)
        const cellRowIdx = parseInt(cell.dataset.rowidx, 10);
        const cellColIdx = parseInt(cell.dataset.colidx, 10);
        if (isNaN(cellRowIdx) || isNaN(cellColIdx) || cellRowIdx !== rowIdx || cellColIdx !== colIdx) {
            // Click landed on a different cell than expected - abort
            console.warn('Cell mismatch: expected', rowIdx, colIdx, 'got', cellRowIdx, cellColIdx);
            releaseLock();
            return;
        }

        const column = tableColumns[colIdx];
        if (!column) {
            releaseLock();
            return;
        }

        // Verify gridData still has this row (it might have been re-rendered)
        if (!gridData[rowIdx]) {
            releaseLock();
            return;
        }

        const currentValue = getCellValue(gridData[rowIdx], colIdx);

        // Store the editing state: row index, column index, row ID, column name, and original value
        editingCellInfo = { rowIdx, colIdx, rowId, columnName: column.name, originalValue: currentValue };

        // Remove cell-selected class if present (in case UI update didn't catch it)
        cell.classList.remove('cell-selected');

        // Add editing class to cell for styling (removes padding, adds border)
        cell.classList.add('editing');

        // Create inline input element with the current value
        // Null values are displayed as empty string for editing
        cell.innerHTML = `<input type="text" class="cell-input" value="${currentValue === null ? '' : escapeHtml(String(currentValue))}">`;

        activeCellInput = cell.querySelector('input');

        // Guard against input creation failure
        if (!activeCellInput) {
            console.error('Failed to create cell input');
            editingCellInfo = null;
            cell.classList.remove('editing');
            releaseLock();
            return;
        }

        activeCellInput.focus();
        activeCellInput.select();

        activeCellInput.addEventListener('keydown', onCellInputKeydown);
        activeCellInput.addEventListener('blur', onCellInputBlur);

        // Clear failsafe timeout since we completed successfully
        if (transitionLockTimeout) {
            clearTimeout(transitionLockTimeout);
            transitionLockTimeout = null;
        }
        // Release lock after a short delay to ensure input is ready
        setTimeout(() => { isTransitioningEdit = false; }, 100);

    } catch (err) {
        // Catch any uncaught exceptions to prevent UI from breaking
        console.error('Error in onCellDoubleClick:', err);
        // Reset all state to recover
        isTransitioningEdit = false;
        isSavingCell = false;
        if (transitionLockTimeout) {
            clearTimeout(transitionLockTimeout);
            transitionLockTimeout = null;
        }
        cleanupCellEdit();
        updateStatus('Error: ' + (err.message || String(err)));
    }
}

/**
 * Handle keyboard events in the cell input.
 * - Enter: Save the edit
 * - Escape: Cancel the edit
 */
function onCellInputKeydown(event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        saveCellEdit();
    } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelCellEdit();
    }
}

/**
 * Handle blur event on the cell input.
 * Auto-saves when clicking outside the cell.
 * Uses setTimeout to allow for click events on other elements.
 */
function onCellInputBlur() {
    setTimeout(() => {
        if (editingCellInfo) {
            saveCellEdit();
        }
    }, 100);
}

/**
 * Save the current cell edit to the database.
 *
 * Flow:
 * 1. Validate that editing is in progress
 * 2. Check if the value actually changed
 * 3. Convert the value to proper SQL syntax (NULL, number, or quoted string)
 * 4. Execute UPDATE query via RPC
 * 5. Fire edit event for undo/redo and dirty state tracking
 * 6. Refresh the grid to show the updated value
 */
async function saveCellEdit() {
    // Guard against concurrent save operations (spam clicking protection)
    if (isSavingCell) return;
    if (!editingCellInfo || !activeCellInput) return;

    const { rowIdx, colIdx, rowId, columnName, originalValue } = editingCellInfo;
    const newValue = activeCellInput.value;

    // Compare values - convert both to strings for comparison
    // Null is treated as empty string for comparison purposes
    const origStr = originalValue === null ? '' : String(originalValue);
    if (newValue === origStr) {
        // No change, just cancel the edit
        cancelCellEdit();
        return;
    }

    // Determine the SQL value representation:
    // - Empty string on NOT NULL column becomes empty string (not NULL)
    // - Empty string on nullable column becomes NULL
    // - Numeric strings are inserted as numbers (no quotes)
    // - Everything else is a quoted string with single quotes escaped
    const column = tableColumns[colIdx];
    const isNotNull = column && column.notnull === 1;

    let sqlValue;
    if (newValue === '') {
        if (isNotNull) {
            // NOT NULL column - use empty string
            sqlValue = "''";
        } else {
            // Nullable column - use NULL
            sqlValue = 'NULL';
        }
    } else if (!isNaN(Number(newValue)) && newValue.trim() !== '') {
        // Numeric value - insert as number without quotes
        sqlValue = newValue;
    } else {
        // String value - escape single quotes by doubling them (SQL standard)
        sqlValue = `'${newValue.replace(/'/g, "''")}'`;
    }

    // Build UPDATE query using rowid for precise row identification
    // Column and table names are quoted to handle special characters/reserved words
    const updateSql = `UPDATE "${selectedTable}" SET "${columnName}" = ${sqlValue} WHERE rowid = ${rowId}`;

    try {
        // Set saving flag to prevent concurrent operations
        isSavingCell = true;
        updateStatus('Saving...');

        // Execute the UPDATE query via RPC to the extension host
        await backendApi.exec(updateSql);

        // Compute the typed new value for storage
        // Empty string becomes null for nullable columns, empty string for NOT NULL columns
        const typedNewValue = newValue === '' ? (isNotNull ? '' : null) :
            (!isNaN(Number(newValue)) && newValue.trim() !== '' ? Number(newValue) : newValue);

        // Fire edit event to:
        // 1. Mark the document as dirty (enables Ctrl+S save)
        // 2. Track the modification for undo/redo
        await backendApi.fireEditEvent({
            label: `Edit ${columnName}`,
            description: `Edit ${columnName}`,
            modificationType: 'cell_update',
            targetTable: selectedTable,
            targetRowId: rowId,
            targetColumn: columnName,
            previousValue: originalValue,
            newValue: typedNewValue
        });

        // Update local grid data optimistically
        // Convert the value to the appropriate type for local display
        gridData[rowIdx][colIdx + getRowDataOffset()] = typedNewValue;

        // Clean up editing state and refresh the view
        cleanupCellEdit();
        await loadTableData();

        // Update status - changes are saved immediately for native engine
        updateStatus('Saved');

    } catch (err) {
        // On error, log to console and show status, but keep the cell in edit mode
        // so the user can correct the value or press Escape to cancel
        console.error('Save failed:', err);

        // Parse and format error message for better user experience
        let errorMessage = err.message || String(err);

        // Handle common SQLite constraint errors with friendlier messages
        if (errorMessage.includes('FOREIGN KEY constraint failed')) {
            errorMessage = 'Foreign key constraint: the value must reference an existing record in the related table';
        } else if (errorMessage.includes('UNIQUE constraint failed')) {
            errorMessage = 'Unique constraint: this value already exists in the column';
        } else if (errorMessage.includes('NOT NULL constraint failed')) {
            errorMessage = 'Not null constraint: this column cannot be empty';
        } else if (errorMessage.includes('CHECK constraint failed')) {
            errorMessage = 'Check constraint: the value does not satisfy the column requirements';
        }

        updateStatus(`Save failed: ${errorMessage}`);
        // Don't cleanup - let user retry or cancel
    } finally {
        // Always clear the saving flag
        isSavingCell = false;
    }
}

/**
 * Cancel the current cell edit without saving.
 * Restores the original value by re-rendering the grid.
 */
function cancelCellEdit() {
    cleanupCellEdit();
    renderDataGrid(); // Re-render to restore original value
}

/**
 * Clean up cell editing state.
 * Removes event listeners and resets editing variables.
 */
function cleanupCellEdit() {
    if (activeCellInput) {
        // Remove event listeners to prevent memory leaks
        activeCellInput.removeEventListener('keydown', onCellInputKeydown);
        activeCellInput.removeEventListener('blur', onCellInputBlur);
        activeCellInput = null;
    }
    editingCellInfo = null;
}

// ================================================================
// CELL PREVIEW/EDIT MODAL
// Floating window for viewing and editing large cell values
// ================================================================

/**
 * Open the cell preview modal for a cell with truncated content.
 * This allows viewing and editing the full value in a larger textarea.
 * @param {number} rowIdx - The row index in gridData
 * @param {number} colIdx - The column index
 * @param {number|string} rowId - The row identifier (rowid for tables, synthetic for views)
 */
function openCellPreview(rowIdx, colIdx, rowId) {
    // Cancel any ongoing inline cell edit first
    if (editingCellInfo) {
        cancelCellEdit();
    }

    const column = tableColumns[colIdx];
    if (!column) return;

    const row = gridData[rowIdx];
    if (!row) return;

    const value = getCellValue(row, colIdx);

    // Store preview state for save operation
    cellPreviewInfo = {
        rowIdx,
        colIdx,
        rowId,
        columnName: column.name,
        originalValue: value
    };

    // Populate the modal UI
    const modal = document.getElementById('cellPreviewModal');
    const columnNameEl = document.getElementById('cellPreviewColumnName');
    const typeBadgeEl = document.getElementById('cellPreviewTypeBadge');
    const textarea = document.getElementById('cellPreviewTextarea');
    const charCountEl = document.getElementById('cellPreviewCharCount');
    const readonlyBadgeEl = document.getElementById('cellPreviewReadonlyBadge');
    const saveBtnEl = document.getElementById('cellPreviewSaveBtn');
    const wrapBtnEl = document.getElementById('wrapTextBtn');

    // Set column name and type
    columnNameEl.textContent = column.name;
    typeBadgeEl.textContent = column.type || 'TEXT';

    // Convert value to string for display
    // Handle BLOB values specially
    let displayValue = '';
    if (value === null || value === undefined) {
        displayValue = '';
    } else if (value instanceof Uint8Array) {
        // For BLOB data, show hex representation
        displayValue = '[BLOB: ' + Array.from(value).map(b => b.toString(16).padStart(2, '0')).join(' ') + ']';
    } else {
        displayValue = String(value);
    }

    textarea.value = displayValue;

    // Set readonly state for views
    const isReadonly = selectedTableType !== 'table';
    textarea.readOnly = isReadonly;
    textarea.classList.toggle('readonly', isReadonly);
    readonlyBadgeEl.style.display = isReadonly ? 'inline' : 'none';
    saveBtnEl.disabled = isReadonly;
    saveBtnEl.style.display = isReadonly ? 'none' : 'inline-block';

    // Update character count
    updateCellPreviewCharCount();

    // Apply word wrap setting
    textarea.style.whiteSpace = cellPreviewWrapEnabled ? 'pre-wrap' : 'pre';
    textarea.style.overflowX = cellPreviewWrapEnabled ? 'hidden' : 'auto';
    wrapBtnEl.classList.toggle('active', cellPreviewWrapEnabled);

    // Show the modal
    modal.classList.remove('hidden');

    // Focus the textarea
    textarea.focus();

    // Add keyboard listener for Escape to close
    textarea.addEventListener('keydown', onCellPreviewKeydown);
}

/**
 * Handle keydown events in the cell preview textarea.
 * Escape closes the modal, Ctrl+Enter saves.
 */
function onCellPreviewKeydown(event) {
    if (event.key === 'Escape') {
        event.preventDefault();
        closeCellPreview();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        // Ctrl+Enter or Cmd+Enter to save
        event.preventDefault();
        saveCellPreview();
    }
}

/**
 * Update the character count display in the cell preview modal.
 */
function updateCellPreviewCharCount() {
    const textarea = document.getElementById('cellPreviewTextarea');
    const charCountEl = document.getElementById('cellPreviewCharCount');
    const len = textarea.value.length;
    charCountEl.textContent = `${len.toLocaleString()} character${len !== 1 ? 's' : ''}`;
}

/**
 * Close the cell preview modal without saving.
 */
function closeCellPreview() {
    const modal = document.getElementById('cellPreviewModal');
    const textarea = document.getElementById('cellPreviewTextarea');

    // Remove keydown listener
    textarea.removeEventListener('keydown', onCellPreviewKeydown);

    // Hide the modal
    modal.classList.add('hidden');

    // Clear the preview state
    cellPreviewInfo = null;
}

/**
 * Save the edited value from the cell preview modal.
 * Uses the same logic as saveCellEdit but with the textarea value.
 */
async function saveCellPreview() {
    if (!cellPreviewInfo) return;
    if (selectedTableType !== 'table') {
        updateStatus('Views are read-only');
        return;
    }

    const { rowIdx, colIdx, rowId, columnName, originalValue } = cellPreviewInfo;
    const textarea = document.getElementById('cellPreviewTextarea');
    const newValue = textarea.value;

    // Compare values - convert both to strings for comparison
    const origStr = originalValue === null ? '' : String(originalValue);
    if (newValue === origStr) {
        // No change, just close
        closeCellPreview();
        return;
    }

    // Determine the SQL value representation
    const column = tableColumns[colIdx];
    const isNotNull = column && column.notnull === 1;

    let sqlValue;
    if (newValue === '') {
        if (isNotNull) {
            sqlValue = "''";
        } else {
            sqlValue = 'NULL';
        }
    } else if (!isNaN(Number(newValue)) && newValue.trim() !== '') {
        sqlValue = newValue;
    } else {
        sqlValue = `'${newValue.replace(/'/g, "''")}'`;
    }

    const updateSql = `UPDATE "${selectedTable}" SET "${columnName}" = ${sqlValue} WHERE rowid = ${rowId}`;

    try {
        updateStatus('Saving...');

        await backendApi.exec(updateSql);

        // Compute the typed new value for storage
        const typedNewValue = newValue === '' ? (isNotNull ? '' : null) :
            (!isNaN(Number(newValue)) && newValue.trim() !== '' ? Number(newValue) : newValue);

        // Fire edit event for undo/redo and dirty state tracking
        await backendApi.fireEditEvent({
            label: `Edit ${columnName}`,
            description: `Edit ${columnName}`,
            modificationType: 'cell_update',
            targetTable: selectedTable,
            targetRowId: rowId,
            targetColumn: columnName,
            previousValue: originalValue,
            newValue: typedNewValue
        });

        // Update local grid data
        gridData[rowIdx][colIdx + getRowDataOffset()] = typedNewValue;

        // Close the modal and refresh
        closeCellPreview();
        await loadTableData();

        updateStatus('Saved');
    } catch (err) {
        console.error('Save failed:', err);
        let errorMessage = err.message || String(err);

        if (errorMessage.includes('FOREIGN KEY constraint failed')) {
            errorMessage = 'Foreign key constraint: the value must reference an existing record in the related table';
        } else if (errorMessage.includes('UNIQUE constraint failed')) {
            errorMessage = 'Unique constraint: this value already exists in the column';
        } else if (errorMessage.includes('NOT NULL constraint failed')) {
            errorMessage = 'Not null constraint: this column cannot be empty';
        } else if (errorMessage.includes('CHECK constraint failed')) {
            errorMessage = 'Check constraint: the value does not satisfy the column requirements';
        }

        updateStatus(`Save failed: ${errorMessage}`);
    }
}

/**
 * Format the cell preview textarea content as pretty-printed JSON.
 * Only works if the content is valid JSON.
 */
function formatCellPreviewJson() {
    const textarea = document.getElementById('cellPreviewTextarea');
    try {
        const parsed = JSON.parse(textarea.value);
        textarea.value = JSON.stringify(parsed, null, 2);
        updateCellPreviewCharCount();
    } catch (e) {
        updateStatus('Content is not valid JSON');
    }
}

/**
 * Compact the cell preview textarea content as minified JSON.
 * Only works if the content is valid JSON.
 */
function compactCellPreviewJson() {
    const textarea = document.getElementById('cellPreviewTextarea');
    try {
        const parsed = JSON.parse(textarea.value);
        textarea.value = JSON.stringify(parsed);
        updateCellPreviewCharCount();
    } catch (e) {
        updateStatus('Content is not valid JSON');
    }
}

/**
 * Toggle word wrap in the cell preview textarea.
 */
function toggleCellPreviewWrap() {
    cellPreviewWrapEnabled = !cellPreviewWrapEnabled;
    const textarea = document.getElementById('cellPreviewTextarea');
    const wrapBtnEl = document.getElementById('wrapTextBtn');

    textarea.style.whiteSpace = cellPreviewWrapEnabled ? 'pre-wrap' : 'pre';
    textarea.style.overflowX = cellPreviewWrapEnabled ? 'hidden' : 'auto';
    wrapBtnEl.classList.toggle('active', cellPreviewWrapEnabled);
}

// Add input event listener for character count updates
document.addEventListener('DOMContentLoaded', () => {
    const textarea = document.getElementById('cellPreviewTextarea');
    if (textarea) {
        textarea.addEventListener('input', updateCellPreviewCharCount);
    }
});

// ================================================================
// ROW SELECTION
// ================================================================

// Debounce timer for row click to allow double-click to fire first
let rowClickTimer = null;

/**
 * Handle click on row number cell - immediate selection without debounce.
 * Row numbers are not editable, so no need to wait for double-click.
 * Clicking on a selected row deselects it (toggle behavior).
 */
function onRowNumberClick(event, rowId) {
    event.stopPropagation(); // Prevent triggering onRowClick on the parent row

    // Clear any pending row click timer
    if (rowClickTimer) {
        clearTimeout(rowClickTimer);
        rowClickTimer = null;
    }

    // Clear cell selection when selecting rows
    selectedCells = [];
    lastSelectedCell = null;
    selectedColumns.clear(); // Clear column selection
    updateCellSelectionUI();

    // Handle selection immediately (no debounce)
    if (event.ctrlKey || event.metaKey) {
        // Toggle selection with Ctrl/Cmd click
        if (selectedRowIds.has(rowId)) {
            selectedRowIds.delete(rowId);
        } else {
            selectedRowIds.add(rowId);
        }
    } else {
        // Single click - toggle behavior
        if (selectedRowIds.has(rowId)) {
            // Already selected - deselect it
            selectedRowIds.delete(rowId);
        } else {
            // Not selected - select only this row
            selectedRowIds.clear();
            selectedRowIds.add(rowId);
        }
    }

    // Update UI efficiently without full re-render
    updateRowSelectionUI();
    updateToolbarButtons();
}

function onRowClick(event, rowId, rowIdx) {
    // Clear any pending click timer
    if (rowClickTimer) {
        clearTimeout(rowClickTimer);
        rowClickTimer = null;
    }

    // Delay the click processing to allow double-click to fire
    // Double-click events fire after ~300ms of the second click
    rowClickTimer = setTimeout(() => {
        rowClickTimer = null;

        // Don't process if we're now in editing mode (double-click happened)
        if (editingCellInfo) return;

        if (event.ctrlKey || event.metaKey) {
            if (selectedRowIds.has(rowId)) {
                selectedRowIds.delete(rowId);
            } else {
                selectedRowIds.add(rowId);
            }
        } else {
            selectedRowIds.clear();
            selectedRowIds.add(rowId);
        }

        renderDataGrid();
        updateToolbarButtons();
    }, 80); // Short delay to allow double-click detection
}

// ================================================================
// COLUMN RESIZING
// ================================================================

/**
 * Start resizing a column when user mousedowns on resize handle.
 */
function startColumnResize(event, columnName) {
    event.stopPropagation(); // Prevent sorting when clicking resize handle
    event.preventDefault();

    resizingColumn = columnName;
    resizeStartX = event.clientX;

    // Get current column width
    const headerCell = document.querySelector(`th[data-column="${columnName}"]`);
    resizeStartWidth = headerCell ? headerCell.offsetWidth : 150;

    // Add resizing class to handle
    const handle = event.target;
    handle.classList.add('resizing');

    // Add document-level event listeners for drag
    document.addEventListener('mousemove', onColumnResize);
    document.addEventListener('mouseup', stopColumnResize);

    // Prevent text selection during resize
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
}

/**
 * Handle mousemove during column resize.
 * Updates both header and data cells in the column for proper visual feedback.
 */
function onColumnResize(event) {
    if (!resizingColumn) return;

    const deltaX = event.clientX - resizeStartX;
    const newWidth = Math.max(30, resizeStartWidth + deltaX); // Minimum 30px for fully customizable widths

    // Update the column width in state
    columnWidths[resizingColumn] = newWidth;

    // Find the column index for this column name
    const colIdx = tableColumns.findIndex(c => c.name === resizingColumn);
    if (colIdx === -1) return;

    // Update the header cell width directly for smooth resizing
    // Must update min-width and max-width too since they constrain the column
    const headerCell = document.querySelector(`th[data-column="${resizingColumn}"]`);
    if (headerCell) {
        headerCell.style.width = `${newWidth}px`;
        headerCell.style.minWidth = `${newWidth}px`;
        headerCell.style.maxWidth = `${newWidth}px`;
    }

    // Update all data cells in this column for consistent width
    // Data cells are at colIdx + 1 (accounting for row number column)
    // Must update all three width properties for proper resizing
    const dataCells = document.querySelectorAll(`.data-row td:nth-child(${colIdx + 2})`);
    for (const cell of dataCells) {
        cell.style.width = `${newWidth}px`;
        cell.style.minWidth = `${newWidth}px`;
        cell.style.maxWidth = `${newWidth}px`;
    }
}

/**
 * Stop column resize on mouseup.
 */
function stopColumnResize() {
    if (!resizingColumn) return;

    // Remove resizing class from handle
    const handle = document.querySelector('.resize-handle.resizing');
    if (handle) {
        handle.classList.remove('resizing');
    }

    // Clean up
    resizingColumn = null;
    document.removeEventListener('mousemove', onColumnResize);
    document.removeEventListener('mouseup', stopColumnResize);

    // Restore selection and cursor
    document.body.style.userSelect = '';
    document.body.style.cursor = '';

    // Update overflow states after resize - some cells may now overflow or fit
    updateCellOverflowStates();
}

// ================================================================
// SORTING & FILTERING
// ================================================================
function onColumnSort(columnName) {
    if (sortedColumn === columnName) {
        sortAscending = !sortAscending;
    } else {
        sortedColumn = columnName;
        sortAscending = true;
    }
    loadTableData();
}

/**
 * Handle click on column header to select all cells in the column.
 * - Click: Toggle column selection (select if not selected, deselect if already selected)
 * - Cmd/Ctrl+Click: Add/remove column cells from existing selection
 */
function onColumnHeaderClick(event, columnName) {
    event.stopPropagation();

    // Find the column index
    const colIdx = tableColumns.findIndex(c => c.name === columnName);
    if (colIdx === -1) return;

    // Clear row selection when selecting cells
    selectedRowIds.clear();

    // Check if entire column is already selected
    const columnCellCount = gridData.length;
    let selectedInColumn = 0;
    for (const sc of selectedCells) {
        if (sc.colIdx === colIdx) selectedInColumn++;
    }
    const isColumnFullySelected = columnCellCount > 0 && selectedInColumn === columnCellCount;

    // Handle Cmd+Click (Mac) or Ctrl+Click (Windows/Linux) to toggle column in selection
    if (event.metaKey || event.ctrlKey) {
        if (isColumnFullySelected) {
            // Remove this column's cells from selection
            selectedCells = selectedCells.filter(sc => sc.colIdx !== colIdx);
            // Remove from selectedColumns tracking
            selectedColumns.delete(columnName);
        } else {
            // Add all cells in this column to the selection
            for (let rowIdx = 0; rowIdx < gridData.length; rowIdx++) {
                const rowId = getRowId(gridData[rowIdx], rowIdx);
                const value = getCellValue(gridData[rowIdx], colIdx);
                // Check if already selected
                const exists = selectedCells.some(sc => sc.rowIdx === rowIdx && sc.colIdx === colIdx);
                if (!exists) {
                    selectedCells.push({ rowIdx, colIdx, rowId, value });
                }
            }
            // Track this column as fully selected
            selectedColumns.add(columnName);
            // Update last selected for shift+click
            if (gridData.length > 0) {
                lastSelectedCell = { rowIdx: 0, colIdx, rowId: getRowId(gridData[0], 0), value: getCellValue(gridData[0], colIdx) };
            }
        }
    } else {
        // Single click - toggle behavior
        if (isColumnFullySelected) {
            // Deselect - clear selection
            selectedCells = [];
            lastSelectedCell = null;
            selectedColumns.clear();
        } else {
            // Select only this column's cells
            selectedCells = [];
            selectedColumns.clear();
            for (let rowIdx = 0; rowIdx < gridData.length; rowIdx++) {
                const rowId = getRowId(gridData[rowIdx], rowIdx);
                const value = getCellValue(gridData[rowIdx], colIdx);
                selectedCells.push({ rowIdx, colIdx, rowId, value });
            }
            // Track this column as fully selected
            selectedColumns.add(columnName);
            // Update last selected for shift+click
            if (gridData.length > 0) {
                lastSelectedCell = { rowIdx: 0, colIdx, rowId: getRowId(gridData[0], 0), value: getCellValue(gridData[0], colIdx) };
            }
        }
    }

    updateCellSelectionUI();
    updateRowSelectionUI();
    updateToolbarButtons();
}

function onFilterChange() {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
        filterQuery = document.getElementById('filterInput').value.trim();
        currentPageIndex = 0;
        loadTableData();
    }, 300);
}

/**
 * Handle keydown in per-column filter input.
 * Applies filter on Enter key press.
 */
function onColumnFilterKeydown(event, columnName) {
    if (event.key === 'Enter') {
        event.preventDefault();
        applyColumnFilter(columnName);
    }
}

/**
 * Apply the column filter for a specific column.
 * Called when user presses Enter or clicks the apply button.
 */
function applyColumnFilter(columnName) {
    const input = document.querySelector(`.column-filter[data-column="${columnName}"]`);
    if (input) {
        columnFilters[columnName] = input.value.trim();
        currentPageIndex = 0;
        loadTableData();
    }
}

// ================================================================
// PIN FUNCTIONALITY
// ================================================================

/**
 * Toggle pin state for a column.
 * Pinned columns stick to the left when scrolling horizontally.
 */
function toggleColumnPin(event, columnName) {
    event.stopPropagation(); // Prevent sorting

    if (pinnedColumns.has(columnName)) {
        pinnedColumns.delete(columnName);
    } else {
        pinnedColumns.add(columnName);
    }

    renderDataGrid();
}

/**
 * Toggle pin state for a row.
 * Pinned rows stick to the top when scrolling vertically.
 */
function toggleRowPin(event, rowId) {
    event.stopPropagation(); // Prevent row selection

    if (pinnedRowIds.has(rowId)) {
        pinnedRowIds.delete(rowId);
    } else {
        pinnedRowIds.add(rowId);
    }

    renderDataGrid();
}

// ================================================================
// PAGINATION
// ================================================================
function updatePagination() {
    document.getElementById('pageIndicator').textContent = `${currentPageIndex + 1} / ${totalPageCount}`;

    document.getElementById('btnFirst').disabled = currentPageIndex === 0;
    document.getElementById('btnPrev').disabled = currentPageIndex === 0;
    document.getElementById('btnNext').disabled = currentPageIndex >= totalPageCount - 1;
    document.getElementById('btnLast').disabled = currentPageIndex >= totalPageCount - 1;
}

function goToPage(page) {
    if (page < 0 || page >= totalPageCount) return;
    currentPageIndex = page;
    loadTableData();
}

function onPageSizeChange() {
    rowsPerPage = parseInt(document.getElementById('pageSizeSelect').value, 10);
    currentPageIndex = 0;
    loadTableData();
}

// ================================================================
// CRUD OPERATIONS
// ================================================================
function openAddRowModal() {
    if (!selectedTable || selectedTableType !== 'table') return;

    const form = document.getElementById('addRowForm');
    // Mark NOT NULL columns as required (notnull is index 3 in PRAGMA table_info)
    form.innerHTML = tableColumns.map(col => {
        const isRequired = col.notnull === 1 && !col.isPrimaryKey;
        const requiredLabel = isRequired ? ' <span style="color: var(--error-color)">*</span>' : '';
        return `
        <div class="form-field">
            <label>${escapeHtml(col.name)}${requiredLabel} <span style="opacity:0.5">(${col.type})</span></label>
            <input type="text" data-column="${escapeHtml(col.name)}" data-required="${isRequired}" placeholder="${col.isPrimaryKey ? 'Auto (Primary Key)' : (isRequired ? 'Required' : 'NULL')}" ${col.isPrimaryKey ? 'disabled' : ''}>
        </div>
    `}).join('');

    openModal('addRowModal');
}

async function submitAddRow() {
    const inputs = document.querySelectorAll('#addRowForm input[data-column]:not([disabled])');
    const colNames = [];
    const colValues = [];
    const missingRequired = [];

    // First pass: validate required fields
    for (const input of inputs) {
        const colName = input.dataset.column;
        const value = input.value.trim();
        const isRequired = input.dataset.required === 'true';

        if (isRequired && (value === '' || value.toLowerCase() === 'null')) {
            missingRequired.push(colName);
            input.style.borderColor = 'var(--error-color)';
        } else {
            input.style.borderColor = '';
        }
    }

    if (missingRequired.length > 0) {
        updateStatus(`Required fields missing: ${missingRequired.join(', ')}`);
        return;
    }

    // Second pass: build SQL
    for (const input of inputs) {
        const colName = input.dataset.column;
        const value = input.value.trim();

        if (value !== '') {
            colNames.push(`"${colName}"`);
            if (value.toLowerCase() === 'null') {
                colValues.push('NULL');
            } else if (!isNaN(Number(value)) && value !== '') {
                colValues.push(value);
            } else {
                colValues.push(`'${value.replace(/'/g, "''")}'`);
            }
        }
    }

    let sql;
    if (colNames.length === 0) {
        sql = `INSERT INTO "${selectedTable}" DEFAULT VALUES`;
    } else {
        sql = `INSERT INTO "${selectedTable}" (${colNames.join(', ')}) VALUES (${colValues.join(', ')})`;
    }

    try {
        updateStatus('Inserting row...');
        await backendApi.exec(sql);
        await backendApi.fireEditEvent({
            description: `Insert row into ${selectedTable}`,
            operation: 'add',
            targetTable: selectedTable,
            queryText: sql
        });

        closeModal('addRowModal');
        await loadTableData();
        updateStatus('Row inserted - Ctrl+S to save');

    } catch (err) {
        console.error('Insert failed:', err);
        updateStatus(`Error: ${err.message}`);
    }
}

function openDeleteModal() {
    // Check if we're deleting columns or rows
    if (selectedColumns.size > 0) {
        // Deleting columns
        const columnNames = Array.from(selectedColumns);
        document.getElementById('deleteConfirmText').textContent =
            `Are you sure you want to delete ${columnNames.length} column${columnNames.length > 1 ? 's' : ''} (${columnNames.join(', ')})?` +
            ` This will permanently remove the column${columnNames.length > 1 ? 's' : ''} and all their data.`;
    } else if (selectedRowIds.size > 0) {
        // Deleting rows
        document.getElementById('deleteConfirmText').textContent =
            `Are you sure you want to delete ${selectedRowIds.size} row${selectedRowIds.size > 1 ? 's' : ''}?`;
    } else {
        return; // Nothing selected
    }

    openModal('deleteModal');
}

async function submitDelete() {
    // Check if we're deleting columns or rows
    if (selectedColumns.size > 0) {
        await submitDeleteColumns();
    } else if (selectedRowIds.size > 0) {
        await submitDeleteRows();
    }
}

/**
 * Delete selected rows from the table.
 * Executes DELETE SQL statement for each selected rowid.
 */
async function submitDeleteRows() {
    if (selectedRowIds.size === 0) return;

    const rowIds = Array.from(selectedRowIds);
    const sql = `DELETE FROM "${selectedTable}" WHERE rowid IN (${rowIds.join(', ')})`;

    try {
        updateStatus('Deleting rows...');
        await backendApi.exec(sql);
        await backendApi.fireEditEvent({
            description: `Delete ${rowIds.length} row${rowIds.length > 1 ? 's' : ''} from ${selectedTable}`,
            operation: 'remove',
            targetTable: selectedTable,
            affectedRecords: rowIds,
            queryText: sql
        });

        closeModal('deleteModal');
        selectedRowIds.clear();
        await loadTableData();
        updateToolbarButtons();
        updateStatus(`Deleted ${rowIds.length} row${rowIds.length > 1 ? 's' : ''} - Ctrl+S to save`);

    } catch (err) {
        console.error('Delete rows failed:', err);
        updateStatus(`Error: ${err.message}`);
    }
}

/**
 * Delete selected columns from the table.
 * SQLite doesn't support DROP COLUMN directly in older versions,
 * so we need to recreate the table without the columns.
 * In SQLite 3.35.0+ (2021), ALTER TABLE DROP COLUMN is supported.
 */
async function submitDeleteColumns() {
    if (selectedColumns.size === 0) return;

    const columnNames = Array.from(selectedColumns);

    try {
        updateStatus('Deleting columns...');

        // Delete columns one by one using ALTER TABLE DROP COLUMN
        // Note: This requires SQLite 3.35.0+ (sql.js should support this)
        for (const columnName of columnNames) {
            const sql = `ALTER TABLE "${selectedTable}" DROP COLUMN "${columnName}"`;
            await backendApi.exec(sql);
        }

        // Fire edit event for undo/redo tracking
        await backendApi.fireEditEvent({
            description: `Delete column${columnNames.length > 1 ? 's' : ''} ${columnNames.join(', ')} from ${selectedTable}`,
            operation: 'drop_column',
            targetTable: selectedTable,
            affectedColumns: columnNames
        });

        closeModal('deleteModal');

        // Clear selections
        selectedColumns.clear();
        selectedCells = [];
        lastSelectedCell = null;

        // Refresh the schema and table data since columns changed
        await refreshSchema();
        await loadTableColumns();
        await loadTableData();
        updateToolbarButtons();
        updateStatus(`Deleted ${columnNames.length} column${columnNames.length > 1 ? 's' : ''} - Ctrl+S to save`);

    } catch (err) {
        console.error('Delete columns failed:', err);
        // Provide helpful error message for common issues
        let errorMessage = err.message || String(err);
        if (errorMessage.includes('no such column') || errorMessage.includes('cannot drop')) {
            errorMessage = 'Cannot delete this column. It may be a primary key or referenced by other constraints.';
        }
        updateStatus(`Error: ${errorMessage}`);
    }
}

async function exportCurrentTable() {
    if (!selectedTable) return;
    await backendApi.exportTable({ table: selectedTable }, tableColumns.map(c => c.name));
}

async function reloadFromDisk() {
    if (!isDbConnected) return;

    try {
        updateStatus('Reloading...');
        await backendApi.refreshFile();
        await refreshSchema();
        if (selectedTable) {
            await loadTableColumns();
            await loadTableData();
        }
        updateStatus('Reloaded');
    } catch (err) {
        console.error('Reload failed:', err);
        updateStatus(`Reload failed: ${err.message}`);
    }
}

// ================================================================
// UI HELPERS
// ================================================================
function openModal(modalId) {
    document.getElementById(modalId).classList.remove('hidden');
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.add('hidden');
}

function updateStatus(message) {
    document.getElementById('statusText').textContent = message;
}

function updateToolbarButtons() {
    const hasTable = selectedTable && selectedTableType === 'table';
    const hasRowSelection = selectedRowIds.size > 0;
    const hasColumnSelection = selectedColumns.size > 0;
    document.getElementById('btnAddRow').disabled = !hasTable;
    document.getElementById('btnAddColumn').disabled = !hasTable;
    // Enable delete button if rows OR columns are selected
    document.getElementById('btnDeleteRows').disabled = !hasTable || (!hasRowSelection && !hasColumnSelection);
    document.getElementById('btnExport').disabled = !selectedTable;
}

function showLoading() {
    document.getElementById('gridContainer').innerHTML = `
        <div class="loading-view">
            <div class="loading-spinner"></div>
            <span>Loading...</span>
        </div>
    `;
}

function showEmptyState() {
    document.getElementById('gridContainer').innerHTML = `
        <div class="empty-view">
            <span class="empty-icon codicon codicon-database"></span>
            <span class="empty-title">Select a table</span>
            <span class="empty-desc">Choose a table from the sidebar to view data</span>
        </div>
    `;
}

function showErrorState(message) {
    document.getElementById('gridContainer').innerHTML = `
        <div class="empty-view">
            <span class="empty-icon codicon codicon-error" style="color: var(--error-color)"></span>
            <span class="empty-title">Error</span>
            <span class="empty-desc">${escapeHtml(message)}</span>
        </div>
    `;
}

/**
 * Escape HTML special characters to prevent XSS attacks.
 * Escapes: & < > " ' (ampersand, less-than, greater-than, double quote, single quote)
 *
 * SECURITY NOTE: Single quote escaping is critical because table/column names
 * are used in onclick handlers with single-quoted strings, e.g.:
 *   onclick="selectTableItem('${escapeHtml(name)}', 'table')"
 * Without escaping single quotes, a malicious table name like:
 *   user'); alert('XSS'); //
 * would break out of the string and execute arbitrary JavaScript.
 */
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ================================================================
// CREATE TABLE FUNCTIONALITY
// ================================================================
let columnDefCounter = 0;

function openCreateTableModal() {
    // Reset the form
    document.getElementById('newTableName').value = '';
    document.getElementById('columnDefinitions').innerHTML = '';
    columnDefCounter = 0;

    // Add initial column (id as primary key)
    addColumnDefinition(true);

    openModal('createTableModal');
}

function addColumnDefinition(isFirst = false) {
    const container = document.getElementById('columnDefinitions');
    const colId = ++columnDefCounter;

    const html = `
        <div class="column-def-row" id="colDef_${colId}" style="display: flex; gap: 8px; margin-bottom: 8px; align-items: center;">
            <input type="text" placeholder="Column name" class="col-name" style="flex: 2;" value="${isFirst ? 'id' : ''}">
            <select class="col-type" style="flex: 1;">
                <option value="INTEGER" ${isFirst ? 'selected' : ''}>INTEGER</option>
                <option value="TEXT" ${!isFirst ? 'selected' : ''}>TEXT</option>
                <option value="REAL">REAL</option>
                <option value="BLOB">BLOB</option>
                <option value="NUMERIC">NUMERIC</option>
            </select>
            <label style="display: flex; align-items: center; gap: 4px;">
                <input type="checkbox" class="col-pk" ${isFirst ? 'checked' : ''}> PK
            </label>
            <label style="display: flex; align-items: center; gap: 4px;">
                <input type="checkbox" class="col-nn"> NN
            </label>
            <button class="icon-button" onclick="removeColumnDefinition(${colId})" title="Remove" ${isFirst ? 'disabled' : ''}>
                <span class="codicon codicon-close"></span>
            </button>
        </div>
    `;
    container.insertAdjacentHTML('beforeend', html);
}

function removeColumnDefinition(colId) {
    const elem = document.getElementById(`colDef_${colId}`);
    if (elem) elem.remove();
}

async function submitCreateTable() {
    const tableName = document.getElementById('newTableName').value.trim();

    if (!tableName) {
        updateStatus('Error: Table name is required');
        return;
    }

    // Validate table name (alphanumeric and underscores only)
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
        updateStatus('Error: Table name must start with a letter or underscore and contain only letters, numbers, and underscores');
        return;
    }

    // Collect column definitions
    const colDefs = [];
    const rows = document.querySelectorAll('.column-def-row');

    for (const row of rows) {
        const name = row.querySelector('.col-name').value.trim();
        const type = row.querySelector('.col-type').value;
        const isPK = row.querySelector('.col-pk').checked;
        const isNN = row.querySelector('.col-nn').checked;

        if (!name) continue;

        let def = `"${name}" ${type}`;
        if (isPK) def += ' PRIMARY KEY';
        if (isNN && !isPK) def += ' NOT NULL';
        colDefs.push(def);
    }

    if (colDefs.length === 0) {
        updateStatus('Error: At least one column is required');
        return;
    }

    const sql = `CREATE TABLE "${tableName}" (${colDefs.join(', ')})`;

    try {
        updateStatus('Creating table...');
        await backendApi.exec(sql);
        await backendApi.fireEditEvent({
            description: `Create table ${tableName}`,
            operation: 'add',
            targetTable: tableName,
            queryText: sql
        });

        closeModal('createTableModal');
        await refreshSchema();
        updateStatus(`Table "${tableName}" created - Ctrl+S to save`);

    } catch (err) {
        console.error('Create table failed:', err);
        updateStatus(`Error: ${err.message}`);
    }
}

// ================================================================
// ADD COLUMN FUNCTIONALITY
// ================================================================
function openAddColumnModal() {
    if (!selectedTable || selectedTableType !== 'table') return;

    // Reset form
    document.getElementById('newColumnName').value = '';
    document.getElementById('newColumnType').value = 'TEXT';
    document.getElementById('newColumnDefault').value = '';

    openModal('addColumnModal');
}

async function submitAddColumn() {
    const columnName = document.getElementById('newColumnName').value.trim();
    const columnType = document.getElementById('newColumnType').value;
    const defaultValue = document.getElementById('newColumnDefault').value.trim();

    if (!columnName) {
        updateStatus('Error: Column name is required');
        return;
    }

    // Validate column name
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(columnName)) {
        updateStatus('Error: Column name must start with a letter or underscore');
        return;
    }

    let sql = `ALTER TABLE "${selectedTable}" ADD COLUMN "${columnName}" ${columnType}`;

    if (defaultValue) {
        if (defaultValue.toLowerCase() === 'null') {
            sql += ' DEFAULT NULL';
        } else if (!isNaN(Number(defaultValue))) {
            sql += ` DEFAULT ${defaultValue}`;
        } else {
            sql += ` DEFAULT '${defaultValue.replace(/'/g, "''")}'`;
        }
    }

    try {
        updateStatus('Adding column...');
        await backendApi.exec(sql);
        await backendApi.fireEditEvent({
            description: `Add column ${columnName} to ${selectedTable}`,
            operation: 'modify',
            targetTable: selectedTable,
            queryText: sql
        });

        closeModal('addColumnModal');
        await loadTableColumns();
        await loadTableData();
        updateStatus(`Column "${columnName}" added - Ctrl+S to save`);

    } catch (err) {
        console.error('Add column failed:', err);
        updateStatus(`Error: ${err.message}`);
    }
}

// ================================================================
// SIDEBAR RESIZE
// ================================================================
(function setupSidebarResize() {
    const sidebar = document.getElementById('sidebarPanel');
    const handle = document.getElementById('resizeHandle');
    let isResizing = false;

    handle.addEventListener('mousedown', e => {
        isResizing = true;
        document.body.style.cursor = 'col-resize';
        e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
        if (!isResizing) return;
        const newWidth = Math.max(150, Math.min(400, e.clientX));
        sidebar.style.width = newWidth + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            document.body.style.cursor = '';
        }
    });
})();

// ================================================================
// KEYBOARD SHORTCUTS
// ================================================================
document.addEventListener('keydown', async (event) => {
    // Cmd+C / Ctrl+C - Copy selected cells or rows to clipboard
    if ((event.metaKey || event.ctrlKey) && event.key === 'c') {
        // Don't intercept if we're editing a cell or in an input
        if (editingCellInfo || document.activeElement.tagName === 'INPUT') {
            return;
        }

        // Priority: selected cells first, then selected rows
        if (selectedCells.length > 0) {
            event.preventDefault();
            await copyCellsToClipboard();
        } else if (selectedRowIds.size > 0 && gridData.length > 0) {
            event.preventDefault();
            await copySelectedRowsToClipboard();
        }
    }

    // Cmd+A / Ctrl+A - Select all rows
    if ((event.metaKey || event.ctrlKey) && event.key === 'a') {
        // Don't intercept if we're editing a cell or in an input
        if (editingCellInfo || document.activeElement.tagName === 'INPUT') {
            return;
        }

        if (selectedTable && gridData.length > 0) {
            event.preventDefault();
            selectAllRows();
        }
    }

    // Cmd+Delete / Cmd+Backspace / Ctrl+Delete / Ctrl+Backspace - Clear selected cell values
    if ((event.metaKey || event.ctrlKey) && (event.key === 'Delete' || event.key === 'Backspace')) {
        // Don't intercept if we're editing a cell or in an input/textarea
        if (editingCellInfo || document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') {
            return;
        }

        // Only works for tables (not views) and when cells are selected
        if (selectedTable && selectedTableType === 'table' && selectedCells.length > 0) {
            event.preventDefault();
            await clearSelectedCellValues();
        }
    }
});

/**
 * Copy selected cells to clipboard.
 * For single cell: copies the value directly.
 * For multiple cells: copies as tab-separated grid (maintains row/col structure).
 */
async function copyCellsToClipboard() {
    if (selectedCells.length === 0) return;

    try {
        let clipboardText;

        if (selectedCells.length === 1) {
            // Single cell - copy value directly
            const value = selectedCells[0].value;
            if (value === null || value === undefined) {
                clipboardText = '';
            } else if (value instanceof Uint8Array) {
                clipboardText = '[BLOB]';
            } else {
                clipboardText = String(value);
            }
        } else {
            // Multiple cells - organize into a grid and copy as TSV
            // Find the bounds of the selection
            const rows = [...new Set(selectedCells.map(c => c.rowIdx))].sort((a, b) => a - b);
            const cols = [...new Set(selectedCells.map(c => c.colIdx))].sort((a, b) => a - b);

            // Build a map for quick lookup
            const cellMap = new Map();
            for (const cell of selectedCells) {
                cellMap.set(`${cell.rowIdx},${cell.colIdx}`, cell.value);
            }

            // Build the grid output
            const lines = [];
            for (const rowIdx of rows) {
                const rowValues = [];
                for (const colIdx of cols) {
                    const key = `${rowIdx},${colIdx}`;
                    if (cellMap.has(key)) {
                        const value = cellMap.get(key);
                        if (value === null || value === undefined) {
                            rowValues.push('');
                        } else if (value instanceof Uint8Array) {
                            rowValues.push('[BLOB]');
                        } else {
                            rowValues.push(String(value));
                        }
                    } else {
                        rowValues.push(''); // Empty for non-selected cells in the range
                    }
                }
                lines.push(rowValues.join('\t'));
            }
            clipboardText = lines.join('\n');
        }

        await navigator.clipboard.writeText(clipboardText);
        const count = selectedCells.length;
        updateStatus(`Copied ${count} cell${count > 1 ? 's' : ''} to clipboard`);

    } catch (err) {
        console.error('Copy failed:', err);
        updateStatus('Copy failed: ' + err.message);
    }
}

/**
 * Copy selected rows to clipboard as tab-separated values (TSV).
 * Format: header row + data rows, tab-separated, newline-delimited.
 */
async function copySelectedRowsToClipboard() {
    if (selectedRowIds.size === 0 || gridData.length === 0) return;

    try {
        // Build header row
        const headers = tableColumns.map(c => c.name).join('\t');

        // Build data rows for selected rows only
        const dataRows = [];
        for (let rowIdx = 0; rowIdx < gridData.length; rowIdx++) {
            const row = gridData[rowIdx];
            const rowId = getRowId(row, rowIdx);
            if (selectedRowIds.has(rowId)) {
                // Get actual column values using the offset helper
                const values = [];
                for (let colIdx = 0; colIdx < tableColumns.length; colIdx++) {
                    const val = getCellValue(row, colIdx);
                    if (val === null) {
                        values.push('');
                    } else if (val instanceof Uint8Array) {
                        values.push('[BLOB]');
                    } else {
                        values.push(String(val));
                    }
                }
                dataRows.push(values.join('\t'));
            }
        }

        // Combine header and data
        const clipboardText = [headers, ...dataRows].join('\n');

        // Copy to clipboard
        await navigator.clipboard.writeText(clipboardText);
        updateStatus(`Copied ${dataRows.length} row${dataRows.length > 1 ? 's' : ''} to clipboard`);

    } catch (err) {
        console.error('Copy failed:', err);
        updateStatus('Copy failed: ' + err.message);
    }
}

/**
 * Clear (set to NULL) the values of all selected cells.
 * Executes UPDATE statements for each unique row/column combination.
 * Fires edit events for undo/redo tracking.
 */
async function clearSelectedCellValues() {
    if (selectedCells.length === 0) return;
    if (selectedTableType !== 'table') {
        updateStatus('Views are read-only');
        return;
    }

    try {
        updateStatus('Clearing cells...');

        // Group cells by rowId for more efficient updates
        // Each cell needs its own UPDATE since we're clearing different columns
        const updates = [];
        for (const cell of selectedCells) {
            const column = tableColumns[cell.colIdx];
            if (!column) continue;

            // Check if column allows NULL
            const isNotNull = column.notnull === 1;
            const newValue = isNotNull ? '' : null;
            const sqlValue = isNotNull ? "''" : 'NULL';

            updates.push({
                rowId: cell.rowId,
                rowIdx: cell.rowIdx,
                colIdx: cell.colIdx,
                columnName: column.name,
                originalValue: cell.value,
                newValue: newValue,
                sql: `UPDATE "${selectedTable}" SET "${column.name}" = ${sqlValue} WHERE rowid = ${cell.rowId}`
            });
        }

        // Execute all updates
        for (const update of updates) {
            await backendApi.exec(update.sql);
        }

        // Fire a single edit event for all the cleared cells
        await backendApi.fireEditEvent({
            label: `Clear ${updates.length} cell${updates.length > 1 ? 's' : ''}`,
            description: `Clear ${updates.length} cell${updates.length > 1 ? 's' : ''} in ${selectedTable}`,
            modificationType: 'cell_clear',
            targetTable: selectedTable,
            affectedCells: updates.map(u => ({
                rowId: u.rowId,
                columnName: u.columnName,
                previousValue: u.originalValue,
                newValue: u.newValue
            }))
        });

        // Update local grid data
        for (const update of updates) {
            gridData[update.rowIdx][update.colIdx + getRowDataOffset()] = update.newValue;
        }

        // Clear selection and refresh
        selectedCells = [];
        lastSelectedCell = null;
        selectedColumns.clear();
        await loadTableData();
        updateToolbarButtons();
        updateStatus(`Cleared ${updates.length} cell${updates.length > 1 ? 's' : ''} - Ctrl+S to save`);

    } catch (err) {
        console.error('Clear cells failed:', err);
        let errorMessage = err.message || String(err);

        // Handle common constraint errors
        if (errorMessage.includes('NOT NULL constraint failed')) {
            errorMessage = 'Cannot clear: one or more columns require a value (NOT NULL constraint)';
        }

        updateStatus(`Clear failed: ${errorMessage}`);
    }
}

/**
 * Select all rows in the current page.
 * Optimized: updates selection state without full re-render, then updates UI.
 */
function selectAllRows() {
    if (gridData.length === 0) return;

    // Clear cell selection when selecting rows
    selectedCells = [];
    lastSelectedCell = null;
    selectedColumns.clear(); // Clear column selection
    updateCellSelectionUI();

    // Check if all are already selected - if so, deselect all
    const allSelected = gridData.every((row, idx) => selectedRowIds.has(getRowId(row, idx)));

    if (allSelected) {
        // Deselect all
        selectedRowIds.clear();
    } else {
        // Select all visible rows
        for (let rowIdx = 0; rowIdx < gridData.length; rowIdx++) {
            selectedRowIds.add(getRowId(gridData[rowIdx], rowIdx));
        }
    }

    // Update UI without full re-render for better performance
    updateRowSelectionUI();
    updateToolbarButtons();
}

/**
 * Update row selection UI without re-rendering entire grid.
 * More efficient for large tables.
 */
function updateRowSelectionUI() {
    const rows = document.querySelectorAll('.data-row');
    for (const row of rows) {
        const rowId = parseInt(row.dataset.rowid, 10);
        if (selectedRowIds.has(rowId)) {
            row.classList.add('selected');
        } else {
            row.classList.remove('selected');
        }
    }
}

/**
 * Handle click on '#' header to select/deselect all rows.
 */
function onSelectAllClick(event) {
    event.stopPropagation();
    selectAllRows();
}

// ================================================================
// INITIALIZE
// ================================================================
initializeApp();
