/**
 * SQL Utility Functions
 *
 * Shared utilities for SQL string construction and escaping.
 */

import type { CellValue } from './types';

/**
 * Escape a SQL identifier (table name, column name) for safe use in queries.
 * SQL identifiers are wrapped in double quotes, and any internal double quotes
 * are escaped by doubling them (SQL standard).
 *
 * SECURITY: This prevents SQL injection via malicious table/column names.
 * Example: A table named `foo"--DROP TABLE bar` becomes `"foo""--DROP TABLE bar"`
 *
 * @param identifier - The table or column name to escape
 * @returns Safely escaped identifier wrapped in double quotes
 */
export function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Convert a CellValue to SQL literal representation.
 * Handles NULL, numbers, strings, and binary data.
 */
export function cellValueToSql(value: CellValue | undefined): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    // Escape single quotes by doubling them (SQL standard)
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (value instanceof Uint8Array) {
    // Convert binary to hex blob literal
    const hex = Array.from(value).map(b => b.toString(16).padStart(2, '0')).join('');
    return `X'${hex}'`;
  }
  // Fallback for any other type
  return `'${String(value).replace(/'/g, "''")}'`;
}
