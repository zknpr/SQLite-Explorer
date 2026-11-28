import type {
  CellValue,
  DeletedRow,
  StoredCellState
} from './types';
import {
  buildStoredCellPredicate,
  buildStoredCellWrite,
  parseStoredCellState,
  type StoredCellSqlFragment
} from './cell-history';
import { foldSqliteIdentifier } from './integer-utils';
import { escapeIdentifier, joinExpressionTerms } from './sql-utils';

export const ROW_HISTORY_CONFLICT_MESSAGE =
  'Row changed outside SQLite Explorer history; undo/redo was not applied.';

export const LEGACY_ROW_HISTORY_MESSAGE =
  'This row edit predates guarded row history and cannot be replayed safely. Save or reload the database.';

export class RowHistoryConflictError extends Error {
  readonly code = 'SQLITE_EXPLORER_ROW_HISTORY_CONFLICT';

  constructor(table: string) {
    super(`${table}: ${ROW_HISTORY_CONFLICT_MESSAGE}`);
    this.name = 'RowHistoryConflictError';
  }
}

export class LegacyRowHistoryError extends Error {
  readonly code = 'SQLITE_EXPLORER_LEGACY_ROW_HISTORY';

  constructor() {
    super(LEGACY_ROW_HISTORY_MESSAGE);
    this.name = 'LegacyRowHistoryError';
  }
}

/**
 * Columns one row-history SELECT reads. SQLite caps a result set at 2,000
 * columns in both engines' builds, and buildStoredCellStateProjection returns
 * two per column beside an optional rowid.
 */
const ROW_HISTORY_COLUMNS_PER_SELECT = 999;

/** A row's columns in SELECT-sized chunks: the whole list up to one SELECT. */
export function chunkRowHistoryColumns(columns: readonly string[]): string[][] {
  if (columns.length <= ROW_HISTORY_COLUMNS_PER_SELECT) return [[...columns]];
  const chunks: string[][] = [];
  for (let start = 0; start < columns.length; start += ROW_HISTORY_COLUMNS_PER_SELECT) {
    chunks.push(columns.slice(start, start + ROW_HISTORY_COLUMNS_PER_SELECT));
  }
  return chunks;
}

export interface RowHistoryState {
  column: string;
  state: StoredCellState;
}

/** Rehydrate exact values from the compact row plus storage-class sidecar. */
export function rowHistoryStates(snapshot: DeletedRow): RowHistoryState[] {
  if (!Array.isArray(snapshot.storageClasses)) throw new LegacyRowHistoryError();
  const seen = new Set<string>();
  return snapshot.storageClasses.map(entry => {
    const canonicalColumn = typeof entry?.column === 'string'
      ? foldSqliteIdentifier(entry.column)
      : undefined;
    if (
      !entry ||
      typeof entry.column !== 'string' ||
      canonicalColumn === undefined ||
      seen.has(canonicalColumn) ||
      !Object.prototype.hasOwnProperty.call(snapshot.row, entry.column)
    ) {
      throw new LegacyRowHistoryError();
    }
    seen.add(canonicalColumn);
    const storedValue = snapshot.row[entry.column];
    const rawTextBytes = entry.storageClass === 'text' && storedValue instanceof Uint8Array
      ? storedValue
      : undefined;
    return {
      column: entry.column,
      state: parseStoredCellState(
        entry.storageClass,
        rawTextBytes ? '' : storedValue,
        `row history column ${entry.column}`,
        { rawTextBytes }
      )
    };
  });
}

/** `states` is rowHistoryStates(snapshot), when the caller already has it. */
export function buildRowHistoryPredicate(
  snapshot: DeletedRow,
  bindPlaceholder: (value: CellValue) => string = () => '?',
  states: readonly RowHistoryState[] = rowHistoryStates(snapshot)
): StoredCellSqlFragment {
  const predicates = states.map(({ column, state }) => (
    buildStoredCellPredicate(column, state, bindPlaceholder)
  ));
  return {
    sql: predicates.length > 0
      ? joinExpressionTerms(predicates.map(predicate => `(${predicate.sql})`), 'AND')
      : '1',
    params: predicates.flatMap(predicate => predicate.params)
  };
}

/**
 * SQL compares REAL 0.0 and -0.0 as equal, so buildRowHistoryPredicate cannot
 * tell which zero a typeless column holds. A snapshot with a REAL zero is
 * checked in JavaScript as well: `projection` reads each such column as its
 * REAL value or NULL, and realZerosMatch compares the row with Object.is.
 */
export interface RealZeroCheck {
  projection: string;
  expected: readonly number[];
}

export function buildRealZeroCheck(states: readonly RowHistoryState[]): RealZeroCheck | undefined {
  const zeros = states.filter(({ state }) => state.storageClass === 'real' && state.value === 0);
  if (zeros.length === 0) return undefined;
  return {
    projection: zeros.map(({ column }) => {
      const escaped = escapeIdentifier(column);
      return `CASE WHEN typeof(${escaped}) = 'real' THEN ${escaped} END`;
    }).join(', '),
    expected: zeros.map(({ state }) => state.value as number)
  };
}

/** `row`: the projection read by the row's identity, undefined unless exactly one row matched. */
export function realZerosMatch(check: RealZeroCheck, row: readonly unknown[] | undefined): boolean {
  return row !== undefined && check.expected.every((value, index) => Object.is(row[index], value));
}

export function buildRowHistoryWrites(
  snapshot: DeletedRow,
  bindPlaceholder: (value: CellValue) => string = () => '?',
  states: readonly RowHistoryState[] = rowHistoryStates(snapshot)
): Array<{ column: string; write: StoredCellSqlFragment }> {
  return states.map(({ column, state }) => ({
    column,
    write: buildStoredCellWrite(state, bindPlaceholder)
  }));
}
