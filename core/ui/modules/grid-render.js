import { state } from './state.js';
import { formatCellValueAsText, appendHighlightedText } from './utils.js';
import { buildCellHighlightMatcher, formatCellValueForActiveMatch } from './match-nav.js';
import {
    getRowId,
    getCellValue,
    getCellValueForDisplay,
    getExactIntegerText,
    getOversizedCellMetadata,
    getReadOnlyRowReason,
    getCellMutationBlockReason,
    getOrderedColumnIndices
} from './data-utils.js';
import { syncSelectionDOM } from './grid-selection.js';

const OVERSIZED_BLOB_PREVIEW_BYTES = 16;
export const MIN_COLUMN_WIDTH = 30;
export const MAX_COLUMN_WIDTH = 10000;

// ================================================================
// VIRTUALIZED ROW WINDOW
//
// Rows are uniform height (26px, single-line clamped by CSS), which the
// pinned-row sticky offsets below already rely on. That lets large pages
// render only a window of rows around the viewport, with two spacer <tr>s
// whose heights stand in for the unmaterialized rows — total scrollHeight
// (and therefore every scrollTop the rest of the code persists/restores)
// is identical to a full render. Pinned rows are always materialized: they
// are position:sticky and permanently visible.
//
// Everything the grid paints (selection, match highlight, stripes, read-only
// markers) derives from `state`, so materializing a row late produces exactly
// the DOM a full render would have produced. Code that addresses a row's DOM
// directly must either tolerate absence (updateCellDom, selection diffing —
// they already do) or call ensureGridRowMaterialized() first (match nav,
// startCellEdit).
// ================================================================

export const GRID_ROW_HEIGHT = 26;
export const GRID_HEADER_HEIGHT = 52;
// Rows materialized beyond each edge of the visible range.
export const VIRTUAL_ROW_OVERSCAN = 20;
// Re-center the window when the visible range gets this close to a
// materialized edge. Must be < VIRTUAL_ROW_OVERSCAN so a freshly centered
// window never immediately re-triggers.
export const VIRTUAL_EDGE_TRIGGER = 10;
// Pages up to this many viewports of rows render fully (no window overhead).
export const VIRTUAL_SMALL_PAGE_FACTOR = 1.5;

// Metadata for the currently mounted windowed tbody, or null when the last
// render was a full render (small page / unknown viewport) or no grid is
// mounted. Reset at the top of every renderDataGrid call.
let virtualWindow = null;

function readViewportHeight(container) {
    const height = container ? container.clientHeight : undefined;
    return typeof height === 'number' && Number.isFinite(height) && height > 0
        ? height
        : null;
}

