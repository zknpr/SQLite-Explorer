/**
 * Filter Match Navigation
 *
 * Lets the user press Enter in the global filter or a column filter to jump
 * between cells whose SQLite-comparable raw or authoritative numeric text contains the active filter term,
 * cycling through them with a visible border + a "current / total" counter.
 */
import { state } from './state.js';
import {
    getCellValue,
    getExactIntegerText,
    getOrderedColumnIndices,
    getOrderedRowIndices
} from './data-utils.js';
import {
    appendHighlightedText,
    buildHighlightMatcher,
    foldAsciiCase,
    formatCellValueAsText,
    truncateAtSqliteTextNul
} from './utils.js';
import { getActiveFilterValue } from '../../../src/core/filter-utils.ts';
import { revealGridCell } from './grid-reveal.js';

// A Symbol cannot collide with any SQLite column name, unlike the former
// string sentinel. This value stays entirely inside the webview process.
export const GLOBAL_MATCH_SCOPE = Symbol('global-match-scope');

function activeTerm(scope) {
    const value = scope === GLOBAL_MATCH_SCOPE ? state.filterQuery : state.columnFilters[scope];
    const activeValue = getActiveFilterValue(value);
    // Case folding is only for the local SQLite-compatible comparison. The
    // active value itself stays untrimmed, matching the exact text sent to SQL.
    return activeValue === undefined ? '' : foldAsciiCase(activeValue);
}

/**
 * Pick the filter whose matches Enter should traverse from the grid itself.
 * Keep an already-selected scope when it is still active; otherwise prefer the
 * global filter, then the first active column in rendered (pinned-first) order.
 */
export function getPreferredMatchScope() {
    if (state.matchNav.scope !== null && activeTerm(state.matchNav.scope)) {
        return state.matchNav.scope;
    }
    if (activeTerm(GLOBAL_MATCH_SCOPE)) return GLOBAL_MATCH_SCOPE;
    for (const colIdx of getOrderedColumnIndices()) {
        const columnName = state.tableColumns[colIdx]?.name;
        if (columnName !== undefined && activeTerm(columnName)) return columnName;
    }
    return null;
}

function getMatchingTextCandidate(value, term, exactIntegerText) {
    // NULL never satisfies LIKE, and SQLite compares BLOB bytes rather than the
    // UI's synthetic "[BLOB]" label. Neither display-only placeholder is a
    // searchable SQL representation, so do not offer it to local navigation.
    if (value === null || value === undefined || value instanceof Uint8Array) {
        return null;
    }

    const rawText = truncateAtSqliteTextNul(value);
    const candidates = exactIntegerText === undefined
        ? [rawText]
        : [exactIntegerText, rawText];
    return candidates.find(candidate => foldAsciiCase(candidate).includes(term)) ?? null;
}

function excerptAroundMatch(text, term, maxLength = 100) {
    if (text.length <= maxLength) return text;

    const matchStart = foldAsciiCase(text).indexOf(term);
    if (matchStart < 0) return formatCellValueAsText(text);

    // Keep the complete match visible even when the filter itself exceeds the
    // usual display width, and divide the remaining context around the match.
    const windowLength = Math.max(maxLength, term.length);
    const contextLength = Math.max(0, windowLength - term.length);
    let start = Math.max(0, matchStart - Math.floor(contextLength / 2));
    let end = Math.min(text.length, start + windowLength);
    if (end - start < windowLength) {
        start = Math.max(0, end - windowLength);
    }

    return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
}

/**
 * Return the normal truncated display text, or an excerpt centered on the
 * active navigation term using the exact raw/numeric candidate that
 * made the cell a match.
 */
export function formatCellValueForActiveMatch(value, col, term, exactIntegerText) {
    if (!term) {
        return formatCellValueAsText(value, col.type, state.dateFormat, col.name);
    }
    const candidate = getMatchingTextCandidate(value, term, exactIntegerText);
    return candidate === null
        ? formatCellValueAsText(value, col.type, state.dateFormat, col.name)
        : excerptAroundMatch(candidate, term);
}

