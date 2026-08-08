import type { CellValue, LabeledModification, RecordId } from './types';
import {
  decodePrimaryKeyRecordId,
  isPrimaryKeyRecordId
} from './row-identity';
import { validateRowId } from './sql-utils';

type UnknownRecord = Record<string, unknown>;

function invalid(reason: string): never {
  throw new Error(`Invalid document modification: ${reason}`);
}

function asRecord(value: unknown, field: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${field} must be an object`);
  }
  return value as UnknownRecord;
}

function hasOwn(record: UnknownRecord, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function assertString(value: unknown, field: string, allowEmpty = false): asserts value is string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    invalid(`${field} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
  }
}

function assertOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'string') {
    invalid(`${field} must be a string when present`);
  }
}

function assertStringArray(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    invalid(`${field} must be an array of strings`);
  }
}

function assertCellValue(value: unknown, field: string): asserts value is CellValue {
  if (
    value !== null
    && typeof value !== 'string'
    && typeof value !== 'bigint'
    && !(typeof value === 'number' && Number.isFinite(value))
    && !(value instanceof Uint8Array)
  ) {
    invalid(`${field} is not a SQLite cell value`);
  }
}

function assertRecordId(value: unknown, field: string): asserts value is RecordId {
  try {
    if (isPrimaryKeyRecordId(value)) {
      decodePrimaryKeyRecordId(value);
    } else {
      validateRowId(value as RecordId);
    }
  } catch {
    invalid(`${field} is not a valid row identity`);
  }
}

function assertRowData(value: unknown, field: string): void {
  const row = asRecord(value, field);
  for (const [column, cell] of Object.entries(row)) {
    assertString(column, `${field} column`);
    assertCellValue(cell, `${field}.${column}`);
  }
}

function assertCellUpdate(edit: UnknownRecord): void {
  if (edit.operation !== undefined && edit.operation !== 'set' && edit.operation !== 'json_patch') {
    invalid('cell_update.operation must be set or json_patch');
  }
  if (edit.undoPolicy !== undefined && edit.undoPolicy !== 'barrier') {
    invalid('cell_update.undoPolicy must be barrier when present');
  }

  if (edit.affectedCells !== undefined) {
    if (!Array.isArray(edit.affectedCells) || edit.affectedCells.length === 0) {
      invalid('cell_update.affectedCells must be a non-empty array');
    }
    for (const [index, rawCell] of edit.affectedCells.entries()) {
      const cell = asRecord(rawCell, `cell_update.affectedCells[${index}]`);
      assertRecordId(cell.rowId, `cell_update.affectedCells[${index}].rowId`);
      if (cell.newRowId !== undefined) {
        assertRecordId(cell.newRowId, `cell_update.affectedCells[${index}].newRowId`);
      }
      assertString(cell.columnName, `cell_update.affectedCells[${index}].columnName`);
      if (!hasOwn(cell, 'priorValue') || !hasOwn(cell, 'newValue')) {
        invalid(`cell_update.affectedCells[${index}] must include priorValue and newValue`);
      }
      assertCellValue(cell.priorValue, `cell_update.affectedCells[${index}].priorValue`);
      assertCellValue(cell.newValue, `cell_update.affectedCells[${index}].newValue`);
      if (cell.operation !== undefined && cell.operation !== 'set' && cell.operation !== 'json_patch') {
        invalid(`cell_update.affectedCells[${index}].operation must be set or json_patch`);
      }
    }
    return;
  }

  assertRecordId(edit.targetRowId, 'cell_update.targetRowId');
  if (edit.newTargetRowId !== undefined) {
    assertRecordId(edit.newTargetRowId, 'cell_update.newTargetRowId');
  }
  assertString(edit.targetColumn, 'cell_update.targetColumn');
  if (!hasOwn(edit, 'newValue')) {
    invalid('cell_update.newValue is required');
  }
  assertCellValue(edit.newValue, 'cell_update.newValue');
  if (edit.undoPolicy !== 'barrier') {
    if (!hasOwn(edit, 'priorValue')) {
      invalid('cell_update.priorValue is required');
    }
    assertCellValue(edit.priorValue, 'cell_update.priorValue');
  }
}

function assertColumnDefinition(value: unknown, field: string): void {
  const column = asRecord(value, field);
  assertString(column.name, `${field}.name`);
  assertString(column.type, `${field}.type`, true);
  if (typeof column.primaryKey !== 'boolean' || typeof column.notNull !== 'boolean') {
    invalid(`${field}.primaryKey and ${field}.notNull must be booleans`);
  }
  assertOptionalString(column.defaultValue, `${field}.defaultValue`);
}

function assertTableDefinition(value: unknown, field: string): void {
  const definition = asRecord(value, field);
  if (!Array.isArray(definition.columns) || definition.columns.length === 0) {
    invalid(`${field}.columns must be a non-empty array`);
  }
  definition.columns.forEach((column, index) => {
    assertColumnDefinition(column, `${field}.columns[${index}]`);
  });
}

