import type { CellValue, ExactIntegerTextMap } from './types';

const NUMERIC_SOURCE_ALIAS = '__sqlite_explorer_numeric_source';
const NUMERIC_VALUE_PREFIX = '__sqlite_explorer_numeric_value_';
const NUMERIC_TEXT_PREFIX = '__sqlite_explorer_numeric_text_';

function quoteInternalIdentifier(identifier: string): string {
  return `"${identifier}"`;
}

/**
 * Project each result value beside sparse SQLite-generated text for the one
 * numeric shape JavaScript cannot identify after transport: an integral REAL.
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
  const quotedSource = quoteInternalIdentifier(NUMERIC_SOURCE_ALIAS);
  const quotedValues = valueColumns.map(quoteInternalIdentifier);
  const exactTextExpressions = quotedValues.map((valueColumn, index) => (
    `CASE WHEN typeof(${valueColumn}) = 'real' ` +
    `AND ${valueColumn} = CAST(${valueColumn} AS INTEGER) ` +
    `THEN CAST(${valueColumn} AS TEXT) END AS ${quoteInternalIdentifier(textColumns[index])}`
  ));

  return {
    // MATERIALIZED is an integrity barrier, not a performance hint here. If
    // SQLite flattens this CTE, each typeof/comparison/cast reference may
    // reevaluate a nondeterministic source expression and describe a value
    // different from the one returned in the same transport row.
    sql:
      `WITH ${quotedSource} (${quotedValues.join(', ')}) AS MATERIALIZED (\n${sourceSql}\n)\n` +
      `SELECT ${[...quotedValues, ...exactTextExpressions].join(', ')} FROM ${quotedSource}`,
    transportColumns: [...valueColumns, ...textColumns]
  };
}

/**
 * Keep the existing number-based grid contract while retaining exact SQLite
 * numeric text where transport would otherwise lose meaning: unsafe int64
 * BigInts and integral REALs whose Number value is indistinguishable from an
 * INTEGER. The protocol field retains its legacy exactIntegerTexts name, but
 * the sparse string sidecar now covers both cases and remains JSON/RPC-safe.
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
        setExactText(rowIndex, columnIndex, exactText);
      }
    }
  }

  const rows = sourceRows.map((sourceRow, rowIndex) => {
    const logicalColumnCount = valueColumnCount ?? sourceRow.length;
    if (valueColumnCount !== undefined && sourceRow.length < valueColumnCount * 2) {
      throw new Error(
        `Exact numeric text row ${rowIndex} has ${sourceRow.length} values; ` +
        `expected at least ${valueColumnCount * 2}`
      );
    }

    return sourceRow.slice(0, logicalColumnCount).map((value, columnIndex) => {
      if (valueColumnCount !== undefined) {
        const exactRealText = sourceRow[valueColumnCount + columnIndex];
        if (exactRealText !== null && exactRealText !== undefined) {
          if (typeof exactRealText !== 'string') {
            throw new Error(
              `Exact numeric text at row ${rowIndex}, column ${columnIndex} is not text`
            );
          }
          setExactText(rowIndex, columnIndex, exactRealText);
        }
      }

      if (typeof value !== 'bigint') return value as CellValue;

      const numericValue = Number(value);
      if (!Number.isSafeInteger(numericValue)) {
        setExactText(rowIndex, columnIndex, value.toString());
      }
      return numericValue;
    });
  });

  return exactIntegerTexts ? { rows, exactIntegerTexts } : { rows };
}
