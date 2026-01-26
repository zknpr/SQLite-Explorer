/**
 * Worker Thread Factory Module
 *
 * Creates and configures Worker threads for database operations.
 * Provides the bridge between extension host and worker thread.
 *
 * Supports two backends:
 * - Native: txiki-js with native SQLite (faster, desktop only)
 * - WASM: sql.js WebAssembly (works everywhere, including browser)
 */

import type { TelemetryReporter } from '@vscode/extension-telemetry';

import * as vsc from 'vscode';
import path from 'path';

import { connectWorkerPort, buildMethodProxy } from './core/rpc';
import type {
  CellValue,
  QueryResultSet,
  ModificationEntry,
  DatabaseOperations,
  DatabaseInitConfig,
  DatabaseInitResult,
  CellUpdate
} from './core/types';

import { Worker } from './platform/threadPool';
import type { DatabaseConnectionBundle } from './connectionTypes';
import { ConfigurationSection } from './config';

// Native worker support (only in Node.js environment)
let nativeSupport: {
  isNativeAvailable: (path: string) => boolean;
  createNativeDatabaseConnection: typeof import('./nativeWorker').createNativeDatabaseConnection;
} | null = null;

// Dynamically import native worker in Node.js environment
if (!import.meta.env.VSCODE_BROWSER_EXT) {
  try {
    // Use dynamic import for native worker
    nativeSupport = require('./nativeWorker');
  } catch {
    // Native worker not available
  }
}

// ============================================================================
// Constants
// ============================================================================

/** Megabyte constant for file size calculations */
export const MEGABYTE = 2 ** 20;

// ============================================================================
// Configuration
// ============================================================================

/**
 * Retrieve maximum file size from user configuration.
 *
 * @returns Maximum size in bytes (0 = unlimited)
 */
export function getMaximumFileSizeBytes(): number {
  const config = vsc.workspace.getConfiguration(ConfigurationSection);
  const sizeMB = config.get<number>('maxFileSize') ?? 200;
  return sizeMB * MEGABYTE;
}

// ============================================================================
// Worker Interface Types
// ============================================================================

/**
 * Methods exposed by the database worker.
 */
interface WorkerMethods {
  initializeDatabase(
    filename: string,
    config: DatabaseInitConfig
  ): Promise<DatabaseInitResult>;
  runQuery(sql: string, params?: CellValue[]): Promise<QueryResultSet[]>;
  exportDatabase(name: string): Promise<Uint8Array>;
  updateCell(table: string, rowId: string | number, column: string, value: CellValue): Promise<void>;
  insertRow(table: string, data: Record<string, CellValue>): Promise<string | number | undefined>;
  deleteRows(table: string, rowIds: (string | number)[]): Promise<void>;
  deleteColumns(table: string, columns: string[]): Promise<void>;
  createTable(table: string, columns: string[]): Promise<void>;
  updateCellBatch(table: string, updates: CellUpdate[]): Promise<void>;
  addColumn(table: string, column: string, type: string, defaultValue?: string): Promise<void>;
  fetchTableData(table: string, options: any): Promise<any>;
  fetchTableCount(table: string, options: any): Promise<number>;
  fetchSchema(): Promise<any>;
  getTableInfo(table: string): Promise<any>;
  ping(): Promise<boolean>;
}

// ============================================================================
// Worker Factory
// ============================================================================

/**
 * Create a database connection bundle.
 *
 * Attempts to use native SQLite (txiki-js) for better performance.
 * Falls back to sql.js (WebAssembly) when native is unavailable or fails.
 *
 * IMPORTANT: The fallback to WASM happens at bundle creation time. If native
 * backend creation succeeds but file open fails later (e.g., due to macOS
 * sandboxing), we wrap the native bundle to catch those errors and create
 * a hybrid that can fall back at connection time.
 *
 * @param extensionUri - Extension installation directory URI
 * @param _reporter - Optional telemetry reporter
 * @returns Connection bundle with worker methods
 */
