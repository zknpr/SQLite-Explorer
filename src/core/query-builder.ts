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
  keysetPlan?: ResolvedKeysetPlan,
  /**
   * Replaces the select list with expressions over the requested columns,
   * one per column in order. WHERE, ORDER BY and LIMIT are unchanged, so a
   * row-packed grid page reads the base table with no co-routine. A reversed
   * keyset page re-sorts its inner SELECT by name and cannot take one.
   */
  selectList?: (columnExpressions: string[]) => string,
  functions: QueryRuntimeFunctions = {}
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
  if (selectList && (columns.includes('*')
    || keysetPlan?.mode === 'before' || keysetPlan?.mode === 'last')) {
    throw new Error('A replaced select list needs named columns and a forward page');
  }
  const escapedColumns = selectList
    ? selectList(columns.map(escapeIdentifier))
    : columns.map(col => {
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
    globalFilterColumns,
    functions
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
export function buildCountQuery(
  table: string,
  options: TableCountOptions,
  functions: QueryRuntimeFunctions = {}
): { sql: string; params: CellValue[] } {
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
    globalFilterColumns,
    functions
  );
  whereClauses.push(...conditions);
  params.push(...filterParams);

  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(' AND ')}`;
  }

  return { sql, params };
}

/** Runtime functions the engine's connection has registered (src/runtime/query-plan.c). */
export interface QueryRuntimeFunctions {
  /** sqlite_explorer_like_any, on a UTF-8 database. */
  likeAny?: boolean;
}

/** Values per sqlite_explorer_like_any call, as for the cell pack. */
const LIKE_ANY_CHUNK = 100;

/**
 * Helper to build WHERE conditions for column filters and global search.
 */
function buildFilterConditions(
  filters: { column: string; value: string }[] = [],
  globalFilter: string | undefined,
  searchColumns: string[],
  functions: QueryRuntimeFunctions = {}
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
    const pattern = `%${escapeLikePattern(activeGlobalFilter)}%`;
    const likeChain = (columns: string[]) => {
      for (let i = 0; i < columns.length; i++) params.push(pattern);
      return `(${columns.map(col => `${escapeIdentifier(col)} LIKE ? ESCAPE '\\'`).join(' OR ')})`;
    };
    if (functions.likeAny) {
      // One call per row and chunk instead of one LIKE per column. The LIKE
      // chain decides only rows the function leaves NULL, and the constant
      // test keeps PRAGMA case_sensitive_like on SQLite's own LIKE.
      const chunks: string[] = [];
      for (let start = 0; start < searchColumns.length; start += LIKE_ANY_CHUNK) {
        const columns = searchColumns.slice(start, start + LIKE_ANY_CHUNK);
        params.push(activeGlobalFilter);
        const call = `sqlite_explorer_like_any(?, ${columns.map(escapeIdentifier).join(', ')})`;
        chunks.push(`COALESCE(CASE WHEN 'a' LIKE 'A' THEN ${call} END, ${likeChain(columns)})`);
      }
      conditions.push(`(${chunks.join(' OR ')})`);
    } else {
      conditions.push(likeChain(searchColumns));
    }
  }

  return { conditions, params };
}