function toFiniteScrollTop(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Unpinned display positions [first, last] intersecting the viewport band not
 * occluded by the sticky header and sticky pinned rows. Row j's layout top is
 * HEADER + pinnedCount*ROW + j*ROW and the occluded band has the same height,
 * so the offsets cancel for `first`; `last` still depends on them.
 */
export function computeVisibleRowRange(scrollTop, viewportHeight, pinnedCount, totalRows) {
    const maxIndex = Math.max(0, totalRows - 1);
    const first = Math.min(Math.floor(scrollTop / GRID_ROW_HEIGHT), maxIndex);
    const usableHeight = viewportHeight - GRID_HEADER_HEIGHT - pinnedCount * GRID_ROW_HEIGHT;
    const last = Math.min(
        Math.max(Math.ceil((scrollTop + usableHeight) / GRID_ROW_HEIGHT) - 1, first),
        maxIndex
    );
    return { first, last };
}

/** Materialization bounds [start, end) for a visible range, overscan applied. */
export function windowFromVisible(visible, totalRows, overscan = VIRTUAL_ROW_OVERSCAN) {
    return {
        start: Math.max(0, visible.first - overscan),
        end: Math.min(totalRows, visible.last + 1 + overscan)
    };
}

/**
 * Whether the rendered window must be rebuilt for the current visible range:
 * always when coverage broke (fast fling past the overscan), otherwise when
 * the visible range drifted within VIRTUAL_EDGE_TRIGGER rows of a window edge
 * that still has rows beyond it.
 */
export function virtualWindowNeedsUpdate(
    start,
    end,
    firstVisible,
    lastVisible,
    totalRows,
    trigger = VIRTUAL_EDGE_TRIGGER
) {
    if (firstVisible < start || lastVisible >= end) return true;
    if (start > 0 && firstVisible - start < trigger) return true;
    if (end < totalRows && end - 1 - lastVisible < trigger) return true;
    return false;
}

/**
 * Decide the initial materialization window for a render, or null to render
 * every row: unknown/zero viewport (hidden container, minimal test DOMs) and
 * pages within VIRTUAL_SMALL_PAGE_FACTOR viewports both take the full-render
 * path, which is byte-for-byte today's DOM.
 */
export function planVirtualRowWindow(scrollTop, viewportHeight, pinnedCount, totalRows) {
    if (viewportHeight === null || !Number.isFinite(viewportHeight) || viewportHeight <= 0) {
        return null;
    }
    const viewportRows = Math.ceil(viewportHeight / GRID_ROW_HEIGHT);
    if (totalRows <= Math.ceil(viewportRows * VIRTUAL_SMALL_PAGE_FACTOR)) return null;
    const visible = computeVisibleRowRange(
        toFiniteScrollTop(scrollTop), viewportHeight, pinnedCount, totalRows
    );
    return windowFromVisible(visible, totalRows);
}

/** Rendered window bounds, or null when the grid is fully materialized. */
export function getVirtualWindowBounds() {
    return virtualWindow ? { start: virtualWindow.start, end: virtualWindow.end } : null;
}

function createSpacerRow(columnCount) {
    const tr = document.createElement('tr');
    tr.className = 'virtual-spacer';
    tr.setAttribute?.('aria-hidden', 'true');
    const td = document.createElement('td');
    td.colSpan = columnCount;
    // Inline zeroing beats a stylesheet rule here: the spacer must be exactly
    // rowCount * GRID_ROW_HEIGHT regardless of UA default td padding.
    Object.assign(td.style, { padding: '0', border: '0', height: '0px' });
    tr.appendChild(td);
    return { tr, td };
}

function setSpacerHeight(spacer, rowCount) {
    const px = `${Math.max(0, rowCount) * GRID_ROW_HEIGHT}px`;
    spacer.td.style.height = px;
    spacer.tr.style.height = px;
}

// ================================================================
// ROW / CELL CONSTRUCTION
// ================================================================

function formatOversizedPreview(value, metadata, ordinaryDisplayValue) {
    const preview = metadata.storageClass === 'blob' && value instanceof Uint8Array
        ? Array.from(value.subarray(0, OVERSIZED_BLOB_PREVIEW_BYTES), byte => (
            byte.toString(16).padStart(2, '0')
        )).join(' ')
        : ordinaryDisplayValue;
    const byteUnit = metadata.byteLength === 1 ? 'byte' : 'bytes';
    return {
        preview,
        details: (
            `… · ${metadata.storageClass.toUpperCase()} · ` +
            `${metadata.byteLength.toLocaleString()} ${byteUnit} · ` +
            `full byte-exact value not shown in grid`
        )
    };
}

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
    const rowHeaderContent = document.createElement('div');
    rowHeaderContent.className = 'header-content';
    const selectAllButton = document.createElement('button');
    selectAllButton.type = 'button';
    selectAllButton.className = 'grid-icon-button row-select-all-button';
    selectAllButton.textContent = '#';
    selectAllButton.title = 'Select all rows on this page';
    selectAllButton.ariaLabel = 'Select all rows on this page';
    rowHeaderContent.appendChild(selectAllButton);
    rowNumTh.appendChild(rowHeaderContent);
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

        const pinClass = isPinned ? 'pinned' : '';
        const pinTitle = isPinned ? 'Unpin column' : 'Pin column';
        const matchCounterText = state.matchNav.scope === col.name && state.matchNav.matches.length > 0
            ? `${state.matchNav.currentIndex + 1}/${state.matchNav.matches.length}`
            : '';

        const headerContent = document.createElement('div');
        headerContent.className = 'header-content';
        const headerTop = document.createElement('div');
        headerTop.className = 'header-top';

        const sortButton = document.createElement('button');
        sortButton.type = 'button';
        sortButton.className = 'header-sort-button';
        sortButton.title = `Sort by ${col.name}`;
        sortButton.ariaLabel = `Sort by ${col.name}`;

        if (col.isPrimaryKey) {
            const keyIcon = document.createElement('span');
            keyIcon.className = 'key-icon codicon codicon-key';
            keyIcon.title = 'Primary Key';
            sortButton.appendChild(keyIcon);
        }

        const headerText = document.createElement('span');
        headerText.className = 'header-text';
        headerText.textContent = col.name;
        sortButton.appendChild(headerText);

        if (isSorted) {
            const sortIndicator = document.createElement('span');
            sortIndicator.className = 'sort-indicator';
            sortIndicator.textContent = state.sortAscending ? '▲' : '▼';
            sortButton.appendChild(sortIndicator);
        }

        headerTop.appendChild(sortButton);

        const selectColumnIcon = document.createElement('button');
        selectColumnIcon.type = 'button';
        selectColumnIcon.className = 'select-column-icon codicon codicon-selection';
        selectColumnIcon.title = 'Select entire column';
        selectColumnIcon.ariaLabel = `Select column ${col.name}`;
        headerTop.appendChild(selectColumnIcon);

        const pinIcon = document.createElement('button');
        pinIcon.type = 'button';
        pinIcon.className = `pin-icon codicon codicon-pin ${pinClass}`;
        pinIcon.title = pinTitle;
        pinIcon.ariaLabel = `${pinTitle} ${col.name}`;
        pinIcon.setAttribute?.('aria-pressed', String(isPinned));
        headerTop.appendChild(pinIcon);
        headerContent.appendChild(headerTop);

        const headerBottom = document.createElement('div');
        headerBottom.className = 'header-bottom';
        const filterWrap = document.createElement('div');
        filterWrap.className = 'column-filter-wrap';
        const filterInput = document.createElement('input');
        filterInput.type = 'text';
        filterInput.className = 'column-filter';
        filterInput.dataset.column = col.name;
        filterInput.value = filterValue;
        filterInput.placeholder = 'Filter...';
        filterInput.ariaLabel = `Filter column ${col.name}`;
        filterWrap.appendChild(filterInput);

        const clearFilterButton = document.createElement('button');
        clearFilterButton.type = 'button';
        clearFilterButton.className = 'filter-clear-btn';
        clearFilterButton.dataset.column = col.name;
        clearFilterButton.ariaLabel = `Clear filter for ${col.name}`;
        clearFilterButton.title = `Clear filter for ${col.name}`;
        clearFilterButton.hidden = filterValue.length === 0;
        const clearIcon = document.createElement('span');
        clearIcon.className = 'codicon codicon-close';
        clearFilterButton.appendChild(clearIcon);
        filterWrap.appendChild(clearFilterButton);

        const matchCounter = document.createElement('span');
        matchCounter.className = 'column-filter-counter';
        matchCounter.dataset.column = col.name;
        matchCounter.textContent = matchCounterText;
        filterWrap.appendChild(matchCounter);
        headerBottom.appendChild(filterWrap);

        const applyFilterButton = document.createElement('button');
        applyFilterButton.type = 'button';
        applyFilterButton.className = 'filter-apply-btn';
        applyFilterButton.title = 'Apply filter — Enter: next match, Shift+Enter: previous';
        applyFilterButton.ariaLabel = `Search column ${col.name}`;
        const searchIcon = document.createElement('span');
        searchIcon.className = 'codicon codicon-search';
        applyFilterButton.appendChild(searchIcon);
        headerBottom.appendChild(applyFilterButton);
        headerContent.appendChild(headerBottom);
        th.appendChild(headerContent);

        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'resize-handle';
        resizeHandle.tabIndex = 0;
        resizeHandle.dataset.column = col.name;
        resizeHandle.setAttribute?.('role', 'separator');
        resizeHandle.setAttribute?.('aria-label', `Resize column ${col.name}`);
        resizeHandle.setAttribute?.('aria-orientation', 'vertical');
        resizeHandle.setAttribute?.('aria-valuemin', String(MIN_COLUMN_WIDTH));
        resizeHandle.setAttribute?.('aria-valuemax', String(MAX_COLUMN_WIDTH));
        resizeHandle.setAttribute?.('aria-valuenow', String(colWidth));
        th.appendChild(resizeHandle);
        headerTr.appendChild(th);
    }
    thead.appendChild(headerTr);
    return thead;
}