export async function createDatabaseConnection(
  extensionUri: vsc.Uri,
  _reporter?: TelemetryReporter
): Promise<DatabaseConnectionBundle> {
  // Try native SQLite first (desktop Node.js only)
  if (!import.meta.env.VSCODE_BROWSER_EXT && nativeSupport) {
    const extensionPath = extensionUri.fsPath;
    if (nativeSupport.isNativeAvailable(extensionPath)) {
      try {
        console.log('[SQLite Explorer] Using native SQLite backend');
        const nativeBundle = await nativeSupport.createNativeDatabaseConnection(extensionUri, _reporter);

        // Wrap the native bundle to provide fallback to WASM if file open fails
        // This handles cases where native SQLite can't access a specific file
        // (e.g., macOS sandboxing, permission issues, file locked)
        const wasmBundlePromise = createWasmDatabaseConnection(extensionUri, _reporter);
        let wasmBundle: DatabaseConnectionBundle | null = null;

        return {
          workerMethods: nativeBundle.workerMethods,
          async establishConnection(fileUri, displayName, forceReadOnly, autoCommit) {
            try {
              // Try native first
              return await nativeBundle.establishConnection(fileUri, displayName, forceReadOnly, autoCommit);
            } catch (nativeErr) {
              // Native failed - fall back to WASM
              console.warn('[SQLite Explorer] Native file open failed, falling back to WASM:', nativeErr);
              if (!wasmBundle) {
                wasmBundle = await wasmBundlePromise;
              }
              return wasmBundle.establishConnection(fileUri, displayName, forceReadOnly, autoCommit);
            }
          }
        };
      } catch (err) {
        console.warn('[SQLite Explorer] Native SQLite failed, falling back to WASM:', err);
      }
    }
  }

  // Fall back to WASM (sql.js)
  console.log('[SQLite Explorer] Using WebAssembly SQLite backend');
  return createWasmDatabaseConnection(extensionUri, _reporter);
}

/**
 * Create a database connection using sql.js (WebAssembly).
 *
 * The worker runs sql.js in a separate thread to prevent
 * blocking the main extension host during database operations.
 *
 * @param extensionUri - Extension installation directory URI
 * @param _reporter - Optional telemetry reporter
 * @returns Connection bundle with worker methods
 */
