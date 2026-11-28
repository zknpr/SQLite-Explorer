import type { CellValue, RecordId } from './types';
import type { RecordIdentityPredicate } from './row-identity';
import type { DeletedRow } from './types';
import { estimateUndoMemoryBytes, SharedStorageClassLists } from './undo-history';
import { escapeIdentifier, escapeMainIdentifier, joinExpressionTerms } from './sql-utils';

const DELETED_ROW_STRUCTURAL_BYTES = 32;
const STORAGE_CLASS_ENTRY_STRUCTURAL_BYTES = 48;

function safeNonNegativeInteger(value: unknown, label: string): number {
  const normalized = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || Number(normalized) < 0) {
    throw new Error(`SQLite returned an unsafe ${label} during delete undo preflight`);
  }
  return Number(normalized);
}

/** Columns whose database values survive in the returned row object. */
export function deleteSnapshotValueColumns(
  insertableColumns: readonly string[],
  _includeSyntheticRowId: boolean
): string[] {
  return [...insertableColumns];
}

/**
 * Metadata-only aggregate; no TEXT/BLOB value crosses the engine boundary.
 * Its third column counts the distinct storage-class lists of the rows: the
 * first letter of typeof() names each class (n, i, r, t, b), so a row's
 * letters spell its list.
 */
export function buildDeleteSnapshotSizeQuery(
  table: string,
  valueColumns: readonly string[],
  predicate: RecordIdentityPredicate
): { sql: string; params: CellValue[] } {
  const valueBytes = joinExpressionTerms(valueColumns.map(column => {
    const escaped = escapeIdentifier(column);
    return (
      `CASE typeof(${escaped}) ` +
      `WHEN 'text' THEN 2 * octet_length(${escaped}) ` +
      `WHEN 'blob' THEN octet_length(${escaped}) ` +
      `WHEN 'integer' THEN 8 WHEN 'real' THEN 8 ELSE 0 END`
    );
  }), '+') || '0';
  const storageClassList = joinExpressionTerms(valueColumns.map(
    column => `substr(typeof(${escapeIdentifier(column)}), 1, 1)`
  ), '||') || "''";
  return {
    sql:
      `SELECT COUNT(*), COALESCE(SUM(${valueBytes}), 0), COUNT(DISTINCT ${storageClassList}) ` +
      `FROM ${escapeMainIdentifier(table)} WHERE ${predicate.sql}`,
    params: predicate.params
  };
}

export function parseDeleteSnapshotSizeRow(
  row: readonly unknown[] | undefined
): { rowCount: number; valueBytes: number; storageClassLists: number } {
  if (!row || row.length < 3) {
    throw new Error('SQLite omitted delete undo preflight metadata');
  }
  return {
    rowCount: safeNonNegativeInteger(row[0], 'row count'),
    valueBytes: safeNonNegativeInteger(row[1], 'value byte count'),
    storageClassLists: safeNonNegativeInteger(row[2], 'storage-class list count')
  };
}

/**
 * Refuse before the full snapshot SELECT when the exact undo entry cannot fit
 * the configured history cap. TEXT uses 2*UTF-8 bytes, a conservative upper
 * bound for the tracker’s UTF-16 string accounting; BLOB and primitives match
 * the tracker exactly.
 */
export function assertDeleteSnapshotFitsUndoBudget(input: {
  table: string;
  insertableColumns: readonly string[];
  includeSyntheticRowId: boolean;
  rowIds: readonly RecordId[];
  rowCount: number;
  valueBytes: number;
  maxSnapshotBytes: number;
  operation?: 'Delete' | 'Insert';
  storageClassListCount?: number;
}): void {
  if (!Number.isSafeInteger(input.maxSnapshotBytes) || input.maxSnapshotBytes < 0) {
    throw new Error('Delete undo snapshot budget must be a non-negative safe integer');
  }
  if (input.rowCount !== input.rowIds.length) {
    throw new Error(`Cannot delete from ${input.table}: one or more row identities no longer exist`);
  }

  const projectedBytes = projectDeleteSnapshotBytes(input);
  if (!Number.isSafeInteger(projectedBytes) || projectedBytes > input.maxSnapshotBytes) {
    throw undoSnapshotBudgetError(input.operation ?? 'Delete', input.maxSnapshotBytes);
  }
}

