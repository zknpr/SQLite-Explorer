/**
 * SQL console module — a CodeMirror 6 SQL editor plus its history/EXPLAIN
 * helpers, for the desktop-only SQL console. Pure frontend: this file does
 * NOT import desktop-host.js or api.js. The run action calls the injected
 * `runSql` callback and history persistence goes through the injected
 * `loadHistory`/`saveHistory` callbacks — the caller (desktop-viewer.js)
 * wires the real backendApi-backed implementations; here they're just
 * function-shaped dependencies.
 */
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history as cmHistory, historyKeymap } from '@codemirror/commands';
import { sql, SQLite } from '@codemirror/lang-sql';
import { autocompletion } from '@codemirror/autocomplete';
import { modLabel } from './platform.js';

export const HISTORY_CAP = 50;
export const HISTORY_ENTRY_MAX = 4096;

/**
 * Row cap the worker's runConsole applies per result set when the caller
 * passes no `maxRows` (clampConsoleMaxRows in the worker). Shown in the
 * controls hint so a truncated set is never a surprise; cosmetic only, so a
 * drift from the worker's default costs nothing but an inaccurate label.
 */
const DEFAULT_ROW_CAP = 5000;

/**
 * Returns a new history list with `sqlText` (trimmed) pushed to the front,
 * newest first, capped at HISTORY_CAP entries. Returns the SAME `list`
 * reference (no new array) when there is nothing to record: empty/
 * whitespace-only text, text over HISTORY_ENTRY_MAX chars, or an exact
 * repeat of the current front entry (consecutive dedupe) — callers can
 * reference-compare to skip a redundant persistence write.
 */
export function pushHistory(list, sqlText) {
    const trimmed = String(sqlText).trim();
    if (!trimmed || trimmed.length > HISTORY_ENTRY_MAX) return list;
    if (list[0] === trimmed) return list;
    return [trimmed, ...list].slice(0, HISTORY_CAP);
}

/**
 * Prefixes `sqlText` with `EXPLAIN QUERY PLAN ` unless it already starts
 * (after leading whitespace) with `explain`, case-insensitively — so
 * re-running EXPLAIN on text loaded back from history doesn't stack a
 * second prefix.
 */
export function explainWrap(sqlText) {
    return /^\s*explain\b/i.test(sqlText) ? sqlText : `EXPLAIN QUERY PLAN ${sqlText}`;
}

// ---- CodeMirror 6 console --------------------------------------------------

