import {
  OversizedCellReplacementRequiredError
} from './cell-edit-policy';
import { SQLITE_MAX_VARIABLE_NUMBER } from './integer-utils';
import { escapeIdentifier, escapeMainIdentifier, validateRowId } from './sql-utils';
import {
  buildRecordIdentityPredicateChunks
} from './row-identity';
import type { CellUpdate, CellValue, TableIdentity } from './types';

export interface BatchPriorLimitQuery {
  column: string;
  sql: string;
  params: CellValue[];
}

export interface BatchHistorySizePreflight {
  queries: Array<{ sql: string; params: CellValue[] }>;
  expectedCellCount: number;
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
          `FROM ${escapeMainIdentifier(table)} ` +
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

function batchHistoryValueBytes(column: string): string {
  const escaped = escapeIdentifier(column);
  return (
    `CASE typeof(${escaped}) `
    + `WHEN 'text' THEN 2 * octet_length(${escaped}) `
    + `WHEN 'blob' THEN octet_length(${escaped}) `
    + `WHEN 'integer' THEN 8 WHEN 'real' THEN 8 ELSE 0 END`
  );
}

/**
 * Build chunked metadata-only aggregates for exactly the cells whose prior
 * values will be retained by batch undo. No TEXT/BLOB value crosses the engine
 * boundary until the complete aggregate has been admitted.
 */
export function buildBatchHistorySizePreflight(
  table: string,
  updates: readonly CellUpdate[],
  identity: TableIdentity
): BatchHistorySizePreflight {
  const rowIdsByColumn = new Map<string, Map<string, CellUpdate['rowId']>>();
  let expectedCellCount = 0;
  for (const update of updates) {
    const rowKey = String(update.rowId);
    let rowIds = rowIdsByColumn.get(update.column);
    if (!rowIds) {
      rowIds = new Map();
      rowIdsByColumn.set(update.column, rowIds);
    }
    if (rowIds.has(rowKey)) {
      throw new Error(`Batch update for ${table} contains the same cell more than once`);
    }
    rowIds.set(rowKey, update.rowId);
    expectedCellCount++;
  }

  const queries: BatchHistorySizePreflight['queries'] = [];
  for (const [column, rowIds] of rowIdsByColumn) {
    for (const predicate of buildRecordIdentityPredicateChunks([...rowIds.values()], identity)) {
      queries.push({
        sql:
          `SELECT COUNT(*), COALESCE(SUM(${batchHistoryValueBytes(column)}), 0) `
          + `FROM ${escapeMainIdentifier(table)} WHERE ${predicate.sql}`,
        params: predicate.params
      });
    }
  }
  return { queries, expectedCellCount };
}

function safeHistoryAggregateInteger(value: unknown, label: string): number {
  const normalized = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || Number(normalized) < 0) {
    throw new Error(`SQLite returned an unsafe ${label} during batch undo preflight`);
  }
  return Number(normalized);
}

/** Refuse the full-value SELECT when aggregate prior values cannot fit history. */
export function assertBatchHistoryFitsUndoBudget(input: {
  table: string;
  preflight: BatchHistorySizePreflight;
  resultRows: readonly (readonly unknown[] | undefined)[];
  maxPriorValueBytes: number;
}): void {
  if (!Number.isSafeInteger(input.maxPriorValueBytes) || input.maxPriorValueBytes < 0) {
    throw new Error('Batch update undo snapshot budget must be a non-negative safe integer');
  }
  if (input.resultRows.length !== input.preflight.queries.length) {
    throw new Error('SQLite returned incomplete batch undo preflight metadata');
  }

  let cellCount = 0;
  let valueBytes = 0;
  for (const row of input.resultRows) {
    if (!row || row.length < 2) {
      throw new Error('SQLite omitted batch undo preflight metadata');
    }
    cellCount += safeHistoryAggregateInteger(row[0], 'cell count');
    valueBytes += safeHistoryAggregateInteger(row[1], 'value byte count');
    if (!Number.isSafeInteger(cellCount) || !Number.isSafeInteger(valueBytes)) {
      throw new Error('SQLite returned unsafe aggregate batch undo metadata');
    }
  }
  if (cellCount !== input.preflight.expectedCellCount) {
    throw new Error(`Cannot update ${input.table}: one or more row identities no longer exist`);
  }
  if (valueBytes > input.maxPriorValueBytes) {
    throw new Error(
      `Batch update undo snapshot exceeds the ${input.maxPriorValueBytes}-byte memory budget; `
      + 'update fewer cells or increase sqliteExplorer.maxUndoMemory.'
    );
  }
}
