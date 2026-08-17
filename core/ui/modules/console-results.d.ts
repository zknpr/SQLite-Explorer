/**
 * Types for console-results.js — the SQL console's results renderer. Pure
 * frontend: no imports from desktop-host.js or api.js. Values are rendered
 * with the shared grid cell formatter, so NULL shows as `NULL`, blobs as
 * `[BLOB]`, and strings over 100 chars are clamped exactly as in the grid.
 */

/** One result set: a SELECT-shaped statement's columns and collected rows. */
export interface ConsoleResultSet {
    headers: string[];
    rows: unknown[][];
    /** True when the statement produced more rows than runConsole's cap collected. */
    truncated: boolean;
}

/** runConsole's success payload (see the worker's runConsole). */
export interface ConsoleRunResult {
    results: ConsoleResultSet[];
    /** True when the script changed rows OR bumped schema_version. */
    mutated: boolean;
    /** total_changes() delta across the whole script. */
    changes: number;
    durationMs: number;
}

/** The failure payload the caller synthesizes from a rejected runConsole. */
export interface ConsoleRunError {
    /** The message to show. A non-string (e.g. a raw Error) is coerced rather than throwing. */
    error: string;
    /** True when the failed run had more than one statement, so earlier statements may have applied. */
    multiStatement: boolean;
}

export type ConsoleRenderPayload = ConsoleRunResult | ConsoleRunError;

/**
 * One-line summary of a completed run, e.g. `123 rows (truncated) · 2 changed · 45 ms`.
 * Segments appear only when they carry information: rows only when the script
 * produced at least one result set (multi-set runs report the summed count and
 * the set count), changes only when the run mutated (`schema changed` when it
 * mutated with zero row changes), duration always, rounded to whole
 * milliseconds. A run with neither rows nor mutations reads `no results · N ms`.
 */
export function formatStatus(result: ConsoleRunResult): string;

/**
 * Renders `payload` into `container`, replacing its previous content. Success
 * payloads render a status line, a tab strip when (and only when) there is
 * more than one result set, and one table per set; error payloads render the
 * message plus, when `multiStatement`, the fixed note
 * `Statements before the error were applied.`
 *
 * All DOM is built with createElement + textContent — query output is
 * untrusted database content and never reaches innerHTML.
 */
export function renderConsoleResults(container: HTMLElement, payload: ConsoleRenderPayload): void;
