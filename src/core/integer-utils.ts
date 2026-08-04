import type { CellValue, ExactIntegerTextMap } from './types';
import { escapeIdentifier } from './sql-utils';

const NUMERIC_SOURCE_ALIAS = '__sqlite_explorer_numeric_source';
const NUMERIC_VALUE_PREFIX = '__sqlite_explorer_numeric_value_';
const NUMERIC_TEXT_PREFIX = '__sqlite_explorer_numeric_text_';
const ROWID_COMPANION_ID = '__sqlite_explorer_numeric_rowid';
const ROWID_COMPANION_TEXT_PREFIX = '__sqlite_explorer_numeric_rowid_text_';
// Bundled SQLite engines use the default SQLITE_MAX_COLUMN value. Keep this
// structural limit explicit so generated metadata can never make an otherwise
// valid wide query fail with "too many columns in result set".
const SQLITE_MAX_RESULT_COLUMNS = 2000;
const ROWID_COMPANION_COLUMNS_PER_QUERY = 999;
const SQLITE_MAX_VARIABLE_NUMBER = 32766;

/** Authoritative main-schema capability check required before companion reads. */
export const ROWID_TABLE_AUTHORITY_SQL =
  `SELECT 1 FROM pragma_table_list ` +
  `WHERE "schema" = 'main' AND "name" = ? AND (` +
  `("type" = 'table' AND "wr" = 0) OR "type" IN ('virtual', 'shadow')) LIMIT 1`;

export interface ExactNumericTextQuery {
  sql: string;
  transportColumns: string[];
  /** Present only when a second, SQLite-text companion exists per value. */
  valueColumnCount?: number;
}

export interface RowIdExactRealTextQuery {
  sql: string;
  params: CellValue[];
  transportColumns: string[];
  /** Positions in the original values row corresponding to the text columns. */
  columnIndices: number[];
}

export interface RowIdExactRealTextResult {
  query: RowIdExactRealTextQuery;
  rows: readonly (readonly unknown[])[];
}

/** True when a fetched SQLite int64 cannot be represented by a JS number. */
export function hasUnsafeBigIntAtColumn(
  rows: readonly (readonly unknown[])[],
  columnIndex: number
): boolean {
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  const minSafe = BigInt(Number.MIN_SAFE_INTEGER);
  return rows.some(row => {
    const value = row[columnIndex];
    return typeof value === 'bigint' && (value > maxSafe || value < minSafe);
  });
}

/**
 * Project each result value beside SQLite-generated text for every REAL.
 * normalizeIntegerRowsForTransport keeps the sidecar sparse by retaining only
 * representations that differ from the JavaScript value crossing the RPC.
 * Explicit CTE column aliases preserve duplicate result names and keep the
 * metadata positionally tied to the exact row/value it describes.
 */
export function buildExactNumericTextQuery(
  sourceSql: string,
  columnCount: number
): ExactNumericTextQuery {
  if (!Number.isInteger(columnCount) || columnCount < 1) {
    throw new Error(`Exact numeric text projection requires a positive column count, got ${columnCount}`);
  }

  const valueColumns = Array.from(
    { length: columnCount },
    (_, index) => `${NUMERIC_VALUE_PREFIX}${index}`
  );
  const textColumns = Array.from(
    { length: columnCount },
    (_, index) => `${NUMERIC_TEXT_PREFIX}${index}`
  );
  const quotedSource = escapeIdentifier(NUMERIC_SOURCE_ALIAS);
  const quotedValues = valueColumns.map(escapeIdentifier);
  const includeRealTextSidecar = columnCount * 2 <= SQLITE_MAX_RESULT_COLUMNS;
  const exactTextExpressions = quotedValues.map((valueColumn, index) => (
    `CASE WHEN typeof(${valueColumn}) = 'real' ` +
    `THEN CAST(${valueColumn} AS TEXT) END AS ${escapeIdentifier(textColumns[index])}`
  ));

  const projectedColumns = includeRealTextSidecar
    ? [...quotedValues, ...exactTextExpressions]
    : quotedValues;
  const transportColumns = includeRealTextSidecar
    ? [...valueColumns, ...textColumns]
    : valueColumns;

  const result: ExactNumericTextQuery = {
    // OFFSET is a documented query-flattening barrier across older CTE-capable
    // SQLite 3.x releases. The resulting coroutine evaluates each source row
    // once before typeof/comparison/cast reference it in the outer query.
    sql:
      `WITH ${quotedSource} (${quotedValues.join(', ')}) AS (\n` +
      `SELECT * FROM (\n${sourceSql}\n) LIMIT -1 OFFSET 0\n)\n` +
      `SELECT ${projectedColumns.join(', ')} FROM ${quotedSource}`,
    transportColumns
  };
  if (includeRealTextSidecar) result.valueColumnCount = columnCount;
  // Unsafe INTEGERs still cross through value columns as BigInt and are
  // normalized exactly. Ultra-wide arbitrary results omit only divergent REAL
  // text because evaluating a volatile source twice would be incorrect;
  // rowid-keyed table callers restore it with bounded companion reads below.
  return result;
}

