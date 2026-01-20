/**
 * Database Handler Module
 *
 * Provides SQLite database operations using sql.js WebAssembly.
 * Handles query execution, data export, and database lifecycle.
 */

// Value types supported by SQLite
export type DatabaseValue = string | number | null | Uint8Array;
export type RecordIdentifier = string | number;

// Query execution result structure
export interface ExecutionResult {
  columnNames: string[];
  records: DatabaseValue[][];
}

// Edit tracking for undo functionality
export interface ModificationRecord {
  description: string;
  operation: 'modify' | 'add' | 'remove' | 'create' | 'alter' | 'drop';
  targetTable?: string;
  targetRecord?: RecordIdentifier;
  targetColumn?: string;
  previousValue?: DatabaseValue;
  updatedValue?: DatabaseValue;
  queryText?: string;
  affectedRecords?: RecordIdentifier[];
}

// Database handler interface
export interface DatabaseHandler {
  readonly engineType: Promise<'wasm'>;
  runQuery(queryText: string, parameters?: DatabaseValue[]): Promise<ExecutionResult[]>;
  getDataBlob(name: string): Promise<Uint8Array>;
  processModifications(modifications: ModificationRecord[], signal?: AbortSignal): Promise<void>;
  revertModification(modification: ModificationRecord): Promise<void>;
  reapplyModification(modification: ModificationRecord): Promise<void>;
  persistChanges(signal?: AbortSignal): Promise<void>;
  discardChanges(modifications: ModificationRecord[], signal?: AbortSignal): Promise<void>;
}

// Configuration for database initialization
export interface DatabaseConfig {
  binaryData: Uint8Array | null;
  walBinaryData?: Uint8Array | null;
  sizeLimit: number;
  resourcePaths?: Record<string, string>;
  wasmModule?: Uint8Array;
  isReadOnly?: boolean;
}

// Result from database initialization
export interface InitializationResult {
  handler: DatabaseHandler;
  isReadOnly: boolean;
}

// Internal sql.js database type
interface SqlJsInstance {
  run(sql: string, params?: any[]): { columns: string[]; values: any[][] }[];
  save(): Uint8Array;
  shutdown(): void;
}

// sql.js module loader type
interface SqlJsLoader {
  Instance: new (data?: ArrayLike<number>) => SqlJsInstance;
}

/**
 * SQLite database wrapper implementation.
 * Wraps sql.js and provides a clean interface for database operations.
 */
class SqliteDatabaseHandler implements DatabaseHandler {
  private instance: SqlJsInstance;
  readonly engineType = Promise.resolve('wasm' as const);

  constructor(instance: SqlJsInstance) {
    this.instance = instance;
  }

  /**
   * Execute a SQL query and return structured results.
   */
  async runQuery(queryText: string, parameters?: DatabaseValue[]): Promise<ExecutionResult[]> {
    try {
      const rawResults = this.instance.run(queryText, parameters);
      return rawResults.map(result => ({
        columnNames: result.columns,
        records: result.values
      }));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`Query execution failed: ${errorMsg}`);
    }
  }

  /**
   * Export database to binary format for saving.
   */
  async getDataBlob(_name: string): Promise<Uint8Array> {
    return this.instance.save();
  }

  /**
   * Apply modifications - currently no-op as changes are immediate.
   */
  async processModifications(_modifications: ModificationRecord[], _signal?: AbortSignal): Promise<void> {
    // Modifications are applied immediately via runQuery
  }

  /**
   * Revert a modification - handled at extension level.
   */
  async revertModification(_modification: ModificationRecord): Promise<void> {
    // Revert logic handled by extension undo system
  }

  /**
   * Reapply a modification - handled at extension level.
   */
  async reapplyModification(_modification: ModificationRecord): Promise<void> {
    // Reapply logic handled by extension redo system
  }

  /**
   * Persist changes - no-op for in-memory database.
   * Actual persistence happens via getDataBlob + file write.
   */
  async persistChanges(_signal?: AbortSignal): Promise<void> {
    // In-memory database - persistence handled externally
  }

  /**
   * Discard changes - handled at extension level.
   */
  async discardChanges(_modifications: ModificationRecord[], _signal?: AbortSignal): Promise<void> {
    // Discard logic handled by extension revert system
  }

  /**
   * Release database resources.
   */
  shutdown(): void {
    this.instance.shutdown();
  }
}

/**
 * Initialize sql.js and create database handler.
 */
export async function initializeDatabase(config: DatabaseConfig): Promise<InitializationResult> {
  // Dynamic import of sql.js
  const loadSqlJs = (await import('sql.js')).default;

  const initConfig: any = {};
  if (config.wasmModule && config.wasmModule.byteLength > 0) {
    initConfig.wasmBinary = config.wasmModule;
  } else if (config.resourcePaths?.['sqlite3.wasm']) {
    initConfig.locateFile = () => config.resourcePaths!['sqlite3.wasm'];
  }

  const SqlJs = await loadSqlJs(initConfig);

  let instance: SqlJsInstance;
  if (config.binaryData && config.binaryData.byteLength > 0) {
    instance = new SqlJs.Instance(new Uint8Array(config.binaryData));
  } else {
    instance = new SqlJs.Instance();
  }

  const handler = new SqliteDatabaseHandler(instance);

  return {
    handler,
    isReadOnly: config.isReadOnly ?? false
  };
}

/**
 * Factory for creating database handlers in worker context.
 */
export function createDatabaseFactory() {
  let activeHandler: SqliteDatabaseHandler | null = null;

  return {
    async loadDatabase(filename: string, config: DatabaseConfig): Promise<InitializationResult> {
      console.log('DatabaseFactory: Loading database', { filename });

      if (activeHandler) {
        activeHandler.shutdown();
      }

      const result = await initializeDatabase(config);
      activeHandler = result.handler as SqliteDatabaseHandler;

      // Return proxy with bound methods
      return {
        handler: {
          engineType: Promise.resolve('wasm'),
          runQuery: (sql: string, params?: DatabaseValue[]) => activeHandler!.runQuery(sql, params),
          getDataBlob: (name: string) => activeHandler!.getDataBlob(name),
          processModifications: (mods: ModificationRecord[], sig?: AbortSignal) => activeHandler!.processModifications(mods, sig),
          revertModification: (mod: ModificationRecord) => activeHandler!.revertModification(mod),
          reapplyModification: (mod: ModificationRecord) => activeHandler!.reapplyModification(mod),
          persistChanges: (sig?: AbortSignal) => activeHandler!.persistChanges(sig),
          discardChanges: (mods: ModificationRecord[], sig?: AbortSignal) => activeHandler!.discardChanges(mods, sig),
        },
        isReadOnly: result.isReadOnly
      };
    },

    async executeQuery(sql: string, params?: DatabaseValue[]): Promise<ExecutionResult[]> {
      if (!activeHandler) throw new Error('No database loaded');
      return activeHandler.runQuery(sql, params);
    },

    async exportDatabase(name: string): Promise<Uint8Array> {
      if (!activeHandler) throw new Error('No database loaded');
      return activeHandler.getDataBlob(name);
    }
  };
}