/**
 * Selection keys and the active match are the only row inputs that can change
 * between the initial render and later window materializations, so they are
 * recomputed per render pass instead of being cached in the row context.
 */
function computeDynamicRowState() {
    const selectedCellKeys = new Set();
    if (state.selectedCells.length > 0) {
        for (const cell of state.selectedCells) {
            selectedCellKeys.add(`${cell.rowIdx},${cell.colIdx}`);
        }
    }
    const activeMatch = state.matchNav.currentIndex >= 0
        ? state.matchNav.matches[state.matchNav.currentIndex]
        : null;
    return { selectedCellKeys, activeMatch };
}

/**
 * Build one data <tr> exactly as a full render would. `displayOrdinal` is the
 * row's position in display order (pinned rows first) across the WHOLE page,
 * independent of the materialization window — it keys the zebra stripe, which
 * therefore stays put as the window moves (the former :nth-child rule would
 * flip with DOM parity).
 */
function buildDataRow(ctx, dyn, rowIdx, displayOrdinal) {
    const row = state.gridData[rowIdx];
    const rowId = getRowId(row, rowIdx);
    const isSelected = state.selectedRowIds.has(rowId);
    const isRowPinned = state.pinnedRowIds.has(rowId);
    const readOnlyRowReason = getReadOnlyRowReason(rowIdx);
    const isStriped = displayOrdinal % 2 === 1;

    const tr = document.createElement('tr');
    tr.id = `row-${rowIdx}`;
    tr.className = `data-row ${isStriped ? 'stripe-even' : ''} ${isSelected ? 'selected' : ''} ${isRowPinned ? 'pinned' : ''} ${readOnlyRowReason ? 'read-only-row' : ''}`;
    tr.dataset.rowid = rowId;
    tr.dataset.rowidx = rowIdx;
    if (readOnlyRowReason) tr.title = readOnlyRowReason;

    if (isRowPinned) {
        tr.style.top = `${ctx.pinnedRowOffsets.get(rowId)}px`;
    }

    const rowNumTd = document.createElement('td');
    rowNumTd.className = 'data-cell row-number';
    Object.assign(rowNumTd.style, {
        width: `${ctx.rowNumWidth}px`,
        minWidth: `${ctx.rowNumWidth}px`,
        maxWidth: `${ctx.rowNumWidth}px`,
        position: 'sticky',
        left: '0',
        zIndex: isRowPinned ? '8' : '2'
    });

    const rowNumVal = state.currentPageIndex * state.rowsPerPage + rowIdx + 1;
    // Use DOM methods instead of innerHTML for consistency with XSS prevention patterns
    const rowSelectButton = document.createElement('button');
    rowSelectButton.type = 'button';
    rowSelectButton.className = 'row-select-button';
    rowSelectButton.textContent = String(rowNumVal);
    rowSelectButton.ariaLabel = `Select row ${rowNumVal}`;
    rowNumTd.appendChild(rowSelectButton);
    const pinButton = document.createElement('button');
    pinButton.type = 'button';
    pinButton.className = `pin-icon codicon codicon-pin ${isRowPinned ? 'pinned' : ''}`;
    pinButton.title = isRowPinned ? 'Unpin row' : 'Pin row';
    pinButton.ariaLabel = `${pinButton.title} ${rowNumVal}`;
    pinButton.setAttribute?.('aria-pressed', String(isRowPinned));
    rowNumTd.appendChild(pinButton);
    tr.appendChild(rowNumTd);

    for (let displayColIdx = 0; displayColIdx < ctx.orderedColumns.length; displayColIdx++) {
        const col = ctx.orderedColumns[displayColIdx];
        const originalColIdx = ctx.columnIndexMap.get(col.name);
        const value = getCellValue(row, originalColIdx);
        const isNull = value === null || value === undefined;
        const isCellSelected = dyn.selectedCellKeys.has(`${rowIdx},${originalColIdx}`);
        const isColPinned = state.pinnedColumns.has(col.name);
        const oversizedMetadata = getOversizedCellMetadata(rowIdx, originalColIdx);
        // A bounded grid value is still viewable through the snapshot-backed
        // inspector. Hiding the affordance made containment look like data loss.
        const hasContent = !!oversizedMetadata || (!isNull && !(value instanceof Uint8Array));
        const colWidth = state.columnWidths[col.name] || 120;
        const isActiveMatch = !!dyn.activeMatch && dyn.activeMatch.rowIdx === rowIdx
            && dyn.activeMatch.colIdx === originalColIdx;
        const visibleValue = getCellValueForDisplay(row, rowIdx, originalColIdx);
        const exactIntegerText = getExactIntegerText(rowIdx, originalColIdx);
        const displayValue = isActiveMatch
            ? formatCellValueForActiveMatch(
                value,
                col,
                state.matchNav.term,
                exactIntegerText
            )
            : formatCellValueAsText(visibleValue, col.type, state.dateFormat, col.name);

        const td = document.createElement('td');
        td.id = `cell-${rowIdx}-${originalColIdx}`;
        td.className = `data-cell ${isNull ? 'null-value' : ''} ${isCellSelected ? 'cell-selected' : ''} ${isColPinned ? 'pinned' : ''} ${isActiveMatch ? 'active-match-cell' : ''} ${oversizedMetadata ? 'oversized-cell' : ''}`;
        td.dataset.rowidx = rowIdx;
        td.dataset.colidx = originalColIdx;
        const isKeyboardTarget = ctx.keyboardTarget?.rowIdx === rowIdx
            && ctx.keyboardTarget?.colIdx === originalColIdx;
        td.tabIndex = isKeyboardTarget ? 0 : -1;
        td.dataset.gridTabstop = String(isKeyboardTarget);
        const mutationBlockReason = getCellMutationBlockReason(rowIdx, originalColIdx);
        if (mutationBlockReason) {
            td.title = mutationBlockReason;
        }

        Object.assign(td.style, {
            width: `${colWidth}px`,
            minWidth: `${colWidth}px`,
            maxWidth: `${colWidth}px`
        });

        if (hasContent) td.style.position = 'relative';

        if (isColPinned) {
            td.style.position = 'sticky';
            td.style.left = `${ctx.pinnedColumnOffsets.get(col.name)}px`;
        }

        const textSpan = document.createElement('span');
        textSpan.className = 'cell-text';
        // Use DOM text nodes (never innerHTML) for security (prevents XSS).
        // formatCellValueAsText returns unescaped text suitable for textContent/text nodes.
        const oversizedDisplay = oversizedMetadata
            ? formatOversizedPreview(value, oversizedMetadata, displayValue)
            : undefined;
        appendHighlightedText(
            textSpan,
            oversizedDisplay?.preview ?? displayValue,
            buildCellHighlightMatcher(value, ctx.columnFilterValues[displayColIdx], exactIntegerText)
        );
        if (oversizedDisplay) {
            textSpan.appendChild(document.createTextNode(oversizedDisplay.details));
        }
        td.appendChild(textSpan);

        if (hasContent) {
            const expandButton = document.createElement('button');
            expandButton.type = 'button';
            expandButton.className = 'expand-icon codicon codicon-link-external';
            expandButton.title = 'View full content';
            expandButton.ariaLabel = `View full content for ${col.name}, row ${rowNumVal}`;
            td.appendChild(expandButton);
        }

        tr.appendChild(td);
    }
    return tr;
}

