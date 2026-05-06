/**
 * SQLite Database Engine Module
 *
 * Slim public surface for the WASM engine. The implementation lives in
 * src/core/engine/wasm/WasmDatabaseEngine.ts; this file owns the factory
 * (createDatabaseEngine) and the worker-side endpoint that wires the
 * RPC dispatcher to the engine instance.
 *
 * WasmDatabaseEngine is re-exported so existing imports
 * (`import { WasmDatabaseEngine } from '.../core/sqlite-db'`) keep working.
 */

import type {
  CellValue,
  RecordId,
  QueryResultSet,
  DatabaseInitConfig,
  DatabaseInitResult,
  CellUpdate,
  TableQueryOptions,
  TableCountOptions,
  SchemaSnapshot,
  ColumnMetadata,
  ColumnDefinition
} from './types';
import { getNodeFs } from './platform/fs';
import {
  WasmDatabaseEngine,
  type WasmDatabaseInstance,
  type WasmEngineModule
} from './engine/wasm/WasmDatabaseEngine';

export { WasmDatabaseEngine } from './engine/wasm/WasmDatabaseEngine';
export { getNodeFs } from './platform/fs';

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

  const SqlJsModule = await loadEngine(engineConfig) as unknown as WasmEngineModule;

  // Create database instance
  let wasmInstance: WasmDatabaseInstance;
  let buffer = config.content;

  // If content is missing but filePath is provided, read from disk (Node.js only)
  if (!buffer && config.filePath) {
      try {
          // Dynamic require to avoid bundling fs in browser builds
          // In actual build, this code path only runs in Node worker
          const fs = getNodeFs();
          if (fs) {
              // Validate size
              const stats = await fs.promises.stat(config.filePath);
              if (config.maxSize > 0 && stats.size > config.maxSize) {
                  throw new Error('File too large');
              }
              buffer = await fs.promises.readFile(config.filePath);
          }
      } catch (e) {
          console.error('Failed to read file in worker:', e);
      }
  }

  if (buffer && buffer.byteLength > 0) {
    // Open existing database from binary
    // Avoid creating an intermediate copy

    const data = (buffer.buffer && buffer.byteLength === buffer.buffer.byteLength)
        ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        : buffer;

    wasmInstance = new SqlJsModule.Database(data);

    // Help GC
    buffer = null;
    config.content = null;
  } else {
    // Create new empty database
    wasmInstance = new SqlJsModule.Database();
  }

  const engine = new WasmDatabaseEngine(wasmInstance, config.queryTimeout);

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
      // Shutdown existing engine if present
      if (activeEngine) {
        activeEngine.shutdown();
      }

      const result = await createDatabaseEngine(config);
      activeEngine = result.operations as WasmDatabaseEngine;

      // Return value is primarily used for isReadOnly flag.
      // The actual database operations are accessed via the worker endpoint methods below.
      return {
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

    async insertRowBatch(table: string, rows: Record<string, CellValue>[]): Promise<void> {
      if (!activeEngine) throw new Error('No database initialized');
      return activeEngine.insertRowBatch(table, rows);
    },

    async deleteRows(table: string, rowIds: RecordId[]): Promise<void> {
      if (!activeEngine) throw new Error('No database initialized');
      return activeEngine.deleteRows(table, rowIds);
    },

    async deleteColumns(table: string, columns: string[], dropDependentIndexes?: string[]): Promise<void> {
      if (!activeEngine) throw new Error('No database initialized');
      return activeEngine.deleteColumns(table, columns, dropDependentIndexes);
    },

    async findDependentIndexes(table: string, columns: string[]): Promise<string[]> {
      if (!activeEngine) throw new Error('No database initialized');
      return activeEngine.findDependentIndexes(table, columns);
    },

    async createTable(table: string, columns: ColumnDefinition[]): Promise<void> {
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
    },

    async writeToFile(path: string): Promise<void> {
      if (!activeEngine) throw new Error('No database initialized');
      return activeEngine.writeToFile(path);
    }
  };
}
