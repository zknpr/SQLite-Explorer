/**
 * Query Builder Module
 *
 * Constructs safe SQL queries for read operations.
 */
import { escapeIdentifier, escapeLikePattern, escapeMainIdentifier } from './sql-utils';
import { getActiveFilterValue } from './filter-utils';
import {
  assembleKeysetSelect,
  buildRowIdLookupSelect,
  ROW_ID_LOOKUP_ROW,
  rowIdLookupApplies,
  type ResolvedKeysetPlan
} from './keyset-pagination';
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
  engine: EngineQueryOptions = {}
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
  const selectListSql = (qualifier: string) => selectList
    ? selectList(columns.map(col => qualifier + escapeIdentifier(col)))
    : columns.map(col => {
        if (col === '*') return `${qualifier}*`;
        if (col === 'rowid') return `${qualifier}"rowid" AS "rowid"`;
        return qualifier + escapeIdentifier(col);
      }).join(', ');
  const escapedColumns = selectListSql('');
  const rowIdLookupSelectListSql = engine.rowIdLookup ? selectListSql(`${ROW_ID_LOOKUP_ROW}.`) : undefined;

  let sql = `SELECT ${escapedColumns} FROM ${escapedTable}`;
  const whereClauses: string[] = [];
  const params: CellValue[] = [];

  const { conditions, params: filterParams } = buildFilterConditions(
    filters,
    globalFilter,
    globalFilterColumns,
    engine
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
      },
      rowIdLookupSelectListSql
    });
  }

  const whereSql = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : '';
  const orderedColumns = orderByColumns?.length
    ? orderByColumns
    : (orderBy ? [orderBy] : []);
  const direction = orderDir === 'DESC' ? 'DESC' : 'ASC';
  const orderSql = orderedColumns.length > 0
    ? ` ORDER BY ${orderedColumns.map(column => `${escapeIdentifier(column)} ${direction}`).join(', ')}`
    : '';
  let pageSql = '';
  if (limit !== undefined) {
    pageSql += ` LIMIT ${normalizeTablePageLimit(limit)}`;
  }
  if (offset !== undefined) {
    pageSql += ` OFFSET ${normalizeTablePageOffset(offset)}`;
  }

  if (rowIdLookupSelectListSql !== undefined && limit !== undefined && rowIdLookupApplies(orderedColumns)) {
    return {
      sql: buildRowIdLookupSelect({
        selectListSql: rowIdLookupSelectListSql,
        escapedTable,
        whereSql,
        keyColumns: orderedColumns,
        innerDirection: direction,
        outerDirection: direction,
        pageSql
      }),
      params
    };
  }
  return { sql: sql + whereSql + orderSql + pageSql, params };
}

/**
 * Build a COUNT query from options.
 */
export function buildCountQuery(
  table: string,
  options: TableCountOptions,
  engine: EngineQueryOptions = {}
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
    engine
  );
  whereClauses.push(...conditions);
  params.push(...filterParams);

  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(' AND ')}`;
  }

  return { sql, params };
}

/** What the engine knows about the connection and table, which page options cannot say. */
export interface EngineQueryOptions {
  /** The runtime's sqlite_explorer_like_any is registered, on a UTF-8 database (query-plan.c). */
  likeAny?: boolean;
  /**
   * The table is an authority-confirmed ordinary rowid table, so a sorted page
   * can take buildRowIdLookupSelect (keyset-pagination.ts). Without an index
   * on the sort, SQLite otherwise builds a sorter record of every column for
   * every row.
   */
  rowIdLookup?: boolean;
}

/** Values per sqlite_explorer_like_any call, as for the cell pack. */
const LIKE_ANY_CHUNK = 100;

/**
 * Helper to build WHERE conditions for column filters and global search.
 * The web demo's worker builds its pages and counts with it too.
 */
export function buildFilterConditions(
  filters: { column: string; value: string }[] = [],
  globalFilter: string | undefined,
  searchColumns: string[],
  engine: EngineQueryOptions = {}
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
    if (engine.likeAny) {
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
