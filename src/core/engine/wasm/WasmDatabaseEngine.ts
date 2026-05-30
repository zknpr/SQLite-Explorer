/**
 * WebAssembly-based SQLite database engine (sql.js).
 *
 * Extracted from src/core/sqlite-db.ts as a standalone module so the
 * factory and worker entry point in sqlite-db can stay slim and so a
 * future native engine can sit alongside under src/core/engine/.
 *
 * Imports getNodeFs from src/core/platform/fs to avoid a circular
 * dependency back into sqlite-db.
 */

import type {
  CellValue,
  RecordId,
  QueryResultSet,
  ModificationEntry,
  DatabaseOperations,
  CellUpdate,
  TableQueryOptions,
  TableCountOptions,
  SchemaSnapshot,
  ColumnMetadata,
  ColumnDefinition
} from '../../types';
import { escapeIdentifier, validateSqlType, validateRowId, validateRowIds } from '../../sql-utils';
import { buildSelectQuery, buildCountQuery } from '../../query-builder';
import { applyMergePatch } from '../../json-utils';
import { getNodeFs } from '../../platform/fs';

// ============================================================================
// Internal sql.js Types
// ============================================================================

interface WasmPreparedStatement {
  run(params?: CellValue[]): void;
  bind(params?: CellValue[]): boolean;
  get(params?: CellValue[]): CellValue[] | undefined;
  step(): boolean;
  reset(): void;
  free(): boolean;
  getColumnNames(): string[];
}

export interface WasmDatabaseInstance {
  exec(sql: string, params?: CellValue[]): Array<{ columns: string[]; values: CellValue[][] }>;
  prepare(sql: string, params?: CellValue[]): WasmPreparedStatement;
  iterateStatements(sql: string): Iterable<WasmPreparedStatement>;
  export(): Uint8Array;
  close(): void;
}

export interface WasmEngineModule {
  Database: new (data?: ArrayLike<number>) => WasmDatabaseInstance;
}

// ============================================================================
// Database Engine Implementation
// ============================================================================

/**
 * Default query timeout in milliseconds (30 seconds).
 */
const DEFAULT_QUERY_TIMEOUT_MS = 30000;

export class WasmDatabaseEngine implements DatabaseOperations {
  private readonly instance: WasmDatabaseInstance;
  private readonly queryTimeout: number;
  /** Whether SQLite's json_patch() function is available (JSON1 extension). */
  private readonly hasJsonPatch: boolean;
  readonly engineKind = Promise.resolve('wasm' as const);

  constructor(instance: WasmDatabaseInstance, timeoutMs: number = DEFAULT_QUERY_TIMEOUT_MS) {
    this.instance = instance;
    this.queryTimeout = timeoutMs;

    // Probe for json_patch() availability at construction time.
    // json_patch() is part of the JSON1 extension, which is included in most
    // sql.js WASM builds but not guaranteed in all environments.
    try {
      instance.exec("SELECT json_patch('{}', '{}')");
      this.hasJsonPatch = true;
    } catch {
      this.hasJsonPatch = false;
    }
  }

  /**
   * Attempt a ROLLBACK and log failures instead of throwing.
   * Used in catch blocks where the original error should propagate,
   * not a secondary rollback failure.
   */
  private async safeRollback(context: string): Promise<void> {
    try {
      await this.executeQuery('ROLLBACK');
    } catch (rollbackErr) {
      console.warn(`Failed to rollback (${context}):`, rollbackErr);
    }
  }

