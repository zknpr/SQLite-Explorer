/**
 * Types for batch-update-logic.js (DOM-free batch-update helpers).
 */

export interface BatchSelectedCell {
  rowId: string | number;
  rowIdx: number;
  colIdx: number;
  value: unknown;
}

export interface BatchColumnDef {
  name: string;
  type?: string;
  isPrimaryKey?: boolean;
  isRowidAlias?: boolean;
  notnull?: number;
}

/** Minimal shape of a batch-field <input> (real element or test stand-in). */
export interface BatchInputLike {
  value: string;
  dataset?: { isnull?: string; ispatch?: string; mode?: string };
}

export interface BatchColumnInfo {
  name: string;
  type?: string;
  notnull?: number;
  isPrimaryKey?: boolean;
  isRowidAlias?: boolean;
  values: Set<unknown>;
}

export interface PreparedBatchUpdate {
  rowId: string | number;
  column: string;
  value: unknown;
  originalValue: unknown;
  operation: 'set' | 'json_patch';
  rowIdx: number;
  colIdx: number;
}

export function groupSelectedCellsByColumn(
  selectedCells: BatchSelectedCell[],
  tableColumns: BatchColumnDef[]
): Map<number, BatchColumnInfo>;

export function summarizeColumnValue(values: Iterable<unknown>): string;

export function prepareBatchUpdates(
  selectedCells: BatchSelectedCell[],
  inputsByCol: Map<number, BatchInputLike>,
  tableColumns: BatchColumnDef[],
  usesDeclaredPrimaryKey?: boolean
): PreparedBatchUpdate[];
