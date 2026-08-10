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
  RecordId,
  DeletedRow,
  QueryResultSet,
  ModificationEntry,
  DatabaseOperations,
  DatabaseInitConfig,
  DatabaseInitResult,
  CellUpdate,
  CellUpdateResult,
  ColumnDefinition,
  TableQueryOptions,
  TableCountOptions,
  TableCountResult,
  SchemaSnapshot,
  ColumnMetadata,
  ViewDefinition,
  ViewDefinitionIntent,
  ViewEditResult,
  ViewTriggerDefinition,
  CellMetadata,
  CellReadChunk,
  CellReadSession,
  CellReadTarget,
  QueryReadChunk,
  QueryReadSession,
  OversizedCellMetadata,
  DatabaseWriteResult,
  ColumnDropTableState
} from './core/types';
import type { PagedWritableOverlaySnapshot } from './core/paged-writable-overlay';

import { Worker } from './platform/threadPool';
import type { DatabaseConnectionBundle } from './connectionTypes';
import { getMaximumFileSizeBytes, getQueryTimeout } from './config';
import { createWorkerEndpoint } from './core/sqlite-db';
import { getNodeFs } from './core/platform/fs';
import { WAL_HEADER_SIZE_BYTES } from './core/paged-open';
import { createSharedCancellationFlag } from './core/cancellation-utils';
import { writePagedWritableOverlayToFile } from './pagedWritableSave';

// Native worker support (only in Node.js environment)
let nativeSupport: {
  isNativeAvailable: (path: string) => Promise<boolean>;
  createNativeDatabaseConnection: typeof import('./nativeWorker').createNativeDatabaseConnection;
} | null = null;

type DesktopTestBackend = 'native' | 'wasm';
let desktopTestBackend: DesktopTestBackend | undefined;
let desktopTestPagedOpenThresholdBytes: number | undefined;

/** Set only by the non-production integration API; normal backend selection is unchanged. */
export function setDesktopTestDatabaseBackend(backend: DesktopTestBackend | undefined): void {
  if (backend !== undefined && backend !== 'native' && backend !== 'wasm') {
    throw new Error(`Unsupported desktop test backend: ${String(backend)}`);
  }
  desktopTestBackend = backend;
}

/** Set only by the non-production integration API; normal paging policy is unchanged. */
export function setDesktopTestPagedOpenThresholdBytes(
  thresholdBytes: number | undefined
): void {
  if (
    thresholdBytes !== undefined
    && (!Number.isSafeInteger(thresholdBytes) || thresholdBytes < 1)
  ) {
    throw new Error('Desktop test paging threshold must be a positive safe integer');
  }
  desktopTestPagedOpenThresholdBytes = thresholdBytes;
}

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
 * part of this RPC contract: worker_threads clones it into a plain object.
 * Bounded query paths mirror it into a probed shared flag; other cancellable
 * operations retain their existing host-side pre-dispatch check.
 */
