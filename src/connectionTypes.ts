/**
 * Database Connection Bundle Types
 *
 * Defines interfaces for database connection management.
 * Abstracts over worker creation and communication.
 */

import type { Uri } from 'vscode';
import type { DatabaseOperations } from './core/types';

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Type that may be a value or a promise.
 */
export type MaybeAsync<T> = T | PromiseLike<T>;

/**
 * Interface for terminating worker threads.
 */
export interface Terminable {
  terminate(): void;
}

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
export interface DatabaseConnectionBundle {
  /**
   * Proxy to worker thread methods.
   * Includes dispose symbol for cleanup.
   */
  workerMethods: {
    initializeDatabase: (...args: unknown[]) => Promise<unknown>;
    runQuery: (...args: unknown[]) => Promise<unknown>;
    exportDatabase: (...args: unknown[]) => Promise<unknown>;
    [Symbol.dispose]: () => void;
  };

  /**
   * Establish a connection to a database file.
   *
   * @param fileUri - URI of the database file
   * @param displayName - Filename for display purposes
   * @param forceReadOnly - Whether to open in read-only mode
   * @param autoCommit - Whether to auto-commit changes
   * @returns Database operations handle and read-only flag
   */
  establishConnection(
    fileUri: Uri,
    displayName: string,
    forceReadOnly?: boolean,
    autoCommit?: boolean
  ): MaybeAsync<{
    databaseOps: DatabaseOperations;
    isReadOnly?: boolean;
  }>;
}