function assertViewDefinition(value: unknown, field: string, targetTable: string): void {
  const definition = asRecord(value, field);
  assertString(definition.identifier, `${field}.identifier`);
  if (definition.identifier !== targetTable) {
    invalid(`${field}.identifier must match targetTable`);
  }
  assertString(definition.sql, `${field}.sql`);
  assertString(definition.selectSql, `${field}.selectSql`);
  assertOptionalString(definition.columnListSql, `${field}.columnListSql`);
  if (definition.columns !== undefined) {
    assertStringArray(definition.columns, `${field}.columns`);
  }
  if (definition.ambiguousTemporaryTriggerNames !== undefined) {
    assertStringArray(
      definition.ambiguousTemporaryTriggerNames,
      `${field}.ambiguousTemporaryTriggerNames`
    );
  }
  if (!Array.isArray(definition.triggers)) {
    invalid(`${field}.triggers must be an array`);
  }
  for (const [index, rawTrigger] of definition.triggers.entries()) {
    const trigger = asRecord(rawTrigger, `${field}.triggers[${index}]`);
    assertString(trigger.identifier, `${field}.triggers[${index}].identifier`);
    assertString(trigger.sql, `${field}.triggers[${index}].sql`);
    if (trigger.temporary !== undefined && typeof trigger.temporary !== 'boolean') {
      invalid(`${field}.triggers[${index}].temporary must be a boolean when present`);
    }
  }
}

/** Validate the untyped webview boundary before an entry reaches undo history. */
export function assertDocumentModification(value: unknown): asserts value is LabeledModification {
  const edit = asRecord(value, 'entry');
  assertString(edit.label, 'label');
  assertString(edit.description, 'description');
  assertString(edit.targetTable, 'targetTable');
  const targetTable = edit.targetTable;

  switch (edit.modificationType) {
    case 'cell_update':
      assertCellUpdate(edit);
      return;

    case 'row_insert':
      assertRecordId(edit.targetRowId, 'row_insert.targetRowId');
      assertRowData(edit.rowData, 'row_insert.rowData');
      return;

    case 'row_delete':
      if (!Array.isArray(edit.affectedRowIds) || edit.affectedRowIds.length === 0) {
        invalid('row_delete.affectedRowIds must be a non-empty array');
      }
      edit.affectedRowIds.forEach((rowId, index) => {
        assertRecordId(rowId, `row_delete.affectedRowIds[${index}]`);
      });
      if (!Array.isArray(edit.deletedRows) || edit.deletedRows.length === 0) {
        invalid('row_delete.deletedRows must be a non-empty array');
      }
      for (const [index, rawDeletedRow] of edit.deletedRows.entries()) {
        const deletedRow = asRecord(rawDeletedRow, `row_delete.deletedRows[${index}]`);
        assertRecordId(deletedRow.rowId, `row_delete.deletedRows[${index}].rowId`);
        assertRowData(deletedRow.row, `row_delete.deletedRows[${index}].row`);
      }
      return;

    case 'column_add': {
      assertString(edit.targetColumn, 'column_add.targetColumn');
      const definition = asRecord(edit.columnDef, 'column_add.columnDef');
      assertString(definition.type, 'column_add.columnDef.type', true);
      assertOptionalString(definition.defaultValue, 'column_add.columnDef.defaultValue');
      return;
    }

    case 'column_drop':
      if (!Array.isArray(edit.deletedColumns) || edit.deletedColumns.length === 0) {
        invalid('column_drop.deletedColumns must be a non-empty array');
      }
      for (const [index, rawColumn] of edit.deletedColumns.entries()) {
        const column = asRecord(rawColumn, `column_drop.deletedColumns[${index}]`);
        assertString(column.name, `column_drop.deletedColumns[${index}].name`);
        assertString(column.type, `column_drop.deletedColumns[${index}].type`, true);
        if (!Array.isArray(column.data)) {
          invalid(`column_drop.deletedColumns[${index}].data must be an array`);
        }
        for (const [dataIndex, rawCell] of column.data.entries()) {
          const cell = asRecord(
            rawCell,
            `column_drop.deletedColumns[${index}].data[${dataIndex}]`
          );
          assertRecordId(
            cell.rowId,
            `column_drop.deletedColumns[${index}].data[${dataIndex}].rowId`
          );
          assertCellValue(
            cell.value,
            `column_drop.deletedColumns[${index}].data[${dataIndex}].value`
          );
        }
      }
      if (edit.droppedIndexes !== undefined) {
        assertStringArray(edit.droppedIndexes, 'column_drop.droppedIndexes');
      }
      return;

    case 'table_create':
      assertTableDefinition(edit.tableDef, 'table_create.tableDef');
      return;

    case 'view_create':
      assertViewDefinition(edit.viewDefAfter, 'view_create.viewDefAfter', targetTable);
      return;

    case 'view_edit':
      assertViewDefinition(edit.viewDefBefore, 'view_edit.viewDefBefore', targetTable);
      assertViewDefinition(edit.viewDefAfter, 'view_edit.viewDefAfter', targetTable);
      return;

    case 'view_drop':
      assertViewDefinition(edit.viewDefBefore, 'view_drop.viewDefBefore', targetTable);
      return;

    default:
      invalid(`unknown modificationType ${String(edit.modificationType)}`);
  }
}
