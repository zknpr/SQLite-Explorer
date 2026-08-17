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
 * Prefixes `sqlText` with `EXPLAIN QUERY PLAN ` unless it already starts
 * (after leading whitespace) with `explain`, case-insensitively.
 */
export function explainWrap(sqlText: string): string;

/** Schema shape consumed by @codemirror/lang-sql's `sql({ schema })` option: table/view name → column names. */
export type ConsoleSchema = Record<string, string[]>;

/** Dependencies injected into {@link createConsole}. */
export interface CreateConsoleOptions {
    /** Empty mount element; the console clears it and builds all of its own DOM inside. */
    container: HTMLElement;
    /**
     * Executes `sqlText`. Invoked on Mod-Enter with the editor's full
     * current text. May return a value or a Promise; createConsole awaits
     * it but does not otherwise interpret the result — rendering results is
     * the injected implementation's own responsibility.
     */
    runSql(sqlText: string): unknown;
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