async function createWasmDatabaseConnection(
  extensionUri: vsc.Uri,
  _reporter?: TelemetryReporter
): Promise<DatabaseConnectionBundle> {
  // Determine worker script path based on environment
  const workerScriptPath = import.meta.env.VSCODE_BROWSER_EXT
    ? vsc.Uri.joinPath(extensionUri, 'out', 'worker-browser.js').toString()
    : path.resolve(__dirname, './worker.cjs');

  // Spawn worker thread
  const workerThread = new Worker(workerScriptPath);

  // Create IPC proxy for worker communication
  // Browser Workers use addEventListener, Node.js Workers use .on()
  const workerProxy = connectWorkerPort<WorkerMethods>(
    {
      postMessage: (data: unknown) => workerThread.postMessage(data),
      on: (event: 'message', handler: (data: unknown) => void) => {
        if (import.meta.env.VSCODE_BROWSER_EXT) {
          // Browser: Web Worker uses addEventListener with MessageEvent wrapper
          workerThread.addEventListener(event, (e: MessageEvent) => handler(e.data));
        } else {
          // Node.js: worker_threads uses .on() with direct data
          (workerThread as unknown as { on(event: string, handler: (data: unknown) => void): void })
            .on(event, handler);
        }
      }
    },
    ['initializeDatabase', 'runQuery', 'exportDatabase', 'updateCell', 'insertRow', 'deleteRows', 'deleteColumns', 'createTable', 'updateCellBatch', 'addColumn', 'fetchTableData', 'fetchTableCount', 'fetchSchema', 'getTableInfo', 'ping']
  );

  // Termination handler
  const terminateWorker = () => {
    workerThread.terminate();
  };

  return {
    workerMethods: {
      ...workerProxy,
      [Symbol.dispose]: terminateWorker
    },

    /**
     * Establish a database connection through the worker.
     *
     * @param fileUri - Database file URI
     * @param displayName - Filename for display
     * @param forceReadOnly - Open in read-only mode
     * @param autoCommit - Commit changes immediately
     * @returns Database handle and read-only status
     */
    async establishConnection(
      fileUri: vsc.Uri,
      displayName: string,
      forceReadOnly?: boolean,
      autoCommit?: boolean
    ) {
      // Read database and WAL files
      const [dbContent, walContent] = await loadDatabaseFiles(fileUri);

      // Load WASM binary from assets directory
      const wasmUri = vsc.Uri.joinPath(extensionUri, 'assets', 'sqlite3.wasm');
      const wasmContent = await vsc.workspace.fs.readFile(wasmUri);

      // Initialize database configuration
      const initConfig: DatabaseInitConfig = {
        content: dbContent,
        walContent,
        maxSize: getMaximumFileSizeBytes(),
        resourceMap: {},
        wasmBinary: wasmContent,
        readOnlyMode: forceReadOnly ?? false
      };

      // Initialize database in worker
      const result = await workerProxy.initializeDatabase(displayName, initConfig);

      // Create operations facade that routes to worker
      const operationsFacade: DatabaseOperations = {
        engineKind: Promise.resolve('wasm'),
        executeQuery: (sql: string, params?: CellValue[]) =>
          workerProxy.runQuery(sql, params),
        serializeDatabase: (name: string) => workerProxy.exportDatabase(name),
        applyModifications: async () => {},
        undoModification: async () => {},
        redoModification: async () => {},
        flushChanges: async () => {},
        discardModifications: async () => {},
        updateCell: (table: string, rowId: string | number, column: string, value: CellValue) =>
          workerProxy.updateCell(table, rowId, column, value),
        insertRow: (table: string, data: Record<string, CellValue>) =>
          workerProxy.insertRow(table, data),
        deleteRows: (table: string, rowIds: (string | number)[]) =>
          workerProxy.deleteRows(table, rowIds),
        deleteColumns: (table: string, columns: string[]) =>
          workerProxy.deleteColumns(table, columns),
        createTable: (table: string, columns: string[]) =>
          workerProxy.createTable(table, columns),
        updateCellBatch: (table: string, updates: CellUpdate[]) =>
          workerProxy.updateCellBatch(table, updates),
        addColumn: (table: string, column: string, type: string, defaultValue?: string) =>
          workerProxy.addColumn(table, column, type, defaultValue),
        fetchTableData: (table: string, options: any) =>
          workerProxy.fetchTableData(table, options),
        fetchTableCount: (table: string, options: any) =>
          workerProxy.fetchTableCount(table, options),
        fetchSchema: () =>
          workerProxy.fetchSchema(),
        getTableInfo: (table: string) =>
          workerProxy.getTableInfo(table),
        ping: () =>
          workerProxy.ping()
      };

      return {
        databaseOps: operationsFacade,
        isReadOnly: result.isReadOnly ?? false
      };
    }
  };
}

// ============================================================================
// File Loading
// ============================================================================

/**
 * Load database file and optional WAL file.
 *
 * @param uri - Database file URI
 * @returns Tuple of [database content, WAL content]
 */
async function loadDatabaseFiles(
  uri: vsc.Uri
): Promise<[Uint8Array | null, Uint8Array | null]> {
  // Untitled documents start empty
  if (uri.scheme === 'untitled') {
    return [new Uint8Array(), null];
  }

  const maxSize = getMaximumFileSizeBytes();

  // Check file size
  const fileStat = await Promise.resolve(vsc.workspace.fs.stat(uri)).catch(() => ({ size: 0 }));
  if (maxSize !== 0 && fileStat.size > maxSize) {
    // File exceeds size limit
    return [null, null];
  }

  // Construct WAL file URI
  const walUri = uri.with({ path: uri.path + '-wal' });

  // Read both files concurrently
  return Promise.all([
    vsc.workspace.fs.readFile(uri),
    Promise.resolve(vsc.workspace.fs.readFile(walUri)).catch(() => null)
  ]);
}
