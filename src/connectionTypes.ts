/**
 * Database Connection Bundle Types
 *
 * Defines interfaces for database connection management.
 * Abstracts over worker creation and communication.
 */

import type { Uri } from 'vscode';
import type { DatabaseOperations } from './core/types';

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
    initializeDatabase: (...args: any[]) => Promise<unknown>;
    runQuery: (...args: any[]) => Promise<unknown>;
    exportDatabase: (...args: any[]) => Promise<unknown>;
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
  ): {
    databaseOps: DatabaseOperations;
    isReadOnly?: boolean;
  } | PromiseLike<{
    databaseOps: DatabaseOperations;
    isReadOnly?: boolean;
  }>;
}
