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

import {
  connectWorkerPort,
  DEFAULT_INVOCATION_TIMEOUT_MS,
  Transfer
} from './core/rpc';
import { serializeOperations } from './core/operation-serializer';
import { GlobalOutputChannel } from './main';
import type {
  CellValue,
  QueryResultSet,
  ModificationEntry,
  DatabaseOperations,
  DatabaseInitConfig,
  DatabaseInitResult,
  CellUpdate,
  ColumnDefinition,
  TableQueryOptions,
  TableCountOptions,
  SchemaSnapshot,
  ColumnMetadata,
  ViewDefinition,
  ViewDefinitionIntent,
  ViewEditResult,
  ViewTriggerDefinition
} from './core/types';

import { Worker } from './platform/threadPool';
import type { DatabaseConnectionBundle } from './connectionTypes';
import { getMaximumFileSizeBytes, getQueryTimeout } from './config';
import { createWorkerEndpoint } from './core/sqlite-db';

// Native worker support (only in Node.js environment)
let nativeSupport: {
  isNativeAvailable: (path: string) => Promise<boolean>;
  createNativeDatabaseConnection: typeof import('./nativeWorker').createNativeDatabaseConnection;
} | null = null;

// Dynamically import native worker in Node.js environment
if (!import.meta.env?.VSCODE_BROWSER_EXT) {
  try {
    // Use dynamic import for native worker
    nativeSupport = require('./nativeWorker');
  } catch {
    // Native worker not available
  }
}

// ============================================================================
// Worker Interface Types
// ============================================================================

/**
 * Methods exposed by the database worker.
 *
 * Keep every parameter structured-cloneable. AbortSignal is deliberately not
 * part of this RPC contract: worker_threads clones it into a plain object, so
 * cancellation is checked in the host facade before dispatch instead.
 */
interface WorkerMethods {
  initializeDatabase(
    filename: string,
    config: DatabaseInitConfig
  ): Promise<DatabaseInitResult>;
  runQuery(sql: string, params?: CellValue[]): Promise<QueryResultSet[]>;
  exportDatabase(): Promise<Uint8Array>;
  applyModifications(mods: ModificationEntry[]): Promise<void>;
  undoModification(mod: ModificationEntry): Promise<void>;
  redoModification(mod: ModificationEntry): Promise<void>;
  flushChanges(): Promise<void>;
  discardModifications(mods: ModificationEntry[]): Promise<void>;
  updateCell(table: string, rowId: string | number, column: string, value: CellValue, patch?: string): Promise<void>;
  insertRow(table: string, data: Record<string, CellValue>): Promise<string | number | undefined>;
  insertRowBatch(table: string, rows: Record<string, CellValue>[]): Promise<void>;
  deleteRows(table: string, rowIds: (string | number)[]): Promise<void>;
  deleteColumns(table: string, columns: string[], dropDependentIndexes?: string[]): Promise<void>;
  findDependentIndexes(table: string, columns: string[]): Promise<string[]>;
  createTable(table: string, columns: ColumnDefinition[]): Promise<void>;
  getViewDefinition(view: string): Promise<ViewDefinition>;
  validateViewDefinition(
    view: string,
    selectSql: string,
    intent?: ViewDefinitionIntent
  ): Promise<void>;
  previewViewDefinition(
    view: string,
    selectSql: string,
    limit?: number,
    intent?: ViewDefinitionIntent
  ): Promise<QueryResultSet>;
  createView(view: string, selectSql: string): Promise<ViewDefinition>;
  editView(
    view: string,
    selectSql: string,
    preserveTriggers?: boolean,
    expectedSql?: string,
    expectedTriggers?: readonly ViewTriggerDefinition[]
  ): Promise<ViewEditResult>;
  dropView(view: string): Promise<ViewDefinition>;
  updateCellBatch(table: string, updates: CellUpdate[]): Promise<void>;
  addColumn(table: string, column: string, type: string, defaultValue?: string): Promise<void>;
  fetchTableData(table: string, options: TableQueryOptions): Promise<QueryResultSet>;
  fetchTableCount(table: string, options: TableCountOptions): Promise<number>;
  fetchSchema(): Promise<SchemaSnapshot>;
  getTableInfo(table: string): Promise<ColumnMetadata[]>;
  getPragmas(): Promise<Record<string, CellValue>>;
  setPragma(pragma: string, value: CellValue): Promise<void>;
  ping(): Promise<boolean>;
  writeToFile(path: string): Promise<void>;
}