interface WorkerMethods {
  initializeDatabase(
    filename: string,
    config: DatabaseInitConfig
  ): Promise<DatabaseInitResult>;
  runQuery(
    sql: string,
    params?: CellValue[],
    cancellationFlag?: Int32Array
  ): Promise<QueryResultSet[]>;
  getCellMetadata(target: CellReadTarget): Promise<CellMetadata>;
  openCellReadSession(target: CellReadTarget): Promise<CellReadSession>;
  readCellChunk(
    sessionId: string,
    byteOffset: number,
    maxBytes: number
  ): Promise<CellReadChunk>;
  closeCellReadSession(sessionId: string): Promise<void>;
  openQueryReadSession(sql: string): Promise<QueryReadSession>;
  readQueryRows(sessionId: string, maxRows: number): Promise<QueryReadChunk>;
  closeQueryReadSession(sessionId: string): Promise<void>;
  exportDatabase(): Promise<Uint8Array>;
  exportPagedWritableOverlay(): Promise<PagedWritableOverlaySnapshot>;
  applyModifications(mods: ModificationEntry[]): Promise<void>;
  undoModification(mod: ModificationEntry): Promise<void>;
  redoModification(mod: ModificationEntry): Promise<void>;
  flushChanges(): Promise<void>;
  discardModifications(mods: ModificationEntry[]): Promise<void>;
  updateCell(
    table: string,
    rowId: RecordId,
    column: string,
    value: CellValue,
    patch?: string,
    maxEditValueBytes?: number
  ): Promise<RecordId | void>;
  replaceOversizedCell(
    table: string,
    rowId: RecordId,
    column: string,
    value: CellValue,
    expected: OversizedCellMetadata,
    maxEditValueBytes?: number
  ): Promise<RecordId | void>;
  insertRow(
    table: string,
    data: Record<string, CellValue>,
    maxEditValueBytes?: number
  ): Promise<RecordId | undefined>;
  insertRowBatch(
    table: string,
    rows: Record<string, CellValue>[],
    maxEditValueBytes?: number
  ): Promise<void>;
  deleteRows(
    table: string,
    rowIds: RecordId[],
    maxUndoSnapshotBytes?: number
  ): Promise<DeletedRow[]>;
  deleteColumns(
    table: string,
    columns: string[],
    dropDependentIndexes?: string[]
  ): Promise<ColumnDropTableState>;
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
    intent?: ViewDefinitionIntent,
    cancellationFlag?: Int32Array
  ): Promise<QueryResultSet>;
  createView(view: string, selectSql: string): Promise<ViewDefinition>;
  editView(
    view: string,
    selectSql: string,
    preserveTriggers?: boolean,
    expectedSql?: string,
    expectedTriggers?: readonly ViewTriggerDefinition[]
  ): Promise<ViewEditResult>;
  dropView(
    view: string,
    expectedSql?: string,
    expectedTriggers?: readonly ViewTriggerDefinition[]
  ): Promise<ViewDefinition>;
  updateCellBatch(
    table: string,
    updates: CellUpdate[],
    maxEditValueBytes?: number,
    maxUndoSnapshotBytes?: number
  ): Promise<CellUpdateResult[]>;
  addColumn(table: string, column: string, type: string, defaultValue?: string): Promise<void>;
  fetchTableData(table: string, options: TableQueryOptions): Promise<QueryResultSet>;
  fetchTableCount(table: string, options: TableCountOptions): Promise<TableCountResult>;
  fetchSchema(): Promise<SchemaSnapshot>;
  getTableInfo(table: string): Promise<ColumnMetadata[]>;
  getPragmas(): Promise<Record<string, CellValue>>;
  setPragma(pragma: string, value: CellValue): Promise<void>;
  ping(): Promise<boolean>;
  writeToFile(path: string): Promise<DatabaseWriteResult | void>;
}

