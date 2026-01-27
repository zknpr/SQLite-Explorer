/**
 * Data Grid Rendering and Logic
 */
import { state } from './state.js';
import { backendApi } from './api.js';
import { escapeHtml, escapeIdentifier, formatCellValue } from './utils.js';
import { updateStatus, showLoading, showErrorState, updateToolbarButtons } from './ui.js';
import { openCellPreview, startCellEdit, openCellInVsCode } from './edit.js';
import { updateBatchSidebar } from './sidebar.js';
import { getRowId, getRowDataOffset, getCellValue } from './data-utils.js';

// Optimization: Track selected element IDs to avoid expensive querySelectorAll
let lastSelectedCellIds = new Set();
let lastSelectedRowIds = new Set();

// ================================================================
// EVENT DELEGATION
// ================================================================

export function initGridInteraction() {
    const container = document.getElementById('gridContainer');
    if (!container) return;

    // --- Mousedown Delegation (Resize) ---
    container.addEventListener('mousedown', (event) => {
        if (event.target.classList.contains('resize-handle')) {
            event.stopPropagation();
            const headerCell = event.target.closest('.header-cell');
            if (headerCell && headerCell.dataset.column) {
                startColumnResize(event, headerCell.dataset.column);
            }
        }
    });

    // --- Keydown Delegation (Filters) ---
    container.addEventListener('keydown', (event) => {
        if (event.target.classList.contains('column-filter')) {
            const colName = event.target.dataset.column;
            if (colName) onColumnFilterKeydown(event, colName);
        }
    });

    // --- Click Delegation ---
    container.addEventListener('click', (event) => {
        const target = event.target;

        // --- Header Interactions ---
        if (target.closest('.grid-header')) {
            // 1. Filter Apply Button
            if (target.closest('.filter-apply-btn')) {
                event.stopPropagation();
                const headerCell = target.closest('.header-cell');
                if (headerCell && headerCell.dataset.column) {
                    applyColumnFilter(headerCell.dataset.column);
                }
                return;
            }

            // 2. Prevent sort when clicking inputs/bottom area
            if (target.closest('.header-bottom') || target.closest('.column-filter')) {
                event.stopPropagation();
                return;
            }

            // 3. Column Selection Icon
            if (target.closest('.select-column-icon')) {
                event.stopPropagation();
                const headerCell = target.closest('.header-cell');
                if (headerCell && headerCell.dataset.column) {
                    onColumnHeaderClick(event, headerCell.dataset.column);
                }
                return;
            }

            // 4. Header Pin Icon
            if (target.closest('.pin-icon')) {
                event.stopPropagation();
                const headerCell = target.closest('.header-cell');
                if (headerCell && headerCell.dataset.column) {
                    toggleColumnPin(event, headerCell.dataset.column);
                }
                return;
            }

            // 5. Select All (Row Number Header)
            if (target.closest('.row-number-header')) {
                onSelectAllClick(event);
                return;
            }

            // 6. Sort (Header Top)
            const headerTop = target.closest('.header-top');
            if (headerTop) {
                const headerCell = headerTop.closest('.header-cell');
                if (headerCell && headerCell.dataset.column) {
                    onColumnSort(headerCell.dataset.column);
                }
                return;
            }
            return;
        }

        // --- Body Interactions ---

        // 1. Row Pin Icon
        if (target.closest('.pin-icon')) {
            const rowEl = target.closest('.data-row');
            if (rowEl) {
                const rowId = rowEl.dataset.rowid;
                // Handle type conversion
                const safeRowId = resolveRowIdType(rowId);
                toggleRowPin(event, safeRowId);
            }
            return;
        }

        // 2. Expand Icon
        if (target.closest('.expand-icon')) {
            const cellEl = target.closest('.data-cell');
            if (cellEl) {
                const rowIdx = parseInt(cellEl.dataset.rowidx, 10);
                const colIdx = parseInt(cellEl.dataset.colidx, 10);
                const rowId = resolveRowIdType(cellEl.closest('.data-row').dataset.rowid);
                openCellPreview(rowIdx, colIdx, rowId);
            }
            return;
        }

        // 3. Row Number Cell
        if (target.closest('.row-number')) {
            const rowEl = target.closest('.data-row');
            if (rowEl) {
                const rowId = resolveRowIdType(rowEl.dataset.rowid);
                onRowNumberClick(event, rowId);
            }
            return;
        }

        // 4. Data Cell
        const cellEl = target.closest('.data-cell');
        if (cellEl) {
            const rowIdx = parseInt(cellEl.dataset.rowidx, 10);
            const colIdx = parseInt(cellEl.dataset.colidx, 10);
            const rowEl = cellEl.closest('.data-row');
            const rowId = resolveRowIdType(rowEl.dataset.rowid);
            onCellClick(event, rowIdx, colIdx, rowId);
            return;
        }

        // 5. Row (generic click)
        const rowEl = target.closest('.data-row');
        if (rowEl) {
             const rowIdx = parseInt(rowEl.dataset.rowidx, 10);
             const rowId = resolveRowIdType(rowEl.dataset.rowid);
             onRowClick(event, rowId, rowIdx);
        }
    });

    // Double Click Handler
    container.addEventListener('dblclick', (event) => {
        const cellEl = event.target.closest('.data-cell');
        if (cellEl && !cellEl.classList.contains('row-number')) {
            const rowIdx = parseInt(cellEl.dataset.rowidx, 10);
            const colIdx = parseInt(cellEl.dataset.colidx, 10);
            const rowEl = cellEl.closest('.data-row');
            const rowId = resolveRowIdType(rowEl.dataset.rowid);
            onCellDoubleClick(event, rowIdx, colIdx, rowId);
        }
    });

    // Lazy overflow detection
    container.addEventListener('mouseover', (event) => {
        const cell = event.target.closest('.data-cell');
        if (cell && !cell.classList.contains('checked-overflow')) {
            const textSpan = cell.querySelector('.cell-text');
            if (textSpan) {
                const hasOverflow = textSpan.scrollWidth > textSpan.clientWidth;
                cell.classList.toggle('has-overflow', hasOverflow);
                cell.classList.add('checked-overflow');
            }
        }
    });
}

