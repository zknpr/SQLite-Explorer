/**
 * Types for console.js — the CodeMirror 6 SQL console module. Pure
 * frontend: no imports from desktop-host.js or api.js. `runSql`,
 * `loadHistory`, `saveHistory`, and `getSchema` are injected by the caller;
 * desktop-viewer.js wires the real backendApi-backed implementations.
 */

/** Maximum number of entries kept in the persisted query history. */
export const HISTORY_CAP: number;
/** Entries longer than this (chars, after trim) are not recorded. */
export const HISTORY_ENTRY_MAX: number;

/**
 * Returns a new history list with `sqlText` (trimmed) pushed to the front,
 * newest first, capped at HISTORY_CAP entries. Returns the SAME `list`
 * reference when there is nothing to record: empty/whitespace-only text,
 * text over HISTORY_ENTRY_MAX chars, or an exact repeat of the current
 * front entry (consecutive dedupe).
 */
export function pushHistory(list: readonly string[], sqlText: string): string[];

/**
 * Removes a leading `EXPLAIN` / `EXPLAIN QUERY PLAN` (case-insensitive, after
 * leading whitespace) so EXPLAIN on already-EXPLAIN text explains the inner
 * statement. The worker owns the wrapping (`options.explain`).
 */
export function stripExplainPrefix(sqlText: string): string;

/**
 * The parameter field's text as the list the worker binds: `[]` for blank,
 * otherwise parseQueryParameters' JSON array of null/string/number values
 * (at most 100). Throws with that function's message on anything else.
 */
export function parseConsoleParameters(text: string | null | undefined): Array<null | string | number>;

/**
 * Filters a persisted history list to usable entries (strings within
 * HISTORY_ENTRY_MAX, at most HISTORY_CAP of them). A trust boundary:
 * settings.json is hand-editable, and one non-string entry used to throw
 * inside createConsole and leave the console unopenable. Returns the SAME
 * reference when nothing needed removing.
 */
export function sanitizeHistory(list: unknown): string[];

/**
 * `'not recorded (too long)'` when `sqlText` exceeds HISTORY_ENTRY_MAX after
 * trimming (so the run happened but pushHistory dropped it), otherwise `''`.
 */
export function historySkipNotice(sqlText: string): string;

/** Schema shape consumed by @codemirror/lang-sql's `sql({ schema })` option: table/view name → column names. */
export type ConsoleSchema = Record<string, string[]>;

/** The run options console.js hands to `runSql`; forwarded verbatim to the worker's runConsole. */
export interface ConsoleRunOptions {
    maxRows?: number;
    maxStatements?: number;
    /** Positional parameters from the parameter field; absent when the field is blank. */
    params?: Array<null | string | number>;
    /** EXPLAIN: the plan of the (single) statement, nothing executed. */
    explain?: boolean;
}

/** Dependencies injected into {@link createConsole}. */
export interface CreateConsoleOptions {
    /** Empty mount element; the console clears it and builds all of its own DOM inside. */
    container: HTMLElement;
    /**
     * Executes `sqlText`. Invoked with the editor's full current text on
     * Mod-Enter and on the Run button, and with {@link stripExplainPrefix}'s
     * result plus `explain: true` on the EXPLAIN button (which records no
     * history). Both carry the parameter field's values as `params` when it
     * is non-blank. Implementations must forward `options` to the backend
     * verbatim. May return a value or a Promise; createConsole awaits it but
     * does not otherwise interpret the result — rendering results is the
     * injected implementation's own responsibility.
     */
    runSql(sqlText: string, options?: ConsoleRunOptions): unknown;
    /** Returns the persisted history, newest first. */
    loadHistory(): string[];
    /** Persists a full replacement history list (as produced by {@link pushHistory}). */
    saveHistory(list: string[]): void;
    /** Returns the current schema for SQL autocompletion. */
    getSchema(): ConsoleSchema;
}

/** Public surface returned by {@link createConsole}. */
export interface Console {
    /** Clears `container`'s `hidden` attribute and focuses the editor. */
    show(): void;
    /** Sets `container`'s `hidden` attribute. */
    hide(): void;
    /** Flips open/closed (show()/hide()) and returns the new isOpen() state. */
    toggle(): boolean;
    isOpen(): boolean;
    /** Reconfigures the SQL language's autocompletion schema from a fresh getSchema() call. */
    refreshSchema(): void;
}

export function createConsole(options: CreateConsoleOptions): Console;