function createTableBody(ctx, hasActiveFilters) {
    const tbody = document.createElement('tbody');
    const dyn = computeDynamicRowState();
    const fragment = document.createDocumentFragment();

    // Pinned rows are position:sticky and always visible, so they are always
    // materialized regardless of the window. They come first in display order.
    let displayOrdinal = 0;
    for (const rowIdx of ctx.pinnedRowIndices) {
        fragment.appendChild(buildDataRow(ctx, dyn, rowIdx, displayOrdinal));
        displayOrdinal++;
    }

    if (!ctx.windowBounds) {
        for (const rowIdx of ctx.unpinnedRowIndices) {
            fragment.appendChild(buildDataRow(ctx, dyn, rowIdx, displayOrdinal));
            displayOrdinal++;
        }

        if (state.gridData.length === 0 && hasActiveFilters) {
            const tr = document.createElement('tr');
            tr.className = 'no-results-row';
            const td = document.createElement('td');
            td.colSpan = ctx.orderedColumns.length + 1;
            Object.assign(td.style, {
                textAlign: 'center',
                padding: '20px',
                color: 'var(--text-secondary)'
            });
            td.textContent = 'No rows match the current filter.';
            tr.appendChild(td);
            fragment.appendChild(tr);
        }

        tbody.appendChild(fragment);
        return tbody;
    }

    const { start, end } = ctx.windowBounds;
    const pinnedCount = ctx.pinnedRowIndices.length;
    const columnCount = ctx.orderedColumns.length + 1;

    const topSpacer = createSpacerRow(columnCount);
    setSpacerHeight(topSpacer, start);
    fragment.appendChild(topSpacer.tr);

    const windowRows = new Map();
    for (let j = start; j < end; j++) {
        const tr = buildDataRow(ctx, dyn, ctx.unpinnedRowIndices[j], pinnedCount + j);
        windowRows.set(j, tr);
        fragment.appendChild(tr);
    }

    const bottomSpacer = createSpacerRow(columnCount);
    setSpacerHeight(bottomSpacer, ctx.unpinnedRowIndices.length - end);
    fragment.appendChild(bottomSpacer.tr);

    tbody.appendChild(fragment);

    const unpinnedPositionByRowIdx = new Map();
    ctx.unpinnedRowIndices.forEach((rowIdx, position) => {
        unpinnedPositionByRowIdx.set(rowIdx, position);
    });

    virtualWindow = {
        tbody,
        topSpacer,
        bottomSpacer,
        windowRows,
        start,
        end,
        ctx,
        pinnedCount,
        totalUnpinned: ctx.unpinnedRowIndices.length,
        unpinnedPositionByRowIdx,
        // Identity of the page this window renders. In-place cell edits mutate
        // this same array; only a commit that REPLACED it (the editing-cell
        // render-skip in loadTableData) makes the mounted DOM diverge, which
        // updateVirtualGridWindow heals with a full re-render once editing ends.
        gridDataRef: state.gridData
    };

    return tbody;
}

