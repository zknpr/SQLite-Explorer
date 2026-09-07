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

/** Shown when the payload is neither a runConsole result nor an error — a caller bug. */
const CONTRACT_VIOLATION_MESSAGE = 'Malformed console result payload';

/**
 * Trailing status segment for a run that stopped at its statement cap. EXPLAIN
 * only ever prefixes the first statement, so a plan for a multi-statement
 * script covers just that one — saying so is what stops the user reading it as
 * a plan for everything they typed.
 */
const SKIPPED_STATEMENTS_NOTE = 'remaining statements not executed';

/**
 * One-line summary of a completed console run, e.g.
 * `123 rows (truncated) · 2 changed · 45 ms`.
 *
 * Segments are emitted only when they carry information:
 * - rows: only when the script produced at least one result set. Multiple
 *   sets report the summed row count plus the set count; `(truncated)` marks
 *   that ANY set hit the row cap. A query plan (`explain`) counts its rows
 *   as plan entries, so `4 plan entries` cannot be misread as data.
 * - changes: only when the run mutated. `mutated` with zero row changes can
 *   only be a schema_version bump (see runConsole), so it is named as such
 *   rather than printed as a misleading "0 changed".
 * - duration: always, rounded to whole milliseconds. A non-finite duration
 *   degrades to 0 rather than surfacing "NaN ms".
 *
 * A run with neither rows nor mutations (`BEGIN;`, comments only) still gets
 * a leading `no results` so the status is never a bare duration.
 *
 * `statementsSkipped` (a capped run, i.e. EXPLAIN on a multi-statement
 * script) adds a trailing segment. It goes last, after the duration, because
 * it describes what the run declined to do rather than what it did — and the
 * user must not read a one-statement plan as covering their whole script.
 *
 * @param {{ results: Array<{ rows: unknown[][], truncated: boolean }>, mutated: boolean, changes: number, durationMs: number, statementsSkipped?: boolean, explain?: boolean }} result
 * @returns {string}
 */
export function formatStatus(result) {
    const sets = result.results;
    const segments = [];

    if (sets.length > 0) {
        const rowCount = sets.reduce((total, set) => total + set.rows.length, 0);
        const noun = result.explain === true
            ? (rowCount === 1 ? 'plan entry' : 'plan entries')
            : (rowCount === 1 ? 'row' : 'rows');
        let rows = `${rowCount} ${noun}`;
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

    if (result.statementsSkipped) segments.push(SKIPPED_STATEMENTS_NOTE);

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
            // style. Deliberately WITHOUT the grid's `data-cell` class: that
            // class carries the grid's own layout rules (fixed --row-height,
            // relative positioning) which do not belong to console output, and
            // omitting it keeps console cells inert to the grid's cell-edit and
            // drop handlers, which match `.data-cell` via closest(). Those
            // handlers are bound to #gridContainer today (dnd.js:36-38,
            // grid-events.js:53-59), so this is defense against a future
            // re-scoping, not a live exposure.
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
 * run can never inherit a stale index. `onSelect` hears every change so the
 * export control can follow the visible set.
 *
 * @param {HTMLElement[]} panes
 * @param {(index: number) => void} onSelect
 * @returns {HTMLElement}
 */
function buildTabStrip(panes, onSelect) {
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
        onSelect(selectedIndex);
    }

    select(0);
    return strip;
}

/**
 * Builds the status row: the summary text plus, when the caller can export and
 * there is a set to export, an Export CSV button that hands over whichever set
 * is visible at click time (the tab strip keeps `selected` current).
 *
 * @param {object} payload
 * @param {{ onExportCsv?: (set: object, payload: object) => unknown } | undefined} options
 * @param {{ index: number }} selected
 * @returns {HTMLElement}
 */
function buildStatusRow(payload, options, selected) {
    const status = document.createElement('div');
    status.className = 'sql-console-results-status';

    const text = document.createElement('span');
    text.className = 'sql-console-results-status-text';
    text.textContent = formatStatus(payload);
    status.appendChild(text);

    if (typeof options?.onExportCsv === 'function' && payload.results.length > 0) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sql-console-results-export';
        button.textContent = 'Export CSV';
        button.title = 'Export the displayed rows of this result set as CSV';
        button.addEventListener('click', () => {
            options.onExportCsv(payload.results[selected.index], payload);
        });
        status.appendChild(button);
    }
    return status;
}

/**
 * Renders a failure into `container`: the message, plus the fixed
 * multi-statement note when earlier statements may have applied.
 *
 * @param {HTMLElement} container
 * @param {string} message
 * @param {boolean} withNote
 */