function resolveRowIdType(idStr) {
    if (idStr === undefined || idStr === null) return idStr;
    const num = Number(idStr);
    return isNaN(num) ? idStr : num;
}

// ================================================================
// DATA LOADING
// ================================================================

export async function loadTableColumns() {
    if (!state.selectedTable) return;

    try {
        const columns = await backendApi.getTableInfo(state.selectedTable);
        state.tableColumns = columns.map(r => ({
            cid: r.ordinal,
            name: r.identifier,
            type: r.declaredType,
            notnull: r.isRequired,
            dflt_value: r.defaultExpression,
            isPrimaryKey: r.primaryKeyPosition > 0
        })).sort((a, b) => a.cid - b.cid);
    } catch (err) {
        console.error('Error loading columns:', err);
        updateStatus('Error loading columns');
    }
}

export async function loadTableData(showSpinner = true, saveScrollPosition = true) {
    if (!state.selectedTable) return;

    const container = document.getElementById('gridContainer');

    // Only capture scroll position if the grid is currently visible (not loading/error state)
    // This prevents overwriting the saved position with 0 when reloading data while a spinner is shown.
    if (saveScrollPosition && container && container.querySelector('.data-grid')) {
        state.scrollPosition.left = container.scrollLeft;
        state.scrollPosition.top = container.scrollTop;
    }

    if (showSpinner) {
        state.isLoadingData = true;
        showLoading();
    }
    updateToolbarButtons();

    try {
        // Build query options
        const filters = [];
        // Column filters
        for (const [colName, filterValue] of Object.entries(state.columnFilters)) {
            if (filterValue && filterValue.trim()) {
                filters.push({ column: colName, value: filterValue });
            }
        }

        const countOptions = {
            filters,
            globalFilter: state.filterQuery,
            columns: state.tableColumns.map(c => c.name) // Needed for global filter
        };

        // Get total count
        state.totalRecordCount = await backendApi.fetchTableCount(state.selectedTable, countOptions);
        state.totalPageCount = Math.max(1, Math.ceil(state.totalRecordCount / state.rowsPerPage));

        if (state.currentPageIndex >= state.totalPageCount) {
            state.currentPageIndex = Math.max(0, state.totalPageCount - 1);
        }

        // Get data
        const isTable = state.selectedTableType === 'table';
        const columnNames = state.tableColumns.map(c => c.name);

        // For tables, we need rowid. We can't ask `fetchTableData` to add it automatically easily without schema knowledge.
        // But we can ask for 'rowid' as a column.
        // The previous logic was: `SELECT rowid AS _rowid_, ...`
        // `query-builder` does `SELECT ${escapedColumns} ...`
        // So we can pass `['rowid AS _rowid_', ...columnNames]`?
        // `query-builder` escapes columns. `escapeIdentifier('rowid AS _rowid_')` -> `"rowid AS _rowid_"` which is invalid SQL.
        // We need to modify query-builder to handle aliases or just special case rowid.
        // OR we just request `rowid` and `*`?

        // Let's modify `query-builder.ts` to allow raw columns or aliases?
        // Or handle the rowid requirement in `fetchTableData` backend side.

        // Actually, let's just pass `rowid` in columns if it's a table.
        // But `rowid` isn't in `state.tableColumns`.
        // If we request `columns: ['rowid', 'name']`, query builder does `SELECT "rowid", "name"`. This works.
        // The frontend expects rowid at index 0 for tables (see `getRowId` and `getRowDataOffset`).

        const queryColumns = isTable ? ['rowid', ...columnNames] : columnNames;

        const queryOptions = {
            columns: queryColumns,
            orderBy: state.sortedColumn,
            orderDir: state.sortAscending ? 'ASC' : 'DESC',
            limit: state.rowsPerPage,
            offset: state.currentPageIndex * state.rowsPerPage,
            filters,
            globalFilter: state.filterQuery
        };

        const dataResult = await backendApi.fetchTableData(state.selectedTable, queryOptions);

        // Data result rows now include rowid at index 0 if we requested it.
        // `grid.js` logic: `getRowId` uses `row[0]`. `getCellValue` uses `colIdx + getRowDataOffset()`.
        // `getRowDataOffset` returns 1 if table (skipping rowid).
        // So if `dataResult.rows` has `[rowid, col1, col2]`, it matches the expectation!

        state.gridData = dataResult.rows || [];

        // If not showing spinner (background refresh), capture the current scroll position
        // right before rendering. This ensures we use the latest scroll position,
        // which covers cases where the user scrolled during fetch or if an edit operation
        // updated the view (and restored scroll) while the fetch was pending.
        if (!showSpinner && container && container.querySelector('.data-grid')) {
            state.scrollPosition.left = container.scrollLeft;
            state.scrollPosition.top = container.scrollTop;
        }

        // Optimization: If editing, skip render to avoid destroying the active editor
        if (!showSpinner && state.editingCellInfo) {
            // We updated gridData, so the data is fresh.
            // We skip the DOM update to keep the <textarea> alive.
            // updateCellDom in edit.js handles the visual update of the modified cell.
        } else {
            renderDataGrid(state.scrollPosition.top, state.scrollPosition.left);
        }

        if (container) {
            container.scrollLeft = state.scrollPosition.left;
            container.scrollTop = state.scrollPosition.top;
        }

        updatePagination();
        updateStatus(`${state.totalRecordCount} records`);

    } catch (err) {
        console.error('Error loading data:', err);
        updateStatus(`Error: ${err.message}`);
        showErrorState(err.message);
    } finally {
        if (showSpinner) {
            state.isLoadingData = false;
        }
    }
}

