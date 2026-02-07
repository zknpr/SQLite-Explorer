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
 * Validate a SQL type definition to ensure it is safe.
 * Allows standard SQLite types and common variants.
 *
 * @param type - The type string to validate (e.g. "INTEGER", "VARCHAR(255)")
 * @throws Error if the type is potentially unsafe
 */
export function validateSqlType(type: string): void {
  if (!type || typeof type !== 'string') {
    throw new Error('Invalid SQL type: Type must be a non-empty string');
  }

  // Check for dangerous characters that could be used for injection
  // Disallow: quotes, semicolons, dashes (comments), slashes, asterisks
  if (/['";\-\/\*]/.test(type)) {
     throw new Error(`Invalid SQL type: "${type}" contains potentially unsafe characters`);
  }

  // Strict validation pattern
  // Matches:
  // 1. Start with alphanumeric words/spaces (e.g. "INTEGER", "UNSIGNED INT")
  // 2. Optional: Parentheses with numbers/commas (e.g. "(255)", "(10, 2)")
  // 3. Optional: Trailing alphanumeric words/spaces (e.g. "UNSIGNED")
  const validPattern = /^[a-zA-Z0-9_\s]+(?:\([0-9\s,]+\)[a-zA-Z0-9_\s]*)?$/;

  if (!validPattern.test(type.trim())) {
     throw new Error(`Invalid SQL type: "${type}" does not match allowed format`);
  }
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

/**
 * Escapes characters that have special meaning in SQL LIKE clauses.
 *
 * @param pattern - The string to escape.
 * @param escapeChar - The escape character to use (default: '\').
 * @returns The escaped string.
 */
export function escapeLikePattern(pattern: string, escapeChar: string = '\\'): string {
  // Escape the escape character itself, then the wildcards % and _
  // We need to escape the escapeChar for use in regex
  const escapedEscapeChar = escapeChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`[${escapedEscapeChar}%_]`, 'g');
  return pattern.replace(regex, (match) => escapeChar + match);
}
