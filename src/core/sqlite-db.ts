/**
 * SQLite Database Engine Module
 *
 * Provides database operations using sql.js WebAssembly engine.
 * Designed to run in a Worker thread for non-blocking execution.
 */

import type {
  CellValue,
  RecordId,
  QueryResultSet,
  ModificationEntry,
  DatabaseInitConfig,
  DatabaseInitResult,
  DatabaseOperations,
  CellUpdate,
  TableQueryOptions,
  TableCountOptions,
  SchemaSnapshot,
  ColumnMetadata
} from './types';
import { escapeIdentifier, cellValueToSql } from './sql-utils';
import { buildSelectQuery, buildCountQuery } from './query-builder';
import { applyMergePatch } from './json-utils';

// ============================================================================
// Internal sql.js Types
// ============================================================================

/**
 * sql.js database instance interface.
 */
interface WasmDatabaseInstance {
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  prepare(sql: string, params?: unknown[]): any;
  export(): Uint8Array;
  close(): void;
}

/**
 * sql.js module interface.
 */
interface WasmEngineModule {
  Database: new (data?: ArrayLike<number>) => WasmDatabaseInstance;
}

// ============================================================================
// Database Engine Implementation
// ============================================================================

/**
 * WebAssembly-based SQLite database engine.
 *
 * Wraps sql.js and provides a clean async API for database operations.
 * All modifications happen in memory until explicitly exported.
 */
class WasmDatabaseEngine implements DatabaseOperations {
  private readonly instance: WasmDatabaseInstance;
  readonly engineKind = Promise.resolve('wasm' as const);

  constructor(instance: WasmDatabaseInstance) {
    this.instance = instance;
  }

