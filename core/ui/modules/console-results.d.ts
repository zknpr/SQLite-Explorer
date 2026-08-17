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
    /**
     * True when a statement cap (EXPLAIN's `maxStatements: 1`) left part of the
     * script unexecuted. Absent reads as false. Exact when the worker drained
     * the tail; conservatively true when the tail held a pragma and was left
     * untouched instead (see the worker's runConsole).
     */
    statementsSkipped?: boolean;
}

/**
 * The failure payload. Normally runConsole's own resolution once execution has
 * begun — it carries the mutation metadata too, so the host can still record
 * what a half-applied script changed. The viewer synthesizes this shape only
 * for failures that never reached the worker (transport, read-only refusal).
 */
export interface ConsoleRunError {
    /** The message to show. A non-string (e.g. a raw Error) is coerced rather than throwing. */
    error: string;
    /** True when the failed run had more than one statement, so earlier statements may have applied. Absent reads as false. */
    multiStatement?: boolean;
}

export type ConsoleRenderPayload = ConsoleRunResult | ConsoleRunError;

/**
 * One-line summary of a completed run, e.g. `123 rows (truncated) · 2 changed · 45 ms`.
 * Segments appear only when they carry information: rows only when the script
 * produced at least one result set (multi-set runs report the summed count and
 * the set count), changes only when the run mutated (`schema changed` when it
 * mutated with zero row changes), duration always, rounded to whole
 * milliseconds. A run with neither rows nor mutations reads `no results · N ms`.
 * A capped run appends ` · remaining statements not executed`.
 */
export function formatStatus(result: ConsoleRunResult): string;

/**
 * Renders `payload` into `container`, replacing its previous content. Success
 * payloads render a status line, a tab strip when (and only when) there is
 * more than one result set, and one table per set; error payloads render the
 * message plus, when `multiStatement`, the fixed note
 * `Statements before the error were applied.`
 *
 * Total: a payload matching neither shape (nullish, a blank/whitespace-only
 * `error`, a non-array or sparse `results`, a set without array
 * `headers`/`rows`) renders `Malformed console result payload` through the
 * error path and logs the raw payload, rather than throwing.
 *
 * All DOM is built with createElement + textContent — query output is
 * untrusted database content and never reaches innerHTML.
 */
export function renderConsoleResults(container: HTMLElement, payload: ConsoleRenderPayload): void;
