/**
 * Count policy for page-on-demand (paged) database opens.
 *
 * Shared by the web demo worker and the desktop WASM engine so both
 * surfaces answer counts identically on paged storage:
 *
 * An exact unfiltered `SELECT COUNT(*)` full-scans the table's b-tree
 * through per-page host callbacks — minutes on multi-GB files, wedging
 * every queued RPC past the webview deadline — and SQLite serves it with
 * the single OP_Count opcode, which never yields to the progress handler,
 * so the scan cannot be interrupted once started. Large paged databases
 * therefore answer unfiltered counts with the intrinsic-rowid span upper bound
 * instead. The gate is decided up front from the file size (the upper
 * bound on any table scan within it). The bound equals the exact count
 * for gap-free rowid tables and otherwise overshoots, which only renders
 * trailing pages short or empty — never a dead end.
 *
 * Exact semantics are kept for: filtered counts (no cheap bound exists),
 * buffer (in-memory) opens, small paged files, and every relation that the
 * shared ROWID_TABLE_AUTHORITY_SQL does not confirm as having an unshadowed
 * intrinsic rowid. A user column named rowid is data, not row identity.
 */

import { escapeIdentifier } from './sql-utils';

/**
 * Largest page-on-demand database whose unfiltered COUNT(*) still runs
 * exactly. Exact counts stream the b-tree through per-4KB host callbacks
 * at a measured ~25-35 MB/s (~2 minutes for a 3.5 GiB / 128M-row table);
 * at 64 MiB the worst-case exact scan stays around two seconds.
 */
export const PAGED_EXACT_COUNT_MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Normalize the internal/test override for the exact-count gate. Any
 * non-finite or negative value falls back to the default; 0 means "no
 * paged file counts exactly" (used by tests to exercise the bound without
 * multi-GB fixtures).
 */
export function resolvePagedExactCountMaxFileBytes(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : PAGED_EXACT_COUNT_MAX_FILE_BYTES;
}

export interface PagedCountDecisionInput {
  /** How the active database is backed. */
  storage: 'memory' | 'paged';
  /** Whether the count carries WHERE conditions (column or global filters). */
  filtered: boolean;
  /** Result of ROWID_TABLE_AUTHORITY_SQL for the target relation. */
  authorityConfirmedRowIdTable: boolean;
  /** File size behind the paged open; 0 for buffer opens. */
  pagedFileSizeBytes: number;
  /** Resolved exact-count gate (resolvePagedExactCountMaxFileBytes). */
  exactCountMaxFileBytes: number;
}

/**
 * True when an unfiltered count on this storage should answer with the
 * intrinsic-rowid span upper bound instead of an exact scan.
 */
export function shouldAnswerCountWithUpperBound(
  input: PagedCountDecisionInput
): boolean {
  return input.storage === 'paged'
    && !input.filtered
    && input.authorityConfirmedRowIdTable
    && input.pagedFileSizeBytes > input.exactCountMaxFileBytes;
}

/** Distinct integer rowids fit within this inclusive span; empty tables return 0. */
export function buildCountUpperBoundSql(table: string): string {
  return `SELECT COALESCE(max(rowid) - min(rowid) + 1, 0) FROM ${escapeIdentifier(table)}`;
}
