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
import * as os from 'node:os';
import { spawn, ChildProcess } from 'child_process';
import * as v8 from 'node:v8';

import { uiKindToString } from './helpers';

import type { TelemetryReporter } from '@vscode/extension-telemetry';
import type { DatabaseConnectionBundle } from './connectionTypes';
import type {
  CellValue,
  CellTextEncoding,
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
  OversizedCellMetadata,
  DatabaseWriteResult,
  ColumnDropTableState,
  StoredCellState
} from './core/types';
import { writeDatabaseSnapshotAtomically } from './atomicDatabaseWrite';
import {
  assertUsableSqlIdentifier,
  escapeIdentifier,
  escapeMainIdentifier,
  validateSqlType,
  validateRowId
} from './core/sql-utils';
import {
  assertColumnNameAvailable,
  buildCreateTableSql,
  buildColumnDefaultClause,
  buildIndexDependencyProbeIndexSql,
  buildIndexDependencyProbeTableSql,
  resolveIndexDependencyColumns
} from './core/schema-ddl';
import { buildSelectQuery, buildCountQuery } from './core/query-builder';
import { normalizeTablePageOptions } from './core/table-pagination';
import {
  computeKeysetKey,
  computeKeysetQueryTag,
  keysetFallbackOrder,
  mintKeysetAnchors,
  ordersBySyntheticRowId,
  resolveKeysetPlan
} from './core/keyset-pagination';
import {
  applyMergePatch,
  parseJsonValueForPatching,
  planJsonPatchHistoryReplay,
  prepareCellUpdateForStorage
} from './core/json-utils';
import {
  assertStoredCellState,
  buildStoredCellPredicate,
  buildStoredCellStateProjection,
  buildStoredCellWrite,
  CellHistoryConflictError,
  LegacyCellHistoryError,
  parseStoredCellState,
  storedCellStatesEqual
} from './core/cell-history';
import {
  buildRowHistoryPredicate,
  buildRowHistoryWrites,
  LegacyRowHistoryError,
  RowHistoryConflictError,
  rowHistoryStates
} from './core/row-history';
import {
  assertMutableRecordId,
  assertNoApplicableUpdateTriggerTargetWrites,
  assertNoUntrackedMutationPrograms,
  assertUniqueCellUpdateTargets,
  buildDeleteTriggerProbeSql,
  buildInsertTriggerProbeSql,
  buildRecordIdentitiesPredicate,
  buildRecordIdentityPredicateChunks,
  buildRecordIdentityPredicate,
  buildUpdateTriggerProbeSql,
  buildTableIdentityMap,
  classifyTableIdentity,
  encodePrimaryKeyRecordId,
  isPrimaryKeyRecordId,
  MAIN_TABLE_ROOT_PAGE_SQL,
  parseMainTableRootPage,
  primaryKeyColumnsFromTableInfo,
  replacePrimaryKeyRecordIdValues,
  TABLE_IDENTITY_METADATA_SQL,
  unresolvableTriggeredPrimaryKeyUpdateError,
  unresolvableTriggeredRowIdUpdateError
} from './core/row-identity';
import {
  assertDeleteSnapshotFitsUndoBudget,
  buildDeleteSnapshotSizeQuery,
  deleteSnapshotValueColumns,
  parseDeleteSnapshotSizeRow
} from './core/delete-history';
import {
  buildExactNumericTextQuery,
  buildRowIdExactRealTextQueries,
  collectRowIdExactRealTexts,
  hasUnsafeBigIntAtColumn,
  normalizeIntegerRowsForTransport,
  parseRowIdAliasColumn,
  ROWID_ALIAS_COLUMN_SQL,
  sqliteIdentifiersEqual,
  TABLE_XINFO_WITH_ROWID_ALIAS_SQL,
  ROWID_TABLE_AUTHORITY_SQL
} from './core/integer-utils';
import {
  buildByteFaithfulPrimaryKeyProjection,
  buildCellContainmentQuery,
  containUnrepresentableTextCells,
  decodeRawTextColumns,
  decodeCellContainment,
  encodeByteFaithfulPrimaryKeyRecordId,
  findUnrepresentableTextRows,
  mergeCellContainmentMetadataRows,
  prependCellContainmentColumn,
  remapShadowedRowIdContainment,
  SQLITE_MAX_RESULT_COLUMNS,
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
  buildStoredTriggerValidationSql,
  buildCreateViewTriggerSql,
  buildCreateViewSql,
  extractViewColumnListSql,
  extractViewSelectSql,
  escapeMainViewIdentifier,
  explainIncludesTriggerProgram,
  mapViewTriggerRows,
  VIEW_TRIGGER_SCHEMA_QUERIES,
  normalizeViewDefinitionError,
  normalizeViewSelectSql,
  qualifyMainTriggerTargetSql
} from './core/view-utils';
import {
  assertNoNewBrokenSchemaDependencies,
  captureSchemaDependencySnapshot,
  type SchemaDependencySnapshot
} from './core/schema-dependency';
import { crypto } from './platform/cryptoShim';
import { DEFAULT_QUERY_TIMEOUT_MS } from './config';
import {
  normalizeCellTextEncoding,
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
import {
  assertBatchHistoryFitsUndoBudget,
  assertBatchPriorLimitResult,
  buildBatchHistorySizePreflight,
  buildBatchPriorLimitQueries
} from './core/batch-update';
import {
  assertNoNewColumnDropForeignKeyViolations,
  assertColumnDropTableStateCurrent,
  assertTableSchemaStateCurrent,
  buildColumnDropRestorePlan,
  captureColumnDropForeignKeyBaseline,
  COLUMN_DROP_FOREIGN_KEY_FIELD_BYTES_LIMIT,
  COLUMN_DROP_FOREIGN_KEY_VIOLATION_BYTES_LIMIT,
  COLUMN_DROP_FOREIGN_KEY_VIOLATION_LIMIT,
  COLUMN_DROP_TABLE_STATE_SQL,
  executeSchemaPreservingColumnDrop,
  mapColumnDropTableState
} from './core/column-drop';

// ============================================================================
// Utility Functions
// ============================================================================

// Utility functions moved to src/core/sql-utils.ts

// This token never crosses RPC. It distinguishes restoration of a value that
// already existed in history from a user request to create oversized content.
const HISTORY_REPLAY_EDIT_TOKEN = Symbol('history-replay-edit');

interface GuardedCellHistoryEntry {
  rowId: RecordId;
  newRowId?: RecordId;
  columnName: string;
  newValue?: CellValue;
  operation?: ModificationEntry['operation'];
  priorState: StoredCellState;
  postState: StoredCellState;
}

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

// Intended query/grid responses are already bounded well below this. Refuse a
// corrupt or compromised worker's advertised multi-gigabyte frame before the
// extension host starts retaining chunks toward that allocation.
const MAX_NATIVE_WORKER_RESPONSE_BYTES = 64 * 1024 * 1024;

/** Timeout for native worker initialization (ms) */
const INIT_TIMEOUT = 10000;

/** Timeout for individual queries (ms) */
const QUERY_TIMEOUT = DEFAULT_QUERY_TIMEOUT_MS;
const EXPORT_SPOOL_NAME = '__sqlite_explorer_export_[0-9a-f]{32}';

function isGeneratedExportSpoolStatement(sql: string): boolean {
  const quotedName = `"${EXPORT_SPOOL_NAME}"`;
  return (
    new RegExp(`^CREATE TEMP TABLE ${quotedName} AS SELECT[\\s\\S]+$`, 'i').test(sql)
    || new RegExp(
      `^SELECT CAST\\(rowid AS TEXT\\), \\* FROM ${quotedName} ` +
      'WHERE rowid > \\? ORDER BY rowid LIMIT 1$',
      'i'
    ).test(sql)
    || new RegExp(`^DROP TABLE IF EXISTS temp\\.${quotedName}$`, 'i').test(sql)
  );
}

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

/**
 * Native SQLite needs write access to both the database and its directory so
 * it can create rollback-journal or WAL sidecars. txiki's SQLite binding can
 * successfully open a requested read-write connection after SQLite falls back
 * to an OS-read-only file descriptor, so infer the effective mode up front.
 */
async function canPersistNativeDatabase(filePath: string): Promise<boolean> {
  const isReadOnlyAccessError = (error: unknown): boolean => {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
  };
  try {
    await fs.promises.access(filePath, fs.constants.W_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (isReadOnlyAccessError(error)) return false;
    // SQLite can create a new database when the leaf does not exist. In that
    // case the parent directory is the only meaningful persistence gate.
    if (code !== 'ENOENT') throw error;
  }
  try {
    await fs.promises.access(path.dirname(filePath), fs.constants.W_OK);
    return true;
  } catch (error) {
    if (isReadOnlyAccessError(error)) return false;
    throw error;
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
      const child = spawn(this.binaryPath, ['run', this.workerScript], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildSpawnEnv(),
        shell: false
      });
      this.process = child;

      const handleIpcError = (streamName: string, err: Error) => {
        if (this.process !== child) return;
        clearTimeout(timeout);
        const error = new Error(`Native worker ${streamName} failed: ${err.message}`, { cause: err });
        console.error(`[NativeWorker] ${error.message}`);
        this.retire(error);
        reject(error);
      };

      // Handle stdout (message responses)
      child.stdout?.on('data', (chunk: Buffer) => {
        try {
          this.handleData(chunk);
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          handleIpcError('response stream', error);
        }
      });
      child.stdout?.on('error', (err: Error) => handleIpcError('response stream', err));
      child.stdin?.on('error', (err: Error) => handleIpcError('request stream', err));

      // Handle stderr (debug output)
      child.stderr?.on('data', (chunk: Buffer) => {
        console.warn('[NativeWorker]', chunk.toString());
      });
      child.stderr?.on('error', (err: Error) => handleIpcError('diagnostic stream', err));

      // Handle process exit
      child.on('exit', (code) => {
        clearTimeout(timeout);
        if (this.process !== child) return;
        const error = new Error(
          code === 0 || code === null
            ? 'Native worker exited unexpectedly'
            : `Native worker process exited with code ${code}`
        );
        if (code !== 0 && code !== null) {
          console.error(`[NativeWorker] Process exited with code ${code}`);
        }
        this.retire(error, false);
        reject(error);
      });

      // Handle process errors
      child.on('error', (err) => {
        clearTimeout(timeout);
        if (this.process !== child) return;
        this.retire(err, false);
        reject(err);
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
    this.retire(new Error('Native worker stopped'));
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
        // A synchronous SQLite call cannot consume another request after the
        // host abandons it. Terminate the worker so one hostile query cannot
        // leave the document permanently queued behind orphaned native work.
        this.stop();
        reject(timeoutError);
      }, timeoutMs);

      const abortListener = signal && (
        method === 'queryBounded' || method === 'queryExportSpool' || method === 'vacuumInto'
      )
        ? () => {
            if (!this.pendingRequests.has(id) || !this.process?.stdin) return;
            const cancelId = ++this.messageId;
            try {
              writeMessage(this.process.stdin, {
                id: cancelId,
                method: 'cancel',
                args: [id]
              });
            } catch (cause) {
              const error = cause instanceof Error ? cause : new Error(String(cause));
              this.retire(error);
            }
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

      try {
        writeMessage(this.process!.stdin!, { id, method, args, timeoutMs });
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        this.retire(error);
      }
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
        if (this.expectedLength > MAX_NATIVE_WORKER_RESPONSE_BYTES) {
          const error = new Error(
            `Native worker response frame ${this.expectedLength} bytes exceeds the ` +
            `${MAX_NATIVE_WORKER_RESPONSE_BYTES}-byte limit`
          );
          console.error(`[NativeWorker] ${error.message}`);
          this.retire(error);
          return;
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

    if (pending.signal?.aborted) {
      // SQLite may finish just before the worker observes the cancel RPC. The
      // caller still cancelled while the request was outstanding, so do not
      // surface a stale successful result.
      pending.reject(
        pending.signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
      );
    } else if (typedMsg.cancelled) {
      pending.reject(
        pending.signal?.reason ?? new DOMException('The operation was aborted', 'AbortError')
      );
    } else if (typedMsg.error) {
      pending.reject(new Error(typedMsg.error));
    } else {
      pending.resolve(typedMsg.result);
    }
  }

  private retire(reason: Error, killProcess: boolean = true): void {
    const process = this.process;
    this.process = null;
    if (killProcess && process) process.kill();
    this.chunks = [];
    this.chunksTotalLength = 0;
    this.expectedLength = -1;
    this.cleanup(reason);
  }

  /**
   * Clean up pending requests.
   */
  private cleanup(reason: Error = new Error('Native worker stopped')): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      if (pending.signal && pending.abortListener) {
        pending.signal.removeEventListener('abort', pending.abortListener);
      }
      pending.reject(reason);
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
  resultSets?: NativeQueryResult[];
}

interface NativeQueryBatchResult {
  results: NativeQueryResult[];
}

interface NativeCompileBatchResult {
  errors: Array<string | null>;
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

  const exportNativeDatabase = async (signal?: AbortSignal): Promise<Uint8Array> => {
    // The txiki SQLite binding has no in-memory serialize primitive. Give
    // VACUUM INTO a private, collision-resistant host path and always remove it;
    // a predictable /tmp filename is both non-portable and racy.
    const scratchDirectory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'sqlite-explorer-export-')
    );
    const snapshotPath = path.join(scratchDirectory, 'snapshot.sqlite');
    try {
      await worker.call(
        'vacuumInto',
        [snapshotPath, queryTimeout],
        queryTimeout + BOUNDED_QUERY_TRANSPORT_MARGIN_MS,
        signal
      );
      signal?.throwIfAborted();
      const content = await fs.promises.readFile(snapshotPath);
      signal?.throwIfAborted();
      return new Uint8Array(content);
    } finally {
      await fs.promises.rm(scratchDirectory, { recursive: true, force: true });
    }
  };

  // Termination handler
  const terminateWorker = () => {
    worker.stop();
  };

  return {
    workerMethods: {
      initializeDatabase: async (...args: unknown[]) => worker.call('open', args),
      runQuery: async (...args: unknown[]) => worker.call('query', args),
      exportDatabase: exportNativeDatabase,
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
      let readOnly = forceReadOnly ?? false;

      // Open database
      // Note: If this fails (e.g., SQLite error 14: unable to open database file),
      // the error will propagate up. Common causes on macOS:
      // - File doesn't exist
      // - Permission denied (sandboxing, Gatekeeper)
      // - File is locked by another process
      // - Path encoding issues with special characters
      try {
        if (!readOnly) readOnly = !(await canPersistNativeDatabase(filePath));
        await worker.call('open', [filePath, readOnly]);
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

      const safeRollbackTransaction = async (context: string): Promise<void> => {
        try {
          await worker.call('run', ['ROLLBACK']);
        } catch (rollbackErr) {
          const message = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
          outputChannel?.appendLine(`[NativeWorker] Failed to rollback native transaction (${context}): ${message}`);
        }
      };

      const findNativeViewDefinition = async (
        view: string,
        allowUnparsed: boolean = false
      ): Promise<ViewDefinition | null> => {
        const metadataQueries = [
          {
            sql: "SELECT sql FROM main.sqlite_schema WHERE type = 'view' AND name = ?",
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

        const {
          triggers,
          ambiguousTemporaryTriggerNames,
          unqualifiedTemporaryTriggers
        } = mapViewTriggerRows(
          view,
          VIEW_TRIGGER_SCHEMA_QUERIES.map((_, index) => (
            metadata.results[index + 1].values ?? []
          ))
        );
        if (unqualifiedTemporaryTriggers.length > 0) {
          const columns = await worker.call<NativeQueryResult>('query', [
            "SELECT name FROM pragma.pragma_table_xinfo(?, 'main') ORDER BY cid",
            [view]
          ]);
          const writableColumns = (columns.values ?? []).map(row => {
            if (typeof row[0] !== 'string') {
              throw new Error(`SQLite returned invalid view column metadata for ${view}`);
            }
            return row[0];
          });
          for (const trigger of unqualifiedTemporaryTriggers) {
            if (triggers.some(candidate => (
              !candidate.temporary
              && sqliteIdentifiersEqual(candidate.identifier, trigger.identifier)
            ))) {
              ambiguousTemporaryTriggerNames.push(trigger.identifier);
              continue;
            }
            try {
              const validationSql = buildStoredTriggerValidationSql(
                trigger.sql,
                'main',
                view,
                writableColumns
              );
              if (validationSql === undefined) {
                ambiguousTemporaryTriggerNames.push(trigger.identifier);
                continue;
              }
              const probe = await worker.call<NativeQueryResult>('query', [
                validationSql
              ]);
              if (explainIncludesTriggerProgram(probe.values ?? [], trigger.identifier)) {
                triggers.push({
                  ...trigger,
                  sql: qualifyMainTriggerTargetSql(trigger.sql, trigger.identifier)
                });
              }
            } catch {
              ambiguousTemporaryTriggerNames.push(trigger.identifier);
            }
          }
        }

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
          "SELECT sql FROM main.sqlite_schema WHERE type = 'view' AND name = ?",
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
        qualifyMain: boolean = true
      ): Promise<string[]> => {
        const pragma = qualifyMain ? 'PRAGMA main.table_xinfo' : 'PRAGMA table_xinfo';
        const info = await worker.call<NativeQueryResult>('query', [
          `${pragma}(${escapeIdentifier(table)})`
        ]);
        const nameIndex = info.columns.indexOf('name');
        const hiddenIndex = info.columns.indexOf('hidden');
        if ((nameIndex < 0 || hiddenIndex < 0) && (info.values?.length ?? 0) > 0) {
          throw new Error('SQLite returned incomplete extended table metadata');
        }
        return (info.values ?? []).filter(row => {
          const hidden = row[hiddenIndex];
          if (typeof hidden !== 'number') {
            throw new Error('SQLite returned invalid hidden-column metadata');
          }
          // SELECT * includes generated columns (2/3), but not hidden virtual
          // table inputs (1). Match that projection exactly.
          return hidden !== 1;
        }).map(row => {
          const name = row[nameIndex];
          if (typeof name !== 'string') {
            throw new Error('SQLite returned invalid column metadata');
          }
          return name;
        });
      };

      const getNativeTableInfo = async (table: string): Promise<ColumnMetadata[]> => {
        const result = await worker.call<NativeQueryResult>('query', [
          TABLE_XINFO_WITH_ROWID_ALIAS_SQL,
          [table]
        ]);
        const index = {
          cid: result.columns.indexOf('cid'),
          name: result.columns.indexOf('name'),
          type: result.columns.indexOf('type'),
          notnull: result.columns.indexOf('notnull'),
          dfltValue: result.columns.indexOf('dflt_value'),
          pk: result.columns.indexOf('pk'),
          hidden: result.columns.indexOf('hidden'),
          rowidAlias: result.columns.indexOf('is_rowid_alias')
        };
        const hiddenCode = (row: readonly CellValue[]) => Number(
          index.hidden >= 0 ? row[index.hidden] : row[6] ?? 0
        );
        return (result.values ?? [])
          .filter(row => hiddenCode(row) !== 1)
          .map(row => ({
            ordinal: (index.cid >= 0 ? row[index.cid] : row[0]) as number,
            identifier: (index.name >= 0 ? row[index.name] : row[1]) as string,
            declaredType: (index.type >= 0 ? row[index.type] : row[2]) as string,
            isRequired: (index.notnull >= 0 ? row[index.notnull] : row[3]) as number,
            defaultExpression: index.dfltValue >= 0 ? row[index.dfltValue] : row[4],
            primaryKeyPosition: (index.pk >= 0 ? row[index.pk] : row[5]) as number,
            isGenerated: hiddenCode(row) === 2 || hiddenCode(row) === 3,
            isRowidAlias: Number(index.rowidAlias >= 0 ? row[index.rowidAlias] : row[7] ?? 0) === 1
          }));
      };

      const readNativeRowIdAliasColumn = async (
        table: string
      ): Promise<string | undefined> => {
        const result = await worker.call<NativeQueryResult>('query', [
          ROWID_ALIAS_COLUMN_SQL,
          [table]
        ]);
        return parseRowIdAliasColumn(result.values ?? [], table);
      };

      const assertNativeUpdateHasNoTargetTableTriggerWrites = async (
        table: string,
        columns: readonly string[],
        hasIntrinsicRowId: boolean = true
      ): Promise<void> => {
        const result = await worker.call<NativeQueryBatchResult>('queryBatch', [[
          { sql: MAIN_TABLE_ROOT_PAGE_SQL, params: [table] },
          {
            sql: buildUpdateTriggerProbeSql(table, columns, hasIntrinsicRowId),
            params: hasIntrinsicRowId ? [0] : []
          }
        ]]);
        if (!result || !Array.isArray(result.results) || result.results.length !== 2) {
          throw new Error(`SQLite returned invalid UPDATE trigger metadata for ${table}`);
        }
        const rootPage = parseMainTableRootPage(
          result.results[0].values ?? [],
          table
        );
        assertNoApplicableUpdateTriggerTargetWrites(
          table,
          rootPage,
          result.results[1].values ?? [],
          hasIntrinsicRowId ? 'rowid' : 'primary-key'
        );
      };

      const assertNativeMutationHasNoUntrackedPrograms = async (
        operation: 'INSERT' | 'DELETE',
        table: string,
        columns: readonly string[] = []
      ): Promise<void> => {
        const sql = operation === 'INSERT'
          ? buildInsertTriggerProbeSql(table, columns)
          : buildDeleteTriggerProbeSql(table);
        const result = await worker.call<NativeQueryResult>('query', [sql, []]);
        assertNoUntrackedMutationPrograms(operation, table, result.values ?? []);
      };

      const readNativeUpdatedRowId = async (
        table: string,
        aliasColumn: string | undefined,
        previousRowId: RecordId,
        updatedColumn: string | undefined,
        updatedValue: CellValue | undefined
      ): Promise<RecordId> => {
        const aliasWasUpdated = aliasColumn !== undefined
          && updatedColumn !== undefined
          && sqliteIdentifiersEqual(aliasColumn, updatedColumn);
        const predicateColumn = aliasWasUpdated ? escapeIdentifier(aliasColumn) : 'rowid';
        const candidate = aliasWasUpdated ? updatedValue : previousRowId;
        const result = await worker.call<NativeQueryResult>('query', [
          `SELECT CAST(rowid AS TEXT) FROM ${escapeMainIdentifier(table)} ` +
          `WHERE ${predicateColumn} = ? LIMIT 2`,
          [candidate ?? null]
        ]);
        if (result.values.length === 0) {
          throw unresolvableTriggeredRowIdUpdateError(table);
        }
        if (result.values.length !== 1) {
          throw new Error(`Rowid identity for ${table} matched more than one row`);
        }
        return validateRowId(result.values[0][0] as RecordId);
      };

      const getNativeInsertableColumnNames = async (table: string): Promise<string[]> => {
        const result = await worker.call<NativeQueryResult>('query', [
          "SELECT name FROM pragma.pragma_table_xinfo(?, 'main') " +
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

      const assertNativeDeleteSnapshotWithinBudget = async (
        table: string,
        insertableColumns: readonly string[],
        predicates: ReturnType<typeof buildRecordIdentityPredicateChunks>,
        rowIds: readonly RecordId[],
        includeSyntheticRowId: boolean,
        maxSnapshotBytes: number,
        operation: 'Delete' | 'Insert' = 'Delete'
      ): Promise<void> => {
        const valueColumns = deleteSnapshotValueColumns(
          insertableColumns,
          includeSyntheticRowId
        );
        let rowCount = 0;
        let valueBytes = 0;
        for (const predicate of predicates) {
          const query = buildDeleteSnapshotSizeQuery(table, valueColumns, predicate);
          const result = await worker.call<NativeQueryResult>('query', [query.sql, query.params]);
          const chunk = parseDeleteSnapshotSizeRow(result.values?.[0]);
          rowCount += chunk.rowCount;
          valueBytes += chunk.valueBytes;
        }
        assertDeleteSnapshotFitsUndoBudget({
          table,
          insertableColumns,
          includeSyntheticRowId,
          rowIds,
          rowCount,
          valueBytes,
          maxSnapshotBytes,
          operation
        });
      };

      const findNativeTableIdentity = async (table: string): Promise<TableIdentity | undefined> => {
        const metadata = await worker.call<NativeQueryResult>('query', [
          `SELECT "type", "wr" FROM pragma.pragma_table_list ` +
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

      const assertNativeRowIdAuthority = async (table: string): Promise<void> => {
        const authority = await worker.call<NativeQueryResult>('query', [
          ROWID_TABLE_AUTHORITY_SQL,
          [table, table]
        ]);
        if ((authority.values?.length ?? 0) !== 1) {
          throw new Error(
            `Table ${table} is read-only because a declared "rowid" column ` +
            `shadows SQLite's intrinsic row identity`
          );
        }
      };

      const resolveNativeTableIdentity = async (table: string): Promise<TableIdentity> => {
        const identity = await findNativeTableIdentity(table);
        if (!identity) throw new Error(`Table not found: ${table}`);
        if (identity.kind === 'rowid') {
          await assertNativeRowIdAuthority(table);
        }
        return identity;
      };

      const readNativeRowHistorySnapshot = async (
        table: string,
        identity: TableIdentity,
        rowId: RecordId,
        insertableColumns: readonly string[]
      ): Promise<DeletedRow> => {
        const predicate = buildRecordIdentityPredicate(rowId, identity);
        const textEncoding = await readNativeCellTextEncoding();
        const result = await worker.call<NativeQueryResult>('query', [
          `SELECT ${insertableColumns.map(buildStoredCellStateProjection).join(', ')} ` +
          `FROM ${escapeMainIdentifier(table)} WHERE ${predicate.sql} LIMIT 2`,
          predicate.params
        ]);
        if (result.values.length !== 1) throw new RowHistoryConflictError(table);
        const states = insertableColumns.map((column, index) => parseStoredCellState(
          result.values[0][index * 2],
          result.values[0][index * 2 + 1],
          `${table}.${column}`,
          { textEncoding }
        ));
        return {
          rowId,
          row: Object.fromEntries(insertableColumns.map(
            (column, index) => [
              column,
              states[index].rawTextBytes ?? states[index].value
            ]
          )),
          storageClasses: insertableColumns.map((column, index) => ({
            column,
            storageClass: states[index].storageClass
          }))
        };
      };

      const captureNativeInsertedRowHistory = async (
        table: string,
        identity: TableIdentity,
        rowId: RecordId,
        maxUndoSnapshotBytes?: number
      ): Promise<DeletedRow> => {
        const insertableColumns = await getNativeInsertableColumnNames(table);
        if (maxUndoSnapshotBytes !== undefined) {
          await assertNativeDeleteSnapshotWithinBudget(
            table,
            insertableColumns,
            [buildRecordIdentityPredicate(rowId, identity)],
            [rowId],
            identity.kind === 'rowid',
            maxUndoSnapshotBytes,
            'Insert'
          );
        }
        return readNativeRowHistorySnapshot(table, identity, rowId, insertableColumns);
      };

      /** Read the current table/catalog state while an undo transaction owns the schema snapshot. */
      const readNativeColumnDropTableState = async (
        table: string
      ): Promise<ColumnDropTableState> => {
        const [schema, columns, identity, dataVersionResult] = await Promise.all([
          worker.call<NativeQueryResult>('query', [COLUMN_DROP_TABLE_STATE_SQL, [table, table]]),
          getNativeTableInfo(table),
          resolveNativeTableIdentity(table),
          worker.call<NativeQueryResult>('query', ['PRAGMA data_version'])
        ]);
        const dataVersion = Number(dataVersionResult.values?.[0]?.[0]);
        return mapColumnDropTableState(
          table,
          columns.map(column => column.identifier),
          identity,
          schema.values ?? [],
          columns.filter(column => column.isGenerated).map(column => column.identifier),
          dataVersion
        );
      };

      /** Stage recorded values in the appended columns before rebuilding exact original DDL. */
      const restoreNativeDroppedColumnValues = async (
        table: string,
        deletedColumns: NonNullable<ModificationEntry['deletedColumns']>,
        identity: TableIdentity
      ): Promise<void> => {
        const batch = deletedColumns.map(column => {
          const escapedColumn = escapeIdentifier(column.name);
          let predicateSql: string | undefined;
          const paramsList = column.data.map(cell => {
            const rowId = identity.kind === 'rowid'
              ? validateRowId(cell.rowId)
              : cell.rowId;
            const predicate = buildRecordIdentityPredicate(rowId, identity);
            if (predicateSql !== undefined && predicateSql !== predicate.sql) {
              throw new Error(`Inconsistent row identity while restoring ${table}.${column.name}`);
            }
            predicateSql = predicate.sql;
            return [cell.value ?? null, ...predicate.params];
          });
          const sql =
            `UPDATE ${escapeMainIdentifier(table)} SET ${escapedColumn} = ? ` +
            `WHERE ${predicateSql ?? (identity.kind === 'rowid' ? 'rowid = ?' : '0')}`;
          return { sql, paramsList };
        }).filter(item => item.paramsList.length > 0);
        if (batch.length > 0) await worker.call('execBatch', [batch]);
      };

      const buildNativeCellLocator = (
        rowId: RecordId,
        identity: TableIdentity
      ): {
        kind: 'rowid'; value: CellValue;
      } | {
        kind: 'primaryKey'; columns: string[]; values: CellValue[]; integerCasts: boolean[];
      } => {
        const predicate = buildRecordIdentityPredicate(rowId, identity);
        return identity.kind === 'rowid'
          ? { kind: 'rowid', value: predicate.params[0] }
          : {
              kind: 'primaryKey',
              columns: identity.columns.map(column => column.identifier),
              values: predicate.params,
              integerCasts: predicate.primaryKeyIntegerCasts!
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

      const assertNativeRowIdBatchPriorsWithinEditLimit = async (
        table: string,
        updates: readonly CellUpdate[],
        editLimitBytes: number
      ): Promise<void> => {
        const queries = buildBatchPriorLimitQueries(table, updates, editLimitBytes);
        const metadata = await worker.call<NativeQueryBatchResult>('queryBatch', [
          queries.map(({ sql, params }) => ({ sql, params }))
        ]);
        if (metadata.results?.length !== queries.length) {
          throw new Error('Batch prior metadata fetch returned incomplete results');
        }
        queries.forEach((query, index) => {
          assertBatchPriorLimitResult(
            table,
            query,
            metadata.results[index].values ?? [],
            editLimitBytes
          );
        });
      };

      const assertNativeBatchHistoryWithinBudget = async (
        table: string,
        updates: readonly CellUpdate[],
        identity: TableIdentity,
        maxPriorValueBytes: number
      ): Promise<void> => {
        const preflight = buildBatchHistorySizePreflight(table, updates, identity);
        const metadata = await worker.call<NativeQueryBatchResult>('queryBatch', [
          preflight.queries.map(({ sql, params }) => ({ sql, params }))
        ]);
        assertBatchHistoryFitsUndoBudget({
          table,
          preflight,
          resultRows: preflight.queries.map((_, index) => metadata.results?.[index]?.values?.[0]),
          maxPriorValueBytes
        });
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

      let nativeCellTextEncoding: CellTextEncoding | undefined;
      const readNativeCellTextEncoding = async (): Promise<CellTextEncoding> => {
        if (nativeCellTextEncoding) return nativeCellTextEncoding;
        const result = await worker.call<NativeQueryResult>('query', [
          'PRAGMA encoding',
          []
        ]);
        // Every caller has already resolved an existing table. SQLite fixes the
        // database encoding once a table exists, so this connection-local cache
        // cannot become stale even when arbitrary SQL remains available.
        nativeCellTextEncoding = normalizeCellTextEncoding(result.values[0]?.[0]);
        return nativeCellTextEncoding;
      };

      const readNativePrimaryKeyRecordId = async (
        table: string,
        identity: Extract<TableIdentity, { kind: 'primaryKey' }>,
        predicate: { sql: string; params: CellValue[] },
        missingRowError?: Error
      ): Promise<RecordId> => {
        const result = await worker.call<NativeQueryResult>('query', [
          `SELECT ${buildByteFaithfulPrimaryKeyProjection(identity)} ` +
          `FROM ${escapeMainIdentifier(table)} WHERE ${predicate.sql} LIMIT 2`,
          predicate.params
        ]);
        if (result.values.length === 0) {
          throw missingRowError ?? new Error(`Updated row in ${table} no longer exists`);
        }
        if (result.values.length !== 1) {
          throw new Error(`Primary-key identity for ${table} matched more than one row`);
        }
        return encodeByteFaithfulPrimaryKeyRecordId(
          identity,
          result.values[0],
          await readNativeCellTextEncoding(),
          `Cannot resolve updated identity in ${table}`
        );
      };

      const applyNativeJsonPatchValue = async (
        currentValue: CellValue,
        patch: CellValue
      ): Promise<string> => {
        const patchText = typeof patch === 'string' ? patch : JSON.stringify(patch);
        const result = await worker.call<NativeQueryResult>('query', [
          `SELECT json_patch(COALESCE(?, '{}'), ?)`,
          [currentValue, patchText]
        ]);
        const value = result.values[0]?.[0];
        if (typeof value !== 'string') {
          throw new Error('SQLite returned an invalid json_patch result');
        }
        return value;
      };

      /** Preserve per-cell UPDATE semantics while carrying a changed rowid forward. */
      const updateNativeRowIdAliasCellBatchWithinSavepoint = async (
        table: string,
        aliasColumn: string,
        updates: CellUpdate[],
        editLimitBytes: number,
        isHistoryReplay: boolean
      ): Promise<CellUpdateResult[]> => {
        const textEncoding = await readNativeCellTextEncoding();
        const updatesByRow = new Map<RecordId, CellUpdate[]>();
        for (const update of updates) {
          const rowId = validateRowId(update.rowId);
          const rowUpdates = updatesByRow.get(rowId) ?? [];
          rowUpdates.push({ ...update, rowId });
          updatesByRow.set(rowId, rowUpdates);
        }

        const results: CellUpdateResult[] = [];
        for (const [rowId, rowUpdates] of updatesByRow) {
          const columns = [...new Set(rowUpdates.map(update => update.column))];
          if (columns.length !== rowUpdates.length) {
            throw new Error(`Batch update for ${table} contains the same column more than once`);
          }
          const current = await worker.call<NativeQueryResult>('query', [
            `SELECT ${columns.map(buildStoredCellStateProjection).join(', ')} ` +
            `FROM ${escapeMainIdentifier(table)} WHERE rowid = ? LIMIT 2`,
            [rowId]
          ]);
          if (current.values.length !== 1) {
            throw new Error(`Cannot update ${table}: row identity no longer exists`);
          }

          const preparedUpdates = await Promise.all(rowUpdates.map(async (update, index) => {
            const priorState = parseStoredCellState(
              current.values[0][index * 2],
              current.values[0][index * 2 + 1],
              `${table}.${update.column}`,
              { textEncoding }
            );
            const priorValue = priorState.value;
            const prepared = prepareCellUpdateForStorage(
              update.value,
              priorValue,
              update.operation ?? 'set'
            );
            const storedValue = prepared.operation === 'json_patch'
              ? await applyNativeJsonPatchValue(priorValue, prepared.value)
              : prepared.value;
            if (!isHistoryReplay && prepared.operation === 'json_patch') {
              assertCellValueWithinEditLimit(storedValue, editLimitBytes);
            }
            return { update, priorValue, priorState, prepared, storedValue };
          }));
          let newRowId = rowId;
          for (const preparedUpdate of preparedUpdates) {
            const escapedColumn = escapeIdentifier(preparedUpdate.update.column);
            const useNativePatch = preparedUpdate.prepared.operation === 'json_patch';
            const storedBindValue = useNativePatch
              ? (typeof preparedUpdate.prepared.value === 'string'
                  ? preparedUpdate.prepared.value
                  : JSON.stringify(preparedUpdate.prepared.value))
              : preparedUpdate.storedValue;
            const expression = useNativePatch
              ? `json_patch(COALESCE(${escapedColumn}, '{}'), ?)`
              : '?';
            const result = await worker.call<{ changes: number }>('run', [
              `UPDATE ${escapeMainIdentifier(table)} SET ${escapedColumn} = ${expression} ` +
              'WHERE rowid = ?',
              [storedBindValue, newRowId]
            ]);
            if (result?.changes !== 1) {
              throw new Error(`Cannot update ${table}: row identity no longer exists`);
            }
            newRowId = await readNativeUpdatedRowId(
              table,
              aliasColumn,
              newRowId,
              preparedUpdate.update.column,
              preparedUpdate.storedValue
            );
          }
          const post = await worker.call<NativeQueryResult>('query', [
            `SELECT ${columns.map(buildStoredCellStateProjection).join(', ')} ` +
            `FROM ${escapeMainIdentifier(table)} WHERE rowid = ? LIMIT 2`,
            [newRowId]
          ]);
          if (post.values.length !== 1) {
            throw unresolvableTriggeredRowIdUpdateError(table);
          }
          for (const [index, preparedUpdate] of preparedUpdates.entries()) {
            results.push({
              rowId,
              newRowId,
              columnName: preparedUpdate.update.column,
              priorValue: preparedUpdate.priorValue,
              newValue: preparedUpdate.prepared.value,
              priorState: preparedUpdate.priorState,
              postState: parseStoredCellState(
                post.values[0][index * 2],
                post.values[0][index * 2 + 1],
                `${table}.${preparedUpdate.update.column}`,
                { textEncoding }
              ),
              operation: preparedUpdate.prepared.operation
            });
          }
        }
        return results;
      };

      const updateNativePrimaryKeyCellBatch = async (
        table: string,
        identity: Extract<TableIdentity, { kind: 'primaryKey' }>,
        updates: CellUpdate[],
        maxEditValueBytes?: number,
        maxUndoSnapshotBytes?: number,
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
          await assertNativeUpdateHasNoTargetTableTriggerWrites(
            table,
            updates.map(update => update.column),
            false
          );
          // A second metadata-only gate under the writer savepoint closes the
          // external-writer race after the pre-savepoint refusal.
          if (!isHistoryReplay && maxUndoSnapshotBytes !== undefined) {
            await assertNativeBatchHistoryWithinBudget(
              table,
              updates,
              identity,
              maxUndoSnapshotBytes
            );
          }
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
          const textEncoding = await readNativeCellTextEncoding();
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
              `SELECT ${columns.map(buildStoredCellStateProjection).join(', ')} ` +
              `FROM ${escapeMainIdentifier(table)} WHERE ${oldPredicate.sql} LIMIT 2`,
              oldPredicate.params
            ]);
            if (current.values.length !== 1) {
              throw new Error(`Cannot update ${table}: row identity no longer exists`);
            }

            const preparedUpdates = await Promise.all(rowUpdates.map(async (update, index) => {
              const priorState = parseStoredCellState(
                current.values[0][index * 2],
                current.values[0][index * 2 + 1],
                `${table}.${update.column}`,
                { textEncoding }
              );
              const priorValue = priorState.value;
              const prepared = prepareCellUpdateForStorage(
                update.value,
                priorValue,
                update.operation ?? 'set'
              );
              const storedValue = prepared.operation === 'json_patch'
                ? await applyNativeJsonPatchValue(priorValue, prepared.value)
                : prepared.value;
              if (!isHistoryReplay && prepared.operation === 'json_patch') {
                // Validate the merged value, not only its bounded patch payload.
                assertCellValueWithinEditLimit(storedValue, editLimitBytes);
              }
              return { update, priorValue, priorState, prepared, storedValue };
            }));
            const updateResult = await worker.call<{ changes: number }>('run', [
              `UPDATE ${escapeMainIdentifier(table)} SET ` +
              `${preparedUpdates.map(({ update }) => `${escapeIdentifier(update.column)} = ?`).join(', ')} ` +
              `WHERE ${oldPredicate.sql}`,
              [
                ...preparedUpdates.map(update => update.storedValue),
                ...oldPredicate.params
              ]
            ]);
            if (updateResult?.changes !== 1) {
              throw new Error(`Cannot update ${table}: row identity no longer exists`);
            }

            const primaryKeyReplacements: Array<{ column: string; value: CellValue }> = [];
            for (const preparedUpdate of preparedUpdates) {
              const keyIndex = identity.columns.findIndex(
                keyColumn => keyColumn.identifier === preparedUpdate.update.column
              );
              if (keyIndex >= 0) {
                primaryKeyReplacements.push({
                  column: preparedUpdate.update.column,
                  value: preparedUpdate.storedValue
                });
              }
            }
            const candidateId = replacePrimaryKeyRecordIdValues(
              rowId,
              identity,
              primaryKeyReplacements
            );
            const newRowId = await readNativePrimaryKeyRecordId(
              table,
              identity,
              buildRecordIdentityPredicate(candidateId, identity),
              unresolvableTriggeredPrimaryKeyUpdateError(table)
            );
            const newPredicate = buildRecordIdentityPredicate(newRowId, identity);
            const post = await worker.call<NativeQueryResult>('query', [
              `SELECT ${columns.map(buildStoredCellStateProjection).join(', ')} ` +
              `FROM ${escapeMainIdentifier(table)} WHERE ${newPredicate.sql} LIMIT 2`,
              newPredicate.params
            ]);
            if (post.values.length !== 1) {
              throw unresolvableTriggeredPrimaryKeyUpdateError(table);
            }
            for (const [index, preparedUpdate] of preparedUpdates.entries()) {
              results.push({
                rowId,
                newRowId,
                columnName: preparedUpdate.update.column,
                priorValue: preparedUpdate.priorValue,
                newValue: preparedUpdate.prepared.value,
                priorState: preparedUpdate.priorState,
                postState: parseStoredCellState(
                  post.values[0][index * 2],
                  post.values[0][index * 2 + 1],
                  `${table}.${preparedUpdate.update.column}`,
                  { textEncoding }
                ),
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
        limit: number,
        signal?: AbortSignal
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
        ], queryTimeout + BOUNDED_QUERY_TRANSPORT_MARGIN_MS, signal);
      };

      const compileNativeView = async (view: string): Promise<void> => {
        await queryNativeSingleStatement(
          `EXPLAIN SELECT * FROM ${escapeMainViewIdentifier(view)}`
        );
      };

      const captureNativeViewDependencySnapshot = async (): Promise<SchemaDependencySnapshot> => (
        captureSchemaDependencySnapshot({
          queryRows: async (sql, params) => (
            (await worker.call<NativeQueryResult>('query', [sql, params])).values ?? []
          ),
          compileStatements: async statements => {
            const result = await worker.call<NativeCompileBatchResult>(
              'compileBatch',
              [statements]
            );
            if (!Array.isArray(result.errors)) {
              throw new Error('Native view dependency validation returned invalid results');
            }
            return result.errors.map(error => error ?? undefined);
          }
        })
      );

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
          const dependenciesBefore = await captureNativeViewDependencySnapshot();
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
          assertNoNewBrokenSchemaDependencies(
            dependenciesBefore,
            await captureNativeViewDependencySnapshot()
          );
          await worker.call('run', [`RELEASE ${savepointName}`]);
        } catch (err) {
          await safeRollbackSavepoint(savepointName, 'restoreViewDefinition');
          throw err;
        }
      };

      const undoLegacyNativeColumnDrop = async (
        table: string,
        deletedColumns: NonNullable<ModificationEntry['deletedColumns']>
      ): Promise<void> => {
        const batch: Array<{ sql: string; params?: CellValue[] }> = [];
        for (const column of deletedColumns) {
          validateSqlType(column.type);
          batch.push({
            sql:
              `ALTER TABLE ${escapeMainIdentifier(table)} ADD COLUMN ` +
              `${escapeIdentifier(column.name)} ${column.type}`
          });
        }
        for (const column of deletedColumns) {
          for (const { rowId, value } of column.data) {
            batch.push({
              sql:
                `UPDATE ${escapeMainIdentifier(table)} SET ${escapeIdentifier(column.name)} = ? ` +
                'WHERE rowid = ?',
              params: [value, validateRowId(rowId)]
            });
          }
        }
        if (batch.length > 0) await worker.call('execBatch', [batch]);
      };

      /**
       * Restore a dropped column from exact pre/post catalog snapshots.
       *
       * The caller may preconfigure the connection PRAGMAs and wrap this in an
       * outer history savepoint. The inner savepoint keeps standalone undo
       * atomic without preventing a multi-entry File Revert from composing it.
       */
      const undoNativeColumnDrop = async (
        table: string,
        deletedColumns: NonNullable<ModificationEntry['deletedColumns']>,
        snapshot: NonNullable<ModificationEntry['columnDropSnapshot']>
      ): Promise<void> => {
        const stagingTable = `__sqlite_explorer_column_restore_${crypto.randomUUID().replace(/-/g, '')}`;
        const plan = buildColumnDropRestorePlan(table, stagingTable, deletedColumns, snapshot);
        const readPragma = async (
          pragma: 'foreign_keys' | 'legacy_alter_table'
        ): Promise<number> => {
          const result = await worker.call<NativeQueryResult>('query', [`PRAGMA ${pragma}`]);
          const value = Number(result.values?.[0]?.[0]);
          if (value !== 0 && value !== 1) {
            throw new Error(`SQLite returned an invalid ${pragma} value`);
          }
          return value;
        };
        const setPragma = async (
          pragma: 'foreign_keys' | 'legacy_alter_table',
          value: number
        ): Promise<void> => {
          await worker.call('run', [`PRAGMA ${pragma} = ${value ? 'ON' : 'OFF'}`]);
          if (await readPragma(pragma) !== value) {
            throw new Error(`Unable to set PRAGMA ${pragma} for column-drop undo`);
          }
        };
        const readBoundedForeignKeyViolations = async (): Promise<NativeQueryResult['values']> => {
          const result = await worker.call<NativeQueryResult>('foreignKeyCheckBounded', [
            table,
            COLUMN_DROP_FOREIGN_KEY_VIOLATION_LIMIT,
            COLUMN_DROP_FOREIGN_KEY_VIOLATION_BYTES_LIMIT,
            COLUMN_DROP_FOREIGN_KEY_FIELD_BYTES_LIMIT
          ]);
          return result.values ?? [];
        };

        const foreignKeysBefore = await readPragma('foreign_keys');
        const legacyAlterBefore = await readPragma('legacy_alter_table');
        const restoreSavepoint = createSavepointName('sp_undo_column_drop');
        let savepointStarted = false;
        let operationError: unknown;
        try {
          if (foreignKeysBefore !== 0) await setPragma('foreign_keys', 0);
          if (legacyAlterBefore !== 1) await setPragma('legacy_alter_table', 1);

          await worker.call('run', [`SAVEPOINT ${restoreSavepoint}`]);
          savepointStarted = true;
          const foreignKeyBaseline = captureColumnDropForeignKeyBaseline(
            table,
            await readBoundedForeignKeyViolations()
          );
          const current = await readNativeColumnDropTableState(table);
          assertColumnDropTableStateCurrent(table, snapshot.after, current);
          const collision = await worker.call<NativeQueryResult>('query', [
            'SELECT 1 FROM main.sqlite_schema WHERE name = ? COLLATE NOCASE LIMIT 1',
            [stagingTable]
          ]);
          if ((collision.values?.length ?? 0) !== 0) {
            throw new Error(`Column-drop staging table already exists: ${stagingTable}`);
          }

          let sequenceState: { value: CellValue } | undefined;
          const sequenceCatalog = await worker.call<NativeQueryResult>('query', [
            "SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = 'sqlite_sequence'"
          ]);
          if ((sequenceCatalog.values?.length ?? 0) !== 0) {
            const sequence = await worker.call<NativeQueryResult>('query', [
              'SELECT seq FROM main.sqlite_sequence WHERE name = ? LIMIT 2',
              [table]
            ]);
            if ((sequence.values?.length ?? 0) > 1) {
              throw new Error(`Cannot undo column drop on ${table}: sqlite_sequence is ambiguous`);
            }
            if ((sequence.values?.length ?? 0) === 1) {
              sequenceState = { value: sequence.values[0][0] };
            }
          }

          for (const sql of plan.stageColumns) await worker.call('run', [sql]);
          await restoreNativeDroppedColumnValues(table, deletedColumns, snapshot.before.identity);
          for (const sql of plan.dropCurrentSchemaObjects) await worker.call('run', [sql]);
          await worker.call('run', [plan.renameCurrentTable]);
          await runNativeSingleStatement(plan.createOriginalTable);
          await worker.call('run', [plan.copyRows]);
          await worker.call('run', [plan.dropStagingTable]);
          if (sequenceState) {
            await worker.call('run', [
              'DELETE FROM main.sqlite_sequence WHERE name = ?',
              [table]
            ]);
            await worker.call('run', [
              'INSERT INTO main.sqlite_sequence(name, seq) VALUES (?, ?)',
              [table, sequenceState.value]
            ]);
          }
          for (const sql of plan.restoreSchemaObjects) await runNativeSingleStatement(sql);

          const restored = await readNativeColumnDropTableState(table);
          assertColumnDropTableStateCurrent(table, snapshot.before, restored);
          assertNoNewColumnDropForeignKeyViolations(
            table,
            foreignKeyBaseline,
            await readBoundedForeignKeyViolations()
          );
          await worker.call('run', [`RELEASE ${restoreSavepoint}`]);
          savepointStarted = false;
        } catch (error) {
          operationError = error;
          if (savepointStarted) {
            await safeRollbackSavepoint(restoreSavepoint, 'undoColumnDrop');
          }
        }

        let pragmaRestoreError: unknown;
        try {
          if (legacyAlterBefore !== 1) await setPragma('legacy_alter_table', legacyAlterBefore);
          if (foreignKeysBefore !== 0) await setPragma('foreign_keys', foreignKeysBefore);
        } catch (error) {
          pragmaRestoreError = error;
        }
        if (operationError !== undefined) {
          if (pragmaRestoreError !== undefined) {
            throw new Error(
              `Column-drop undo failed and connection PRAGMAs could not be restored: ${String(pragmaRestoreError)}`,
              { cause: operationError }
            );
          }
          throw operationError;
        }
        if (pragmaRestoreError !== undefined) throw pragmaRestoreError;
      };

      const guardedNativeCellHistoryEntries = (
        mod: ModificationEntry
      ): GuardedCellHistoryEntry[] => {
        const entries = mod.affectedCells ?? (
          mod.targetRowId !== undefined && mod.targetColumn
            ? [{
                rowId: mod.targetRowId,
                newRowId: mod.newTargetRowId,
                columnName: mod.targetColumn,
                newValue: mod.newValue,
                operation: mod.operation,
                priorState: mod.priorState,
                postState: mod.postState
              }]
            : []
        );
        if (entries.length === 0) throw new LegacyCellHistoryError();
        return entries.map(entry => {
          assertStoredCellState(entry.priorState);
          assertStoredCellState(entry.postState);
          return { ...entry, priorState: entry.priorState, postState: entry.postState };
        });
      };

      const replayNativeCellHistory = async (
        table: string,
        mod: ModificationEntry,
        direction: 'undo' | 'redo'
      ): Promise<void> => {
        if (mod.undoPolicy === 'barrier') {
          throw new Error('Forward-only cell history barriers cannot be replayed');
        }
        const cells = guardedNativeCellHistoryEntries(mod);
        const usesPrimaryKey = cells.some(cell => isPrimaryKeyRecordId(cell.rowId));
        if (usesPrimaryKey && !cells.every(cell => isPrimaryKeyRecordId(cell.rowId))) {
          throw new Error('Cannot mix rowid and primary-key row identities');
        }
        const identity: TableIdentity = usesPrimaryKey
          ? await resolveNativeTableIdentity(table)
          : await (async () => {
              await assertNativeRowIdAuthority(table);
              return { kind: 'rowid' } as const;
            })();
        if (usesPrimaryKey && identity.kind !== 'primaryKey') {
          throw new Error(`Primary-key identity cannot target rowid table ${table}`);
        }
        if (!usesPrimaryKey && identity.kind !== 'rowid') {
          throw new Error(`Rowid identity cannot target WITHOUT ROWID table ${table}`);
        }
        const textEncoding = await readNativeCellTextEncoding();

        const grouped = new Map<RecordId, GuardedCellHistoryEntry[]>();
        for (const cell of cells) {
          const row = grouped.get(cell.rowId) ?? [];
          if (row.some(existing => sqliteIdentifiersEqual(existing.columnName, cell.columnName))) {
            throw new Error(`Cell history for ${table} contains the same column more than once`);
          }
          row.push(cell);
          grouped.set(cell.rowId, row);
        }
        const groups = [...grouped.entries()];
        if (
          direction === 'undo'
          && cells.some(cell => cell.newRowId !== undefined && cell.newRowId !== cell.rowId)
        ) {
          groups.reverse();
        }

        const savepointName = createSavepointName('sp_replay_cell_history');
        await worker.call('run', [`SAVEPOINT ${savepointName}`]);
        try {
          await assertNativeUpdateHasNoTargetTableTriggerWrites(
            table,
            cells.map(cell => cell.columnName),
            identity.kind === 'rowid'
          );
          for (const [originalRowId, rowCells] of groups) {
            const recordedNewRowIds = new Set(
              rowCells.map(cell => cell.newRowId ?? cell.rowId)
            );
            if (recordedNewRowIds.size !== 1) {
              throw new Error(`Cell history for ${table} has inconsistent post-update identities`);
            }
            const recordedNewRowId = rowCells[0].newRowId ?? originalRowId;
            const currentRowId = direction === 'undo' ? recordedNewRowId : originalRowId;
            const targetRowId = direction === 'undo' ? originalRowId : recordedNewRowId;
            const currentPredicate = buildRecordIdentityPredicate(currentRowId, identity);
            const projections = rowCells.map(cell => buildStoredCellStateProjection(cell.columnName));
            const currentResult = await worker.call<NativeQueryResult>('query', [
              `SELECT ${projections.join(', ')} FROM ${escapeMainIdentifier(table)} ` +
              `WHERE ${currentPredicate.sql} LIMIT 2`,
              currentPredicate.params
            ]);
            if (currentResult.values.length !== 1) {
              throw new CellHistoryConflictError(table, rowCells.map(cell => cell.columnName));
            }

            const currentStates = rowCells.map((cell, index) => parseStoredCellState(
              currentResult.values[0][index * 2],
              currentResult.values[0][index * 2 + 1],
              `${table}.${cell.columnName}`,
              { textEncoding }
            ));
            const targetStates = rowCells.map((cell, index) => {
              const expected = direction === 'undo' ? cell.postState : cell.priorState;
              const recordedTarget = direction === 'undo' ? cell.priorState : cell.postState;
              const current = currentStates[index];
              if (cell.operation !== 'json_patch') {
                if (!storedCellStatesEqual(current, expected)) {
                  throw new CellHistoryConflictError(table, [cell.columnName]);
                }
                return recordedTarget;
              }
              if (current.storageClass !== expected.storageClass || cell.newValue === undefined) {
                throw new CellHistoryConflictError(table, [cell.columnName]);
              }
              const plan = planJsonPatchHistoryReplay(
                current.value,
                cell.newValue,
                cell.priorState.value,
                cell.postState.value,
                direction
              );
              if (plan.kind === 'conflict') {
                throw new CellHistoryConflictError(table, [cell.columnName]);
              }
              return Object.is(plan.value, recordedTarget.value)
                ? recordedTarget
                : parseStoredCellState('text', plan.value, `${table}.${cell.columnName} JSON replay`);
            });

            const writes = targetStates.map(state => buildStoredCellWrite(state));
            const guards = currentStates.map((state, index) => buildStoredCellPredicate(
              rowCells[index].columnName,
              state
            ));
            const update = await worker.call<{ changes: number }>('run', [
              `UPDATE ${escapeMainIdentifier(table)} SET ` +
              `${rowCells.map((cell, index) => (
                `${escapeIdentifier(cell.columnName)} = ${writes[index].sql}`
              )).join(', ')} WHERE ${currentPredicate.sql} AND ` +
              guards.map(guard => `(${guard.sql})`).join(' AND '),
              [
                ...writes.flatMap(write => write.params),
                ...currentPredicate.params,
                ...guards.flatMap(guard => guard.params)
              ]
            ]);
            if (update?.changes !== 1) {
              throw new CellHistoryConflictError(table, rowCells.map(cell => cell.columnName));
            }

            const targetPredicate = buildRecordIdentityPredicate(targetRowId, identity);
            const actualResult = await worker.call<NativeQueryResult>('query', [
              `SELECT ${projections.join(', ')} FROM ${escapeMainIdentifier(table)} ` +
              `WHERE ${targetPredicate.sql} LIMIT 2`,
              targetPredicate.params
            ]);
            if (actualResult.values.length !== 1) {
              throw new CellHistoryConflictError(table, rowCells.map(cell => cell.columnName));
            }
            const exactTarget = targetStates.every((state, index) => storedCellStatesEqual(
              state,
              parseStoredCellState(
                actualResult.values[0][index * 2],
                actualResult.values[0][index * 2 + 1],
                `${table}.${rowCells[index].columnName}`,
                { textEncoding }
              )
            ));
            if (!exactTarget) {
              throw new CellHistoryConflictError(table, rowCells.map(cell => cell.columnName));
            }
          }
          await worker.call('run', [`RELEASE ${savepointName}`]);
        } catch (error) {
          await safeRollbackSavepoint(savepointName, 'replayNativeCellHistory');
          throw error;
        }
      };

      const insertNativeRowInternal = async (
        table: string,
        data: Record<string, CellValue>,
        maxEditValueBytes: number | undefined,
        historyReplayToken: typeof HISTORY_REPLAY_EDIT_TOKEN | undefined,
        captureHistory: boolean,
        maxUndoSnapshotBytes?: number
      ): Promise<RecordId | DeletedRow> => {
        if (historyReplayToken !== HISTORY_REPLAY_EDIT_TOKEN) {
          assertCellValuesWithinEditLimit(Object.values(data), maxEditValueBytes);
        }
        const identity = await resolveNativeTableIdentity(table);
        const columns = Object.keys(data);
        let sql: string;
        let params: CellValue[] = [];

        if (columns.length === 0) {
          sql = `INSERT INTO ${escapeMainIdentifier(table)} DEFAULT VALUES`;
        } else {
          params = columns.map(column => data[column]);
          sql = `INSERT INTO ${escapeMainIdentifier(table)} ` +
            `(${columns.map(escapeIdentifier).join(', ')}) ` +
            `VALUES (${columns.map(() => '?').join(', ')})`;
        }

        const savepointName = createSavepointName(
          identity.kind === 'primaryKey' ? 'sp_insert_pk_row' : 'sp_insert_rowid_row'
        );
        await worker.call('run', [`SAVEPOINT ${savepointName}`]);
        try {
          await assertNativeMutationHasNoUntrackedPrograms('INSERT', table, columns);
          let rowId: RecordId;
          if (identity.kind === 'primaryKey') {
            const returning = await queryNativeSingleStatement<NativeQueryResult>(
              `${sql} RETURNING ${buildByteFaithfulPrimaryKeyProjection(identity)}`,
              params
            );
            if (returning.values.length !== 1) {
              throw new Error(`Insert into ${table} did not return exactly one primary-key identity`);
            }
            const candidateId = encodeByteFaithfulPrimaryKeyRecordId(
              identity,
              returning.values[0],
              await readNativeCellTextEncoding(),
              `Cannot insert into ${table}`
            );
            rowId = await readNativePrimaryKeyRecordId(
              table,
              identity,
              buildRecordIdentityPredicate(candidateId, identity)
            );
          } else {
            await worker.call('run', [sql, params]);
            const metadata = await queryNativeSingleStatement<NativeQueryResult>(
              'SELECT changes(), CAST(last_insert_rowid() AS TEXT)'
            );
            if (metadata.values.length !== 1 || Number(metadata.values[0][0]) !== 1) {
              throw new Error(`Insert into ${table} did not create exactly one row`);
            }
            rowId = validateRowId(metadata.values[0][1] as RecordId);
            const predicate = buildRecordIdentityPredicate(rowId, identity);
            const current = await queryNativeSingleStatement<NativeQueryResult>(
              `SELECT 1 FROM ${escapeMainIdentifier(table)} ` +
              `WHERE ${predicate.sql} LIMIT 2`,
              predicate.params
            );
            if (current.values.length !== 1) {
              throw new Error(
                `Insert into ${table} did not leave one addressable row; the insert was rolled back`
              );
            }
          }

          const history = captureHistory
            ? await captureNativeInsertedRowHistory(
                table,
                identity,
                rowId,
                maxUndoSnapshotBytes
              )
            : undefined;
          await worker.call('run', [`RELEASE ${savepointName}`]);
          return history ?? rowId;
        } catch (error) {
          await safeRollbackSavepoint(savepointName, 'insertNativeRow');
          throw error;
        }
      };

      const deleteNativeRowHistorySnapshots = async (
        table: string,
        snapshots: readonly DeletedRow[]
      ): Promise<void> => {
        if (snapshots.length === 0) throw new LegacyRowHistoryError();
        snapshots.forEach(rowHistoryStates);
        const identity = await resolveNativeTableIdentity(table);
        const savepointName = createSavepointName('sp_history_delete_rows');
        await worker.call('run', [`SAVEPOINT ${savepointName}`]);
        try {
          await assertNativeMutationHasNoUntrackedPrograms('DELETE', table);
          for (const snapshot of snapshots) {
            const rowIdentity = buildRecordIdentityPredicate(snapshot.rowId, identity);
            const rowState = buildRowHistoryPredicate(snapshot);
            const result = await worker.call<{ changes: number }>('run', [
              `DELETE FROM ${escapeMainIdentifier(table)} WHERE ` +
              `(${rowIdentity.sql}) AND (${rowState.sql})`,
              [...rowIdentity.params, ...rowState.params]
            ]);
            if (result?.changes !== 1) throw new RowHistoryConflictError(table);
          }
          await worker.call('run', [`RELEASE ${savepointName}`]);
        } catch (error) {
          await safeRollbackSavepoint(savepointName, 'deleteNativeRowHistorySnapshots');
          throw error;
        }
      };

      const restoreNativeRowHistorySnapshots = async (
        table: string,
        snapshots: readonly DeletedRow[]
      ): Promise<void> => {
        if (snapshots.length === 0) throw new LegacyRowHistoryError();
        const identity = await resolveNativeTableIdentity(table);
        const prepared = snapshots.map(snapshot => ({
          snapshot,
          states: rowHistoryStates(snapshot),
          writes: buildRowHistoryWrites(snapshot)
        }));
        const savepointName = createSavepointName('sp_history_restore_rows');
        await worker.call('run', [`SAVEPOINT ${savepointName}`]);
        try {
          for (const entry of prepared) {
            await assertNativeMutationHasNoUntrackedPrograms(
              'INSERT',
              table,
              entry.states.map(state => state.column)
            );
            const rowIdentity = buildRecordIdentityPredicate(entry.snapshot.rowId, identity);
            const existing = await worker.call<NativeQueryResult>('query', [
              `SELECT 1 FROM ${escapeMainIdentifier(table)} ` +
              `WHERE ${rowIdentity.sql} LIMIT 1`,
              rowIdentity.params
            ]);
            if (existing.values.length !== 0) throw new RowHistoryConflictError(table);
          }

          for (const entry of prepared) {
            const columns = entry.writes.map(item => item.column);
            const values = entry.writes.map(item => item.write.sql);
            const params = entry.writes.flatMap(item => item.write.params);
            if (
              identity.kind === 'rowid'
              && !columns.some(column => column.toLowerCase() === 'rowid')
            ) {
              columns.unshift('rowid');
              values.unshift('?');
              params.unshift(entry.snapshot.rowId);
            }
            const inserted = await worker.call<{ changes: number }>('run', [
              `INSERT INTO ${escapeMainIdentifier(table)} ` +
              `(${columns.map(escapeIdentifier).join(', ')}) VALUES (${values.join(', ')})`,
              params
            ]);
            if (inserted?.changes !== 1) throw new RowHistoryConflictError(table);

            const rowIdentity = buildRecordIdentityPredicate(entry.snapshot.rowId, identity);
            const rowState = buildRowHistoryPredicate(entry.snapshot);
            const verified = await worker.call<NativeQueryResult>('query', [
              `SELECT 1 FROM ${escapeMainIdentifier(table)} WHERE ` +
              `(${rowIdentity.sql}) AND (${rowState.sql}) LIMIT 2`,
              [...rowIdentity.params, ...rowState.params]
            ]);
            if (verified.values.length !== 1) throw new RowHistoryConflictError(table);
          }
          await worker.call('run', [`RELEASE ${savepointName}`]);
        } catch (error) {
          await safeRollbackSavepoint(savepointName, 'restoreNativeRowHistorySnapshots');
          throw error;
        }
      };

      const rawOperations: DatabaseOperations = {
        engineKind: Promise.resolve('native'),

        executeQuery: async (
          sql: string,
          params?: CellValue[],
          signal?: AbortSignal
        ): Promise<QueryResultSet[]> => {
          let result: NativeQueryResult;
          if (isGeneratedExportSpoolStatement(sql)) {
            const boundary = `/*sqlite_explorer_boundary_${crypto.randomUUID().replace(/-/g, '')}*/`;
            result = await worker.call<NativeQueryResult>(
              'queryExportSpool',
              [`${sql}\n${boundary}`, sql, boundary, params, queryTimeout],
              queryTimeout + BOUNDED_QUERY_TRANSPORT_MARGIN_MS,
              signal
            );
          } else {
            signal?.throwIfAborted();
            result = await worker.call<NativeQueryResult>('query', [sql, params]);
            signal?.throwIfAborted();
          }

          // Return in QueryResultSet format with multiple property names for compatibility:
          // - headers/rows: new naming convention from src/core/types.ts
          // - columns/values: sql.js compatible aliases
          // - columnNames/records: used by webview (core/ui/viewer.html) for schema queries
          const resultSets = result.resultSets ?? [result];
          return resultSets.map(resultSet => ({
            headers: resultSet.columns,
            rows: resultSet.values,
            columns: resultSet.columns,
            values: resultSet.values,
            columnNames: resultSet.columns,
            records: resultSet.values
          }));
        },

        getCellMetadata: async (target: CellReadTarget): Promise<CellMetadata> => {
          validateCellReadTarget(target);
          return readNativeCellMetadata(target.table, target.rowId, target.column);
        },

        openCellReadSession: async (target: CellReadTarget): Promise<CellReadSession> => {
          validateCellReadTarget(target);
          const identity = await resolveNativeTableIdentity(target.table);
          return worker.call<CellReadSession>(
            'openCellReadSession',
            [
              target.table,
              target.column,
              buildNativeCellLocator(target.rowId, identity),
              queryTimeout
            ],
            queryTimeout + BOUNDED_QUERY_TRANSPORT_MARGIN_MS
          );
        },

        readCellChunk: async (
          sessionId: string,
          byteOffset: number,
          maxBytes: number
        ): Promise<CellReadChunk> => {
          validateCellReadWindow(byteOffset, maxBytes);
          return worker.call<CellReadChunk>(
            'readCellChunk',
            [sessionId, byteOffset, maxBytes, queryTimeout],
            queryTimeout + BOUNDED_QUERY_TRANSPORT_MARGIN_MS
          );
        },

        closeCellReadSession: async (sessionId: string): Promise<void> => {
          await worker.call(
            'closeCellReadSession',
            [sessionId, queryTimeout],
            queryTimeout + BOUNDED_QUERY_TRANSPORT_MARGIN_MS
          );
        },

        serializeDatabase: async (signal?: AbortSignal): Promise<Uint8Array> => {
          return exportNativeDatabase(signal);
        },

        applyModifications: async () => {
          throw new Error(
            'applyModifications is not supported on the native backend; ' +
            'history replay uses redoModification'
          );
        },

        /**
         * Undo a modification by executing the inverse SQL.
         */
        undoModification: async (mod: ModificationEntry) => {
          const { modificationType, targetTable, targetRowId, newTargetRowId, targetColumn, priorValue, newValue, operation, affectedCells, deletedRows, columnDef, deletedColumns, columnDropSnapshot } = mod;
          if (modificationType === 'pragma_update') {
            throw new Error('Persistent PRAGMA changes are forward-only history barriers');
          }
          if (!targetTable) {
            throw new Error(`Cannot undo ${modificationType}: missing target table`);
          }

          switch (modificationType) {
            case 'cell_update': {
              await replayNativeCellHistory(targetTable, mod, 'undo');
              break;
            }

            case 'row_insert':
              if (!mod.insertedRow || targetRowId === undefined) {
                throw new LegacyRowHistoryError();
              }
              if (
                typeof mod.insertedRow.rowId !== typeof targetRowId ||
                String(mod.insertedRow.rowId) !== String(targetRowId)
              ) throw new LegacyRowHistoryError();
              await deleteNativeRowHistorySnapshots(targetTable, [mod.insertedRow]);
              break;

            case 'row_delete':
              if (deletedRows && deletedRows.length > 0) {
                await restoreNativeRowHistorySnapshots(targetTable, deletedRows);
              } else {
                throw new Error('Cannot undo row_delete: missing deleted row data');
              }
              break;

            case 'column_add':
              if (targetColumn) {
                await rawOperations.deleteColumns(
                  targetTable,
                  [targetColumn],
                  undefined,
                  mod.columnAddSnapshot
                );
              } else {
                throw new Error('Cannot undo column_add: missing column name');
              }
              break;

            case 'column_drop':
              if (deletedColumns && deletedColumns.length > 0) {
                if (columnDropSnapshot) {
                  await undoNativeColumnDrop(targetTable, deletedColumns, columnDropSnapshot);
                } else {
                  await undoLegacyNativeColumnDrop(targetTable, deletedColumns);
                }
              } else {
                throw new Error('Cannot undo column_drop: missing deleted column data');
              }
              break;

            case 'table_create':
              if (!mod.tableCreateSnapshot) {
                throw new Error(
                  `Cannot undo table creation on ${targetTable}: history lacks the required schema snapshot`
                );
              }
              {
              const savepointName = createSavepointName('sp_undo_table_create');
              await worker.call('run', [`SAVEPOINT ${savepointName}`]);
              try {
                const dependenciesBefore = await captureNativeViewDependencySnapshot();
                const current = await readNativeColumnDropTableState(targetTable);
                  assertTableSchemaStateCurrent(
                    targetTable,
                    mod.tableCreateSnapshot,
                    current,
                    'undo table creation',
                    'after the table was created'
                  );
                const rows = await worker.call<NativeQueryResult>('query', [
                  `SELECT 1 FROM ${escapeMainIdentifier(targetTable)} LIMIT 1`
                ]);
                  if ((rows.values?.length ?? 0) !== 0) {
                    throw new Error(
                      `Cannot undo table creation on ${targetTable}: the table contains data`
                    );
                  }
                await worker.call('run', [
                  `DROP TABLE ${escapeMainIdentifier(targetTable)}`
                ]);
                assertNoNewBrokenSchemaDependencies(
                  dependenciesBefore,
                  await captureNativeViewDependencySnapshot()
                );
                await worker.call('run', [`RELEASE ${savepointName}`]);
                } catch (error) {
                  await safeRollbackSavepoint(savepointName, 'undoTableCreate');
                  throw error;
                }
              }
              break;

            case 'view_create':
                if (mod.viewDefAfter) {
                  await applyNativeViewHistoryState(targetTable, mod.viewDefAfter, null);
                } else {
                  throw new Error('Cannot undo view_create: missing view definition');
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
                  throw new Error('Cannot undo view_edit: missing view definition');
                }
                break;

            case 'view_drop':
                if (mod.viewDefBefore) {
                  await applyNativeViewHistoryState(targetTable, null, mod.viewDefBefore);
                } else {
                  throw new Error('Cannot undo view_drop: missing view definition');
                }
                break;

            default:
              throw new Error(`Cannot undo unsupported modification type: ${String(modificationType)}`);
          }
        },

        /**
         * Redo a modification by re-executing the original change.
         */
        redoModification: async (mod: ModificationEntry) => {
          const { modificationType, targetTable, targetColumn, newValue, operation, affectedCells, tableDef, columnDef, deletedColumns, droppedIndexes } = mod;
          if (modificationType === 'pragma_update') {
            throw new Error('Persistent PRAGMA changes are forward-only history barriers');
          }
          if (!targetTable) {
            throw new Error(`Cannot redo ${modificationType}: missing target table`);
          }

          switch (modificationType) {
            case 'cell_update':
              await replayNativeCellHistory(targetTable, mod, 'redo');
              break;

            case 'row_insert':
              if (!mod.insertedRow) throw new LegacyRowHistoryError();
              await restoreNativeRowHistorySnapshots(targetTable, [mod.insertedRow]);
              break;

            case 'row_delete':
              if (!mod.deletedRows || mod.deletedRows.length === 0) {
                throw new LegacyRowHistoryError();
              }
              await deleteNativeRowHistorySnapshots(targetTable, mod.deletedRows);
              break;

            case 'column_add':
              if (targetColumn && columnDef) {
                if (!mod.columnAddBeforeSnapshot) {
                  throw new Error('Cannot redo column addition: pre-add schema snapshot is unavailable');
                }
                await rawOperations.addColumn(
                  targetTable,
                  targetColumn,
                  columnDef.type,
                  columnDef.defaultValue,
                  mod.columnAddBeforeSnapshot
                );
              } else {
                throw new Error('Cannot redo column_add: missing column definition');
              }
              break;

            case 'column_drop':
              if (deletedColumns) {
                await rawOperations.deleteColumns(
                  targetTable,
                  deletedColumns.map(c => c.name),
                  droppedIndexes ?? undefined,
                  mod.columnDropSnapshot?.before
                );
              } else {
                throw new Error('Cannot redo column_drop: missing deleted column data');
              }
              break;

            case 'table_create':
              if (tableDef && tableDef.columns) {
                await rawOperations.createTable(targetTable, tableDef.columns);
              } else {
                throw new Error('Cannot redo table_create: missing table definition');
              }
              break;

            case 'view_create':
              if (mod.viewDefAfter) {
                await applyNativeViewHistoryState(targetTable, null, mod.viewDefAfter);
              } else {
                throw new Error('Cannot redo view_create: missing view definition');
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
                throw new Error('Cannot redo view_edit: missing view definition');
              }
              break;

            case 'view_drop':
              if (mod.viewDefBefore) {
                await applyNativeViewHistoryState(targetTable, mod.viewDefBefore, null);
              } else {
                throw new Error('Cannot redo view_drop: missing view definition');
              }
              break;

            default:
              throw new Error(`Cannot redo unsupported modification type: ${String(modificationType)}`);
          }
        },

        flushChanges: async () => {},
        discardModifications: async (mods: ModificationEntry[]) => {
          await rawOperations.revertModifications!(mods, []);
        },

        revertModifications: async (
          discard: ModificationEntry[],
          restore: ModificationEntry[],
          signal?: AbortSignal
        ) => {
          signal?.throwIfAborted();
          const needsColumnRestorePragmas = discard.some(
            modification => modification.modificationType === 'column_drop'
          );
          const readBooleanPragma = async (
            pragma: 'foreign_keys' | 'legacy_alter_table'
          ): Promise<number> => {
            const result = await worker.call<NativeQueryResult>('query', [`PRAGMA ${pragma}`]);
            const value = Number(result.values?.[0]?.[0]);
            if (value !== 0 && value !== 1) {
              throw new Error(`SQLite returned an invalid ${pragma} value`);
            }
            return value;
          };
          const setBooleanPragma = async (
            pragma: 'foreign_keys' | 'legacy_alter_table',
            value: number
          ): Promise<void> => {
            await worker.call('run', [`PRAGMA ${pragma} = ${value ? 'ON' : 'OFF'}`]);
            if (await readBooleanPragma(pragma) !== value) {
              throw new Error(`Unable to set PRAGMA ${pragma} for atomic history replay`);
            }
          };

          const foreignKeysBefore = needsColumnRestorePragmas
            ? await readBooleanPragma('foreign_keys')
            : 0;
          const legacyAlterBefore = needsColumnRestorePragmas
            ? await readBooleanPragma('legacy_alter_table')
            : 1;
          let pragmasPrepared = false;
          let operationError: unknown;
          const savepointName = createSavepointName('sp_revert_checkpoint');
          let savepointStarted = false;
          try {
            pragmasPrepared = true;
            if (needsColumnRestorePragmas) {
              if (foreignKeysBefore !== 0) await setBooleanPragma('foreign_keys', 0);
              if (legacyAlterBefore !== 1) await setBooleanPragma('legacy_alter_table', 1);
            }
            await worker.call('run', [`SAVEPOINT ${savepointName}`]);
            savepointStarted = true;
            for (let index = discard.length - 1; index >= 0; index--) {
              signal?.throwIfAborted();
              await rawOperations.undoModification(discard[index]);
            }
            for (const modification of restore) {
              signal?.throwIfAborted();
              await rawOperations.redoModification(modification);
            }
            signal?.throwIfAborted();
            await worker.call('run', [`RELEASE ${savepointName}`]);
            savepointStarted = false;
          } catch (error) {
            operationError = error;
            if (savepointStarted) {
              await safeRollbackSavepoint(savepointName, 'revertModifications');
            }
          }

          let pragmaRestoreError: unknown;
          if (pragmasPrepared && needsColumnRestorePragmas) {
            try {
              if (legacyAlterBefore !== 1) {
                await setBooleanPragma('legacy_alter_table', legacyAlterBefore);
              }
              if (foreignKeysBefore !== 0) {
                await setBooleanPragma('foreign_keys', foreignKeysBefore);
              }
            } catch (error) {
              pragmaRestoreError = error;
            }
          }
          if (operationError !== undefined) {
            if (pragmaRestoreError !== undefined) {
              throw new AggregateError(
                [operationError, pragmaRestoreError],
                'Atomic history replay failed and connection PRAGMAs could not be restored'
              );
            }
            throw operationError;
          }
          if (pragmaRestoreError !== undefined) {
            outputChannel?.appendLine(
              `[NativeWorker] History replay committed, but connection PRAGMAs could not be restored: ${String(pragmaRestoreError)}`
            );
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
            }], maxEditValueBytes, undefined, historyReplayToken);
            return result[0]?.newRowId ?? rowId;
          }

          // Validate rowId is a number
          const rowIdNum = validateRowId(rowId);
          await assertNativeRowIdAuthority(table);
          const savepointName = createSavepointName('sp_update_rowid_cell');
          await worker.call('run', [`SAVEPOINT ${savepointName}`]);

          try {
            const rowIdAliasColumn = await readNativeRowIdAliasColumn(table);
            await assertNativeUpdateHasNoTargetTableTriggerWrites(table, [column]);
            let sql: string;
            let params: CellValue[];

            if (patch) {
              // COALESCE handles NULL columns: json_patch(NULL, x) returns NULL,
              // but expected behavior is to treat NULL as empty object (matching WASM path)
              const escapedColumn = escapeIdentifier(column);
              sql =
                `UPDATE ${escapeMainIdentifier(table)} SET ${escapedColumn} = ` +
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
                `UPDATE ${escapeMainIdentifier(table)} SET ${escapedColumn} = ? WHERE rowid = ?` +
                (enforcePriorPolicy
                  ? ` AND NOT (typeof(${escapedColumn}) IN ('text', 'blob') ` +
                    `AND length(CAST(${escapedColumn} AS BLOB)) > ?)`
                  : '');
              params = enforcePriorPolicy
                ? [value, rowIdNum, editLimitBytes]
                : [value, rowIdNum];
            }

            const result = await worker.call<{ changes: number }>('run', [sql, params]);
            const changes = result?.changes;
            if (changes !== 1) {
              if (enforcePriorPolicy) {
                await assertNativeCellPriorWithinEditLimit(
                  table,
                  rowIdNum,
                  column,
                  editLimitBytes,
                  { kind: 'rowid' }
                );
              }
              if (typeof changes === 'number' && changes > 1) {
                throw new Error(`Cell ${table}.${column} matched more than one row`);
              }
              throw new Error(`Cannot update ${table}.${column}: row ${rowId} no longer exists`);
            }
            const newRowId = await readNativeUpdatedRowId(
              table,
              rowIdAliasColumn,
              rowIdNum,
              column,
              patch ?? value
            );
            await worker.call('run', [`RELEASE ${savepointName}`]);
            return newRowId;
          } catch (error) {
            await safeRollbackSavepoint(savepointName, 'updateCell');
            throw error;
          }
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
            if (identity.kind === 'rowid') {
              return readNativeUpdatedRowId(
                table,
                await readNativeRowIdAliasColumn(table),
                validateRowId(rowId),
                column,
                value
              );
            }

            const keyIndex = identity.columns.findIndex(key => key.identifier === column);
            const candidateId = replacePrimaryKeyRecordIdValues(
              rowId,
              identity,
              keyIndex >= 0 ? [{ column, value }] : []
            );
            return readNativePrimaryKeyRecordId(
              table,
              identity,
              buildRecordIdentityPredicate(candidateId, identity),
              unresolvableTriggeredPrimaryKeyUpdateError(table)
            );
          };

          const savepointName = createSavepointName('sp_replace_oversized_cell');
          await worker.call('run', [`SAVEPOINT ${savepointName}`]);
          try {
            await assertNativeUpdateHasNoTargetTableTriggerWrites(
              table,
              [column],
              identity.kind === 'rowid'
            );
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
          const result = await insertNativeRowInternal(
            table,
            data,
            maxEditValueBytes,
            historyReplayToken,
            false
          );
          return typeof result === 'object' ? result.rowId : result;
        },

        insertRowWithHistory: async (
          table: string,
          data: Record<string, CellValue>,
          maxEditValueBytes?: number,
          maxUndoSnapshotBytes?: number
        ): Promise<DeletedRow> => {
          const result = await insertNativeRowInternal(
            table,
            data,
            maxEditValueBytes,
            undefined,
            true,
            maxUndoSnapshotBytes
          );
          if (typeof result !== 'object') {
            throw new Error(`Insert into ${table} did not capture guarded row history`);
          }
          return result;
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
          const escapedTable = escapeMainIdentifier(table);

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
            const guardedShapes = new Set<string>();
            for (const row of rows) {
              const columns = Object.keys(row);
              const shape = columns.join('\0');
              if (guardedShapes.has(shape)) continue;
              guardedShapes.add(shape);
              await assertNativeMutationHasNoUntrackedPrograms('INSERT', table, columns);
            }
            await worker.call('execBatch', [batchItems]);
          }
        },

        /**
         * Delete rows by ID.
         */
        deleteRows: async (
          table: string,
          rowIds: RecordId[],
          maxUndoSnapshotBytes?: number
        ): Promise<DeletedRow[]> => {
          rowIds.forEach(assertMutableRecordId);
          if (rowIds.length === 0) return [];
          const identity = await resolveNativeTableIdentity(table);

          if (rowIds.some(isPrimaryKeyRecordId)) {
            if (!rowIds.every(isPrimaryKeyRecordId)) {
              throw new Error('Cannot mix rowid and primary-key row identities');
            }
            if (identity.kind !== 'primaryKey') {
              throw new Error(`Primary-key identity cannot target rowid table ${table}`);
            }
            const predicates = buildRecordIdentityPredicateChunks(rowIds, identity);
            const savepointName = createSavepointName('sp_delete_pk_rows');
            await worker.call('run', [`SAVEPOINT ${savepointName}`]);
            try {
              await assertNativeMutationHasNoUntrackedPrograms('DELETE', table);
              const insertableColumns = await getNativeInsertableColumnNames(table);
              if (maxUndoSnapshotBytes !== undefined) {
                await assertNativeDeleteSnapshotWithinBudget(
                  table,
                  insertableColumns,
                  predicates,
                  rowIds,
                  false,
                  maxUndoSnapshotBytes
                );
              }
              const textEncoding = await readNativeCellTextEncoding();
              const deletedRows: DeletedRow[] = [];
              for (const predicate of predicates) {
                const current = await worker.call<NativeQueryResult>('query', [
                  `SELECT ${insertableColumns.map(buildStoredCellStateProjection).join(', ')} ` +
                  `FROM ${escapeMainIdentifier(table)} WHERE ${predicate.sql}`,
                  predicate.params
                ]);
                const primaryKeyIndices = identity.columns.map(column => {
                  const index = insertableColumns.indexOf(column.identifier);
                  if (index < 0) {
                    throw new Error(`Primary-key column missing from ${table}: ${column.identifier}`);
                  }
                  return index;
                });
                deletedRows.push(...current.values.map(row => {
                  const states = insertableColumns.map((column, index) => parseStoredCellState(
                    row[index * 2],
                    row[index * 2 + 1],
                    `${table}.${column}`,
                    { textEncoding }
                  ));
                  const deletedRowId = encodePrimaryKeyRecordId(
                    identity.columns,
                    primaryKeyIndices.map(index => states[index].value)
                  );
                  const rowData = Object.fromEntries(insertableColumns.map(
                    (column, index) => [
                      column,
                      states[index].rawTextBytes ?? states[index].value
                    ]
                  ));
                  return {
                    rowId: deletedRowId,
                    row: rowData,
                    storageClasses: insertableColumns.map((column, index) => ({
                      column,
                      storageClass: states[index].storageClass
                    }))
                  };
                }));
              }
              if (deletedRows.length !== rowIds.length) {
                throw new Error(`Cannot delete from ${table}: one or more row identities no longer exist`);
              }
              for (const predicate of predicates) {
                await worker.call('run', [
                  `DELETE FROM ${escapeMainIdentifier(table)} WHERE ${predicate.sql}`,
                  predicate.params
                ]);
              }
              await worker.call('run', [`RELEASE ${savepointName}`]);
              return deletedRows;
            } catch (error) {
              await safeRollbackSavepoint(savepointName, 'deleteNativePrimaryKeyRows');
              throw error;
            }
          }

          if (identity.kind !== 'rowid') {
            throw new Error(`Rowid identity cannot target WITHOUT ROWID table ${table}`);
          }

          // Snapshot rowid rows atomically and return the same replay payload
          // shape as primary-key deletion.
          const predicates = buildRecordIdentityPredicateChunks(rowIds, identity);
          const savepointName = createSavepointName('sp_delete_rowid_rows');
          await worker.call('run', [`SAVEPOINT ${savepointName}`]);
          try {
            await assertNativeMutationHasNoUntrackedPrograms('DELETE', table);
            const insertableColumns = await getNativeInsertableColumnNames(table);
            if (maxUndoSnapshotBytes !== undefined) {
              await assertNativeDeleteSnapshotWithinBudget(
                table,
                insertableColumns,
                predicates,
                rowIds,
                true,
                maxUndoSnapshotBytes
              );
            }
            const textEncoding = await readNativeCellTextEncoding();
            const deletedRows: DeletedRow[] = [];
            for (const predicate of predicates) {
              const current = await worker.call<NativeQueryResult>('query', [
                `SELECT CAST(rowid AS TEXT), ` +
                `${insertableColumns.map(buildStoredCellStateProjection).join(', ')} ` +
                `FROM ${escapeMainIdentifier(table)} WHERE ${predicate.sql}`,
                predicate.params
              ]);
              deletedRows.push(...current.values.map(row => {
                const deletedRowId = validateRowId(row[0] as RecordId | bigint);
                const states = insertableColumns.map((column, index) => parseStoredCellState(
                  row[index * 2 + 1],
                  row[index * 2 + 2],
                  `${table}.${column}`,
                  { textEncoding }
                ));
                const rowData: Record<string, CellValue> = Object.fromEntries(
                  insertableColumns.map((column, index) => [
                    column,
                    states[index].rawTextBytes ?? states[index].value
                  ])
                );
                return {
                  rowId: deletedRowId,
                  row: rowData,
                  storageClasses: insertableColumns.map((column, index) => ({
                    column,
                    storageClass: states[index].storageClass
                  }))
                };
              }));
            }
            if (deletedRows.length !== rowIds.length) {
              throw new Error(`Cannot delete from ${table}: one or more row identities no longer exist`);
            }
            for (const predicate of predicates) {
              await worker.call('run', [
                `DELETE FROM ${escapeMainIdentifier(table)} WHERE ${predicate.sql}`,
                predicate.params
              ]);
            }
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
          const indexQuery = `
            SELECT name, sql FROM main.sqlite_master
            WHERE type = 'index'
              AND tbl_name = ?
              AND sql IS NOT NULL
          `;
          const indexResult = await worker.call<NativeQueryResult>('query', [indexQuery, [table]]);
          const indexes = (indexResult.values ?? []).map(row => ({
            name: row[0] as string,
            sql: row[1] as string
          }));
          if (indexes.length === 0 || columns.length === 0) return [];

          const tableInfo = await worker.call<NativeQueryResult>('query', [
            `PRAGMA main.table_xinfo(${escapeIdentifier(table)})`
          ]);
          const tableColumns = (tableInfo.values ?? []).map(row => row[1] as string);
          const targetColumns = resolveIndexDependencyColumns(tableColumns, columns);
          if (targetColumns.length === 0) return [];
          const suffix = crypto.randomUUID().replace(/-/g, '');
          const probeTable = `__sqlite_explorer_index_probe_${suffix}`;
          const probeIndex = `__sqlite_explorer_index_candidate_${suffix}`;
          const savepointName = createSavepointName('sp_index_dependencies');

          await worker.call('run', [`SAVEPOINT ${savepointName}`]);
          try {
            await worker.call('run', [
              buildIndexDependencyProbeTableSql(probeTable, tableColumns)
            ]);
            const baselineSavepoint = createSavepointName('sp_index_baseline');
            await worker.call('run', [`SAVEPOINT ${baselineSavepoint}`]);
            try {
              for (const column of targetColumns) {
                await worker.call('run', [
                  `ALTER TABLE temp.${escapeIdentifier(probeTable)} `
                  + `DROP COLUMN ${escapeIdentifier(column)}`
                ]);
              }
              await worker.call('run', [`ROLLBACK TO ${baselineSavepoint}`]);
              await worker.call('run', [`RELEASE ${baselineSavepoint}`]);
            } catch (error) {
              await safeRollbackSavepoint(baselineSavepoint, 'findDependentIndexBaseline');
              throw new Error(
                'Cannot establish the index dependency probe baseline',
                { cause: error }
              );
            }

            const dependentIndexes: string[] = [];
            for (const index of indexes) {
              const candidateSavepoint = createSavepointName('sp_index_candidate');
              await worker.call('run', [`SAVEPOINT ${candidateSavepoint}`]);
              try {
                await worker.call('run', [buildIndexDependencyProbeIndexSql(
                  probeTable,
                  probeIndex,
                  index.sql
                )]);
                let isDependent = false;
                for (const column of targetColumns) {
                  try {
                    await worker.call('run', [
                      `ALTER TABLE temp.${escapeIdentifier(probeTable)} `
                      + `DROP COLUMN ${escapeIdentifier(column)}`
                    ]);
                  } catch {
                    isDependent = true;
                    break;
                  }
                }
                await worker.call('run', [`ROLLBACK TO ${candidateSavepoint}`]);
                await worker.call('run', [`RELEASE ${candidateSavepoint}`]);
                if (isDependent) dependentIndexes.push(index.name);
              } catch (error) {
                await safeRollbackSavepoint(candidateSavepoint, 'findDependentIndex');
                throw new Error(
                  `Cannot inspect dependency for index ${escapeIdentifier(index.name)}`,
                  { cause: error }
                );
              }
            }

            await worker.call('run', [`ROLLBACK TO ${savepointName}`]);
            await worker.call('run', [`RELEASE ${savepointName}`]);
            return dependentIndexes;
          } catch (error) {
            await safeRollbackSavepoint(savepointName, 'findDependentIndexes');
            throw error;
          }
        },

        /**
         * Delete columns by name.
         * If dropDependentIndexes is provided, those indexes will be dropped first.
         */
        deleteColumns: async (
          table: string,
          columns: string[],
          dropDependentIndexes?: string[],
          expectedCurrentState?: ColumnDropTableState
        ): Promise<ColumnDropTableState> => {
          if (columns.length === 0) return readNativeColumnDropTableState(table);

          // A SAVEPOINT composes with replay's outer transaction. The post-drop
          // snapshot is read before RELEASE so capture failure rolls the DDL back.
          const savepointName = createSavepointName('sp_delete_columns');
          await worker.call('run', [`SAVEPOINT ${savepointName}`]);
          try {
            if (expectedCurrentState) {
              const current = await readNativeColumnDropTableState(table);
              assertTableSchemaStateCurrent(
                table,
                expectedCurrentState,
                current,
                'apply column deletion history',
                'since this history entry was recorded'
              );
            }
            await executeSchemaPreservingColumnDrop(
              table,
              columns,
              dropDependentIndexes,
              async sql => {
                await worker.call('run', [sql]);
              }
            );
            const stateAfter = await readNativeColumnDropTableState(table);
            await worker.call('run', [`RELEASE ${savepointName}`]);
            return stateAfter;
          } catch (error) {
            await safeRollbackSavepoint(savepointName, 'deleteColumns');
            throw error;
          }
        },

        /**
         * Create a new table.
         */
        createTable: async (
          table: string,
          columns: ColumnDefinition[]
        ): Promise<ColumnDropTableState> => {
          const sql = buildCreateTableSql(table, columns);
          const savepointName = createSavepointName('sp_create_table');
          await worker.call('run', [`SAVEPOINT ${savepointName}`]);
          try {
            const dependenciesBefore = await captureNativeViewDependencySnapshot();
            await worker.call('run', [sql]);
            assertNoNewBrokenSchemaDependencies(
              dependenciesBefore,
              await captureNativeViewDependencySnapshot()
            );
            const stateAfter = await readNativeColumnDropTableState(table);
            await worker.call('run', [`RELEASE ${savepointName}`]);
            return stateAfter;
          } catch (error) {
            await safeRollbackSavepoint(savepointName, 'createTable');
            throw error;
          }
        },

        getViewDefinition: getNativeViewDefinition,

        validateViewDefinition: async (
          view: string,
          selectSql: string,
          intent: ViewDefinitionIntent = 'edit'
        ) => {
          assertUsableSqlIdentifier(view, 'View name');
          if (forceReadOnly) {
            throw new Error('View validation is unavailable because the database is read-only');
          }
          const body = normalizeViewSelectSql(selectSql);
          const { storedSql: existingSql, columnListSql } =
            await resolveExistingViewForIntent(view, intent);
          const savepointName = createSavepointName('sp_validate_view');
          await worker.call('run', [`SAVEPOINT ${savepointName}`]);
          try {
            const dependenciesBefore = await captureNativeViewDependencySnapshot();
            if (typeof existingSql === 'string') {
              await worker.call('run', [`DROP VIEW ${escapeMainViewIdentifier(view)}`]);
            }
            await runNativeSingleStatement(buildCreateViewSql(view, body, columnListSql));
            await compileNativeView(view);
            assertNoNewBrokenSchemaDependencies(
              dependenciesBefore,
              await captureNativeViewDependencySnapshot()
            );
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
          intent: ViewDefinitionIntent = 'edit',
          signal?: AbortSignal
        ) => {
          assertUsableSqlIdentifier(view, 'View name');
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
          let result: NativeQueryResult;
          try {
            const dependenciesBefore = await captureNativeViewDependencySnapshot();
            if (typeof existingSql === 'string') {
              await worker.call('run', [`DROP VIEW ${escapeMainViewIdentifier(view)}`]);
            }
            await runNativeSingleStatement(
              buildCreateViewSql(view, body, columnListSql)
            );
            await compileNativeView(view);
            assertNoNewBrokenSchemaDependencies(
              dependenciesBefore,
              await captureNativeViewDependencySnapshot()
            );
            columns = await getNativeColumnNames(view, true);
            // Query the installed disposable main view while its savepoint is
            // still active. Executing the raw body here would resolve ordinary
            // source names through TEMP first and could preview semantics that
            // the validated persistent view will never have.
            result = await queryNativeBoundedStatement(
              `SELECT * FROM ${escapeMainViewIdentifier(view)}`,
              columns,
              boundedLimit,
              signal
            );
            await worker.call('run', [`ROLLBACK TO ${savepointName}`]);
            await worker.call('run', [`RELEASE ${savepointName}`]);
          } catch (err) {
            await safeRollbackSavepoint(savepointName, 'previewViewDefinition');
            throw normalizeViewDefinitionError(err, view, body);
          }

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
          assertUsableSqlIdentifier(view, 'View name');
          if (forceReadOnly) {
            throw new Error('View creation is unavailable because the database is read-only');
          }
          const body = normalizeViewSelectSql(selectSql);
          const savepointName = createSavepointName('sp_create_view');
          await worker.call('run', [`SAVEPOINT ${savepointName}`]);
          try {
            const dependenciesBefore = await captureNativeViewDependencySnapshot();
            await runNativeSingleStatement(buildCreateViewSql(view, body));
            await compileNativeView(view);
            assertNoNewBrokenSchemaDependencies(
              dependenciesBefore,
              await captureNativeViewDependencySnapshot()
            );
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
            const dependenciesBefore = await captureNativeViewDependencySnapshot();
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
            assertNoNewBrokenSchemaDependencies(
              dependenciesBefore,
              await captureNativeViewDependencySnapshot()
            );
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
            const dependenciesBefore = await captureNativeViewDependencySnapshot();
            await worker.call('run', [`DROP VIEW ${escapeMainViewIdentifier(view)}`]);
            assertNoNewBrokenSchemaDependencies(
              dependenciesBefore,
              await captureNativeViewDependencySnapshot()
            );
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
          options = normalizeTablePageOptions(options);
          let columns = options.columns;
          if (!columns || (columns.length === 1 && columns[0] === '*')) {
            columns = await getNativeColumnNames(table);
          }
          let identity: TableIdentity | undefined;
          let primaryKeyContext: {
            identity: Extract<TableIdentity, { kind: 'primaryKey' }>;
            visibleColumns: string[];
          } | undefined;
          let effectiveOrderBy = options.orderBy;
          let identityOrderBy: string[] | undefined;
          if (columns[0]?.toLowerCase() === 'rowid') {
            const syntheticRowIdOrder = ordersBySyntheticRowId({ ...options, columns });
            identity = await findNativeTableIdentity(table);
            if (identity?.kind === 'primaryKey') {
              const visibleColumns = columns.slice(1);
              const hiddenPrimaryKeyColumns = identity.columns
                .map(column => column.identifier)
                .filter(column => !visibleColumns.includes(column));
              columns = [...visibleColumns, ...hiddenPrimaryKeyColumns];
              primaryKeyContext = { identity, visibleColumns };
              if (syntheticRowIdOrder) {
                effectiveOrderBy = undefined;
                identityOrderBy = identity.columns.map(column => column.identifier);
              }
            }
          }
          const hasRowIdShape = columns[0]?.toLowerCase() === 'rowid';
          const snapshotName = hasRowIdShape || columns.length >= SQLITE_MAX_RESULT_COLUMNS
            ? createSavepointName('sp_numeric_snapshot')
            : undefined;
          if (snapshotName) {
            // Unlike the private WASM databases, the native file can receive a
            // WAL commit from another process between RPCs. The first read
            // inside this savepoint fixes one SQLite snapshot for the rowid
            // authority, the page values, and any companion text alike.
            await worker.call('run', [`SAVEPOINT ${snapshotName}`]);
          }

          try {
            let isRowIdTable = false;
            if (hasRowIdShape) {
              // This authority read fixes the WAL snapshot before the main data
              // read, so both exact identities and any companion text describe
              // one committed database state. It is also the single authority
              // for rowid keyset eligibility: the seek plan (or the fallback
              // ORDER BY), the page execution, and the anchor minting below all
              // derive from this one in-savepoint answer, so an external WAL
              // commit between reads can never desynchronize them.
              const authority = await worker.call<NativeQueryResult>('query', [
                ROWID_TABLE_AUTHORITY_SQL,
                [table, table]
              ]);
              isRowIdTable = authority.values.length > 0;
            }

            // Keyset eligibility: a declared WITHOUT ROWID key (needs no
            // authority — that path never opens this savepoint), or an
            // authority-confirmed unshadowed rowid. Key/tag derive from the
            // untransformed options so minting and validation agree.
            const keysetIdentity = identity?.kind === 'primaryKey'
              ? identity
              : (identity?.kind === 'rowid' && isRowIdTable ? identity : undefined);
            const keysetKey = computeKeysetKey(options, keysetIdentity);
            const keysetTag = keysetKey ? computeKeysetQueryTag(table, options) : undefined;
            const keysetPlan = keysetKey
              ? resolveKeysetPlan(table, options, keysetIdentity)
              : undefined;
            const queryOptions = {
              ...options,
              columns,
              orderBy: effectiveOrderBy,
              orderByColumns: identityOrderBy
            };
            const fallbackOrder = keysetFallbackOrder(keysetKey, keysetPlan);
            if (fallbackOrder) {
              // One total order for both paths: this OFFSET/fallback page
              // re-anchors the grid, so its row order must match what those
              // anchors will seek. keysetKey is gated on the in-savepoint
              // authority above, so a shadowed rowid table keeps the
              // pre-keyset SQL unchanged.
              queryOptions.orderBy = undefined;
              queryOptions.orderByColumns = fallbackOrder.orderByColumns;
              queryOptions.orderDir = fallbackOrder.orderDir;
            }
            const splitSyntheticRowId = identity?.kind === 'rowid'
              && hasRowIdShape
              && columns.length > SQLITE_MAX_RESULT_COLUMNS;
            const valueColumns = splitSyntheticRowId ? columns.slice(1) : columns;
            const valueQueryOptions = splitSyntheticRowId
              ? { ...queryOptions, columns: valueColumns }
              : queryOptions;
            const { sql, params } = buildSelectQuery(table, valueQueryOptions, keysetPlan);
            const rowIdQuery = splitSyntheticRowId
              ? buildSelectQuery(
                  table,
                  { ...queryOptions, columns: ['rowid'] },
                  keysetPlan
                )
              : undefined;
            const primaryKeyColumnIndices = primaryKeyContext
              ? primaryKeyContext.identity.columns.map(column => {
                  const index = columns.indexOf(column.identifier);
                  if (index < 0) {
                    throw new Error(`Primary-key column missing from table fetch: ${column.identifier}`);
                  }
                  return index;
                })
              : [];
            const keysetColumnIndices = keysetKey
              ? keysetKey.keyColumns
                  .map(column => columns.indexOf(column))
                  .filter(index => index >= 0)
              : [];
            const identityRawTextColumnIndices = [
              ...new Set([...primaryKeyColumnIndices, ...keysetColumnIndices])
            ];
            const identityContainmentRawTextColumnIndices = splitSyntheticRowId
              ? identityRawTextColumnIndices
                  .filter(index => index > 0)
                  .map(index => index - 1)
              : identityRawTextColumnIndices;
            const containmentRawTextColumnIndices =
              valueColumns.length * 2 + 1 <= SQLITE_MAX_RESULT_COLUMNS
                ? valueColumns.map((_, index) => index)
                : identityContainmentRawTextColumnIndices;
            const containmentQuery = buildCellContainmentQuery(
              sql,
              valueColumns.length,
              queryOptions,
              containmentRawTextColumnIndices
            );
            const transportQuery = buildExactNumericTextQuery(
              containmentQuery.sql,
              containmentQuery.primaryTransportColumnCount
            );
            const needsRowIdCompanions = transportQuery.valueColumnCount === undefined
              && hasRowIdShape;
            const primaryResult = await worker.call<NativeQueryResult>('queryNumeric', [
              transportQuery.sql,
              params,
              transportQuery.transportColumns,
              transportQuery.valueColumnCount
            ]);
            const valueSourceRows = mergeCellContainmentMetadataRows(
              primaryResult.values,
              undefined,
              containmentQuery
            ) as CellValue[][];
            const rowIdResult = rowIdQuery
              ? await worker.call<NativeQueryResult>('query', [
                  rowIdQuery.sql,
                  rowIdQuery.params
                ])
              : undefined;
            if (rowIdResult && rowIdResult.values.length !== valueSourceRows.length) {
              throw new Error('Synthetic rowid companion row count does not match the value page');
            }
            const sourceRows = rowIdResult
              ? rowIdResult.values.map((row, rowIndex) => {
                  if (row.length !== 1) {
                    throw new Error(`Synthetic rowid companion row ${rowIndex} is not one value`);
                  }
                  return [row[0], ...valueSourceRows[rowIndex]];
                })
              : valueSourceRows;

            const companionResults = [];
            if (isRowIdTable && needsRowIdCompanions && sourceRows.length > 0) {
              const companionQueries = buildRowIdExactRealTextQueries(
                table,
                columns,
                sourceRows.map(row => row[0] as CellValue)
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
              sourceRows,
              companionResults
            );
            const needsExactRowIdIdentity = isRowIdTable
              && hasUnsafeBigIntAtColumn(sourceRows, 0);

            // txiki preserves SQLite int64 values as BigInt. The generated
            // companion columns also retain authoritative REAL text before V8
            // normalizes the storage class into a JavaScript Number.
            const normalized = normalizeIntegerRowsForTransport(
              valueSourceRows,
              undefined,
              splitSyntheticRowId
                ? primaryResult.exactIntegerTexts
                : mergeExactIntegerTextMaps(
                    companionExactTexts,
                    primaryResult.exactIntegerTexts
                  ),
              !splitSyntheticRowId && needsExactRowIdIdentity ? 0 : undefined
            );
            const valueContained = decodeCellContainment(
              normalized.rows,
              valueColumns.length,
              normalized.exactIntegerTexts,
              queryOptions.maxPageResponseBytes
            );
            const decodedContained = rowIdResult
              ? prependCellContainmentColumn(
                  normalizeIntegerRowsForTransport(
                    rowIdResult.values,
                    undefined,
                    undefined,
                    needsExactRowIdIdentity ? 0 : undefined
                  ).rows.map(row => row[0]),
                  valueContained,
                  companionExactTexts
                )
              : valueContained;
            const rawTextRows = decodeRawTextColumns(normalized.rows, containmentQuery);
            const textEncoding = containmentRawTextColumnIndices.length > 0
              ? normalizeCellTextEncoding((await worker.call<NativeQueryResult>('query', [
                  'PRAGMA encoding',
                  []
                ])).values[0]?.[0])
              : undefined;
            const sourceRawTextColumnIndices = splitSyntheticRowId
              ? containmentQuery.rawTextColumnIndices.map(index => index + 1)
              : containmentQuery.rawTextColumnIndices;
            const contained = textEncoding
              ? containUnrepresentableTextCells({
                  sourceRows,
                  rawTextRows,
                  rawTextColumnIndices: sourceRawTextColumnIndices,
                  textEncoding,
                  contained: decodedContained
                })
              : decodedContained;
            const { rows, oversizedCells, exactIntegerTexts } = contained;
            const shadowedRowId = identity?.kind === 'rowid'
              && hasRowIdShape
              && !isRowIdTable
              ? remapShadowedRowIdContainment({
                  rows,
                  oversizedCells,
                  exactIntegerTexts,
                  rowOffset: queryOptions.offset
                })
              : undefined;
            const remapped = primaryKeyContext && textEncoding
              ? remapPrimaryKeyContainment({
                  identity: primaryKeyContext.identity,
                  sourceColumns: columns,
                  visibleColumnCount: primaryKeyContext.visibleColumns.length,
                  identityRows: sourceRows,
                  rawTextBytes: rawTextRows,
                  rawTextColumnIndices: sourceRawTextColumnIndices,
                  rawTextValidationUnavailable: containmentQuery.rawTextValidationUnavailable,
                  textEncoding,
                  rows,
                  oversizedCells,
                  exactIntegerTexts,
                  effectiveInlineCellBytes: containmentQuery.effectiveInlineCellBytes,
                  rowOffset: queryOptions.offset
                })
              : undefined;
            const unrepresentableKeysetTextRows = keysetKey && textEncoding
              ? findUnrepresentableTextRows({
                  sourceRows,
                  sourceColumnIndices: keysetColumnIndices,
                  rawTextRows,
                  rawTextColumnIndices: sourceRawTextColumnIndices,
                  textEncoding,
                  rawTextValidationUnavailable: containmentQuery.rawTextValidationUnavailable
                })
              : undefined;

            // Anchors come from the exact source rows (BigInt-preserving,
            // display order); keysetKey exists only when the in-savepoint
            // shadowing authority (or the declared PK) authorized seeking.
            const keysetAnchors = keysetKey && keysetTag !== undefined
              ? mintKeysetAnchors({
                  tag: keysetTag,
                  key: keysetKey,
                  projectionColumns: columns,
                  rows: sourceRows,
                  oversizedCells,
                  excludedRowIndices: unrepresentableKeysetTextRows
                })
              : undefined;

            if (primaryKeyContext && remapped) {
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
                  : {}),
                ...(keysetAnchors ? { keysetAnchors } : {})
              };
            }

            if (snapshotName) {
              await worker.call('run', [`RELEASE ${snapshotName}`]);
            }
            return {
              headers: columns,
              rows: shadowedRowId?.rows ?? rows,
              columns,
              values: shadowedRowId?.rows ?? rows,
              exactIntegerTexts: shadowedRowId
                ? shadowedRowId.exactIntegerTexts
                : exactIntegerTexts,
              ...((shadowedRowId ? shadowedRowId.oversizedCells : oversizedCells)
                ? { oversizedCells: shadowedRowId ? shadowedRowId.oversizedCells : oversizedCells }
                : {}),
              ...(shadowedRowId?.readOnlyRowReasons
                ? { readOnlyRowReasons: shadowedRowId.readOnlyRowReasons }
                : {}),
              ...(keysetAnchors ? { keysetAnchors } : {})
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
            return { count: typeof val === 'number' ? val : 0, isExact: true };
          }
          return { count: 0, isExact: true };
        },

        /**
         * Fetch database schema.
         */
        fetchSchema: async () => {
          // Keep schema and identity discovery in one IPC round-trip.
          const queries = [
            { sql: "SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name" },
            { sql: "SELECT name FROM main.sqlite_schema WHERE type='view' ORDER BY name" },
            { sql: "SELECT name, tbl_name FROM main.sqlite_schema WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name" },
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
        writeToFile: async (
          targetPath: string,
          signal?: AbortSignal
        ): Promise<DatabaseWriteResult> => {
          signal?.throwIfAborted();
          let canonicalSource: string;
          let canonicalTarget: string;
          try {
            [canonicalSource, canonicalTarget] = await Promise.all([
              fs.promises.realpath(filePath),
              fs.promises.realpath(targetPath)
            ]);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            canonicalSource = '';
            canonicalTarget = '';
          }

          const replacingActiveSource = canonicalSource !== ''
            && canonicalSource === canonicalTarget;
          if (replacingActiveSource) {
            let walHasFrames = false;
            try {
              walHasFrames = (
                await fs.promises.stat(`${canonicalSource}-wal`, { bigint: true })
              ).size > 32n;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            if (walHasFrames) {
              // Only this connection can checkpoint its active source safely.
              // After snapshotting, this connection is closed so the atomic
              // writer can prove exclusive ownership and close the race between
              // this checkpoint and the final rename.
              const checkpoint = await worker.call<NativeQueryResult>(
                'query',
                ['PRAGMA wal_checkpoint(TRUNCATE)'],
                queryTimeout + BOUNDED_QUERY_TRANSPORT_MARGIN_MS,
                signal
              );
              const status = checkpoint.values?.[0];
              if (
                !Array.isArray(status)
                || status.length < 3
                || Number(status[0]) !== 0
                || Number(status[1]) !== Number(status[2])
              ) {
                throw new Error(
                  'Cannot checkpoint the active database WAL before atomic save; '
                  + 'close other readers or writers and retry.'
                );
              }
            }
          }

          let sourceConnectionClosed = false;
          let result: DatabaseWriteResult | undefined;
          let writeError: unknown;
          let writeCompleted = false;
          try {
            result = await writeDatabaseSnapshotAtomically(
              fs,
              filePath,
              targetPath,
              async temporaryPath => {
                // VACUUM INTO itself refuses an existing path. The atomic helper
                // keeps that private snapshot off the destination until fsync and
                // target-generation validation have both succeeded.
                await worker.call(
                  'vacuumInto',
                  [temporaryPath, queryTimeout],
                  queryTimeout + BOUNDED_QUERY_TRANSPORT_MARGIN_MS,
                  signal
                );
                if (replacingActiveSource) {
                  // A WAL connection keeps a shared main-file lock even with no
                  // frames. Close both native handles before the helper obtains
                  // its exclusive lock; serialized operations prevent this
                  // connection from touching the retired inode before reopen.
                  sourceConnectionClosed = true;
                  await worker.call('close');
                }
              },
              signal,
              (_level, message, error) => {
                const details = error === undefined
                  ? ''
                  : ` ${error instanceof Error ? error.message : String(error)}`;
                outputChannel?.appendLine(`[NativeWorker] ${message}${details}`);
              }
            );
            writeCompleted = true;
          } catch (error) {
            writeError = error;
          }

          if (sourceConnectionClosed) {
            try {
              await worker.call('open', [filePath, readOnly]);
            } catch (reopenError) {
              if (!writeCompleted) {
                throw new AggregateError(
                  [writeError, reopenError],
                  'Native database save failed and reopening the source also failed'
                );
              }
              const details = reopenError instanceof Error
                ? reopenError.message
                : String(reopenError);
              outputChannel?.appendLine(
                `[NativeWorker] Database saved, but the native source connection `
                + `could not be reopened: ${details}`
              );
            }
          }
          if (!writeCompleted) throw writeError;
          return result!;
        },

        /**
         * Update multiple cells in a batch.
         */
        updateCellBatch: async (
          table: string,
          updates: CellUpdate[],
          maxEditValueBytes?: number,
          maxUndoSnapshotBytes?: number,
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
            assertUniqueCellUpdateTargets(updates, identity);
            if (!isHistoryReplay && maxUndoSnapshotBytes !== undefined) {
              await assertNativeBatchHistoryWithinBudget(
                table,
                updates,
                identity,
                maxUndoSnapshotBytes
              );
            }
            return updateNativePrimaryKeyCellBatch(
              table,
              identity,
              updates,
              maxEditValueBytes,
              maxUndoSnapshotBytes,
              historyReplayToken
            );
          }

          await assertNativeRowIdAuthority(table);
          const rowIdIdentity = { kind: 'rowid' } as const;
          assertUniqueCellUpdateTargets(updates, rowIdIdentity);
          if (!isHistoryReplay && maxUndoSnapshotBytes !== undefined) {
            await assertNativeBatchHistoryWithinBudget(
              table,
              updates,
              rowIdIdentity,
              maxUndoSnapshotBytes
            );
          }

          const batchItems: { sql: string; paramsList?: CellValue[][], params?: CellValue[] }[] = [];
          const escapedTable = escapeMainIdentifier(table);
          const savepointName = createSavepointName('sp_update_batch');
          await worker.call('run', [`SAVEPOINT ${savepointName}`]);

          try {
          if (!isHistoryReplay && maxUndoSnapshotBytes !== undefined) {
            await assertNativeBatchHistoryWithinBudget(
              table,
              updates,
              rowIdIdentity,
              maxUndoSnapshotBytes
            );
          }
          if (!isHistoryReplay && maxEditValueBytes !== undefined) {
            await assertNativeRowIdBatchPriorsWithinEditLimit(
              table,
              updates,
              editLimitBytes
            );
          }
          const rowIdAliasColumn = await readNativeRowIdAliasColumn(table);
          await assertNativeUpdateHasNoTargetTableTriggerWrites(
            table,
            updates.map(update => update.column)
          );
          if (
            rowIdAliasColumn !== undefined
            && updates.some(update => sqliteIdentifiersEqual(update.column, rowIdAliasColumn))
          ) {
            const results = await updateNativeRowIdAliasCellBatchWithinSavepoint(
              table,
              rowIdAliasColumn,
              updates,
              editLimitBytes,
              isHistoryReplay
            );
            await worker.call('run', [`RELEASE ${savepointName}`]);
            return results;
          }
          const rowIds = [...new Set(updates.map(update => validateRowId(update.rowId)))];
          const columns = [...new Set(updates.map(update => update.column))];
          const textEncoding = await readNativeCellTextEncoding();
          const rowIdPredicates = buildRecordIdentityPredicateChunks(rowIds, rowIdIdentity);
          const currentValues = new Map<string, Map<string, StoredCellState>>();
          for (const predicate of rowIdPredicates) {
            const current = await worker.call<NativeQueryResult>('query', [
              `SELECT CAST(rowid AS TEXT), ${columns.map(buildStoredCellStateProjection).join(', ')} ` +
              `FROM ${escapedTable} WHERE ${predicate.sql}`,
              predicate.params
            ]);
            for (const row of current.values ?? []) {
              const values = new Map<string, StoredCellState>();
              columns.forEach((column, index) => values.set(column, parseStoredCellState(
                row[index * 2 + 1],
                row[index * 2 + 2],
                `${table}.${column}`,
                { textEncoding }
              )));
              currentValues.set(String(validateRowId(row[0] as RecordId)), values);
            }
          }
          const results: Array<Omit<CellUpdateResult, 'postState'>> = [];
          const processedUpdates = await Promise.all(updates.map(async update => {
            const rowId = validateRowId(update.rowId);
            const row = currentValues.get(String(rowId));
            if (!row) {
              throw new Error(`Cannot update ${table}.${update.column}: row ${update.rowId} no longer exists`);
            }
            const priorState = row.get(update.column);
            if (!priorState) {
              throw new Error(`Cannot update ${table}.${update.column}: cell state is unavailable`);
            }
            const priorValue = priorState.value;
            const prepared = prepareCellUpdateForStorage(
              update.value,
              priorValue,
              update.operation ?? 'set'
            );
            if (!isHistoryReplay && prepared.operation === 'json_patch') {
              const storedValue = await applyNativeJsonPatchValue(priorValue, prepared.value);
              assertCellValueWithinEditLimit(storedValue, editLimitBytes);
            }
            results.push({
              rowId,
              columnName: update.column,
              priorValue,
              newValue: prepared.value,
              priorState,
              operation: prepared.operation
            });
            return { ...update, rowId, value: prepared.value, operation: prepared.operation };
          }));

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
          const remainingRowIds = new Set<string>();
          for (const predicate of rowIdPredicates) {
            const remaining = await worker.call<NativeQueryResult>('query', [
              `SELECT CAST(rowid AS TEXT) FROM ${escapedTable} WHERE ${predicate.sql}`,
              predicate.params
            ]);
            for (const row of remaining.values ?? []) {
              remainingRowIds.add(String(validateRowId(row[0] as RecordId)));
            }
          }
          if (rowIds.some(rowId => !remainingRowIds.has(String(rowId)))) {
            throw unresolvableTriggeredRowIdUpdateError(table);
          }

          const postValues = new Map<string, Map<string, StoredCellState>>();
          for (const predicate of rowIdPredicates) {
            const post = await worker.call<NativeQueryResult>('query', [
              `SELECT CAST(rowid AS TEXT), ${columns.map(buildStoredCellStateProjection).join(', ')} ` +
              `FROM ${escapedTable} WHERE ${predicate.sql}`,
              predicate.params
            ]);
            for (const row of post.values ?? []) {
              const values = new Map<string, StoredCellState>();
              columns.forEach((column, index) => values.set(column, parseStoredCellState(
                row[index * 2 + 1],
                row[index * 2 + 2],
                `${table}.${column}`,
                { textEncoding }
              )));
              postValues.set(String(validateRowId(row[0] as RecordId)), values);
            }
          }
          const completedResults: CellUpdateResult[] = results.map(result => {
            const postState = postValues.get(String(result.rowId))?.get(result.columnName);
            if (!postState) {
              throw unresolvableTriggeredRowIdUpdateError(table);
            }
            return { ...result, postState };
          });
          await worker.call('run', [`RELEASE ${savepointName}`]);
          return completedResults;
          } catch (err) {
            await safeRollbackSavepoint(savepointName, 'updateCellBatch');
            throw err;
          }
        },

        /**
         * Add a new column to a table.
         */
        addColumn: async (
          table: string,
          column: string,
          type: string,
          defaultValue?: string,
          expectedCurrentState?: ColumnDropTableState
        ): Promise<ColumnDropTableState> => {
          assertUsableSqlIdentifier(column, 'Column name');
          validateSqlType(type);
          const sql = `ALTER TABLE ${escapeMainIdentifier(table)} ADD COLUMN `
            + `${escapeIdentifier(column)} ${type}${buildColumnDefaultClause(defaultValue)}`;

          const savepointName = createSavepointName('sp_add_column');
          await worker.call('run', [`SAVEPOINT ${savepointName}`]);
          try {
            const current = await readNativeColumnDropTableState(table);
            if (expectedCurrentState) {
              assertTableSchemaStateCurrent(
                table,
                expectedCurrentState,
                current,
                'redo column addition',
                'after the column addition was undone'
              );
            }
            assertColumnNameAvailable(table, column, current.columns);
            const dependenciesBefore = await captureNativeViewDependencySnapshot();
            await worker.call('run', [sql]);
            const stateAfter = await readNativeColumnDropTableState(table);
            assertNoNewBrokenSchemaDependencies(
              dependenciesBefore,
              await captureNativeViewDependencySnapshot()
            );
            await worker.call('run', [`RELEASE ${savepointName}`]);
            return stateAfter;
          } catch (error) {
            await safeRollbackSavepoint(savepointName, 'addColumn');
            throw error;
          }
        }
      };

      const operationsFacade = serializeOperations(rawOperations);

      return {
        databaseOps: operationsFacade,
        isReadOnly: readOnly
      };
    }
  };
}