  /**
   * Execute a SQL query and return structured results.
   *
   * Returns results in sql.js compatible format for webview compatibility.
   * The webview expects { columns, values } format from the original sql.js.
   *
   * @param sql - SQL statement to execute
   * @param params - Optional bound parameters
   * @returns Array of result sets in sql.js format
   */
  async executeQuery(sql: string, params?: CellValue[]): Promise<QueryResultSet[]> {
    try {
      const rawResults = this.instance.exec(sql, params);
      // Return in sql.js compatible format for webview compatibility
      return rawResults.map(resultSet => ({
        columns: resultSet.columns,
        values: resultSet.values as CellValue[][],
        // Also provide our new format for internal use
        headers: resultSet.columns,
        rows: resultSet.values as CellValue[][]
      })) as QueryResultSet[];
    } catch (err) {
      const errorDetail = err instanceof Error ? err.message : String(err);
      throw new Error(`Query failed: ${errorDetail}`);
    }
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
   * Handled at extension level through history tracking.
   */
  async undoModification(_mod: ModificationEntry): Promise<void> {
    // Extension handles undo via re-executing inverse queries
  }

  /**
   * Redo a modification.
   * Handled at extension level through history tracking.
   */
  async redoModification(_mod: ModificationEntry): Promise<void> {
    // Extension handles redo via re-executing queries
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
   * Handled at extension level through history tracking.
   */
  async discardModifications(
    _mods: ModificationEntry[],
    _signal?: AbortSignal
  ): Promise<void> {
    // Extension handles rollback via history
  }

  /**
   * Update a single cell value.
   */
  async updateCell(table: string, rowId: RecordId, column: string, value: CellValue, patch?: string): Promise<void> {
    // Validate rowId is a number
    const rowIdNum = Number(rowId);
    if (!Number.isFinite(rowIdNum)) {
      throw new Error(`Invalid rowid: ${rowId}`);
    }

    let sql: string;
    let params: CellValue[];

    if (patch) {
        // Fallback to JS implementation of json_patch
        // Fetch current value
        const currentResult = await this.executeQuery(`SELECT ${escapeIdentifier(column)} FROM ${escapeIdentifier(table)} WHERE rowid = ?`, [rowIdNum]);
        let currentValue = currentResult[0]?.rows[0]?.[0];

        // Parse current JSON
        let currentObj = {};
        if (typeof currentValue === 'string') {
            try { currentObj = JSON.parse(currentValue); } catch {}
        } else if (typeof currentValue === 'object' && currentValue !== null && !(currentValue instanceof Uint8Array)) {
             // Already an object? (unlikely from SQLite unless using some extension, usually string)
             currentObj = currentValue;
        }

        // Apply patch
        const patchObj = typeof patch === 'string' ? JSON.parse(patch) : patch;
        const newValueObj = applyMergePatch(currentObj, patchObj);
        const newValueStr = JSON.stringify(newValueObj);

        sql = `UPDATE ${escapeIdentifier(table)} SET ${escapeIdentifier(column)} = ? WHERE rowid = ?`;
        params = [newValueStr, rowIdNum];
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
   * Delete rows by ID.
   */
  async deleteRows(table: string, rowIds: RecordId[]): Promise<void> {
    if (rowIds.length === 0) return;

    // Validate all row IDs
    const validIds = rowIds.map(id => {
      const num = Number(id);
      if (!Number.isFinite(num)) throw new Error(`Invalid rowid: ${id}`);
      return num;
    });

    const placeholders = validIds.map(() => '?').join(', ');
    const sql = `DELETE FROM ${escapeIdentifier(table)} WHERE rowid IN (${placeholders})`;
    await this.executeQuery(sql, validIds);
  }

  /**
   * Delete columns by name.
   */
  async deleteColumns(table: string, columns: string[]): Promise<void> {
    if (columns.length === 0) return;

    const escapedTable = escapeIdentifier(table);

    for (const col of columns) {
      const sql = `ALTER TABLE ${escapedTable} DROP COLUMN ${escapeIdentifier(col)}`;
      await this.executeQuery(sql);
    }
  }

  /**
   * Create a new table.
   */
  async createTable(table: string, columns: string[]): Promise<void> {
    if (columns.length === 0) throw new Error('At least one column is required');

    // columns array is expected to contain full column definitions (e.g. "id INTEGER PRIMARY KEY")
    // We assume the caller (backend/frontend) passes pre-validated/escaped definitions or we blindly trust them?
    // The previous frontend code constructed "escapeIdentifier(name) type constraints".
    // We should probably accept structured column definitions to be safe, but for now matching existing logic.
    // Ideally, we should pass { name, type, constraints } objects.
    // However, to keep changes minimal and safer than raw SQL, we will accept the definitions string but verify it doesn't contain dangerous characters if possible,
    // OR we change the signature to accept structured data.

    // Let's change the signature in types.ts later if needed, but for now let's stick to the plan of moving SQL generation.
    // If we pass raw column definitions string, we are still vulnerable if the definition string is constructed poorly.
    // The frontend code: let def = `${escapeIdentifier(name)} ${type}`; ... colDefs.push(def);
    // So the frontend IS escaping the identifier. The type is from a select box (safe).
    // So passing the array of definitions strings is relatively safe assuming the frontend uses escapeIdentifier.
    // But to be safer, let's just accept the raw SQL for the column list since it's `CREATE TABLE tbl ( ... )`.

    // Actually, looking at `submitCreateTable` in `viewer.js`:
    // It constructs: `CREATE TABLE ${escapeIdentifier(tableName)} (${colDefs.join(', ')})`
    // colDefs are constructed using escapeIdentifier.

    // Implementing `createTable(table, columnDefs)`:
    const sql = `CREATE TABLE ${escapeIdentifier(table)} (${columns.join(', ')})`;
    await this.executeQuery(sql);
  }

  /**
   * Update multiple cells in a batch.
   */
  async updateCellBatch(table: string, updates: CellUpdate[]): Promise<void> {
    if (updates.length === 0) return;

    // Use transaction for performance and atomicity
    await this.executeQuery('BEGIN TRANSACTION');
    try {
      const escapedTable = escapeIdentifier(table);

      for (const update of updates) {
        // Validate rowId
        const rowIdNum = Number(update.rowId);
        if (!Number.isFinite(rowIdNum)) throw new Error(`Invalid rowid: ${update.rowId}`);

        const escapedColumn = escapeIdentifier(update.column);
        let sql: string;

        if (update.operation === 'json_patch') {
             // Fallback to JS implementation of json_patch
             // Fetch current value
             const currentResult = await this.executeQuery(`SELECT ${escapedColumn} FROM ${escapedTable} WHERE rowid = ?`, [rowIdNum]);
             let currentValue = currentResult[0]?.rows[0]?.[0];

             // Parse current JSON
             let currentObj = {};
             if (typeof currentValue === 'string') {
                 try { currentObj = JSON.parse(currentValue); } catch {}
             }

             // Apply patch
             const patchObj = typeof update.value === 'string' ? JSON.parse(update.value as string) : update.value;
             const newValueObj = applyMergePatch(currentObj, patchObj);
             const newValueStr = JSON.stringify(newValueObj);

             sql = `UPDATE ${escapedTable} SET ${escapedColumn} = ? WHERE rowid = ?`;
             params = [newValueStr, rowIdNum];
        } else {
             // Standard set
             sql = `UPDATE ${escapedTable} SET ${escapedColumn} = ? WHERE rowid = ?`;
             params = [update.value, rowIdNum];
        }

        await this.executeQuery(sql, params);
      }
      await this.executeQuery('COMMIT');
    } catch (err) {
      try { await this.executeQuery('ROLLBACK'); } catch {}
      throw err;
    }
  }

  /**
   * Add a new column to a table.
   */
  async addColumn(table: string, column: string, type: string, defaultValue?: string): Promise<void> {
    let sql = `ALTER TABLE ${escapeIdentifier(table)} ADD COLUMN ${escapeIdentifier(column)} ${type}`;

    if (defaultValue !== undefined && defaultValue !== null && defaultValue !== '') {
      // Basic SQL safe default value handling
      // Ideally we would parse this better or accept a typed value, but matching existing logic
      if (defaultValue.toLowerCase() === 'null') {
        sql += ' DEFAULT NULL';
      } else if (!isNaN(Number(defaultValue))) {
        sql += ` DEFAULT ${defaultValue}`;
      } else {
        sql += ` DEFAULT '${defaultValue.replace(/'/g, "''")}'`;
      }
    }

    await this.executeQuery(sql);
  }

  /**
   * Fetch table data using options.
   */
  async fetchTableData(table: string, options: TableQueryOptions): Promise<QueryResultSet> {
    const { sql, params } = buildSelectQuery(table, options);
    const result = await this.executeQuery(sql, params);
    if (result && result.length > 0) {
      return result[0];
    }
    // Return empty result set structure
    return { headers: [], rows: [] };
  }

  /**
   * Fetch table row count using options.
   */
  async fetchTableCount(table: string, options: TableCountOptions): Promise<number> {
    const { sql, params } = buildCountQuery(table, options);
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
    // Get tables
    const tablesResult = await this.executeQuery(
      "SELECT name, sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    // Get views
    const viewsResult = await this.executeQuery(
      "SELECT name, sql FROM sqlite_schema WHERE type='view' ORDER BY name"
    );
    // Get indexes
    const indexesResult = await this.executeQuery(
      "SELECT name, tbl_name FROM sqlite_schema WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );

    const tables = (tablesResult[0]?.rows || []).map(row => ({
      identifier: row[0] as string
      // We could parse column count or details here if needed, but for now matching existing behavior
    }));

    const views = (viewsResult[0]?.rows || []).map(row => ({
      identifier: row[0] as string
    }));

    const indexes = (indexesResult[0]?.rows || []).map(row => ({
      identifier: row[0] as string,
      parentTable: row[1] as string
    }));

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

    for (const pragma of pragmasToFetch) {
      const res = await this.executeQuery(`PRAGMA ${pragma}`);
      if (res[0]?.rows?.[0]) {
        result[pragma] = res[0].rows[0][0];
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

    // Value sanitization depends on type
    let sql: string;
    if (typeof value === 'string') {
        sql = `PRAGMA ${pragma} = '${value.replace(/'/g, "''")}'`;
    } else if (typeof value === 'number') {
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
}

// ============================================================================
// Database Factory
// ============================================================================

/**
 * Initialize the sql.js engine and create a database instance.
 *
 * @param config - Initialization configuration
 * @returns Database operations handle and read-only flag
 */
export async function createDatabaseEngine(
  config: DatabaseInitConfig
): Promise<DatabaseInitResult> {
  // Dynamically load sql.js module
  const loadEngine = (await import('sql.js')).default;

  // Configure WASM loading
  const engineConfig: Record<string, unknown> = {};
  if (config.wasmBinary && config.wasmBinary.byteLength > 0) {
    engineConfig.wasmBinary = config.wasmBinary;
  } else if (config.resourceMap?.['sqlite3.wasm']) {
    engineConfig.locateFile = () => config.resourceMap!['sqlite3.wasm'];
  }

  const SqlJsModule = await loadEngine(engineConfig) as WasmEngineModule;

  // Create database instance
  let wasmInstance: WasmDatabaseInstance;
  if (config.content && config.content.byteLength > 0) {
    // Open existing database from binary
    wasmInstance = new SqlJsModule.Database(new Uint8Array(config.content));
  } else {
    // Create new empty database
    wasmInstance = new SqlJsModule.Database();
  }

  const engine = new WasmDatabaseEngine(wasmInstance);

  return {
    operations: engine,
    isReadOnly: config.readOnlyMode ?? false
  };
}

// ============================================================================
// Worker Entry Point
// ============================================================================

/**
 * Create a handler object for worker-side database operations.
 *
 * This factory creates an object with methods that can be exposed
 * to the extension host via the IPC module.
 */
export function createWorkerEndpoint() {
  let activeEngine: WasmDatabaseEngine | null = null;

  return {
    /**
     * Initialize a database from binary content.
     *
     * @param filename - Display name for the database
     * @param config - Initialization configuration
     * @returns Database handle and read-only status
     */
    async initializeDatabase(
      filename: string,
      config: DatabaseInitConfig
    ): Promise<DatabaseInitResult> {
      console.log('[Worker] Initializing database:', filename);

      // Shutdown existing engine if present
      if (activeEngine) {
        activeEngine.shutdown();
      }

      const result = await createDatabaseEngine(config);
      activeEngine = result.operations as WasmDatabaseEngine;

      // Return proxy object with bound methods
      // Note: This return value is primarily used for isReadOnly flag.
      // The actual database operations are accessed via the worker endpoint methods below.
      return {
        operations: {
          engineKind: Promise.resolve('wasm'),
          executeQuery: (sql: string, params?: CellValue[]) =>
            activeEngine!.executeQuery(sql, params),
          serializeDatabase: (name: string) =>
            activeEngine!.serializeDatabase(name),
          applyModifications: (mods: ModificationEntry[], sig?: AbortSignal) =>
            activeEngine!.applyModifications(mods, sig),
          undoModification: (mod: ModificationEntry) =>
            activeEngine!.undoModification(mod),
          redoModification: (mod: ModificationEntry) =>
            activeEngine!.redoModification(mod),
          flushChanges: (sig?: AbortSignal) =>
            activeEngine!.flushChanges(sig),
          discardModifications: (mods: ModificationEntry[], sig?: AbortSignal) =>
            activeEngine!.discardModifications(mods, sig),
          updateCell: (table: string, rowId: RecordId, column: string, value: CellValue) =>
            activeEngine!.updateCell(table, rowId, column, value),
          insertRow: (table: string, data: Record<string, CellValue>) =>
            activeEngine!.insertRow(table, data),
          deleteRows: (table: string, rowIds: RecordId[]) =>
            activeEngine!.deleteRows(table, rowIds),
          deleteColumns: (table: string, columns: string[]) =>
            activeEngine!.deleteColumns(table, columns),
          createTable: (table: string, columns: string[]) =>
            activeEngine!.createTable(table, columns),
          updateCellBatch: (table: string, updates: CellUpdate[]) =>
            activeEngine!.updateCellBatch(table, updates),
          addColumn: (table: string, column: string, type: string, defaultValue?: string) =>
            activeEngine!.addColumn(table, column, type, defaultValue),
          fetchTableData: (table: string, options: TableQueryOptions) =>
            activeEngine!.fetchTableData(table, options),
          fetchTableCount: (table: string, options: TableCountOptions) =>
            activeEngine!.fetchTableCount(table, options),
          fetchSchema: () =>
            activeEngine!.fetchSchema(),
          getTableInfo: (table: string) =>
            activeEngine!.getTableInfo(table),
          getPragmas: () =>
            activeEngine!.getPragmas(),
          setPragma: (pragma: string, value: CellValue) =>
            activeEngine!.setPragma(pragma, value),
          ping: () =>
            activeEngine!.ping()
        },
        isReadOnly: result.isReadOnly
      };
    },

    /**
     * Execute a query on the active database.
     *
     * @param sql - SQL statement
     * @param params - Bound parameters
     * @returns Query result sets
     */
    async runQuery(sql: string, params?: CellValue[]): Promise<QueryResultSet[]> {
      if (!activeEngine) throw new Error('No database initialized');
      return activeEngine.executeQuery(sql, params);
    },

    /**
     * Export the active database to binary.
     *
     * @param name - Database name
     * @returns Binary content
     */
    async exportDatabase(name: string): Promise<Uint8Array> {
      if (!activeEngine) throw new Error('No database initialized');
      return activeEngine.serializeDatabase(name);
    },

    async updateCell(table: string, rowId: RecordId, column: string, value: CellValue): Promise<void> {
      if (!activeEngine) throw new Error('No database initialized');
      return activeEngine.updateCell(table, rowId, column, value);
    },

    async insertRow(table: string, data: Record<string, CellValue>): Promise<RecordId | undefined> {
      if (!activeEngine) throw new Error('No database initialized');
      return activeEngine.insertRow(table, data);
    },

    async deleteRows(table: string, rowIds: RecordId[]): Promise<void> {
      if (!activeEngine) throw new Error('No database initialized');
      return activeEngine.deleteRows(table, rowIds);
    },

    async deleteColumns(table: string, columns: string[]): Promise<void> {
      if (!activeEngine) throw new Error('No database initialized');
      return activeEngine.deleteColumns(table, columns);
    },

    async createTable(table: string, columns: string[]): Promise<void> {
      if (!activeEngine) throw new Error('No database initialized');
      return activeEngine.createTable(table, columns);
    },

    async updateCellBatch(table: string, updates: CellUpdate[]): Promise<void> {
      if (!activeEngine) throw new Error('No database initialized');
      return activeEngine.updateCellBatch(table, updates);
    },

    async addColumn(table: string, column: string, type: string, defaultValue?: string): Promise<void> {
      if (!activeEngine) throw new Error('No database initialized');
      return activeEngine.addColumn(table, column, type, defaultValue);
    },

    async fetchTableData(table: string, options: TableQueryOptions): Promise<QueryResultSet> {
      if (!activeEngine) throw new Error('No database initialized');
      return activeEngine.fetchTableData(table, options);
    },

    async fetchTableCount(table: string, options: TableCountOptions): Promise<number> {
      if (!activeEngine) throw new Error('No database initialized');
      return activeEngine.fetchTableCount(table, options);
    },

    async fetchSchema(): Promise<SchemaSnapshot> {
      if (!activeEngine) throw new Error('No database initialized');
      return activeEngine.fetchSchema();
    },

    async getTableInfo(table: string): Promise<ColumnMetadata[]> {
      if (!activeEngine) throw new Error('No database initialized');
      return activeEngine.getTableInfo(table);
    },

    async getPragmas(): Promise<Record<string, CellValue>> {
      if (!activeEngine) throw new Error('No database initialized');
      return activeEngine.getPragmas();
    },

    async setPragma(pragma: string, value: CellValue): Promise<void> {
      if (!activeEngine) throw new Error('No database initialized');
      return activeEngine.setPragma(pragma, value);
    },

    async ping(): Promise<boolean> {
      if (!activeEngine) return false;
      return activeEngine.ping();
    }
  };
}
