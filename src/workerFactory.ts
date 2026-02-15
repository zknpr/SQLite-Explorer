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

import { connectWorkerPort, buildMethodProxy, Transfer } from './core/rpc';
import { GlobalOutputChannel } from './main';
import type {
  CellValue,
  QueryResultSet,
  ModificationEntry,
  DatabaseOperations,
  DatabaseInitConfig,
  DatabaseInitResult,
  CellUpdate,
  ColumnDefinition
} from './core/types';

import { Worker } from './platform/threadPool';
import type { DatabaseConnectionBundle } from './connectionTypes';
import { ConfigurationSection } from './config';

// Native worker support (only in Node.js environment)
let nativeSupport: {
  isNativeAvailable: (path: string) => Promise<boolean>;
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
  return sizeMB * (2 ** 20);
}

/** Default query timeout in milliseconds (30 seconds) */
const DEFAULT_QUERY_TIMEOUT_MS = 30000;

/**
 * Retrieve query timeout from user configuration.
 *
 * @returns Query timeout in milliseconds
 */
export function getQueryTimeout(): number {
  const config = vsc.workspace.getConfiguration(ConfigurationSection);
  return config.get<number>('queryTimeout', DEFAULT_QUERY_TIMEOUT_MS);
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
  deleteColumns(table: string, columns: string[], dropDependentIndexes?: string[]): Promise<void>;
  findDependentIndexes(table: string, columns: string[]): Promise<string[]>;
  createTable(table: string, columns: ColumnDefinition[]): Promise<void>;
  updateCellBatch(table: string, updates: CellUpdate[]): Promise<void>;
  addColumn(table: string, column: string, type: string, defaultValue?: string): Promise<void>;
  fetchTableData(table: string, options: any): Promise<any>;
  fetchTableCount(table: string, options: any): Promise<number>;
  fetchSchema(): Promise<any>;
  getTableInfo(table: string): Promise<any>;
  getPragmas(): Promise<Record<string, CellValue>>;
  setPragma(pragma: string, value: CellValue): Promise<void>;
  ping(): Promise<boolean>;
  writeToFile(path: string): Promise<void>;
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
    if (await nativeSupport.isNativeAvailable(extensionPath)) {
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
  // Spawn worker thread
  // Browser: Web Workers can't load from vscode-vfs:// URIs directly.
  // Use fetch to load the worker script as a Blob and create a Blob URL.
  // Node.js: Use require path directly.
  let workerThread: InstanceType<typeof Worker>;

  if (import.meta.env.VSCODE_BROWSER_EXT) {
    // Browser environment: fetch worker script and create Blob URL
    const workerScriptUri = vsc.Uri.joinPath(extensionUri, 'out', 'worker-browser.js');
    const workerContent = await vsc.workspace.fs.readFile(workerScriptUri);
    const blob = new Blob([workerContent], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    workerThread = new Worker(blobUrl);
  } else {
    // Node.js environment: use file path directly
    const workerScriptPath = path.resolve(__dirname, './worker.cjs');
    workerThread = new Worker(workerScriptPath);
  }

  // Create IPC proxy for worker communication
  // Browser Workers use addEventListener, Node.js Workers use .on()
  // Route worker log messages to the VS Code output channel for visibility.
  // Falls back to console if no output channel is available (e.g., during tests).
  const logHandler = (level: 'log' | 'warn' | 'error', args: unknown[]) => {
    const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    if (GlobalOutputChannel) {
      GlobalOutputChannel.appendLine(`[Worker/${level}] ${text}`);
    } else {
      console[level]('[Worker]', ...args);
    }
  };

  const workerProxy = connectWorkerPort<WorkerMethods>(
    {
      postMessage: (data: unknown, transfer?: Transferable[]) => {
        if (transfer) {
          workerThread.postMessage(data, transfer);
        } else {
          workerThread.postMessage(data);
        }
      },
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
    ['initializeDatabase', 'runQuery', 'exportDatabase', 'updateCell', 'insertRow', 'deleteRows', 'deleteColumns', 'findDependentIndexes', 'createTable', 'updateCellBatch', 'addColumn', 'fetchTableData', 'fetchTableCount', 'fetchSchema', 'getTableInfo', 'getPragmas', 'setPragma', 'ping', 'writeToFile'],
    logHandler
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
      try {
        // Read database and WAL files
        // Optimization: If running in Node and file is local, pass path to worker instead of reading content here
        // This avoids blocking the extension host and transferring large buffers
        const isNode = !import.meta.env.VSCODE_BROWSER_EXT;
        const isLocal = fileUri.scheme === 'file';

        let dbContent: Uint8Array | null = null;
        let walContent: Uint8Array | null = null;
        let filePath: string | undefined;

        if (isNode && isLocal) {
            // Check size limit first
            const maxSize = getMaximumFileSizeBytes();
            const fileStat = await vsc.workspace.fs.stat(fileUri);
            if (maxSize !== 0 && fileStat.size > maxSize) {
               throw new Error(`File size (${(fileStat.size / (1024 * 1024)).toFixed(2)} MB) exceeds the maximum allowed size (${(maxSize / (1024 * 1024)).toFixed(2)} MB). Configure 'sqliteExplorer.maxFileSize' to increase the limit.`);
            } else {
               filePath = fileUri.fsPath;
            }
        } else {
            [dbContent, walContent] = await loadDatabaseFiles(fileUri);
        }

        // Load WASM binary from assets directory
        const wasmUri = vsc.Uri.joinPath(extensionUri, 'assets', 'sqlite3.wasm');
        const wasmContent = await vsc.workspace.fs.readFile(wasmUri);

        // Initialize database configuration
        const initConfig: DatabaseInitConfig = {
          content: dbContent,
          filePath,
          walContent,
          maxSize: getMaximumFileSizeBytes(),
          resourceMap: {},
          wasmBinary: wasmContent,
          readOnlyMode: forceReadOnly ?? false,
          queryTimeout: getQueryTimeout()
        };

        // Initialize database in worker
        // Use Transfer wrapper to zero-copy transfer the array buffers
        const transferables: Transferable[] = [];
        if (initConfig.content && initConfig.content.buffer) {
            transferables.push(initConfig.content.buffer);
        }
        if (initConfig.walContent && initConfig.walContent.buffer) {
            transferables.push(initConfig.walContent.buffer);
        }
        if (initConfig.wasmBinary && initConfig.wasmBinary.buffer) {
            transferables.push(initConfig.wasmBinary.buffer);
        }

        const result = await workerProxy.initializeDatabase(
            displayName,
            new Transfer(initConfig, transferables) as unknown as DatabaseInitConfig
        );

        // Create operations facade that routes to worker
        // Helper: Wrap Uint8Array values in Transfer for zero-copy transfer to worker
        // This significantly improves performance for blob operations by avoiding buffer copying
        const wrapForTransfer = (value: CellValue): CellValue => {
          if (value instanceof Uint8Array && value.buffer) {
            return new Transfer(value, [value.buffer]) as unknown as CellValue;
          }
          return value;
        };

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
            workerProxy.updateCell(table, rowId, column, wrapForTransfer(value)),
          insertRow: (table: string, data: Record<string, CellValue>) => {
            // Wrap any Uint8Array values in the data object for zero-copy transfer
            const wrappedData: Record<string, CellValue> = {};
            for (const key of Object.keys(data)) {
              wrappedData[key] = wrapForTransfer(data[key]);
            }
            return workerProxy.insertRow(table, wrappedData);
          },
          deleteRows: (table: string, rowIds: (string | number)[]) =>
            workerProxy.deleteRows(table, rowIds),
          deleteColumns: (table: string, columns: string[], dropDependentIndexes?: string[]) =>
            workerProxy.deleteColumns(table, columns, dropDependentIndexes),
          findDependentIndexes: (table: string, columns: string[]) =>
            workerProxy.findDependentIndexes(table, columns),
          createTable: (table: string, columns: ColumnDefinition[]) =>
            workerProxy.createTable(table, columns),
          updateCellBatch: (table: string, updates: CellUpdate[]) => {
            // Wrap any Uint8Array values in updates for zero-copy transfer
            const wrappedUpdates = updates.map(u => ({
              ...u,
              value: wrapForTransfer(u.value)
            }));
            return workerProxy.updateCellBatch(table, wrappedUpdates);
          },
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
          getPragmas: () =>
            workerProxy.getPragmas(),
          setPragma: (pragma: string, value: CellValue) =>
            workerProxy.setPragma(pragma, value),
          ping: () =>
            workerProxy.ping(),
          writeToFile: (path: string) =>
            workerProxy.writeToFile(path)
        };

        return {
          databaseOps: operationsFacade,
          isReadOnly: result.isReadOnly ?? false
        };
      } catch (err) {
        // Terminate worker on connection failure to prevent leak
        terminateWorker();
        throw err;
      }
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
    throw new Error(`File size (${(fileStat.size / (1024 * 1024)).toFixed(2)} MB) exceeds the maximum allowed size (${(maxSize / (1024 * 1024)).toFixed(2)} MB). Configure 'sqliteExplorer.maxFileSize' to increase the limit.`);
  }

  // Construct WAL file URI
  const walUri = uri.with({ path: uri.path + '-wal' });

  // Read both files concurrently
  return Promise.all([
    vsc.workspace.fs.readFile(uri),
    Promise.resolve(vsc.workspace.fs.readFile(walUri)).catch(() => null)
  ]);
}