function renderError(container, message, withNote) {
    const error = document.createElement('div');
    error.className = 'sql-console-results-error';
    error.textContent = message;
    container.appendChild(error);

    if (withNote) {
        const note = document.createElement('div');
        note.className = 'sql-console-results-note';
        note.textContent = MULTI_STATEMENT_NOTE;
        container.appendChild(note);
    }
}

/**
 * True when `payload` carries a renderable failure message. A nullish `error`
 * is not a message, and neither is an empty/whitespace-only string — both
 * would produce a visually blank error pane, so they fall through to the
 * contract check instead. Any other present value (a raw Error, a number) is
 * a message and renders coerced.
 *
 * @param {unknown} payload
 * @returns {boolean}
 */
function isErrorPayload(payload) {
    if (payload === null || typeof payload !== 'object') return false;
    const error = payload.error;
    if (error === null || error === undefined) return false;
    return typeof error !== 'string' || error.trim() !== '';
}

/**
 * True when `payload` is structurally renderable as a successful run: every
 * property the success path walks is present and of the right kind. Checked
 * rather than assumed because rendering must be total — see
 * {@link renderConsoleResults}. One extra pass over the rows is nothing next
 * to building a DOM row for each of them.
 *
 * The `Array.from` calls are load-bearing, not decoration: `every()` SKIPS
 * array holes while the render path's `for...of` does not, so a sparse
 * `results`/`rows` would sail past a bare `every()` and then throw on an
 * `undefined` set/row. Copying materializes the holes so the predicate sees
 * (and rejects) them.
 *
 * @param {unknown} payload
 * @returns {boolean}
 */
function isRenderableRun(payload) {
    if (payload === null || typeof payload !== 'object') return false;
    if (!Array.isArray(payload.results)) return false;
    return Array.from(payload.results).every(set =>
        set !== null
        && typeof set === 'object'
        && Array.isArray(set.headers)
        && Array.isArray(set.rows)
        && Array.from(set.rows).every(row => Array.isArray(row))
    );
}

/**
 * Renders a console run into `container`, replacing whatever the previous
 * run left behind.
 *
 * Two payload shapes, discriminated by a non-blank `error`:
 * - success: runConsole's result — a status line, a tab strip when (and only
 *   when) there is more than one result set, and one table per set.
 * - failure: the error message, plus the fixed multi-statement note when the
 *   failed run had more than one statement.
 *
 * Rendering is TOTAL: anything that is neither of those (a nullish payload, a
 * blank error message, a missing/non-array/sparse `results`, a set without
 * array `headers`/`rows`) is a caller contract violation and renders as a
 * visible failure with the raw payload logged, instead of throwing halfway
 * through and leaving the pane blank — the container has already been cleared
 * by then, so a throw would lose the previous output AND show nothing in its
 * place.
 *
 * `options.onExportCsv`, when given, adds an Export CSV control to the status
 * row of a run with at least one result set; it receives the set that is
 * visible when clicked and the whole payload. The renderer never builds the
 * CSV or touches a file itself — that stays with the caller, which owns the
 * host seam.
 *
 * @param {HTMLElement} container
 * @param {{ results: Array<{ headers: string[], rows: unknown[][], truncated: boolean }>, mutated: boolean, changes: number, durationMs: number, explain?: boolean } | { error: string, multiStatement?: boolean }} payload
 * @param {{ onExportCsv?: (set: { headers: string[], rows: unknown[][], truncated: boolean }, payload: object) => unknown }} [options]
 * @returns {void}
 */
export function renderConsoleResults(container, payload, options) {
    container.replaceChildren();

    // Presence-checked and coerced on the way out (see isErrorPayload): the
    // error branch is the worst possible place to throw a second time, so a
    // caller that hands over an Error instead of its message still gets its
    // failure rendered.
    if (isErrorPayload(payload)) {
        renderError(container, String(payload.error), Boolean(payload.multiStatement));
        return;
    }

    if (!isRenderableRun(payload)) {
        // Loud in devtools (raw payload, for whoever has to debug the caller)
        // and visible on screen (the user must not be left staring at an
        // empty pane wondering whether the query did anything).
        console.error('[ConsoleResults] Malformed console result payload:', payload);
        renderError(container, CONTRACT_VIOLATION_MESSAGE, false);
        return;
    }

    const selected = { index: 0 };
    container.appendChild(buildStatusRow(payload, options, selected));

    const panes = payload.results.map(set => buildPane(set));
    if (panes.length > 1) {
        container.appendChild(buildTabStrip(panes, index => { selected.index = index; }));
    }
    for (const pane of panes) container.appendChild(pane);
}
