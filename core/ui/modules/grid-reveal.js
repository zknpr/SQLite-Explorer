/**
 * Grid viewport reveal helpers.
 *
 * Native scrollIntoView only considers the scrollport rectangle; it does not
 * subtract sticky headers, pinned rows, the row-number gutter, or pinned
 * columns. Resolve that occlusion once here so every programmatic grid focus
 * path lands in the actually visible portion of the grid.
 */

function measuredRect(element) {
    if (!element || typeof element.getBoundingClientRect !== 'function') return null;
    const rect = element.getBoundingClientRect();
    if (!rect || ![rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)) {
        return null;
    }
    return rect;
}

function queryOne(container, selector) {
    if (typeof container.querySelector !== 'function') return null;
    return container.querySelector(selector);
}

function queryLast(container, selector) {
    if (typeof container.querySelectorAll !== 'function') return null;
    const elements = container.querySelectorAll(selector);
    return elements.length > 0 ? elements[elements.length - 1] : null;
}

function extendVisibleEnd(current, element, containerStart, containerEnd, edge) {
    const rect = measuredRect(element);
    if (!rect || rect[edge] <= containerStart) return current;
    const elementStart = edge === 'right' ? rect.left : rect.top;
    if (elementStart >= containerEnd) return current;
    return Math.max(current, Math.min(rect[edge], containerEnd));
}

function getVisibleLeft(container, containerRect, targetIsPinned) {
    if (targetIsPinned) return containerRect.left;
    let visibleLeft = containerRect.left;
    const rowNumber = queryOne(container, '.header-cell.row-number-header') ||
        queryOne(container, '.data-cell.row-number');
    // Pinned columns render contiguously from the left, so the final pinned
    // header is the only column boundary that affects the unpinned viewport.
    const lastPinnedColumn = queryLast(container, '.grid-header .header-cell.pinned') ||
        queryLast(container, '.data-cell.pinned');
    visibleLeft = extendVisibleEnd(
        visibleLeft,
        rowNumber,
        containerRect.left,
        containerRect.right,
        'right'
    );
    visibleLeft = extendVisibleEnd(
        visibleLeft,
        lastPinnedColumn,
        containerRect.left,
        containerRect.right,
        'right'
    );
    return visibleLeft;
}

function getVisibleTop(container, containerRect, targetIsPinned) {
    if (targetIsPinned) return containerRect.top;
    let visibleTop = containerRect.top;
    const headerRow = queryOne(container, '.grid-header tr') ||
        queryOne(container, '.grid-header .header-cell');
    // Pinned rows also render contiguously below the header; measuring the final
    // row captures the whole sticky stack without forcing layout for every cell.
    const lastPinnedRow = queryLast(container, '.data-row.pinned');
    visibleTop = extendVisibleEnd(
        visibleTop,
        headerRow,
        containerRect.top,
        containerRect.bottom,
        'bottom'
    );
    visibleTop = extendVisibleEnd(
        visibleTop,
        lastPinnedRow,
        containerRect.top,
        containerRect.bottom,
        'bottom'
    );
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
