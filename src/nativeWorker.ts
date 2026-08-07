/**
 * Native SQLite Worker Manager
 *
 * Spawns and manages the txiki-js native runtime for high-performance
 * SQLite operations. Falls back to sql.js (WASM) when native is unavailable.
 *
 * Communication uses V8 serialization over stdin/stdout for compatibility
 * between Node.js and txiki-js.
 */

import * as vsc from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import * as v8 from 'node:v8';

import { uiKindToString } from './helpers';

import type { TelemetryReporter } from '@vscode/extension-telemetry';
import type { DatabaseConnectionBundle } from './connectionTypes';
import type {
  CellValue,
  RecordId,
  QueryResultSet,
  DatabaseOperations,
  DatabaseInitConfig,
  DatabaseInitResult,
  ModificationEntry,
  CellUpdate,
  CellUpdateResult,
  TableQueryOptions,
  TableCountOptions,
  SchemaSnapshot,
  ColumnMetadata,
  ColumnDefinition,
  TableMetadata,
  ViewMetadata,
  IndexMetadata,
  ViewDefinition,
  ViewDefinitionIntent,
  ViewEditResult,
  ViewTriggerDefinition,
  ExactIntegerTextMap,
  TableIdentity,
  DeletedRow,
  CellMetadata,
  CellReadChunk,
  CellReadSession,
  CellReadTarget,
  OversizedCellMetadata
} from './core/types';
import { escapeIdentifier, validateSqlType, validateRowId, validateRowIds } from './core/sql-utils';
import { buildSelectQuery, buildCountQuery } from './core/query-builder';
import {
  applyMergePatch,
  computeJsonPatchUndo,
  parseJsonValueForPatching,
  prepareCellUpdateForStorage
} from './core/json-utils';
import {
  assertMutableRecordId,
  buildRecordIdentitiesPredicate,
  buildRecordIdentityPredicate,
  buildTableIdentityMap,
  classifyTableIdentity,
  encodePrimaryKeyRecordId,
  isPrimaryKeyRecordId,
  primaryKeyColumnsFromTableInfo,
  TABLE_IDENTITY_METADATA_SQL
} from './core/row-identity';
import {
  buildExactNumericTextQuery,
  buildRowIdExactRealTextQueries,
  collectRowIdExactRealTexts,
  hasUnsafeBigIntAtColumn,
  normalizeIntegerRowsForTransport,
  ROWID_TABLE_AUTHORITY_SQL
} from './core/integer-utils';
import {
  buildCellContainmentQuery,
  decodeCellContainment,
  remapPrimaryKeyContainment
} from './core/cell-containment';
import { serializeOperations } from './core/operation-serializer';
import { InvocationTimeoutError } from './core/rpc';
import {
  assertViewDefinitionSnapshotCurrent,
  assertViewDefinitionStateCurrent,
  assertViewDefinitionIntent,
  assertViewTriggerSnapshotIsMutationSafe,
  assertViewTriggersCompatibleWithColumns,
  buildCreateViewTriggerSql,
  buildCreateViewSql,
  extractViewColumnListSql,
  extractViewSelectSql,
  escapeMainViewIdentifier,
  mapViewTriggerRows,
  VIEW_TRIGGER_SCHEMA_QUERIES,
  normalizeViewDefinitionError,
  normalizeViewSelectSql
} from './core/view-utils';
import { crypto } from './platform/cryptoShim';
import { DEFAULT_QUERY_TIMEOUT_MS } from './config';
import {
  validateCellReadTarget,
  validateCellReadWindow
} from './core/cell-read';
import {
  assertCellValueWithinEditLimit,
  assertCellValuesWithinEditLimit,
  assertOversizedCellReplacementExpectation,
  OVERSIZED_CELL_REPLACEMENT_CONFLICT_MESSAGE,
  OversizedCellReplacementRequiredError
} from './core/cell-edit-policy';

// ============================================================================
// Utility Functions
// ============================================================================

// Utility functions moved to src/core/sql-utils.ts

// This token never crosses RPC. It distinguishes restoration of a value that
// already existed in history from a user request to create oversized content.
const HISTORY_REPLAY_EDIT_TOKEN = Symbol('history-replay-edit');

type NativeHistoryUpdateCell = (
  table: string,
  rowId: RecordId,
  column: string,
  value: CellValue,
  patch?: string,
  maxEditValueBytes?: number,
  historyReplayToken?: typeof HISTORY_REPLAY_EDIT_TOKEN
) => Promise<RecordId | void>;

type NativeHistoryUpdateCellBatch = (
  table: string,
  updates: CellUpdate[],
  maxEditValueBytes?: number,
  historyReplayToken?: typeof HISTORY_REPLAY_EDIT_TOKEN
) => Promise<CellUpdateResult[]>;

type NativeHistoryInsertRow = (
  table: string,
  data: Record<string, CellValue>,
  maxEditValueBytes?: number,
  historyReplayToken?: typeof HISTORY_REPLAY_EDIT_TOKEN
) => Promise<RecordId | undefined>;

type NativeHistoryInsertRowBatch = (
  table: string,
  rows: Record<string, CellValue>[],
  maxEditValueBytes?: number,
  historyReplayToken?: typeof HISTORY_REPLAY_EDIT_TOKEN
) => Promise<void>;

const updateNativeCellForHistory = (
  operations: DatabaseOperations,
  table: string,
  rowId: RecordId,
  column: string,
  value: CellValue,
  patch?: string
) => (operations.updateCell as NativeHistoryUpdateCell)(
  table,
  rowId,
  column,
  value,
  patch,
  undefined,
  HISTORY_REPLAY_EDIT_TOKEN
);

const updateNativeCellBatchForHistory = (
  operations: DatabaseOperations,
  table: string,
  updates: CellUpdate[]
) => (operations.updateCellBatch as NativeHistoryUpdateCellBatch)(
  table,
  updates,
  undefined,
  HISTORY_REPLAY_EDIT_TOKEN
);

const insertNativeRowForHistory = (
  operations: DatabaseOperations,
  table: string,
  data: Record<string, CellValue>
) => (operations.insertRow as NativeHistoryInsertRow)(
  table,
  data,
  undefined,
  HISTORY_REPLAY_EDIT_TOKEN
);

const insertNativeRowBatchForHistory = (
  operations: DatabaseOperations,
  table: string,
  rows: Record<string, CellValue>[]
) => (operations.insertRowBatch as NativeHistoryInsertRowBatch)(
  table,
  rows,
  undefined,
  HISTORY_REPLAY_EDIT_TOKEN
);

function mergeExactIntegerTextMaps(
  companionTexts: ExactIntegerTextMap | undefined,
  nativeTexts: ExactIntegerTextMap | undefined
): ExactIntegerTextMap | undefined {
  if (!companionTexts) return nativeTexts;
  if (!nativeTexts) return companionTexts;

  const merged: ExactIntegerTextMap = {};
  for (const source of [companionTexts, nativeTexts]) {
    for (const [rowIndex, columns] of Object.entries(source)) {
      const numericRowIndex = Number(rowIndex);
      merged[numericRowIndex] ??= {};
      Object.assign(merged[numericRowIndex], columns);
    }
  }
  return merged;
}

/**
 * Build a minimal env block for the txiki-js child process.
 *
 * Goals:
 *   1. Drop secrets that may be present in the parent's env (AWS_*, GH_TOKEN,
 *      shell history paths, etc.) — the txiki-js worker has no need for them.
 *   2. Keep the variables the OS itself needs to spawn and run the binary,
 *      otherwise the worker fails to start in production environments.
 *
 * Windows: SystemRoot is required for kernel/DLL resolution; TEMP/TMP for
 * tmpfile() and any temporary export paths; PATH for any spawned subprocess
 * the runtime might invoke. Stripping SystemRoot is a documented cause of
 * "DLL initialization failed" on win32 child processes.
 *
 * POSIX: HOME for any tilde expansion the runtime does internally; TMPDIR
 * for tmpfile()/VACUUM INTO export paths (e.g., /tmp on Linux/macOS by
 * default — not present on minimal containers); TZ + LANG/LC_ALL for ICU
 * collation when the worker runs SQLite collations sensitive to locale.
 */
function buildSpawnEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowList = process.platform === 'win32'
    ? ['SystemRoot', 'TEMP', 'TMP', 'PATH', 'PATHEXT']
    : ['HOME', 'TMPDIR', 'TZ', 'LANG', 'LC_ALL', 'LC_CTYPE'];

  for (const key of allowList) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

// ============================================================================
// Constants
// ============================================================================

/** Header size for length-prefixed messages (4 bytes, big-endian) */
const HEADER_SIZE = 4;

/** Timeout for native worker initialization (ms) */
const INIT_TIMEOUT = 10000;

/** Timeout for individual queries (ms) */
const QUERY_TIMEOUT = DEFAULT_QUERY_TIMEOUT_MS;

/** Let a bounded worker query report its own precise timeout before RPC expires. */
const BOUNDED_QUERY_TRANSPORT_MARGIN_MS = 2000;

// ============================================================================
// Platform Detection
// ============================================================================

/**
 * Determine the native binary path based on current platform.
 *
 * @param extensionPath - Extension installation directory
 * @returns Path to native binary or null if unsupported
 */
async function getNativeBinaryPath(extensionPath: string): Promise<string | null> {
  const platform = process.platform;
  const arch = process.arch;

  let platformDir: string;

  // Map Node.js platform/arch to txiki-js binary directories
  switch (platform) {
    case 'linux':
      platformDir = arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu';
      break;
    case 'darwin':
      platformDir = arch === 'arm64' ? 'aarch64-macos' : 'x86_64-macos';
      break;
    case 'win32':
      platformDir = 'x86_64-windows';
      break;
    default:
      return null;
  }

  const binaryName = platform === 'win32' ? 'tjs.exe' : 'tjs';
  const binaryPath = path.join(extensionPath, 'natives', platformDir, binaryName);

  // Verify binary exists
  try {
    await fs.promises.access(binaryPath, fs.constants.F_OK);
    return binaryPath;
  } catch {
    return null;
  }
}

// ============================================================================
// Native Worker Communication
// ============================================================================

/**
 * Write a length-prefixed V8-serialized message.
 *
 * @param stream - Writable stream (stdin)
 * @param msg - Message to send
 */
function writeMessage(stream: NodeJS.WritableStream, msg: unknown): void {
  const serialized = v8.serialize(msg);
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32BE(serialized.byteLength, 0);

  stream.write(header);
  stream.write(serialized);
}

/**
 * Native worker process wrapper.
 *
 * Manages the txiki-js child process and provides RPC-style communication.
 */
