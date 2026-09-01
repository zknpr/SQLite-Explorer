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
    return {
      column: entry.column,
      state: parseStoredCellState(
        entry.storageClass,
        snapshot.row[entry.column],
        `row history column ${entry.column}`
      )
    };
  });
}

export function buildRowHistoryPredicate(
  snapshot: DeletedRow,
  bindPlaceholder: (value: CellValue) => string = () => '?'
): StoredCellSqlFragment {
  const predicates = rowHistoryStates(snapshot).map(({ column, state }) => (
    buildStoredCellPredicate(column, state, bindPlaceholder)
  ));
  return {
    sql: predicates.length > 0
      ? predicates.map(predicate => `(${predicate.sql})`).join(' AND ')
      : '1',
    params: predicates.flatMap(predicate => predicate.params)
  };
}

export function buildRowHistoryWrites(
  snapshot: DeletedRow,
  bindPlaceholder: (value: CellValue) => string = () => '?'
): Array<{ column: string; write: StoredCellSqlFragment }> {
  return rowHistoryStates(snapshot).map(({ column, state }) => ({
    column,
    write: buildStoredCellWrite(state, bindPlaceholder)
  }));
}