const WORKER_METHOD_NAMES = [
  'initializeDatabase',
  'runQuery',
  'exportDatabase',
  'applyModifications',
  'undoModification',
  'redoModification',
  'flushChanges',
  'discardModifications',
  'updateCell',
  'insertRow',
  'insertRowBatch',
  'deleteRows',
  'deleteColumns',
  'findDependentIndexes',
  'createTable',
  'getViewDefinition',
  'validateViewDefinition',
  'previewViewDefinition',
  'createView',
  'editView',
  'dropView',
  'updateCellBatch',
  'addColumn',
  'fetchTableData',
  'fetchTableCount',
  'fetchSchema',
  'getTableInfo',
  'getPragmas',
  'setPragma',
  'ping',
  'writeToFile'
] as const satisfies ReadonlyArray<keyof WorkerMethods>;

type MissingWorkerMethod = Exclude<keyof WorkerMethods, typeof WORKER_METHOD_NAMES[number]>;
const COMPLETE_WORKER_METHOD_NAMES: [MissingWorkerMethod] extends [never]
  ? typeof WORKER_METHOD_NAMES
  : never = WORKER_METHOD_NAMES;

type WorkerLogLevel = 'log' | 'warn' | 'error';

function formatWorkerLogArgument(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    // Logging must not mask the database failure it is trying to report.
    return String(value);
  }
}

function forwardWorkerLog(level: WorkerLogLevel, args: unknown[]): void {
  const text = args.map(formatWorkerLogArgument).join(' ');
  if (GlobalOutputChannel) {
    GlobalOutputChannel.appendLine(`[Worker/${level}] ${text}`);
  } else {
    console[level]('[Worker]', ...args);
  }
}

/**
 * History batches execute entries serially in the worker. Scale their host RPC
 * deadline with the batch length so a long File Revert cannot time out merely
 * because many individually healthy undo steps share one invocation.
 */