function computeMatches(scope, term) {
    const matches = [];
    if (!term) return matches;

    // Resolve the columns to scan and their data indices once, outside the row loop.
    const columnsToScan = [];
    for (const idx of getOrderedColumnIndices()) {
        const col = state.tableColumns[idx];
        if (scope === GLOBAL_MATCH_SCOPE || col.name === scope) {
            columnsToScan.push({ col, colIdx: idx });
        }
    }

    for (const rowIdx of getOrderedRowIndices()) {
        const row = state.gridData[rowIdx];
        for (const { col, colIdx } of columnsToScan) {
            const value = getCellValue(row, colIdx);
            const exactIntegerText = getExactIntegerText(rowIdx, colIdx);
            if (getMatchingTextCandidate(value, term, exactIntegerText) !== null) {
                matches.push({ rowIdx, colIdx });
            }
        }
    }
    return matches;
}

function renderMatchCellText(cellEl, rowIdx, colIdx, term) {
    if (!cellEl || typeof cellEl.querySelector !== 'function') return;
    const textSpan = cellEl.querySelector('.cell-text');
    const row = state.gridData[rowIdx];
    const col = state.tableColumns[colIdx];
    if (!textSpan || !row || !col || typeof textSpan.replaceChildren !== 'function') return;

    const value = getCellValue(row, colIdx);
    const exactIntegerText = getExactIntegerText(rowIdx, colIdx);
    const displayValue = term
        ? formatCellValueForActiveMatch(value, col, term, exactIntegerText)
        : formatCellValueAsText(value, col.type, state.dateFormat, col.name);
    const matcher = buildHighlightMatcher([state.filterQuery, state.columnFilters[col.name]]);
    textSpan.replaceChildren();
    appendHighlightedText(textSpan, displayValue, matcher);
}

function clearActiveMatchCells() {
    document.querySelectorAll('.active-match-cell').forEach(cellEl => {
        const rowIdx = Number(cellEl.dataset?.rowidx);
        const colIdx = Number(cellEl.dataset?.colidx);
        if (Number.isInteger(rowIdx) && Number.isInteger(colIdx)) {
            renderMatchCellText(cellEl, rowIdx, colIdx, null);
        }
        cellEl.classList.remove('active-match-cell');
    });
}

function focusActiveMatch() {
    clearActiveMatchCells();

    const { matches, currentIndex } = state.matchNav;
    if (currentIndex < 0 || currentIndex >= matches.length) return;

    const { rowIdx, colIdx } = matches[currentIndex];
    const cellEl = document.getElementById(`cell-${rowIdx}-${colIdx}`);
    if (cellEl) {
        cellEl.classList.add('active-match-cell');
        renderMatchCellText(cellEl, rowIdx, colIdx, state.matchNav.term);
        revealGridCell(cellEl);
    }
}

function updateMatchCounterUI() {
    const { scope, matches, currentIndex } = state.matchNav;
    const counterText = matches.length > 0 ? `${currentIndex + 1}/${matches.length}` : '';

    const globalCounter = document.getElementById('filterMatchCounter');
    if (globalCounter) {
        globalCounter.textContent = scope === GLOBAL_MATCH_SCOPE ? counterText : '';
    }

    document.querySelectorAll('.column-filter-counter').forEach(el => {
        el.textContent = el.dataset.column === scope ? counterText : '';
    });
}

/**
 * Move to the next (direction = 1) or previous (direction = -1) match for the
 * given scope (GLOBAL_MATCH_SCOPE or a column name), wrapping around at either end.
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
    clearActiveMatchCells();
    state.matchNav.scope = null;
    state.matchNav.term = null;
    state.matchNav.matches = [];
    state.matchNav.currentIndex = -1;
    updateMatchCounterUI();
}
