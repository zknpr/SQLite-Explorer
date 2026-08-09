import {
  OversizedCellReplacementRequiredError
} from './cell-edit-policy';
import { SQLITE_MAX_VARIABLE_NUMBER } from './integer-utils';
import { escapeIdentifier, validateRowId } from './sql-utils';
import type { CellUpdate, CellValue } from './types';

export interface BatchPriorLimitQuery {
  column: string;
  sql: string;
  params: CellValue[];
}

// Each query reserves one bind for the edit limit. Staying below SQLite's
// bundled variable ceiling also bounds SQL text and worker-message size.
export const BATCH_PRIOR_ROWID_CHUNK_SIZE = SQLITE_MAX_VARIABLE_NUMBER - 1;

/**
 * Build metadata-only guards for rowid batches without one query per cell.
 * Distinct row identities are checked once per column and no prior value is
 * materialized before the caller has confirmed that every value is bounded.
 */
export function buildBatchPriorLimitQueries(
  table: string,
  updates: readonly CellUpdate[],
  editLimitBytes: number
): BatchPriorLimitQuery[] {
  const rowIdsByColumn = new Map<string, Map<string, CellValue>>();
  for (const update of updates) {
    const rowId = validateRowId(update.rowId);
    let rowIds = rowIdsByColumn.get(update.column);
    if (!rowIds) {
      rowIds = new Map();
      rowIdsByColumn.set(update.column, rowIds);
    }
    rowIds.set(String(rowId), rowId);
  }

  const queries: BatchPriorLimitQuery[] = [];
  for (const [column, rowIdMap] of rowIdsByColumn) {
    const rowIds = [...rowIdMap.values()];
    const escapedColumn = escapeIdentifier(column);
    for (let offset = 0; offset < rowIds.length; offset += BATCH_PRIOR_ROWID_CHUNK_SIZE) {
      const chunk = rowIds.slice(offset, offset + BATCH_PRIOR_ROWID_CHUNK_SIZE);
      queries.push({
        column,
        sql:
          `SELECT typeof(${escapedColumn}) AS "storage_class", ` +
          `length(CAST(${escapedColumn} AS BLOB)) AS "byte_length" ` +
          `FROM ${escapeIdentifier(table)} ` +
          `WHERE rowid IN (${chunk.map(() => '?').join(', ')}) ` +
          `AND typeof(${escapedColumn}) IN ('text', 'blob') ` +
          `AND length(CAST(${escapedColumn} AS BLOB)) > ? LIMIT 1`,
        params: [...chunk, editLimitBytes]
      });
    }
  }
  return queries;
}

/** Validate one metadata-only query result and raise the established refusal. */
export function assertBatchPriorLimitResult(
  table: string,
  query: Pick<BatchPriorLimitQuery, 'column'>,
  rows: readonly (readonly unknown[])[],
  editLimitBytes: number
): void {
  if (rows.length === 0) return;
  if (rows.length !== 1 || rows[0].length < 2) {
    throw new Error(`SQLite returned invalid batch metadata for ${table}.${query.column}`);
  }

  const storageClass = rows[0][0];
  const rawByteLength = rows[0][1];
  const byteLength = typeof rawByteLength === 'bigint'
    ? Number(rawByteLength)
    : rawByteLength;
  if (
    (storageClass !== 'text' && storageClass !== 'blob')
    || !Number.isSafeInteger(byteLength)
    || Number(byteLength) <= editLimitBytes
  ) {
    throw new Error(`SQLite returned invalid batch metadata for ${table}.${query.column}`);
  }

  throw new OversizedCellReplacementRequiredError(
    table,
    query.column,
    storageClass,
    Number(byteLength),
    editLimitBytes
  );
}
