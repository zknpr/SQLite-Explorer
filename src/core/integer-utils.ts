import type { CellValue, ExactIntegerTextMap } from './types';

/**
 * Keep the existing number-based grid contract while retaining exact SQLite
 * INTEGER text only where converting an int64 BigInt would lose precision.
 * The sparse string sidecar is safe across every webview/worker RPC boundary;
 * BigInt itself is deliberately kept out of general UI, edit, and export code.
 */
export function normalizeIntegerRowsForTransport(
  sourceRows: readonly (readonly unknown[])[]
): { rows: CellValue[][]; exactIntegerTexts?: ExactIntegerTextMap } {
  let exactIntegerTexts: ExactIntegerTextMap | undefined;
  const rows = sourceRows.map((sourceRow, rowIndex) => sourceRow.map((value, columnIndex) => {
    if (typeof value !== 'bigint') return value as CellValue;

    const numericValue = Number(value);
    if (!Number.isSafeInteger(numericValue)) {
      exactIntegerTexts ??= {};
      exactIntegerTexts[rowIndex] ??= {};
      exactIntegerTexts[rowIndex][columnIndex] = value.toString();
    }
    return numericValue;
  }));

  return exactIntegerTexts ? { rows, exactIntegerTexts } : { rows };
}