  /**
   * Execute a SQL query and return structured results.
   *
   * Returns results in sql.js compatible format for webview compatibility.
   * The webview expects { columns, values } format from the original sql.js.
   * Implements query timeout to prevent runaway queries.
   *
   * @param sql - SQL statement to execute
   * @param params - Optional bound parameters
   * @returns Array of result sets in sql.js format
   */
  async executeQuery(sql: string, params?: CellValue[]): Promise<QueryResultSet[]> {
    const startTime = Date.now();
    const results: QueryResultSet[] = [];
    let currentStmt: WasmPreparedStatement | null = null;

    try {
      const iterator = this.instance.iterateStatements(sql);
      let isFirstStatement = true;

      for (const stmt of iterator) {
        currentStmt = stmt;

        // Bind parameters only to the first statement to match exec behavior
        if (isFirstStatement && params && params.length > 0) {
          stmt.bind(params);
        }
        isFirstStatement = false;

        const rows: CellValue[][] = [];

        while (stmt.step()) {
          // Check timeout during row iteration
          if (Date.now() - startTime > this.queryTimeout) {
            stmt.free();
            currentStmt = null; // Prevent double-free in catch block
            throw new Error(`Query execution timed out after ${this.queryTimeout}ms`);
          }
          const row = stmt.get();
          if (row) {
            rows.push(row);
          }
        }

        const columns = stmt.getColumnNames();
        // Only include results that have columns (matching exec behavior)
        if (columns.length > 0) {
          results.push({
            columns,
            values: rows,
            headers: columns,
            rows
          });
        }

        // iterateStatements handles freeing - clear reference
        currentStmt = null;
      }
    } catch (err) {
      // Ensure current statement is freed if iteration was interrupted
      if (currentStmt) {
        try {
          currentStmt.free();
        } catch (freeErr) {
          console.warn('Failed to free statement on error:', freeErr);
        }
      }
      const errorDetail = err instanceof Error ? err.message : String(err);
      throw new Error(`Query failed: ${errorDetail}`);
    }

    return results;
  }

  /**
   * Serialize the database to binary format.
   *
   * @param _name - Identifier (unused, for interface compatibility)
   * @returns Database binary content
   */
  async serializeDatabase(_name: string): Promise<Uint8Array> {
    return this.instance.export();
  }

  /**
   * Apply a batch of modifications.
   * Currently no-op as modifications are applied via executeQuery.
   */
  async applyModifications(
    _mods: ModificationEntry[],
    _signal?: AbortSignal
  ): Promise<void> {
    // Modifications applied directly through executeQuery
  }

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

  private async undoCellUpdate(targetTable: string, mod: ModificationEntry): Promise<void> {
    const { affectedCells, targetRowId, targetColumn, priorValue } = mod;
    if (affectedCells) {
      // Batch undo
      const updates = affectedCells.map(cell => ({
        rowId: cell.rowId,
        column: cell.columnName,
        value: cell.priorValue ?? null
      }));
      await this.updateCellBatch(targetTable, updates);
    } else if (targetRowId !== undefined && targetColumn) {
      // Single cell undo
      await this.updateCell(targetTable, targetRowId, targetColumn, priorValue ?? null);
    }
  }

  private async undoRowInsert(targetTable: string, mod: ModificationEntry): Promise<void> {
    const { targetRowId } = mod;
    // Undo insert = delete row
    if (targetRowId !== undefined) {
      await this.deleteRows(targetTable, [targetRowId]);
    }
  }

  private async undoRowDelete(targetTable: string, mod: ModificationEntry): Promise<void> {
    const { deletedRows } = mod;
    // Undo delete = re-insert rows
    if (deletedRows && deletedRows.length > 0) {
      await this.insertRowBatch(targetTable, deletedRows.map(dr => dr.row));
    }
  }

  private async undoColumnAdd(targetTable: string, mod: ModificationEntry): Promise<void> {
    const { targetColumn } = mod;
    // Undo add column = drop column
    if (targetColumn) {
      await this.deleteColumns(targetTable, [targetColumn]);
    }
  }