// ================================================================
// WINDOW MAINTENANCE (scroll / resize / reveal)
// ================================================================

/**
 * Rebuild the materialized slice for [newStart, newEnd). Rows present in both
 * the old and new window are reused as-is — every post-render mutation
 * (selection classes, match highlight, updateCellDom rewrites) lands on the
 * live element, so a reused row is always current.
 */
function renderWindowRows(vw, newStart, newEnd) {
    const dyn = computeDynamicRowState();
    const pinnedCount = vw.pinnedCount;
    const newRows = new Map();
    for (let j = newStart; j < newEnd; j++) {
        const existing = vw.windowRows.get(j);
        newRows.set(
            j,
            existing ?? buildDataRow(vw.ctx, dyn, vw.ctx.unpinnedRowIndices[j], pinnedCount + j)
        );
    }
    for (const [j, tr] of vw.windowRows) {
        if (!newRows.has(j)) vw.tbody.removeChild(tr);
    }
    // Insert in ascending order before the bottom spacer; insertBefore also
    // moves reused rows, so the final order is correct without index math.
    for (const tr of newRows.values()) {
        vw.tbody.insertBefore(tr, vw.bottomSpacer.tr);
    }
    setSpacerHeight(vw.topSpacer, newStart);
    setSpacerHeight(vw.bottomSpacer, vw.totalUnpinned - newEnd);
    vw.windowRows = newRows;
    vw.start = newStart;
    vw.end = newEnd;
    syncSelectionDOM();
}