// ================================================================
// RENDERING
// ================================================================

export function renderDataGrid(savedScrollTop = null, savedScrollLeft = null) {
    const headerHeight = 52;
    const rowHeight = 26;
    const rowNumWidth = 50;

    const container = document.getElementById('gridContainer');
    if (!container) return;

    // If explicit scroll positions not provided, capture current
    const currentScrollLeft = container.scrollLeft;
    const currentScrollTop = container.scrollTop;

    const finalScrollLeft = savedScrollLeft !== null ? savedScrollLeft : currentScrollLeft;
    const finalScrollTop = savedScrollTop !== null ? savedScrollTop : currentScrollTop;

    const hasActiveFilters = Object.values(state.columnFilters).some(v => v && v.trim() !== '');

    // Clear container
    container.innerHTML = '';

    if (state.gridData.length === 0 && !hasActiveFilters && state.tableColumns.length === 0) {
        const emptyView = document.createElement('div');
        emptyView.className = 'empty-view';
        emptyView.innerHTML = `
            <span class="empty-icon codicon codicon-database"></span>
            <span class="empty-title">No data</span>
            <span class="empty-desc">This table is empty</span>
        `;
        container.appendChild(emptyView);
        return;
    }

    // Optimization: Pre-calculate selected cells set for O(1) lookup during render
    const selectedCellKeys = new Set();
    if (state.selectedCells.length > 0) {
        for (const cell of state.selectedCells) {
            selectedCellKeys.add(`${cell.rowIdx},${cell.colIdx}`);
        }
    }

    const table = document.createElement('table');
    table.className = 'data-grid';

    const thead = document.createElement('thead');
    thead.className = 'grid-header';
    const headerTr = document.createElement('tr');

    // Calculate column widths if needed
    if (Object.keys(state.columnWidths).length === 0 && state.gridData.length > 0) {
        for (const col of state.tableColumns) {
            const headerLen = col.name.length;
            const iconPadding = col.isPrimaryKey ? 86 : 70;
            const titleWidth = headerLen * 8 + iconPadding;
            state.columnWidths[col.name] = Math.max(80, Math.min(250, titleWidth));
        }
    }

    // Reorder columns: pinned first
    const orderedColumns = [
        ...state.tableColumns.filter(col => state.pinnedColumns.has(col.name)),
        ...state.tableColumns.filter(col => !state.pinnedColumns.has(col.name))
    ];

    // Pinned column offsets
    const pinnedColumnOffsets = new Map();
    // Start 1px to the left to create a slight overlap (49px instead of 50px).
    let cumulativeLeft = rowNumWidth - 1;
    for (const col of orderedColumns) {
        if (state.pinnedColumns.has(col.name)) {
            pinnedColumnOffsets.set(col.name, cumulativeLeft);
            cumulativeLeft += (state.columnWidths[col.name] || 120);
        }
    }

    // Column index map
    const columnIndexMap = new Map();
    state.tableColumns.forEach((col, idx) => columnIndexMap.set(col.name, idx));

    // Header cells
    const rowNumTh = document.createElement('th');
    rowNumTh.className = 'header-cell row-number-header';
    Object.assign(rowNumTh.style, {
        width: `${rowNumWidth}px`,
        minWidth: `${rowNumWidth}px`,
        maxWidth: `${rowNumWidth}px`,
        position: 'sticky',
        left: '0',
        top: '0',
        zIndex: '11',
        background: 'var(--bg-secondary)'
    });
    rowNumTh.title = 'Click to select all rows';
    rowNumTh.innerHTML = '<div class="header-content"><div class="header-top" style="height:100%;justify-content:center">#</div></div>';
    headerTr.appendChild(rowNumTh);

    for (const col of orderedColumns) {
        const isSorted = state.sortedColumn === col.name;
        const isPinned = state.pinnedColumns.has(col.name);
        const isColumnSelected = state.selectedColumns.has(col.name);
        const colWidth = state.columnWidths[col.name] || 120;
        const filterValue = state.columnFilters[col.name] || '';

        const th = document.createElement('th');
        th.className = `header-cell ${isPinned ? 'pinned' : ''} ${isColumnSelected ? 'column-selected' : ''}`;
        Object.assign(th.style, {
            width: `${colWidth}px`,
            minWidth: `${colWidth}px`,
            maxWidth: `${colWidth}px`
        });

        if (isPinned) {
            th.style.position = 'sticky';
            th.style.left = `${pinnedColumnOffsets.get(col.name)}px`;
        }
        th.dataset.column = col.name;

        const safeColName = escapeHtml(col.name);
        const safeFilterValue = escapeHtml(filterValue);
        const sortIndicator = isSorted ? `<span class="sort-indicator">${state.sortAscending ? '▲' : '▼'}</span>` : '';
        const keyIcon = col.isPrimaryKey ? '<span class="key-icon codicon codicon-key" title="Primary Key"></span>' : '';
        const pinClass = isPinned ? 'pinned' : '';
        const pinTitle = isPinned ? 'Unpin column' : 'Pin column';

        th.innerHTML = `
            <div class="header-content">
                <div class="header-top">
                    ${keyIcon}<span class="header-text">${safeColName}${sortIndicator}</span>
                    <span class="select-column-icon codicon codicon-selection" title="Select entire column"></span>
                    <span class="pin-icon codicon codicon-pin ${pinClass}" title="${pinTitle}"></span>
                </div>
                <div class="header-bottom">
                    <input type="text" class="column-filter" data-column="${safeColName}" value="${safeFilterValue}" placeholder="Filter...">
                    <button class="filter-apply-btn" title="Apply filter (Enter)"><span class="codicon codicon-search"></span></button>
                </div>
            </div>
            <div class="resize-handle"></div>
        `;
        headerTr.appendChild(th);
    }
    thead.appendChild(headerTr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

    // Pinned rows logic
    const pinnedRowsList = [];
    for (let rowIdx = 0; rowIdx < state.gridData.length; rowIdx++) {
        const rowId = getRowId(state.gridData[rowIdx], rowIdx);
        if (state.pinnedRowIds.has(rowId)) {
            pinnedRowsList.push({ rowIdx, rowId, row: state.gridData[rowIdx] });
        }
    }

    const pinnedRowOffsets = new Map();
    for (let i = 0; i < pinnedRowsList.length; i++) {
        const topOffset = headerHeight + (i * rowHeight);
        pinnedRowOffsets.set(pinnedRowsList[i].rowId, topOffset);
    }

    const orderedRowIndices = [
        ...state.gridData.map((row, idx) => ({ idx, rowId: getRowId(row, idx) })).filter(r => state.pinnedRowIds.has(r.rowId)),
        ...state.gridData.map((row, idx) => ({ idx, rowId: getRowId(row, idx) })).filter(r => !state.pinnedRowIds.has(r.rowId))
    ];

    const fragment = document.createDocumentFragment();

    for (const { idx: rowIdx, rowId } of orderedRowIndices) {
        const row = state.gridData[rowIdx];
        const isSelected = state.selectedRowIds.has(rowId);
        const isRowPinned = state.pinnedRowIds.has(rowId);

        const tr = document.createElement('tr');
        tr.id = `row-${rowIdx}`;
        tr.className = `data-row ${isSelected ? 'selected' : ''} ${isRowPinned ? 'pinned' : ''}`;
        tr.dataset.rowid = rowId;
        tr.dataset.rowidx = rowIdx;

        if (isRowPinned) {
            tr.style.top = `${pinnedRowOffsets.get(rowId)}px`;
        }

        const rowNumTd = document.createElement('td');
        rowNumTd.className = 'data-cell row-number';
        Object.assign(rowNumTd.style, {
            width: `${rowNumWidth}px`,
            minWidth: `${rowNumWidth}px`,
            maxWidth: `${rowNumWidth}px`,
            position: 'sticky',
            left: '0',
            zIndex: isRowPinned ? '8' : '2'
        });

        const rowNumVal = state.currentPageIndex * state.rowsPerPage + rowIdx + 1;
        rowNumTd.innerHTML = `${rowNumVal}<span class="pin-icon codicon codicon-pin ${isRowPinned ? 'pinned' : ''}" title="${isRowPinned ? 'Unpin row' : 'Pin row'}"></span>`;
        tr.appendChild(rowNumTd);

        for (let displayColIdx = 0; displayColIdx < orderedColumns.length; displayColIdx++) {
            const col = orderedColumns[displayColIdx];
            const originalColIdx = columnIndexMap.get(col.name);
            const value = getCellValue(row, originalColIdx);
            const displayValue = formatCellValue(value, col.type, state.dateFormat, col.name);
            const isNull = value === null || value === undefined;
            const isCellSelected = selectedCellKeys.has(`${rowIdx},${originalColIdx}`);
            const isColPinned = state.pinnedColumns.has(col.name);
            const hasContent = !isNull && !(value instanceof Uint8Array);
            const colWidth = state.columnWidths[col.name] || 120;

            const td = document.createElement('td');
            td.id = `cell-${rowIdx}-${originalColIdx}`;
            td.className = `data-cell ${isNull ? 'null-value' : ''} ${isCellSelected ? 'cell-selected' : ''} ${isColPinned ? 'pinned' : ''}`;
            td.dataset.rowidx = rowIdx;
            td.dataset.colidx = originalColIdx;

            Object.assign(td.style, {
                width: `${colWidth}px`,
                minWidth: `${colWidth}px`,
                maxWidth: `${colWidth}px`
            });

            if (hasContent) td.style.position = 'relative';

            if (isColPinned) {
                td.style.position = 'sticky';
                td.style.left = `${pinnedColumnOffsets.get(col.name)}px`;
            }

            const textSpan = document.createElement('span');
            textSpan.className = 'cell-text';
            textSpan.textContent = displayValue;
            td.appendChild(textSpan);

            if (hasContent) {
                const iconSpan = document.createElement('span');
                iconSpan.className = 'expand-icon codicon codicon-link-external';
                iconSpan.title = 'View full content';
                td.appendChild(iconSpan);
            }

            tr.appendChild(td);
        }
        fragment.appendChild(tr);
    }

    if (state.gridData.length === 0 && hasActiveFilters) {
        const tr = document.createElement('tr');
        tr.className = 'no-results-row';
        const td = document.createElement('td');
        td.colSpan = orderedColumns.length + 1;
        Object.assign(td.style, {
            textAlign: 'center',
            padding: '20px',
            color: 'var(--text-secondary)'
        });
        td.textContent = 'No rows match the current filter. Modify or clear filters above.';
        tr.appendChild(td);
        fragment.appendChild(tr);
    }

    tbody.appendChild(fragment);
    table.appendChild(tbody);
    container.appendChild(table);

    container.scrollLeft = finalScrollLeft;
    container.scrollTop = finalScrollTop;

    // Sync selection tracking sets with the new DOM
    lastSelectedCellIds.clear();
    if (state.selectedCells.length > 0) {
        state.selectedCells.forEach(cell => {
            lastSelectedCellIds.add(`cell-${cell.rowIdx}-${cell.colIdx}`);
        });
    }

    lastSelectedRowIds.clear();
    if (state.selectedRowIds.size > 0) {
        const rows = document.querySelectorAll('.data-row.selected');
        rows.forEach(row => {
            if (row.id) lastSelectedRowIds.add(row.id);
        });
    }
}

// ================================================================
// HELPERS
// ================================================================

export function updateSelectionStates() {
    // --- Cells Diffing ---
    const newCellIds = new Set();
    for (const cell of state.selectedCells) {
        newCellIds.add(`cell-${cell.rowIdx}-${cell.colIdx}`);
    }

    // Remove from Deselected
    for (const id of lastSelectedCellIds) {
        if (!newCellIds.has(id)) {
            const el = document.getElementById(id);
            if (el) el.classList.remove('cell-selected');
        }
    }

    // Add to Newly Selected
    for (const id of newCellIds) {
        if (!lastSelectedCellIds.has(id)) {
            const el = document.getElementById(id);
            if (el) el.classList.add('cell-selected');
        }
    }
    lastSelectedCellIds = newCellIds;

    // --- Rows Diffing ---
    const newRowDomIds = new Set();
    // Efficiently calculate which DOM rows should be selected based on gridData
    // This avoids querying the DOM to find rows
    for (let i = 0; i < state.gridData.length; i++) {
        const rowId = getRowId(state.gridData[i], i);
        // Check fuzzy match (string/number) to align with dataset behavior
        const isSelected = state.selectedRowIds.has(rowId) ||
                          (typeof rowId !== 'string' && state.selectedRowIds.has(String(rowId)));

        if (isSelected) {
            newRowDomIds.add(`row-${i}`);
        }
    }

    // Remove from Deselected
    for (const id of lastSelectedRowIds) {
        if (!newRowDomIds.has(id)) {
            const el = document.getElementById(id);
            if (el) el.classList.remove('selected');
        }
    }

    // Add to Newly Selected
    for (const id of newRowDomIds) {
        if (!lastSelectedRowIds.has(id)) {
            const el = document.getElementById(id);
            if (el) el.classList.add('selected');
        }
    }
    lastSelectedRowIds = newRowDomIds;

    // --- Columns (Small number, simple update is fine) ---
    document.querySelectorAll('.header-cell.column-selected').forEach(el => el.classList.remove('column-selected'));
    if (state.selectedColumns.size > 0) {
        state.selectedColumns.forEach(colName => {
            const safeColName = CSS.escape(colName);
            const header = document.querySelector(`.header-cell[data-column="${safeColName}"]`);
            if (header) header.classList.add('column-selected');
        });
    }
}

export { getRowId, getRowDataOffset, getCellValue } from './data-utils.js';

export function updatePagination() {
    document.getElementById('pageIndicator').textContent = `${state.currentPageIndex + 1} / ${state.totalPageCount}`;
    document.getElementById('btnFirst').disabled = state.currentPageIndex === 0;
    document.getElementById('btnPrev').disabled = state.currentPageIndex === 0;
    document.getElementById('btnNext').disabled = state.currentPageIndex >= state.totalPageCount - 1;
    document.getElementById('btnLast').disabled = state.currentPageIndex >= state.totalPageCount - 1;
}

// ================================================================
// ACTIONS
// ================================================================

export function onFilterChange() {
    clearTimeout(state.filterTimer);
    state.filterTimer = setTimeout(() => {
        state.filterQuery = document.getElementById('filterInput').value;
        state.currentPageIndex = 0;
        loadTableData();
    }, 300);
}

export function onPageSizeChange() {
    state.rowsPerPage = parseInt(document.getElementById('pageSizeSelect').value, 10);
    state.currentPageIndex = 0;
    loadTableData();
}

export function onDateFormatChange() {
    const select = document.getElementById('dateFormatSelect');
    if (select) {
        state.dateFormat = select.value;
        renderDataGrid();
    }
}

export function goToPage(pageIndex) {
    if (pageIndex >= 0 && pageIndex < state.totalPageCount) {
        state.currentPageIndex = pageIndex;
        state.scrollPosition = { top: 0, left: 0 };
        loadTableData(true, false);
    }
}

export function onColumnSort(columnName) {
    if (state.sortedColumn === columnName) {
        state.sortAscending = !state.sortAscending;
    } else {
        state.sortedColumn = columnName;
        state.sortAscending = true;
    }
    loadTableData();
}

export function applyColumnFilter(columnName) {
    const input = document.querySelector(`.column-filter[data-column="${columnName}"]`);
    if (input) {
        state.columnFilters[columnName] = input.value;
        state.currentPageIndex = 0;
        loadTableData();
    }
}

export function onColumnFilterKeydown(event, columnName) {
    if (event.key === 'Enter') {
        applyColumnFilter(columnName);
    }
}

// Column Selection
export function onColumnHeaderClick(event, columnName) {
    event.stopPropagation();
    const colIdx = state.tableColumns.findIndex(c => c.name === columnName);
    if (colIdx === -1) return;

    state.selectedRowIds.clear();

    const columnCellCount = state.gridData.length;
    let selectedInColumn = 0;
    for (const sc of state.selectedCells) {
        if (sc.colIdx === colIdx) selectedInColumn++;
    }
    const isColumnFullySelected = columnCellCount > 0 && selectedInColumn === columnCellCount;

    if ((event.metaKey || event.ctrlKey)) {
        // Toggle add/remove column
        if (isColumnFullySelected) {
            state.selectedCells = state.selectedCells.filter(sc => sc.colIdx !== colIdx);
            state.selectedColumns.delete(columnName);
        } else {
            // Add missing cells - Optimization: Use Set for fast lookup
            const existingSet = new Set();
            for (const sc of state.selectedCells) {
                existingSet.add(`${sc.rowIdx},${sc.colIdx}`);
            }

            for (let r = 0; r < state.gridData.length; r++) {
                if (!existingSet.has(`${r},${colIdx}`)) {
                    const rowId = getRowId(state.gridData[r], r);
                    const value = getCellValue(state.gridData[r], colIdx);
                    state.selectedCells.push({ rowIdx: r, colIdx, rowId, value });
                    existingSet.add(`${r},${colIdx}`);
                }
            }
            state.selectedColumns.add(columnName);
        }
    } else {
        // Toggle selection if this column is already fully selected and is the only column selected
        if (isColumnFullySelected && state.selectedColumns.size === 1 && state.selectedColumns.has(columnName)) {
            state.selectedCells = [];
            state.selectedColumns.clear();
        } else {
            // Select only this column
            state.selectedCells = [];
            state.selectedColumns.clear();
            for (let r = 0; r < state.gridData.length; r++) {
                const rowId = getRowId(state.gridData[r], r);
                const value = getCellValue(state.gridData[r], colIdx);
                state.selectedCells.push({ rowIdx: r, colIdx, rowId, value });
            }
            state.selectedColumns.add(columnName);
        }
    }

    state.lastSelectedCell = null;
    updateSelectionStates();
    updateToolbarButtons();
    updateBatchSidebar();
}

// Column Pinning
export function toggleColumnPin(event, columnName) {
    event.stopPropagation();
    if (state.pinnedColumns.has(columnName)) {
        state.pinnedColumns.delete(columnName);
    } else {
        state.pinnedColumns.add(columnName);
    }
    renderDataGrid();
}

// Row Pinning
export function toggleRowPin(event, rowId) {
    event.stopPropagation();
    if (state.pinnedRowIds.has(rowId)) {
        state.pinnedRowIds.delete(rowId);
    } else {
        state.pinnedRowIds.add(rowId);
    }
    renderDataGrid();
}

// Column Resizing
export function startColumnResize(event, columnName) {
    event.stopPropagation();
    state.resizingColumn = columnName;
    state.resizeStartX = event.clientX;
    state.resizeStartWidth = state.columnWidths[columnName] || 120;

    const handle = event.target;
    handle.classList.add('resizing');

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    document.addEventListener('mousemove', onColumnResize);
    document.addEventListener('mouseup', stopColumnResize);
}

function onColumnResize(event) {
    if (!state.resizingColumn) return;
    const deltaX = event.clientX - state.resizeStartX;
    const newWidth = Math.max(30, state.resizeStartWidth + deltaX);
    state.columnWidths[state.resizingColumn] = newWidth;

    const colIdx = state.tableColumns.findIndex(c => c.name === state.resizingColumn);
    if (colIdx === -1) return;

    // Direct DOM update for performance
    const headerCell = document.querySelector(`th[data-column="${state.resizingColumn}"]`);
    if (headerCell) {
        headerCell.style.width = `${newWidth}px`;
        headerCell.style.minWidth = `${newWidth}px`;
        headerCell.style.maxWidth = `${newWidth}px`;
    }

    // Need to account for pinned columns offsets potentially changing if we resize a pinned column
    // But for now just updating the cells is enough visually
    const dataCells = document.querySelectorAll(`.data-row td:nth-child(${colIdx + 2})`); // +2 because nth-child is 1-based and we have row number column
    for (const cell of dataCells) {
        cell.style.width = `${newWidth}px`;
        cell.style.minWidth = `${newWidth}px`;
        cell.style.maxWidth = `${newWidth}px`;
    }

    // If we are resizing a pinned column, we might need to re-render to update subsequent pinned columns' left offsets
    if (state.pinnedColumns.has(state.resizingColumn)) {
        // Debounce full re-render? Or just let it be slightly off during drag?
        // Full re-render is heavy. Let's leave it for stopColumnResize
    }
}

function stopColumnResize() {
    if (!state.resizingColumn) return;

    const handle = document.querySelector('.resize-handle.resizing');
    if (handle) handle.classList.remove('resizing');

    state.resizingColumn = null;
    document.removeEventListener('mousemove', onColumnResize);
    document.removeEventListener('mouseup', stopColumnResize);

    document.body.style.userSelect = '';
    document.body.style.cursor = '';

    // Full re-render to ensure pinned columns are correct
    renderDataGrid();
}

// Row Selection
export function onRowClick(event, rowId, rowIdx) {
    // Selection logic handled in onRowNumberClick mostly, but we can support clicking anywhere on row
    // But we need to distinguish from cell selection.
    // Viewer.js `onRowClick` was empty/not used for selection logic except triggering fire event?
    // Looking at viewer.js: onRowClick was defined but empty in logic I saw?
    // Wait, viewer.js `onRowClick` had: `data-rowid="${rowId}" data-rowidx="${rowIdx}" onclick="onRowClick(event, ${rowId}, ${rowIdx})"`
    // But I didn't see the implementation in the snippets.
    // Let's assume standard row selection if not clicking a cell with content.
}

export function onRowNumberClick(event, rowId) {
    event.stopPropagation();

    // Clear cell selection
    state.selectedCells = [];
    state.lastSelectedCell = null;
    state.selectedColumns.clear();

    if (event.ctrlKey || event.metaKey) {
        if (state.selectedRowIds.has(rowId)) {
            state.selectedRowIds.delete(rowId);
        } else {
            state.selectedRowIds.add(rowId);
        }
    } else {
        if (state.selectedRowIds.has(rowId) && state.selectedRowIds.size === 1) {
            state.selectedRowIds.delete(rowId);
        } else {
            state.selectedRowIds.clear();
            state.selectedRowIds.add(rowId);
        }
    }

    updateSelectionStates();
    updateToolbarButtons();
    updateBatchSidebar();
}

export function onSelectAllClick(event) {
    event.stopPropagation();
    if (state.gridData.length === 0) return;

    state.selectedCells = [];
    state.lastSelectedCell = null;
    state.selectedColumns.clear();

    // Check if all rows on current page are selected
    let allSelected = true;
    for (let i = 0; i < state.gridData.length; i++) {
        const id = getRowId(state.gridData[i], i);
        if (!state.selectedRowIds.has(id)) {
            allSelected = false;
            break;
        }
    }

    if (allSelected) {
        // If all selected, deselect all
        state.selectedRowIds.clear();
    } else {
        // Otherwise, select all (union)
        for (let i = 0; i < state.gridData.length; i++) {
            const id = getRowId(state.gridData[i], i);
            state.selectedRowIds.add(id);
        }
    }

    updateSelectionStates();
    updateToolbarButtons();
    updateBatchSidebar();
}

// Cell Click (Selection)
export function onCellClick(event, rowIdx, colIdx, rowId) {
    event.stopPropagation();
    if (state.isLoadingData || state.isSavingCell || state.isTransitioningEdit || state.editingCellInfo) return;

    const value = state.gridData[rowIdx] ? getCellValue(state.gridData[rowIdx], colIdx) : null;

    // Range selection
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && state.lastSelectedCell) {
        state.selectedRowIds.clear();

        const minRow = Math.min(state.lastSelectedCell.rowIdx, rowIdx);
        const maxRow = Math.max(state.lastSelectedCell.rowIdx, rowIdx);
        const minCol = Math.min(state.lastSelectedCell.colIdx, colIdx);
        const maxCol = Math.max(state.lastSelectedCell.colIdx, colIdx);

        // Optimization: Use Set for fast lookup of existing selected cells
        const existingSet = new Set();
        for (const sc of state.selectedCells) {
            existingSet.add(`${sc.rowIdx},${sc.colIdx}`);
        }

        for (let r = minRow; r <= maxRow; r++) {
            for (let c = minCol; c <= maxCol; c++) {
                // Check against Set instead of Array.some()
                if (!existingSet.has(`${r},${c}`)) {
                    const rId = getRowId(state.gridData[r], r);
                    const val = getCellValue(state.gridData[r], c);
                    state.selectedCells.push({ rowIdx: r, colIdx: c, rowId: rId, value: val });
                    // Add to Set to prevent duplicates if we encounter same cell again (unlikely here but good practice)
                    existingSet.add(`${r},${c}`);
                }
            }
        }
    }
    // Multi selection
    else if (event.metaKey || event.ctrlKey) {
        state.selectedRowIds.clear();
        const existingIdx = state.selectedCells.findIndex(sc => sc.rowIdx === rowIdx && sc.colIdx === colIdx);
        if (existingIdx >= 0) {
            state.selectedCells.splice(existingIdx, 1);
        } else {
            state.selectedCells.push({ rowIdx, colIdx, rowId, value });
            state.lastSelectedCell = { rowIdx, colIdx };
        }
    }
    // Shift selection (range from last)
    else if (event.shiftKey && state.lastSelectedCell) {
        state.selectedRowIds.clear();
        state.selectedCells = []; // Reset and select range

        const minRow = Math.min(state.lastSelectedCell.rowIdx, rowIdx);
        const maxRow = Math.max(state.lastSelectedCell.rowIdx, rowIdx);
        const minCol = Math.min(state.lastSelectedCell.colIdx, colIdx);
        const maxCol = Math.max(state.lastSelectedCell.colIdx, colIdx);

        for (let r = minRow; r <= maxRow; r++) {
            for (let c = minCol; c <= maxCol; c++) {
                const rId = getRowId(state.gridData[r], r);
                const val = getCellValue(state.gridData[r], c);
                state.selectedCells.push({ rowIdx: r, colIdx: c, rowId: rId, value: val });
            }
        }
    }
    // Single selection
    else {
        state.selectedRowIds.clear();
        state.selectedCells = [{ rowIdx, colIdx, rowId, value }];
        state.lastSelectedCell = { rowIdx, colIdx };
        state.selectedColumns.clear();
    }

    updateSelectionStates();
    updateToolbarButtons();
    updateBatchSidebar();
}