  private async undoColumnDrop(targetTable: string, mod: ModificationEntry): Promise<void> {
    const { deletedColumns } = mod;
    // Undo drop column = add column + restore values
    if (deletedColumns) {
      await this.executeQuery('BEGIN TRANSACTION');
      try {
        // Optimize column creation by batching all ADD COLUMN statements into a single executeQuery call.
        // This avoids N+1 query transaction overhead for multiple columns.
        const addColumnStatements = deletedColumns.map(col => {
          validateSqlType(col.type);
          return `ALTER TABLE ${escapeIdentifier(targetTable)} ADD COLUMN ${escapeIdentifier(col.name)} ${col.type};`;
        }).join('\n');

        if (addColumnStatements) {
          await this.executeQuery(addColumnStatements);
        }

        // Optimize restoration by grouping rows that have identical column sets
        // This is done effectively by doing one UPDATE per row for all restored columns
        // e.g. UPDATE table SET col1 = ?, col2 = ? WHERE rowid = ?

        // First, transform the data into a row-centric map
        const rowUpdates = new Map<number, Record<string, CellValue | null>>();
        for (const col of deletedColumns) {
          for (const cell of col.data) {
            const rId = Number(cell.rowId);
            let rowObj = rowUpdates.get(rId);
            if (!rowObj) {
              rowObj = {};
              rowUpdates.set(rId, rowObj);
            }
            rowObj[col.name] = cell.value ?? null;
          }
        }

        if (rowUpdates.size > 0) {
          const columnsToSet = deletedColumns.map(c => escapeIdentifier(c.name));
          const setClause = columnsToSet.map(c => `${c} = ?`).join(', ');
          const sql = `UPDATE ${escapeIdentifier(targetTable)} SET ${setClause} WHERE rowid = ?`;
          const stmt = this.instance.prepare(sql);
          try {
            for (const [rId, rowObj] of rowUpdates.entries()) {
              const params: CellValue[] = deletedColumns.map(c => rowObj[c.name] ?? null);
              params.push(rId);
              stmt.run(params);
            }
          } finally {
            stmt.free();
          }
        }

        await this.executeQuery('COMMIT');
      } catch (e) {
        await this.safeRollback('undoColumnDrop');
        throw e;
      }
    }
  }

  private async undoTableCreate(targetTable: string): Promise<void> {
    // Undo create table = drop table
    await this.executeQuery(`DROP TABLE IF EXISTS ${escapeIdentifier(targetTable)}`);
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
                const updates = affectedCells.map(cell => ({
                    rowId: cell.rowId,
                    column: cell.columnName,
                    value: cell.newValue ?? null
                }));
                await this.updateCellBatch(targetTable, updates);
            } else if (targetRowId !== undefined && targetColumn) {
                await this.updateCell(targetTable, targetRowId, targetColumn, newValue ?? null);
            }
            break;

        case 'row_insert':
            // Redo insert = insert again
            if (rowData) {
                // If we have the original rowId, enforce it to maintain history consistency
                const dataToInsert = targetRowId !== undefined
                    ? { ...rowData, rowid: targetRowId }
                    : rowData;
                await this.insertRow(targetTable, dataToInsert);
            }
            break;

        case 'row_delete':
            // Redo delete = delete rows
            if (affectedRowIds) {
                await this.deleteRows(targetTable, affectedRowIds);
            }
            break;

        case 'column_add':
            // Redo add column = add column
            if (targetColumn && columnDef) {
                await this.addColumn(targetTable, targetColumn, columnDef.type, columnDef.defaultValue);
            }
            break;

        case 'column_drop':
            // Redo drop column = drop column
            if (deletedColumns) {
                const colNames = deletedColumns.map(c => c.name);
                await this.deleteColumns(targetTable, colNames);
            }
            break;