/**
 * Build exact-REAL companion reads for an already-fetched rowid-keyed page.
 * Each query stays below both SQLite's 2,000-column result limit and the
 * bundled engines' 32,766-variable limit. This is safe to do after the main
 * query because table rowids identify the exact page rows and database
 * operations on a connection are serialized; arbitrary view/preview sources
 * deliberately retain the values-only degradation rather than being evaluated
 * twice.
 *
 * The leading-column check below is only a cheap structural precondition.
 * Callers must first prove ROWID_TABLE_AUTHORITY_SQL returned a row for the
 * target; a view or WITHOUT ROWID table can legally expose a column named
 * rowid without providing stable hidden-rowid identity.
 */
export function buildRowIdExactRealTextQueries(
  table: string,
  columns: readonly string[],
  rowIds: readonly (CellValue | bigint)[]
): RowIdExactRealTextQuery[] {
  if (columns.length < 2 || columns[0].toLowerCase() !== 'rowid' || rowIds.length === 0) {
    return [];
  }

  const dataColumns = columns.slice(1);
  const queries: RowIdExactRealTextQuery[] = [];
  for (
    let columnOffset = 0;
    columnOffset < dataColumns.length;
    columnOffset += ROWID_COMPANION_COLUMNS_PER_QUERY
  ) {
    const columnChunk = dataColumns.slice(
      columnOffset,
      columnOffset + ROWID_COMPANION_COLUMNS_PER_QUERY
    );
    const columnIndices = columnChunk.map((_, index) => columnOffset + index + 1);
    const textColumns = columnIndices.map(
      columnIndex => `${ROWID_COMPANION_TEXT_PREFIX}${columnIndex}`
    );
    const textExpressions = columnChunk.map((column, index) => {
      const quotedColumn = escapeIdentifier(column);
      return (
        `CASE WHEN typeof(${quotedColumn}) = 'real' ` +
        `THEN CAST(${quotedColumn} AS TEXT) END AS ${escapeIdentifier(textColumns[index])}`
      );
    });

    for (
      let rowOffset = 0;
      rowOffset < rowIds.length;
      rowOffset += SQLITE_MAX_VARIABLE_NUMBER
    ) {
      const rowIdChunk = rowIds.slice(rowOffset, rowOffset + SQLITE_MAX_VARIABLE_NUMBER);
      const params = rowIdChunk.map(rowId => (
        typeof rowId === 'bigint' ? rowId.toString() : rowId
      ));
      queries.push({
        sql:
          `SELECT rowid AS ${escapeIdentifier(ROWID_COMPANION_ID)}, ` +
          `${textExpressions.join(', ')} FROM ${escapeIdentifier(table)} ` +
          `WHERE rowid IN (${rowIdChunk.map(() => '?').join(', ')})`,
        params,
        transportColumns: [ROWID_COMPANION_ID, ...textColumns],
        columnIndices
      });
    }
  }
  return queries;
}

/** Merge positionally named companion rows into the sparse exact-text map. */
export function collectRowIdExactRealTexts(
  sourceRows: readonly (readonly unknown[])[],
  companionResults: readonly RowIdExactRealTextResult[]
): ExactIntegerTextMap | undefined {
  // No companion query means the caller deliberately selected values-only
  // degradation (for example, a wide view or WITHOUT ROWID table). Do not
  // interpret that source's first projected value as a rowid in this case.
  if (companionResults.length === 0) return undefined;

  const sourceRowById = new Map<string, number>();
  sourceRows.forEach((row, rowIndex) => {
    const rowId = row[0];
    if (!['bigint', 'number', 'string'].includes(typeof rowId)) {
      throw new Error(`Invalid rowid identity at source row ${rowIndex}`);
    }
    sourceRowById.set(String(rowId), rowIndex);
  });

  let exactTexts: ExactIntegerTextMap | undefined;
  for (const { query, rows } of companionResults) {
    for (const companionRow of rows) {
      if (companionRow.length < query.columnIndices.length + 1) {
        throw new Error('Rowid exact REAL companion result is missing columns');
      }
      const rowIndex = sourceRowById.get(String(companionRow[0]));
      if (rowIndex === undefined) {
        throw new Error(`Rowid exact REAL companion returned an unexpected row: ${String(companionRow[0])}`);
      }
      query.columnIndices.forEach((columnIndex, companionIndex) => {
        const exactText = companionRow[companionIndex + 1];
        if (exactText === null || exactText === undefined) return;
        if (typeof exactText !== 'string') {
          throw new Error(
            `Rowid exact REAL text at row ${rowIndex}, column ${columnIndex} is not text`
          );
        }
        const value = sourceRows[rowIndex]?.[columnIndex];
        if (value === undefined) {
          throw new Error(
            `Rowid exact REAL text is outside row ${rowIndex}, column ${columnIndex}`
          );
        }
        if (exactText !== String(value)) {
          exactTexts ??= {};
          exactTexts[rowIndex] ??= {};
          exactTexts[rowIndex][columnIndex] = exactText;
        }
      });
    }
  }
  return exactTexts;
}