const WORKER_METHOD_NAMES = [
  'initializeDatabase',
  'runQuery',
  'getCellMetadata',
  'openCellReadSession',
  'readCellChunk',
  'closeCellReadSession',
  'openQueryReadSession',
  'readQueryRows',
  'closeQueryReadSession',
  'exportDatabase',
  'exportPagedWritableOverlay',
  'applyModifications',
  'undoModification',
  'redoModification',
  'flushChanges',
  'discardModifications',
  'updateCell',
  'replaceOversizedCell',
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

/** Keep AbortSignal host-local while exposing its state to synchronous worker code. */
async function callWorkerWithCancellation<T>(
  signal: AbortSignal,
  call: (cancellationFlag?: Int32Array) => Promise<T>
): Promise<T> {
  signal.throwIfAborted();
  const sharedCancellation = createSharedCancellationFlag(signal);
  try {
    const result = await call(sharedCancellation?.flag);
    signal.throwIfAborted();
    return result;
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    throw error;
  } finally {
    sharedCancellation?.dispose();
  }
}

/**
 * History batches execute entries serially in the worker, while one undo/redo
 * entry can carry several payload arrays that each add replay work. Scale the
 * host RPC deadline with the explicit work units so healthy history operations
 * do not time out merely because one invocation contains many steps.
 */
// Past ten base intervals, fail into DatabaseDocument's reconnect/reload
// recovery instead of letting a hung worker invocation survive the session.
const MAX_HISTORY_INVOCATION_TIMEOUT_MS = 10 * DEFAULT_INVOCATION_TIMEOUT_MS;

/** Count the payload arrays that make a single history replay scale with stored work. */
function getModificationWorkUnits(modification: ModificationEntry | undefined): number {
  const scaledPayloads = [
    modification?.affectedCells,
    modification?.deletedRows,
    modification?.affectedRowIds,
    modification?.deletedColumns,
    modification?.droppedIndexes,
    modification?.viewDefBefore?.triggers,
    modification?.viewDefAfter?.triggers
  ];
  const workUnits = scaledPayloads.reduce(
    (total, payload) => total + (payload?.length ?? 0),
    0
  );
  return Math.max(1, workUnits);
}

function getWorkerInvocationTimeout(
  methodName: string,
  parameters: readonly unknown[]
): number {
  let workUnits: number;
  if (methodName === 'applyModifications' || methodName === 'discardModifications') {
    const modifications = parameters[0];
    workUnits = Array.isArray(modifications) ? Math.max(1, modifications.length) : 1;
  } else if (methodName === 'undoModification' || methodName === 'redoModification') {
    const modification = parameters[0] as ModificationEntry | undefined;
    workUnits = getModificationWorkUnits(modification);
  } else {
    return DEFAULT_INVOCATION_TIMEOUT_MS;
  }

  return Math.min(
    MAX_HISTORY_INVOCATION_TIMEOUT_MS,
    DEFAULT_INVOCATION_TIMEOUT_MS * workUnits
  );
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
  if (desktopTestBackend === 'wasm') {
    GlobalOutputChannel?.appendLine('[DesktopTest] Forcing WebAssembly SQLite backend');
    return createWasmDatabaseConnection(extensionUri, _reporter);
  }

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
        const wasmBundlePromise = desktopTestBackend === 'native'
          ? undefined
          : createWasmDatabaseConnection(extensionUri, _reporter);
        let wasmBundle: DatabaseConnectionBundle | null = null;

        return {
          workerMethods: nativeBundle.workerMethods,
          async establishConnection(fileUri, displayName, forceReadOnly, autoCommit) {
            try {
              // Try native first
              return await nativeBundle.establishConnection(fileUri, displayName, forceReadOnly, autoCommit);
            } catch (nativeErr) {
              if (desktopTestBackend === 'native') {
                nativeBundle.workerMethods[Symbol.dispose]();
                throw nativeErr;
              }
              // Native failed - fall back to WASM
              GlobalOutputChannel?.appendLine(`[SQLite Explorer] Native file open failed, falling back to WASM: ${nativeErr instanceof Error ? nativeErr.message : String(nativeErr)}`);
              if (!wasmBundle) {
                wasmBundle = await wasmBundlePromise!;
              }
              return wasmBundle.establishConnection(fileUri, displayName, forceReadOnly, autoCommit);
            }
          }
        };
      } catch (err) {
        if (desktopTestBackend === 'native') throw err;
        GlobalOutputChannel?.appendLine(`[SQLite Explorer] Native SQLite failed, falling back to WASM: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (desktopTestBackend === 'native') {
    throw new Error('Native SQLite backend is unavailable on this platform');
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
      const [dbContent, walSize] = await Promise.all([
        loadDatabaseFile(fileUri),
        statWalSize(fileUri)
      ]);
      const hasActiveWal = walSize > 0;
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
        maxSize: getMaximumFileSizeBytes(),
        resourceMap: {},
        wasmBinary: wasmContent,
        readOnlyMode,
        queryTimeout: getQueryTimeout()
      };

      const result = await endpoint.initializeDatabase(displayName, initConfig);

      const operationsFacade: DatabaseOperations = {
        engineKind: Promise.resolve('wasm'),
        executeQuery: (sql: string, params?: CellValue[], signal?: AbortSignal) =>
          endpoint.runQuery(sql, params, signal),
        getCellMetadata: (target: CellReadTarget) =>
          endpoint.getCellMetadata(target),
        openCellReadSession: (target: CellReadTarget) =>
          endpoint.openCellReadSession(target),
        readCellChunk: (sessionId: string, byteOffset: number, maxBytes: number) =>
          endpoint.readCellChunk(sessionId, byteOffset, maxBytes),
        closeCellReadSession: (sessionId: string) =>
          endpoint.closeCellReadSession(sessionId),
        openQueryReadSession: (sql: string) =>
          endpoint.openQueryReadSession(sql),
        readQueryRows: (sessionId: string, maxRows: number) =>
          endpoint.readQueryRows(sessionId, maxRows),
        closeQueryReadSession: (sessionId: string) =>
          endpoint.closeQueryReadSession(sessionId),
        // In-process facade plumbing; persistence policy belongs to the caller.
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
        updateCell: (
          table: string,
          rowId: RecordId,
          column: string,
          value: CellValue,
          patch?: string,
          maxEditValueBytes?: number
        ) => endpoint.updateCell(
          table,
          rowId,
          column,
          value,
          patch,
          maxEditValueBytes
        ),
        replaceOversizedCell: (
          table: string,
          rowId: RecordId,
          column: string,
          value: CellValue,
          expected: OversizedCellMetadata,
          maxEditValueBytes?: number
        ) => endpoint.replaceOversizedCell(
          table,
          rowId,
          column,
          value,
          expected,
          maxEditValueBytes
        ),
        insertRow: (
          table: string,
          data: Record<string, CellValue>,
          maxEditValueBytes?: number
        ) => endpoint.insertRow(table, data, maxEditValueBytes),
        insertRowBatch: (
          table: string,
          rows: Record<string, CellValue>[],
          maxEditValueBytes?: number
        ) => endpoint.insertRowBatch(table, rows, maxEditValueBytes),
        deleteRows: (table: string, rowIds: RecordId[], maxUndoSnapshotBytes?: number) =>
          endpoint.deleteRows(table, rowIds, maxUndoSnapshotBytes),
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
          intent?: ViewDefinitionIntent,
          signal?: AbortSignal
        ) => endpoint.previewViewDefinition(view, selectSql, limit, intent, signal),
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
        dropView: (
          view: string,
          expectedSql?: string,
          expectedTriggers?: readonly ViewTriggerDefinition[]
        ) => endpoint.dropView(view, expectedSql, expectedTriggers),
        updateCellBatch: (
          table: string,
          updates: CellUpdate[],
          maxEditValueBytes?: number,
          maxUndoSnapshotBytes?: number
        ) => endpoint.updateCellBatch(
          table,
          updates,
          maxEditValueBytes,
          maxUndoSnapshotBytes
        ),
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
        isReadOnly: result.isReadOnly ?? false,
        storage: result.storage
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
      // Keep the configured refusal message ready for local files above
      // maxFileSize. The worker owns the authoritative backend-agnostic gate;
      // the host substitutes the existing user-facing units when it refuses.
      let oversizedFileMessage: string | undefined;
      try {
        // Read database file
        // Optimization: If running in Node and file is local, pass path to worker instead of reading content here
        // This avoids blocking the extension host and transferring large buffers
        const isNode = !import.meta.env?.VSCODE_BROWSER_EXT;
        const isLocal = fileUri.scheme === 'file';

        let dbContent: Uint8Array | null = null;
        let filePath: string | undefined;

        if (isNode && isLocal) {
            // Check size limit first
            const maxSize = getMaximumFileSizeBytes();
            const fileStat = await vsc.workspace.fs.stat(fileUri);
            if (maxSize !== 0 && fileStat.size > maxSize) {
               oversizedFileMessage = `File size (${(fileStat.size / (1024 * 1024)).toFixed(2)} MB) exceeds the maximum allowed size (${(maxSize / (1024 * 1024)).toFixed(2)} MB). Configure 'sqliteExplorer.maxFileSize' to increase the limit.`;
            }
            filePath = fileUri.fsPath;
        } else {
            dbContent = await loadDatabaseFile(fileUri);
        }

        // Like the browser guard above, sql.js only ever opens the main
        // database image: committed transactions still sitting in a sibling
        // -wal file are invisible to it, and saving that stale view would
        // erase them from disk. Force read-only whenever the -wal holds
        // frames (size > header; empty or header-only files are clean
        // checkpoint leftovers — see WAL_HEADER_SIZE_BYTES).
        const walSize = await statWalSize(fileUri);
        const hasUncheckpointedWal = walSize > WAL_HEADER_SIZE_BYTES;
        if (oversizedFileMessage !== undefined && hasUncheckpointedWal) {
          // Over the in-memory gate AND carrying (or possibly carrying) WAL
          // frames: the file can neither buffer (over the gate) nor open
          // page-on-demand (the snapshot reads only the main file and would
          // miss the committed WAL transactions). Reject with the actionable
          // checkpoint instruction instead of the bare size error.
          //
          // A WAL-at-rest HEADER (bytes 18/19 == 0x02) with no frame-bearing
          // sibling is a different case and deliberately stays pageable: with
          // this sibling gate clean there are no invisible frames, and the
          // worker-side sniff in openPagedDatabaseEngine (core/sqlite-db.ts)
          // presents such headers to the engine in pageable form.
          //
          // Deliberate final rejection: clear the size-error substitution so
          // the catch below surfaces the checkpoint instruction itself.
          oversizedFileMessage = undefined;
          throw new Error(
            `${displayName} has uncheckpointed WAL data and exceeds the in-memory size limit for the `
            + 'WebAssembly backend, so it cannot be opened: a page-on-demand snapshot reads only the '
            + 'main database file and would miss the WAL transactions. Run '
            + '"PRAGMA wal_checkpoint(TRUNCATE)" on the database (or close the program writing to '
            + 'it), then reopen it.'
          );
        }
        if (hasUncheckpointedWal) {
          warnWalReadOnlyDowngrade(displayName);
        }

        // Load WASM binary from assets directory
        const wasmUri = vsc.Uri.joinPath(extensionUri, 'assets', 'sqlite3.wasm');
        const wasmContent = await vsc.workspace.fs.readFile(wasmUri);

        // Initialize database configuration
        const initConfig: DatabaseInitConfig = {
          content: dbContent,
          filePath,
          maxSize: getMaximumFileSizeBytes(),
          resourceMap: {},
          wasmBinary: wasmContent,
          readOnlyMode: (forceReadOnly ?? false) || hasUncheckpointedWal,
          queryTimeout: getQueryTimeout(),
          // Desktop local files may use page-on-demand storage above the
          // worker's dedicated paging threshold (writable first, then
          // read-only) after the independent maxSize refusal gate passes.
          // The browser extension host never reaches this bundle, and paged
          // mode is impossible there anyway: workspace.fs is async-only
          // while the in-process engine needs synchronous reads.
          allowPagedFallback: filePath !== undefined,
          ...(desktopTestPagedOpenThresholdBytes === undefined
            ? {}
            : { pagedOpenThresholdBytes: desktopTestPagedOpenThresholdBytes })
        };

        // Initialize database in worker
        // Use Transfer wrapper to zero-copy transfer the array buffers
        const transferables: Transferable[] = [];
        if (initConfig.content && initConfig.content.buffer) {
            transferables.push(initConfig.content.buffer);
        }
        if (initConfig.wasmBinary && initConfig.wasmBinary.buffer) {
            transferables.push(initConfig.wasmBinary.buffer);
        }

        const result = await workerProxy.initializeDatabase(
            displayName,
            new Transfer(initConfig, transferables) as unknown as DatabaseInitConfig
        );

        // Mirror the WAL gate's surfacing: the webview only ever receives the
        // bare read-only flag, so the reason is raised here (toast + output
        // channel) when the worker chose the page-on-demand fallback.
        if (result.storage === 'paged' && result.isReadOnly) {
          warnPagedReadOnlyDowngrade(displayName);
        }

        // Create operations facade that routes to worker
        // Transfer a private copy. postMessage detaches transfer-list buffers, while
        // HostBridge retains the caller-owned value for undo/redo and hot-exit.
        // Copying once here preserves that history and keeps the worker crossing
        // itself zero-copy.
        const wrapForTransfer = (value: CellValue): CellValue => {
          if (value instanceof Uint8Array && value.buffer) {
            const transferableValue = value.slice();
            return new Transfer(
              transferableValue,
              [transferableValue.buffer]
            ) as unknown as CellValue;
          }
          return value;
        };

        // AbortSignal cannot cross worker_threads RPC without losing its
        // prototype. Mutation replays retain their existing pre-dispatch check;
        // bounded queries use callWorkerWithCancellation's shared flag instead.
        const callWorkerAfterAbortCheck = async <T>(
          signal: AbortSignal | undefined,
          call: () => Promise<T>
        ): Promise<T> => {
          signal?.throwIfAborted();
          return call();
        };

        const writeToFile = result.storage === 'paged' && result.isReadOnly !== true
          ? async (
              targetPath: string,
              signal?: AbortSignal
            ): Promise<DatabaseWriteResult> => {
              signal?.throwIfAborted();
              if (!filePath) {
                throw new Error(
                  'Internal error: writable paged save has no local frozen base path.'
                );
              }
              const fs = getNodeFs();
              if (!fs) {
                throw new Error(
                  'Internal error: writable paged save requires desktop filesystem access.'
                );
              }
              const snapshot = await workerProxy.exportPagedWritableOverlay();
              // AbortSignal cannot cross worker_threads. Re-check after the
              // serialized export before starting host filesystem I/O.
              signal?.throwIfAborted();
              return writePagedWritableOverlayToFile(
                fs,
                filePath,
                targetPath,
                snapshot,
                (level, message, error) => forwardWorkerLog(level, [message, error]),
                undefined,
                signal
              );
            }
          : (targetPath: string) => workerProxy.writeToFile(targetPath);

        const operationsFacade: DatabaseOperations = {
          engineKind: Promise.resolve('wasm'),
          executeQuery: (sql: string, params?: CellValue[], signal?: AbortSignal) => (
            signal
              ? callWorkerWithCancellation(
                  signal,
                  cancellationFlag => workerProxy.runQuery(sql, params, cancellationFlag)
                )
              : workerProxy.runQuery(sql, params)
          ),
          getCellMetadata: (target: CellReadTarget) =>
            workerProxy.getCellMetadata(target),
          openCellReadSession: (target: CellReadTarget) =>
            workerProxy.openCellReadSession(target),
          readCellChunk: (sessionId: string, byteOffset: number, maxBytes: number) =>
            workerProxy.readCellChunk(sessionId, byteOffset, maxBytes),
          closeCellReadSession: (sessionId: string) =>
            workerProxy.closeCellReadSession(sessionId),
          openQueryReadSession: (sql: string) =>
            workerProxy.openQueryReadSession(sql),
          readQueryRows: (sessionId: string, maxRows: number) =>
            workerProxy.readQueryRows(sessionId, maxRows),
          closeQueryReadSession: (sessionId: string) =>
            workerProxy.closeQueryReadSession(sessionId),
          // Worker facade plumbing; persistence policy belongs to the caller.
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
          // Preserve JSON merge patches through worker RPC while transferring
          // a private Uint8Array copy (the host may retain the original in history).
          updateCell: (
            table: string,
            rowId: RecordId,
            column: string,
            value: CellValue,
            patch?: string,
            maxEditValueBytes?: number
          ) => workerProxy.updateCell(
            table,
            rowId,
            column,
            wrapForTransfer(value),
            patch,
            maxEditValueBytes
          ),
          replaceOversizedCell: (
            table: string,
            rowId: RecordId,
            column: string,
            value: CellValue,
            expected: OversizedCellMetadata,
            maxEditValueBytes?: number
          ) => workerProxy.replaceOversizedCell(
            table,
            rowId,
            column,
            wrapForTransfer(value),
            expected,
            maxEditValueBytes
          ),
          insertRow: (
            table: string,
            data: Record<string, CellValue>,
            maxEditValueBytes?: number
          ) => {
            // Retain caller-owned values because insert history records this object.
            const wrappedData: Record<string, CellValue> = {};
            for (const key of Object.keys(data)) {
              wrappedData[key] = wrapForTransfer(data[key]);
            }
            return workerProxy.insertRow(table, wrappedData, maxEditValueBytes);
          },
          insertRowBatch: (
            table: string,
            rows: Record<string, CellValue>[],
            maxEditValueBytes?: number
          ) => workerProxy.insertRowBatch(table, rows, maxEditValueBytes),
          deleteRows: (table: string, rowIds: RecordId[], maxUndoSnapshotBytes?: number) =>
            workerProxy.deleteRows(table, rowIds, maxUndoSnapshotBytes),
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
            intent?: ViewDefinitionIntent,
            signal?: AbortSignal
          ) => (
            signal
              ? callWorkerWithCancellation(
                  signal,
                  cancellationFlag => workerProxy.previewViewDefinition(
                    view,
                    selectSql,
                    limit,
                    intent,
                    cancellationFlag
                  )
                )
              : workerProxy.previewViewDefinition(view, selectSql, limit, intent)
          ),
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
          dropView: (
            view: string,
            expectedSql?: string,
            expectedTriggers?: readonly ViewTriggerDefinition[]
          ) => workerProxy.dropView(view, expectedSql, expectedTriggers),
          updateCellBatch: (
            table: string,
            updates: CellUpdate[],
            maxEditValueBytes?: number,
            maxUndoSnapshotBytes?: number
          ) => {
            // Retain caller-owned values because batch history records these updates.
            const wrappedUpdates = updates.map(u => ({
              ...u,
              value: wrapForTransfer(u.value)
            }));
            return workerProxy.updateCellBatch(
              table,
              wrappedUpdates,
              maxEditValueBytes,
              maxUndoSnapshotBytes
            );
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
          writeToFile
        };

        return {
          databaseOps: serializeOperations(operationsFacade),
          isReadOnly: result.isReadOnly ?? false,
          storage: result.storage
        };
      } catch (err) {
        // Terminate worker on connection failure to prevent leak
        terminateWorker();
        if (oversizedFileMessage !== undefined) {
          // Preserve the configured refusal surface while retaining the
          // worker's authoritative byte-level reason on the cause chain.
          const reason = err instanceof Error ? err.message : String(err);
          GlobalOutputChannel?.appendLine(
            `[SQLite Explorer] ${displayName}: WebAssembly open failed (${reason}); `
            + 'reporting the configured maxFileSize refusal.'
          );
          throw new Error(oversizedFileMessage, { cause: err });
        }
        throw err;
      }
    }
  };
}

// ============================================================================
// File Loading
// ============================================================================

/**
 * Load the database file content.
 *
 * @param uri - Database file URI
 * @returns Database content (empty for untitled documents)
 */
async function loadDatabaseFile(uri: vsc.Uri): Promise<Uint8Array> {
  // Untitled documents start empty
  if (uri.scheme === 'untitled') {
    return new Uint8Array();
  }

  const maxSize = getMaximumFileSizeBytes();

  // Check file size
  const fileStat = await Promise.resolve(vsc.workspace.fs.stat(uri)).catch(() => ({ size: 0 }));
  if (maxSize !== 0 && fileStat.size > maxSize) {
    throw new Error(`File size (${(fileStat.size / (1024 * 1024)).toFixed(2)} MB) exceeds the maximum allowed size (${(maxSize / (1024 * 1024)).toFixed(2)} MB). Configure 'sqliteExplorer.maxFileSize' to increase the limit.`);
  }

  return vsc.workspace.fs.readFile(uri);
}

// WAL_HEADER_SIZE_BYTES (frame-detection threshold for sibling -wal files,
// with the full rationale) lives in ./core/paged-open so the engine-side
// paged fallback shares the identical definition.

/**
 * Measure the -wal file next to a database.
 *
 * @param uri - Database file URI
 * @returns Size of the sibling -wal file in bytes, or 0 when it is absent
 */
async function statWalSize(uri: vsc.Uri): Promise<number> {
  if (uri.scheme === 'untitled') {
    return 0;
  }
  const walUri = uri.with({ path: uri.path + '-wal' });
  try {
    return (await vsc.workspace.fs.stat(walUri)).size;
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code === 'FileNotFound' || code === 'ENOENT') {
      // No -wal file: the database has no separate WAL state to merge.
      return 0;
    }
    // Any other stat failure (permissions, transient provider error) leaves
    // the WAL state unknowable while committed frames may be invisible to
    // sql.js — fail toward the read-only gate rather than silently disarming
    // the only defense against saving a stale view over the real file.
    GlobalOutputChannel?.appendLine(
      `SQLite Explorer: could not inspect ${walUri.toString()} (`
      + `${err instanceof Error ? err.message : String(err)}); `
      + 'treating WAL state as unknown and opening read-only'
    );
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Surface the WAL read-only downgrade to the user.
 *
 * The webview only ever receives the bare read-only flag (the browser WAL
 * guard is silent for the same reason), so the desktop gate raises the reason
 * here: once as a toast and once in the output channel.
 */
function warnWalReadOnlyDowngrade(displayName: string): void {
  GlobalOutputChannel?.appendLine(
    `[SQLite Explorer] ${displayName}: uncheckpointed WAL data found next to the database. ` +
    'The WebAssembly backend reads only the main database file, so the database opens ' +
    'read-only to avoid saving a stale copy over the WAL transactions. Run ' +
    '"PRAGMA wal_checkpoint(TRUNCATE)" on it (or close the program writing to it), then reopen.'
  );
  // Fire-and-forget: the toast resolves when dismissed and must not block
  // connection establishment.
  void vsc.window.showWarningMessage(vsc.l10n.t(
    '{0} has WAL changes the WebAssembly SQLite backend cannot read, so it is opened read-only and the data shown may be incomplete. Run "PRAGMA wal_checkpoint(TRUNCATE)" on the database (or close the program writing to it), then reopen it.',
    displayName
  ));
}

/**
 * Surface the paged (page-on-demand) read-only downgrade to the user.
 *
 * Same pattern as the WAL gate above: the webview only receives the bare
 * read-only flag, so the storage limitation is raised here — once as a toast
 * and once in the output channel. Paging is selected by a dedicated threshold,
 * so changing maxFileSize is not a way to force materialization.
 */
function warnPagedReadOnlyDowngrade(displayName: string): void {
  GlobalOutputChannel?.appendLine(
    `[SQLite Explorer] ${displayName}: the WebAssembly backend opened this database ` +
    'page-on-demand as a read-only snapshot. Reopen with writable page-on-demand support ' +
    'or use the native desktop backend to edit and save it.'
  );
  // Fire-and-forget, matching warnWalReadOnlyDowngrade.
  void vsc.window.showWarningMessage(vsc.l10n.t(
    '{0} is open page-on-demand as read-only. Reopen with writable page-on-demand support or use the native desktop backend to edit and save it.',
    displayName
  ));
}
