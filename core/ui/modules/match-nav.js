/**
 * Filter Match Navigation
 *
 * Lets the user press Enter in the global filter or a column filter to jump
 * between cells whose full formatted text contains the active filter term,
 * cycling through them with a visible border + a "current / total" counter.
 */
import { state } from './state.js';
import { getCellValue } from './data-utils.js';
import { formatCellValueAsText } from './utils.js';

function activeTerm(scope) {
    return (scope === 'global' ? state.filterQuery : state.columnFilters[scope] || '').trim().toLowerCase();
}

function computeMatches(scope, term) {
    const matches = [];
    if (!term) return matches;

    // Resolve the columns to scan and their data indices once, outside the row loop.
    const columnsToScan = [];
    state.tableColumns.forEach((col, idx) => {
        if (scope === 'global' || col.name === scope) {
            columnsToScan.push({ col, colIdx: idx });
        }
    });

    for (let rowIdx = 0; rowIdx < state.gridData.length; rowIdx++) {
        const row = state.gridData[rowIdx];
        for (const { col, colIdx } of columnsToScan) {
            const value = getCellValue(row, colIdx);
            // String() guards against formatters that may return a non-string
            // (number/null/undefined), which would otherwise throw on .toLowerCase().
            const text = String(formatCellValueAsText(
                value,
                col.type,
                state.dateFormat,
                col.name,
                false
            ));
            if (text.toLowerCase().includes(term)) {
                matches.push({ rowIdx, colIdx });
            }
        }
    }
    return matches;
}

function focusActiveMatch() {
    document.querySelectorAll('.active-match-cell').forEach(el => el.classList.remove('active-match-cell'));

    const { matches, currentIndex } = state.matchNav;
    if (currentIndex < 0 || currentIndex >= matches.length) return;

    const { rowIdx, colIdx } = matches[currentIndex];
    const cellEl = document.getElementById(`cell-${rowIdx}-${colIdx}`);
    if (cellEl) {
        cellEl.classList.add('active-match-cell');
        cellEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
}

function updateMatchCounterUI() {
    const { scope, matches, currentIndex } = state.matchNav;
    const counterText = matches.length > 0 ? `${currentIndex + 1}/${matches.length}` : '';

    const globalCounter = document.getElementById('filterMatchCounter');
    if (globalCounter) {
        globalCounter.textContent = scope === 'global' ? counterText : '';
    }

    document.querySelectorAll('.column-filter-counter').forEach(el => {
        el.textContent = el.dataset.column === scope ? counterText : '';
    });
}

/**
 * Move to the next (direction = 1) or previous (direction = -1) match for the
 * given scope ('global' or a column name), wrapping around at either end.
 * Matches are cached on `state.matchNav` and only recomputed when the scope or
 * term changes (a fresh term is detected after `resetMatchNav()` cleared the
 * cache), so pressing Enter/Shift+Enter repeatedly is O(matches), not a full
 * rescan of every row.
 */
export function navigateMatches(scope, direction = 1) {
    // Normalize to ±1 so a stray non-numeric arg (e.g. a DOM event) can never
    // produce a NaN index in the modulo arithmetic below.
    direction = direction < 0 ? -1 : 1;
    const term = activeTerm(scope);
    const cacheValid = state.matchNav.scope === scope
        && state.matchNav.term === term
        && state.matchNav.matches.length > 0;

    if (cacheValid) {
        const len = state.matchNav.matches.length;
        state.matchNav.currentIndex = (state.matchNav.currentIndex + direction + len) % len;
    } else {
        const matches = computeMatches(scope, term);
        state.matchNav.scope = scope;
        state.matchNav.term = term;
        state.matchNav.matches = matches;
        // Fresh search: forward starts at the first match, backward at the last.
        state.matchNav.currentIndex = matches.length === 0
            ? -1
            : (direction === 1 ? 0 : matches.length - 1);
    }

    focusActiveMatch();
    updateMatchCounterUI();
}

/**
 * Clear match navigation state, e.g. when the filter term or grid data
 * changes outside of an explicit Enter-to-navigate action (sorting, paging,
 * applying a new term) so a stale border/counter isn't left pointing at the
 * wrong cell and the cache is invalidated.
 */
export function resetMatchNav() {
    state.matchNav.scope = null;
    state.matchNav.term = null;
    state.matchNav.matches = [];
    state.matchNav.currentIndex = -1;
    document.querySelectorAll('.active-match-cell').forEach(el => el.classList.remove('active-match-cell'));
    updateMatchCounterUI();
}
