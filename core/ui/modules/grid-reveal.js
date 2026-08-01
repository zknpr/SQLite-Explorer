/**
 * Grid viewport reveal helpers.
 *
 * Native scrollIntoView only considers the scrollport rectangle; it does not
 * subtract sticky headers, pinned rows, the row-number gutter, or pinned
 * columns. Resolve that occlusion once here so every programmatic grid focus
 * path lands in the actually visible portion of the grid.
 */

const STICKY_COLUMN_SELECTOR = [
    '.data-cell.row-number',
    '.header-cell.row-number-header',
    '.data-cell.pinned',
    '.header-cell.pinned'
].join(', ');

const STICKY_ROW_SELECTOR = [
    '.grid-header .header-cell',
    '.data-row.pinned .data-cell'
].join(', ');

function measuredRect(element) {
    if (!element || typeof element.getBoundingClientRect !== 'function') return null;
    const rect = element.getBoundingClientRect();
    if (!rect || ![rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)) {
        return null;
    }
    return rect;
}

function queryAll(container, selector) {
    if (typeof container.querySelectorAll !== 'function') return [];
    return container.querySelectorAll(selector);
}

function getVisibleLeft(container, containerRect, targetIsPinned) {
    if (targetIsPinned) return containerRect.left;
    let visibleLeft = containerRect.left;
    for (const element of queryAll(container, STICKY_COLUMN_SELECTOR)) {
        const rect = measuredRect(element);
        if (!rect || rect.right <= containerRect.left || rect.left >= containerRect.right) continue;
        visibleLeft = Math.max(visibleLeft, Math.min(rect.right, containerRect.right));
    }
    return visibleLeft;
}

function getVisibleTop(container, containerRect, targetIsPinned) {
    if (targetIsPinned) return containerRect.top;
    let visibleTop = containerRect.top;
    for (const element of queryAll(container, STICKY_ROW_SELECTOR)) {
        const rect = measuredRect(element);
        if (!rect || rect.bottom <= containerRect.top || rect.top >= containerRect.bottom) continue;
        visibleTop = Math.max(visibleTop, Math.min(rect.bottom, containerRect.bottom));
    }
    return visibleTop;
}

function nearestScrollDelta(start, end, visibleStart, visibleEnd) {
    if (start < visibleStart) return start - visibleStart;
    if (end > visibleEnd) return end - visibleEnd;
    return 0;
}

/** Reveal a data cell without leaving it underneath sticky grid regions. */
export function revealGridCell(cellElement) {
    if (!cellElement) return false;
    const container = document.getElementById('gridContainer');
    const containerRect = measuredRect(container);
    const cellRect = measuredRect(cellElement);

    if (!container || !containerRect || !cellRect) {
        cellElement.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        return true;
    }

    const targetIsPinnedColumn = cellElement.classList?.contains?.('pinned') ?? false;
    const targetIsPinnedRow = !!cellElement.closest?.('.data-row.pinned');
    const visibleLeft = getVisibleLeft(container, containerRect, targetIsPinnedColumn);
    const visibleTop = getVisibleTop(container, containerRect, targetIsPinnedRow);

    const horizontalDelta = targetIsPinnedColumn
        ? 0
        : nearestScrollDelta(cellRect.left, cellRect.right, visibleLeft, containerRect.right);
    const verticalDelta = targetIsPinnedRow
        ? 0
        : nearestScrollDelta(cellRect.top, cellRect.bottom, visibleTop, containerRect.bottom);

    if (horizontalDelta !== 0) {
        const currentLeft = Number.isFinite(container.scrollLeft) ? container.scrollLeft : 0;
        container.scrollLeft = Math.max(0, currentLeft + horizontalDelta);
    }
    if (verticalDelta !== 0) {
        const currentTop = Number.isFinite(container.scrollTop) ? container.scrollTop : 0;
        container.scrollTop = Math.max(0, currentTop + verticalDelta);
    }
    return true;
}