/**
 * The window freezes only while a live editor <textarea> could be rebuilt
 * away. An edit session whose editor DOM is gone — a failed deferred save
 * retained it after a table switch already wiped the old grid — must not
 * freeze the NEW grid's window: that blanks everything beyond the
 * materialized slice with no keyboard recovery (Escape is swallowed by the
 * editing guard and the textarea holding its handler no longer exists).
 */
function editorHoldsWindow() {
    // `!== false` rather than `=== true`: only a provably disconnected editor
    // releases the freeze, so minimal DOMs without isConnected keep today's
    // behavior while real browsers unfreeze the leaked-session case.
    return !!state.editingCellInfo && state.activeCellInput?.isConnected !== false;
}

/**
 * Revalidate the window against the live scroll position, rebuilding the
 * materialized slice when the visible range drifted near/past its edges.
 * No-ops while an inline cell edit is live — the DOM must stay frozen so
 * the editor's <textarea> survives (mirrors the render-skip in loadTableData);
 * cleanupCellEdit schedules a revalidation when the edit ends.
 * Returns true when it changed the DOM.
 */
export function updateVirtualGridWindow() {
    const vw = virtualWindow;
    if (!vw) return false;
    // The container was wiped (spinner, error view, table switch) since this
    // window was built: the metadata is dead, and rendering from it would
    // paint stale rows over the new content.
    if (vw.tbody.isConnected === false) {
        virtualWindow = null;
        return false;
    }
    if (editorHoldsWindow()) return false;
    // A background commit replaced the page under a skipped render. Re-render
    // from current state (captures the live scroll position, so the viewport
    // does not move).
    if (vw.gridDataRef !== state.gridData) {
        renderDataGrid();
        return true;
    }
    const container = document.getElementById('gridContainer');
    const viewportHeight = readViewportHeight(container);
    if (viewportHeight === null) return false;
    const scrollTop = toFiniteScrollTop(container.scrollTop);
    const visible = computeVisibleRowRange(
        scrollTop, viewportHeight, vw.pinnedCount, vw.totalUnpinned
    );
    if (!virtualWindowNeedsUpdate(vw.start, vw.end, visible.first, visible.last, vw.totalUnpinned)) {
        return false;
    }
    const next = windowFromVisible(visible, vw.totalUnpinned);
    renderWindowRows(vw, next.start, next.end);
    return true;
}

