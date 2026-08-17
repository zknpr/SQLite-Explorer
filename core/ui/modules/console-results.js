/**
 * SQL console results renderer — turns a runConsole payload (or its error
 * form) into DOM under a caller-supplied container. Pure frontend: no
 * imports from desktop-host.js or api.js; the only dependency is the shared
 * cell formatter, reused so console output reads exactly like grid output
 * (NULL/[BLOB] literals, the same long-text clamp).
 *
 * SECURITY: every value here is untrusted database content. The renderer
 * builds DOM with document.createElement + textContent ONLY — no innerHTML,
 * no HTML strings, anywhere. tests/unit/console_results.test.ts renders
 * through a fake node whose innerHTML accessor throws, so a regression fails
 * the suite rather than shipping an XSS sink into the desktop webview.
 */
import { formatCellValueAsText } from './utils.js';

/** Separator between status segments — middle dot, spaced. */
const STATUS_SEPARATOR = ' · ';

/**
 * Fixed note shown beside an error when the run was multi-statement.
 * runConsole does NOT wrap the script in a transaction, so statements that
 * ran before the failing one stay applied; the user has to know that.
 */
const MULTI_STATEMENT_NOTE = 'Statements before the error were applied.';

/**
 * One-line summary of a completed console run, e.g.
 * `123 rows (truncated) · 2 changed · 45 ms`.
 *
 * Segments are emitted only when they carry information:
 * - rows: only when the script produced at least one result set. Multiple
 *   sets report the summed row count plus the set count; `(truncated)` marks
 *   that ANY set hit the row cap.
 * - changes: only when the run mutated. `mutated` with zero row changes can
 *   only be a schema_version bump (see runConsole), so it is named as such
 *   rather than printed as a misleading "0 changed".
 * - duration: always, rounded to whole milliseconds. A non-finite duration
 *   degrades to 0 rather than surfacing "NaN ms".
 *
 * A run with neither rows nor mutations (`BEGIN;`, comments only) still gets
 * a leading `no results` so the status is never a bare duration.
 *
 * @param {{ results: Array<{ rows: unknown[][], truncated: boolean }>, mutated: boolean, changes: number, durationMs: number }} result
 * @returns {string}
 */
export function formatStatus(result) {
    const sets = result.results;
    const segments = [];

    if (sets.length > 0) {
        const rowCount = sets.reduce((total, set) => total + set.rows.length, 0);
        let rows = `${rowCount} ${rowCount === 1 ? 'row' : 'rows'}`;
        if (sets.length > 1) rows += ` in ${sets.length} sets`;
        if (sets.some(set => set.truncated)) rows += ' (truncated)';
        segments.push(rows);
    }

    if (result.mutated) {
        segments.push(result.changes > 0 ? `${result.changes} changed` : 'schema changed');
    }

    if (segments.length === 0) segments.push('no results');

    const durationMs = Number.isFinite(result.durationMs) ? Math.round(result.durationMs) : 0;
    segments.push(`${durationMs} ms`);

    return segments.join(STATUS_SEPARATOR);
}

/**
 * Builds one result set's pane: a scroll wrapper around a table whose
 * `<thead>` the stylesheet makes sticky.
 *
 * @param {{ headers: string[], rows: unknown[][] }} set
 * @returns {HTMLElement}
 */
function buildPane(set) {
    const pane = document.createElement('div');
    pane.className = 'sql-console-results-pane';

    const table = document.createElement('table');
    table.className = 'sql-console-results-table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const header of set.headers) {
        const th = document.createElement('th');
        th.textContent = header;
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);

    const tbody = document.createElement('tbody');
    for (const row of set.rows) {
        const tr = document.createElement('tr');
        for (const value of row) {
            const td = document.createElement('td');
            // Same NULL class the grid uses (grid-render.js), so console NULLs
            // pick up the one existing null-cell rule instead of a parallel
            // style. Deliberately WITHOUT the grid's `data-cell` class:
            // document-level grid handlers (dnd.js/grid-events.js) match
            // `.data-cell` via closest(), and console cells must not answer
            // to cell-edit or drop handling.
            if (value === null || value === undefined) td.className = 'null-value';
            td.textContent = formatCellValueAsText(value);
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }

    table.appendChild(thead);
    table.appendChild(tbody);
    pane.appendChild(table);
    return pane;
}

/**
 * Builds the tab strip for a multi-set run and wires it to show exactly one
 * pane. Selection state lives in this closure — it is per render, so a new
 * run can never inherit a stale index.
 *
 * @param {HTMLElement[]} panes
 * @returns {HTMLElement}
 */
function buildTabStrip(panes) {
    const strip = document.createElement('div');
    strip.className = 'sql-console-results-tabs';

    const tabs = panes.map((_, index) => {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.textContent = `Set ${index + 1}`;
        tab.addEventListener('click', () => select(index));
        strip.appendChild(tab);
        return tab;
    });

    function select(selectedIndex) {
        panes.forEach((pane, index) => { pane.hidden = index !== selectedIndex; });
        tabs.forEach((tab, index) => {
            tab.className = index === selectedIndex
                ? 'sql-console-results-tab active'
                : 'sql-console-results-tab';
        });
    }

    select(0);
    return strip;
}

/**
 * Renders a console run into `container`, replacing whatever the previous
 * run left behind.
 *
 * Two payload shapes, discriminated by the presence of `error`:
 * - success: runConsole's result — a status line, a tab strip when (and only
 *   when) there is more than one result set, and one table per set.
 * - failure: the error message, plus the fixed multi-statement note when the
 *   failed run had more than one statement.
 *
 * @param {HTMLElement} container
 * @param {{ results: Array<{ headers: string[], rows: unknown[][], truncated: boolean }>, mutated: boolean, changes: number, durationMs: number } | { error: string, multiStatement: boolean }} payload
 * @returns {void}
 */
export function renderConsoleResults(container, payload) {
    container.replaceChildren();

    // Presence-checked, not typeof-string-checked, and coerced on the way out:
    // the error branch is the worst possible place to throw a second time, so
    // a caller that hands over an Error instead of its message still gets its
    // failure rendered instead of a TypeError from the result branch below.
    if (payload.error !== undefined) {
        const error = document.createElement('div');
        error.className = 'sql-console-results-error';
        error.textContent = String(payload.error);
        container.appendChild(error);

        if (payload.multiStatement) {
            const note = document.createElement('div');
            note.className = 'sql-console-results-note';
            note.textContent = MULTI_STATEMENT_NOTE;
            container.appendChild(note);
        }
        return;
    }

    const status = document.createElement('div');
    status.className = 'sql-console-results-status';
    status.textContent = formatStatus(payload);
    container.appendChild(status);

    const panes = payload.results.map(set => buildPane(set));
    if (panes.length > 1) container.appendChild(buildTabStrip(panes));
    for (const pane of panes) container.appendChild(pane);
}