export function clearSelection() {
    state.selectedCells = [];
    state.selectedRowIds.clear();
    state.selectedColumns.clear();
    state.lastSelectedCell = null;

    updateSelectionStates();
    updateToolbarButtons();
    updateBatchSidebar();
}

// Cell Double Click (Edit)
export function onCellDoubleClick(event, rowIdx, colIdx, rowId) {
    if (state.cellEditBehavior === 'vscode') {
        // Need to simulate opening preview first to set state.cellPreviewInfo if openCellInVsCode depends on it?
        // openCellInVsCode uses state.cellPreviewInfo.
        // We should refactor openCellInVsCode or set the info directly.

        // Actually openCellInVsCode requires state.cellPreviewInfo to be set.
        // And openCellPreview sets it.
        // Let's manually set it or refactor.
        // Refactoring openCellInVsCode to take params is better, but for now let's set state.

        const column = state.tableColumns[colIdx];
        if (!column) return;
        const row = state.gridData[rowIdx];
        if (!row) return;
        const value = getCellValue(row, colIdx);

        state.cellPreviewInfo = {
            rowIdx,
            colIdx,
            rowId,
            columnName: column.name,
            originalValue: value
        };
        openCellInVsCode();

    } else if (state.cellEditBehavior === 'modal') {
        openCellPreview(rowIdx, colIdx, rowId);
    } else {
        startCellEdit(rowIdx, colIdx, rowId);
    }
}
