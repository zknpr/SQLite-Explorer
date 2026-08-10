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
 * therefore answer unfiltered counts without scanning the complete b-tree.
 * Intrinsic-rowid tables use their rowid-span upper bound. WITHOUT ROWID
 * tables first run a capped row probe: small tables remain exact, while larger
 * tables publish the database byte size as a conservative row upper bound.
 * Every row occupies a b-tree cell (including its pointer), so the file's byte
 * length cannot undercount rows. Loose bounds only render trailing pages short
 * or empty — never a dead end.
 *
 * Exact semantics are kept for filtered counts (no cheap bound exists), buffer
 * (in-memory) opens, small paged files, views, and non-table relations. A user
 * column named rowid is data, not row identity.
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
 * Maximum rows visited while deciding whether a WITHOUT ROWID table is small
 * enough to count exactly. At SQLite's usual 4 KiB page size, even one leaf
 * page per row visits about 40 MiB. Unlike OP_Count, the coroutine remains
 * progress-handler interruptible for databases using larger pages.
 */
export const PAGED_COUNT_PROBE_MAX_ROWS = 10_000;

/** Cheap main-schema classification used only after the large-paged gate. */
export const WITHOUT_ROWID_TABLE_SQL =
  `SELECT 1 FROM pragma.pragma_table_list ` +
  `WHERE "schema" = 'main' AND "name" = ? AND "type" = 'table' AND "wr" = 1 LIMIT 1`;

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

/**
 * Fetch exact decimal endpoints in one SQLite snapshot. Each scalar subquery
 * contains only one aggregate so SQLite can seek directly to that b-tree
 * endpoint; combining MIN and MAX in one aggregate would scan every row.
 */
export function buildCountUpperBoundSql(table: string): string {
  const escapedTable = escapeIdentifier(table);
  return (
    `SELECT (SELECT CAST(min(rowid) AS TEXT) FROM ${escapedTable}), ` +
    `(SELECT CAST(max(rowid) AS TEXT) FROM ${escapedTable})`
  );
}

/**
 * COUNT the first N+1 rows through a coroutine. The subquery LIMIT prevents
 * SQLite from replacing this with the non-interruptible full-table OP_Count.
 */
export function buildCappedCountProbeSql(table: string): string {
  return `SELECT COUNT(*) FROM (SELECT 1 FROM ${escapeIdentifier(table)} LIMIT ?)`;
}

export interface CappedCountResolution {
  count: number;
  isExact: boolean;
}

/**
 * Resolve a capped WITHOUT ROWID probe. A result below the cap proves exact
 * cardinality. Reaching N+1 proves only that more than N rows exist, so retain
 * the UI's established upper-bound contract using the file byte length.
 */
export function resolveCappedCount(
  probedRows: unknown,
  pagedFileSizeBytes: number
): CappedCountResolution | undefined {
  if (
    typeof probedRows !== 'number' ||
    !Number.isSafeInteger(probedRows) ||
    probedRows < 0 ||
    probedRows > PAGED_COUNT_PROBE_MAX_ROWS + 1
  ) {
    return undefined;
  }
  if (probedRows <= PAGED_COUNT_PROBE_MAX_ROWS) {
    return { count: probedRows, isExact: true };
  }
  return {
    count: resolveFileSizeRowUpperBound(pagedFileSizeBytes, probedRows),
    isExact: false
  };
}

/** Fail safely if the bounded probe itself cannot produce a usable scalar. */
export function resolveFileSizeRowUpperBound(
  pagedFileSizeBytes: number,
  minimum = PAGED_COUNT_PROBE_MAX_ROWS + 1
): number {
  if (!Number.isSafeInteger(minimum) || minimum < 0) {
    minimum = PAGED_COUNT_PROBE_MAX_ROWS + 1;
  }
  if (!Number.isSafeInteger(pagedFileSizeBytes) || pagedFileSizeBytes < minimum) {
    return Number.MAX_SAFE_INTEGER;
  }
  return pagedFileSizeBytes;
}

function parseExactInteger(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? BigInt(value) : undefined;
  }
  if (typeof value !== 'string' || !/^-?(0|[1-9]\d*)$/.test(value)) {
    return undefined;
  }
  try {
    const parsed = BigInt(value);
    return parsed.toString() === value ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the inclusive rowid span without losing integer precision. An
 * unsafe span is not a usable JS pagination count, so callers must fall back
 * to exact COUNT(*) rather than publish rounded navigation state.
 */
export function resolveCountUpperBound(
  endpoints: readonly unknown[] | undefined
): number | undefined {
  if (!endpoints || endpoints.length < 2) return undefined;
  const [minimumValue, maximumValue] = endpoints;
  if (minimumValue === null && maximumValue === null) return 0;
  if (minimumValue === null || maximumValue === null) return undefined;

  const minimum = parseExactInteger(minimumValue);
  const maximum = parseExactInteger(maximumValue);
  if (minimum === undefined || maximum === undefined) return undefined;
  const span = maximum - minimum + 1n;
  if (span < 1n || span > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(span);
}
