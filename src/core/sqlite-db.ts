/**
 * SQLite Database Engine Module
 *
 * Provides database operations using sql.js WebAssembly engine.
 * Designed to run in a Worker thread for non-blocking execution.
 */

import type {
  CellValue,
  QueryResultSet,
  ModificationEntry,
  DatabaseInitConfig,
  DatabaseInitResult,
  DatabaseOperations
} from './types';

// ============================================================================
// Internal sql.js Types
// ============================================================================

/**
 * sql.js database instance interface.
 */
interface WasmDatabaseInstance {
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
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
            activeEngine!.discardModifications(mods, sig)
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
    }
  };
}
