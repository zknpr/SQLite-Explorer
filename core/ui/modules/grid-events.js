import { state, persistState } from './state.js';
import {
    goToPage,
    applyGlobalFilter,
    applyCurrentFilter,
    clearGlobalFilter,
    clearColumnFilter,
    onFilterInput,
    onFilterEnter,
    onPageSizeChange,
    onDateFormatChange,
    startColumnResize,
    onColumnResizeKeydown,
    onColumnFilterKeydown,
    applyColumnFilter,
    onColumnHeaderClick,
    toggleColumnPin,
    toggleRowPin,
    onSelectAllClick,
    onColumnSort,
    onRowNumberClick,
    onCellClick,
    onCellDoubleClick
} from './grid-actions.js';
import { openCellPreview } from './edit.js';
import { clearSelection } from './grid-selection.js';
import { ensureGridRowMaterialized, scheduleVirtualGridUpdate } from './grid-render.js';
import { validateRowId } from './utils.js';
import { getOrderedColumnIndices, getOrderedRowIndices } from './data-utils.js';

export function initGridControls() {
    const globalFilter = document.getElementById('filterInput');
    globalFilter?.addEventListener('input', onFilterInput);
    globalFilter?.addEventListener('compositionend', onFilterInput);
    globalFilter?.addEventListener('keydown', onFilterEnter);
    document.getElementById('btnClearFilter')?.addEventListener('click', clearGlobalFilter);
    // Wrap so the click MouseEvent isn't passed as `direction` (which would make
    // navigateMatches compute NaN); the Search button always advances forward.
    document.getElementById('btnApplyFilter')?.addEventListener('click', () => applyGlobalFilter(1));
    document.getElementById('pageSizeSelect')?.addEventListener('change', onPageSizeChange);
    document.getElementById('dateFormatSelect')?.addEventListener('change', onDateFormatChange);

    // The nav intent names the page's relationship to the current anchors so
    // loadTableData can seek (keyset) instead of scanning to OFFSET.
    document.getElementById('btnFirst')?.addEventListener('click', () => goToPage(0, 'first'));
    document.getElementById('btnPrev')?.addEventListener('click', () => goToPage(state.currentPageIndex - 1, 'prev'));
    document.getElementById('btnNext')?.addEventListener('click', () => goToPage(state.currentPageIndex + 1, 'next'));
    document.getElementById('btnLast')?.addEventListener('click', () => goToPage(state.totalPageCount - 1, 'last'));
}

export function initGridInteraction() {
    const container = document.getElementById('gridContainer');
    if (!container) return;

    container.addEventListener('mousedown', handleMousedown);
    container.addEventListener('input', handleFilterInput);
    container.addEventListener('compositionend', handleFilterInput);
    container.addEventListener('keydown', handleKeydown);
    container.addEventListener('focusin', handleFocusin);
    container.addEventListener('click', handleClick);
    container.addEventListener('dblclick', handleDoubleClick);
    container.addEventListener('mouseover', handleMouseover);
    container.addEventListener('scroll', handleScroll, { passive: true });
    document.addEventListener('click', handleDocumentClick);

    // A viewport that grows (window resize, panel toggle) can expose rows the
    // virtualized window has not materialized, and no scroll event fires for
    // that. Guarded: absent in the unit-test environment, where the full-render
    // fallback applies anyway. The container element lives for the webview's
    // lifetime, so the observer needs no disposal.
    if (typeof ResizeObserver === 'function') {
        new ResizeObserver(() => scheduleVirtualGridUpdate()).observe(container);
    }
}

function handleFilterInput(event) {
    if (event.target?.classList?.contains('column-filter')) onFilterInput(event);
}

function handleMousedown(event) {
    const target = event.target;
    if (event.shiftKey && typeof target.closest === 'function') {
        const isEditor = target.closest('.cell-input, input, textarea, [contenteditable="true"]');
        const isSelectionTarget = target.closest(
            '.data-cell, .row-number, .select-column-icon, .row-number-header'
        );
        if (!isEditor && isSelectionTarget) {
            // click.preventDefault() runs too late to stop the browser's native
            // drag/range text selection; suppress it at mousedown instead.
            event.preventDefault();
        }
    }

    if (target.classList.contains('resize-handle')) {
        event.stopPropagation();
        const headerCell = target.closest('.header-cell');
        if (headerCell && headerCell.dataset.column) {
            startColumnResize(event, headerCell.dataset.column);
        }
    }
}

