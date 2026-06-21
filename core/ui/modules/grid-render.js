import { state } from './state.js';
import { escapeHtml, formatCellValueAsText } from './utils.js';
import { getRowId, getCellValue } from './data-utils.js';
import { syncSelectionDOM } from './grid-selection.js';

function createEmptyView() {
    const emptyView = document.createElement('div');
    emptyView.className = 'empty-view';
    emptyView.innerHTML = `
        <span class="empty-icon codicon codicon-database"></span>
        <span class="empty-title">No data</span>
        <span class="empty-desc">This table is empty</span>
    `;
    return emptyView;
}

function createTableHeader(rowNumWidth, orderedColumns, pinnedColumnOffsets) {
    const thead = document.createElement('thead');
    thead.className = 'grid-header';
    const headerTr = document.createElement('tr');

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
    rowNumTh.innerHTML = '<div class="header-content"><div class="header-top header-top-center">#</div></div>';
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
                    ${keyIcon}<span class="header-text">${safeColName}</span>${sortIndicator}
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
    return thead;
}

function createTableBody(orderedColumns, columnIndexMap, pinnedColumnOffsets, rowNumWidth, headerHeight, rowHeight, selectedCellKeys, hasActiveFilters) {
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
        // Use DOM methods instead of innerHTML for consistency with XSS prevention patterns
        rowNumTd.appendChild(document.createTextNode(String(rowNumVal)));
        const pinSpan = document.createElement('span');
        pinSpan.className = `pin-icon codicon codicon-pin ${isRowPinned ? 'pinned' : ''}`;
        pinSpan.title = isRowPinned ? 'Unpin row' : 'Pin row';
        rowNumTd.appendChild(pinSpan);
        tr.appendChild(rowNumTd);

        for (let displayColIdx = 0; displayColIdx < orderedColumns.length; displayColIdx++) {
            const col = orderedColumns[displayColIdx];
            const originalColIdx = columnIndexMap.get(col.name);
            const value = getCellValue(row, originalColIdx);
            const displayValue = formatCellValueAsText(value, col.type, state.dateFormat, col.name);
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
            // Use textContent for security (prevents XSS).
            // formatCellValueAsText returns unescaped text suitable for textContent.
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
    return tbody;
}

export function renderDataGrid(savedScrollTop = null, savedScrollLeft = null) {
    const headerHeight = 52;
    const rowHeight = 26;

    // Calculate row number column width based on the largest row number that will be displayed
    // Base width: 50px for up to 2 digits, add ~8px per additional digit
    const maxRowNum = state.currentPageIndex * state.rowsPerPage + state.gridData.length;
    const digitCount = Math.max(2, String(maxRowNum).length);
    const rowNumWidth = 36 + (digitCount * 8); // Base 36px + 8px per digit

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
        container.appendChild(createEmptyView());
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

    const thead = createTableHeader(rowNumWidth, orderedColumns, pinnedColumnOffsets);
    table.appendChild(thead);

    const tbody = createTableBody(orderedColumns, columnIndexMap, pinnedColumnOffsets, rowNumWidth, headerHeight, rowHeight, selectedCellKeys, hasActiveFilters);
    table.appendChild(tbody);

    container.appendChild(table);

    container.scrollLeft = finalScrollLeft;
    container.scrollTop = finalScrollTop;

    syncSelectionDOM();
}

export function updatePagination() {
    document.getElementById('pageIndicator').textContent = `${state.currentPageIndex + 1} / ${state.totalPageCount}`;
    document.getElementById('btnFirst').disabled = state.currentPageIndex === 0;
    document.getElementById('btnPrev').disabled = state.currentPageIndex === 0;
    document.getElementById('btnNext').disabled = state.currentPageIndex >= state.totalPageCount - 1;
    document.getElementById('btnLast').disabled = state.currentPageIndex >= state.totalPageCount - 1;
}
