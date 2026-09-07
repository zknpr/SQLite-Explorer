import type { TableQueryOptions } from './types';

/**
 * Hard ceiling declared by sqliteExplorer.defaultPageSize in package.json.
 * This is a server-side boundary too: webview values are untrusted and a raw
 * SQLite `LIMIT -1` (or a limit rounded past the safe range) is unbounded.
 */
export const MAX_TABLE_PAGE_ROWS = 100_000;
export const DEFAULT_TABLE_PAGE_ROWS = 5_000;

export function normalizeTablePageLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('Table page limit must be a positive safe integer');
  }
  return Math.min(value, MAX_TABLE_PAGE_ROWS);
}

export function normalizeTablePageOffset(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Table page offset must be a non-negative safe integer');
  }
  return value;
}

/** Normalize an untrusted table-page request before any query planning. */
export function normalizeTablePageOptions(
  options: TableQueryOptions,
  defaultLimit: number = DEFAULT_TABLE_PAGE_ROWS
): TableQueryOptions & { limit: number; offset: number } {
  return {
    ...options,
    limit: normalizeTablePageLimit(options.limit ?? defaultLimit),
    offset: normalizeTablePageOffset(options.offset ?? 0)
  };
}