/** Snapshot bytes assertDeleteSnapshotFitsUndoBudget compares against the budget. */
export function projectDeleteSnapshotBytes(input: {
  insertableColumns: readonly string[];
  rowIds: readonly RecordId[];
  rowCount: number;
  valueBytes: number;
  /**
   * Count this many storage-class lists instead of one per row: the distinct
   * lists of the rows, which an entry whose snapshots share their lists
   * holds. Only for a caller that then charges every snapshot exactly
   * (deleteSnapshotCharger): this projection is then an early refusal, and
   * the charge is what holds the entry to the budget.
   */
  storageClassListCount?: number;
}): number {
  const rowKeys = new Set(input.insertableColumns);
  const rowKeyBytes = [...rowKeys].reduce((total, key) => total + key.length * 2, 0);
  const identityBytes = input.rowIds.reduce<number>(
    (total, rowId) => total + estimateUndoMemoryBytes(rowId),
    0
  );
  const listCount = Math.min(input.storageClassListCount ?? input.rowCount, input.rowCount);
  const storageClassBytes = listCount * input.insertableColumns.reduce(
    (total, column) => total + column.length * 2 + STORAGE_CLASS_ENTRY_STRUCTURAL_BYTES,
    0
  );
  return input.valueBytes
    // Synthetic row identity is retained only in DeletedRow.rowId. Keeping it
    // out of row avoids colliding with a legal declared column named rowid.
    + identityBytes
    + input.rowCount * (DELETED_ROW_STRUCTURAL_BYTES + rowKeyBytes)
    + storageClassBytes;
}

/**
 * `admittedRows`: how many rows of a batch fit before the refusal, which an
 * import reports. It travels in the message because a refusal from the
 * WebAssembly worker reaches the host as text.
 */
export function undoSnapshotBudgetError(
  operation: 'Delete' | 'Insert',
  maxSnapshotBytes: number,
  admittedRows?: number
): Error {
  return new Error(
    `${operation} undo snapshot exceeds the ${maxSnapshotBytes}-byte memory budget` +
    `${admittedRows === undefined ? '' : ` after ${admittedRows} rows`}; ` +
    `${operation.toLowerCase()} fewer rows or increase ` +
    'sqliteExplorer.maxUndoMemory.'
  );
}

/**
 * Charge each snapshot of a delete as its entry will count it, with equal
 * storage-class lists shared, and refuse once the snapshots pass the budget.
 * The engine reads every snapshot before it deletes a row, so a refusal
 * leaves the table as it was.
 */
export function deleteSnapshotCharger(maxSnapshotBytes: number | undefined): (snapshot: DeletedRow) => DeletedRow {
  const lists = new SharedStorageClassLists();
  let remaining = maxSnapshotBytes;
  return snapshot => {
    const bytes = lists.charge(snapshot);
    if (remaining !== undefined) {
      remaining -= bytes;
      if (remaining < 0) throw undoSnapshotBudgetError('Delete', maxSnapshotBytes!);
    }
    return snapshot;
  };
}

/** The admitted row count an undoSnapshotBudgetError names, if it names one. */
export function undoSnapshotBudgetAdmittedRows(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = / undo snapshot exceeds the \d+-byte memory budget after (\d+) rows;/.exec(error.message);
  return match ? Number(match[1]) : undefined;
}

/** Whether an error is undoSnapshotBudgetError's, also after a worker passed on its message. */
export function isUndoSnapshotBudgetError(error: unknown, operation: 'Delete' | 'Insert'): boolean {
  return error instanceof Error
    && new RegExp(`${operation} undo snapshot exceeds the \\d+-byte memory budget`).test(error.message);
}
