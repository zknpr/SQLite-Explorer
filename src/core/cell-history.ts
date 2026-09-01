import type { CellStorageClass, CellValue, StoredCellState } from './types';
import { escapeIdentifier } from './sql-utils';

const CELL_STORAGE_CLASSES = new Set<CellStorageClass>([
  'null',
  'integer',
  'real',
  'text',
  'blob'
]);

export const CELL_HISTORY_CONFLICT_MESSAGE =
  'Cell changed outside SQLite Explorer history; undo/redo was not applied.';

export const LEGACY_CELL_HISTORY_MESSAGE =
  'This edit predates guarded cell history and cannot be replayed safely. Save or reload the database.';

export class CellHistoryConflictError extends Error {
  readonly code = 'SQLITE_EXPLORER_CELL_HISTORY_CONFLICT';

  constructor(table: string, columns: readonly string[]) {
    const target = columns.length === 1
      ? `${table}.${columns[0]}`
      : `${columns.length} cells in ${table}`;
    super(`${target}: ${CELL_HISTORY_CONFLICT_MESSAGE}`);
    this.name = 'CellHistoryConflictError';
  }
}

export class LegacyCellHistoryError extends Error {
  readonly code = 'SQLITE_EXPLORER_LEGACY_CELL_HISTORY';

  constructor() {
    super(LEGACY_CELL_HISTORY_MESSAGE);
    this.name = 'LegacyCellHistoryError';
  }
}

export function buildStoredCellStateProjection(column: string): string {
  const escaped = escapeIdentifier(column);
  return `typeof(${escaped}), ${escaped}`;
}

export function parseStoredCellState(
  storageClassRaw: unknown,
  value: unknown,
  context: string
): StoredCellState {
  if (
    typeof storageClassRaw !== 'string'
    || !CELL_STORAGE_CLASSES.has(storageClassRaw as CellStorageClass)
  ) {
    throw new Error(`SQLite returned an invalid storage class for ${context}`);
  }
  const storageClass = storageClassRaw as CellStorageClass;
  const valid = storageClass === 'null'
    ? value === null
    : storageClass === 'integer'
      ? typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value))
      : storageClass === 'real'
        ? typeof value === 'number'
        : storageClass === 'text'
          ? typeof value === 'string'
          : value instanceof Uint8Array;
  if (!valid) {
    throw new Error(`SQLite returned an invalid ${storageClass} value for ${context}`);
  }
  return { storageClass, value: value as CellValue };
}

export function assertStoredCellState(
  state: StoredCellState | undefined
): asserts state is StoredCellState {
  if (!state || typeof state !== 'object') throw new LegacyCellHistoryError();
  parseStoredCellState(state.storageClass, state.value, 'cell history');
}

export function storedCellStatesEqual(left: StoredCellState, right: StoredCellState): boolean {
  if (left.storageClass !== right.storageClass) return false;
  const leftValue = left.value;
  const rightValue = right.value;
  if (leftValue instanceof Uint8Array || rightValue instanceof Uint8Array) {
    if (!(leftValue instanceof Uint8Array) || !(rightValue instanceof Uint8Array)) return false;
    return leftValue.length === rightValue.length
      && leftValue.every((byte, index) => byte === rightValue[index]);
  }
  return Object.is(leftValue, rightValue);
}

export interface StoredCellSqlFragment {
  sql: string;
  params: CellValue[];
}

type BindPlaceholder = (value: CellValue) => string;

/** Bind a value so a typeless column regains the recorded storage class. */
export function buildStoredCellWrite(
  state: StoredCellState,
  bindPlaceholder: BindPlaceholder = () => '?'
): StoredCellSqlFragment {
  assertStoredCellState(state);
  switch (state.storageClass) {
    case 'null':
      return { sql: 'NULL', params: [] };
    case 'integer':
      return { sql: bindPlaceholder(state.value), params: [state.value] };
    case 'real':
      return { sql: 'CAST(? AS REAL)', params: [state.value] };
    case 'text':
      return { sql: 'CAST(? AS TEXT)', params: [state.value] };
    case 'blob':
      return { sql: '?', params: [state.value] };
  }
}

/** Match both value and storage class, bypassing declared column collation. */
export function buildStoredCellPredicate(
  column: string,
  state: StoredCellState,
  bindPlaceholder: BindPlaceholder = () => '?'
): StoredCellSqlFragment {
  assertStoredCellState(state);
  const escaped = escapeIdentifier(column);
  switch (state.storageClass) {
    case 'null':
      return { sql: `typeof(${escaped}) = 'null'`, params: [] };
    case 'integer': {
      const placeholder = bindPlaceholder(state.value);
      return {
        sql: `typeof(${escaped}) = 'integer' AND ${escaped} IS ${placeholder}`,
        params: [state.value]
      };
    }
    case 'real':
      return {
        sql: `typeof(${escaped}) = 'real' AND ${escaped} IS CAST(? AS REAL)`,
        params: [state.value]
      };
    case 'text':
      return {
        sql: `typeof(${escaped}) = 'text' AND CAST(${escaped} AS BLOB) = CAST(? AS BLOB)`,
        params: [state.value]
      };
    case 'blob':
      return {
        sql: `typeof(${escaped}) = 'blob' AND ${escaped} IS ?`,
        params: [state.value]
      };
  }
}