let windowUpdateScheduled = false;

/**
 * rAF-throttled window revalidation; the cheap no-op path makes it safe to
 * call from every scroll event. Falls back to a synchronous update where
 * requestAnimationFrame does not exist (unit tests), which also makes test
 * assertions deterministic.
 */
export function scheduleVirtualGridUpdate() {
    if (!virtualWindow) return;
    if (typeof requestAnimationFrame !== 'function') {
        updateVirtualGridWindow();
        return;
    }
    if (windowUpdateScheduled) return;
    windowUpdateScheduled = true;
    requestAnimationFrame(() => {
        windowUpdateScheduled = false;
        updateVirtualGridWindow();
    });
}

/**
 * Guarantee `row-<rowIdx>` / its cells exist in the DOM before a caller
 * addresses them by id (match navigation, programmatic cell edit). When the
 * row sits outside the materialized window, scroll it to the center of the
 * unoccluded band and rebuild the window synchronously; callers follow up
 * with revealGridCell for exact positioning. No-op when the grid is fully
 * materialized, and while an inline edit freezes the window (callers already
 * tolerate a missing cell there, matching pre-virtualization behavior).
 */
export function ensureGridRowMaterialized(rowIdx) {
    let vw = virtualWindow;
    if (!vw) return;
    if (editorHoldsWindow()) return;
    if (vw.tbody.isConnected === false) {
        virtualWindow = null;
        return;
    }
    if (vw.gridDataRef !== state.gridData) {
        renderDataGrid();
        vw = virtualWindow;
        if (!vw) return;
    }
    const position = vw.unpinnedPositionByRowIdx.get(rowIdx);
    // Pinned rows (and unknown indices) are always materialized / unreachable.
    if (position === undefined) return;
    if (position >= vw.start && position < vw.end) return;

    const container = document.getElementById('gridContainer');
    if (!container) return;
    const viewportHeight = readViewportHeight(container) ?? (
        GRID_HEADER_HEIGHT + GRID_ROW_HEIGHT * 10
    );
    const band = Math.max(
        viewportHeight - GRID_HEADER_HEIGHT - vw.pinnedCount * GRID_ROW_HEIGHT,
        GRID_ROW_HEIGHT
    );
    // Place the row mid-band: rowTop − scrollTop should equal (band − row)/2.
    container.scrollTop = Math.max(
        0,
        Math.round(position * GRID_ROW_HEIGHT - (band - GRID_ROW_HEIGHT) / 2)
    );
    updateVirtualGridWindow();
}