function handleDocumentClick(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function' || state.editingCellInfo) return;
    if (target.closest(
        '.data-grid, [data-preserve-grid-selection], ' +
        '.modal-overlay, .cell-preview-modal'
    )) return;

    if (state.selectedCells.length > 0 ||
        state.selectedRowIds.size > 0 ||
        state.selectedColumns.size > 0) {
        clearSelection();
    }
}

function handleKeydown(event) {
    if (event.target?.classList?.contains('column-filter')) {
        const colName = event.target.dataset.column;
        if (colName) return onColumnFilterKeydown(event, colName);
        return;
    }

    if (event.target?.classList?.contains('resize-handle')) {
        const columnName = event.target.closest('.header-cell')?.dataset.column;
        if (columnName) onColumnResizeKeydown(event, columnName);
        return;
    }

    const interactiveControl = event.target?.closest?.(
        'input, textarea, button, select, a, [contenteditable="true"]'
    );
    if (interactiveControl) return;

    const cell = event.target?.closest?.('.data-cell');
    if (cell && !cell.classList.contains('row-number')) {
        if (state.isGridReloading && (event.key === ' ' || event.key === 'Enter')) {
            event.preventDefault();
            return;
        }
        const rowIdx = parseInt(cell.dataset.rowidx, 10);
        const colIdx = parseInt(cell.dataset.colidx, 10);
        const rowId = resolveRowIdType(cell.closest('.data-row')?.dataset.rowid);

        if (event.key.startsWith('Arrow')) {
            if (moveGridCellFocus(event, rowIdx, colIdx)) return;
        } else if (event.key === ' ') {
            event.preventDefault();
            onCellClick(event, rowIdx, colIdx, rowId);
            return;
        } else if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault();
            if (event.altKey) openCellPreview(rowIdx, colIdx, rowId);
            else onCellDoubleClick(event, rowIdx, colIdx, rowId);
            return;
        }
    }

    if (event.key === 'Enter' && !event.isComposing) {
        if (state.editingCellInfo) return;
        const pending = applyCurrentFilter(event.shiftKey ? -1 : 1);
        if (pending) {
            event.preventDefault();
            return pending;
        }
    }
}

function handleFocusin(event) {
    if (event.target?.classList?.contains('data-cell')
        && !event.target.classList.contains('row-number')) {
        setGridTabstop(event.target, false);
    }
}

function setGridTabstop(cell, focus = true) {
    const container = document.getElementById('gridContainer');
    const previous = container?.querySelector?.('.data-cell[data-grid-tabstop="true"]');
    if (previous && previous !== cell) {
        previous.tabIndex = -1;
        previous.dataset.gridTabstop = 'false';
    }
    cell.tabIndex = 0;
    cell.dataset.gridTabstop = 'true';
    if (focus) cell.focus?.();
}

function moveGridCellFocus(event, rowIdx, colIdx) {
    const rows = getOrderedRowIndices();
    const columns = getOrderedColumnIndices();
    let rowPosition = rows.indexOf(rowIdx);
    let columnPosition = columns.indexOf(colIdx);
    if (rowPosition < 0 || columnPosition < 0) return false;

    if (event.key === 'ArrowUp') rowPosition--;
    else if (event.key === 'ArrowDown') rowPosition++;
    else if (event.key === 'ArrowLeft') columnPosition--;
    else if (event.key === 'ArrowRight') columnPosition++;
    else return false;

    if (rowPosition < 0 || rowPosition >= rows.length
        || columnPosition < 0 || columnPosition >= columns.length) return false;

    event.preventDefault();
    event.stopPropagation();
    const targetRowIdx = rows[rowPosition];
    const targetColIdx = columns[columnPosition];
    ensureGridRowMaterialized(targetRowIdx);
    const target = document.getElementById(`cell-${targetRowIdx}-${targetColIdx}`);
    if (!target) return false;
    setGridTabstop(target);
    return true;
}

function handleClick(event) {
    // Block grid selection/sort/filter/pin clicks while a load is in flight. The
    // flicker fix keeps the previous grid visible during a same-table refetch, so
    // without this guard a click on the stale row numbers or cells could select
    // (and then delete) rows from the old result set before the new data arrives.
    const target = event.target;
    const isFilterControl = target.closest(
        '.filter-apply-btn, .filter-clear-btn, .column-filter'
    );
    if (state.isGridReloading && !isFilterControl) return;
    if (target.closest('.grid-header')) {
        handleHeaderClick(event, target);
        return;
    }
    handleBodyClick(event, target);
}