/**
 * Keep the existing number-based grid contract while retaining exact SQLite
 * numeric text where transport would otherwise lose meaning: unsafe int64
 * BigInts and REALs whose SQLite text differs from JavaScript's String(value).
 * The protocol field retains its legacy exactIntegerTexts name, but the sparse
 * string sidecar now covers both cases and remains JSON/RPC-safe.
 */
export function normalizeIntegerRowsForTransport(
  sourceRows: readonly (readonly unknown[])[],
  valueColumnCount?: number,
  transportedExactTexts?: ExactIntegerTextMap,
  exactIntegerIdentityColumn?: number
): { rows: CellValue[][]; exactIntegerTexts?: ExactIntegerTextMap } {
  let exactIntegerTexts: ExactIntegerTextMap | undefined;
  const setExactText = (rowIndex: number, columnIndex: number, text: string) => {
    exactIntegerTexts ??= {};
    exactIntegerTexts[rowIndex] ??= {};
    exactIntegerTexts[rowIndex][columnIndex] = text;
  };

  const rows = sourceRows.map((sourceRow, rowIndex) => {
    const logicalColumnCount = valueColumnCount ?? sourceRow.length;
    if (valueColumnCount !== undefined && sourceRow.length < valueColumnCount * 2) {
      throw new Error(
        `Exact numeric text row ${rowIndex} has ${sourceRow.length} values; ` +
        `expected at least ${valueColumnCount * 2}`
      );
    }

    return sourceRow.slice(0, logicalColumnCount).map((value, columnIndex) => {
      let normalizedValue = value as CellValue | bigint;
      if (typeof value === 'bigint') {
        const numericValue = Number(value);
        if (!Number.isSafeInteger(numericValue)) {
          const exactText = value.toString();
          if (columnIndex === exactIntegerIdentityColumn) {
            // RecordId already accepts strings. Keeping an unsafe rowid exact in
            // the value slot makes every downstream selection/mutation/history
            // path use the same lossless identity without a parallel lookup.
            normalizedValue = exactText;
          } else {
            setExactText(rowIndex, columnIndex, exactText);
            normalizedValue = numericValue;
          }
        } else {
          normalizedValue = numericValue;
        }
      }

      if (valueColumnCount !== undefined) {
        const exactRealText = sourceRow[valueColumnCount + columnIndex];
        if (exactRealText !== null && exactRealText !== undefined) {
          if (typeof exactRealText !== 'string') {
            throw new Error(
              `Exact numeric text at row ${rowIndex}, column ${columnIndex} is not text`
            );
          }
          if (exactRealText !== String(normalizedValue)) {
            setExactText(rowIndex, columnIndex, exactRealText);
          }
        }
      }
      return normalizedValue as CellValue;
    });
  });

  if (transportedExactTexts) {
    for (const [rowIndexText, exactRow] of Object.entries(transportedExactTexts)) {
      const rowIndex = Number(rowIndexText);
      if (
        !Number.isInteger(rowIndex) ||
        rowIndex < 0 ||
        exactRow === null ||
        typeof exactRow !== 'object'
      ) {
        throw new Error(`Invalid exact numeric text row index: ${rowIndexText}`);
      }
      for (const [columnIndexText, exactText] of Object.entries(exactRow)) {
        const columnIndex = Number(columnIndexText);
        if (!Number.isInteger(columnIndex) || columnIndex < 0 || typeof exactText !== 'string') {
          throw new Error(
            `Invalid exact numeric text entry at row ${rowIndexText}, column ${columnIndexText}`
          );
        }
        const value = rows[rowIndex]?.[columnIndex];
        if (value === undefined) {
          throw new Error(
            `Exact numeric text entry is outside row ${rowIndexText}, column ${columnIndexText}`
          );
        }
        if (exactText !== String(value)) {
          setExactText(rowIndex, columnIndex, exactText);
        }
      }
    }
  }

  return exactIntegerTexts ? { rows, exactIntegerTexts } : { rows };
}