// ================================================================
// FULL GRID RENDER
// ================================================================

export function renderDataGrid(savedScrollTop = null, savedScrollLeft = null) {
    // Whatever window described the previous DOM is invalid the moment we
    // rebuild (or bail before rebuilding).
    virtualWindow = null;

    const headerHeight = GRID_HEADER_HEIGHT;
    const rowHeight = GRID_ROW_HEIGHT;

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

    // The container's own box height; independent of (and measured before
    // replacing) its content. null in environments without layout, which
    // falls back to rendering every row.
    const viewportHeight = readViewportHeight(container);

    const hasActiveFilters = Object.values(state.columnFilters).some(v => v && v.trim() !== '');

    // Clear container
    container.innerHTML = '';

    if (state.gridData.length === 0 && !hasActiveFilters && state.tableColumns.length === 0) {
        container.appendChild(createEmptyView());
        return;
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
    const orderedColumns = getOrderedColumnIndices().map(index => state.tableColumns[index]);

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

    // Row display order: pinned rows first, then unpinned — must mirror
    // getOrderedRowIndices(), which interaction code uses for traversal.
    const pinnedRowIndices = [];
    const unpinnedRowIndices = [];
    state.gridData.forEach((row, index) => {
        (state.pinnedRowIds.has(getRowId(row, index)) ? pinnedRowIndices : unpinnedRowIndices)
            .push(index);
    });

    // Sticky offsets for pinned rows (below the sticky header, stacked).
    const pinnedRowOffsets = new Map();
    for (let i = 0; i < pinnedRowIndices.length; i++) {
        const rowIdx = pinnedRowIndices[i];
        pinnedRowOffsets.set(getRowId(state.gridData[rowIdx], rowIdx), headerHeight + (i * rowHeight));
    }

    const columnFilterValues = orderedColumns.map(col =>
        [state.filterQuery, state.columnFilters[col.name]]
    );

    const ctx = {
        rowNumWidth,
        orderedColumns,
        columnIndexMap,
        pinnedColumnOffsets,
        pinnedRowOffsets,
        pinnedRowIndices,
        unpinnedRowIndices,
        columnFilterValues,
        windowBounds: planVirtualRowWindow(
            finalScrollTop,
            viewportHeight,
            pinnedRowIndices.length,
            unpinnedRowIndices.length
        )
    };

    const orderedColumnIndices = orderedColumns.map(column => columnIndexMap.get(column.name));
    const preferred = state.lastSelectedCell;
    const preferredRowPosition = preferred
        ? unpinnedRowIndices.indexOf(preferred.rowIdx)
        : -1;
    const preferredRowIsRendered = !!preferred && (
        pinnedRowIndices.includes(preferred.rowIdx)
        || !ctx.windowBounds
        || (preferredRowPosition >= ctx.windowBounds.start
            && preferredRowPosition < ctx.windowBounds.end)
    );
    const fallbackRowIdx = pinnedRowIndices[0]
        ?? unpinnedRowIndices[ctx.windowBounds?.start ?? 0];
    ctx.keyboardTarget = {
        rowIdx: preferredRowIsRendered ? preferred.rowIdx : fallbackRowIdx,
        colIdx: preferred && orderedColumnIndices.includes(preferred.colIdx)
            ? preferred.colIdx
            : orderedColumnIndices[0]
    };

    const tbody = createTableBody(ctx, hasActiveFilters);
    table.appendChild(tbody);

    container.appendChild(table);

    container.scrollLeft = finalScrollLeft;
    container.scrollTop = finalScrollTop;

    syncSelectionDOM();
}

export function updatePagination() {
    const boundPrefix = state.totalRecordCountIsExact ? '' : '≤';
    document.getElementById('pageIndicator').textContent =
        `${boundPrefix}${state.currentPageIndex + 1} / ${boundPrefix}${state.totalPageCount}`;
    document.getElementById('btnFirst').disabled = state.currentPageIndex === 0;
    document.getElementById('btnPrev').disabled = state.currentPageIndex === 0;
    document.getElementById('btnNext').disabled = state.currentPageIndex >= state.totalPageCount - 1;
    document.getElementById('btnLast').disabled = state.currentPageIndex >= state.totalPageCount - 1;
}