        case 'table_create':
            // Redo create table
            if (tableDef && tableDef.columns) {
                await this.createTable(targetTable, tableDef.columns);
            }
            break;
    }
  }

  /**
   * Flush changes to storage.
   * No-op for in-memory database; actual persistence via serializeDatabase.
   */
  async flushChanges(_signal?: AbortSignal): Promise<void> {
    // In-memory database - flush handled by exporting to file
  }

  /**
   * Discard pending modifications.
   * Reverts changes by undoing them in reverse order.
   */
  async discardModifications(
    mods: ModificationEntry[],
    _signal?: AbortSignal
  ): Promise<void> {
    // Apply undos in reverse order (LIFO)
    for (let i = mods.length - 1; i >= 0; i--) {
        await this.undoModification(mods[i]);
    }
  }

  /**
   * Update a single cell value.
   */
  async updateCell(table: string, rowId: RecordId, column: string, value: CellValue, patch?: string): Promise<void> {
    // Validate rowId is a number
    const rowIdNum = validateRowId(rowId);

    let sql: string;
    let params: CellValue[];

    if (patch) {
        const escapedCol = escapeIdentifier(column);
        const escapedTbl = escapeIdentifier(table);

        if (this.hasJsonPatch) {
            // Use SQLite's native json_patch() — single UPDATE, no SELECT round-trip.
            // COALESCE handles NULL columns: json_patch(NULL, x) returns NULL per SQL semantics,
            // but the expected behavior is to treat NULL as empty object (matching JS fallback).
            sql = `UPDATE ${escapedTbl} SET ${escapedCol} = json_patch(COALESCE(${escapedCol}, '{}'), ?) WHERE rowid = ?`;
            params = [typeof patch === 'string' ? patch : JSON.stringify(patch), rowIdNum];
        } else {
            // Fallback: read current value, apply patch in JS, write back
            const currentResult = await this.executeQuery(`SELECT ${escapedCol} FROM ${escapedTbl} WHERE rowid = ?`, [rowIdNum]);
            let currentValue = currentResult[0]?.rows[0]?.[0];

            let currentObj = {};
            if (typeof currentValue === 'string') {
                try { currentObj = JSON.parse(currentValue); } catch (e) { console.warn('Failed to parse current JSON value for patching (updateCell)', e); }
            } else if (typeof currentValue === 'object' && currentValue !== null && !(currentValue instanceof Uint8Array)) {
                currentObj = currentValue;
            }

            const patchObj = typeof patch === 'string' ? JSON.parse(patch) : patch;
            const newValueObj = applyMergePatch(currentObj, patchObj);
            const newValueStr = JSON.stringify(newValueObj);

            sql = `UPDATE ${escapedTbl} SET ${escapedCol} = ? WHERE rowid = ?`;
            params = [newValueStr, rowIdNum];
        }
    } else {
        sql = `UPDATE ${escapeIdentifier(table)} SET ${escapeIdentifier(column)} = ? WHERE rowid = ?`;
        params = [value, rowIdNum];
    }

    await this.executeQuery(sql, params);
  }

  /**
   * Insert a new row.
   */
  async insertRow(table: string, data: Record<string, CellValue>): Promise<RecordId | undefined> {
    const columns = Object.keys(data);
    let sql: string;
    let params: CellValue[] = [];

    if (columns.length === 0) {
      sql = `INSERT INTO ${escapeIdentifier(table)} DEFAULT VALUES`;
    } else {
      const colNames = columns.map(escapeIdentifier).join(', ');
      const placeholders = columns.map(() => '?').join(', ');
      params = columns.map(col => data[col]);
      sql = `INSERT INTO ${escapeIdentifier(table)} (${colNames}) VALUES (${placeholders})`;
    }

    await this.executeQuery(sql, params);

    // Get last insert rowid
    const result = await this.executeQuery('SELECT last_insert_rowid() as id');
    if (result && result.length > 0 && result[0].rows.length > 0) {
      return result[0].rows[0][0] as RecordId;
    }
    return undefined;
  }

  /**
   * Insert multiple rows in a batch within a transaction.
   */
  async insertRowBatch(table: string, rows: Record<string, CellValue>[]): Promise<void> {
    if (rows.length === 0) return;

    await this.executeQuery('BEGIN TRANSACTION');
    try {
      const escapedTable = escapeIdentifier(table);
      const groups = new Map<string, { columns: string[], data: CellValue[][] }>();

      for (const row of rows) {
        const columns = Object.keys(row);
        const key = columns.join('\0');
        if (!groups.has(key)) {
          groups.set(key, { columns, data: [] });
        }
        groups.get(key)!.data.push(columns.map(col => row[col]));
      }

      for (const group of groups.values()) {
        const { columns, data } = group;
        let sql: string;
        if (columns.length === 0) {
          sql = `INSERT INTO ${escapedTable} DEFAULT VALUES`;
          const stmt = this.instance.prepare(sql);
          try {
            for (let i = 0; i < data.length; i++) {
              stmt.run();
            }
          } finally {
            stmt.free();
          }
        } else {
          const colNames = columns.map(escapeIdentifier).join(', ');
          const placeholders = columns.map(() => '?').join(', ');
          sql = `INSERT INTO ${escapedTable} (${colNames}) VALUES (${placeholders})`;
          const stmt = this.instance.prepare(sql);
          try {
            for (const params of data) {
              stmt.run(params);
            }
          } finally {
            stmt.free();
          }
        }
      }

      await this.executeQuery('COMMIT');
    } catch (e) {
      await this.safeRollback('insertRowBatch');
      throw e;
    }
  }

  /**
   * Delete rows by ID.
   */
  async deleteRows(table: string, rowIds: RecordId[]): Promise<void> {
    if (rowIds.length === 0) return;

    // Validate all row IDs
    const validIds = validateRowIds(rowIds);

    const placeholders = validIds.map(() => '?').join(', ');
    const sql = `DELETE FROM ${escapeIdentifier(table)} WHERE rowid IN (${placeholders})`;
    await this.executeQuery(sql, validIds);
  }

  /**
   * Find indexes that depend on specific columns.
   *
   * @param table - Table name
   * @param columns - Column names to check
   * @returns Array of index names that reference any of the columns
   */
  async findDependentIndexes(table: string, columns: string[]): Promise<string[]> {
    const dependentIndexes: string[] = [];

    // Query sqlite_master for indexes on this table
    const indexQuery = `
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index'
        AND tbl_name = ?
        AND sql IS NOT NULL
    `;
    const indexResult = await this.executeQuery(indexQuery, [table]);

    if (indexResult.length > 0 && indexResult[0].rows) {
      for (const row of indexResult[0].rows) {
        const indexName = row[0] as string;
        const indexSql = row[1] as string;

        // Check if this index references any of the columns
        const referencesColumn = columns.some(col => {
          // Escape regex metacharacters in column name to prevent broken patterns
          // for names like "data[0]", "a+b", "user.name"
          const escaped = col.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // Match column name in index definition (quoted or unquoted)
          const patterns = [
            new RegExp(`[\\(,]\\s*${escaped}\\s*[\\),]`, 'i'),
            new RegExp(`[\\(,]\\s*"${escaped}"\\s*[\\),]`, 'i'),
            new RegExp(`[\\(,]\\s*\\[${escaped}\\]\\s*[\\),]`, 'i'),
            new RegExp(`[\\(,]\\s*\`${escaped}\`\\s*[\\),]`, 'i')
          ];
          return patterns.some(p => p.test(indexSql));
        });

        if (referencesColumn) {
          dependentIndexes.push(indexName);
        }
      }
    }

    return dependentIndexes;
  }

  /**
   * Delete columns by name.
   *
   * If dropDependentIndexes is provided, those indexes will be dropped first.
   * Otherwise, deletion may fail if indexes reference the columns.
   *
   * @param table - Table name
   * @param columns - Column names to delete
   * @param dropDependentIndexes - Optional list of indexes to drop first
   */
  async deleteColumns(table: string, columns: string[], dropDependentIndexes?: string[]): Promise<void> {
    if (columns.length === 0) return;

    const escapedTable = escapeIdentifier(table);

    // Now drop the columns within a single transaction for better performance
    // This avoids N+1 query transaction overhead for multiple columns
    await this.executeQuery('BEGIN TRANSACTION');
    try {
      // Drop specified dependent indexes first inside the transaction
      if (dropDependentIndexes && dropDependentIndexes.length > 0) {
        const dropIndexStatements = dropDependentIndexes
          .map((indexName) => `DROP INDEX IF EXISTS ${escapeIdentifier(indexName)};`)
          .join('\n');
        await this.executeQuery(dropIndexStatements);
      }

      const dropColumnStatements = columns
        .map((col) => `ALTER TABLE ${escapedTable} DROP COLUMN ${escapeIdentifier(col)};`)
        .join('\n');
      await this.executeQuery(dropColumnStatements);
      await this.executeQuery('COMMIT');
    } catch (e) {
      await this.safeRollback('deleteColumns');
      throw e;
    }
  }

  /**
   * Helper to resolve wildcard columns to explicit column names when using global filter.
   */
  private async resolveQueryColumns(table: string, columns: string[] | undefined, globalFilter: string | undefined): Promise<string[] | undefined> {
    if (globalFilter && (!columns || (columns.length === 1 && columns[0] === '*'))) {
      const tableInfo = await this.getTableInfo(table);
      return tableInfo.map(c => c.identifier);
    }
    return columns;
  }

  /**
   * Create a new table.
   */
  async createTable(table: string, columns: ColumnDefinition[]): Promise<void> {
    if (columns.length === 0) throw new Error('At least one column is required');

    const colDefs = columns.map(col => {
      if (typeof col === 'string') {
         throw new Error('Legacy string column definitions not supported for security');
      }
      // Validate SQL type to prevent injection via malicious type definitions
      validateSqlType(col.type);
      let def = `${escapeIdentifier(col.name)} ${col.type}`;
      if (col.primaryKey) def += ' PRIMARY KEY';
      if (col.notNull && !col.primaryKey) def += ' NOT NULL';
      return def;
    });

    const sql = `CREATE TABLE ${escapeIdentifier(table)} (${colDefs.join(', ')})`;
    await this.executeQuery(sql);
  }

  /**
   * Update multiple cells in a batch.
   */
  async updateCellBatch(table: string, updates: CellUpdate[]): Promise<void> {
    if (updates.length === 0) return;

    // Use SAVEPOINT instead of BEGIN TRANSACTION so this method can be called
    // safely from within an outer transaction (e.g., undoColumnDrop).
    // escapeIdentifier wraps in double quotes defensively — the generated name
    // is already [a-zA-Z0-9_] safe, but quoting prevents issues if the pattern changes.
    const savepointName = escapeIdentifier(`sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      const escapedTable = escapeIdentifier(table);
      // Group updates by column and operation type
      // Prepare statements one by one avoids full re-parse

      // Prepare per column.
      // Group by column.

      const updatesByColumn = new Map<string, CellUpdate[]>();
      for (const update of updates) {
          const key = `${update.column}|${update.operation || 'set'}`;
          if (!updatesByColumn.has(key)) {
              updatesByColumn.set(key, []);
          }
          updatesByColumn.get(key)!.push(update);
      }

      for (const [key, columnUpdates] of updatesByColumn.entries()) {
          const [column, op] = key.split('|');
          const escapedColumn = escapeIdentifier(column);

          // For json_patch operations, choose between native SQLite json_patch()
          // and JS fallback depending on runtime availability
          const useNativePatch = op === 'json_patch' && this.hasJsonPatch;

          // COALESCE handles NULL columns: json_patch(NULL, x) returns NULL per SQL semantics,
          // but the expected behavior is to treat NULL as empty object (matching JS fallback).
          const sql = useNativePatch
            ? `UPDATE ${escapedTable} SET ${escapedColumn} = json_patch(COALESCE(${escapedColumn}, '{}'), ?) WHERE rowid = ?`
            : `UPDATE ${escapedTable} SET ${escapedColumn} = ? WHERE rowid = ?`;

          const stmt = this.instance.prepare(sql);

          // Only need SELECT for JS fallback path
          let selectStmt: WasmPreparedStatement | null = null;

          try {
              if (op === 'json_patch' && !this.hasJsonPatch) {
                 selectStmt = this.instance.prepare(`SELECT ${escapedColumn} FROM ${escapedTable} WHERE rowid = ?`);
              }

              for (const update of columnUpdates) {
                  const rowIdNum = validateRowId(update.rowId);

                  if (useNativePatch) {
                     // Native json_patch(): single UPDATE, no SELECT needed
                     const patchStr = typeof update.value === 'string'
                       ? update.value
                       : JSON.stringify(update.value);
                     stmt.run([patchStr, rowIdNum]);

                  } else if (op === 'json_patch') {
                     // JS fallback: read current value, apply patch, write back
                     let currentValue = null;
                     if (selectStmt) {
                        const row = selectStmt.get([rowIdNum]);
                        if (row && row.length > 0) {
                            currentValue = row[0];
                        }
                        selectStmt.reset();
                     }

                     let currentObj = {};
                     if (typeof currentValue === 'string') {
                         try { currentObj = JSON.parse(currentValue); } catch (e) { console.warn('Failed to parse current JSON value for patching (updateCells)', e); }
                     }

                     const patchObj = typeof update.value === 'string' ? JSON.parse(update.value as string) : update.value;
                     const newValueObj = applyMergePatch(currentObj, patchObj);
                     const newValueStr = JSON.stringify(newValueObj);

                     stmt.run([newValueStr, rowIdNum]);
                  } else {
                      // Standard update
                      stmt.run([update.value, rowIdNum]);
                  }
              }
          } finally {
              stmt.free();
              if (selectStmt) selectStmt.free();
          }
      }

      await this.executeQuery(`RELEASE ${savepointName}`);
    } catch (err) {
      try {
        // ROLLBACK TO restores but keeps the savepoint; RELEASE removes it
        await this.executeQuery(`ROLLBACK TO ${savepointName}`);
        await this.executeQuery(`RELEASE ${savepointName}`);
      } catch (rollbackErr) {
        console.warn('Failed to rollback savepoint:', rollbackErr);
      }
      throw err;
    }
  }

  /**
   * Add a new column to a table.
   */
  async addColumn(table: string, column: string, type: string, defaultValue?: string): Promise<void> {
    // Validate SQL type to prevent injection via malicious type definitions
    validateSqlType(type);
    let sql = `ALTER TABLE ${escapeIdentifier(table)} ADD COLUMN ${escapeIdentifier(column)} ${type}`;

    if (defaultValue !== undefined && defaultValue !== null && defaultValue !== '') {
      // SQL safe default value handling with strict validation
      if (defaultValue.toLowerCase() === 'null') {
        sql += ' DEFAULT NULL';
      } else if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(defaultValue)) {
        // Strict numeric pattern: optional sign, digits with optional decimal, optional exponent
        // This prevents hex (0x), special values, and other edge cases
        sql += ` DEFAULT ${defaultValue}`;
      } else {
        sql += ` DEFAULT '${defaultValue.replace(/'/g, "''")}'`;
      }
    }

    await this.executeQuery(sql);
  }

  /**
   * Fetch table data using options.
   *
   * NOTE: This method intentionally bypasses the query timeout mechanism.
   * Unlike raw executeQuery(), fetchTableData() always includes pagination
   * (LIMIT/OFFSET) which naturally bounds the result size and execution time.
   * The query builder enforces these limits, making timeout unnecessary here.
   */
  async fetchTableData(table: string, options: TableQueryOptions): Promise<QueryResultSet> {
    const queryOptions = { ...options };
    queryOptions.columns = await this.resolveQueryColumns(table, queryOptions.columns, queryOptions.globalFilter);

    const { sql, params } = buildSelectQuery(table, queryOptions);

    // Use prepare/step/get to avoid overhead of exec() which builds intermediate objects
    // and to allow for potentially better memory management in the future
    let stmt: WasmPreparedStatement | null = null;
    try {
        stmt = this.instance.prepare(sql, params);
        const rows: CellValue[][] = [];

        while (stmt.step()) {
            // We know a row exists because step() returned true
            const row = stmt.get();
            if (row) {
                rows.push(row);
            }
        }

        const headers = stmt.getColumnNames();
        return {
            headers,
            rows,
            columns: headers,
            values: rows
        };
    } catch (err) {
        const errorDetail = err instanceof Error ? err.message : String(err);
        throw new Error(`Fetch failed: ${errorDetail}`);
    } finally {
        if (stmt) stmt.free();
    }
  }

  /**
   * Fetch table row count using options.
   */
  async fetchTableCount(table: string, options: TableCountOptions): Promise<number> {
    const queryOptions = { ...options };
    queryOptions.columns = await this.resolveQueryColumns(table, queryOptions.columns, queryOptions.globalFilter);

    const { sql, params } = buildCountQuery(table, queryOptions);
    const result = await this.executeQuery(sql, params);
    if (result && result.length > 0 && result[0].rows.length > 0) {
      const count = result[0].rows[0][0];
      return typeof count === 'number' ? count : 0;
    }
    return 0;
  }

  /**
   * Fetch database schema.
   */
  async fetchSchema(): Promise<SchemaSnapshot> {
    // Combine schema queries into one
    const schemaResult = await this.executeQuery(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name"
    );

    const rows = schemaResult[0]?.rows || [];

    const tables = rows
        .filter(r => r[0] === 'table')
        .map(r => ({ identifier: r[1] as string }));

    const views = rows
        .filter(r => r[0] === 'view')
        .map(r => ({ identifier: r[1] as string }));

    const indexes = rows
        .filter(r => r[0] === 'index')
        .map(r => ({ identifier: r[1] as string, parentTable: r[2] as string }));

    return { tables, views, indexes };
  }

  /**
   * Get table metadata.
   */
  async getTableInfo(table: string): Promise<ColumnMetadata[]> {
    const result = await this.executeQuery(`PRAGMA table_info(${escapeIdentifier(table)})`);
    return (result[0]?.rows || []).map(row => ({
      ordinal: row[0] as number,
      identifier: row[1] as string,
      declaredType: row[2] as string,
      isRequired: row[3] as number,
      defaultExpression: row[4],
      primaryKeyPosition: row[5] as number
    }));
  }

  /**
   * Get PRAGMA settings.
   */
  async getPragmas(): Promise<Record<string, CellValue>> {
    const pragmasToFetch = [
      'foreign_keys',
      'journal_mode',
      'synchronous',
      'cache_size',
      'locking_mode',
      'temp_store',
      'encoding',
      'auto_vacuum'
    ];

    const result: Record<string, CellValue> = {};
    const query = pragmasToFetch.map(pragma => `PRAGMA ${pragma};`).join('\n');
    const res = await this.executeQuery(query);

    for (let i = 0; i < pragmasToFetch.length; i++) {
      if (res[i]?.rows?.[0]) {
        result[pragmasToFetch[i]] = res[i].rows[0][0];
      }
    }

    return result;
  }

  /**
   * Set PRAGMA value.
   */
  async setPragma(pragma: string, value: CellValue): Promise<void> {
    // Validate pragma name to prevent SQL injection
    const allowedPragmas = [
      'foreign_keys',
      'journal_mode',
      'synchronous',
      'cache_size',
      'locking_mode',
      'temp_store',
      'auto_vacuum'
    ];

    if (!allowedPragmas.includes(pragma)) {
      throw new Error(`Invalid or disallowed PRAGMA: ${pragma}`);
    }

    // Value sanitization depends on type.
    // String values use a strict whitelist to prevent injection — only
    // alphanumeric, underscores, and hyphens are allowed (covers all
    // valid PRAGMA string values like 'wal', 'delete', 'normal', etc.)
    let sql: string;
    if (typeof value === 'string') {
        if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
          throw new Error('Invalid PRAGMA string value: contains disallowed characters');
        }
        sql = `PRAGMA ${pragma} = '${value}'`;
    } else if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
          throw new Error('Invalid PRAGMA numeric value: must be finite');
        }
        sql = `PRAGMA ${pragma} = ${value}`;
    } else if (typeof value === 'boolean') {
        sql = `PRAGMA ${pragma} = ${value ? 'ON' : 'OFF'}`;
    } else {
        throw new Error(`Invalid PRAGMA value type: ${typeof value}`);
    }

    await this.executeQuery(sql);
  }

  /**
   * Test connection.
   */
  async ping(): Promise<boolean> {
    try {
      await this.executeQuery('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Release database resources.
   */
  shutdown(): void {
    this.instance.close();
  }

  /**
   * Write database directly to file system.
   */
  async writeToFile(path: string): Promise<void> {
    const data = this.instance.export();

    const fs = getNodeFs();
    if (fs) {
        await fs.promises.writeFile(path, data);
    } else {
        throw new Error('File system access not available');
    }
  }
}