export class NativeWorkerProcess {
  private process: ChildProcess | null = null;
  private messageId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
    signal?: AbortSignal;
    abortListener?: () => void;
  }>();

  private chunks: Buffer[] = [];
  private chunksTotalLength = 0;
  private expectedLength = -1;

  constructor(
    private readonly binaryPath: string,
    private readonly workerScript: string
  ) {
    if (!path.isAbsolute(binaryPath)) {
      throw new Error(`Security Error: Expected absolute path for binary, got: ${binaryPath}`);
    }
    if (!path.isAbsolute(workerScript)) {
      throw new Error(`Security Error: Expected absolute path for worker script, got: ${workerScript}`);
    }
  }

  /**
   * Start the native worker process.
   *
   * @returns Promise resolving when worker is ready
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.stop();
        reject(new Error('Native worker initialization timed out'));
      }, INIT_TIMEOUT);

      // Spawn txiki-js with the worker script
      this.process = spawn(this.binaryPath, ['run', this.workerScript], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildSpawnEnv(),
        shell: false
      });

      // Handle stdout (message responses)
      this.process.stdout?.on('data', (chunk: Buffer) => {
        this.handleData(chunk);
      });

      // Handle stderr (debug output)
      this.process.stderr?.on('data', (chunk: Buffer) => {
        console.warn('[NativeWorker]', chunk.toString());
      });

      // Handle process exit
      this.process.on('exit', (code) => {
        clearTimeout(timeout);
        if (code !== 0 && code !== null) {
          console.error(`[NativeWorker] Process exited with code ${code}`);
        }
        this.cleanup();
      });

      // Handle process errors
      this.process.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
        this.cleanup();
      });

      // Wait for ready signal
      const onReady = (msg: { ready?: boolean }) => {
        if (msg.ready) {
          clearTimeout(timeout);
          resolve();
        }
      };

      // Temporarily intercept first message for ready signal
      const originalHandler = this.handleMessage.bind(this);
      this.handleMessage = (msg: unknown) => {
        this.handleMessage = originalHandler;
        const typedMsg = msg as { ready?: boolean };
        if (typedMsg.ready) {
          onReady(typedMsg);
        } else {
          originalHandler(msg);
        }
      };
    });
  }

  /**
   * Stop the native worker process.
   */
  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.cleanup();
  }

  /**
   * Send an RPC request to the worker.
   *
   * @param method - Method name to call
   * @param args - Arguments to pass
   * @param timeoutMs - Host-side transport deadline
   * @param signal - Optional cancellation for preemptible worker calls
   * @returns Promise resolving to the result
   */
  async call<T>(
    method: string,
    args: unknown[] = [],
    timeoutMs: number = QUERY_TIMEOUT,
    signal?: AbortSignal
  ): Promise<T> {
    if (!this.process || !this.process.stdin) {
      throw new Error('Native worker not running');
    }
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
    }

    const id = ++this.messageId;

    return new Promise((resolve, reject) => {
      const removeAbortListener = () => {
        if (signal && abortListener) {
          signal.removeEventListener('abort', abortListener);
        }
      };
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        removeAbortListener();
        const timeoutError = new InvocationTimeoutError(
          method,
          method === 'queryBounded'
            ? `Query execution timed out after ${timeoutMs}ms`
            : `Request ${method} timed out`
        );
        // open performs the capability probe before serving any useful work.
        // Once its caller has abandoned the request, the process has no valid
        // consumer and may otherwise keep running the probe to 41M rows.
        if (method === 'open') this.stop();
        reject(timeoutError);
      }, timeoutMs);

      const abortListener = signal && method === 'queryBounded'
        ? () => {
            if (!this.pendingRequests.has(id) || !this.process?.stdin) return;
            const cancelId = ++this.messageId;
            writeMessage(this.process.stdin, {
              id: cancelId,
              method: 'cancel',
              args: [id]
            });
          }
        : undefined;

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
        signal,
        abortListener
      });

      if (abortListener) signal!.addEventListener('abort', abortListener, { once: true });

      writeMessage(this.process!.stdin!, { id, method, args });
    });
  }

  /**
   * Handle incoming data from stdout.
   */
  private handleData(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.chunksTotalLength += chunk.length;

    while (this.chunksTotalLength >= HEADER_SIZE) {
      if (this.expectedLength < 0) {
        // Read length header
        if (this.chunks[0].length >= HEADER_SIZE) {
          // Fast path: header is in the first chunk
          this.expectedLength = this.chunks[0].readUInt32BE(0);
        } else {
          // Slow path: header is split across chunks
          const header = Buffer.alloc(HEADER_SIZE);
          let copied = 0;
          for (const c of this.chunks) {
            const len = Math.min(c.length, HEADER_SIZE - copied);
            c.copy(header, copied, 0, len);
            copied += len;
            if (copied === HEADER_SIZE) break;
          }
          this.expectedLength = header.readUInt32BE(0);
        }
      }

      const totalNeeded = HEADER_SIZE + this.expectedLength;
      if (this.chunksTotalLength < totalNeeded) {
        // Need more data
        break;
      }

      // We have the full message
      // Note: We concat only when we have the full message, avoiding O(N^2) copying for large payloads
      const fullBuffer = Buffer.concat(this.chunks);
      const body = fullBuffer.subarray(HEADER_SIZE, totalNeeded);

      // Deserialize and handle
      try {
        const msg = v8.deserialize(body);
        this.handleMessage(msg);
      } catch (err) {
        console.error('[NativeWorker] Failed to deserialize message:', err);
      }

      // Handle remaining data
      const remaining = fullBuffer.subarray(totalNeeded);
      this.chunks = [];
      this.chunksTotalLength = 0;
      this.expectedLength = -1;

      if (remaining.length > 0) {
        this.chunks.push(remaining);
        this.chunksTotalLength = remaining.length;
      }
    }
  }

  /**
   * Handle a parsed message.
   */
  private handleMessage(msg: unknown): void {
    const typedMsg = msg as {
      id?: number;
      result?: unknown;
      error?: string;
      cancelled?: boolean;
    };

    if (typedMsg.id === undefined) {
      return;
    }

    const pending = this.pendingRequests.get(typedMsg.id);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(typedMsg.id);
    clearTimeout(pending.timeout);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener('abort', pending.abortListener);
    }

    if (typedMsg.cancelled) {
      pending.reject(
        pending.signal?.reason ?? new DOMException('The operation was aborted', 'AbortError')
      );
    } else if (typedMsg.error) {
      pending.reject(new Error(typedMsg.error));
    } else {
      pending.resolve(typedMsg.result);
    }
  }

  /**
   * Clean up pending requests.
   */
  private cleanup(): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      if (pending.signal && pending.abortListener) {
        pending.signal.removeEventListener('abort', pending.abortListener);
      }
      pending.reject(new Error('Native worker stopped'));
    }
    this.pendingRequests.clear();
  }
}

// ============================================================================
// Database Connection Factory
// ============================================================================

interface NativeQueryResult {
  columns: string[];
  values: CellValue[][];
  rowCount?: number;
  exactIntegerTexts?: ExactIntegerTextMap;
}

interface NativeQueryBatchResult {
  results: NativeQueryResult[];
}

// Helper to safely map rows by column name
/** @internal */
export function mapRowsByName<T = Record<string, CellValue>>(result: NativeQueryResult | undefined | null, mapping: Record<string, string>): T[] {
  if (!result || !result.columns || !result.values) return [];

  const headers = result.columns;
  const headerMap = new Map(headers.map((h, i) => [h, i]));

  return result.values.map((row) => {
    const obj: Record<string, CellValue> = {};
    for (const [targetProp, sourceCol] of Object.entries(mapping)) {
      const idx = headerMap.get(sourceCol);
      if (idx !== undefined) {
        obj[targetProp] = row[idx];
      }
    }
    return obj as T;
  });
}

/**
 * Check if native SQLite is available on this platform.
 *
 * @param extensionPath - Extension installation directory
 * @returns True if native binary is available
 */
export async function isNativeAvailable(extensionPath: string): Promise<boolean> {
  if (uiKindToString(vsc.env.uiKind) === 'web') {
    return false;
  }
  return (await getNativeBinaryPath(extensionPath)) !== null;
}

/**
 * Create a native database connection.
 *
 * Spawns the txiki-js runtime and establishes communication.
 *
 * @param extensionUri - Extension installation directory URI
 * @param _reporter - Optional telemetry reporter
 * @param outputChannel - Optional extension output channel for worker diagnostics
 * @returns Connection bundle with native worker
 */
