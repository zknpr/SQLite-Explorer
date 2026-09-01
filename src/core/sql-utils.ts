/**
 * SQL Utility Functions
 *
 * Shared utilities for SQL string construction and escaping.
 */

import type { CellValue, RecordId } from './types';

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

/** Qualify a persistent object so a same-named TEMP object cannot intercept DDL/DML. */
export function escapeMainIdentifier(identifier: string): string {
  return `main.${escapeIdentifier(identifier)}`;
}

/**
 * Reject identifiers that cannot be represented safely, without imposing an
 * application-specific naming grammar on SQLite identifiers.
 */
export function assertUsableSqlIdentifier(
  identifier: unknown,
  label: string = 'Identifier'
): asserts identifier is string {
  if (typeof identifier !== 'string' || identifier.length === 0) {
    throw new Error(`${label} is required`);
  }
  if (identifier.includes('\0')) {
    throw new Error(`${label} cannot contain NUL characters`);
  }
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
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'string') {
    // Check for NUL characters which are unsafe in SQL scripts
    // If found, encode as hex blob and cast to TEXT
    if (value.includes('\0')) {
      const encoder = new TextEncoder();
      const bytes = encoder.encode(value);
      const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
      return `CAST(X'${hex}' AS TEXT)`;
    }
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
 * Prevents SQL wildcard injection where malicious input like '%' could
 * cause expensive full table scans.
 *
 * @param pattern - The string to escape.
 * @param escapeChar - The escape character to use (default: '\\').
 * @returns The escaped string.
 */
export function escapeLikePattern(pattern: string, escapeChar: string = '\\'): string {
  // Escape the escape character itself, then the wildcards % and _
  // We need to escape the escapeChar for use in regex
  const escapedEscapeChar = escapeChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`[${escapedEscapeChar}%_]`, 'g');
  return pattern.replace(regex, (match) => escapeChar + match);
}

/**
 * Validate that a row ID is a safe integer and convert it to a number.
 * Throws an error if the row ID is invalid.
 *
 * A SQLite rowid is always an integer. We deliberately reject inputs that
 * `Number()` would silently coerce into a plausible-but-wrong value:
 *   - non string/number/bigint types — Number(null)/Number(false)/Number([])
 *     are all 0, Number(true) is 1, Number([5]) is 5
 *   - blank/whitespace strings ('' / '   ' -> 0), which would target "row 0"
 *   - fractional ('123.45') and scientific-notation ('1e3') strings
 *   - NaN / Infinity, fractional numbers, and magnitudes beyond ±(2^53-1)
 *     that a JS number cannot represent without precision loss
 *
 * @param rowId - The row ID to validate
 * @returns The validated integer row ID
 */
const SQLITE_MIN_ROWID = -9223372036854775808n;
const SQLITE_MAX_ROWID = 9223372036854775807n;

export function validateRowId(rowId: RecordId | bigint): RecordId {
  // Only strings, numbers, and bigints are valid rowid inputs. RecordId is typed
  // string | number, but this runs against untyped runtime values (RPC payloads,
  // persisted history state), where null/boolean/array would otherwise sail
  // through Number() as 0/1/element. Capturing typeof in a local keeps TS from
  // narrowing rowId to `never` and flagging the (intentional) runtime guard.
  const inputType = typeof rowId;
  if (inputType !== 'string' && inputType !== 'number' && inputType !== 'bigint') {
    throw new Error(`Invalid rowid: ${rowId}`);
  }
  // For string inputs, require an integer form (optional sign + digits).
  // This rejects '', '   ', '123.45' and '1e3' up front — none are valid rowids,
  // even though Number() would happily turn them into 0 / 123.45 / 1000.
  if (typeof rowId === 'number') {
    if (!Number.isSafeInteger(rowId)) throw new Error(`Invalid rowid: ${rowId}`);
    return rowId;
  }

  const text = typeof rowId === 'string' ? rowId.trim() : rowId.toString();
  if (!/^[+-]?\d+$/.test(text)) {
    throw new Error(`Invalid rowid: ${rowId}`);
  }
  const exact = BigInt(text);
  if (exact < SQLITE_MIN_ROWID || exact > SQLITE_MAX_ROWID) {
    throw new Error(`Invalid rowid: ${rowId}`);
  }

  const num = Number(exact);
  // Preserve normal rowids as numbers for protocol compatibility. Decimal
  // strings outside the safe range stay strings so SQLite INTEGER affinity can
  // bind their full int64 identity without a lossy JavaScript conversion.
  return Number.isSafeInteger(num) ? num : exact.toString();
}

/**
 * Validate an array of row IDs, ensuring all are finite numbers.
 *
 * @param rowIds - The array of row IDs to validate
 * @returns An array of validated numeric row IDs
 */
export function validateRowIds(rowIds: RecordId[]): RecordId[] {
  return rowIds.map(validateRowId);
}
