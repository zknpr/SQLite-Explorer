import type {
  CellStorageClass,
  CellTextEncoding,
  CellValue,
  StoredCellState
} from './types';
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
  // TEXT must cross the engine boundary as database bytes. A malformed value
  // decoded to a JS string cannot otherwise be distinguished from a literal
  // replacement character, and history would restore different bytes.
  return (
    `typeof(${escaped}), CASE WHEN typeof(${escaped}) = 'text' ` +
    `THEN CAST(${escaped} AS BLOB) ELSE ${escaped} END`
  );
}

export interface StoredCellStateParseOptions {
  /** Required when a fresh TEXT projection arrives as database bytes. */
  textEncoding?: CellTextEncoding;
  /** Exact bytes retained by a serialized row-history snapshot. */
  rawTextBytes?: unknown;
}

function decodeProjectedText(
  bytes: Uint8Array,
  encoding: CellTextEncoding | undefined,
  context: string
): Pick<StoredCellState, 'value' | 'rawTextBytes'> {
  if (!encoding) {
    throw new Error(`SQLite text encoding is required for ${context}`);
  }
  try {
    return {
      value: new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes)
    };
  } catch {
    // A replacement-character string is neither authoritative nor useful for
    // replay. Keep a constant-size display fallback and retain only exact bytes.
    return {
      value: '',
      rawTextBytes: bytes
    };
  }
}

export function parseStoredCellState(
  storageClassRaw: unknown,
  value: unknown,
  context: string,
  options: StoredCellStateParseOptions = {}
): StoredCellState {
  if (
    typeof storageClassRaw !== 'string'
    || !CELL_STORAGE_CLASSES.has(storageClassRaw as CellStorageClass)
  ) {
    throw new Error(`SQLite returned an invalid storage class for ${context}`);
  }
  const storageClass = storageClassRaw as CellStorageClass;
  if (storageClass !== 'text' && options.rawTextBytes !== undefined) {
    throw new Error(`SQLite returned raw TEXT bytes for non-TEXT ${context}`);
  }
  if (storageClass === 'text') {
    if (value instanceof Uint8Array) {
      return {
        storageClass,
        ...decodeProjectedText(value, options.textEncoding, context)
      };
    }
    if (typeof value !== 'string') {
      throw new Error(`SQLite returned an invalid text value for ${context}`);
    }
    if (options.rawTextBytes !== undefined && !(options.rawTextBytes instanceof Uint8Array)) {
      throw new Error(`SQLite returned invalid raw TEXT bytes for ${context}`);
    }
    return {
      storageClass,
      value,
      ...(options.rawTextBytes instanceof Uint8Array
        ? { rawTextBytes: options.rawTextBytes }
        : {})
    };
  }
  const valid = storageClass === 'null'
    ? value === null
    : storageClass === 'integer'
      ? typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value))
      : storageClass === 'real'
        ? typeof value === 'number'
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
  parseStoredCellState(state.storageClass, state.value, 'cell history', {
    rawTextBytes: state.rawTextBytes
  });
}

export function storedCellStatesEqual(left: StoredCellState, right: StoredCellState): boolean {
  if (left.storageClass !== right.storageClass) return false;
  if (left.storageClass === 'text') {
    const leftBytes = left.rawTextBytes;
    const rightBytes = right.rawTextBytes;
    if (leftBytes || rightBytes) {
      if (!leftBytes || !rightBytes) return false;
      return leftBytes.length === rightBytes.length
        && leftBytes.every((byte, index) => byte === rightBytes[index]);
    }
  }
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
      return {
        // Binding a BLOB directly through CAST(? AS TEXT) transcodes it from
        // the connection encoding in UTF-16 databases. substr(BLOB, 1) keeps
        // the value byte-oriented until SQLite applies the TEXT storage class.
        sql: state.rawTextBytes
          ? 'CAST(substr(?, 1) AS TEXT)'
          : 'CAST(? AS TEXT)',
        params: [state.rawTextBytes ?? state.value]
      };
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
        params: [state.rawTextBytes ?? state.value]
      };
    case 'blob':
      return {
        sql: `typeof(${escaped}) = 'blob' AND ${escaped} IS ?`,
        params: [state.value]
      };
  }
}
