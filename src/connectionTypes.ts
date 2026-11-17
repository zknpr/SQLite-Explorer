/**
 * Database Connection Bundle Types
 *
 * Defines interfaces for database connection management.
 * Abstracts over worker creation and communication.
 */

import type { Event, Uri } from 'vscode';
import type { DatabaseConnectionInvalidatedError } from './core/database-connection-invalidated';
import type { DatabaseOperations, CellValue, QueryResultSet, DatabaseInitConfig, DatabaseInitResult } from './core/types';
import type { ModuleCheckResult } from './core/virtual-table-modules';

// ============================================================================
// Connection Bundle Interface
// ============================================================================

/**
 * Database connection bundle.
 *
 * Provides methods for:
 * - Accessing worker thread methods
 * - Establishing database connections
 */
export interface EstablishedDatabaseConnection {
  databaseOps: DatabaseOperations;
  isReadOnly?: boolean;
  storage?: DatabaseInitResult['storage'];
  /** Terminal loss of native connection state; recovery requires an explicit reload. */
  onDidInvalidate?: Event<DatabaseConnectionInvalidatedError>;
  /**
   * Native only: the main-schema virtual tables whose module, one of
   * `modules`, this engine lacks (core/virtual-table-modules.ts). The factory
   * calls it once, right after the open, to pick the engine.
   */
  findTablesWithMissingModules?(modules: readonly string[]): Promise<ModuleCheckResult>;
  /**
   * Native only: release the database's file locks before the connection is
   * given up. The worker closes the database, which also removes the -wal
   * and -shm its open created; when closing would checkpoint a -wal that was
   * there before or holds changes, the worker is killed instead and this
   * resolves once its process is gone.
   */
  closeDatabase?(): Promise<void>;
}

export interface DatabaseConnectionBundle {
  /**
   * Proxy to worker thread methods.
   * Includes dispose symbol for cleanup.
   */
  workerMethods: {
    initializeDatabase: (filename: string, config: DatabaseInitConfig) => Promise<DatabaseInitResult>;
    runQuery: (
      sql: string,
      params?: CellValue[],
      cancellationFlag?: Int32Array
    ) => Promise<QueryResultSet[]>;
    exportDatabase: () => Promise<Uint8Array>;
    [Symbol.dispose]: () => void;
  };

  /**
   * Establish a connection to a database file.
   *
   * @param fileUri - URI of the database file
   * @param displayName - Filename for display purposes
   * @param forceReadOnly - Whether to open in read-only mode
   * @param autoCommit - Whether to auto-commit changes
   * @param backupEngine - For a hot-exit restore, the engine its backup was
   *   written on. Native has already written the backup's unsaved edits to the
   *   file and WebAssembly replays them, so the restore reopens that engine.
   * @returns Database operations handle and read-only flag
   */
  establishConnection(
    fileUri: Uri,
    displayName: string,
    forceReadOnly?: boolean,
    autoCommit?: boolean,
    backupEngine?: 'native' | 'wasm'
  ): EstablishedDatabaseConnection | PromiseLike<EstablishedDatabaseConnection>;
}
