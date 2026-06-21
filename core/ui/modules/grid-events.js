import { state, persistState } from './state.js';
import {
    goToPage,
    onFilterChange,
    onPageSizeChange,
    onDateFormatChange,
    startColumnResize,
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

export function initGridControls() {
    document.getElementById('filterInput')?.addEventListener('keyup', onFilterChange);
    document.getElementById('pageSizeSelect')?.addEventListener('change', onPageSizeChange);
    document.getElementById('dateFormatSelect')?.addEventListener('change', onDateFormatChange);

    document.getElementById('btnFirst')?.addEventListener('click', () => goToPage(0));
    document.getElementById('btnPrev')?.addEventListener('click', () => goToPage(state.currentPageIndex - 1));
    document.getElementById('btnNext')?.addEventListener('click', () => goToPage(state.currentPageIndex + 1));
    document.getElementById('btnLast')?.addEventListener('click', () => goToPage(state.totalPageCount - 1));
}

export function initGridInteraction() {
    const container = document.getElementById('gridContainer');
    if (!container) return;

    container.addEventListener('mousedown', handleMousedown);
    container.addEventListener('keydown', handleKeydown);
    container.addEventListener('click', handleClick);
    container.addEventListener('dblclick', handleDoubleClick);
    container.addEventListener('mouseover', handleMouseover);
    container.addEventListener('scroll', handleScroll, { passive: true });
}

function handleMousedown(event) {
    if (event.target.classList.contains('resize-handle')) {
        event.stopPropagation();
        const headerCell = event.target.closest('.header-cell');
        if (headerCell && headerCell.dataset.column) {
            startColumnResize(event, headerCell.dataset.column);
        }
    }
}

function handleKeydown(event) {
    // Ignore filter Enter while a load is in flight: acting now would queue a
    // concurrent reload and operate against the stale, soon-to-be-replaced grid.
    if (state.isLoadingData) return;
    if (event.target.classList.contains('column-filter')) {
        const colName = event.target.dataset.column;
        if (colName) onColumnFilterKeydown(event, colName);
    }
}

function handleClick(event) {
    // Block grid selection/sort/filter/pin clicks while a load is in flight. The
    // flicker fix keeps the previous grid visible during a same-table refetch, so
    // without this guard a click on the stale row numbers or cells could select
    // (and then delete) rows from the old result set before the new data arrives.
    if (state.isLoadingData) return;
    const target = event.target;
    if (target.closest('.grid-header')) {
        handleHeaderClick(event, target);
        return;
    }
    handleBodyClick(event, target);
}

function handleHeaderClick(event, target) {
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
        onCellClick(event, rowIdx, colIdx, rowId);
        return;
    }
}

function handleDoubleClick(event) {
    // Don't open a cell editor on stale cells while a refetch is in flight.
    if (state.isLoadingData) return;
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
    // Ignore scroll while a load is in flight. The flicker fix keeps the grid
    // mounted and scrollable during a refetch; without this, scrolling the old
    // page during a page change (which reset scrollPosition to {0,0}) would
    // overwrite the reset and reopen the new page at a stale offset. Same-table
    // filter/sort refetches still preserve scroll via the post-await re-capture
    // in loadTableData, which reads the live DOM position directly.
    if (state.isLoadingData) return;
    const container = event.currentTarget;
    state.scrollPosition.left = container.scrollLeft;
    state.scrollPosition.top = container.scrollTop;
    persistState();
}

function resolveRowIdType(idStr) {
    if (idStr === undefined || idStr === null) return idStr;
    // Row IDs in SQLite are integers, but if using 'WITHOUT ROWID' tables, PK could be anything.
    // However, for standard tables, we try to keep them as numbers to match what the backend returns.
    const num = Number(idStr);
    return !isNaN(num) && idStr.trim() !== '' ? num : idStr;
}
