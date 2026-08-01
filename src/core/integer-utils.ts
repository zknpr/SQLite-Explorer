import type { CellValue, ExactIntegerTextMap } from './types';
import { escapeIdentifier } from './sql-utils';

const NUMERIC_SOURCE_ALIAS = '__sqlite_explorer_numeric_source';
const NUMERIC_VALUE_PREFIX = '__sqlite_explorer_numeric_value_';
const NUMERIC_TEXT_PREFIX = '__sqlite_explorer_numeric_text_';

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
): { sql: string; transportColumns: string[] } {
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
  const exactTextExpressions = quotedValues.map((valueColumn, index) => (
    `CASE WHEN typeof(${valueColumn}) = 'real' ` +
    `THEN CAST(${valueColumn} AS TEXT) END AS ${escapeIdentifier(textColumns[index])}`
  ));

  return {
    // OFFSET is a documented query-flattening barrier across older CTE-capable
    // SQLite 3.x releases. The resulting coroutine evaluates each source row
    // once before typeof/comparison/cast reference it in the outer query.
    sql:
      `WITH ${quotedSource} (${quotedValues.join(', ')}) AS (\n` +
      `SELECT * FROM (\n${sourceSql}\n) LIMIT -1 OFFSET 0\n)\n` +
      `SELECT ${[...quotedValues, ...exactTextExpressions].join(', ')} FROM ${quotedSource}`,
    transportColumns: [...valueColumns, ...textColumns]
  };
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
  transportedExactTexts?: ExactIntegerTextMap
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
          setExactText(rowIndex, columnIndex, value.toString());
        }
        normalizedValue = numericValue;
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
      if (!Number.isInteger(rowIndex) || rowIndex < 0 || typeof exactRow !== 'object') {
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