function getWorkerInvocationTimeout(
  methodName: string,
  parameters: readonly unknown[]
): number {
  if (methodName !== 'applyModifications' && methodName !== 'discardModifications') {
    return DEFAULT_INVOCATION_TIMEOUT_MS;
  }

  const modifications = parameters[0];
  const modificationCount = Array.isArray(modifications) ? modifications.length : 1;
  return DEFAULT_INVOCATION_TIMEOUT_MS * Math.max(1, modificationCount);
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
  if (!import.meta.env?.VSCODE_BROWSER_EXT && nativeSupport) {
    const extensionPath = extensionUri.fsPath;
    if (await nativeSupport.isNativeAvailable(extensionPath)) {
      try {
        GlobalOutputChannel?.appendLine('[SQLite Explorer] Using native SQLite backend');
        const nativeBundle = await nativeSupport.createNativeDatabaseConnection(
          extensionUri,
          _reporter,
          GlobalOutputChannel,
          getQueryTimeout()
        );

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
              GlobalOutputChannel?.appendLine(`[SQLite Explorer] Native file open failed, falling back to WASM: ${nativeErr instanceof Error ? nativeErr.message : String(nativeErr)}`);
              if (!wasmBundle) {
                wasmBundle = await wasmBundlePromise;
              }
              return wasmBundle.establishConnection(fileUri, displayName, forceReadOnly, autoCommit);
            }
          }
        };
      } catch (err) {
        GlobalOutputChannel?.appendLine(`[SQLite Explorer] Native SQLite failed, falling back to WASM: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Fall back to WASM (sql.js)
  GlobalOutputChannel?.appendLine('[SQLite Explorer] Using WebAssembly SQLite backend');
  return createWasmDatabaseConnection(extensionUri, _reporter);
}

/**
 * Create a database connection using sql.js (WebAssembly).
 *
 * Browser VS Code runs sql.js in-process to avoid CSP-blocked workers.
 * Desktop VS Code keeps sql.js in a worker thread to avoid blocking the
 * extension host during database operations.
 *
 * @param extensionUri - Extension installation directory URI
 * @param _reporter - Optional telemetry reporter
 * @returns Connection bundle with worker methods
 */
async function createWasmDatabaseConnection(
  extensionUri: vsc.Uri,
  _reporter?: TelemetryReporter
): Promise<DatabaseConnectionBundle> {
  if (import.meta.env?.VSCODE_BROWSER_EXT === true) {
    return createInProcessWasmDatabaseConnection(extensionUri);
  }

  return createWorkerBackedWasmDatabaseConnection(extensionUri);
}

/**
 * Create a browser-safe WASM database connection.
 *
 * VS Code Web enforces Trusted Types (require-trusted-types-for 'script') on the
 * browser extension host with a fixed trusted-types policy allowlist, so
 * `new Worker(blobUrl)` with a plain string URL is blocked ("This document
 * requires 'TrustedScriptURL' assignment") and the worker never starts. (The CSP
 * does allow worker-src 'self' blob:; the blocker is Trusted Types, not
 * worker-src. WebAssembly instantiation is permitted.) This bundle therefore runs
 * the sql.js endpoint directly in the extension host and lets thrown
 * initialization/query errors reject the original operation.
 */
async function createInProcessWasmDatabaseConnection(
  extensionUri: vsc.Uri
): Promise<DatabaseConnectionBundle> {
  // The browser endpoint has no RPC worker envelope to carry engine warnings,
  // so bridge the same logger directly to the extension output channel.
  const endpoint = createWorkerEndpoint((level, ...args) => {
    forwardWorkerLog(level, args);
  });

  return {
    workerMethods: {
      ...endpoint,
      // Free the in-process sql.js WASM heap when the document is disposed.
      // Unlike the Node worker path (which terminates the whole thread), the
      // browser engine lives in the extension host, so closing a database must
      // explicitly shut the engine down or its WASM memory leaks until reload.
      [Symbol.dispose]: () => { endpoint.dispose(); }
    },

    /**
     * Establish a database connection in the browser extension host.
     *
     * The browser path must read binary content through VS Code's workspace
     * filesystem because local file paths are not available in vscode.dev.
     */
    async establishConnection(
      fileUri: vsc.Uri,
      displayName: string,
      forceReadOnly?: boolean,
      autoCommit?: boolean
    ) {
      // Browser mode always reads database bytes through the VS Code filesystem.
      // There is no file-path fast path because the web extension host cannot
      // access local disk paths directly.
      const [dbContent, walContent] = await loadDatabaseFiles(fileUri);
      const hasActiveWal = !!walContent && walContent.byteLength > 0;
      // sql.js opens one main database image and cannot merge a separate WAL
      // file, so browser editing is disabled when committed WAL pages may be
      // absent from the main database bytes that save() would later overwrite.
      const readOnlyMode = (forceReadOnly ?? false) || hasActiveWal;

      // Preload sql.js WASM bytes from the extension assets directory so
      // WebAssembly instantiation does not depend on worker-relative URLs.
      const wasmUri = vsc.Uri.joinPath(extensionUri, 'assets', 'sqlite3.wasm');
      const wasmContent = await vsc.workspace.fs.readFile(wasmUri);

      const initConfig: DatabaseInitConfig = {
        content: dbContent,
        walContent,
        maxSize: getMaximumFileSizeBytes(),
        resourceMap: {},
        wasmBinary: wasmContent,
        readOnlyMode,
        queryTimeout: getQueryTimeout()
      };

      const result = await endpoint.initializeDatabase(displayName, initConfig);

      const operationsFacade: DatabaseOperations = {
        engineKind: Promise.resolve('wasm'),
        executeQuery: (sql: string, params?: CellValue[]) =>
          endpoint.runQuery(sql, params),
        serializeDatabase: () => endpoint.exportDatabase(),
        applyModifications: (mods: ModificationEntry[], signal?: AbortSignal) =>
          endpoint.applyModifications(mods, signal),
        undoModification: (mod: ModificationEntry) =>
          endpoint.undoModification(mod),
        redoModification: (mod: ModificationEntry) =>
          endpoint.redoModification(mod),
        flushChanges: (signal?: AbortSignal) =>
          endpoint.flushChanges(signal),
        discardModifications: (mods: ModificationEntry[], signal?: AbortSignal) =>
          endpoint.discardModifications(mods, signal),
        // Preserve JSON merge patches when the browser facade calls the
        // in-process endpoint directly.
        updateCell: (table: string, rowId: string | number, column: string, value: CellValue, patch?: string) =>
          endpoint.updateCell(table, rowId, column, value, patch),
        insertRow: (table: string, data: Record<string, CellValue>) =>
          endpoint.insertRow(table, data),
        insertRowBatch: (table: string, rows: Record<string, CellValue>[]) =>
          endpoint.insertRowBatch(table, rows),
        deleteRows: (table: string, rowIds: (string | number)[]) =>
          endpoint.deleteRows(table, rowIds),
        deleteColumns: (table: string, columns: string[], dropDependentIndexes?: string[]) =>
          endpoint.deleteColumns(table, columns, dropDependentIndexes),
        findDependentIndexes: (table: string, columns: string[]) =>
          endpoint.findDependentIndexes(table, columns),
        createTable: (table: string, columns: ColumnDefinition[]) =>
          endpoint.createTable(table, columns),
        getViewDefinition: (view: string) =>
          endpoint.getViewDefinition(view),
        validateViewDefinition: (
          view: string,
          selectSql: string,
          intent?: ViewDefinitionIntent
        ) => endpoint.validateViewDefinition(view, selectSql, intent),
        previewViewDefinition: (
          view: string,
          selectSql: string,
          limit?: number,
          intent?: ViewDefinitionIntent
        ) => endpoint.previewViewDefinition(view, selectSql, limit, intent),
        createView: (view: string, selectSql: string) =>
          endpoint.createView(view, selectSql),
        editView: (
          view: string,
          selectSql: string,
          preserveTriggers?: boolean,
          expectedSql?: string,
          expectedTriggers?: readonly ViewTriggerDefinition[]
        ) => endpoint.editView(
          view,
          selectSql,
          preserveTriggers,
          expectedSql,
          expectedTriggers
        ),
        dropView: (view: string) =>
          endpoint.dropView(view),
        updateCellBatch: (table: string, updates: CellUpdate[]) =>
          endpoint.updateCellBatch(table, updates),
        addColumn: (table: string, column: string, type: string, defaultValue?: string) =>
          endpoint.addColumn(table, column, type, defaultValue),
        fetchTableData: (table: string, options: TableQueryOptions) =>
          endpoint.fetchTableData(table, options),
        fetchTableCount: (table: string, options: TableCountOptions) =>
          endpoint.fetchTableCount(table, options),
        fetchSchema: () =>
          endpoint.fetchSchema(),
        getTableInfo: (table: string) =>
          endpoint.getTableInfo(table),
        getPragmas: () =>
          endpoint.getPragmas(),
        setPragma: (pragma: string, value: CellValue) =>
          endpoint.setPragma(pragma, value),
        ping: () =>
          endpoint.ping(),
        writeToFile: (path: string) =>
          endpoint.writeToFile(path)
      };

      return {
        databaseOps: serializeOperations(operationsFacade),
        isReadOnly: result.isReadOnly ?? false
      };
    }
  };
}

/**
 * Create a Node.js WASM database connection backed by worker_threads.
 *
 * Desktop VS Code is not constrained by the browser extension host CSP, so it
 * keeps the existing worker/RPC path to avoid blocking the extension host.
 */
async function createWorkerBackedWasmDatabaseConnection(
  extensionUri: vsc.Uri
): Promise<DatabaseConnectionBundle> {
  // Node.js environment: use file path directly
  const workerScriptPath = path.resolve(__dirname, './worker.cjs');
  const workerThread: InstanceType<typeof Worker> = new Worker(workerScriptPath);

  // Create IPC proxy for Node.js worker communication
  // Route worker log messages to the VS Code output channel for visibility.
  // Falls back to console if no output channel is available (e.g., during tests).
  const workerProxy = connectWorkerPort<WorkerMethods>(
    {
      postMessage: (data: unknown, transfer?: Transferable[]) => {
        if (transfer) {
          // worker_threads.Worker postMessage needs TransferListItem[], but we can pass it via any if necessary or let it be inferred if we cast it. Transferable in DOM is ArrayBuffer | MessagePort | ImageBitmap, which intersects with node's TransferListItem (ArrayBuffer | MessagePort | FileHandle | X509Certificate | Blob) at ArrayBuffer and MessagePort.
          workerThread.postMessage(data, transfer as any);
        } else {
          workerThread.postMessage(data);
        }
      },
      on: (event: 'message', handler: (data: unknown) => void) => {
        // Node.js worker_threads uses .on() with direct message payloads.
        (workerThread as unknown as { on(event: string, handler: (data: unknown) => void): void })
          .on(event, handler);
      }
    },
    COMPLETE_WORKER_METHOD_NAMES,
    forwardWorkerLog,
    getWorkerInvocationTimeout
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
        const isNode = !import.meta.env?.VSCODE_BROWSER_EXT;
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

        // AbortSignal cannot cross worker_threads RPC without losing its
        // prototype. Preserve cancellation that was already requested, but do
        // not serialize the signal. Mid-operation cancellation will require a
        // dedicated cancel message and worker-local AbortController.
        const callWorkerAfterAbortCheck = async <T>(
          signal: AbortSignal | undefined,
          call: () => Promise<T>
        ): Promise<T> => {
          signal?.throwIfAborted();
          return call();
        };

        const operationsFacade: DatabaseOperations = {
          engineKind: Promise.resolve('wasm'),
          executeQuery: (sql: string, params?: CellValue[]) =>
            workerProxy.runQuery(sql, params),
          serializeDatabase: () => workerProxy.exportDatabase(),
          applyModifications: (mods: ModificationEntry[], signal?: AbortSignal) =>
            callWorkerAfterAbortCheck(signal, () => workerProxy.applyModifications(mods)),
          undoModification: (mod: ModificationEntry) =>
            workerProxy.undoModification(mod),
          redoModification: (mod: ModificationEntry) =>
            workerProxy.redoModification(mod),
          flushChanges: (signal?: AbortSignal) =>
            callWorkerAfterAbortCheck(signal, () => workerProxy.flushChanges()),
          discardModifications: (mods: ModificationEntry[], signal?: AbortSignal) =>
            callWorkerAfterAbortCheck(signal, () => workerProxy.discardModifications(mods)),
          // Preserve JSON merge patches through worker RPC while still
          // transferring Uint8Array cell values without copying.
          updateCell: (table: string, rowId: string | number, column: string, value: CellValue, patch?: string) =>
            workerProxy.updateCell(table, rowId, column, wrapForTransfer(value), patch),
          insertRow: (table: string, data: Record<string, CellValue>) => {
            // Wrap any Uint8Array values in the data object for zero-copy transfer
            const wrappedData: Record<string, CellValue> = {};
            for (const key of Object.keys(data)) {
              wrappedData[key] = wrapForTransfer(data[key]);
            }
            return workerProxy.insertRow(table, wrappedData);
          },
          insertRowBatch: (table: string, rows: Record<string, CellValue>[]) =>
            workerProxy.insertRowBatch(table, rows),
          deleteRows: (table: string, rowIds: (string | number)[]) =>
            workerProxy.deleteRows(table, rowIds),
          deleteColumns: (table: string, columns: string[], dropDependentIndexes?: string[]) =>
            workerProxy.deleteColumns(table, columns, dropDependentIndexes),
          findDependentIndexes: (table: string, columns: string[]) =>
            workerProxy.findDependentIndexes(table, columns),
          createTable: (table: string, columns: ColumnDefinition[]) =>
            workerProxy.createTable(table, columns),
          getViewDefinition: (view: string) =>
            workerProxy.getViewDefinition(view),
          validateViewDefinition: (
            view: string,
            selectSql: string,
            intent?: ViewDefinitionIntent
          ) => workerProxy.validateViewDefinition(view, selectSql, intent),
          previewViewDefinition: (
            view: string,
            selectSql: string,
            limit?: number,
            intent?: ViewDefinitionIntent
          ) => workerProxy.previewViewDefinition(view, selectSql, limit, intent),
          createView: (view: string, selectSql: string) =>
            workerProxy.createView(view, selectSql),
          editView: (
            view: string,
            selectSql: string,
            preserveTriggers?: boolean,
            expectedSql?: string,
            expectedTriggers?: readonly ViewTriggerDefinition[]
          ) => workerProxy.editView(
            view,
            selectSql,
            preserveTriggers,
            expectedSql,
            expectedTriggers
          ),
          dropView: (view: string) =>
            workerProxy.dropView(view),
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
          fetchTableData: (table: string, options: TableQueryOptions) =>
            workerProxy.fetchTableData(table, options),
          fetchTableCount: (table: string, options: TableCountOptions) =>
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
