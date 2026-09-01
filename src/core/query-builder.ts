/**
 * Query Builder Module
 *
 * Constructs safe SQL queries for read operations.
 */
import { escapeIdentifier, escapeLikePattern, escapeMainIdentifier } from './sql-utils';
import { getActiveFilterValue } from './filter-utils';
import { assembleKeysetSelect, type ResolvedKeysetPlan } from './keyset-pagination';
import type { CellValue, TableQueryOptions, TableCountOptions } from './types';
import {
  normalizeTablePageLimit,
  normalizeTablePageOffset
} from './table-pagination';

export { MAX_TABLE_PAGE_ROWS } from './table-pagination';

/**
 * Build a SELECT query from options.
 *
 * `keysetPlan` is an engine-resolved (never webview-supplied) seek plan; when
 * present it owns ORDER BY and LIMIT, and the options' orderBy/limit/offset
 * are ignored. Without it the emitted SQL is unchanged.
 */
export function buildSelectQuery(
  table: string,
  options: TableQueryOptions,
  keysetPlan?: ResolvedKeysetPlan
): { sql: string; params: CellValue[] } {
  const {
    columns = ['*'],
    orderBy,
    orderByColumns,
    orderDir = 'ASC',
    limit,
    offset,
    filters = [],
    globalFilter,
    globalFilterColumns = columns
  } = options;

  const escapedTable = escapeMainIdentifier(table);
  const escapedColumns = columns.map(col => {
    if (col === '*') return '*';
    if (col === 'rowid') return '"rowid" AS "rowid"';
    return escapeIdentifier(col);
  }).join(', ');

  let sql = `SELECT ${escapedColumns} FROM ${escapedTable}`;
  const whereClauses: string[] = [];
  const params: CellValue[] = [];

  const { conditions, params: filterParams } = buildFilterConditions(
    filters,
    globalFilter,
    globalFilterColumns
  );
  whereClauses.push(...conditions);
  params.push(...filterParams);

  if (keysetPlan) {
    return assembleKeysetSelect({
      selectListSql: escapedColumns,
      escapedTable,
      whereClauses,
      filterParams: params,
      plan: {
        ...keysetPlan,
        limit: normalizeTablePageLimit(keysetPlan.limit)
      }
    });
  }

  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(' AND ')}`;
  }

  const orderedColumns = orderByColumns?.length
    ? orderByColumns
    : (orderBy ? [orderBy] : []);
  if (orderedColumns.length > 0) {
    const direction = orderDir === 'DESC' ? 'DESC' : 'ASC';
    sql += ` ORDER BY ${orderedColumns
      .map(column => `${escapeIdentifier(column)} ${direction}`)
      .join(', ')}`;
  }

  if (limit !== undefined) {
    sql += ` LIMIT ${normalizeTablePageLimit(limit)}`;
  }

  if (offset !== undefined) {
    sql += ` OFFSET ${normalizeTablePageOffset(offset)}`;
  }

  return { sql, params };
}

/**
 * Build a COUNT query from options.
 */
export function buildCountQuery(table: string, options: TableCountOptions): { sql: string; params: CellValue[] } {
  const {
    columns = [],
    globalFilterColumns = columns,
    filters = [],
    globalFilter
  } = options;

  const escapedTable = escapeMainIdentifier(table);
  let sql = `SELECT COUNT(*) as count FROM ${escapedTable}`;
  const whereClauses: string[] = [];
  const params: CellValue[] = [];

  const { conditions, params: filterParams } = buildFilterConditions(
    filters,
    globalFilter,
    globalFilterColumns
  );
  whereClauses.push(...conditions);
  params.push(...filterParams);

  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(' AND ')}`;
  }

  return { sql, params };
}

/**
 * Helper to build WHERE conditions for column filters and global search.
 */
function buildFilterConditions(
  filters: { column: string; value: string }[] = [],
  globalFilter: string | undefined,
  searchColumns: string[]
): { conditions: string[]; params: CellValue[] } {
  const conditions: string[] = [];
  const params: CellValue[] = [];

  // Column filters
  for (const filter of filters) {
    const filterValue = getActiveFilterValue(filter.value);
    if (filterValue !== undefined) {
      conditions.push(`${escapeIdentifier(filter.column)} LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLikePattern(filterValue)}%`);
    }
  }

  // Global filter
  const activeGlobalFilter = getActiveFilterValue(globalFilter);
  if (activeGlobalFilter !== undefined && searchColumns.length > 0) {
    const globalConditions = searchColumns
      .map(col => `${escapeIdentifier(col)} LIKE ? ESCAPE '\\'`)
      .join(' OR ');

    conditions.push(`(${globalConditions})`);
    for (let i = 0; i < searchColumns.length; i++) {
      params.push(`%${escapeLikePattern(activeGlobalFilter)}%`);
    }
  }

  return { conditions, params };
}
