/**
 * Query Builder Module
 *
 * Constructs safe SQL queries for read operations.
 */
import { escapeIdentifier } from './sql-utils';
import { TableQueryOptions, TableCountOptions } from './types';

/**
 * Build a SELECT query from options.
 */
export function buildSelectQuery(table: string, options: TableQueryOptions): { sql: string; params: any[] } {
  const {
    columns = ['*'],
    orderBy,
    orderDir = 'ASC',
    limit,
    offset,
    filters = [],
    globalFilter
  } = options;

  const escapedTable = escapeIdentifier(table);
  const escapedColumns = columns.map(col => {
    if (col === '*') return '*';
    if (col === 'rowid') return '"rowid" AS "rowid"';
    return escapeIdentifier(col);
  }).join(', ');

  let sql = `SELECT ${escapedColumns} FROM ${escapedTable}`;
  const whereClauses: string[] = [];
  const params: any[] = [];

  // Column filters
  for (const filter of filters) {
    if (filter.value) {
      whereClauses.push(`${escapeIdentifier(filter.column)} LIKE ?`);
      params.push(`%${filter.value}%`);
    }
  }

  // Global filter
  if (globalFilter) {
    const globalConditions = columns.map(col => `${escapeIdentifier(col)} LIKE ?`).join(' OR ');
    whereClauses.push(`(${globalConditions})`);
    // Add param for each column in the OR clause
    for (let i = 0; i < columns.length; i++) {
      params.push(`%${globalFilter}%`);
    }
  }

  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(' AND ')}`;
  }

  if (orderBy) {
    sql += ` ORDER BY ${escapeIdentifier(orderBy)} ${orderDir === 'DESC' ? 'DESC' : 'ASC'}`;
  }

  if (typeof limit === 'number') {
    sql += ` LIMIT ${limit}`;
  }

  if (typeof offset === 'number') {
    sql += ` OFFSET ${offset}`;
  }

  return { sql, params };
}

/**
 * Build a COUNT query from options.
 */
export function buildCountQuery(table: string, options: TableCountOptions): { sql: string; params: any[] } {
  const { columns = [], filters = [], globalFilter } = options;

  const escapedTable = escapeIdentifier(table);
  let sql = `SELECT COUNT(*) as count FROM ${escapedTable}`;
  const whereClauses: string[] = [];
  const params: any[] = [];

  // Column filters
  for (const filter of filters) {
    if (filter.value) {
      whereClauses.push(`${escapeIdentifier(filter.column)} LIKE ?`);
      params.push(`%${filter.value}%`);
    }
  }

  // Global filter
  if (globalFilter && columns.length > 0) {
    const globalConditions = columns.map(col => `${escapeIdentifier(col)} LIKE ?`).join(' OR ');
    whereClauses.push(`(${globalConditions})`);
    for (let i = 0; i < columns.length; i++) {
      params.push(`%${globalFilter}%`);
    }
  }

  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(' AND ')}`;
  }

  return { sql, params };
}
