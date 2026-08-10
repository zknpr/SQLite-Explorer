import type { CellValue, RecordId } from './types';
import type { RecordIdentityPredicate } from './row-identity';
import { estimateUndoMemoryBytes } from './undo-history';
import { escapeIdentifier } from './sql-utils';

const DELETED_ROW_STRUCTURAL_BYTES = 32;

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
  includeSyntheticRowId: boolean
): string[] {
  return includeSyntheticRowId
    ? insertableColumns.filter(column => column !== 'rowid')
    : [...insertableColumns];
}

/** Metadata-only aggregate; no TEXT/BLOB value crosses the engine boundary. */
export function buildDeleteSnapshotSizeQuery(
  table: string,
  valueColumns: readonly string[],
  predicate: RecordIdentityPredicate
): { sql: string; params: CellValue[] } {
  const valueBytes = valueColumns.map(column => {
    const escaped = escapeIdentifier(column);
    return (
      `CASE typeof(${escaped}) ` +
      `WHEN 'text' THEN 2 * octet_length(${escaped}) ` +
      `WHEN 'blob' THEN octet_length(${escaped}) ` +
      `WHEN 'integer' THEN 8 WHEN 'real' THEN 8 ELSE 0 END`
    );
  }).join(' + ') || '0';
  return {
    sql:
      `SELECT COUNT(*), COALESCE(SUM(${valueBytes}), 0) ` +
      `FROM ${escapeIdentifier(table)} WHERE ${predicate.sql}`,
    params: predicate.params
  };
}

export function parseDeleteSnapshotSizeRow(
  row: readonly unknown[] | undefined
): { rowCount: number; valueBytes: number } {
  if (!row || row.length < 2) {
    throw new Error('SQLite omitted delete undo preflight metadata');
  }
  return {
    rowCount: safeNonNegativeInteger(row[0], 'row count'),
    valueBytes: safeNonNegativeInteger(row[1], 'value byte count')
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
}): void {
  if (!Number.isSafeInteger(input.maxSnapshotBytes) || input.maxSnapshotBytes < 0) {
    throw new Error('Delete undo snapshot budget must be a non-negative safe integer');
  }
  if (input.rowCount !== input.rowIds.length) {
    throw new Error(`Cannot delete from ${input.table}: one or more row identities no longer exist`);
  }

  const rowKeys = new Set(input.insertableColumns);
  if (input.includeSyntheticRowId) rowKeys.add('rowid');
  const rowKeyBytes = [...rowKeys].reduce((total, key) => total + key.length * 2, 0);
  const identityBytes = input.rowIds.reduce<number>(
    (total, rowId) => total + estimateUndoMemoryBytes(rowId),
    0
  );
  const projectedBytes = input.valueBytes
    // Every DeletedRow retains rowId; rowid tables also restore the same value
    // from row.rowid, so the snapshot owns a second primitive/string copy.
    + identityBytes * (input.includeSyntheticRowId ? 2 : 1)
    + input.rowCount * (DELETED_ROW_STRUCTURAL_BYTES + rowKeyBytes);

  if (!Number.isSafeInteger(projectedBytes) || projectedBytes > input.maxSnapshotBytes) {
    throw new Error(
      `Delete undo snapshot exceeds the ${input.maxSnapshotBytes}-byte memory budget; ` +
      'delete fewer rows or increase sqliteExplorer.maxUndoMemory.'
    );
  }
}