function handleHeaderClick(event, target) {
    // 1. Filter Clear Button
    const clearFilterButton = target.closest('.filter-clear-btn');
    if (clearFilterButton) {
        event.stopPropagation();
        const columnName = clearFilterButton.dataset.column
            || target.closest('.header-cell')?.dataset.column;
        if (columnName) return clearColumnFilter(columnName);
        return;
    }

    // 2. Filter Apply Button
    if (target.closest('.filter-apply-btn')) {
        event.stopPropagation();
        const headerCell = target.closest('.header-cell');
        if (headerCell && headerCell.dataset.column) {
            applyColumnFilter(headerCell.dataset.column);
        }
        return;
    }

    // 3. Prevent sort when clicking inputs/bottom area
    if (target.closest('.header-bottom') || target.closest('.column-filter')) {
        event.stopPropagation();
        return;
    }

    // 4. Column Selection Icon
    if (target.closest('.select-column-icon')) {
        event.stopPropagation();
        const headerCell = target.closest('.header-cell');
        if (headerCell && headerCell.dataset.column) {
            onColumnHeaderClick(event, headerCell.dataset.column);
        }
        return;
    }

    // 5. Header Pin Icon
    if (target.closest('.pin-icon')) {
        event.stopPropagation();
        const headerCell = target.closest('.header-cell');
        if (headerCell && headerCell.dataset.column) {
            toggleColumnPin(event, headerCell.dataset.column);
        }
        return;
    }

    // 6. Select All (Row Number Header)
    if (target.closest('.row-number-header')) {
        onSelectAllClick(event);
        return;
    }

    // 7. Sort
    const sortButton = target.closest('.header-sort-button');
    if (sortButton) {
        const headerCell = sortButton.closest('.header-cell');
        if (headerCell && headerCell.dataset.column) {
            onColumnSort(headerCell.dataset.column);
        }
        return;
    }
}

function handleBodyClick(event, target) {
    // 1. Row Pin Icon
    if (target.closest('.pin-icon')) {
        const rowEl = target.closest('.data-row');
        if (rowEl) {
            const rowId = rowEl.dataset.rowid;
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
            const rowIdx = parseInt(rowEl.dataset.rowidx, 10);
            onRowNumberClick(event, rowId, rowIdx);
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
        setGridTabstop(cellEl, false);
        onCellClick(event, rowIdx, colIdx, rowId);
        return;
    }
}

function handleDoubleClick(event) {
    // Don't open a cell editor on stale cells while a refetch is in flight.
    if (state.isGridReloading) return;
    const cellEl = event.target.closest('.data-cell');
    if (cellEl && !cellEl.classList.contains('row-number')) {
        const rowIdx = parseInt(cellEl.dataset.rowidx, 10);
        const colIdx = parseInt(cellEl.dataset.colidx, 10);
        const rowEl = cellEl.closest('.data-row');
        const rowId = resolveRowIdType(rowEl.dataset.rowid);
        onCellDoubleClick(event, rowIdx, colIdx, rowId);
    }
}

function handleMouseover(event) {
    const cell = event.target.closest('.data-cell');
    if (cell && !cell.classList.contains('checked-overflow')) {
        const textSpan = cell.querySelector('.cell-text');
        if (textSpan) {
            const hasOverflow = textSpan.scrollWidth > textSpan.clientWidth;
            cell.classList.toggle('has-overflow', hasOverflow);
            cell.classList.add('checked-overflow');
        }
    }
}

function handleScroll(event) {
    // Revalidate the virtualized row window on every scroll, BEFORE the reload
    // guard below: the flicker fix keeps the old grid mounted and scrollable
    // during a same-table refetch, and its rows must keep materializing. The
    // window renders from state.gridData, which still holds the rows the
    // mounted grid was built from until the load commits, so this is always
    // coherent. (rAF-throttled and a cheap no-op when the window is valid or
    // the page rendered fully.)
    scheduleVirtualGridUpdate();

    // Ignore scroll while a load is in flight. The flicker fix keeps the grid
    // mounted and scrollable during a refetch; without this, scrolling the old
    // page during a page change (which reset scrollPosition to {0,0}) would
    // overwrite the reset and reopen the new page at a stale offset. Same-table
    // filter/sort refetches still preserve scroll via the post-await re-capture
    // in loadTableData, which reads the live DOM position directly.
    if (state.isGridReloading) return;
    const container = event.currentTarget;
    state.scrollPosition.left = container.scrollLeft;
    state.scrollPosition.top = container.scrollTop;
    persistState();
}

export function resolveRowIdType(idStr) {
    if (idStr === undefined || idStr === null) return idStr;
    return validateRowId(idStr);
}
