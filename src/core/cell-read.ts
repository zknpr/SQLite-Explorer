import type {
  CellMetadata,
  CellReadTarget,
  CellStorageClass,
  CellTextEncoding,
  CellValue
} from './types';
import { escapeIdentifier } from './sql-utils';

/** One RPC response stays at or below Stage A's default per-cell ceiling. */
export const MAX_CELL_READ_CHUNK_BYTES = 1024 * 1024;
export const DEFAULT_CELL_READ_SESSION_IDLE_TIMEOUT_MS = 30_000;
export const DEFAULT_CELL_READ_SESSION_ABSOLUTE_TIMEOUT_MS = 5 * 60_000;

const CELL_STORAGE_CLASSES = new Set<CellStorageClass>([
  'null',
  'integer',
  'real',
  'text',
  'blob'
]);

export interface CellReadSqlTarget {
  table: string;
  column: string;
  predicateSql: string;
  predicateParams: CellValue[];
}

export function validateCellReadTarget(target: CellReadTarget): void {
  if (!target || typeof target !== 'object') throw new Error('Cell read target is required');
  if (typeof target.table !== 'string' || target.table.length === 0) {
    throw new Error('Cell read table must be a non-empty string');
  }
  if (typeof target.column !== 'string' || target.column.length === 0) {
    throw new Error('Cell read column must be a non-empty string');
  }
}

export function validateCellReadWindow(byteOffset: number, maxBytes: number): void {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new Error('Cell read byte offset must be a non-negative safe integer');
  }
  if (
    !Number.isSafeInteger(maxBytes)
    || maxBytes < 1
    || maxBytes > MAX_CELL_READ_CHUNK_BYTES
  ) {
    throw new Error(
      `Cell read chunk size must be an integer from 1 through ${MAX_CELL_READ_CHUNK_BYTES}`
    );
  }
}

export function normalizeCellTextEncoding(value: unknown): CellTextEncoding {
  const normalized = String(value).toLowerCase().replace(/[_\s-]/g, '');
  if (normalized === 'utf8') return 'utf-8';
  if (normalized === 'utf16le') return 'utf-16le';
  if (normalized === 'utf16be') return 'utf-16be';
  throw new Error(`Unsupported SQLite text encoding: ${String(value)}`);
}

export function buildCellMetadataQuery(target: CellReadSqlTarget): {
  sql: string;
  params: CellValue[];
} {
  const column = escapeIdentifier(target.column);
  return {
    sql:
      `SELECT typeof(${column}), ` +
      `CASE WHEN ${column} IS NULL THEN 0 ELSE length(CAST(${column} AS BLOB)) END ` +
      `FROM ${escapeIdentifier(target.table)} WHERE ${target.predicateSql} LIMIT 2`,
    params: target.predicateParams
  };
}

export function buildCellChunkQuery(target: CellReadSqlTarget): {
  sql: string;
  params: CellValue[];
} {
  const column = escapeIdentifier(target.column);
  return {
    // Offsets are bytes in SQLite's database encoding. Casting before substr()
    // is the invariant that prevents TEXT character indices from being confused
    // with either UTF-8 bytes or JavaScript UTF-16 code units.
    sql:
      `SELECT substr(CAST(${column} AS BLOB), ? + 1, ?) ` +
      `FROM ${escapeIdentifier(target.table)} WHERE ${target.predicateSql} LIMIT 2`,
    params: target.predicateParams
  };
}

export function decodeCellMetadata(
  rows: readonly (readonly unknown[])[],
  textEncoding: CellTextEncoding,
  target: CellReadTarget
): CellMetadata {
  if (rows.length !== 1) {
    throw new Error(
      rows.length === 0
        ? `Cell ${target.table}.${target.column} no longer exists`
        : `Cell ${target.table}.${target.column} matched more than one row`
    );
  }
  const storageClass = rows[0][0];
  if (typeof storageClass !== 'string' || !CELL_STORAGE_CLASSES.has(storageClass as CellStorageClass)) {
    throw new Error(`SQLite returned an invalid storage class for ${target.table}.${target.column}`);
  }
  const rawByteLength = rows[0][1];
  const byteLength = typeof rawByteLength === 'bigint'
    ? Number(rawByteLength)
    : rawByteLength;
  if (!Number.isSafeInteger(byteLength) || Number(byteLength) < 0) {
    throw new Error(`SQLite returned an unsafe byte length for ${target.table}.${target.column}`);
  }
  return {
    storageClass: storageClass as CellStorageClass,
    byteLength: Number(byteLength),
    ...(storageClass === 'text' ? { textEncoding } : {})
  };
}

export function normalizeCellReadTimeout(
  value: number | undefined,
  fallback: number
): number {
  return Number.isFinite(value) && Number(value) >= 1
    ? Math.floor(Number(value))
    : fallback;
}
