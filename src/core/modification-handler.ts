import type { DatabaseOperations, ModificationEntry, CellUpdate, RecordId, CellValue } from './types';
import { escapeIdentifier } from './sql-utils';

/**
 * Handles Undo/Redo operations for database modifications.
 * Encapsulates logic for reverting and reapplying changes.
 */
export class ModificationHandler {
  constructor(private readonly db: DatabaseOperations) {}

  /**
   * Undo a modification.
   */
  async undoModification(mod: ModificationEntry): Promise<void> {
    const { modificationType, targetTable } = mod;
    if (!targetTable) return;

    switch (modificationType) {
      case 'cell_update':
        await this.undoCellUpdate(targetTable, mod);
        break;

      case 'row_insert':
        await this.undoRowInsert(targetTable, mod);
        break;

      case 'row_delete':
        await this.undoRowDelete(targetTable, mod);
        break;

      case 'column_add':
        await this.undoColumnAdd(targetTable, mod);
        break;

      case 'column_drop':
        await this.undoColumnDrop(targetTable, mod);
        break;

      case 'table_create':
        await this.undoTableCreate(targetTable);
        break;
    }
  }

  /**
   * Redo a modification.
   */
  async redoModification(mod: ModificationEntry): Promise<void> {
    const { modificationType, targetTable, targetRowId, targetColumn, newValue, affectedCells, affectedRowIds, rowData, tableDef, columnDef, deletedColumns } = mod;
    if (!targetTable) return;

    switch (modificationType) {
        case 'cell_update':
            if (affectedCells) {
                // Batch redo
                const updates: CellUpdate[] = affectedCells.map(cell => ({
                    rowId: cell.rowId,
                    column: cell.columnName,
                    value: cell.newValue ?? null
                }));
                await this.db.updateCellBatch(targetTable, updates);
            } else if (targetRowId !== undefined && targetColumn) {
                await this.db.updateCell(targetTable, targetRowId, targetColumn, newValue ?? null);
            }
            break;

        case 'row_insert':
            // Redo insert = insert again
            if (rowData) {
                // If we have the original rowId, enforce it to maintain history consistency
                const dataToInsert = targetRowId !== undefined
                    ? { ...rowData, rowid: targetRowId }
                    : rowData;
                await this.db.insertRow(targetTable, dataToInsert);
            }
            break;

        case 'row_delete':
            // Redo delete = delete rows
            if (affectedRowIds) {
                await this.db.deleteRows(targetTable, affectedRowIds);
            }
            break;

        case 'column_add':
            // Redo add column = add column
            if (targetColumn && columnDef) {
                await this.db.addColumn(targetTable, targetColumn, columnDef.type, columnDef.defaultValue);
            }
            break;

        case 'column_drop':
            // Redo drop column = drop column
            if (deletedColumns) {
                const colNames = deletedColumns.map(c => c.name);
                await this.db.deleteColumns(targetTable, colNames);
            }
            break;

        case 'table_create':
            // Redo create table
            if (tableDef && tableDef.columns) {
                await this.db.createTable(targetTable, tableDef.columns);
            }
            break;
    }
  }

  /**
   * Discard pending modifications.
   * Reverts changes by undoing them in reverse order.
   */
  async discardModifications(mods: ModificationEntry[]): Promise<void> {
    // Apply undos in reverse order (LIFO)
    for (let i = mods.length - 1; i >= 0; i--) {
        await this.undoModification(mods[i]);
    }
  }

  private async undoCellUpdate(targetTable: string, mod: ModificationEntry): Promise<void> {
    const { affectedCells, targetRowId, targetColumn, priorValue } = mod;
    if (affectedCells) {
      // Batch undo
      const updates: CellUpdate[] = affectedCells.map(cell => ({
        rowId: cell.rowId,
        column: cell.columnName,
        value: cell.priorValue ?? null
      }));
      await this.db.updateCellBatch(targetTable, updates);
    } else if (targetRowId !== undefined && targetColumn) {
      // Single cell undo
      await this.db.updateCell(targetTable, targetRowId, targetColumn, priorValue ?? null);
    }
  }

  private async undoRowInsert(targetTable: string, mod: ModificationEntry): Promise<void> {
    const { targetRowId } = mod;
    // Undo insert = delete row
    if (targetRowId !== undefined) {
      await this.db.deleteRows(targetTable, [targetRowId]);
    }
  }

  private async undoRowDelete(targetTable: string, mod: ModificationEntry): Promise<void> {
    const { deletedRows } = mod;
    // Undo delete = re-insert rows
    if (deletedRows && deletedRows.length > 0) {
      // Optimization: use batch insert if available
      const rows = deletedRows.map(r => r.row);
      await this.db.insertRowBatch(targetTable, rows);
    }
  }

  private async undoColumnAdd(targetTable: string, mod: ModificationEntry): Promise<void> {
    const { targetColumn } = mod;
    // Undo add column = drop column
    if (targetColumn) {
      await this.db.deleteColumns(targetTable, [targetColumn]);
    }
  }

  private async undoColumnDrop(targetTable: string, mod: ModificationEntry): Promise<void> {
    const { deletedColumns } = mod;
    // Undo drop column = add column + restore values
    if (deletedColumns) {
      for (const col of deletedColumns) {
        await this.db.addColumn(targetTable, col.name, col.type);
        // Restore values
        if (col.data && col.data.length > 0) {
           const updates: CellUpdate[] = col.data.map(d => ({
               rowId: d.rowId,
               column: col.name,
               value: d.value
           }));
           await this.db.updateCellBatch(targetTable, updates);
        }
      }
    }
  }

  private async undoTableCreate(targetTable: string): Promise<void> {
    // Undo create table = drop table
    await this.db.executeQuery(`DROP TABLE IF EXISTS ${escapeIdentifier(targetTable)}`);
  }
}