// Maps the editor's chrome onto the app's existing theme tokens (see
// viewer.css :root) rather than hardcoding colors, so the console follows
// whatever theme (including "system"/live OS changes) is already active.
const consoleTheme = EditorView.theme({
    '&': { backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' },
    '.cm-gutters': { backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'var(--hover-bg)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--active-bg)' },
    '.cm-cursor': { borderLeftColor: 'var(--text-primary)' }
});

/**
 * Builds a CodeMirror 6 SQL console inside `container`. The module owns and
 * builds all of its own DOM under `container` (Run + EXPLAIN buttons, history
 * prev/next + dropdown, the editor, a notice line) — it makes no assumptions
 * about `container`'s existing children (it clears them first) and never
 * reaches outside `container` into the rest of the page. show()/hide()/toggle() therefore
 * only ever touch `container`'s own `hidden` attribute; any page-level
 * layout class (e.g. a `.console-mode` toggle on an ancestor panel) is the
 * caller's responsibility, layered on top of this return value.
 *
 * @param {{
 *   container: HTMLElement,
 *   runSql: (sqlText: string) => unknown,
 *   loadHistory: () => string[],
 *   saveHistory: (list: string[]) => void,
 *   getSchema: () => Record<string, string[]>
 * }} deps
 */
export function createConsole({ container, runSql, loadHistory, saveHistory, getSchema }) {
    const schemaCompartment = new Compartment();
    const sqlExtension = () => sql({ dialect: SQLite, schema: getSchema() });

    container.replaceChildren();

    const controls = document.createElement('div');
    controls.className = 'sql-console-controls';

    const runButton = document.createElement('button');
    runButton.type = 'button';
    runButton.className = 'sql-console-run';
    runButton.title = `Run (${modLabel('↩')})`;
    runButton.textContent = 'Run';

    // EXPLAIN lives here rather than in the caller: it is the module's own
    // explainWrap() applied to the module's own editor text, and it must NOT
    // go through runCurrent() — a query plan is a diagnostic detour, not a
    // query the user asked to remember, so it records no history.
    const explainButton = document.createElement('button');
    explainButton.type = 'button';
    explainButton.className = 'sql-console-explain';
    explainButton.title = 'Run EXPLAIN QUERY PLAN for the current statement (not recorded in history)';
    explainButton.textContent = 'EXPLAIN';

    const prevButton = document.createElement('button');
    prevButton.type = 'button';
    prevButton.className = 'sql-console-history-prev';
    prevButton.title = 'Older query';
    prevButton.textContent = '‹'; // ‹

    const historySelect = document.createElement('select');
    historySelect.className = 'sql-console-history-select';

    const nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.className = 'sql-console-history-next';
    nextButton.title = 'Newer query';
    nextButton.textContent = '›'; // ›

    const hint = document.createElement('span');
    hint.className = 'sql-console-hint';
    hint.textContent = `${modLabel('↩')} to run · first ${DEFAULT_ROW_CAP.toLocaleString()} rows per result set`;

    controls.append(runButton, explainButton, prevButton, historySelect, nextButton, hint);

    const editorRoot = document.createElement('div');
    editorRoot.className = 'sql-console-editor';

    const notice = document.createElement('div');
    notice.className = 'sql-console-notice';
    notice.hidden = true;

    container.append(controls, editorRoot, notice);

    // -1 = editing a fresh draft (not browsing history); 0..N-1 indexes into
    // loadHistory()'s newest-first list.
    let historyIndex = -1;
    let open = false;
    let view;

    function setNotice(text) {
        notice.textContent = text;
        notice.hidden = !text;
    }

    function populateHistorySelect() {
        const list = loadHistory();
        historySelect.replaceChildren();

        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = list.length ? 'History…' : 'No history yet';
        historySelect.append(placeholder);

        list.forEach((entry, index) => {
            const option = document.createElement('option');
            option.value = String(index);
            option.textContent = entry.length > 80 ? `${entry.slice(0, 80)}…` : entry;
            historySelect.append(option);
        });
        historySelect.value = '';
    }

    function loadIntoEditor(text) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
        view.focus();
    }

    // Keeps the dropdown's displayed selection tracking historyIndex when
    // prev/next move it without going through the select's own change event.
    // Re-populating isn't needed for this: the option list itself doesn't
    // change between runs, only which option should read as selected does.
    function syncHistorySelect() {
        historySelect.value = historyIndex === -1 ? '' : String(historyIndex);
    }

    function goOlder() {
        const list = loadHistory();
        if (historyIndex + 1 >= list.length) return; // already at the oldest entry (or no history)
        historyIndex += 1;
        loadIntoEditor(list[historyIndex]);
        syncHistorySelect();
    }

    function goNewer() {
        if (historyIndex < 0) return; // already on the fresh draft
        historyIndex -= 1;
        const list = loadHistory();
        loadIntoEditor(historyIndex === -1 ? '' : list[historyIndex]);
        syncHistorySelect();
    }

    runButton.addEventListener('click', () => { void runCurrent(); });
    explainButton.addEventListener('click', () => { void runExplain(); });
    prevButton.addEventListener('click', goOlder);
    nextButton.addEventListener('click', goNewer);
    historySelect.addEventListener('change', () => {
        if (historySelect.value === '') return;
        const index = Number(historySelect.value);
        const list = loadHistory();
        if (!(index in list)) return;
        historyIndex = index;
        loadIntoEditor(list[index]);
    });

    async function execute(sqlText) {
        setNotice('');
        try {
            await runSql(sqlText);
        } catch (err) {
            // The injected runSql is expected to render its own errors
            // (desktop-viewer.js renders via console-results.js); this is
            // defense-in-depth so a throwing/rejecting callback still
            // surfaces somewhere instead of failing silently.
            setNotice(err instanceof Error ? err.message : String(err));
        }
    }

    async function runCurrent() {
        const text = view.state.doc.toString();
        if (!text.trim()) return;
        await execute(text);
        // History records the attempt regardless of outcome — a failed
        // query is exactly the kind of thing a user wants to recall and fix.
        saveHistory(pushHistory(loadHistory(), text));
        historyIndex = -1;
        populateHistorySelect();
    }

    /**
     * Runs the editor's text wrapped in EXPLAIN QUERY PLAN. No history write:
     * the recorded entry should be the query the user is working on, not the
     * plan lookup, and the next Run records it anyway.
     */
    async function runExplain() {
        const text = view.state.doc.toString();
        if (!text.trim()) return;
        await execute(explainWrap(text));
    }

    const runKeymap = keymap.of([
        { key: 'Mod-Enter', run: () => { void runCurrent(); return true; } },
        ...historyKeymap,
        ...defaultKeymap
    ]);

    view = new EditorView({
        state: EditorState.create({
            doc: '',
            extensions: [
                lineNumbers(),
                cmHistory(),
                runKeymap,
                schemaCompartment.of(sqlExtension()),
                autocompletion(),
                consoleTheme
            ]
        }),
        parent: editorRoot
    });

    populateHistorySelect();

    function show() {
        container.hidden = false;
        open = true;
        view.focus();
    }

    function hide() {
        container.hidden = true;
        open = false;
    }

    function toggle() {
        if (open) hide(); else show();
        return open;
    }

    function isOpen() {
        return open;
    }

    /** Reconfigures the SQL language's autocompletion schema from a fresh getSchema() call. */
    function refreshSchema() {
        view.dispatch({ effects: schemaCompartment.reconfigure(sqlExtension()) });
    }

    // Force container.hidden/open into agreement as the last construction
    // step, regardless of whatever hidden/visible markup the caller handed
    // in — isOpen() must never disagree with container.hidden's real value.
    hide();

    return { show, hide, toggle, isOpen, refreshSchema };
}