export async function createNativeDatabaseConnection(
  extensionUri: vsc.Uri,
  _reporter?: TelemetryReporter,
  outputChannel?: vsc.OutputChannel | null,
  queryTimeout: number = DEFAULT_QUERY_TIMEOUT_MS
): Promise<DatabaseConnectionBundle> {
  const extensionPath = extensionUri.fsPath;
  const binaryPath = await getNativeBinaryPath(extensionPath);

  if (!binaryPath) {
    throw new Error('Native SQLite not available on this platform');
  }

  const workerScript = path.join(extensionPath, 'natives', 'native-worker.js');

  // Verify worker script exists
  if (!fs.existsSync(workerScript)) {
    throw new Error('Native worker script not found');
  }

  // Create and start worker
  const worker = new NativeWorkerProcess(binaryPath, workerScript);
  await worker.start();

  // Termination handler
  const terminateWorker = () => {
    worker.stop();
  };

  return {
    workerMethods: {
      initializeDatabase: async (...args: unknown[]) => worker.call('open', args),
      runQuery: async (...args: unknown[]) => worker.call('query', args),
      exportDatabase: async (...args: unknown[]) => worker.call('export', args),
      [Symbol.dispose]: terminateWorker
    },

    /**
     * Establish a database connection through the native worker.
     */
    async establishConnection(
      fileUri: vsc.Uri,
      displayName: string,
      forceReadOnly?: boolean,
      _autoCommit?: boolean
    ) {
      const filePath = fileUri.fsPath;

      // Open database
      // Note: If this fails (e.g., SQLite error 14: unable to open database file),
      // the error will propagate up. Common causes on macOS:
      // - File doesn't exist
      // - Permission denied (sandboxing, Gatekeeper)
      // - File is locked by another process
      // - Path encoding issues with special characters
      try {
        await worker.call('open', [filePath, forceReadOnly ?? false]);
      } catch (err) {
        // Re-throw with more context to help debugging
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to open database "${displayName}": ${message}. Path: ${filePath}`, { cause: err });
      }

      // Public mutating operations are wrapped below with a per-connection
      // promise-chain lock. The raw implementation is used for internal
      // facade-to-facade calls so composite operations do not deadlock.
      const createSavepointName = (prefix: string): string => (
        escapeIdentifier(`${prefix}_${crypto.randomUUID().replace(/-/g, '')}`)
      );

      const safeRollbackSavepoint = async (savepointName: string, context: string): Promise<void> => {
        try {
          await worker.call('run', [`ROLLBACK TO ${savepointName}`]);
          await worker.call('run', [`RELEASE ${savepointName}`]);
        } catch (rollbackErr) {
          const message = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
          outputChannel?.appendLine(`[NativeWorker] Failed to rollback native savepoint (${context}): ${message}`);
        }
      };

      const findNativeViewDefinition = async (
        view: string,
        allowUnparsed: boolean = false
      ): Promise<ViewDefinition | null> => {
        const metadataQueries = [
          {
            sql: "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = ?",
            params: [view]
          },
          ...VIEW_TRIGGER_SCHEMA_QUERIES.map(source => ({
            sql: source.sql,
            params: source.params(view)
          }))
        ];
        const metadata = await worker.call<NativeQueryBatchResult>('queryBatch', [metadataQueries]);
        if (!metadata?.results || metadata.results.length < metadataQueries.length) {
          throw new Error('View definition fetch failed: queryBatch returned incomplete results');
        }

        const viewResult = metadata.results[0];
        const createSql = viewResult.values?.[0]?.[0];
        if (typeof createSql !== 'string') {
          return null;
        }

        const { triggers, ambiguousTemporaryTriggerNames } = mapViewTriggerRows(
          view,
          VIEW_TRIGGER_SCHEMA_QUERIES.map((_, index) => (
            metadata.results[index + 1].values ?? []
          ))
        );

        let selectSql: string;
        let columnListSql: string | undefined;
        try {
          selectSql = extractViewSelectSql(createSql);
          columnListSql = extractViewColumnListSql(createSql);
        } catch (err) {
          if (!allowUnparsed) throw err;
          selectSql = '';
        }
        return {
          identifier: view,
          sql: createSql,
          selectSql,
          columnListSql,
          triggers,
          ...(ambiguousTemporaryTriggerNames.length > 0
            ? { ambiguousTemporaryTriggerNames }
            : {})
        };
      };

      const getNativeViewDefinition = async (
        view: string,
        allowUnparsed: boolean = false
      ): Promise<ViewDefinition> => {
        const definition = await findNativeViewDefinition(view, allowUnparsed);
        if (!definition) throw new Error(`View not found: ${view}`);
        return definition;
      };

      /** Resolve one canonical installed-view snapshot for intent checks and column preservation. */
      const resolveExistingViewForIntent = async (
        view: string,
        intent: ViewDefinitionIntent
      ): Promise<{ storedSql: CellValue | undefined; columnListSql: string | undefined }> => {
        const result = await worker.call<NativeQueryResult>('query', [
          "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = ?",
          [view]
        ]);
        const row = result.values?.[0];
        assertViewDefinitionIntent(view, row !== undefined, intent);
        const storedSql = row?.[0];
        return {
          storedSql,
          columnListSql: typeof storedSql === 'string'
            ? extractViewColumnListSql(storedSql)
            : undefined
        };
      };

      const getNativeColumnNames = async (
        table: string,
        qualifyMain: boolean = false
      ): Promise<string[]> => {
        const pragma = qualifyMain ? 'PRAGMA main.table_info' : 'PRAGMA table_info';
        const info = await worker.call<NativeQueryResult>('query', [
          `${pragma}(${escapeIdentifier(table)})`
        ]);
        const nameIndex = info.columns.indexOf('name');
        if (nameIndex < 0 && (info.values?.length ?? 0) > 0) {
          throw new Error('SQLite returned table metadata without a column name field');
        }
        return (info.values ?? []).map(row => {
          const name = row[nameIndex];
          if (typeof name !== 'string') {
            throw new Error('SQLite returned invalid column metadata');
          }
          return name;
        });
      };

      const getNativeTableInfo = async (table: string): Promise<ColumnMetadata[]> => {
        const result = await worker.call<NativeQueryResult>('query', [
          `PRAGMA table_info(${escapeIdentifier(table)})`
        ]);
        const index = {
          cid: result.columns.indexOf('cid'),
          name: result.columns.indexOf('name'),
          type: result.columns.indexOf('type'),
          notnull: result.columns.indexOf('notnull'),
          dfltValue: result.columns.indexOf('dflt_value'),
          pk: result.columns.indexOf('pk')
        };
        return (result.values ?? []).map(row => ({
          ordinal: (index.cid >= 0 ? row[index.cid] : row[0]) as number,
          identifier: (index.name >= 0 ? row[index.name] : row[1]) as string,
          declaredType: (index.type >= 0 ? row[index.type] : row[2]) as string,
          isRequired: (index.notnull >= 0 ? row[index.notnull] : row[3]) as number,
          defaultExpression: index.dfltValue >= 0 ? row[index.dfltValue] : row[4],
          primaryKeyPosition: (index.pk >= 0 ? row[index.pk] : row[5]) as number
        }));
      };

      const getNativeInsertableColumnNames = async (table: string): Promise<string[]> => {
        const result = await worker.call<NativeQueryResult>('query', [
          'SELECT name FROM pragma_table_xinfo(?) ' +
          'WHERE hidden NOT IN (2, 3) ORDER BY cid',
          [table]
        ]);
        return (result.values ?? []).map(row => {
          if (typeof row[0] !== 'string') {
            throw new Error(`SQLite returned invalid column metadata for ${table}`);
          }
          return row[0];
        });
      };

      const findNativeTableIdentity = async (table: string): Promise<TableIdentity | undefined> => {
        const metadata = await worker.call<NativeQueryResult>('query', [
          `SELECT "type", "wr" FROM pragma_table_list ` +
          `WHERE "schema" = 'main' AND "name" = ? LIMIT 1`,
          [table]
        ]);
        if ((metadata.values?.length ?? 0) === 0) return undefined;
        const kind = classifyTableIdentity(metadata.values[0][0], metadata.values[0][1]);
        if (!kind) return undefined;
        if (kind === 'rowid') return { kind: 'rowid' };
        const columns = primaryKeyColumnsFromTableInfo(await getNativeTableInfo(table));
        if (columns.length === 0) {
          throw new Error(`WITHOUT ROWID table ${table} has no declared primary key`);
        }
        return { kind: 'primaryKey', columns };
      };

      const resolveNativeTableIdentity = async (table: string): Promise<TableIdentity> => {
        const identity = await findNativeTableIdentity(table);
        if (!identity) throw new Error(`Table not found: ${table}`);
        return identity;
      };

      const buildNativeCellLocator = (
        rowId: RecordId,
        identity: TableIdentity
      ): {
        kind: 'rowid'; value: CellValue;
      } | {
        kind: 'primaryKey'; columns: string[]; values: CellValue[];
      } => {
        const predicate = buildRecordIdentityPredicate(rowId, identity);
        return identity.kind === 'rowid'
          ? { kind: 'rowid', value: predicate.params[0] }
          : {
              kind: 'primaryKey',
              columns: identity.columns.map(column => column.identifier),
              values: predicate.params
            };
      };

      const readNativeCellMetadata = async (
        table: string,
        rowId: RecordId,
        column: string,
        identity?: TableIdentity
      ): Promise<CellMetadata> => worker.call<CellMetadata>('getCellMetadata', [
        table,
        column,
        buildNativeCellLocator(rowId, identity ?? await resolveNativeTableIdentity(table))
      ]);

      const assertNativeCellPriorWithinEditLimit = async (
        table: string,
        rowId: RecordId,
        column: string,
        editLimitBytes: number,
        identity?: TableIdentity
      ): Promise<void> => {
        const metadata = await readNativeCellMetadata(table, rowId, column, identity);
        if (
          (metadata.storageClass === 'text' || metadata.storageClass === 'blob')
          && metadata.byteLength > editLimitBytes
        ) {
          throw new OversizedCellReplacementRequiredError(
            table,
            column,
            metadata.storageClass,
            metadata.byteLength,
            editLimitBytes
          );
        }
      };

      const assertNativeBatchPriorsWithinEditLimit = async (
        table: string,
        updates: readonly CellUpdate[],
        editLimitBytes: number,
        identity: TableIdentity
      ): Promise<void> => {
        const seen = new Set<string>();
        for (const update of updates) {
          const key = `${String(update.rowId)}\0${update.column}`;
          if (seen.has(key)) continue;
          seen.add(key);
          await assertNativeCellPriorWithinEditLimit(
            table,
            update.rowId,
            update.column,
            editLimitBytes,
            identity
          );
        }
      };

      const queryNativeSingleStatement = async <T>(
        sql: string,
        params?: CellValue[]
      ): Promise<T> => {
        const boundary = `/*sqlite_explorer_boundary_${crypto.randomUUID().replace(/-/g, '')}*/`;
        return worker.call<T>('querySingle', [`${sql}\n${boundary}`, params, boundary]);
      };

      const runNativeSingleStatement = async (sql: string, params?: CellValue[]): Promise<void> => {
        const boundary = `/*sqlite_explorer_boundary_${crypto.randomUUID().replace(/-/g, '')}*/`;
        await worker.call('runSingle', [`${sql}\n${boundary}`, sql, params, boundary]);
      };

      const readNativePrimaryKeyRecordId = async (
        table: string,
        identity: Extract<TableIdentity, { kind: 'primaryKey' }>,
        predicate: { sql: string; params: CellValue[] }
      ): Promise<RecordId> => {
        const result = await worker.call<NativeQueryResult>('query', [
          `SELECT ${identity.columns.map(column => escapeIdentifier(column.identifier)).join(', ')} ` +
          `FROM ${escapeIdentifier(table)} WHERE ${predicate.sql} LIMIT 2`,
          predicate.params
        ]);
        if (result.values.length !== 1) {
          throw new Error(
            result.values.length === 0
              ? `Updated row in ${table} no longer exists`
              : `Primary-key identity for ${table} matched more than one row`
          );
        }
        return encodePrimaryKeyRecordId(identity.columns, result.values[0]);
      };

      const applyNativeJsonPatchValue = (currentValue: CellValue, patch: CellValue): string => {
        const currentObject = parseJsonValueForPatching(currentValue, 'updateCellBatch');
        const patchObject = typeof patch === 'string' ? JSON.parse(patch) : patch;
        return JSON.stringify(applyMergePatch(currentObject, patchObject));
      };

      const updateNativePrimaryKeyCellBatch = async (
        table: string,
        identity: Extract<TableIdentity, { kind: 'primaryKey' }>,
        updates: CellUpdate[],
        maxEditValueBytes?: number,
        historyReplayToken?: typeof HISTORY_REPLAY_EDIT_TOKEN
      ): Promise<CellUpdateResult[]> => {
        const isHistoryReplay = historyReplayToken === HISTORY_REPLAY_EDIT_TOKEN;
        const editLimitBytes = isHistoryReplay
          ? 0
          : assertCellValuesWithinEditLimit(
              updates.map(update => update.value),
              maxEditValueBytes
            );
        const savepointName = createSavepointName('sp_update_pk_batch');
        await worker.call('run', [`SAVEPOINT ${savepointName}`]);
        try {
          // Keep the existing full prior-value read below for bounded history,
          // but refuse oversized priors from metadata before it can run.
          if (!isHistoryReplay && maxEditValueBytes !== undefined) {
            await assertNativeBatchPriorsWithinEditLimit(
              table,
              updates,
              editLimitBytes,
              identity
            );
          }
          const updatesByRow = new Map<RecordId, CellUpdate[]>();
          for (const update of updates) {
            const rowUpdates = updatesByRow.get(update.rowId) ?? [];
            rowUpdates.push(update);
            updatesByRow.set(update.rowId, rowUpdates);
          }

          const results: CellUpdateResult[] = [];
          for (const [rowId, rowUpdates] of updatesByRow) {
            const oldPredicate = buildRecordIdentityPredicate(rowId, identity);
            const columns = [...new Set(rowUpdates.map(update => update.column))];
            if (columns.length !== rowUpdates.length) {
              throw new Error(`Batch update for ${table} contains the same column more than once`);
            }
            const current = await worker.call<NativeQueryResult>('query', [
              `SELECT ${columns.map(escapeIdentifier).join(', ')} ` +
              `FROM ${escapeIdentifier(table)} WHERE ${oldPredicate.sql} LIMIT 2`,
              oldPredicate.params
            ]);
            if (current.values.length !== 1) {
              throw new Error(`Cannot update ${table}: row identity no longer exists`);
            }

            const preparedUpdates = rowUpdates.map((update, index) => {
              const priorValue = current.values[0][index];
              const prepared = prepareCellUpdateForStorage(
                update.value,
                priorValue,
                update.operation ?? 'set'
              );
              const storedValue = prepared.operation === 'json_patch'
                ? applyNativeJsonPatchValue(priorValue, prepared.value)
                : prepared.value;
              if (!isHistoryReplay && prepared.operation === 'json_patch') {
                // Validate the merged value, not only its bounded patch payload.
                assertCellValueWithinEditLimit(storedValue, editLimitBytes);
              }
              return { update, priorValue, prepared, storedValue };
            });
            await worker.call('run', [
              `UPDATE ${escapeIdentifier(table)} SET ` +
              `${preparedUpdates.map(({ update }) => `${escapeIdentifier(update.column)} = ?`).join(', ')} ` +
              `WHERE ${oldPredicate.sql}`,
              [
                ...preparedUpdates.map(update => update.storedValue),
                ...oldPredicate.params
              ]
            ]);

            const candidateValues = [...oldPredicate.primaryKey!.values];
            for (const preparedUpdate of preparedUpdates) {
              const keyIndex = identity.columns.findIndex(
                keyColumn => keyColumn.identifier === preparedUpdate.update.column
              );
              if (keyIndex >= 0) candidateValues[keyIndex] = preparedUpdate.storedValue;
            }
            const candidateId = encodePrimaryKeyRecordId(identity.columns, candidateValues);
            const newRowId = await readNativePrimaryKeyRecordId(
              table,
              identity,
              buildRecordIdentityPredicate(candidateId, identity)
            );
            for (const preparedUpdate of preparedUpdates) {
              results.push({
                rowId,
                newRowId,
                columnName: preparedUpdate.update.column,
                priorValue: preparedUpdate.priorValue,
                newValue: preparedUpdate.prepared.value,
                operation: preparedUpdate.prepared.operation
              });
            }
          }

          await worker.call('run', [`RELEASE ${savepointName}`]);
          return results;
        } catch (error) {
          await safeRollbackSavepoint(savepointName, 'updateNativePrimaryKeyCellBatch');
          throw error;
        }
      };

      const queryNativeBoundedStatement = async (
        sql: string,
        columns: string[],
        limit: number
      ): Promise<NativeQueryResult> => {
        const transportQuery = buildExactNumericTextQuery(sql, columns.length);
        const boundary = `/*sqlite_explorer_boundary_${crypto.randomUUID().replace(/-/g, '')}*/`;
        return worker.call<NativeQueryResult>('queryBounded', [
          `${transportQuery.sql}\n${boundary}`,
          transportQuery.sql,
          boundary,
          transportQuery.transportColumns,
          transportQuery.valueColumnCount,
          limit,
          queryTimeout
        ], queryTimeout + BOUNDED_QUERY_TRANSPORT_MARGIN_MS);
      };

      const compileNativeViewSelect = async (selectSql: string): Promise<void> => {
        await queryNativeSingleStatement(`EXPLAIN SELECT * FROM (${selectSql}\n) LIMIT 0`);
      };

      const compileNativeView = async (view: string): Promise<void> => {
        await queryNativeSingleStatement(
          `EXPLAIN SELECT * FROM ${escapeMainViewIdentifier(view)}`
        );
      };

      const applyNativeViewHistoryState = async (
        view: string,
        expectedCurrent: ViewDefinition | null,
        replacement: ViewDefinition | null
      ): Promise<void> => {
        const savepointName = createSavepointName('sp_restore_view');
        await worker.call('run', [`SAVEPOINT ${savepointName}`]);
        try {
          const current = await findNativeViewDefinition(view, true);
          if (current) assertViewTriggerSnapshotIsMutationSafe(current);
          assertViewDefinitionStateCurrent(expectedCurrent, current);
          if (current) {
            await worker.call('run', [`DROP VIEW ${escapeMainViewIdentifier(view)}`]);
          }
          if (replacement) {
            await runNativeSingleStatement(replacement.sql);
            await compileNativeView(replacement.identifier);
            for (const trigger of replacement.triggers) {
              await runNativeSingleStatement(buildCreateViewTriggerSql(trigger));
            }
          }
          await worker.call('run', [`RELEASE ${savepointName}`]);
        } catch (err) {
          await safeRollbackSavepoint(savepointName, 'restoreViewDefinition');
          throw err;
        }
      };

      const rawOperations: DatabaseOperations = {
        engineKind: Promise.resolve('native'),

        executeQuery: async (sql: string, params?: CellValue[]): Promise<QueryResultSet[]> => {
          const result = await worker.call<NativeQueryResult>('query', [sql, params]);

          // Return in QueryResultSet format with multiple property names for compatibility:
          // - headers/rows: new naming convention from src/core/types.ts
          // - columns/values: sql.js compatible aliases
          // - columnNames/records: used by webview (core/ui/viewer.html) for schema queries
          return [{
            headers: result.columns,
            rows: result.values,
            columns: result.columns,
            values: result.values,
            columnNames: result.columns,
            records: result.values
          }];
        },

        getCellMetadata: async (target: CellReadTarget): Promise<CellMetadata> => {
          validateCellReadTarget(target);
          return readNativeCellMetadata(target.table, target.rowId, target.column);
        },

        openCellReadSession: async (target: CellReadTarget): Promise<CellReadSession> => {
          validateCellReadTarget(target);
          const identity = await resolveNativeTableIdentity(target.table);
          const predicate = buildRecordIdentityPredicate(target.rowId, identity);
          const locator = identity.kind === 'rowid'
            ? { kind: 'rowid' as const, value: predicate.params[0] }
            : {
                kind: 'primaryKey' as const,
                columns: identity.columns.map(column => column.identifier),
                values: predicate.params
              };
          return worker.call<CellReadSession>('openCellReadSession', [
            target.table,
            target.column,
            locator
          ]);
        },

        readCellChunk: async (
          sessionId: string,
          byteOffset: number,
          maxBytes: number
        ): Promise<CellReadChunk> => {
          validateCellReadWindow(byteOffset, maxBytes);
          return worker.call<CellReadChunk>('readCellChunk', [
            sessionId,
            byteOffset,
            maxBytes
          ]);
        },

        closeCellReadSession: async (sessionId: string): Promise<void> => {
          await worker.call('closeCellReadSession', [sessionId]);
        },

        serializeDatabase: async (): Promise<Uint8Array> => {
          const result = await worker.call<{ content: Uint8Array }>('export', []);
          return result.content;
        },

        applyModifications: async () => {},

        /**
         * Undo a modification by executing the inverse SQL.
         */
        undoModification: async (mod: ModificationEntry) => {
          const { modificationType, targetTable, targetRowId, newTargetRowId, targetColumn, priorValue, newValue, operation, affectedCells, deletedRows, columnDef, deletedColumns } = mod;
          if (!targetTable) return;

          switch (modificationType) {
            case 'cell_update': {
              // Keep this undo interpretation paired with
              // WasmDatabaseEngine.undoCellUpdate so ModificationEntry
              // fields keep one interpretation across desktop and web undo.
              const computeUndoValue = (
                currentValue: CellValue,
                cellPrior: CellValue | undefined,
                cellNew: CellValue | undefined,
                cellOperation: ModificationEntry['operation']
              ): CellValue => {
                if (cellOperation === 'json_patch') {
                  const plan = computeJsonPatchUndo(currentValue, cellNew, cellPrior);
                  if (plan.kind === 'restore') {
                    return plan.value;
                  }
                }
                return cellPrior ?? null;
              };

              if (affectedCells) {
                // A later forward transition may occupy a key vacated by an
                // earlier row. Reverse only identity-changing batches so
                // ordinary edit replay retains its established call order.
                const hasIdentityTransition = affectedCells.some(cell => (
                  cell.newRowId !== undefined && cell.newRowId !== cell.rowId
                ));
                const undoCells = hasIdentityTransition
                  ? [...affectedCells].reverse()
                  : affectedCells;
                const currentRowIds = undoCells.map(cell => cell.newRowId ?? cell.rowId);
                const usesPrimaryKey = currentRowIds.some(isPrimaryKeyRecordId);
                if (usesPrimaryKey && !currentRowIds.every(isPrimaryKeyRecordId)) {
                  throw new Error('Cannot mix rowid and primary-key row identities');
                }
                const identity = usesPrimaryKey
                  ? await resolveNativeTableIdentity(targetTable)
                  : { kind: 'rowid' } as const;
                const patchCells = undoCells.filter(cell => cell.operation === 'json_patch');
                let patchReads: NativeQueryBatchResult | undefined;
                if (patchCells.length > 0) {
                  patchReads = await worker.call<NativeQueryBatchResult>('queryBatch', [
                    patchCells.map(cell => {
                      const currentRowId = cell.newRowId ?? cell.rowId;
                      const predicate = buildRecordIdentityPredicate(currentRowId, identity);
                      return {
                        sql:
                          `SELECT ${escapeIdentifier(cell.columnName)} ` +
                          `FROM ${escapeIdentifier(targetTable)} WHERE ${predicate.sql}`,
                        params: predicate.params
                      };
                    })
                  ]);
                  if (patchReads.results?.length !== patchCells.length) {
                    throw new Error('JSON patch undo read returned incomplete results');
                  }
                }
                const updates: CellUpdate[] = [];
                let patchIndex = 0;
                for (const cell of undoCells) {
                  const currentRowId = cell.newRowId ?? cell.rowId;
                  let value = cell.priorValue ?? null;
                  if (cell.operation === 'json_patch') {
                    const read = patchReads!.results[patchIndex++];
                    value = computeUndoValue(
                      (read.values[0]?.[0] ?? null) as CellValue,
                      cell.priorValue,
                      cell.newValue,
                      cell.operation
                    );
                  }
                  updates.push({ rowId: currentRowId, column: cell.columnName, value });
                }
                if (usesPrimaryKey) {
                  await updateNativePrimaryKeyCellBatch(
                    targetTable,
                    identity as Extract<TableIdentity, { kind: 'primaryKey' }>,
                    updates,
                    undefined,
                    HISTORY_REPLAY_EDIT_TOKEN
                  );
                } else {
                  await worker.call('execBatch', [updates.map(update => ({
                    sql:
                      `UPDATE ${escapeIdentifier(targetTable)} ` +
                      `SET ${escapeIdentifier(update.column)} = ? WHERE rowid = ?`,
                    params: [update.value, validateRowId(update.rowId)]
                  }))]);
                }
              } else if (targetRowId !== undefined && targetColumn) {
                const currentRowId = newTargetRowId ?? targetRowId;
                let value = priorValue ?? null;
                if (operation === 'json_patch') {
                  const identity = isPrimaryKeyRecordId(currentRowId)
                    ? await resolveNativeTableIdentity(targetTable)
                    : { kind: 'rowid' } as const;
                  const predicate = buildRecordIdentityPredicate(currentRowId, identity);
                  const read = await worker.call<NativeQueryResult>('query', [
                    `SELECT ${escapeIdentifier(targetColumn)} ` +
                    `FROM ${escapeIdentifier(targetTable)} WHERE ${predicate.sql}`,
                    predicate.params
                  ]);
                  const currentValue = (read.values[0]?.[0] ?? null) as CellValue;
                  value = computeUndoValue(currentValue, priorValue, newValue, operation);
                }
                await updateNativeCellForHistory(
                  rawOperations,
                  targetTable,
                  currentRowId,
                  targetColumn,
                  value
                );
              }
              break;
            }

            case 'row_insert':
              if (targetRowId !== undefined) {
                await rawOperations.deleteRows(targetTable, [targetRowId]);
              }
              break;

            case 'row_delete':
              if (deletedRows && deletedRows.length > 0) {
                await insertNativeRowBatchForHistory(
                  rawOperations,
                  targetTable,
                  deletedRows.map(dr => dr.row)
                );
              }
              break;

            case 'column_add':
              if (targetColumn) {
                await worker.call('run', [`ALTER TABLE ${escapeIdentifier(targetTable)} DROP COLUMN ${escapeIdentifier(targetColumn)}`]);
              }
              break;

            case 'column_drop':
                if (deletedColumns) {
                    const batch = [];
                    // 1. Add columns back
                    for (const col of deletedColumns) {
                        validateSqlType(col.type); // Validate type
                        batch.push({
                            sql: `ALTER TABLE ${escapeIdentifier(targetTable)} ADD COLUMN ${escapeIdentifier(col.name)} ${col.type}`
                        });
                    }
                    // 2. Restore values
                    for (const col of deletedColumns) {
                        for (const { rowId, value } of col.data) {
                            batch.push({
                                sql: `UPDATE ${escapeIdentifier(targetTable)} SET ${escapeIdentifier(col.name)} = ? WHERE rowid = ?`,
                                params: [value, validateRowId(rowId)]
                            });
                        }
                    }
                    if (batch.length > 0) {
                        await worker.call('execBatch', [batch]);
                    }
                }
                break;

            case 'table_create':
                await worker.call('run', [`DROP TABLE IF EXISTS ${escapeIdentifier(targetTable)}`]);
                break;

            case 'view_create':
                if (mod.viewDefAfter) {
                  await applyNativeViewHistoryState(targetTable, mod.viewDefAfter, null);
                } else {
                  outputChannel?.appendLine('[NativeWorker] Skipping view undo: definition missing from history entry');
                }
                break;

            case 'view_edit':
                if (mod.viewDefBefore && mod.viewDefAfter) {
                  await applyNativeViewHistoryState(
                    targetTable,
                    mod.viewDefAfter,
                    mod.viewDefBefore
                  );
                } else {
                  outputChannel?.appendLine('[NativeWorker] Skipping view undo: definition missing from history entry');
                }
                break;

            case 'view_drop':
                if (mod.viewDefBefore) {
                  await applyNativeViewHistoryState(targetTable, null, mod.viewDefBefore);
                } else {
                  outputChannel?.appendLine('[NativeWorker] Skipping view undo: definition missing from history entry');
                }
                break;
          }
        },

        /**
         * Redo a modification by re-executing the original change.
         */
        redoModification: async (mod: ModificationEntry) => {
          const { modificationType, targetTable, targetRowId, targetColumn, newValue, operation, affectedCells, affectedRowIds, rowData, tableDef, columnDef, deletedColumns, droppedIndexes } = mod;
          if (!targetTable) return;

          // Keep this non-strict forward replay switch paired with
          // WasmDatabaseEngine.forwardApply(..., false) so ModificationEntry
          // fields keep one interpretation across desktop and web redo.
          const normalizeReplayCellOperation = (replayOperation: unknown): 'set' | 'json_patch' => {
            return replayOperation === 'json_patch' ? 'json_patch' : 'set';
          };

          switch (modificationType) {
            case 'cell_update':
              if (affectedCells) {
                await updateNativeCellBatchForHistory(rawOperations, targetTable, affectedCells.map(c => ({
                  rowId: c.rowId,
                  column: c.columnName,
                  value: c.newValue ?? null,
                  operation: normalizeReplayCellOperation(c.operation)
                })));
              } else if (targetRowId !== undefined && targetColumn) {
                const replayOperation = normalizeReplayCellOperation(operation);
                if (replayOperation === 'json_patch') {
                  const patch = typeof newValue === 'string' ? newValue : JSON.stringify(newValue ?? null);
                  await updateNativeCellForHistory(
                    rawOperations,
                    targetTable,
                    targetRowId,
                    targetColumn,
                    null,
                    patch
                  );
                } else {
                  await updateNativeCellForHistory(
                    rawOperations,
                    targetTable,
                    targetRowId,
                    targetColumn,
                    newValue ?? null
                  );
                }
              }
              break;

            case 'row_insert':
              if (rowData) {
                const dataToInsert = targetRowId !== undefined && !isPrimaryKeyRecordId(targetRowId)
                  ? { ...rowData, rowid: targetRowId }
                  : rowData;
                await insertNativeRowForHistory(rawOperations, targetTable, dataToInsert);
              }
              break;

            case 'row_delete':
              if (affectedRowIds) {
                await rawOperations.deleteRows(targetTable, affectedRowIds);
              }
              break;

            case 'column_add':
              if (targetColumn && columnDef) {
                await rawOperations.addColumn(targetTable, targetColumn, columnDef.type, columnDef.defaultValue);
              }
              break;

            case 'column_drop':
              if (deletedColumns) {
                await rawOperations.deleteColumns(targetTable, deletedColumns.map(c => c.name), droppedIndexes ?? undefined);
              }
              break;

            case 'table_create':
              if (tableDef && tableDef.columns) {
                await rawOperations.createTable(targetTable, tableDef.columns);
              }
              break;

            case 'view_create':
              if (mod.viewDefAfter) {
                await applyNativeViewHistoryState(targetTable, null, mod.viewDefAfter);
              } else {
                outputChannel?.appendLine('[NativeWorker] Skipping view redo: definition missing from history entry');
              }
              break;

            case 'view_edit':
              if (mod.viewDefBefore && mod.viewDefAfter) {
                await applyNativeViewHistoryState(
                  targetTable,
                  mod.viewDefBefore,
                  mod.viewDefAfter
                );
              } else {
                outputChannel?.appendLine('[NativeWorker] Skipping view redo: definition missing from history entry');
              }
              break;

            case 'view_drop':
              if (mod.viewDefBefore) {
                await applyNativeViewHistoryState(targetTable, mod.viewDefBefore, null);
              } else {
                outputChannel?.appendLine('[NativeWorker] Skipping view redo: definition missing from history entry');
              }
              break;
          }
        },

        flushChanges: async () => {},
        discardModifications: async (mods: ModificationEntry[]) => {
            for (let i = mods.length - 1; i >= 0; i--) {
                await rawOperations.undoModification(mods[i]);
            }
        },

        /**
         * Update a single cell value.
         */
        updateCell: async (
          table: string,
          rowId: RecordId,
          column: string,
          value: CellValue,
          patch?: string,
          maxEditValueBytes?: number,
          historyReplayToken?: typeof HISTORY_REPLAY_EDIT_TOKEN
        ) => {
          const isHistoryReplay = historyReplayToken === HISTORY_REPLAY_EDIT_TOKEN;
          const enforcePriorPolicy = !isHistoryReplay && maxEditValueBytes !== undefined;
          const editLimitBytes = isHistoryReplay
            ? 0
            : assertCellValuesWithinEditLimit([value], maxEditValueBytes);
          assertMutableRecordId(rowId);
          if (isPrimaryKeyRecordId(rowId)) {
            const identity = await resolveNativeTableIdentity(table);
            if (identity.kind !== 'primaryKey') {
              throw new Error(`Primary-key identity cannot target rowid table ${table}`);
            }
            const result = await updateNativePrimaryKeyCellBatch(table, identity, [{
              rowId,
              column,
              value: patch ?? value,
              operation: patch === undefined ? 'set' : 'json_patch'
            }], maxEditValueBytes, historyReplayToken);
            return result[0]?.newRowId ?? rowId;
          }

          // Validate rowId is a number
          const rowIdNum = validateRowId(rowId);

          let sql: string;
          let params: CellValue[];

          if (patch) {
            // COALESCE handles NULL columns: json_patch(NULL, x) returns NULL,
            // but expected behavior is to treat NULL as empty object (matching WASM path)
            const escapedColumn = escapeIdentifier(column);
            sql =
              `UPDATE ${escapeIdentifier(table)} SET ${escapedColumn} = ` +
              `json_patch(COALESCE(${escapedColumn}, '{}'), ?) WHERE rowid = ?` +
              (enforcePriorPolicy
                ? ` AND NOT (typeof(${escapedColumn}) IN ('text', 'blob') ` +
                  `AND length(CAST(${escapedColumn} AS BLOB)) > ?)`
                : '');
            params = enforcePriorPolicy
              ? [patch, rowIdNum, editLimitBytes]
              : [patch, rowIdNum];
          } else {
            const escapedColumn = escapeIdentifier(column);
            sql =
              `UPDATE ${escapeIdentifier(table)} SET ${escapedColumn} = ? WHERE rowid = ?` +
              (enforcePriorPolicy
                ? ` AND NOT (typeof(${escapedColumn}) IN ('text', 'blob') ` +
                  `AND length(CAST(${escapedColumn} AS BLOB)) > ?)`
                : '');
            params = enforcePriorPolicy
              ? [value, rowIdNum, editLimitBytes]
              : [value, rowIdNum];
          }

          const result = await worker.call<{ changes: number }>('run', [sql, params]);
          if (enforcePriorPolicy && result?.changes !== 1) {
            await assertNativeCellPriorWithinEditLimit(
              table,
              rowIdNum,
              column,
              editLimitBytes,
              { kind: 'rowid' }
            );
            throw new Error(`Cannot update ${table}.${column}: row ${rowId} no longer exists`);
          }
          return rowIdNum;
        },

        replaceOversizedCell: async (
          table: string,
          rowId: RecordId,
          column: string,
          value: CellValue,
          expected: OversizedCellMetadata,
          maxEditValueBytes?: number
        ) => {
          const editLimitBytes = assertCellValuesWithinEditLimit(
            [value],
            maxEditValueBytes
          );
          assertOversizedCellReplacementExpectation(expected, editLimitBytes);
          assertMutableRecordId(rowId);
          const identity = await resolveNativeTableIdentity(table);
          const predicate = buildRecordIdentityPredicate(rowId, identity);
          const locator = buildNativeCellLocator(rowId, identity);

          const updateAndResolveIdentity = async (): Promise<RecordId> => {
            const result = await worker.call<{ changes: number }>('replaceOversizedCell', [
              table,
              column,
              locator,
              value,
              expected,
              editLimitBytes
            ]);
            if (result?.changes !== 1) {
              throw new Error(OVERSIZED_CELL_REPLACEMENT_CONFLICT_MESSAGE);
            }
            if (identity.kind === 'rowid') return validateRowId(rowId);

            const candidateValues = [...predicate.primaryKey!.values];
            const keyIndex = identity.columns.findIndex(key => key.identifier === column);
            if (keyIndex >= 0) candidateValues[keyIndex] = value;
            const candidateId = encodePrimaryKeyRecordId(identity.columns, candidateValues);
            return readNativePrimaryKeyRecordId(
              table,
              identity,
              buildRecordIdentityPredicate(candidateId, identity)
            );
          };

          if (identity.kind === 'rowid') return updateAndResolveIdentity();

          const savepointName = createSavepointName('sp_replace_oversized_cell');
          await worker.call('run', [`SAVEPOINT ${savepointName}`]);
          try {
            const newRowId = await updateAndResolveIdentity();
            await worker.call('run', [`RELEASE ${savepointName}`]);
            return newRowId;
          } catch (error) {
            await safeRollbackSavepoint(savepointName, 'replaceOversizedCell');
            throw error;
          }
        },

        /**
         * Insert a new row.
         */
        insertRow: async (
          table: string,
          data: Record<string, CellValue>,
          maxEditValueBytes?: number,
          historyReplayToken?: typeof HISTORY_REPLAY_EDIT_TOKEN
        ) => {
          if (historyReplayToken !== HISTORY_REPLAY_EDIT_TOKEN) {
            assertCellValuesWithinEditLimit(Object.values(data), maxEditValueBytes);
          }
          const identity = await resolveNativeTableIdentity(table);
          const columns = Object.keys(data);
          let sql: string;
          let params: CellValue[] = [];

          if (columns.length === 0) {
            sql = `INSERT INTO ${escapeIdentifier(table)} DEFAULT VALUES`;
          } else {
            const colNames = columns.map(escapeIdentifier).join(', ');
            const placeholders = columns.map(() => '?').join(', ');
            params = columns.map(col => data[col]);
            sql = `INSERT INTO ${escapeIdentifier(table)} (${colNames}) VALUES (${placeholders})`;
          }

          if (identity.kind === 'primaryKey') {
            const savepointName = createSavepointName('sp_insert_pk_row');
            await worker.call('run', [`SAVEPOINT ${savepointName}`]);
            try {
              const returning = await queryNativeSingleStatement<NativeQueryResult>(
                `${sql} RETURNING ` +
                identity.columns.map(column => escapeIdentifier(column.identifier)).join(', '),
                params
              );
              if (returning.values.length !== 1) {
                throw new Error(`Insert into ${table} did not return exactly one primary-key identity`);
              }
              const candidateId = encodePrimaryKeyRecordId(identity.columns, returning.values[0]);
              const rowId = await readNativePrimaryKeyRecordId(
                table,
                identity,
                buildRecordIdentityPredicate(candidateId, identity)
              );
              await worker.call('run', [`RELEASE ${savepointName}`]);
              return rowId;
            } catch (error) {
              await safeRollbackSavepoint(savepointName, 'insertNativePrimaryKeyRow');
              throw error;
            }
          }

          const result = await worker.call<{
            changes: number;
            lastInsertRowId: number | bigint;
          }>('run', [sql, params]);

          if (result && result.lastInsertRowId !== undefined) {
            return Number(result.lastInsertRowId) as RecordId;
          }
          return undefined;
        },

        /**
         * Insert multiple rows in a batch.
         */
        insertRowBatch: async (
          table: string,
          rows: Record<string, CellValue>[],
          maxEditValueBytes?: number,
          historyReplayToken?: typeof HISTORY_REPLAY_EDIT_TOKEN
        ) => {
          if (rows.length === 0) return;
          if (historyReplayToken !== HISTORY_REPLAY_EDIT_TOKEN) {
            assertCellValuesWithinEditLimit(
              rows.flatMap(row => Object.values(row)),
              maxEditValueBytes
            );
          }

          const batchItems: { sql: string; params: CellValue[] }[] = [];
          const escapedTable = escapeIdentifier(table);

          for (const row of rows) {
            const columns = Object.keys(row);
            let sql: string;
            let params: CellValue[] = [];

            if (columns.length === 0) {
              sql = `INSERT INTO ${escapedTable} DEFAULT VALUES`;
            } else {
              const colNames = columns.map(escapeIdentifier).join(', ');
              const placeholders = columns.map(() => '?').join(', ');
              params = columns.map(col => row[col]);
              sql = `INSERT INTO ${escapedTable} (${colNames}) VALUES (${placeholders})`;
            }
            batchItems.push({ sql, params });
          }

          if (batchItems.length > 0) {
            await worker.call('execBatch', [batchItems]);
          }
        },

        /**
         * Delete rows by ID.
         */
        deleteRows: async (table: string, rowIds: RecordId[]): Promise<DeletedRow[] | void> => {
          rowIds.forEach(assertMutableRecordId);
          if (rowIds.length === 0) return [];

          if (rowIds.some(isPrimaryKeyRecordId)) {
            if (!rowIds.every(isPrimaryKeyRecordId)) {
              throw new Error('Cannot mix rowid and primary-key row identities');
            }
            const identity = await resolveNativeTableIdentity(table);
            if (identity.kind !== 'primaryKey') {
              throw new Error(`Primary-key identity cannot target rowid table ${table}`);
            }
            const predicate = buildRecordIdentitiesPredicate(rowIds, identity);
            const savepointName = createSavepointName('sp_delete_pk_rows');
            await worker.call('run', [`SAVEPOINT ${savepointName}`]);
            try {
              const insertableColumns = await getNativeInsertableColumnNames(table);
              const current = await worker.call<NativeQueryResult>('query', [
                `SELECT ${insertableColumns.map(escapeIdentifier).join(', ')} ` +
                `FROM ${escapeIdentifier(table)} WHERE ${predicate.sql}`,
                predicate.params
              ]);
              const primaryKeyIndices = identity.columns.map(column => {
                const index = current.columns.indexOf(column.identifier);
                if (index < 0) {
                  throw new Error(`Primary-key column missing from ${table}: ${column.identifier}`);
                }
                return index;
              });
              const deletedRows = current.values.map(row => {
                const deletedRowId = encodePrimaryKeyRecordId(
                  identity.columns,
                  primaryKeyIndices.map(index => row[index])
                );
                const rowData = Object.fromEntries(
                  current.columns.map((header, index) => [header, row[index]])
                );
                return { rowId: deletedRowId, row: rowData };
              });
              if (deletedRows.length !== rowIds.length) {
                throw new Error(`Cannot delete from ${table}: one or more row identities no longer exist`);
              }
              await worker.call('run', [
                `DELETE FROM ${escapeIdentifier(table)} WHERE ${predicate.sql}`,
                predicate.params
              ]);
              await worker.call('run', [`RELEASE ${savepointName}`]);
              return deletedRows;
            } catch (error) {
              await safeRollbackSavepoint(savepointName, 'deleteNativePrimaryKeyRows');
              throw error;
            }
          }

          // Snapshot rowid rows atomically and return the same replay payload
          // shape as primary-key deletion.
          const validIds = validateRowIds(rowIds);
          const placeholders = validIds.map(() => '?').join(', ');
          const savepointName = createSavepointName('sp_delete_rowid_rows');
          await worker.call('run', [`SAVEPOINT ${savepointName}`]);
          try {
            const insertableColumns = await getNativeInsertableColumnNames(table);
            const current = await worker.call<NativeQueryResult>('query', [
              `SELECT CAST(rowid AS TEXT), ${insertableColumns.map(escapeIdentifier).join(', ')} ` +
              `FROM ${escapeIdentifier(table)} WHERE rowid IN (${placeholders})`,
              validIds
            ]);
            const deletedRows = current.values.map(row => {
              const deletedRowId = validateRowId(row[0] as RecordId | bigint);
              const rowData: Record<string, CellValue> = Object.fromEntries(
                insertableColumns.map((column, index) => [column, row[index + 1]])
              );
              rowData.rowid = deletedRowId;
              return { rowId: deletedRowId, row: rowData };
            });
            if (deletedRows.length !== validIds.length) {
              throw new Error(`Cannot delete from ${table}: one or more row identities no longer exist`);
            }
            await worker.call('run', [
              `DELETE FROM ${escapeIdentifier(table)} WHERE rowid IN (${placeholders})`,
              validIds
            ]);
            await worker.call('run', [`RELEASE ${savepointName}`]);
            return deletedRows;
          } catch (error) {
            await safeRollbackSavepoint(savepointName, 'deleteNativeRowidRows');
            throw error;
          }
        },

        /**
         * Find indexes that depend on specific columns.
         */
        findDependentIndexes: async (table: string, columns: string[]): Promise<string[]> => {
          const dependentIndexes: string[] = [];

          // Query sqlite_master for indexes on this table
          const indexQuery = `
            SELECT name, sql FROM sqlite_master
            WHERE type = 'index'
              AND tbl_name = ?
              AND sql IS NOT NULL
          `;
          const indexResult = await worker.call<NativeQueryResult>('query', [indexQuery, [table]]);

          if (indexResult && indexResult.values) {
            for (const row of indexResult.values) {
              const indexName = row[0] as string;
              const indexSql = row[1] as string;

              // Check if this index references any of the columns
              const referencesColumn = columns.some(col => {
                // Escape regex metacharacters in column name to prevent broken patterns
                const escaped = col.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                // Match column name in index definition (quoted or unquoted)
                const patterns = [
                  new RegExp(`[\\(,]\\s*${escaped}\\s*[\\),]`, 'i'),
                  new RegExp(`[\\(,]\\s*"${escaped}"\\s*[\\),]`, 'i'),
                  new RegExp(`[\\(,]\\s*\\[${escaped}\\]\\s*[\\),]`, 'i'),
                  new RegExp(`[\\(,]\\s*\`${escaped}\`\\s*[\\),]`, 'i')
                ];
                return patterns.some(p => p.test(indexSql));
              });

              if (referencesColumn) {
                dependentIndexes.push(indexName);
              }
            }
          }

          return dependentIndexes;
        },

        /**
         * Delete columns by name.
         * If dropDependentIndexes is provided, those indexes will be dropped first.
         */
        deleteColumns: async (table: string, columns: string[], dropDependentIndexes?: string[]) => {
          if (columns.length === 0) return;

          const escapedTable = escapeIdentifier(table);
          const batch: { sql: string; params?: CellValue[] }[] = [];

          // Drop specified dependent indexes first
          if (dropDependentIndexes && dropDependentIndexes.length > 0) {
            for (const indexName of dropDependentIndexes) {
              batch.push({ sql: `DROP INDEX IF EXISTS ${escapeIdentifier(indexName)}` });
            }
          }

          // Now drop the columns
          for (const col of columns) {
            batch.push({ sql: `ALTER TABLE ${escapedTable} DROP COLUMN ${escapeIdentifier(col)}` });
          }

          if (batch.length > 0) {
            await worker.call('execBatch', [batch]);
          }
        },

        /**
         * Create a new table.
         */
        createTable: async (table: string, columns: ColumnDefinition[]) => {
          // Construct SQL from structured column definitions
          const colDefs = columns.map(col => {
            // If it's a string, it indicates legacy/unsafe mode which is not supported.
            if (typeof col === 'string') {
               throw new Error('Legacy string column definitions not supported for security');
            }

            validateSqlType(col.type);

            let def = `${escapeIdentifier(col.name)} ${col.type}`;
            if (col.primaryKey) def += ' PRIMARY KEY';
            if (col.notNull && !col.primaryKey) def += ' NOT NULL';
            return def;
          });

          const sql = `CREATE TABLE ${escapeIdentifier(table)} (${colDefs.join(', ')})`;
          await worker.call('run', [sql]);
        },

        getViewDefinition: getNativeViewDefinition,

        validateViewDefinition: async (
          view: string,
          selectSql: string,
          intent: ViewDefinitionIntent = 'edit'
        ) => {
          if (forceReadOnly) {
            throw new Error('View validation is unavailable because the database is read-only');
          }
          const body = normalizeViewSelectSql(selectSql);
          const { storedSql: existingSql, columnListSql } =
            await resolveExistingViewForIntent(view, intent);
          const savepointName = createSavepointName('sp_validate_view');
          await worker.call('run', [`SAVEPOINT ${savepointName}`]);
          try {
            if (typeof existingSql === 'string') {
              await worker.call('run', [`DROP VIEW ${escapeMainViewIdentifier(view)}`]);
            }
            await runNativeSingleStatement(buildCreateViewSql(view, body, columnListSql));
            await compileNativeView(view);
            await worker.call('run', [`ROLLBACK TO ${savepointName}`]);
            await worker.call('run', [`RELEASE ${savepointName}`]);
          } catch (err) {
            await safeRollbackSavepoint(savepointName, 'validateViewDefinition');
            throw normalizeViewDefinitionError(err, view, body);
          }
        },

        previewViewDefinition: async (
          view: string,
          selectSql: string,
          limit: number = 50,
          intent: ViewDefinitionIntent = 'edit'
        ) => {
          if (forceReadOnly) {
            throw new Error('View preview is unavailable because the database is read-only');
          }
          const body = normalizeViewSelectSql(selectSql);
          const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 50));
          const { storedSql: existingSql, columnListSql } =
            await resolveExistingViewForIntent(view, intent);
          // Native preview always needs DDL because the txiki row-object API
          // needs the disposable view's positional schema; consequently it is
          // explicitly refused read-only. WASM/demo can use a target-named CTE
          // only as their read-only fallback. Replace the real target name here
          // so even schema-qualified self-references cannot resolve the old view.
          const savepointName = createSavepointName('sp_preview_view');
          await worker.call('run', [`SAVEPOINT ${savepointName}`]);
          let columns: string[];
          try {
            if (typeof existingSql === 'string') {
              await worker.call('run', [`DROP VIEW ${escapeMainViewIdentifier(view)}`]);
            }
            await runNativeSingleStatement(
              buildCreateViewSql(view, body, columnListSql)
            );
            await compileNativeView(view);
            columns = await getNativeColumnNames(view, true);
            await worker.call('run', [`ROLLBACK TO ${savepointName}`]);
            await worker.call('run', [`RELEASE ${savepointName}`]);
          } catch (err) {
            await safeRollbackSavepoint(savepointName, 'previewViewDefinition');
            throw normalizeViewDefinitionError(err, view, body);
          }

          // The disposable view is needed only to validate CREATE VIEW context
          // and derive stable positional names. Execute the normalized SELECT
          // after rolling it back so queryBounded can use the second connection
          // when no outer transaction is active. The worker falls back to the
          // sync connection if an outer savepoint still owns uncommitted state.
          const result = await queryNativeBoundedStatement(
            body,
            columns,
            boundedLimit
          );
          const { rows, exactIntegerTexts } = normalizeIntegerRowsForTransport(
            result.values,
            undefined,
            result.exactIntegerTexts
          );
          return {
            headers: columns,
            rows,
            columns,
            values: rows,
            columnNames: columns,
            records: rows,
            exactIntegerTexts
          };
        },

        createView: async (view: string, selectSql: string): Promise<ViewDefinition> => {
          if (forceReadOnly) {
            throw new Error('View creation is unavailable because the database is read-only');
          }
          const body = normalizeViewSelectSql(selectSql);
          await compileNativeViewSelect(body);
          const savepointName = createSavepointName('sp_create_view');
          await worker.call('run', [`SAVEPOINT ${savepointName}`]);
          try {
            await runNativeSingleStatement(buildCreateViewSql(view, body));
            await compileNativeView(view);
            const definition = await getNativeViewDefinition(view);
            await worker.call('run', [`RELEASE ${savepointName}`]);
            return definition;
          } catch (err) {
            await safeRollbackSavepoint(savepointName, 'createView');
            throw err;
          }
        },

        editView: async (
          view: string,
          selectSql: string,
          preserveTriggers: boolean = true,
          expectedSql?: string,
          expectedTriggers?: readonly ViewTriggerDefinition[]
        ): Promise<ViewEditResult> => {
          if (forceReadOnly) {
            throw new Error('View editing is unavailable because the database is read-only');
          }
          const body = normalizeViewSelectSql(selectSql);
          await compileNativeViewSelect(body);
          const savepointName = createSavepointName('sp_edit_view');
          await worker.call('run', [`SAVEPOINT ${savepointName}`]);
          try {
            const before = await getNativeViewDefinition(view);
            assertViewTriggerSnapshotIsMutationSafe(before);
            assertViewDefinitionSnapshotCurrent(
              expectedSql,
              before.sql,
              expectedTriggers,
              before.triggers
            );
            await worker.call('run', [`DROP VIEW ${escapeMainViewIdentifier(view)}`]);
            await runNativeSingleStatement(buildCreateViewSql(view, body, before.columnListSql, before.columns));
            await compileNativeView(view);
            if (preserveTriggers) {
              const columns = await getNativeColumnNames(view, true);
              assertViewTriggersCompatibleWithColumns(before.triggers, columns);
              for (const trigger of before.triggers) {
                await runNativeSingleStatement(buildCreateViewTriggerSql(trigger));
              }
            }
            const after = await getNativeViewDefinition(view);
            // Only the native transport accepts duplicate validated/executable
            // SQL payloads, so only this engine needs a post-edit comparison to
            // detect transport divergence before releasing the savepoint.
            if (after.selectSql !== body) {
              throw new Error(
                'Native SQLite stored a view definition different from the submitted SQL; the replacement was rolled back'
              );
            }
            await worker.call('run', [`RELEASE ${savepointName}`]);
            return { before, after };
          } catch (err) {
            await safeRollbackSavepoint(savepointName, 'editView');
            throw err;
          }
        },

        dropView: async (
          view: string,
          expectedSql?: string,
          expectedTriggers?: readonly ViewTriggerDefinition[]
        ): Promise<ViewDefinition> => {
          if (forceReadOnly) {
            throw new Error('View deletion is unavailable because the database is read-only');
          }
          const savepointName = createSavepointName('sp_drop_view');
          await worker.call('run', [`SAVEPOINT ${savepointName}`]);
          try {
            const before = await getNativeViewDefinition(view, true);
            assertViewTriggerSnapshotIsMutationSafe(before);
            assertViewDefinitionSnapshotCurrent(
              expectedSql,
              before.sql,
              expectedTriggers,
              before.triggers
            );
            await worker.call('run', [`DROP VIEW ${escapeMainViewIdentifier(view)}`]);
            await worker.call('run', [`RELEASE ${savepointName}`]);
            return before;
          } catch (err) {
            await safeRollbackSavepoint(savepointName, 'dropView');
            throw err;
          }
        },

        /**
         * Fetch table data.
         */
        fetchTableData: async (table: string, options: TableQueryOptions) => {
          let columns = options.columns;
          if (!columns || (columns.length === 1 && columns[0] === '*')) {
            columns = await getNativeColumnNames(table);
          }
          let primaryKeyContext: {
            identity: Extract<TableIdentity, { kind: 'primaryKey' }>;
            visibleColumns: string[];
          } | undefined;
          let effectiveOrderBy = options.orderBy;
          let identityOrderBy: string[] | undefined;
          if (columns[0]?.toLowerCase() === 'rowid') {
            const identity = await findNativeTableIdentity(table);
            if (identity?.kind === 'primaryKey') {
              const visibleColumns = columns.slice(1);
              const hiddenPrimaryKeyColumns = identity.columns
                .map(column => column.identifier)
                .filter(column => !visibleColumns.includes(column));
              columns = [...visibleColumns, ...hiddenPrimaryKeyColumns];
              primaryKeyContext = { identity, visibleColumns };
              if (effectiveOrderBy?.toLowerCase() === 'rowid') {
                effectiveOrderBy = undefined;
                identityOrderBy = identity.columns.map(column => column.identifier);
              }
            }
          }
          const queryOptions = {
            ...options,
            columns,
            orderBy: effectiveOrderBy,
            orderByColumns: identityOrderBy
          };
          const { sql, params } = buildSelectQuery(table, queryOptions);
          const containmentQuery = buildCellContainmentQuery(sql, columns.length, queryOptions);
          const transportQuery = buildExactNumericTextQuery(
            containmentQuery.sql,
            columns.length + 1
          );
          const hasRowIdShape = columns[0]?.toLowerCase() === 'rowid';
          const needsRowIdCompanions = transportQuery.valueColumnCount === undefined
            && hasRowIdShape;
          const snapshotName = hasRowIdShape
            ? createSavepointName('sp_numeric_snapshot')
            : undefined;
          if (snapshotName) {
            // Unlike the private WASM databases, the native file can receive a
            // WAL commit from another process between RPCs. The first read below
            // fixes one SQLite snapshot for both values and companion text.
            await worker.call('run', [`SAVEPOINT ${snapshotName}`]);
          }

          try {
            let isRowIdTable = false;
            if (hasRowIdShape) {
              // This authority read fixes the WAL snapshot before the main data
              // read, so both exact identities and any companion text describe
              // one committed database state.
              const authority = await worker.call<NativeQueryResult>('query', [
                ROWID_TABLE_AUTHORITY_SQL,
                [table, table]
              ]);
              isRowIdTable = authority.values.length > 0;
            }
            const result = await worker.call<NativeQueryResult>('queryNumeric', [
              transportQuery.sql,
              params,
              transportQuery.transportColumns,
              transportQuery.valueColumnCount
            ]);

            const companionResults = [];
            if (isRowIdTable && needsRowIdCompanions && result.values.length > 0) {
              const companionQueries = buildRowIdExactRealTextQueries(
                table,
                columns,
                result.values.map(row => row[0])
              );
              if (companionQueries.length > 0) {
                const companionBatch = await worker.call<NativeQueryBatchResult>('queryBatch', [
                  companionQueries.map(query => ({ sql: query.sql, params: query.params }))
                ]);
                if (companionBatch.results?.length !== companionQueries.length) {
                  throw new Error('Exact REAL companion fetch failed: queryBatch returned incomplete results');
                }
                companionResults.push(...companionQueries.map((query, index) => ({
                  query,
                  rows: companionBatch.results[index].values
                })));
              }
            }
            const companionExactTexts = collectRowIdExactRealTexts(
              result.values,
              companionResults
            );
            const needsExactRowIdIdentity = isRowIdTable
              && hasUnsafeBigIntAtColumn(result.values, 0);

            // txiki preserves SQLite int64 values as BigInt. The generated
            // companion columns also retain authoritative REAL text before V8
            // normalizes the storage class into a JavaScript Number.
            const normalized = normalizeIntegerRowsForTransport(
              result.values,
              undefined,
              mergeExactIntegerTextMaps(companionExactTexts, result.exactIntegerTexts),
              needsExactRowIdIdentity ? 0 : undefined
            );
            const contained = decodeCellContainment(
              normalized.rows,
              columns.length,
              normalized.exactIntegerTexts
            );
            const { rows, oversizedCells, exactIntegerTexts } = contained;

            if (primaryKeyContext) {
              const visibleColumnCount = primaryKeyContext.visibleColumns.length;
              const remapped = remapPrimaryKeyContainment({
                identity: primaryKeyContext.identity,
                sourceColumns: columns,
                visibleColumnCount,
                identityRows: result.values,
                rows,
                oversizedCells,
                exactIntegerTexts,
                effectiveInlineCellBytes: containmentQuery.effectiveInlineCellBytes,
                rowOffset: queryOptions.offset
              });
              const resultHeaders = ['rowid', ...primaryKeyContext.visibleColumns];
              if (snapshotName) {
                await worker.call('run', [`RELEASE ${snapshotName}`]);
              }
              return {
                headers: resultHeaders,
                rows: remapped.rows,
                columns: resultHeaders,
                values: remapped.rows,
                exactIntegerTexts: remapped.exactIntegerTexts,
                ...(remapped.oversizedCells ? { oversizedCells: remapped.oversizedCells } : {}),
                ...(remapped.readOnlyRowReasons
                  ? { readOnlyRowReasons: remapped.readOnlyRowReasons }
                  : {})
              };
            }

            if (snapshotName) {
              await worker.call('run', [`RELEASE ${snapshotName}`]);
            }
            return {
              headers: columns,
              rows: rows,
              columns,
              values: rows,
              exactIntegerTexts,
              ...(oversizedCells ? { oversizedCells } : {})
            };
          } catch (err) {
            if (snapshotName) {
              await safeRollbackSavepoint(snapshotName, 'fetchTableData numeric snapshot');
            }
            throw err;
          }
        },

        /**
         * Fetch table row count.
         */
        fetchTableCount: async (table: string, options: TableCountOptions) => {
          const { sql, params } = buildCountQuery(table, options);
          const result = await worker.call<NativeQueryResult>('query', [sql, params]);
          if (result && result.values && result.values.length > 0) {
            const val = result.values[0][0];
            return typeof val === 'number' ? val : 0;
          }
          return 0;
        },

        /**
         * Fetch database schema.
         */
        fetchSchema: async () => {
          // Keep schema and identity discovery in one IPC round-trip.
          const queries = [
            { sql: "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name" },
            { sql: "SELECT name FROM sqlite_schema WHERE type='view' ORDER BY name" },
            { sql: "SELECT name, tbl_name FROM sqlite_schema WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name" },
            { sql: TABLE_IDENTITY_METADATA_SQL }
          ];

          const res = await worker.call<NativeQueryBatchResult>('queryBatch', [queries]);

          // Validate the response — throw instead of silently returning empty schema
          if (!res || !res.results || res.results.length < 4) {
            throw new Error('Schema fetch failed: queryBatch returned incomplete results');
          }

          const tableNames = mapRowsByName<TableMetadata>(res.results[0], { identifier: 'name' });
          const identities = buildTableIdentityMap(res.results[3].values ?? []);
          const tables = tableNames.map(table => {
            const identity = identities.get(table.identifier);
            if (!identity) throw new Error(`Table not found: ${table.identifier}`);
            return { ...table, identity };
          });
          const views = mapRowsByName<ViewMetadata>(res.results[1], { identifier: 'name' });
          const indexes = mapRowsByName<IndexMetadata>(res.results[2], { identifier: 'name', parentTable: 'tbl_name' });

          return { tables, views, indexes } as SchemaSnapshot;
        },

        /**
         * Get table metadata.
         */
        getTableInfo: async (table: string) => {
          return getNativeTableInfo(table);
        },

        /**
         * Get database PRAGMA settings.
         */
        getPragmas: async () => {
          const pragmasToFetch = [
            'foreign_keys',
            'journal_mode',
            'synchronous',
            'cache_size',
            'locking_mode',
            'temp_store',
            'encoding',
            'auto_vacuum'
          ];

          const queries = pragmasToFetch.map(pragma => ({ sql: `PRAGMA ${pragma}` }));
          const res = await worker.call<NativeQueryBatchResult>('queryBatch', [queries]);

          const result: Record<string, CellValue> = {};

          if (res && res.results && Array.isArray(res.results)) {
            res.results.forEach((r, i) => {
              if (r && r.values && r.values.length > 0) {
                result[pragmasToFetch[i]] = r.values[0][0];
              }
            });
          }

          return result;
        },

        /**
         * Set database PRAGMA value.
         */
        setPragma: async (pragma: string, value: CellValue) => {
          // Validate pragma name
          const allowedPragmas = [
            'foreign_keys',
            'journal_mode',
            'synchronous',
            'cache_size',
            'locking_mode',
            'temp_store',
            'auto_vacuum'
          ];

          if (!allowedPragmas.includes(pragma)) {
            throw new Error(`Invalid or disallowed PRAGMA: ${pragma}`);
          }

          // Value sanitization depends on type.
          // String values use a strict whitelist — only alphanumeric, underscores,
          // and hyphens allowed (covers all valid PRAGMA string values).
          let sql: string;
          if (typeof value === 'string') {
              if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
                throw new Error('Invalid PRAGMA string value: contains disallowed characters');
              }
              sql = `PRAGMA ${pragma} = '${value}'`;
          } else if (typeof value === 'number') {
              if (!Number.isFinite(value)) {
                throw new Error('Invalid PRAGMA numeric value: must be finite');
              }
              sql = `PRAGMA ${pragma} = ${value}`;
          } else if (typeof value === 'boolean') {
              sql = `PRAGMA ${pragma} = ${value ? 'ON' : 'OFF'}`;
          } else {
              throw new Error(`Invalid PRAGMA value type: ${typeof value}`);
          }

          await worker.call('exec', [sql]);
        },

        /**
         * Test connection.
         */
        ping: async () => {
          try {
            await worker.call('query', ['SELECT 1']);
            return true;
          } catch {
            return false;
          }
        },

        /**
         * Write database to file.
         */
        writeToFile: async (path: string) => {
           // Use VACUUM INTO for atomic backup
           // Escaping path properly for SQL string literal
           const escapedPath = path.replace(/'/g, "''");
           await worker.call('exec', [`VACUUM INTO '${escapedPath}'`]);
        },

        /**
         * Update multiple cells in a batch.
         */
        updateCellBatch: async (
          table: string,
          updates: CellUpdate[],
          maxEditValueBytes?: number,
          historyReplayToken?: typeof HISTORY_REPLAY_EDIT_TOKEN
        ): Promise<CellUpdateResult[]> => {
          updates.forEach(update => assertMutableRecordId(update.rowId));
          if (updates.length === 0) return [];
          const isHistoryReplay = historyReplayToken === HISTORY_REPLAY_EDIT_TOKEN;
          const editLimitBytes = isHistoryReplay
            ? 0
            : assertCellValuesWithinEditLimit(
                updates.map(update => update.value),
                maxEditValueBytes
              );

          if (updates.some(update => isPrimaryKeyRecordId(update.rowId))) {
            if (!updates.every(update => isPrimaryKeyRecordId(update.rowId))) {
              throw new Error('Cannot mix rowid and primary-key row identities');
            }
            const identity = await resolveNativeTableIdentity(table);
            if (identity.kind !== 'primaryKey') {
              throw new Error(`Primary-key identity cannot target rowid table ${table}`);
            }
            return updateNativePrimaryKeyCellBatch(
              table,
              identity,
              updates,
              maxEditValueBytes,
              historyReplayToken
            );
          }

          const batchItems: { sql: string; paramsList?: CellValue[][], params?: CellValue[] }[] = [];
          const escapedTable = escapeIdentifier(table);
          const savepointName = createSavepointName('sp_update_batch');
          await worker.call('run', [`SAVEPOINT ${savepointName}`]);

          try {
          if (!isHistoryReplay && maxEditValueBytes !== undefined) {
            await assertNativeBatchPriorsWithinEditLimit(
              table,
              updates,
              editLimitBytes,
              { kind: 'rowid' }
            );
          }
          const rowIds = [...new Set(updates.map(update => validateRowId(update.rowId)))];
          const columns = [...new Set(updates.map(update => update.column))];
          const placeholders = rowIds.map(() => '?').join(', ');
          const current = await worker.call<NativeQueryResult>('query', [
            `SELECT CAST(rowid AS TEXT), ${columns.map(escapeIdentifier).join(', ')} ` +
            `FROM ${escapedTable} WHERE rowid IN (${placeholders})`,
            rowIds
          ]);
          const currentValues = new Map<string, Map<string, CellValue>>();
          for (const row of current.values ?? []) {
            const values = new Map<string, CellValue>();
            columns.forEach((column, index) => values.set(column, row[index + 1]));
            currentValues.set(String(validateRowId(row[0] as RecordId)), values);
          }
          const results: CellUpdateResult[] = [];
          const processedUpdates = updates.map(update => {
            const rowId = validateRowId(update.rowId);
            const row = currentValues.get(String(rowId));
            if (!row) {
              throw new Error(`Cannot update ${table}.${update.column}: row ${update.rowId} no longer exists`);
            }
            const priorValue = row.get(update.column) as CellValue;
            const prepared = prepareCellUpdateForStorage(
              update.value,
              priorValue,
              update.operation ?? 'set'
            );
            if (!isHistoryReplay && prepared.operation === 'json_patch') {
              const storedValue = applyNativeJsonPatchValue(priorValue, prepared.value);
              assertCellValueWithinEditLimit(storedValue, editLimitBytes);
            }
            results.push({
              rowId,
              columnName: update.column,
              priorValue,
              newValue: prepared.value,
              operation: prepared.operation
            });
            return { ...update, rowId, value: prepared.value, operation: prepared.operation };
          });

          const updatesByColumn = new Map<string, CellUpdate[]>();
          for (const update of processedUpdates) {
            const key = `${update.column}|${update.operation || 'set'}`;
            if (!updatesByColumn.has(key)) {
                updatesByColumn.set(key, []);
            }
            updatesByColumn.get(key)!.push(update);
          }

          for (const [key, columnUpdates] of updatesByColumn.entries()) {
            const column = columnUpdates[0].column;
            const op = columnUpdates[0].operation || 'set';
            const escapedColumn = escapeIdentifier(column);
            let sql: string;

            if (op === 'json_patch') {
              // COALESCE handles NULL columns: json_patch(NULL, x) returns NULL per SQL
              // semantics, but a patch on a NULL JSON cell must be applied to '{}' (matching
              // the single-cell updateCell path and both WasmDatabaseEngine json_patch sites).
              sql = `UPDATE ${escapedTable} SET ${escapedColumn} = json_patch(COALESCE(${escapedColumn}, '{}'), ?) WHERE rowid = ?`;
            } else {
              // Standard set
              sql = `UPDATE ${escapedTable} SET ${escapedColumn} = ? WHERE rowid = ?`;
            }

            const paramsList = columnUpdates.map(update => {
                const rowIdNum = validateRowId(update.rowId);
                return [update.value, rowIdNum];
            });

            batchItems.push({ sql, paramsList });
          }

          if (batchItems.length > 0) {
            await worker.call('execBatch', [batchItems]);
          }
          await worker.call('run', [`RELEASE ${savepointName}`]);
          return results;
          } catch (err) {
            await safeRollbackSavepoint(savepointName, 'updateCellBatch');
            throw err;
          }
        },

        /**
         * Add a new column to a table.
         */
        addColumn: async (table: string, column: string, type: string, defaultValue?: string) => {
          validateSqlType(type);
          let sql = `ALTER TABLE ${escapeIdentifier(table)} ADD COLUMN ${escapeIdentifier(column)} ${type}`;

          if (defaultValue !== undefined && defaultValue !== null && defaultValue !== '') {
            if (defaultValue.toLowerCase() === 'null') {
              sql += ' DEFAULT NULL';
            } else if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(defaultValue)) {
              // Strict numeric pattern: optional sign, digits with optional decimal, optional exponent
              sql += ` DEFAULT ${defaultValue}`;
            } else {
              sql += ` DEFAULT '${defaultValue.replace(/'/g, "''")}'`;
            }
          }

          await worker.call('exec', [sql]);
        }
      };

      const operationsFacade = serializeOperations(rawOperations);

      return {
        databaseOps: operationsFacade,
        isReadOnly: forceReadOnly ?? false
      };
    }
  };
}
