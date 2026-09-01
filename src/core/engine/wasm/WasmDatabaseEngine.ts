/**
 * WebAssembly-based SQLite database engine (sql.js).
 *
 * Extracted from src/core/sqlite-db.ts as a standalone module so the
 * factory and worker entry point in sqlite-db can stay slim and so a
 * future native engine can sit alongside under src/core/engine/.
 *
 * Imports getNodeFs from src/core/platform/fs to avoid a circular
 * dependency back into sqlite-db.
 */

import type {
  CellValue,
  RecordId,
  QueryResultSet,
  ModificationEntry,
  DatabaseOperations,
  CellUpdate,
  CellUpdateResult,
  TableQueryOptions,
  TableCountOptions,
  TableCountResult,
  SchemaSnapshot,
  ColumnMetadata,
  ColumnDefinition,
  ViewDefinition,
  ViewDefinitionIntent,
  ViewEditResult,
  ViewTriggerDefinition,
  TableIdentity,
  DeletedRow,
  CellMetadata,
  CellReadChunk,
  CellReadSession,
  CellReadTarget,
  QueryReadChunk,
  QueryReadSession,
  CellTextEncoding,
  OversizedCellMetadata,
  DatabaseWriteResult,
  ColumnDropTableState,
  StoredCellState
} from '../../types';
import {
  assertUsableSqlIdentifier,
  escapeIdentifier,
  escapeMainIdentifier,
  validateSqlType,
  validateRowId
} from '../../sql-utils';
import {
  assertColumnNameAvailable,
  buildCreateTableSql,
  buildColumnDefaultClause,
  buildIndexDependencyProbeIndexSql,
  buildIndexDependencyProbeTableSql,
  resolveIndexDependencyColumns
} from '../../schema-ddl';
import { crypto } from '../../../platform/cryptoShim';
import { buildSelectQuery, buildCountQuery } from '../../query-builder';
import { normalizeTablePageOptions } from '../../table-pagination';
import {
  computeKeysetKey,
  computeKeysetQueryTag,
  keysetFallbackOrder,
  mintKeysetAnchors,
  ordersBySyntheticRowId,
  resolveKeysetPlan
} from '../../keyset-pagination';
import {
  applyMergePatch,
  parseJsonValueForPatching,
  planJsonPatchHistoryReplay,
  prepareCellUpdateForStorage
} from '../../json-utils';
import {
  assertStoredCellState,
  buildStoredCellPredicate,
  buildStoredCellStateProjection,
  buildStoredCellWrite,
  CellHistoryConflictError,
  LegacyCellHistoryError,
  parseStoredCellState,
  storedCellStatesEqual
} from '../../cell-history';
import {
  buildRowHistoryPredicate,
  buildRowHistoryWrites,
  LegacyRowHistoryError,
  RowHistoryConflictError,
  rowHistoryStates
} from '../../row-history';
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
} from '../../integer-utils';
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
} from '../../cell-containment';
import { getNodeFs } from '../../platform/fs';
import { writeDatabaseSnapshotAtomically } from '../../../atomicDatabaseWrite';
import {
  buildCappedCountProbeSql,
  buildCountUpperBoundSql,
  PAGED_COUNT_PROBE_MAX_ROWS,
  resolveCappedCount,
  resolveCountUpperBound,
  resolveFileSizeRowUpperBound,
  WITHOUT_ROWID_TABLE_SQL,
  shouldAnswerCountWithUpperBound
} from '../../paged-count';
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
} from '../../row-identity';
import {
  assertDeleteSnapshotFitsUndoBudget,
  buildDeleteSnapshotSizeQuery,
  deleteSnapshotValueColumns,
  parseDeleteSnapshotSizeRow
} from '../../delete-history';
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
} from '../../view-utils';
import {
  assertNoNewBrokenSchemaDependencies,
  captureSchemaDependencySnapshot,
  type SchemaDependencySnapshot
} from '../../schema-dependency';
import {
  buildCellChunkQuery,
  buildCellMetadataQuery,
  decodeCellMetadata,
  DEFAULT_CELL_READ_SESSION_ABSOLUTE_TIMEOUT_MS,
  DEFAULT_CELL_READ_SESSION_IDLE_TIMEOUT_MS,
  normalizeCellReadTimeout,
  normalizeCellTextEncoding,
  validateCellReadTarget,
  validateCellReadWindow,
  type CellReadSqlTarget
} from '../../cell-read';
import {
  assertCellValueWithinEditLimit,
  assertCellValuesWithinEditLimit,
  assertOversizedCellReplacementExpectation,
  OVERSIZED_CELL_REPLACEMENT_CONFLICT_MESSAGE,
  OversizedCellReplacementRequiredError
} from '../../cell-edit-policy';
import {
  assertBatchHistoryFitsUndoBudget,
  assertBatchPriorLimitResult,
  buildBatchHistorySizePreflight,
  buildBatchPriorLimitQueries
} from '../../batch-update';
import {
  assertNoNewColumnDropForeignKeyViolations,
  assertColumnDropTableStateCurrent,
  assertTableSchemaStateCurrent,
  buildColumnDropRestorePlan,
  captureColumnDropForeignKeyBaseline,
  columnDropForeignKeyViolationBytes,
  COLUMN_DROP_FOREIGN_KEY_VIOLATION_BYTES_LIMIT,
  COLUMN_DROP_FOREIGN_KEY_VIOLATION_LIMIT,
  COLUMN_DROP_TABLE_STATE_SQL,
  executeSchemaPreservingColumnDrop,
  mapColumnDropTableState,
  normalizeColumnDropForeignKeyViolation
} from '../../column-drop';
import {
  normalizePagedWritableOverlay,
  shouldWarnForPagedAtomicRewrite,
  shouldWarnForPagedOverlayCopy,
  type PagedFileIdentity,
  type PagedWritableOverlaySnapshot,
  type RawPagedWritableOverlay
} from '../../paged-writable-overlay';

// ============================================================================
// Internal sql.js Types
// ============================================================================

type WasmBindValue = Exclude<CellValue, bigint>;

// Public mutation entry points enforce Stage D. History replay supplies this
// unforgeable in-process token so restoring an already-existing legacy value
// is not misclassified as creating a new oversized value.
const HISTORY_REPLAY_EDIT_TOKEN = Symbol('history-replay-edit');

interface WasmPreparedStatement {
  run(params?: WasmBindValue[]): void;
  bind(params?: WasmBindValue[]): boolean;
  get(params?: WasmBindValue[]): CellValue[] | undefined;
  get(
    params: WasmBindValue[] | null | undefined,
    config: { useBigInt: true }
  ): Array<CellValue | bigint> | undefined;
  step(): boolean;
  reset(): void;
  free(): boolean;
  getColumnNames(): string[];
  getSQL(): string;
}

export interface WasmDatabaseInstance {
  exec(sql: string, params?: WasmBindValue[]): Array<{ columns: string[]; values: CellValue[][] }>;
  prepare(sql: string, params?: WasmBindValue[]): WasmPreparedStatement;
  iterateStatements(sql: string): Iterable<WasmPreparedStatement>;
  progress_handler(nOps?: number | null, callback?: (() => unknown) | null): void;
  interrupt(): void;
  export(): Uint8Array;
  exportPagedWritableOverlay?: () => RawPagedWritableOverlay;
  close(): void;
}

/**
 * Host I/O contract for both paged open variants: absolute-offset synchronous
 * reads over an immutable base whose size is pinned at open. Writable paging
 * layers its copy-on-write overlay above this unchanged reader.
 */
export interface WasmPagedHostIo {
  size(): number;
  read(offset: number, length: number): Uint8Array;
}

export interface WasmEngineModule {
  Database: (new (data?: ArrayLike<number>) => WasmDatabaseInstance) & {
    /**
     * Page-on-demand read-only open, present only in the patched sql.js
     * fork (stage 0 of the paged-VFS program). Optional so a stale
     * vendored build degrades to the buffer paths instead of crashing.
     */
    openPaged?: (hostIo: WasmPagedHostIo) => WasmDatabaseInstance;
    /** Copy-on-write paged open, present in stage 3 fork builds. */
    openPagedWritable?: (hostIo: WasmPagedHostIo) => WasmDatabaseInstance;
  };
}

export type WasmEngineLogHandler = (
  level: 'log' | 'warn' | 'error',
  ...args: unknown[]
) => void;

export type WasmOperationCancellation = AbortSignal | Int32Array;
export type WasmQueryCancellation = WasmOperationCancellation;

function cancellationCheck(
  cancellation?: WasmOperationCancellation
): Pick<AbortSignal, 'throwIfAborted'> | undefined {
  if (!cancellation || 'aborted' in cancellation) return cancellation;
  return {
    throwIfAborted() {
      if (cancellation.length > 0 && Atomics.load(cancellation, 0) !== 0) {
        const error = new Error('Database operation cancelled');
        error.name = 'AbortError';
        throw error;
      }
    }
  };
}

interface ExistingViewForIntent {
  storedSql: CellValue | undefined;
  columnListSql: string | undefined;
}

interface GuardedCellHistoryEntry {
  rowId: RecordId;
  newRowId?: RecordId;
  columnName: string;
  newValue?: CellValue;
  operation?: ModificationEntry['operation'];
  priorState: StoredCellState;
  postState: StoredCellState;
}

/**
 * sql.js does not expose a native int64 bind; its current BigInt branch binds
 * decimal text internally. Perform that conversion at our boundary so history
 * replay remains exact without depending on an undocumented binder detail.
 */
function normalizeWasmBindParams(
  params?: readonly CellValue[]
): WasmBindValue[] | undefined {
  return params?.map(value => {
    if (typeof value !== 'bigint') return value;
    const numericValue = Number(value);
    return Number.isSafeInteger(numericValue) ? numericValue : value.toString();
  });
}

/** sql.js binds unsafe bigint as TEXT; cast only those captured INTEGER values. */
function wasmBindPlaceholder(value: CellValue): string {
  return typeof value === 'bigint' && !Number.isSafeInteger(Number(value))
    ? 'CAST(? AS INTEGER)'
    : '?';
}

// ============================================================================
// Database Engine Implementation
// ============================================================================

/**
 * Default query timeout in milliseconds (30 seconds).
 */
const DEFAULT_QUERY_TIMEOUT_MS = 30000;
const PROGRESS_HANDLER_INTERVAL = 1000;

interface WasmCellReadSessionState {
  sessionId: string;
  target: CellReadTarget;
  sqlTarget: CellReadSqlTarget;
  metadata: CellMetadata;
  savepointName: string;
  absoluteExpiresAt: number;
  expiresAt: number;
  idleTimer: ReturnType<typeof setTimeout>;
  absoluteTimer: ReturnType<typeof setTimeout>;
}

interface WasmQueryReadSessionState {
  sessionId: string;
  statement: WasmPreparedStatement;
}

const MAX_QUERY_READ_ROWS = 128;

/**
 * State a page-on-demand (openPaged) open hands the engine. Presence of
 * this object is what marks the engine as paged: counts consult the shared
 * paged count policy, serialization is allowed only for writable overlays,
 * and shutdown releases the host read resources after the WASM instance
 * closes.
 */
export interface WasmEnginePagedState {
  /** True only when the fork supplied a copy-on-write overlay. */
  writable: boolean;
  /** Size of the snapshot; upper-bounds any table scan within it. */
  fileSizeBytes: number;
  /** Resolved exact-count gate (resolvePagedExactCountMaxFileBytes). */
  exactCountMaxFileBytes: number;
  /** Identity of the frozen base originally opened by the worker. */
  baseIdentity: PagedFileIdentity;
  /** Persistent host-read failure, used to replace SQLite's generic I/O error. */
  getReadError?: () => Error | undefined;
  /** Revalidate the frozen base even when every export read hits the host cache. */
  assertBaseUnchanged?: () => void;
  /** Release host read resources; called once from shutdown(). */
  dispose?: () => void;
}

export class WasmDatabaseEngine implements DatabaseOperations {
  private readonly instance: WasmDatabaseInstance;
  private readonly queryTimeout: number;
  private readonly readOnlyMode: boolean;
  private readonly logger: WasmEngineLogHandler;
  /** Whether SQLite's json_patch() function is available (JSON1 extension). */
  private readonly hasJsonPatch: boolean;
  private readonly cellReadSessionIdleTimeoutMs: number;
  private readonly cellReadSessionAbsoluteTimeoutMs: number;
  private cellReadSession: WasmCellReadSessionState | undefined;
  private readonly closedCellReadSessionIds = new Set<string>();
  private queryReadSession: WasmQueryReadSessionState | undefined;
  private readonly closedQueryReadSessionIds = new Set<string>();
  private instanceClosed = false;
  /** Set only for page-on-demand opens; undefined for buffer opens. */
  private readonly pagedState: WasmEnginePagedState | undefined;
  private pagedOverlayMemoryWarningEmitted = false;
  private pagedAtomicRewriteWarningEmitted = false;
  readonly engineKind = Promise.resolve('wasm' as const);

  constructor(
    instance: WasmDatabaseInstance,
    timeoutMs: number = DEFAULT_QUERY_TIMEOUT_MS,
    readOnlyMode: boolean = false,
    logger?: WasmEngineLogHandler,
    cellReadOptions: {
      idleTimeoutMs?: number;
      absoluteTimeoutMs?: number;
    } = {},
    pagedState?: WasmEnginePagedState
  ) {
    this.instance = instance;
    this.pagedState = pagedState;
    this.queryTimeout = timeoutMs;
    this.readOnlyMode = readOnlyMode;
    this.logger = logger ?? ((level, ...args) => console[level](...args));
    this.cellReadSessionIdleTimeoutMs = normalizeCellReadTimeout(
      cellReadOptions.idleTimeoutMs,
      DEFAULT_CELL_READ_SESSION_IDLE_TIMEOUT_MS
    );
    this.cellReadSessionAbsoluteTimeoutMs = Math.max(
      this.cellReadSessionIdleTimeoutMs,
      normalizeCellReadTimeout(
        cellReadOptions.absoluteTimeoutMs,
        DEFAULT_CELL_READ_SESSION_ABSOLUTE_TIMEOUT_MS
      )
    );

    if (this.readOnlyMode) {
      // Public mutation methods fail early with operation-specific messages,
      // while SQLite itself blocks any overlooked or newly added write path.
      instance.exec('PRAGMA query_only = ON');
    }

    // Probe for json_patch() availability at construction time.
    // json_patch() is part of the JSON1 extension, which is included in most
    // sql.js WASM builds but not guaranteed in all environments.
    try {
      instance.exec("SELECT json_patch('{}', '{}')");
      this.hasJsonPatch = true;
    } catch {
      this.hasJsonPatch = false;
    }
  }

  /**
   * Attempt a ROLLBACK and log failures instead of throwing.
   * Used in catch blocks where the original error should propagate,
   * not a secondary rollback failure.
   */
  private async safeRollback(context: string): Promise<void> {
    try {
      await this.executeQuery('ROLLBACK');
    } catch (rollbackErr) {
      this.logger('warn', `Failed to rollback (${context}):`, rollbackErr);
    }
  }

  /**
   * Build a quoted SAVEPOINT name that is unique enough for nested engine work.
   */
  private createSavepointName(prefix: string): string {
    return escapeIdentifier(`${prefix}_${crypto.randomUUID().replace(/-/g, '')}`);
  }

  /**
   * Roll back and release a SAVEPOINT without masking the original failure.
   */
  private async safeRollbackSavepoint(savepointName: string, context: string): Promise<void> {
    try {
      await this.executeQuery(`ROLLBACK TO ${savepointName}`);
      await this.executeQuery(`RELEASE ${savepointName}`);
    } catch (rollbackErr) {
      this.logger('warn', `Failed to rollback savepoint (${context}):`, rollbackErr);
    }
  }

  /** Prepare only when SQLite proves the statement consumed our generated suffix. */
  private prepareSingleStatement(sql: string): WasmPreparedStatement {
    const boundary = `/*sqlite_explorer_boundary_${crypto.randomUUID().replace(/-/g, '')}*/`;
    const statement = this.instance.prepare(`${sql}\n${boundary}`);
    if (!statement.getSQL().trimEnd().endsWith(boundary)) {
      statement.free();
      throw new Error('Exactly one SQL statement is required');
    }
    return statement;
  }

  /** Execute exactly the checked prepared statement, never a trailing statement. */
  private runSingleStatement(sql: string): void {
    // Validate with the boundary comment, then execute the original SQL so a
    // CREATE statement does not persist our private marker in sqlite_schema.
    this.compileSingleStatement(sql);
    const statement = this.instance.prepare(sql);
    try {
      statement.run();
    } finally {
      statement.free();
    }
  }

  /** Compile a statement through SQLite without retaining or executing it. */
  private compileSingleStatement(sql: string): void {
    const statement = this.prepareSingleStatement(sql);
    statement.free();
  }

  /**
   * Run synchronous SQLite work with a real VM deadline and optional cooperative
   * cancellation. The handler is connection-global, so every registration is
   * paired with an unconditional clear before another engine operation can run.
   */
  private executeWithProgressHandler<T>(
    operation: () => T,
    cancellation?: WasmQueryCancellation
  ): T {
    const isCancelled = (): boolean => {
      if (!cancellation) return false;
      if ('aborted' in cancellation) return cancellation.aborted;
      return cancellation.length > 0 && Atomics.load(cancellation, 0) !== 0;
    };
    const throwCancellation = (): never => {
      if (cancellation && 'aborted' in cancellation) {
        cancellation.throwIfAborted();
      }
      const error = new Error('Query execution cancelled');
      error.name = 'AbortError';
      throw error;
    };

    if (isCancelled()) throwCancellation();

    const deadline = Date.now() + this.queryTimeout;
    let termination: 'timeout' | 'cancelled' | undefined;
    this.instance.progress_handler(PROGRESS_HANDLER_INTERVAL, () => {
      if (isCancelled()) {
        termination = 'cancelled';
        return true;
      }
      if (Date.now() >= deadline) {
        termination = 'timeout';
        return true;
      }
      return false;
    });

    try {
      return operation();
    } catch (error) {
      const pagedReadError = this.pagedState?.getReadError?.();
      if (pagedReadError) throw pagedReadError;
      if (termination === 'timeout') {
        throw new Error(`Query execution timed out after ${this.queryTimeout}ms`);
      }
      if (termination === 'cancelled' || isCancelled()) throwCancellation();
      throw error;
    } finally {
      this.instance.progress_handler(null);
    }
  }

  /** Read a generated preview SELECT under the configured VM deadline. */
  private executeSingleQuery(
    sql: string,
    cancellation?: WasmQueryCancellation
  ): QueryResultSet {
    return this.executeWithProgressHandler(() => {
      const sourceStatement = this.prepareSingleStatement(sql);
      const headers = sourceStatement.getColumnNames();
      sourceStatement.free();
      const transportQuery = buildExactNumericTextQuery(sql, headers.length);
      const statement = this.prepareSingleStatement(transportQuery.sql);
      const sourceRows: Array<Array<CellValue | bigint>> = [];
      try {
        while (statement.step()) {
          const row = statement.get(null, { useBigInt: true });
          if (!row) {
            throw new Error('SQLite returned no row after a successful statement step');
          }
          sourceRows.push(row);
        }
        const { rows, exactIntegerTexts } = normalizeIntegerRowsForTransport(
          sourceRows,
          transportQuery.valueColumnCount
        );
        return { headers, rows, columns: headers, values: rows, exactIntegerTexts };
      } finally {
        statement.free();
      }
    }, cancellation);
  }

  /**
   * Execute a SQL query and return structured results.
   *
   * Returns results in sql.js compatible format for webview compatibility.
   * The webview expects { columns, values } format from the original sql.js.
   * Implements query timeout to prevent runaway queries.
   *
   * @param sql - SQL statement to execute
   * @param params - Optional bound parameters
   * @returns Array of result sets in sql.js format
   */
  async executeQuery(
    sql: string,
    params?: CellValue[],
    cancellation?: WasmQueryCancellation
  ): Promise<QueryResultSet[]> {
    this.assertNoActiveReadSession();
    const results: QueryResultSet[] = [];
    const executionState: { currentStmt?: WasmPreparedStatement } = {};

    try {
      return this.executeWithProgressHandler(() => {
        const iterator = this.instance.iterateStatements(sql);
        let isFirstStatement = true;

        for (const stmt of iterator) {
          executionState.currentStmt = stmt;

          // Bind parameters only to the first statement to match exec behavior
          if (isFirstStatement && params && params.length > 0) {
            stmt.bind(normalizeWasmBindParams(params));
          }
          isFirstStatement = false;

          const rows: CellValue[][] = [];

          while (stmt.step()) {
            const row = stmt.get();
            if (row) {
              rows.push(row);
            }
          }

          const columns = stmt.getColumnNames();
          // Only include results that have columns (matching exec behavior)
          if (columns.length > 0) {
            results.push({
              columns,
              values: rows,
              headers: columns,
              rows
            });
          }

          // iterateStatements handles freeing - clear reference
          executionState.currentStmt = undefined;
        }
        return results;
      }, cancellation);
    } catch (err) {
      // Ensure current statement is freed if iteration was interrupted
      const interruptedStmt = executionState.currentStmt;
      if (interruptedStmt) {
        try {
          interruptedStmt.free();
        } catch (freeErr) {
          this.logger('warn', 'Failed to free statement on error:', freeErr);
        }
      }
      if (cancellation && 'aborted' in cancellation && cancellation.aborted) {
        cancellation.throwIfAborted();
      }
      const errorDetail = err instanceof Error ? err.message : String(err);
      throw new Error(`Query failed: ${errorDetail}`);
    }
  }

  private assertNoActiveReadSession(): void {
    if (this.cellReadSession) {
      throw new Error(
        'A cell read session is active; close it before running another database operation'
      );
    }
    if (this.queryReadSession) {
      throw new Error(
        'A query read session is active; close it before running another database operation'
      );
    }
  }

  private getCellTextEncoding(): CellTextEncoding {
    const encoding = this.instance.exec('PRAGMA encoding')[0]?.values?.[0]?.[0];
    return normalizeCellTextEncoding(encoding);
  }

  private async resolveCellReadSqlTarget(target: CellReadTarget): Promise<CellReadSqlTarget> {
    validateCellReadTarget(target);
    const identity = await this.resolveTableIdentity(target.table);
    const predicate = buildRecordIdentityPredicate(target.rowId, identity);
    return {
      table: target.table,
      column: target.column,
      predicateSql: predicate.sql,
      predicateParams: predicate.params
    };
  }

  private readCellMetadata(
    target: CellReadTarget,
    sqlTarget: CellReadSqlTarget
  ): CellMetadata {
    const query = buildCellMetadataQuery(sqlTarget);
    return decodeCellMetadata(
      this.queryRaw(query.sql, query.params).rows,
      this.getCellTextEncoding(),
      target
    );
  }

  async getCellMetadata(target: CellReadTarget): Promise<CellMetadata> {
    this.assertNoActiveReadSession();
    const sqlTarget = await this.resolveCellReadSqlTarget(target);
    return this.readCellMetadata(target, sqlTarget);
  }

  async openCellReadSession(target: CellReadTarget): Promise<CellReadSession> {
    this.assertNoActiveReadSession();
    const sqlTarget = await this.resolveCellReadSqlTarget(target);
    const sessionId = crypto.randomUUID();
    const savepointName = this.createSavepointName('sp_cell_read');
    this.instance.exec(`SAVEPOINT ${savepointName}`);

    try {
      // The metadata SELECT is deliberately the first database read inside the
      // bracket. It fixes the snapshot before any chunk can be requested.
      const metadata = this.readCellMetadata(target, sqlTarget);
      const now = Date.now();
      const absoluteExpiresAt = now + this.cellReadSessionAbsoluteTimeoutMs;
      const expiresAt = Math.min(
        now + this.cellReadSessionIdleTimeoutMs,
        absoluteExpiresAt
      );
      const expire = () => this.expireCellReadSession(sessionId);
      const idleTimer = setTimeout(expire, Math.max(1, expiresAt - now));
      const absoluteTimer = setTimeout(
        expire,
        Math.max(1, absoluteExpiresAt - now)
      );
      (idleTimer as unknown as { unref?: () => void }).unref?.();
      (absoluteTimer as unknown as { unref?: () => void }).unref?.();
      this.cellReadSession = {
        sessionId,
        target: { ...target },
        sqlTarget,
        metadata,
        savepointName,
        absoluteExpiresAt,
        expiresAt,
        idleTimer,
        absoluteTimer
      };
      return { sessionId, metadata, expiresAt };
    } catch (error) {
      try {
        this.instance.exec(`ROLLBACK TO ${savepointName}`);
        this.instance.exec(`RELEASE ${savepointName}`);
      } catch (cleanupError) {
        this.closeInstanceAfterCellReadCleanupFailure(
          [error, cleanupError],
          'Cell read session open failed and its savepoint cleanup also failed'
        );
      }
      throw error;
    }
  }

  async readCellChunk(
    sessionId: string,
    byteOffset: number,
    maxBytes: number
  ): Promise<CellReadChunk> {
    validateCellReadWindow(byteOffset, maxBytes);
    const session = this.cellReadSession;
    if (!session || session.sessionId !== sessionId) {
      throw new Error(`Cell read session expired or not found: ${sessionId}`);
    }
    if (Date.now() >= session.expiresAt || Date.now() >= session.absoluteExpiresAt) {
      this.expireCellReadSession(sessionId);
      throw new Error(`Cell read session expired or not found: ${sessionId}`);
    }
    if (byteOffset > session.metadata.byteLength) {
      throw new Error(
        `Cell read byte offset ${byteOffset} exceeds source length ${session.metadata.byteLength}`
      );
    }

    const query = buildCellChunkQuery(session.sqlTarget);
    const rows = this.queryRaw(
      query.sql,
      [byteOffset, maxBytes, ...query.params]
    ).rows;
    if (rows.length !== 1) {
      throw new Error(`Snapshot cell ${session.target.table}.${session.target.column} disappeared`);
    }
    const rawBytes = rows[0][0];
    if (!(rawBytes instanceof Uint8Array)) {
      throw new Error('SQLite returned a non-BLOB cell read window');
    }
    const bytes = rawBytes.slice();
    if (bytes.byteLength > maxBytes) {
      throw new Error('SQLite returned a cell read window larger than requested');
    }
    this.refreshCellReadSession(session);
    return {
      byteOffset,
      bytes,
      done: byteOffset + bytes.byteLength >= session.metadata.byteLength
    };
  }

  async closeCellReadSession(sessionId: string): Promise<void> {
    if (this.closedCellReadSessionIds.has(sessionId)) return;
    const session = this.cellReadSession;
    if (!session || session.sessionId !== sessionId) {
      throw new Error(`Cell read session expired or not found: ${sessionId}`);
    }
    this.releaseCellReadSession(session);
  }

  async openQueryReadSession(sql: string): Promise<QueryReadSession> {
    this.assertNoActiveReadSession();
    const sessionId = crypto.randomUUID();
    const statement = this.prepareSingleStatement(sql);
    this.queryReadSession = { sessionId, statement };
    return { sessionId };
  }

  async readQueryRows(sessionId: string, maxRows: number): Promise<QueryReadChunk> {
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_QUERY_READ_ROWS) {
      throw new Error(
        `Query read row limit must be an integer between 1 and ${MAX_QUERY_READ_ROWS}`
      );
    }
    const session = this.queryReadSession;
    if (!session || session.sessionId !== sessionId) {
      throw new Error(`Query read session not found: ${sessionId}`);
    }

    return this.executeWithProgressHandler(() => {
      const rows: CellValue[][] = [];
      while (rows.length < maxRows && session.statement.step()) {
        const row = session.statement.get();
        if (!row) {
          throw new Error('SQLite returned no row after a successful statement step');
        }
        rows.push(row);
      }
      // When a batch fills exactly, EOF is learned by the next bounded read;
      // stepping ahead here would consume a row we cannot safely buffer.
      return { rows, done: rows.length < maxRows };
    });
  }

  async closeQueryReadSession(sessionId: string): Promise<void> {
    if (this.closedQueryReadSessionIds.has(sessionId)) return;
    const session = this.queryReadSession;
    if (!session || session.sessionId !== sessionId) {
      throw new Error(`Query read session not found: ${sessionId}`);
    }
    this.queryReadSession = undefined;
    try {
      session.statement.free();
    } finally {
      this.closedQueryReadSessionIds.add(sessionId);
    }
  }

  private refreshCellReadSession(session: WasmCellReadSessionState): void {
    clearTimeout(session.idleTimer);
    const now = Date.now();
    session.expiresAt = Math.min(
      now + this.cellReadSessionIdleTimeoutMs,
      session.absoluteExpiresAt
    );
    session.idleTimer = setTimeout(
      () => this.expireCellReadSession(session.sessionId),
      Math.max(1, session.expiresAt - now)
    );
    (session.idleTimer as unknown as { unref?: () => void }).unref?.();
  }

  private expireCellReadSession(sessionId: string): void {
    const session = this.cellReadSession;
    if (!session || session.sessionId !== sessionId) return;
    try {
      this.releaseCellReadSession(session);
    } catch (error) {
      this.logger('error', 'Failed to release expired cell read session:', error);
    }
  }

  /**
   * A failed ROLLBACK/RELEASE leaves the savepoint state unknowable. Closing
   * the sql.js database is the only remaining way to ensure the snapshot
   * cannot stay pinned after the session has been removed from our registry.
   */
  private closeInstanceAfterCellReadCleanupFailure(
    errors: unknown[],
    message: string
  ): never {
    try {
      this.instance.close();
      this.instanceClosed = true;
    } catch (closeError) {
      errors.push(closeError);
    }
    throw new AggregateError(errors, message);
  }

  private releaseCellReadSession(session: WasmCellReadSessionState): void {
    clearTimeout(session.idleTimer);
    clearTimeout(session.absoluteTimer);
    this.cellReadSession = undefined;
    this.closedCellReadSessionIds.add(session.sessionId);
    if (this.closedCellReadSessionIds.size > 64) {
      this.closedCellReadSessionIds.delete(this.closedCellReadSessionIds.values().next().value!);
    }
    try {
      this.instance.exec(`RELEASE ${session.savepointName}`);
    } catch (releaseError) {
      try {
        this.instance.exec(`ROLLBACK TO ${session.savepointName}`);
        this.instance.exec(`RELEASE ${session.savepointName}`);
      } catch (cleanupError) {
        this.closeInstanceAfterCellReadCleanupFailure(
          [releaseError, cleanupError],
          'Failed to release cell read session savepoint'
        );
      }
      throw releaseError;
    }
  }

  /**
   * Serialize the database to binary format.
   * This implements a caller-selected whole-image export; save policy remains
   * with DatabaseDocument and explicit export policy with HostBridge.
   *
   * @param _name - Identifier (unused, for interface compatibility)
   * @returns Database binary content
   */
  async serializeDatabase(signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const content = this.exportDatabaseImage();
    signal?.throwIfAborted();
    return content;
  }

  /** Export a buffer/paged-writable database and normalize the fork's save gate. */
  private exportDatabaseImage(): Uint8Array {
    this.assertSerializable();
    this.pagedState?.assertBaseUnchanged?.();
    try {
      const data = this.instance.export();
      // A cached base page does not invoke hostIo.read(), so revalidate after
      // export as well before any caller is allowed to persist the image.
      this.pagedState?.assertBaseUnchanged?.();
      return data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.pagedState?.writable && /transaction is open/i.test(message)) {
        throw new Error(
          'Cannot save while a database transaction is open; retry after the edit completes.',
          { cause: error }
        );
      }
      throw error;
    }
  }

  /** Extract and validate the dirty copy-on-write state without reading the base. */
  exportPagedWritableOverlay(): PagedWritableOverlaySnapshot {
    const pagedState = this.pagedState;
    if (!pagedState?.writable) {
      throw new Error(
        'Paged overlay export is available only for writable page-on-demand databases.'
      );
    }
    const exportOverlay = this.instance.exportPagedWritableOverlay;
    if (!exportOverlay) {
      throw new Error(
        'Writable sql.js fork does not expose exportPagedWritableOverlay.'
      );
    }

    pagedState.assertBaseUnchanged?.();
    let rawOverlay: RawPagedWritableOverlay;
    try {
      rawOverlay = exportOverlay.call(this.instance);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/transaction is open/i.test(message)) {
        throw new Error(
          'Cannot save while a database transaction is open; retry after the edit completes.',
          { cause: error }
        );
      }
      throw error;
    }
    // Validate the frozen base before any normalization allocation or transfer.
    pagedState.assertBaseUnchanged?.();

    const snapshot = normalizePagedWritableOverlay(rawOverlay, pagedState.baseIdentity);
    if (
      shouldWarnForPagedOverlayCopy(
        snapshot.dirtyBytes,
        this.pagedOverlayMemoryWarningEmitted
      )
    ) {
      this.pagedOverlayMemoryWarningEmitted = true;
      this.logger(
        'warn',
        'Saving a writable page-on-demand database copied '
        + `${snapshot.dirtyBytes} dirty overlay bytes in worker memory.`
      );
    }
    if (
      shouldWarnForPagedAtomicRewrite(
        snapshot.logicalSize,
        this.pagedAtomicRewriteWarningEmitted
      )
    ) {
      this.pagedAtomicRewriteWarningEmitted = true;
      this.logger(
        'warn',
        'Atomic save rewrites the full '
        + `${snapshot.logicalSize} bytes to an adjacent temporary file; `
        + 'save time, disk I/O, and required free space scale with the database size.'
      );
    }
    return snapshot;
  }

  /**
   * Surface a clear, actionable error for whole-database serialization on
   * a paged open instead of the fork's terser stage-0 export() message.
   * Save/Save As are already gated by the document's read-only flag; this
   * covers the remaining desktop surfaces that reach export() directly
   * (the webview's exportDb RPC, future callers).
   */
  private assertSerializable(): void {
    if (this.pagedState && !this.pagedState.writable) {
      throw new Error(
        'Database export is unavailable for a read-only page-on-demand snapshot. '
        + 'Reopen with writable page-on-demand support or use the native desktop '
        + 'backend to edit and save this database.'
      );
    }
  }

  /**
   * Apply a batch of modifications.
   *
   * Hot-exit restore opens the last saved database bytes first, then replays
   * the serialized uncommitted edit entries into that fresh in-memory database.
   * Each entry is applied through the same forward path used by redo so restore
   * and redo cannot drift apart.
   */
  async applyModifications(
    mods: ModificationEntry[],
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted();
    if (mods.length === 0) return;

    const firstPragma = mods.findIndex(mod => mod.modificationType === 'pragma_update');
    if (firstPragma < 0) {
      await this.applyTransactionalModificationRun(mods, signal);
      return;
    }

    // journal_mode cannot change inside a transaction. Preserve history order
    // while keeping each ordinary run atomic; a PRAGMA is verified immediately
    // before replay advances to the next entry.
    let runStart = 0;
    for (let index = firstPragma; index < mods.length; index++) {
      const mod = mods[index];
      if (mod.modificationType !== 'pragma_update') continue;
      await this.applyTransactionalModificationRun(mods.slice(runStart, index), signal);
      signal?.throwIfAborted();
      await this.forwardApply(mod, true);
      signal?.throwIfAborted();
      runStart = index + 1;
    }
    await this.applyTransactionalModificationRun(mods.slice(runStart), signal);
  }

  private async applyTransactionalModificationRun(
    mods: ModificationEntry[],
    signal?: AbortSignal
  ): Promise<void> {
    if (mods.length === 0) return;
    const savepointName = this.createSavepointName('sp_apply_modifications');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      for (const mod of mods) {
        // Check cancellation at the replay boundary so an aborted restore stops
        // before the next modification starts mutating the in-memory database.
        signal?.throwIfAborted();
        await this.forwardApply(mod, true);
        signal?.throwIfAborted();
      }
      signal?.throwIfAborted();
      await this.executeQuery(`RELEASE ${savepointName}`);
    } catch (err) {
      await this.safeRollbackSavepoint(savepointName, 'applyModifications');
      throw err;
    }
  }

  /**
   * Undo a modification.
   */
  async undoModification(mod: ModificationEntry): Promise<void> {
    const { modificationType, targetTable } = mod;
    if (modificationType === 'pragma_update') {
      throw new Error('Persistent PRAGMA changes are forward-only history barriers');
    }
    if (!targetTable) {
      throw new Error(`Cannot undo ${modificationType}: missing target table`);
    }

    switch (modificationType) {
      case 'cell_update':
        await this.undoCellUpdate(targetTable, mod);
        break;

      case 'row_insert':
        await this.undoRowInsert(targetTable, mod);
        break;

      case 'row_delete':
        await this.undoRowDelete(targetTable, mod);
        break;

      case 'column_add':
        await this.undoColumnAdd(targetTable, mod);
        break;

      case 'column_drop':
        await this.undoColumnDrop(targetTable, mod);
        break;

      case 'table_create':
        await this.undoTableCreate(targetTable, mod);
        break;

      case 'view_create':
        if (mod.viewDefAfter) {
          await this.applyViewHistoryState(targetTable, mod.viewDefAfter, null);
        } else {
          throw new Error('Cannot undo view_create: missing view definition');
        }
        break;

      case 'view_edit':
        if (mod.viewDefBefore && mod.viewDefAfter) {
          await this.applyViewHistoryState(targetTable, mod.viewDefAfter, mod.viewDefBefore);
        } else {
          throw new Error('Cannot undo view_edit: missing view definition');
        }
        break;

      case 'view_drop':
        if (mod.viewDefBefore) {
          await this.applyViewHistoryState(targetTable, null, mod.viewDefBefore);
        } else {
          throw new Error('Cannot undo view_drop: missing view definition');
        }
        break;

      default:
        throw new Error(`Cannot undo unsupported modification type: ${String(modificationType)}`);
    }
  }

  private async undoCellUpdate(targetTable: string, mod: ModificationEntry): Promise<void> {
    await this.replayCellHistory(targetTable, mod, 'undo');
  }

  private guardedCellHistoryEntries(mod: ModificationEntry): GuardedCellHistoryEntry[] {
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
  }

  /**
   * Replay one cell-history entry under a single compare-and-swap savepoint.
   * Reads start after SAVEPOINT and every write matches the exact state read,
   * so a second connection cannot land between JSON planning and mutation.
   */
  private async replayCellHistory(
    table: string,
    mod: ModificationEntry,
    direction: 'undo' | 'redo'
  ): Promise<void> {
    if (mod.undoPolicy === 'barrier') {
      throw new Error('Forward-only cell history barriers cannot be replayed');
    }
    const cells = this.guardedCellHistoryEntries(mod);
    const usesPrimaryKey = cells.some(cell => isPrimaryKeyRecordId(cell.rowId));
    if (usesPrimaryKey && !cells.every(cell => isPrimaryKeyRecordId(cell.rowId))) {
      throw new Error('Cannot mix rowid and primary-key row identities');
    }
    const identity = await this.resolveTableIdentity(table);
    if (usesPrimaryKey && identity.kind !== 'primaryKey') {
      throw new Error(`Primary-key identity cannot target rowid table ${table}`);
    }
    if (!usesPrimaryKey && identity.kind !== 'rowid') {
      throw new Error(`Rowid identity cannot target WITHOUT ROWID table ${table}`);
    }

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

    const savepointName = this.createSavepointName('sp_replay_cell_history');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      await this.assertUpdateHasNoTargetTableTriggerWrites(
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
        const currentResult = this.queryRaw(
          `SELECT ${projections.join(', ')} FROM ${escapeMainIdentifier(table)} ` +
          `WHERE ${currentPredicate.sql} LIMIT 2`,
          currentPredicate.params
        );
        if (currentResult.rows.length !== 1) {
          throw new CellHistoryConflictError(table, rowCells.map(cell => cell.columnName));
        }

        const currentStates = rowCells.map((cell, index) => parseStoredCellState(
          currentResult.rows[0][index * 2],
          currentResult.rows[0][index * 2 + 1],
          `${table}.${cell.columnName}`,
          { textEncoding: this.getCellTextEncoding() }
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

        const writes = targetStates.map(state => buildStoredCellWrite(state, wasmBindPlaceholder));
        const guards = currentStates.map((state, index) => buildStoredCellPredicate(
          rowCells[index].columnName,
          state,
          wasmBindPlaceholder
        ));
        await this.executeQuery(
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
        );
        if (this.readChangesCount() !== 1) {
          throw new CellHistoryConflictError(table, rowCells.map(cell => cell.columnName));
        }

        const targetPredicate = buildRecordIdentityPredicate(targetRowId, identity);
        const actualResult = this.queryRaw(
          `SELECT ${projections.join(', ')} FROM ${escapeMainIdentifier(table)} ` +
          `WHERE ${targetPredicate.sql} LIMIT 2`,
          targetPredicate.params
        );
        if (actualResult.rows.length !== 1) {
          throw new CellHistoryConflictError(table, rowCells.map(cell => cell.columnName));
        }
        const exactTarget = targetStates.every((state, index) => storedCellStatesEqual(
          state,
          parseStoredCellState(
            actualResult.rows[0][index * 2],
            actualResult.rows[0][index * 2 + 1],
            `${table}.${rowCells[index].columnName}`,
            { textEncoding: this.getCellTextEncoding() }
          )
        ));
        if (!exactTarget) {
          throw new CellHistoryConflictError(table, rowCells.map(cell => cell.columnName));
        }
      }
      await this.executeQuery(`RELEASE ${savepointName}`);
    } catch (error) {
      await this.safeRollbackSavepoint(savepointName, 'replayCellHistory');
      throw error;
    }
  }

  private async undoRowInsert(targetTable: string, mod: ModificationEntry): Promise<void> {
    if (!mod.insertedRow || mod.targetRowId === undefined) {
      throw new LegacyRowHistoryError();
    }
    if (
      typeof mod.insertedRow.rowId !== typeof mod.targetRowId ||
      String(mod.insertedRow.rowId) !== String(mod.targetRowId)
    ) {
      throw new LegacyRowHistoryError();
    }
    await this.deleteRowHistorySnapshots(targetTable, [mod.insertedRow]);
  }

  private async undoRowDelete(targetTable: string, mod: ModificationEntry): Promise<void> {
    const { deletedRows } = mod;
    if (deletedRows && deletedRows.length > 0) {
      await this.restoreRowHistorySnapshots(targetTable, deletedRows);
    } else {
      throw new Error('Cannot undo row_delete: missing deleted row data');
    }
  }

  private async deleteRowHistorySnapshots(
    table: string,
    snapshots: readonly DeletedRow[]
  ): Promise<void> {
    if (snapshots.length === 0) throw new LegacyRowHistoryError();
    snapshots.forEach(rowHistoryStates);
    const identity = await this.resolveTableIdentity(table);
    const savepointName = this.createSavepointName('sp_history_delete_rows');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      await this.assertDeleteHasNoUntrackedPrograms(table);
      for (const snapshot of snapshots) {
        const rowIdentity = buildRecordIdentityPredicate(snapshot.rowId, identity);
        const rowState = buildRowHistoryPredicate(snapshot, wasmBindPlaceholder);
        await this.executeQuery(
          `DELETE FROM ${escapeMainIdentifier(table)} WHERE ` +
          `(${rowIdentity.sql}) AND (${rowState.sql})`,
          [...rowIdentity.params, ...rowState.params]
        );
        if (this.readChangesCount() !== 1) throw new RowHistoryConflictError(table);
      }
      await this.executeQuery(`RELEASE ${savepointName}`);
    } catch (error) {
      await this.safeRollbackSavepoint(savepointName, 'deleteRowHistorySnapshots');
      throw error;
    }
  }

  private async restoreRowHistorySnapshots(
    table: string,
    snapshots: readonly DeletedRow[]
  ): Promise<void> {
    if (snapshots.length === 0) throw new LegacyRowHistoryError();
    const identity = await this.resolveTableIdentity(table);
    const prepared = snapshots.map(snapshot => ({
      snapshot,
      states: rowHistoryStates(snapshot),
      writes: buildRowHistoryWrites(snapshot, wasmBindPlaceholder)
    }));
    const savepointName = this.createSavepointName('sp_history_restore_rows');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      for (const entry of prepared) {
        await this.assertInsertHasNoUntrackedPrograms(
          table,
          entry.states.map(state => state.column)
        );
        const rowIdentity = buildRecordIdentityPredicate(entry.snapshot.rowId, identity);
        const existing = this.queryRaw(
          `SELECT 1 FROM ${escapeMainIdentifier(table)} ` +
          `WHERE ${rowIdentity.sql} LIMIT 1`,
          rowIdentity.params
        );
        if (existing.rows.length !== 0) throw new RowHistoryConflictError(table);
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
          values.unshift(wasmBindPlaceholder(entry.snapshot.rowId));
          params.unshift(entry.snapshot.rowId);
        }
        await this.executeQuery(
          `INSERT INTO ${escapeMainIdentifier(table)} ` +
          `(${columns.map(escapeIdentifier).join(', ')}) VALUES (${values.join(', ')})`,
          params
        );
        if (this.readChangesCount() !== 1) throw new RowHistoryConflictError(table);

        const rowIdentity = buildRecordIdentityPredicate(entry.snapshot.rowId, identity);
        const rowState = buildRowHistoryPredicate(entry.snapshot, wasmBindPlaceholder);
        const verified = this.queryRaw(
          `SELECT 1 FROM ${escapeMainIdentifier(table)} WHERE ` +
          `(${rowIdentity.sql}) AND (${rowState.sql}) LIMIT 2`,
          [...rowIdentity.params, ...rowState.params]
        );
        if (verified.rows.length !== 1) throw new RowHistoryConflictError(table);
      }
      await this.executeQuery(`RELEASE ${savepointName}`);
    } catch (error) {
      await this.safeRollbackSavepoint(savepointName, 'restoreRowHistorySnapshots');
      throw error;
    }
  }

  private async undoColumnAdd(targetTable: string, mod: ModificationEntry): Promise<void> {
    const { targetColumn } = mod;
    // Undo add column = drop column
    if (targetColumn) {
      await this.deleteColumns(
        targetTable,
        [targetColumn],
        undefined,
        mod.columnAddSnapshot
      );
    } else {
      throw new Error('Cannot undo column_add: missing column name');
    }
  }

  private readBoundedColumnDropForeignKeyViolations(
    table: string
  ): Array<readonly [string, string | null, string, string]> {
    // Use the PRAGMA statement directly: an untrusted database can create a
    // table named pragma_foreign_key_check and shadow the table-valued form.
    const statement = this.instance.prepare('PRAGMA foreign_key_check');
    const rows: Array<readonly [string, string | null, string, string]> = [];
    let aggregateBytes = 0;
    try {
      while (statement.step()) {
        const row = statement.get(null, { useBigInt: true });
        if (!row) throw new Error(`Invalid foreign-key check result for ${table}`);
        aggregateBytes += columnDropForeignKeyViolationBytes(table, row);
        if (aggregateBytes > COLUMN_DROP_FOREIGN_KEY_VIOLATION_BYTES_LIMIT) {
          throw new Error(
            `Cannot undo column drop on ${table}: foreign-key violations exceed the byte safety bound`
          );
        }
        rows.push(normalizeColumnDropForeignKeyViolation(table, row));
        if (rows.length > COLUMN_DROP_FOREIGN_KEY_VIOLATION_LIMIT) break;
      }
      return rows;
    } finally {
      statement.free();
    }
  }

  private async undoColumnDrop(targetTable: string, mod: ModificationEntry): Promise<void> {
    const { deletedColumns, columnDropSnapshot } = mod;
    // Undo drop column = add column + restore values
    if (!deletedColumns || deletedColumns.length === 0) {
      throw new Error('Cannot undo column_drop: missing deleted column data');
    }
    if (!columnDropSnapshot) {
      await this.undoLegacyColumnDrop(targetTable, deletedColumns);
      return;
    }

    const stagingTable = `__sqlite_explorer_column_restore_${crypto.randomUUID().replace(/-/g, '')}`;
    const plan = buildColumnDropRestorePlan(
      targetTable,
      stagingTable,
      deletedColumns,
      columnDropSnapshot
    );
    const readPragma = async (pragma: 'foreign_keys' | 'legacy_alter_table'): Promise<number> => {
      const result = await this.executeQuery(`PRAGMA ${pragma}`);
      const value = Number(result[0]?.rows[0]?.[0]);
      if (value !== 0 && value !== 1) {
        throw new Error(`SQLite returned an invalid ${pragma} value`);
      }
      return value;
    };
    const setPragma = async (
      pragma: 'foreign_keys' | 'legacy_alter_table',
      value: number
    ): Promise<void> => {
      await this.executeQuery(`PRAGMA ${pragma} = ${value ? 'ON' : 'OFF'}`);
      if (await readPragma(pragma) !== value) {
        throw new Error(`Unable to set PRAGMA ${pragma} for column-drop undo`);
      }
    };

    const foreignKeysBefore = await readPragma('foreign_keys');
    const legacyAlterBefore = await readPragma('legacy_alter_table');
    const restoreSavepoint = this.createSavepointName('sp_undo_column_drop');
    let savepointStarted = false;
    let operationError: unknown;
    try {
      if (foreignKeysBefore !== 0) await setPragma('foreign_keys', 0);
      if (legacyAlterBefore !== 1) await setPragma('legacy_alter_table', 1);

      await this.executeQuery(`SAVEPOINT ${restoreSavepoint}`);
      savepointStarted = true;
      const foreignKeyBaseline = captureColumnDropForeignKeyBaseline(
        targetTable,
        this.readBoundedColumnDropForeignKeyViolations(targetTable)
      );
      const current = await this.readColumnDropTableState(targetTable);
      assertColumnDropTableStateCurrent(targetTable, columnDropSnapshot.after, current);
      const collision = await this.executeQuery(
        'SELECT 1 FROM main.sqlite_schema WHERE name = ? COLLATE NOCASE LIMIT 1',
        [stagingTable]
      );
      if ((collision[0]?.rows.length ?? 0) !== 0) {
        throw new Error(`Column-drop staging table already exists: ${stagingTable}`);
      }

      let sequenceState: { value: CellValue } | undefined;
      const sequenceCatalog = await this.executeQuery(
        "SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = 'sqlite_sequence'"
      );
      if ((sequenceCatalog[0]?.rows.length ?? 0) !== 0) {
        const sequence = await this.executeQuery(
          'SELECT seq FROM main.sqlite_sequence WHERE name = ? LIMIT 2',
          [targetTable]
        );
        if ((sequence[0]?.rows.length ?? 0) > 1) {
          throw new Error(`Cannot undo column drop on ${targetTable}: sqlite_sequence is ambiguous`);
        }
        if ((sequence[0]?.rows.length ?? 0) === 1) {
          sequenceState = { value: sequence[0].rows[0][0] };
        }
      }

      for (const sql of plan.stageColumns) await this.executeQuery(sql);
      await this.restoreDroppedColumnValues(
        targetTable,
        deletedColumns,
        columnDropSnapshot.before.identity
      );
      for (const sql of plan.dropCurrentSchemaObjects) await this.executeQuery(sql);
      await this.executeQuery(plan.renameCurrentTable);
      this.runSingleStatement(plan.createOriginalTable);
      await this.executeQuery(plan.copyRows);
      await this.executeQuery(plan.dropStagingTable);
      if (sequenceState) {
        // RENAME transfers the retired-ID high-water mark to staging, while
        // INSERT...SELECT seeds the recreated table only at max(rowid). Restore
        // the exact pre-rebuild entry after dropping staging removes the old one.
        await this.executeQuery('DELETE FROM main.sqlite_sequence WHERE name = ?', [targetTable]);
        await this.executeQuery(
          'INSERT INTO main.sqlite_sequence(name, seq) VALUES (?, ?)',
          [targetTable, sequenceState.value]
        );
      }
      for (const sql of plan.restoreSchemaObjects) this.runSingleStatement(sql);

      const restored = await this.readColumnDropTableState(targetTable);
      assertColumnDropTableStateCurrent(targetTable, columnDropSnapshot.before, restored);
      assertNoNewColumnDropForeignKeyViolations(
        targetTable,
        foreignKeyBaseline,
        this.readBoundedColumnDropForeignKeyViolations(targetTable)
      );
      await this.executeQuery(`RELEASE ${restoreSavepoint}`);
      savepointStarted = false;
    } catch (error) {
      operationError = error;
      if (savepointStarted) {
        await this.safeRollbackSavepoint(restoreSavepoint, 'undoColumnDrop');
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
  }

  /** Map the current catalog state while the undo transaction holds its schema snapshot. */
  private async readColumnDropTableState(table: string): Promise<ColumnDropTableState> {
    const [schema, columns, identity, dataVersionResult] = await Promise.all([
      this.executeQuery(COLUMN_DROP_TABLE_STATE_SQL, [table, table]),
      this.getTableInfo(table),
      this.resolveTableIdentity(table),
      this.executeQuery('PRAGMA data_version')
    ]);
    const dataVersion = Number(dataVersionResult[0]?.rows[0]?.[0]);
    return mapColumnDropTableState(
      table,
      columns.map(column => column.identifier),
      identity,
      schema[0]?.rows ?? [],
      columns.filter(column => column.isGenerated).map(column => column.identifier),
      dataVersion
    );
  }

  /** Stage recorded values before rebuilding the table from its exact original DDL. */
  private async restoreDroppedColumnValues(
    table: string,
    deletedColumns: NonNullable<ModificationEntry['deletedColumns']>,
    identity: TableIdentity
  ): Promise<void> {
    const rowUpdates = new Map<RecordId, Map<string, CellValue | null>>();
    for (const column of deletedColumns) {
      for (const cell of column.data) {
        const rowId = identity.kind === 'rowid'
          ? validateRowId(cell.rowId)
          : cell.rowId;
        const values = rowUpdates.get(rowId) ?? new Map<string, CellValue | null>();
        values.set(column.name, cell.value ?? null);
        rowUpdates.set(rowId, values);
      }
    }

    const statements = new Map<string, WasmPreparedStatement>();
    try {
      for (const [rowId, values] of rowUpdates) {
        const params: CellValue[] = deletedColumns.map(column => values.get(column.name) ?? null);
        const setClause = deletedColumns.map((column, index) => (
          `${escapeIdentifier(column.name)} = ${wasmBindPlaceholder(params[index])}`
        )).join(', ');
        const predicate = buildRecordIdentityPredicate(rowId, identity);
        const sql =
          `UPDATE ${escapeMainIdentifier(table)} SET ${setClause} WHERE ${predicate.sql}`;
        let statement = statements.get(sql);
        if (!statement) {
          statement = this.instance.prepare(sql);
          statements.set(sql, statement);
        }
        statement.run(normalizeWasmBindParams([...params, ...predicate.params]));
      }
    } finally {
      for (const statement of statements.values()) statement.free();
    }
  }

  /** Replay older history entries that predate exact schema snapshots. */
  private async undoLegacyColumnDrop(
    targetTable: string,
    deletedColumns: NonNullable<ModificationEntry['deletedColumns']>
  ): Promise<void> {
    const savepointName = this.createSavepointName('sp_undo_legacy_column_drop');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      const addColumnStatements = deletedColumns.map(column => {
        validateSqlType(column.type);
        return `ALTER TABLE ${escapeMainIdentifier(targetTable)} ADD COLUMN ${escapeIdentifier(column.name)} ${column.type};`;
      }).join('\n');
      if (addColumnStatements) await this.executeQuery(addColumnStatements);
      await this.restoreDroppedColumnValues(targetTable, deletedColumns, { kind: 'rowid' });
      await this.executeQuery(`RELEASE ${savepointName}`);
    } catch (error) {
      await this.safeRollbackSavepoint(savepointName, 'undoColumnDrop legacy');
      throw error;
    }
  }

  private async undoTableCreate(
    targetTable: string,
    mod: ModificationEntry
  ): Promise<void> {
    if (!mod.tableCreateSnapshot) {
      throw new Error(
        `Cannot undo table creation on ${targetTable}: history lacks the required schema snapshot`
      );
    }

    const savepointName = this.createSavepointName('sp_undo_table_create');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      const dependenciesBefore = await this.captureViewDependencySnapshot();
      const current = await this.readColumnDropTableState(targetTable);
      assertTableSchemaStateCurrent(
        targetTable,
        mod.tableCreateSnapshot,
        current,
        'undo table creation',
        'after the table was created'
      );
      const rows = await this.executeQuery(
        `SELECT 1 FROM ${escapeMainIdentifier(targetTable)} LIMIT 1`
      );
      if ((rows[0]?.rows.length ?? 0) !== 0) {
        throw new Error(
          `Cannot undo table creation on ${targetTable}: the table contains data`
        );
      }
      await this.executeQuery(`DROP TABLE ${escapeMainIdentifier(targetTable)}`);
      assertNoNewBrokenSchemaDependencies(
        dependenciesBefore,
        await this.captureViewDependencySnapshot()
      );
      await this.executeQuery(`RELEASE ${savepointName}`);
    } catch (error) {
      await this.safeRollbackSavepoint(savepointName, 'undoTableCreate');
      throw error;
    }
  }

  /**
   * Apply one modification in the forward direction.
   *
   * `strict` is enabled for hot-exit restore so malformed or unsupported
   * entries fail loudly instead of silently dropping recovered edits. Redo uses
   * the historical non-strict behavior so existing undo/redo semantics are not
   * changed for entries that lack enough data to replay.
   *
   * Keep the non-strict redo shape paired with nativeWorker.redoModification so
   * ModificationEntry fields keep one interpretation across web and desktop.
   */
  private async forwardApply(mod: ModificationEntry, strict: boolean): Promise<void> {
    const { modificationType, targetTable, targetRowId, targetColumn, newValue, operation, affectedCells, tableDef, columnDef, deletedColumns, droppedIndexes } = mod;
    if (modificationType === 'pragma_update') {
      if (!mod.targetPragma || newValue === undefined) {
        throw new Error('Cannot apply pragma_update: missing PRAGMA name or new value');
      }
      await this.applyPragmaHistoryValue(mod.targetPragma, newValue);
      return;
    }
    if (!targetTable) {
      if (strict) throw new Error(`Cannot apply ${modificationType}: missing target table`);
      return;
    }

    switch (modificationType) {
        case 'cell_update':
            if (mod.undoPolicy === 'barrier') {
              if (!strict || targetRowId === undefined || !targetColumn) {
                throw new Error('Forward-only cell history barriers cannot be replayed by redo');
              }
              await this.updateCell(
                targetTable,
                targetRowId,
                targetColumn,
                newValue ?? null,
                undefined,
                undefined,
                HISTORY_REPLAY_EDIT_TOKEN
              );
              break;
            }
            await this.replayCellHistory(targetTable, mod, 'redo');
            break;

        case 'row_insert':
            if (!mod.insertedRow) throw new LegacyRowHistoryError();
            await this.restoreRowHistorySnapshots(targetTable, [mod.insertedRow]);
            break;

        case 'row_delete':
            if (!mod.deletedRows || mod.deletedRows.length === 0) {
              throw new LegacyRowHistoryError();
            }
            await this.deleteRowHistorySnapshots(targetTable, mod.deletedRows);
            break;

        case 'column_add':
            if (targetColumn && columnDef) {
                if (!mod.columnAddBeforeSnapshot) {
                  throw new Error('Cannot redo column addition: pre-add schema snapshot is unavailable');
                }
                await this.addColumn(
                  targetTable,
                  targetColumn,
                  columnDef.type,
                  columnDef.defaultValue,
                  mod.columnAddBeforeSnapshot
                );
            } else if (strict) {
                throw new Error('Cannot apply column_add: missing column definition');
            }
            break;

        case 'column_drop':
            if (deletedColumns) {
                const colNames = deletedColumns.map(c => c.name);
                await this.deleteColumns(
                  targetTable,
                  colNames,
                  droppedIndexes ?? undefined,
                  mod.columnDropSnapshot?.before
                );
            } else if (strict) {
                throw new Error('Cannot apply column_drop: missing deleted column data');
            }
            break;

        case 'table_create':
            if (tableDef && tableDef.columns) {
                await this.createTable(targetTable, tableDef.columns);
            } else if (strict) {
                throw new Error('Cannot apply table_create: missing table definition');
            }
            break;

        case 'view_create':
            if (mod.viewDefAfter) {
                await this.applyViewHistoryState(targetTable, null, mod.viewDefAfter);
            } else if (strict) {
                throw new Error('Cannot apply view_create: missing view definition');
            } else {
                this.logger(
                  'warn',
                  '[WasmDatabaseEngine] Skipping view redo: definition missing from history entry'
                );
            }
            break;

        case 'view_edit':
            if (mod.viewDefBefore && mod.viewDefAfter) {
                await this.applyViewHistoryState(
                  targetTable,
                  mod.viewDefBefore,
                  mod.viewDefAfter
                );
            } else if (strict) {
                throw new Error('Cannot apply view_edit: missing view definition');
            } else {
                this.logger(
                  'warn',
                  '[WasmDatabaseEngine] Skipping view redo: definition missing from history entry'
                );
            }
            break;

        case 'view_drop':
            if (mod.viewDefBefore) {
                await this.applyViewHistoryState(targetTable, mod.viewDefBefore, null);
            } else if (strict) {
                throw new Error('Cannot apply view_drop: missing view definition');
            } else {
                this.logger(
                  'warn',
                  '[WasmDatabaseEngine] Skipping view redo: definition missing from history entry'
                );
            }
            break;

        default:
            if (strict) {
                throw new Error(`Cannot apply unsupported modification type: ${String(modificationType)}`);
            }
            break;
    }
  }

  /**
   * Redo a modification.
   */
  async redoModification(mod: ModificationEntry): Promise<void> {
    await this.forwardApply(mod, true);
  }

  /**
   * Flush changes to storage.
   * No-op for in-memory database; actual persistence via serializeDatabase.
   */
  async flushChanges(_signal?: AbortSignal): Promise<void> {
    // In-memory database - flush handled by exporting to file
  }

  /**
   * Discard pending modifications.
   * Reverts changes by undoing them in reverse order.
   */
  async discardModifications(
    mods: ModificationEntry[],
    signal?: AbortSignal
  ): Promise<void> {
    await this.revertModifications(mods, [], signal);
  }

  async revertModifications(
    discard: ModificationEntry[],
    restore: ModificationEntry[],
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted();
    const needsColumnRestorePragmas = discard.some(
      modification => modification.modificationType === 'column_drop'
    );
    const readBooleanPragma = async (
      pragma: 'foreign_keys' | 'legacy_alter_table'
    ): Promise<number> => {
      const value = Number((await this.executeQuery(`PRAGMA ${pragma}`))[0]?.rows[0]?.[0]);
      if (value !== 0 && value !== 1) {
        throw new Error(`SQLite returned an invalid ${pragma} value`);
      }
      return value;
    };
    const setBooleanPragma = async (
      pragma: 'foreign_keys' | 'legacy_alter_table',
      value: number
    ): Promise<void> => {
      await this.executeQuery(`PRAGMA ${pragma} = ${value ? 'ON' : 'OFF'}`);
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
    const savepointName = this.createSavepointName('sp_revert_checkpoint');
    let savepointStarted = false;
    try {
      pragmasPrepared = true;
      if (needsColumnRestorePragmas) {
        if (foreignKeysBefore !== 0) await setBooleanPragma('foreign_keys', 0);
        if (legacyAlterBefore !== 1) await setBooleanPragma('legacy_alter_table', 1);
      }
      await this.executeQuery(`SAVEPOINT ${savepointName}`);
      savepointStarted = true;
      for (let index = discard.length - 1; index >= 0; index--) {
        signal?.throwIfAborted();
        await this.undoModification(discard[index]);
      }
      for (const modification of restore) {
        signal?.throwIfAborted();
        await this.forwardApply(modification, true);
      }
      signal?.throwIfAborted();
      await this.executeQuery(`RELEASE ${savepointName}`);
      savepointStarted = false;
    } catch (error) {
      operationError = error;
      if (savepointStarted) {
        await this.safeRollbackSavepoint(savepointName, 'revertModifications');
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
      this.logger(
        'warn',
        'History replay committed, but connection PRAGMAs could not be restored:',
        pragmaRestoreError
      );
    }
  }

  /**
   * Update a single cell value.
   */
  async updateCell(
    table: string,
    rowId: RecordId,
    column: string,
    value: CellValue,
    patch?: string,
    maxEditValueBytes?: number,
    historyReplayToken?: typeof HISTORY_REPLAY_EDIT_TOKEN
  ): Promise<RecordId> {
    this.assertNoActiveReadSession();
    const isHistoryReplay = historyReplayToken === HISTORY_REPLAY_EDIT_TOKEN;
    const enforcePriorPolicy = !isHistoryReplay && maxEditValueBytes !== undefined;
    const editLimitBytes = isHistoryReplay
      ? 0
      : assertCellValuesWithinEditLimit([value], maxEditValueBytes);
    assertMutableRecordId(rowId);
    if (isPrimaryKeyRecordId(rowId)) {
      const identity = await this.resolveTableIdentity(table);
      if (identity.kind !== 'primaryKey') {
        throw new Error(`Primary-key identity cannot target rowid table ${table}`);
      }
      const result = await this.updatePrimaryKeyCellBatch(table, identity, [{
        rowId,
        column,
        value: patch ?? value,
        operation: patch === undefined ? 'set' : 'json_patch'
      }], maxEditValueBytes, historyReplayToken);
      return result[0]?.newRowId ?? rowId;
    }

    // Validate rowId is a number
    const rowIdNum = validateRowId(rowId);
    const identity = await this.resolveTableIdentity(table);
    if (identity.kind !== 'rowid') {
      throw new Error(`Rowid identity cannot target WITHOUT ROWID table ${table}`);
    }
    const savepointName = this.createSavepointName('sp_update_rowid_cell');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);

    try {
      const rowIdAliasColumn = await this.readRowIdAliasColumn(table);
      await this.assertUpdateHasNoTargetTableTriggerWrites(table, [column]);
      let sql: string;
      let params: CellValue[];

      if (patch) {
        const escapedCol = escapeIdentifier(column);
        const escapedTbl = escapeMainIdentifier(table);

        if (this.hasJsonPatch) {
          // Use SQLite's native json_patch() — single UPDATE, no SELECT round-trip.
          // COALESCE handles NULL columns: json_patch(NULL, x) returns NULL per SQL semantics,
          // but the expected behavior is to treat NULL as empty object (matching JS fallback).
          sql =
            `UPDATE ${escapedTbl} SET ${escapedCol} = ` +
            `json_patch(COALESCE(${escapedCol}, '{}'), ?) WHERE rowid = ?` +
            (enforcePriorPolicy
              ? ` AND NOT (typeof(${escapedCol}) IN ('text', 'blob') ` +
                `AND length(CAST(${escapedCol} AS BLOB)) > ?)`
              : '');
          params = enforcePriorPolicy
            ? [
                typeof patch === 'string' ? patch : JSON.stringify(patch),
                rowIdNum,
                editLimitBytes
              ]
            : [typeof patch === 'string' ? patch : JSON.stringify(patch), rowIdNum];
        } else {
          // Fallback: read current value, apply patch in JS, write back
          if (enforcePriorPolicy) {
            await this.assertCellPriorWithinEditLimit(
              table,
              rowIdNum,
              column,
              editLimitBytes
            );
          }
          const currentResult = await this.executeQuery(
            `SELECT ${escapedCol} FROM ${escapedTbl} WHERE rowid = ?`,
            [rowIdNum]
          );
          const currentValue = currentResult[0]?.rows[0]?.[0];

          const currentObj = parseJsonValueForPatching(currentValue, 'updateCell');

          const patchObj = typeof patch === 'string' ? JSON.parse(patch) : patch;
          const newValueObj = applyMergePatch(currentObj, patchObj);
          const newValueStr = JSON.stringify(newValueObj);

          sql = `UPDATE ${escapedTbl} SET ${escapedCol} = ? WHERE rowid = ?`;
          params = [newValueStr, rowIdNum];
        }
      } else {
        const escapedColumn = escapeIdentifier(column);
        sql =
          `UPDATE ${escapeMainIdentifier(table)} SET ${escapedColumn} = ` +
          `${wasmBindPlaceholder(value)} WHERE rowid = ?` +
          (enforcePriorPolicy
            ? ` AND NOT (typeof(${escapedColumn}) IN ('text', 'blob') ` +
              `AND length(CAST(${escapedColumn} AS BLOB)) > ?)`
            : '');
        params = enforcePriorPolicy
          ? [value, rowIdNum, editLimitBytes]
          : [value, rowIdNum];
      }

      await this.executeQuery(sql, params);
      const changes = this.readChangesCount();
      if (changes !== 1) {
        if (enforcePriorPolicy) {
          await this.assertCellPriorWithinEditLimit(table, rowIdNum, column, editLimitBytes);
        }
        if (changes > 1) {
          throw new Error(`Cell ${table}.${column} matched more than one row`);
        }
        throw new Error(`Cannot update ${table}.${column}: row ${rowId} no longer exists`);
      }
      const newRowId = this.readUpdatedRowId(
        table,
        rowIdAliasColumn,
        rowIdNum,
        column,
        patch ?? value
      );
      await this.executeQuery(`RELEASE ${savepointName}`);
      return newRowId;
    } catch (error) {
      await this.safeRollbackSavepoint(savepointName, 'updateCell');
      throw error;
    }
  }

  async replaceOversizedCell(
    table: string,
    rowId: RecordId,
    column: string,
    value: CellValue,
    expected: OversizedCellMetadata,
    maxEditValueBytes?: number
  ): Promise<RecordId> {
    this.assertNoActiveReadSession();
    const editLimitBytes = assertCellValuesWithinEditLimit([value], maxEditValueBytes);
    assertOversizedCellReplacementExpectation(expected, editLimitBytes);
    assertMutableRecordId(rowId);
    const identity = await this.resolveTableIdentity(table);
    const predicate = buildRecordIdentityPredicate(rowId, identity);
    const escapedTable = escapeMainIdentifier(table);
    const escapedColumn = escapeIdentifier(column);
    const guardedSql =
      `UPDATE ${escapedTable} SET ${escapedColumn} = ${wasmBindPlaceholder(value)} ` +
      `WHERE ${predicate.sql} AND typeof(${escapedColumn}) = ? ` +
      `AND length(CAST(${escapedColumn} AS BLOB)) = ?`;
    const guardedParams = [
      value,
      ...predicate.params,
      expected.storageClass,
      expected.byteLength
    ];

    const updateAndResolveIdentity = async (): Promise<RecordId> => {
      await this.executeQuery(guardedSql, guardedParams);
      if (this.readChangesCount() !== 1) {
        throw new Error(OVERSIZED_CELL_REPLACEMENT_CONFLICT_MESSAGE);
      }
      if (identity.kind === 'rowid') {
        return this.readUpdatedRowId(
          table,
          await this.readRowIdAliasColumn(table),
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
      return this.readPrimaryKeyRecordId(
        table,
        identity,
        buildRecordIdentityPredicate(candidateId, identity),
        unresolvableTriggeredPrimaryKeyUpdateError(table)
      );
    };

    const savepointName = this.createSavepointName('sp_replace_oversized_cell');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      await this.assertUpdateHasNoTargetTableTriggerWrites(
        table,
        [column],
        identity.kind === 'rowid'
      );
      const newRowId = await updateAndResolveIdentity();
      await this.executeQuery(`RELEASE ${savepointName}`);
      return newRowId;
    } catch (error) {
      await this.safeRollbackSavepoint(savepointName, 'replaceOversizedCell');
      throw error;
    }
  }

  /**
   * Insert a new row.
   */
  async insertRow(
    table: string,
    data: Record<string, CellValue>,
    maxEditValueBytes?: number,
    historyReplayToken?: typeof HISTORY_REPLAY_EDIT_TOKEN
  ): Promise<RecordId | undefined> {
    const result = await this.insertRowInternal(
      table,
      data,
      maxEditValueBytes,
      historyReplayToken,
      false
    );
    return typeof result === 'object' ? result.rowId : result;
  }

  async insertRowWithHistory(
    table: string,
    data: Record<string, CellValue>,
    maxEditValueBytes?: number,
    maxUndoSnapshotBytes?: number
  ): Promise<DeletedRow> {
    const result = await this.insertRowInternal(
      table,
      data,
      maxEditValueBytes,
      undefined,
      true,
      maxUndoSnapshotBytes
    );
    if (!result || typeof result !== 'object') {
      throw new Error(`Insert into ${table} did not capture guarded row history`);
    }
    return result;
  }

  private async insertRowInternal(
    table: string,
    data: Record<string, CellValue>,
    maxEditValueBytes: number | undefined,
    historyReplayToken: typeof HISTORY_REPLAY_EDIT_TOKEN | undefined,
    captureHistory: boolean,
    maxUndoSnapshotBytes?: number
  ): Promise<RecordId | DeletedRow | undefined> {
    if (historyReplayToken !== HISTORY_REPLAY_EDIT_TOKEN) {
      assertCellValuesWithinEditLimit(Object.values(data), maxEditValueBytes);
    }
    const identity = await this.resolveTableIdentity(table);
    const columns = Object.keys(data);
    let sql: string;
    let params: CellValue[] = [];

    if (columns.length === 0) {
      sql = `INSERT INTO ${escapeMainIdentifier(table)} DEFAULT VALUES`;
    } else {
      const colNames = columns.map(escapeIdentifier).join(', ');
      params = columns.map(col => data[col]);
      const placeholders = params.map(wasmBindPlaceholder).join(', ');
      sql = `INSERT INTO ${escapeMainIdentifier(table)} (${colNames}) VALUES (${placeholders})`;
    }

    if (identity.kind === 'primaryKey') {
      const savepointName = this.createSavepointName('sp_insert_pk_row');
      await this.executeQuery(`SAVEPOINT ${savepointName}`);
      try {
        await this.assertInsertHasNoUntrackedPrograms(table, columns);
        const returningSql =
          `${sql} RETURNING ${buildByteFaithfulPrimaryKeyProjection(identity)}`;
        const result = this.queryRaw(returningSql, params);
        if (result.rows.length !== 1) {
          throw new Error(`Insert into ${table} did not return exactly one primary-key identity`);
        }
        const candidateId = encodeByteFaithfulPrimaryKeyRecordId(
          identity,
          result.rows[0],
          this.getCellTextEncoding(),
          `Cannot insert into ${table}`
        );
        const rowId = this.readPrimaryKeyRecordId(
          table,
          identity,
          buildRecordIdentityPredicate(candidateId, identity)
        );
        const history = captureHistory
          ? await this.captureInsertedRowHistory(table, identity, rowId, maxUndoSnapshotBytes)
          : undefined;
        await this.executeQuery(`RELEASE ${savepointName}`);
        return history ?? rowId;
      } catch (error) {
        await this.safeRollbackSavepoint(savepointName, 'insertPrimaryKeyRow');
        throw error;
      }
    }

    const savepointName = this.createSavepointName('sp_insert_rowid_row');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      await this.assertInsertHasNoUntrackedPrograms(table, columns);
      await this.executeQuery(sql, params);
      if (this.readChangesCount() !== 1) {
        throw new Error(`Insert into ${table} did not create exactly one row`);
      }
      const rawRowId = this.queryRaw(
        'SELECT CAST(last_insert_rowid() AS TEXT)'
      ).rows[0]?.[0];
      const rowId = validateRowId(rawRowId as RecordId | bigint);
      const predicate = buildRecordIdentityPredicate(rowId, identity);
      const current = this.queryRaw(
        `SELECT 1 FROM ${escapeMainIdentifier(table)} WHERE ${predicate.sql} LIMIT 2`,
        predicate.params
      );
      if (current.rows.length !== 1) {
        throw new Error(
          `Insert into ${table} did not leave one addressable row; the insert was rolled back`
        );
      }
      const history = captureHistory
        ? await this.captureInsertedRowHistory(table, identity, rowId, maxUndoSnapshotBytes)
        : undefined;
      await this.executeQuery(`RELEASE ${savepointName}`);
      return history ?? rowId;
    } catch (error) {
      await this.safeRollbackSavepoint(savepointName, 'insertRowIdRow');
      throw error;
    }
  }

  /**
   * Insert multiple rows in a batch within a transaction.
   */
  async insertRowBatch(
    table: string,
    rows: Record<string, CellValue>[],
    maxEditValueBytes?: number,
    historyReplayToken?: typeof HISTORY_REPLAY_EDIT_TOKEN
  ): Promise<void> {
    if (rows.length === 0) return;
    if (historyReplayToken !== HISTORY_REPLAY_EDIT_TOKEN) {
      assertCellValuesWithinEditLimit(
        rows.flatMap(row => Object.values(row)),
        maxEditValueBytes
      );
    }

    const escapedTable = escapeMainIdentifier(table);
    const statements = new Map<string, WasmPreparedStatement>();
    let operationFailed = false;
    let operationError: unknown;
    let failedStatement: WasmPreparedStatement | undefined;

    const savepointName = this.createSavepointName('sp_insert_row_batch');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      for (const row of rows) {
        const columns = Object.keys(row);
        const values = columns.map(column => row[column]);
        const placeholders = values.map(wasmBindPlaceholder);
        const key = `${columns.join('\0')}\0\0${placeholders.join('\0')}`;
        let statement = statements.get(key);
        if (!statement) {
          await this.assertInsertHasNoUntrackedPrograms(table, columns);
          const sql = columns.length === 0
            ? `INSERT INTO ${escapedTable} DEFAULT VALUES`
            : `INSERT INTO ${escapedTable} (${columns.map(escapeIdentifier).join(', ')}) ` +
              `VALUES (${placeholders.join(', ')})`;
          statement = this.instance.prepare(sql);
          statements.set(key, statement);
        }
        try {
          if (columns.length === 0) statement.run();
          else statement.run(normalizeWasmBindParams(values));
        } catch (error) {
          failedStatement = statement;
          throw error;
        }
      }
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }

    const cleanupErrors: unknown[] = [];
    for (const statement of statements.values()) {
      try {
        const finalized = statement.free();
        // sqlite3_finalize repeats the last sqlite3_step error as `false`.
        // That is the primary operation failure, not a second cleanup error.
        if (!finalized && statement !== failedStatement) {
          cleanupErrors.push(new Error('Failed to finalize batch insert statement'));
        }
      } catch (error) {
        // Keep finalizing the remaining shapes; one broken statement must not
        // leak every later cached statement or hide the primary insert error.
        cleanupErrors.push(error);
      }
    }

    if (operationFailed || cleanupErrors.length > 0) {
      let errorToThrow: unknown;
      if (operationFailed && cleanupErrors.length > 0) {
        errorToThrow = new AggregateError(
          [operationError, ...cleanupErrors],
          'Batch insertion failed and statement cleanup also failed'
        );
      } else if (operationFailed) {
        errorToThrow = operationError;
      } else if (cleanupErrors.length === 1) {
        errorToThrow = cleanupErrors[0];
      } else {
        errorToThrow = new AggregateError(
          cleanupErrors,
          'Multiple batch insert statements failed to finalize'
        );
      }
      await this.safeRollbackSavepoint(savepointName, 'insertRowBatch');
      throw errorToThrow;
    }

    try {
      // Finalize every statement before committing so cleanup failures still
      // roll back the batch instead of surfacing after durable side effects.
      await this.executeQuery(`RELEASE ${savepointName}`);
    } catch (error) {
      await this.safeRollbackSavepoint(savepointName, 'insertRowBatch');
      throw error;
    }
  }

  /**
   * Delete rows by ID.
   */
  async deleteRows(
    table: string,
    rowIds: RecordId[],
    maxUndoSnapshotBytes?: number
  ): Promise<DeletedRow[]> {
    rowIds.forEach(assertMutableRecordId);
    if (rowIds.length === 0) return [];
    const identity = await this.resolveTableIdentity(table);

    if (rowIds.some(isPrimaryKeyRecordId)) {
      if (!rowIds.every(isPrimaryKeyRecordId)) {
        throw new Error('Cannot mix rowid and primary-key row identities');
      }
      if (identity.kind !== 'primaryKey') {
        throw new Error(`Primary-key identity cannot target rowid table ${table}`);
      }
      const predicates = buildRecordIdentityPredicateChunks(rowIds, identity);
      const savepointName = this.createSavepointName('sp_delete_pk_rows');
      await this.executeQuery(`SAVEPOINT ${savepointName}`);
      try {
        await this.assertDeleteHasNoUntrackedPrograms(table);
        const insertableColumns = await this.getInsertableColumnNames(table);
        if (maxUndoSnapshotBytes !== undefined) {
          this.assertDeleteSnapshotWithinBudget(
            table,
            insertableColumns,
            predicates,
            rowIds,
            false,
            maxUndoSnapshotBytes
          );
        }
        const deletedRows: DeletedRow[] = [];
        for (const predicate of predicates) {
          const current = this.queryRaw(
            `SELECT ${insertableColumns.map(buildStoredCellStateProjection).join(', ')} ` +
            `FROM ${escapeMainIdentifier(table)} WHERE ${predicate.sql}`,
            predicate.params
          );
          const primaryKeyIndices = identity.columns.map(column => {
            const index = insertableColumns.indexOf(column.identifier);
            if (index < 0) throw new Error(`Primary-key column missing from ${table}: ${column.identifier}`);
            return index;
          });
          deletedRows.push(...current.rows.map(row => {
            const states = insertableColumns.map((column, index) => parseStoredCellState(
              row[index * 2],
              row[index * 2 + 1],
              `${table}.${column}`,
              { textEncoding: this.getCellTextEncoding() }
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
          await this.executeQuery(
            `DELETE FROM ${escapeMainIdentifier(table)} WHERE ${predicate.sql}`,
            predicate.params
          );
        }
        await this.executeQuery(`RELEASE ${savepointName}`);
        return deletedRows;
      } catch (error) {
        await this.safeRollbackSavepoint(savepointName, 'deletePrimaryKeyRows');
        throw error;
      }
    }

    if (identity.kind !== 'rowid') {
      throw new Error(`Rowid identity cannot target WITHOUT ROWID table ${table}`);
    }

    // Snapshot and delete rowid rows under one savepoint, matching the PK path.
    const predicates = buildRecordIdentityPredicateChunks(rowIds, identity);
    const savepointName = this.createSavepointName('sp_delete_rowid_rows');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      await this.assertDeleteHasNoUntrackedPrograms(table);
      const insertableColumns = await this.getInsertableColumnNames(table);
      if (maxUndoSnapshotBytes !== undefined) {
        this.assertDeleteSnapshotWithinBudget(
          table,
          insertableColumns,
          predicates,
          rowIds,
          true,
          maxUndoSnapshotBytes
        );
      }
      const deletedRows: DeletedRow[] = [];
      for (const predicate of predicates) {
        const current = this.queryRaw(
          `SELECT CAST(rowid AS TEXT), ` +
          `${insertableColumns.map(buildStoredCellStateProjection).join(', ')} ` +
          `FROM ${escapeMainIdentifier(table)} WHERE ${predicate.sql}`,
          predicate.params
        );
        deletedRows.push(...current.rows.map(row => {
          const rowId = validateRowId(row[0] as RecordId | bigint);
          const states = insertableColumns.map((column, index) => parseStoredCellState(
            row[index * 2 + 1],
            row[index * 2 + 2],
            `${table}.${column}`,
            { textEncoding: this.getCellTextEncoding() }
          ));
          const rowData: Record<string, CellValue> = Object.fromEntries(insertableColumns.map(
            (column, index) => [
              column,
              states[index].rawTextBytes ?? states[index].value
            ]
          ));
          return {
            rowId,
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
        await this.executeQuery(
          `DELETE FROM ${escapeMainIdentifier(table)} WHERE ${predicate.sql}`,
          predicate.params
        );
      }
      await this.executeQuery(`RELEASE ${savepointName}`);
      return deletedRows;
    } catch (error) {
      await this.safeRollbackSavepoint(savepointName, 'deleteRowidRows');
      throw error;
    }
  }

  /**
   * Find indexes that depend on specific columns.
   *
   * @param table - Table name
   * @param columns - Column names to check
   * @returns Array of index names that reference any of the columns
   */
  async findDependentIndexes(table: string, columns: string[]): Promise<string[]> {
    const indexQuery = `
      SELECT name, sql FROM main.sqlite_master
      WHERE type = 'index'
        AND tbl_name = ?
        AND sql IS NOT NULL
    `;
    const indexResult = await this.executeQuery(indexQuery, [table]);
    const indexes = (indexResult[0]?.rows ?? []).map(row => ({
      name: row[0] as string,
      sql: row[1] as string
    }));
    if (indexes.length === 0 || columns.length === 0) return [];

    const tableInfo = await this.executeQuery(
      `PRAGMA main.table_xinfo(${escapeIdentifier(table)})`
    );
    const tableColumns = (tableInfo[0]?.rows ?? []).map(row => row[1] as string);
    const targetColumns = resolveIndexDependencyColumns(tableColumns, columns);
    if (targetColumns.length === 0) return [];
    const suffix = crypto.randomUUID().replace(/-/g, '');
    const probeTable = `__sqlite_explorer_index_probe_${suffix}`;
    const probeIndex = `__sqlite_explorer_index_candidate_${suffix}`;
    const savepointName = this.createSavepointName('sp_index_dependencies');

    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      await this.executeQuery(
        buildIndexDependencyProbeTableSql(probeTable, tableColumns)
      );
      const baselineSavepoint = this.createSavepointName('sp_index_baseline');
      await this.executeQuery(`SAVEPOINT ${baselineSavepoint}`);
      try {
        for (const column of targetColumns) {
          await this.executeQuery(
            `ALTER TABLE temp.${escapeIdentifier(probeTable)} `
            + `DROP COLUMN ${escapeIdentifier(column)}`
          );
        }
        await this.executeQuery(`ROLLBACK TO ${baselineSavepoint}`);
        await this.executeQuery(`RELEASE ${baselineSavepoint}`);
      } catch (error) {
        await this.safeRollbackSavepoint(baselineSavepoint, 'findDependentIndexBaseline');
        throw new Error('Cannot establish the index dependency probe baseline', { cause: error });
      }

      const dependentIndexes: string[] = [];
      for (const index of indexes) {
        const candidateSavepoint = this.createSavepointName('sp_index_candidate');
        await this.executeQuery(`SAVEPOINT ${candidateSavepoint}`);
        try {
          await this.executeQuery(buildIndexDependencyProbeIndexSql(
            probeTable,
            probeIndex,
            index.sql
          ));
          let isDependent = false;
          for (const column of targetColumns) {
            try {
              await this.executeQuery(
                `ALTER TABLE temp.${escapeIdentifier(probeTable)} `
                + `DROP COLUMN ${escapeIdentifier(column)}`
              );
            } catch {
              isDependent = true;
              break;
            }
          }
          await this.executeQuery(`ROLLBACK TO ${candidateSavepoint}`);
          await this.executeQuery(`RELEASE ${candidateSavepoint}`);
          if (isDependent) dependentIndexes.push(index.name);
        } catch (error) {
          await this.safeRollbackSavepoint(candidateSavepoint, 'findDependentIndex');
          throw new Error(
            `Cannot inspect dependency for index ${escapeIdentifier(index.name)}`,
            { cause: error }
          );
        }
      }

      await this.executeQuery(`ROLLBACK TO ${savepointName}`);
      await this.executeQuery(`RELEASE ${savepointName}`);
      return dependentIndexes;
    } catch (error) {
      await this.safeRollbackSavepoint(savepointName, 'findDependentIndexes');
      throw error;
    }
  }

  /**
   * Delete columns by name.
   *
   * If dropDependentIndexes is provided, those indexes will be dropped first.
   * Otherwise, deletion may fail if indexes reference the columns.
   *
   * @param table - Table name
   * @param columns - Column names to delete
   * @param dropDependentIndexes - Optional list of indexes to drop first
   */
  async deleteColumns(
    table: string,
    columns: string[],
    dropDependentIndexes?: string[],
    expectedCurrentState?: ColumnDropTableState
  ): Promise<ColumnDropTableState> {
    if (columns.length === 0) return this.readColumnDropTableState(table);

    // Use a SAVEPOINT so column drops remain atomic on their own and can also
    // participate in the outer hot-exit restore transaction.
    const savepointName = this.createSavepointName('sp_delete_columns');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      if (expectedCurrentState) {
        const current = await this.readColumnDropTableState(table);
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
          await this.executeQuery(sql);
        }
      );
      // Capture the exact undo guard while the DDL is still rollbackable.
      const stateAfter = await this.readColumnDropTableState(table);
      await this.executeQuery(`RELEASE ${savepointName}`);
      return stateAfter;
    } catch (e) {
      await this.safeRollbackSavepoint(savepointName, 'deleteColumns');
      throw e;
    }
  }

  /**
   * Helper to resolve wildcard columns to explicit column names when using global filter.
   */
  private async resolveQueryColumns(table: string, columns: string[] | undefined, globalFilter: string | undefined): Promise<string[] | undefined> {
    if (globalFilter && (!columns || (columns.length === 1 && columns[0] === '*'))) {
      const tableInfo = await this.getTableInfo(table);
      return tableInfo.map(c => c.identifier);
    }
    return columns;
  }

  /** Discover table identity while allowing callers that also read views. */
  private async findTableIdentity(table: string): Promise<TableIdentity | undefined> {
    const metadata = await this.executeQuery(
      `SELECT "type", "wr" FROM pragma.pragma_table_list ` +
      `WHERE "schema" = 'main' AND "name" = ? LIMIT 1`,
      [table]
    );
    if ((metadata[0]?.rows.length ?? 0) === 0) return undefined;
    const kind = classifyTableIdentity(metadata[0].rows[0][0], metadata[0].rows[0][1]);
    if (!kind) return undefined;
    if (kind === 'rowid') return { kind: 'rowid' };

    const columns = primaryKeyColumnsFromTableInfo(await this.getTableInfo(table));
    if (columns.length === 0) {
      throw new Error(`WITHOUT ROWID table ${table} has no declared primary key`);
    }
    return { kind: 'primaryKey', columns };
  }

  /** Resolve the declared identity without trusting a client-supplied PK token. */
  private async resolveTableIdentity(table: string): Promise<TableIdentity> {
    const identity = await this.findTableIdentity(table);
    if (!identity) throw new Error(`Table not found: ${table}`);
    if (identity.kind === 'rowid') {
      const authority = await this.executeQuery(ROWID_TABLE_AUTHORITY_SQL, [table, table]);
      if ((authority[0]?.rows.length ?? 0) !== 1) {
        throw new Error(
          `Table ${table} is read-only because a declared "rowid" column ` +
          `shadows SQLite's intrinsic row identity`
        );
      }
    }
    return identity;
  }

  /** Read rows with sql.js BigInt transport retained for identity/history. */
  private queryRaw(sql: string, params: readonly CellValue[] = []): {
    headers: string[];
    rows: Array<Array<CellValue | bigint>>;
  } {
    const statement = this.instance.prepare(sql, normalizeWasmBindParams(params));
    try {
      const headers = statement.getColumnNames();
      const rows: Array<Array<CellValue | bigint>> = [];
      while (statement.step()) {
        const row = statement.get(null, { useBigInt: true });
        if (row) rows.push(row);
      }
      return { headers, rows };
    } finally {
      statement.free();
    }
  }

  private readChangesCount(): number {
    const raw = this.queryRaw('SELECT changes()').rows[0]?.[0];
    const changes = typeof raw === 'bigint' ? Number(raw) : raw;
    if (!Number.isSafeInteger(changes) || Number(changes) < 0) {
      throw new Error('SQLite returned an invalid changes() count');
    }
    return Number(changes);
  }

  private async assertCellPriorWithinEditLimit(
    table: string,
    rowId: RecordId,
    column: string,
    editLimitBytes: number
  ): Promise<void> {
    const metadata = await this.getCellMetadata({ table, rowId, column });
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
  }

  private async assertBatchPriorsWithinEditLimit(
    table: string,
    updates: readonly CellUpdate[],
    editLimitBytes: number
  ): Promise<void> {
    const seen = new Set<string>();
    for (const update of updates) {
      const key = `${String(update.rowId)}\0${update.column}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await this.assertCellPriorWithinEditLimit(
        table,
        update.rowId,
        update.column,
        editLimitBytes
      );
    }
  }

  private async assertRowIdBatchPriorsWithinEditLimit(
    table: string,
    updates: readonly CellUpdate[],
    editLimitBytes: number
  ): Promise<void> {
    const queries = buildBatchPriorLimitQueries(table, updates, editLimitBytes);
    for (const query of queries) {
      const result = await this.executeQuery(query.sql, query.params);
      assertBatchPriorLimitResult(
        table,
        query,
        result[0]?.rows ?? [],
        editLimitBytes
      );
    }
  }

  private async assertBatchHistoryWithinBudget(
    table: string,
    updates: readonly CellUpdate[],
    identity: TableIdentity,
    maxPriorValueBytes: number
  ): Promise<void> {
    const preflight = buildBatchHistorySizePreflight(table, updates, identity);
    const resultRows: Array<readonly unknown[] | undefined> = [];
    for (const query of preflight.queries) {
      const result = await this.executeQuery(query.sql, query.params);
      resultRows.push(result[0]?.rows[0]);
    }
    assertBatchHistoryFitsUndoBudget({
      table,
      preflight,
      resultRows,
      maxPriorValueBytes
    });
  }

  /** Columns SQLite permits in an INSERT; generated columns have hidden 2/3. */
  private async getInsertableColumnNames(table: string): Promise<string[]> {
    const result = await this.executeQuery(
      "SELECT name FROM pragma.pragma_table_xinfo(?, 'main') " +
      'WHERE hidden NOT IN (2, 3) ORDER BY cid',
      [table]
    );
    return (result[0]?.rows ?? []).map(row => {
      if (typeof row[0] !== 'string') {
        throw new Error(`SQLite returned invalid column metadata for ${table}`);
      }
      return row[0];
    });
  }

  private assertDeleteSnapshotWithinBudget(
    table: string,
    insertableColumns: readonly string[],
    predicates: ReturnType<typeof buildRecordIdentityPredicateChunks>,
    rowIds: readonly RecordId[],
    includeSyntheticRowId: boolean,
    maxSnapshotBytes: number,
    operation: 'Delete' | 'Insert' = 'Delete'
  ): void {
    const valueColumns = deleteSnapshotValueColumns(
      insertableColumns,
      includeSyntheticRowId
    );
    let rowCount = 0;
    let valueBytes = 0;
    for (const predicate of predicates) {
      const query = buildDeleteSnapshotSizeQuery(table, valueColumns, predicate);
      const result = this.queryRaw(query.sql, query.params);
      const chunk = parseDeleteSnapshotSizeRow(result.rows[0]);
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
  }

  private readRowHistorySnapshot(
    table: string,
    identity: TableIdentity,
    rowId: RecordId,
    insertableColumns: readonly string[]
  ): DeletedRow {
    const predicate = buildRecordIdentityPredicate(rowId, identity);
    const projections = insertableColumns.map(buildStoredCellStateProjection);
    const result = this.queryRaw(
      `SELECT ${projections.join(', ')} FROM ${escapeMainIdentifier(table)} ` +
      `WHERE ${predicate.sql} LIMIT 2`,
      predicate.params
    );
    if (result.rows.length !== 1) throw new RowHistoryConflictError(table);
    const states = insertableColumns.map((column, index) => parseStoredCellState(
      result.rows[0][index * 2],
      result.rows[0][index * 2 + 1],
      `${table}.${column}`,
      { textEncoding: this.getCellTextEncoding() }
    ));
    const row = Object.fromEntries(insertableColumns.map(
      (column, index) => [
        column,
        states[index].rawTextBytes ?? states[index].value
      ]
    ));
    return {
      rowId,
      row,
      storageClasses: insertableColumns.map((column, index) => ({
        column,
        storageClass: states[index].storageClass
      }))
    };
  }

  private async captureInsertedRowHistory(
    table: string,
    identity: TableIdentity,
    rowId: RecordId,
    maxUndoSnapshotBytes?: number
  ): Promise<DeletedRow> {
    const insertableColumns = await this.getInsertableColumnNames(table);
    if (maxUndoSnapshotBytes !== undefined) {
      this.assertDeleteSnapshotWithinBudget(
        table,
        insertableColumns,
        [buildRecordIdentityPredicate(rowId, identity)],
        [rowId],
        identity.kind === 'rowid',
        maxUndoSnapshotBytes,
        'Insert'
      );
    }
    return this.readRowHistorySnapshot(table, identity, rowId, insertableColumns);
  }

  private readPrimaryKeyRecordId(
    table: string,
    identity: Extract<TableIdentity, { kind: 'primaryKey' }>,
    predicate: { sql: string; params: CellValue[] },
    missingRowError?: Error
  ): RecordId {
    const result = this.queryRaw(
      `SELECT ${buildByteFaithfulPrimaryKeyProjection(identity)} ` +
      `FROM ${escapeMainIdentifier(table)} WHERE ${predicate.sql} LIMIT 2`,
      predicate.params
    );
    if (result.rows.length === 0) {
      throw missingRowError ?? new Error(`Updated row in ${table} no longer exists`);
    }
    if (result.rows.length !== 1) {
      throw new Error(`Primary-key identity for ${table} matched more than one row`);
    }
    return encodeByteFaithfulPrimaryKeyRecordId(
      identity,
      result.rows[0],
      this.getCellTextEncoding(),
      `Cannot resolve updated identity in ${table}`
    );
  }

  private async readRowIdAliasColumn(table: string): Promise<string | undefined> {
    const result = await this.executeQuery(ROWID_ALIAS_COLUMN_SQL, [table]);
    return parseRowIdAliasColumn(result[0]?.rows ?? [], table);
  }

  private async assertUpdateHasNoTargetTableTriggerWrites(
    table: string,
    columns: readonly string[],
    hasIntrinsicRowId: boolean = true
  ): Promise<void> {
    const rootPageResult = await this.executeQuery(MAIN_TABLE_ROOT_PAGE_SQL, [table]);
    const rootPage = parseMainTableRootPage(rootPageResult[0]?.rows ?? [], table);
    const result = await this.executeQuery(
      buildUpdateTriggerProbeSql(table, columns, hasIntrinsicRowId),
      hasIntrinsicRowId ? [0] : []
    );
    assertNoApplicableUpdateTriggerTargetWrites(
      table,
      rootPage,
      result[0]?.rows ?? [],
      hasIntrinsicRowId ? 'rowid' : 'primary-key'
    );
  }

  private async assertInsertHasNoUntrackedPrograms(
    table: string,
    columns: readonly string[]
  ): Promise<void> {
    const result = await this.executeQuery(buildInsertTriggerProbeSql(table, columns));
    assertNoUntrackedMutationPrograms('INSERT', table, result[0]?.rows ?? []);
  }

  private async assertDeleteHasNoUntrackedPrograms(table: string): Promise<void> {
    const result = await this.executeQuery(buildDeleteTriggerProbeSql(table));
    assertNoUntrackedMutationPrograms('DELETE', table, result[0]?.rows ?? []);
  }

  /** Resolve the post-update rowid while the caller's savepoint is still open. */
  private readUpdatedRowId(
    table: string,
    aliasColumn: string | undefined,
    previousRowId: RecordId,
    updatedColumn: string | undefined,
    updatedValue: CellValue | undefined
  ): RecordId {
    const aliasWasUpdated = aliasColumn !== undefined
      && updatedColumn !== undefined
      && sqliteIdentifiersEqual(aliasColumn, updatedColumn);
    const predicateColumn = aliasWasUpdated ? escapeIdentifier(aliasColumn) : 'rowid';
    const candidate = aliasWasUpdated ? updatedValue : previousRowId;
    const result = this.queryRaw(
      `SELECT CAST(rowid AS TEXT) FROM ${escapeMainIdentifier(table)} ` +
      `WHERE ${predicateColumn} = ? LIMIT 2`,
      [candidate ?? null]
    );
    if (result.rows.length === 0) {
      throw unresolvableTriggeredRowIdUpdateError(table);
    }
    if (result.rows.length !== 1) {
      throw new Error(`Rowid identity for ${table} matched more than one row`);
    }
    return validateRowId(result.rows[0][0] as RecordId);
  }

  /** Preserve per-cell UPDATE semantics while carrying a changed rowid forward. */
  private async updateRowIdAliasCellBatchWithinSavepoint(
    table: string,
    aliasColumn: string,
    updates: CellUpdate[],
    editLimitBytes: number,
    isHistoryReplay: boolean
  ): Promise<CellUpdateResult[]> {
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
      const current = this.queryRaw(
        `SELECT ${columns.map(buildStoredCellStateProjection).join(', ')} ` +
        `FROM ${escapeMainIdentifier(table)} WHERE rowid = ? LIMIT 2`,
        [rowId]
      );
      if (current.rows.length !== 1) {
        throw new Error(`Cannot update ${table}: row identity no longer exists`);
      }

      const preparedUpdates = rowUpdates.map((update, index) => {
        const priorState = parseStoredCellState(
          current.rows[0][index * 2],
          current.rows[0][index * 2 + 1],
          `${table}.${update.column}`,
          { textEncoding: this.getCellTextEncoding() }
        );
        const priorValue = priorState.value;
        const prepared = prepareCellUpdateForStorage(
          update.value,
          priorValue,
          update.operation ?? 'set'
        );
        const storedValue = prepared.operation === 'json_patch'
          ? this.applyJsonPatchValue(priorValue, prepared.value)
          : prepared.value;
        if (!isHistoryReplay && prepared.operation === 'json_patch') {
          assertCellValueWithinEditLimit(storedValue, editLimitBytes);
        }
        return { update, priorValue, priorState, prepared, storedValue };
      });
      let newRowId = rowId;
      for (const preparedUpdate of preparedUpdates) {
        const escapedColumn = escapeIdentifier(preparedUpdate.update.column);
        const useNativePatch = preparedUpdate.prepared.operation === 'json_patch'
          && this.hasJsonPatch;
        const storedBindValue = useNativePatch
          ? (typeof preparedUpdate.prepared.value === 'string'
              ? preparedUpdate.prepared.value
              : JSON.stringify(preparedUpdate.prepared.value))
          : preparedUpdate.storedValue;
        const expression = useNativePatch
          ? `json_patch(COALESCE(${escapedColumn}, '{}'), ?)`
          : wasmBindPlaceholder(preparedUpdate.storedValue);
        await this.executeQuery(
          `UPDATE ${escapeMainIdentifier(table)} SET ${escapedColumn} = ${expression} ` +
          'WHERE rowid = ?',
          [storedBindValue, newRowId]
        );
        if (this.readChangesCount() !== 1) {
          throw new Error(`Cannot update ${table}: row identity no longer exists`);
        }
        newRowId = this.readUpdatedRowId(
          table,
          aliasColumn,
          newRowId,
          preparedUpdate.update.column,
          preparedUpdate.storedValue
        );
      }
      const post = this.queryRaw(
        `SELECT ${columns.map(buildStoredCellStateProjection).join(', ')} ` +
        `FROM ${escapeMainIdentifier(table)} WHERE rowid = ? LIMIT 2`,
        [newRowId]
      );
      if (post.rows.length !== 1) {
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
            post.rows[0][index * 2],
            post.rows[0][index * 2 + 1],
            `${table}.${preparedUpdate.update.column}`,
            { textEncoding: this.getCellTextEncoding() }
          ),
          operation: preparedUpdate.prepared.operation
        });
      }
    }
    return results;
  }

  private applyJsonPatchValue(currentValue: CellValue, patch: CellValue): string {
    if (this.hasJsonPatch) {
      const patchText = typeof patch === 'string' ? patch : JSON.stringify(patch);
      const value = this.queryRaw(
        `SELECT json_patch(COALESCE(?, '{}'), ?)`,
        [currentValue, patchText]
      ).rows[0]?.[0];
      if (typeof value !== 'string') {
        throw new Error('SQLite returned an invalid json_patch result');
      }
      return value;
    }
    const currentObject = parseJsonValueForPatching(currentValue, 'updateCellBatch');
    const patchObject = typeof patch === 'string' ? JSON.parse(patch) : patch;
    return JSON.stringify(applyMergePatch(currentObject, patchObject));
  }

  /** PK batches update each row once so changing any key member cannot stale later writes. */
  private async updatePrimaryKeyCellBatch(
    table: string,
    identity: Extract<TableIdentity, { kind: 'primaryKey' }>,
    updates: CellUpdate[],
    maxEditValueBytes?: number,
    historyReplayToken?: typeof HISTORY_REPLAY_EDIT_TOKEN
  ): Promise<CellUpdateResult[]> {
    const isHistoryReplay = historyReplayToken === HISTORY_REPLAY_EDIT_TOKEN;
    const editLimitBytes = isHistoryReplay
      ? 0
      : assertCellValuesWithinEditLimit(
          updates.map(update => update.value),
          maxEditValueBytes
        );
    const savepointName = this.createSavepointName('sp_update_pk_batch');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      await this.assertUpdateHasNoTargetTableTriggerWrites(
        table,
        updates.map(update => update.column),
        false
      );
      // Metadata-only preflight must run before the established full prior-value
      // SELECT below. Normal bounded edits retain the same SAVEPOINT and update path.
      if (!isHistoryReplay && maxEditValueBytes !== undefined) {
        await this.assertBatchPriorsWithinEditLimit(table, updates, editLimitBytes);
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
        const current = this.queryRaw(
          `SELECT ${columns.map(buildStoredCellStateProjection).join(', ')} ` +
          `FROM ${escapeMainIdentifier(table)} WHERE ${oldPredicate.sql} LIMIT 2`,
          oldPredicate.params
        );
        if (current.rows.length !== 1) {
          throw new Error(`Cannot update ${table}: row identity no longer exists`);
        }

        const preparedUpdates = rowUpdates.map((update, index) => {
          const priorState = parseStoredCellState(
            current.rows[0][index * 2],
            current.rows[0][index * 2 + 1],
            `${table}.${update.column}`,
            { textEncoding: this.getCellTextEncoding() }
          );
          const priorValue = priorState.value;
          const prepared = prepareCellUpdateForStorage(
            update.value,
            priorValue,
            update.operation ?? 'set'
          );
          const storedValue = prepared.operation === 'json_patch'
            ? this.applyJsonPatchValue(priorValue, prepared.value)
            : prepared.value;
          if (!isHistoryReplay && prepared.operation === 'json_patch') {
            // A bounded merge-patch can still create an oversized stored value.
            // Validate the result while the row is still protected by the savepoint.
            assertCellValueWithinEditLimit(storedValue, editLimitBytes);
          }
          return { update, priorValue, priorState, prepared, storedValue };
        });

        const setClause = preparedUpdates.map(({ update, storedValue }) => (
          `${escapeIdentifier(update.column)} = ${wasmBindPlaceholder(storedValue)}`
        )).join(', ');
        await this.executeQuery(
          `UPDATE ${escapeMainIdentifier(table)} SET ${setClause} WHERE ${oldPredicate.sql}`,
          [
            ...preparedUpdates.map(update => update.storedValue),
            ...oldPredicate.params
          ]
        );
        if (this.readChangesCount() !== 1) {
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
        const newRowId = this.readPrimaryKeyRecordId(
          table,
          identity,
          buildRecordIdentityPredicate(candidateId, identity),
          unresolvableTriggeredPrimaryKeyUpdateError(table)
        );
        const newPredicate = buildRecordIdentityPredicate(newRowId, identity);
        const post = this.queryRaw(
          `SELECT ${columns.map(buildStoredCellStateProjection).join(', ')} ` +
          `FROM ${escapeMainIdentifier(table)} WHERE ${newPredicate.sql} LIMIT 2`,
          newPredicate.params
        );
        if (post.rows.length !== 1) {
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
              post.rows[0][index * 2],
              post.rows[0][index * 2 + 1],
              `${table}.${preparedUpdate.update.column}`,
              { textEncoding: this.getCellTextEncoding() }
            ),
            operation: preparedUpdate.prepared.operation
          });
        }
      }

      await this.executeQuery(`RELEASE ${savepointName}`);
      return results;
    } catch (error) {
      await this.safeRollbackSavepoint(savepointName, 'updatePrimaryKeyCellBatch');
      throw error;
    }
  }

  /**
   * Create a new table.
   */
  async createTable(
    table: string,
    columns: ColumnDefinition[]
  ): Promise<ColumnDropTableState> {
    const sql = buildCreateTableSql(table, columns);
    const savepointName = this.createSavepointName('sp_create_table');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      const dependenciesBefore = await this.captureViewDependencySnapshot();
      await this.executeQuery(sql);
      assertNoNewBrokenSchemaDependencies(
        dependenciesBefore,
        await this.captureViewDependencySnapshot()
      );
      const stateAfter = await this.readColumnDropTableState(table);
      await this.executeQuery(`RELEASE ${savepointName}`);
      return stateAfter;
    } catch (error) {
      await this.safeRollbackSavepoint(savepointName, 'createTable');
      throw error;
    }
  }

  /** Read a view and every INSTEAD OF trigger SQLite associates with it. */
  private async findViewDefinition(
    view: string,
    allowUnparsed: boolean
  ): Promise<ViewDefinition | null> {
    const viewResult = await this.executeQuery(
      "SELECT sql FROM main.sqlite_schema WHERE type = 'view' AND name = ?",
      [view]
    );
    const createSql = viewResult[0]?.rows[0]?.[0];
    if (typeof createSql !== 'string') {
      return null;
    }

    const triggerRows: CellValue[][][] = [];
    for (const source of VIEW_TRIGGER_SCHEMA_QUERIES) {
      const result = await this.executeQuery(source.sql, source.params(view));
      triggerRows.push(result[0]?.rows ?? []);
    }
    const {
      triggers,
      ambiguousTemporaryTriggerNames,
      unqualifiedTemporaryTriggers
    } = mapViewTriggerRows(
      view,
      triggerRows
    );
    if (unqualifiedTemporaryTriggers.length > 0) {
      const columnsResult = await this.executeQuery(
        "SELECT name FROM pragma.pragma_table_xinfo(?, 'main') ORDER BY cid",
        [view]
      );
      const writableColumns = (columnsResult[0]?.rows ?? []).map(row => {
        if (typeof row[0] !== 'string') {
          throw new Error(`SQLite returned invalid view column metadata for ${view}`);
        }
        return row[0];
      });
      for (const trigger of unqualifiedTemporaryTriggers) {
        // A same-named persistent trigger makes EXPLAIN's program marker
        // schema-ambiguous even if the DML itself compiles.
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
          const probe = await this.executeQuery(validationSql);
          if (explainIncludesTriggerProgram(probe[0]?.rows ?? [], trigger.identifier)) {
            triggers.push({
              ...trigger,
              sql: qualifyMainTriggerTargetSql(trigger.sql, trigger.identifier)
            });
          }
        } catch {
          // Failure to compile may be caused by the candidate main trigger or
          // by another broken program. Either way ownership is not provable.
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
      // Dropping depends only on the schema object name. Preserve opaque raw SQL
      // for history and let SQLite remain authoritative if it is replayed.
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
  }

  private async readViewDefinition(view: string, allowUnparsed: boolean): Promise<ViewDefinition> {
    const definition = await this.findViewDefinition(view, allowUnparsed);
    if (!definition) throw new Error(`View not found: ${view}`);
    return definition;
  }

  async getViewDefinition(view: string): Promise<ViewDefinition> {
    return this.readViewDefinition(view, false);
  }

  /** Snapshot schema validity on this connection and therefore in the caller's savepoint. */
  private captureViewDependencySnapshot(): Promise<SchemaDependencySnapshot> {
    return captureSchemaDependencySnapshot({
      queryRows: async (sql, params) => (
        (await this.executeQuery(sql, params))[0]?.rows ?? []
      ),
      compileStatements: async statements => statements.map(sql => {
        try {
          this.compileSingleStatement(sql);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      })
    });
  }

  /** Resolve the installed view state once so validate and preview enforce identical intent rules. */
  private async resolveExistingViewForIntent(
    view: string,
    intent: ViewDefinitionIntent
  ): Promise<ExistingViewForIntent> {
    const result = await this.executeQuery(
      "SELECT sql FROM main.sqlite_schema WHERE type = 'view' AND name = ?",
      [view]
    );
    const row = result[0]?.rows[0];
    assertViewDefinitionIntent(view, row !== undefined, intent);
    const storedSql = row?.[0];
    return {
      storedSql,
      columnListSql: typeof storedSql === 'string'
        ? extractViewColumnListSql(storedSql)
        : undefined
    };
  }

  async validateViewDefinition(
    view: string,
    selectSql: string,
    intent: ViewDefinitionIntent = 'edit'
  ): Promise<void> {
    assertUsableSqlIdentifier(view, 'View name');
    if (this.readOnlyMode) {
      throw new Error('View validation is unavailable because the database is read-only');
    }
    const body = normalizeViewSelectSql(selectSql);
    const { storedSql: existingSql, columnListSql } =
      await this.resolveExistingViewForIntent(view, intent);
    const savepointName = this.createSavepointName('sp_validate_view');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      const dependenciesBefore = await this.captureViewDependencySnapshot();
      if (typeof existingSql === 'string') {
        this.runSingleStatement(`DROP VIEW ${escapeMainViewIdentifier(view)}`);
      }
      this.runSingleStatement(buildCreateViewSql(view, body, columnListSql));
      this.compileSingleStatement(`EXPLAIN SELECT * FROM ${escapeMainViewIdentifier(view)}`);
      assertNoNewBrokenSchemaDependencies(
        dependenciesBefore,
        await this.captureViewDependencySnapshot()
      );
      // Successful validation is deliberately non-mutating.
      await this.executeQuery(`ROLLBACK TO ${savepointName}`);
      await this.executeQuery(`RELEASE ${savepointName}`);
    } catch (err) {
      await this.safeRollbackSavepoint(savepointName, 'validateViewDefinition');
      throw normalizeViewDefinitionError(err, view, body);
    }
  }

  async previewViewDefinition(
    view: string,
    selectSql: string,
    limit: number = 50,
    intent: ViewDefinitionIntent = 'edit',
    cancellation?: WasmQueryCancellation
  ): Promise<QueryResultSet> {
    assertUsableSqlIdentifier(view, 'View name');
    const body = normalizeViewSelectSql(selectSql);
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 50));
    const { storedSql: existingSql, columnListSql } =
      await this.resolveExistingViewForIntent(view, intent);

    if (this.readOnlyMode) {
      // Read-only documents cannot run disposable schema DDL. A target-named
      // CTE still shadows ordinary unqualified references to the installed
      // view and preserves explicit output names; writable previews below use
      // the exact CREATE VIEW context and also catch schema-qualified cycles.
      const previewSource = escapeIdentifier(view);
      if (columnListSql) {
        return this.executeSingleQuery(
          `WITH ${previewSource} ${columnListSql} AS (${body}\n) ` +
          `SELECT * FROM ${previewSource} LIMIT ${boundedLimit}`,
          cancellation
        );
      }
      return this.executeSingleQuery(
        `WITH ${previewSource} AS (${body}\n) ` +
        `SELECT * FROM ${previewSource} LIMIT ${boundedLimit}`,
        cancellation
      );
    }

    const savepointName = this.createSavepointName('sp_preview_view');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      const dependenciesBefore = await this.captureViewDependencySnapshot();
      if (typeof existingSql === 'string') {
        this.runSingleStatement(`DROP VIEW ${escapeMainViewIdentifier(view)}`);
      }
      this.runSingleStatement(buildCreateViewSql(view, body, columnListSql));
      this.compileSingleStatement(`EXPLAIN SELECT * FROM ${escapeMainViewIdentifier(view)}`);
      assertNoNewBrokenSchemaDependencies(
        dependenciesBefore,
        await this.captureViewDependencySnapshot()
      );
      const result = this.executeSingleQuery(
        `SELECT * FROM ${escapeMainViewIdentifier(view)} LIMIT ${boundedLimit}`,
        cancellation
      );
      await this.executeQuery(`ROLLBACK TO ${savepointName}`);
      await this.executeQuery(`RELEASE ${savepointName}`);
      return result;
    } catch (err) {
      await this.safeRollbackSavepoint(savepointName, 'previewViewDefinition');
      throw normalizeViewDefinitionError(err, view, body);
    }
  }

  async createView(view: string, selectSql: string): Promise<ViewDefinition> {
    assertUsableSqlIdentifier(view, 'View name');
    this.assertWritableMutation('View creation');
    const body = normalizeViewSelectSql(selectSql);
    const savepointName = this.createSavepointName('sp_create_view');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      const dependenciesBefore = await this.captureViewDependencySnapshot();
      this.runSingleStatement(buildCreateViewSql(view, body));
      this.compileSingleStatement(`EXPLAIN SELECT * FROM ${escapeMainViewIdentifier(view)}`);
      assertNoNewBrokenSchemaDependencies(
        dependenciesBefore,
        await this.captureViewDependencySnapshot()
      );
      const definition = await this.getViewDefinition(view);
      await this.executeQuery(`RELEASE ${savepointName}`);
      return definition;
    } catch (err) {
      await this.safeRollbackSavepoint(savepointName, 'createView');
      throw err;
    }
  }

  async editView(
    view: string,
    selectSql: string,
    preserveTriggers: boolean = true,
    expectedSql?: string,
    expectedTriggers?: readonly ViewTriggerDefinition[]
  ): Promise<ViewEditResult> {
    this.assertWritableMutation('View editing');
    const body = normalizeViewSelectSql(selectSql);
    const savepointName = this.createSavepointName('sp_edit_view');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      // Read and compare after opening the savepoint. That read transaction
      // prevents a stale editor snapshot from being silently overwritten even
      // when another connection races between the UI check and this mutation.
      const before = await this.getViewDefinition(view);
      assertViewTriggerSnapshotIsMutationSafe(before);
      assertViewDefinitionSnapshotCurrent(
        expectedSql,
        before.sql,
        expectedTriggers,
        before.triggers
      );
      const dependenciesBefore = await this.captureViewDependencySnapshot();
      this.runSingleStatement(`DROP VIEW ${escapeMainViewIdentifier(view)}`);
      this.runSingleStatement(buildCreateViewSql(view, body, before.columnListSql, before.columns));
      this.compileSingleStatement(`EXPLAIN SELECT * FROM ${escapeMainViewIdentifier(view)}`);
      if (preserveTriggers) {
        const columnResult = await this.executeQuery(
          `PRAGMA main.table_info(${escapeIdentifier(view)})`
        );
        const columns = (columnResult[0]?.rows ?? []).map(row => {
          if (typeof row[1] !== 'string') {
            throw new Error(`SQLite returned invalid column metadata for view ${view}`);
          }
          return row[1];
        });
        assertViewTriggersCompatibleWithColumns(before.triggers, columns);
        for (const trigger of before.triggers) {
          this.runSingleStatement(buildCreateViewTriggerSql(trigger));
        }
      }
      const after = await this.getViewDefinition(view);
      assertNoNewBrokenSchemaDependencies(
        dependenciesBefore,
        await this.captureViewDependencySnapshot()
      );
      await this.executeQuery(`RELEASE ${savepointName}`);
      return { before, after };
    } catch (err) {
      await this.safeRollbackSavepoint(savepointName, 'editView');
      throw err;
    }
  }

  async dropView(
    view: string,
    expectedSql?: string,
    expectedTriggers?: readonly ViewTriggerDefinition[]
  ): Promise<ViewDefinition> {
    this.assertWritableMutation('View deletion');
    const savepointName = this.createSavepointName('sp_drop_view');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      const before = await this.readViewDefinition(view, true);
      assertViewTriggerSnapshotIsMutationSafe(before);
      assertViewDefinitionSnapshotCurrent(
        expectedSql,
        before.sql,
        expectedTriggers,
        before.triggers
      );
      const dependenciesBefore = await this.captureViewDependencySnapshot();
      this.runSingleStatement(`DROP VIEW ${escapeMainViewIdentifier(view)}`);
      assertNoNewBrokenSchemaDependencies(
        dependenciesBefore,
        await this.captureViewDependencySnapshot()
      );
      await this.executeQuery(`RELEASE ${savepointName}`);
      return before;
    } catch (err) {
      await this.safeRollbackSavepoint(savepointName, 'dropView');
      throw err;
    }
  }

  private assertWritableMutation(operation: string): void {
    if (this.readOnlyMode) {
      throw new Error(`${operation} is unavailable because the database is read-only`);
    }
  }

  /** Atomically apply one tracked view-state transition for undo, redo, or hot exit. */
  private async applyViewHistoryState(
    view: string,
    expectedCurrent: ViewDefinition | null,
    replacement: ViewDefinition | null
  ): Promise<void> {
    const savepointName = this.createSavepointName('sp_restore_view');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      const current = await this.findViewDefinition(view, true);
      if (current) assertViewTriggerSnapshotIsMutationSafe(current);
      assertViewDefinitionStateCurrent(expectedCurrent, current);
      const dependenciesBefore = await this.captureViewDependencySnapshot();
      if (current) {
        this.runSingleStatement(`DROP VIEW ${escapeMainViewIdentifier(view)}`);
      }
      if (replacement) {
        this.runSingleStatement(replacement.sql);
        this.compileSingleStatement(
          `EXPLAIN SELECT * FROM ${escapeMainViewIdentifier(replacement.identifier)}`
        );
        for (const trigger of replacement.triggers) {
          this.runSingleStatement(buildCreateViewTriggerSql(trigger));
        }
      }
      assertNoNewBrokenSchemaDependencies(
        dependenciesBefore,
        await this.captureViewDependencySnapshot()
      );
      await this.executeQuery(`RELEASE ${savepointName}`);
    } catch (err) {
      await this.safeRollbackSavepoint(savepointName, 'restoreViewDefinition');
      throw err;
    }
  }

  /**
   * Update multiple cells in a batch.
   */
  async updateCellBatch(
    table: string,
    updates: CellUpdate[],
    maxEditValueBytes?: number,
    maxUndoSnapshotBytes?: number,
    historyReplayToken?: typeof HISTORY_REPLAY_EDIT_TOKEN
  ): Promise<CellUpdateResult[]> {
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
      const identity = await this.resolveTableIdentity(table);
      if (identity.kind !== 'primaryKey') {
        throw new Error(`Primary-key identity cannot target rowid table ${table}`);
      }
      assertUniqueCellUpdateTargets(updates, identity);
      if (!isHistoryReplay && maxUndoSnapshotBytes !== undefined) {
        await this.assertBatchHistoryWithinBudget(
          table,
          updates,
          identity,
          maxUndoSnapshotBytes
        );
      }
      return this.updatePrimaryKeyCellBatch(
        table,
        identity,
        updates,
        maxEditValueBytes,
        historyReplayToken
      );
    }

    const rowIdIdentity = await this.resolveTableIdentity(table);
    if (rowIdIdentity.kind !== 'rowid') {
      throw new Error(`Rowid identity cannot target WITHOUT ROWID table ${table}`);
    }
    assertUniqueCellUpdateTargets(updates, rowIdIdentity);
    if (!isHistoryReplay && maxUndoSnapshotBytes !== undefined) {
      await this.assertBatchHistoryWithinBudget(
        table,
        updates,
        rowIdIdentity,
        maxUndoSnapshotBytes
      );
    }

    // Use SAVEPOINT instead of BEGIN TRANSACTION so this method can be called
    // safely from within an outer transaction (e.g., undoColumnDrop).
    // escapeIdentifier wraps in double quotes defensively — the generated name
    // is already [a-zA-Z0-9_] safe, but quoting prevents issues if the pattern changes.
    const savepointName = this.createSavepointName('sp_update_batch');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      // Refuse the unconfirmed oversized case before the existing SELECT can
      // materialize any prior value into JavaScript history.
      if (!isHistoryReplay && maxEditValueBytes !== undefined) {
        await this.assertRowIdBatchPriorsWithinEditLimit(table, updates, editLimitBytes);
      }
      const rowIdAliasColumn = await this.readRowIdAliasColumn(table);
      await this.assertUpdateHasNoTargetTableTriggerWrites(
        table,
        updates.map(update => update.column)
      );
      if (
        rowIdAliasColumn !== undefined
        && updates.some(update => sqliteIdentifiersEqual(update.column, rowIdAliasColumn))
      ) {
        const results = await this.updateRowIdAliasCellBatchWithinSavepoint(
          table,
          rowIdAliasColumn,
          updates,
          editLimitBytes,
          isHistoryReplay
        );
        await this.executeQuery(`RELEASE ${savepointName}`);
        return results;
      }
      const escapedTable = escapeMainIdentifier(table);
      const rowIds = [...new Set(updates.map(update => validateRowId(update.rowId)))];
      const columns = [...new Set(updates.map(update => update.column))];
      const rowIdPredicates = buildRecordIdentityPredicateChunks(rowIds, rowIdIdentity);
      const currentValues = new Map<string, Map<string, StoredCellState>>();
      for (const predicate of rowIdPredicates) {
        const current = await this.executeQuery(
          `SELECT CAST(rowid AS TEXT), ${columns.map(buildStoredCellStateProjection).join(', ')} ` +
          `FROM ${escapedTable} WHERE ${predicate.sql}`,
          predicate.params
        );
        for (const row of current[0]?.rows ?? []) {
          const values = new Map<string, StoredCellState>();
          columns.forEach((column, index) => values.set(column, parseStoredCellState(
            row[index * 2 + 1],
            row[index * 2 + 2],
            `${table}.${column}`,
            { textEncoding: this.getCellTextEncoding() }
          )));
          currentValues.set(String(validateRowId(row[0] as RecordId)), values);
        }
      }
      const results: Array<Omit<CellUpdateResult, 'postState'>> = [];
      const processedUpdates = updates.map(update => {
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
          const storedValue = this.applyJsonPatchValue(priorValue, prepared.value);
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
      });
      // Group updates by column and operation type
      // Prepare statements one by one avoids full re-parse

      // Prepare per column.
      // Group by column.

      const updatesByColumn = new Map<string, CellUpdate[]>();
      for (const update of processedUpdates) {
          const key =
            `${update.column}|${update.operation || 'set'}|` +
            `${wasmBindPlaceholder(update.value)}`;
          if (!updatesByColumn.has(key)) {
              updatesByColumn.set(key, []);
          }
          updatesByColumn.get(key)!.push(update);
      }

      for (const columnUpdates of updatesByColumn.values()) {
          // Recover the tuple from the group itself, never by re-parsing the key:
          // SQLite identifiers may legally contain '|', so splitting it would
          // truncate a column named e.g. `notes|set|?` and write the wrong column.
          // Every member of a group shares one column/operation/placeholder by
          // construction, so the first entry is authoritative.
          const column = columnUpdates[0].column;
          const op = columnUpdates[0].operation || 'set';
          const valuePlaceholder = wasmBindPlaceholder(columnUpdates[0].value);
          const escapedColumn = escapeIdentifier(column);

          // For json_patch operations, choose between native SQLite json_patch()
          // and JS fallback depending on runtime availability
          const useNativePatch = op === 'json_patch' && this.hasJsonPatch;

          // COALESCE handles NULL columns: json_patch(NULL, x) returns NULL per SQL semantics,
          // but the expected behavior is to treat NULL as empty object (matching JS fallback).
          const sql = useNativePatch
            ? `UPDATE ${escapedTable} SET ${escapedColumn} = json_patch(COALESCE(${escapedColumn}, '{}'), ?) WHERE rowid = ?`
            : `UPDATE ${escapedTable} SET ${escapedColumn} = ${valuePlaceholder} WHERE rowid = ?`;

          const stmt = this.instance.prepare(sql);

          // Only need SELECT for JS fallback path
          let selectStmt: WasmPreparedStatement | null = null;

          try {
              if (op === 'json_patch' && !this.hasJsonPatch) {
                 selectStmt = this.instance.prepare(`SELECT ${escapedColumn} FROM ${escapedTable} WHERE rowid = ?`);
              }

              // Cache parsed patch objects to optimize JS fallback for batch updates
              const parsedPatchCache = new Map<string, unknown>();

              for (const update of columnUpdates) {
                  const rowIdNum = validateRowId(update.rowId);

                  if (useNativePatch) {
                     // Native json_patch(): single UPDATE, no SELECT needed
                     const patchStr = typeof update.value === 'string'
                       ? update.value
                       : JSON.stringify(update.value);
                     stmt.run(normalizeWasmBindParams([patchStr, rowIdNum]));

                  } else if (op === 'json_patch') {
                     // JS fallback: read current value, apply patch, write back
                     let currentValue = null;
                     if (selectStmt) {
                        const row = selectStmt.get([rowIdNum]);
                        if (row && row.length > 0) {
                            currentValue = row[0];
                        }
                        selectStmt.reset();
                     }

                     const currentObj = parseJsonValueForPatching(currentValue, 'updateCells');

                     let patchObj;
                     if (typeof update.value === 'string') {
                         if (parsedPatchCache.has(update.value)) {
                             patchObj = parsedPatchCache.get(update.value);
                         } else {
                             patchObj = JSON.parse(update.value);
                             parsedPatchCache.set(update.value, patchObj);
                         }
                     } else {
                         patchObj = update.value;
                     }

                     const newValueObj = applyMergePatch(currentObj, patchObj);
                     const newValueStr = JSON.stringify(newValueObj);

                     stmt.run(normalizeWasmBindParams([newValueStr, rowIdNum]));
                  } else {
                      // Standard update
                      stmt.run(normalizeWasmBindParams([update.value, rowIdNum]));
                  }
              }
          } finally {
              stmt.free();
              if (selectStmt) selectStmt.free();
          }
      }

      // A trigger may move or delete an intrinsic rowid after an otherwise
      // successful per-cell UPDATE. Never commit history that still names a
      // vanished identity.
      const remainingRowIds = new Set<string>();
      for (const predicate of rowIdPredicates) {
        const remaining = this.queryRaw(
          `SELECT CAST(rowid AS TEXT) FROM ${escapedTable} ` +
          `WHERE ${predicate.sql}`,
          predicate.params
        );
        for (const row of remaining.rows) {
          remainingRowIds.add(String(validateRowId(row[0] as RecordId)));
        }
      }
      if (rowIds.some(rowId => !remainingRowIds.has(String(rowId)))) {
        throw unresolvableTriggeredRowIdUpdateError(table);
      }

      const postValues = new Map<string, Map<string, StoredCellState>>();
      for (const predicate of rowIdPredicates) {
        const post = this.queryRaw(
          `SELECT CAST(rowid AS TEXT), ${columns.map(buildStoredCellStateProjection).join(', ')} ` +
          `FROM ${escapedTable} WHERE ${predicate.sql}`,
          predicate.params
        );
        for (const row of post.rows) {
          const values = new Map<string, StoredCellState>();
          columns.forEach((column, index) => values.set(column, parseStoredCellState(
            row[index * 2 + 1],
            row[index * 2 + 2],
            `${table}.${column}`,
            { textEncoding: this.getCellTextEncoding() }
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

      await this.executeQuery(`RELEASE ${savepointName}`);
      return completedResults;
    } catch (err) {
      await this.safeRollbackSavepoint(savepointName, 'updateCellBatch');
      throw err;
    }
  }

  /**
   * Add a new column to a table.
   */
  async addColumn(
    table: string,
    column: string,
    type: string,
    defaultValue?: string,
    expectedCurrentState?: ColumnDropTableState
  ): Promise<ColumnDropTableState> {
    assertUsableSqlIdentifier(column, 'Column name');
    // Validate SQL type to prevent injection via malicious type definitions
    validateSqlType(type);
    const sql = `ALTER TABLE ${escapeMainIdentifier(table)} ADD COLUMN `
      + `${escapeIdentifier(column)} ${type}${buildColumnDefaultClause(defaultValue)}`;

    const savepointName = this.createSavepointName('sp_add_column');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      const current = await this.readColumnDropTableState(table);
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
      const dependenciesBefore = await this.captureViewDependencySnapshot();
      await this.executeQuery(sql);
      const stateAfter = await this.readColumnDropTableState(table);
      assertNoNewBrokenSchemaDependencies(
        dependenciesBefore,
        await this.captureViewDependencySnapshot()
      );
      await this.executeQuery(`RELEASE ${savepointName}`);
      return stateAfter;
    } catch (error) {
      await this.safeRollbackSavepoint(savepointName, 'addColumn');
      throw error;
    }
  }

  /**
   * Fetch table data using options.
   *
   * Runs under the same progress-handler deadline as executeQuery():
   * LIMIT/OFFSET bound the rows returned, not the work performed, so an
   * expensive view, CTE or unindexed ORDER BY still hits queryTimeout.
   */
  async fetchTableData(table: string, options: TableQueryOptions): Promise<QueryResultSet> {
    options = normalizeTablePageOptions(options);
    const queryOptions = { ...options };
    queryOptions.columns = await this.resolveQueryColumns(table, queryOptions.columns, queryOptions.globalFilter);

    let identity: TableIdentity | undefined;
    let primaryKeyContext: {
      identity: Extract<TableIdentity, { kind: 'primaryKey' }>;
      visibleColumns: string[];
    } | undefined;
    if (queryOptions.columns?.[0]?.toLowerCase() === 'rowid') {
      identity = await this.findTableIdentity(table);
      if (identity?.kind === 'primaryKey') {
        const visibleColumns = queryOptions.columns.slice(1);
        const hiddenPrimaryKeyColumns = identity.columns
          .map(column => column.identifier)
          .filter(column => !visibleColumns.includes(column));
        queryOptions.columns = [...visibleColumns, ...hiddenPrimaryKeyColumns];
        primaryKeyContext = { identity, visibleColumns };
        if (ordersBySyntheticRowId(options)) {
          queryOptions.orderBy = undefined;
          queryOptions.orderByColumns = identity.columns.map(column => column.identifier);
        }
      }
    }

    // Use prepare/step/get to avoid overhead of exec() which builds intermediate objects
    // and to allow for potentially better memory management in the future
    const executionState: {
      headerStmt?: WasmPreparedStatement;
      stmt?: WasmPreparedStatement;
      rowIdStmt?: WasmPreparedStatement;
    } = {};
    try {
      // executeWithProgressHandler is strictly synchronous and its handler is
      // connection-global, so the awaited authority read must resolve before
      // the guarded span below. This engine owns a private in-memory copy, so
      // no external process can commit between this read and the page and
      // companion reads it authorizes.
      const firstColumn = queryOptions.columns?.[0]?.toLowerCase();
      let isRowIdTable = false;
      if (firstColumn === undefined || firstColumn === '*' || firstColumn === 'rowid') {
        const authority = await this.executeQuery(ROWID_TABLE_AUTHORITY_SQL, [table, table]);
        isRowIdTable = (authority[0]?.rows.length ?? 0) > 0;
      }

      // Keyset eligibility: a declared WITHOUT ROWID key, or an authority-
      // confirmed unshadowed rowid. Key/tag derive from the untransformed
      // request options so minting and validation always agree.
      const keysetIdentity = identity?.kind === 'primaryKey'
        ? identity
        : (identity?.kind === 'rowid' && isRowIdTable ? identity : undefined);
      const keysetKey = computeKeysetKey(options, keysetIdentity);
      const keysetTag = keysetKey ? computeKeysetQueryTag(table, options) : undefined;
      const keysetPlan = keysetKey
        ? resolveKeysetPlan(table, options, keysetIdentity)
        : undefined;
      const fallbackOrder = keysetFallbackOrder(keysetKey, keysetPlan);
      if (fallbackOrder) {
        // One total order for both paths: this OFFSET/fallback page re-anchors
        // the grid (anchors minted below), so its row order must match what
        // those anchors will seek. keysetKey is authority-gated above, so a
        // shadowed rowid table keeps the pre-keyset SQL unchanged.
        queryOptions.orderBy = undefined;
        queryOptions.orderByColumns = fallbackOrder.orderByColumns;
        queryOptions.orderDir = fallbackOrder.orderDir;
      }

      const splitSyntheticRowId = identity?.kind === 'rowid'
        && firstColumn === 'rowid'
        && (queryOptions.columns?.length ?? 0) > SQLITE_MAX_RESULT_COLUMNS;
      const valueQueryOptions = splitSyntheticRowId
        ? { ...queryOptions, columns: queryOptions.columns!.slice(1) }
        : queryOptions;
      const { sql, params } = buildSelectQuery(table, valueQueryOptions, keysetPlan);
      const rowIdQuery = splitSyntheticRowId
        ? buildSelectQuery(
            table,
            { ...queryOptions, columns: ['rowid'] },
            keysetPlan
          )
        : undefined;

      return this.executeWithProgressHandler(() => {
        const bindParams = normalizeWasmBindParams(params);
        const headerStmt = this.instance.prepare(sql, bindParams);
        executionState.headerStmt = headerStmt;
        const valueHeaders = headerStmt.getColumnNames();
        const headers = splitSyntheticRowId ? ['rowid', ...valueHeaders] : valueHeaders;
        headerStmt.free();
        executionState.headerStmt = undefined;

        const primaryKeyColumnIndices = primaryKeyContext
          ? primaryKeyContext.identity.columns.map(column => {
              const index = headers.indexOf(column.identifier);
              if (index < 0) {
                throw new Error(`Primary-key column missing from table fetch: ${column.identifier}`);
              }
              return index;
            })
          : [];
        const keysetColumnIndices = keysetKey
          ? keysetKey.keyColumns
              .map(column => headers.indexOf(column))
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
          valueHeaders.length * 2 + 1 <= SQLITE_MAX_RESULT_COLUMNS
            ? valueHeaders.map((_, index) => index)
            : identityContainmentRawTextColumnIndices;
        const containmentQuery = buildCellContainmentQuery(
          sql,
          valueHeaders.length,
          queryOptions,
          containmentRawTextColumnIndices
        );
        const transportQuery = buildExactNumericTextQuery(
          containmentQuery.sql,
          containmentQuery.primaryTransportColumnCount
        );
        const stmt = this.instance.prepare(transportQuery.sql, bindParams);
        executionState.stmt = stmt;
        const primaryRows: Array<Array<CellValue | bigint>> = [];

        while (stmt.step()) {
            // We know a row exists because step() returned true
            const row = stmt.get(null, { useBigInt: true });
            if (row) {
                primaryRows.push(row);
            }
        }
        const valueSourceRows = mergeCellContainmentMetadataRows(
          primaryRows,
          undefined,
          containmentQuery
        ) as Array<Array<CellValue | bigint>>;
        let rowIdRows: Array<Array<CellValue | bigint>> | undefined;
        if (rowIdQuery) {
          const rowIdStmt = this.instance.prepare(
            rowIdQuery.sql,
            normalizeWasmBindParams(rowIdQuery.params)
          );
          executionState.rowIdStmt = rowIdStmt;
          rowIdRows = [];
          while (rowIdStmt.step()) {
            const row = rowIdStmt.get(null, { useBigInt: true });
            if (row) rowIdRows.push(row);
          }
          rowIdStmt.free();
          executionState.rowIdStmt = undefined;
          if (rowIdRows.length !== valueSourceRows.length) {
            throw new Error('Synthetic rowid companion row count does not match the value page');
          }
        }
        const sourceRows = rowIdRows
          ? rowIdRows.map((row, rowIndex) => {
              if (row.length !== 1) {
                throw new Error(`Synthetic rowid companion row ${rowIndex} is not one value`);
              }
              return [row[0], ...valueSourceRows[rowIndex]];
            })
          : valueSourceRows;

        const companionResults = [];
        const hasRowIdShape = headers[0]?.toLowerCase() === 'rowid';
        const needsExactRowIdIdentity = hasRowIdShape
          && hasUnsafeBigIntAtColumn(sourceRows, 0);
        const needsRowIdCompanions = transportQuery.valueColumnCount === undefined
          && hasRowIdShape;
        if (isRowIdTable && needsRowIdCompanions) {
          for (const query of buildRowIdExactRealTextQueries(
            table,
            headers,
            sourceRows.map(row => row[0])
          )) {
            let companionStmt: WasmPreparedStatement | null = null;
            try {
              companionStmt = this.instance.prepare(
                query.sql,
                normalizeWasmBindParams(query.params)
              );
              const companionRows: Array<Array<CellValue | bigint>> = [];
              while (companionStmt.step()) {
                const row = companionStmt.get(null, { useBigInt: true });
                if (row) companionRows.push(row);
              }
              companionResults.push({ query, rows: companionRows });
            } finally {
              if (companionStmt) companionStmt.free();
            }
          }
        }
        const companionExactTexts = collectRowIdExactRealTexts(
          sourceRows,
          companionResults
        );

        const normalized = normalizeIntegerRowsForTransport(
          valueSourceRows,
          transportQuery.valueColumnCount,
          splitSyntheticRowId ? undefined : companionExactTexts,
          !splitSyntheticRowId && isRowIdTable && needsExactRowIdIdentity ? 0 : undefined
        );
        const valueContained = decodeCellContainment(
          normalized.rows,
          valueHeaders.length,
          normalized.exactIntegerTexts,
          queryOptions.maxPageResponseBytes
        );
        const decodedContained = rowIdRows
          ? prependCellContainmentColumn(
              normalizeIntegerRowsForTransport(
                rowIdRows,
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
          ? this.getCellTextEncoding()
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
        const remapped = primaryKeyContext
          ? remapPrimaryKeyContainment({
              identity: primaryKeyContext.identity,
              sourceColumns: headers,
              visibleColumnCount: primaryKeyContext.visibleColumns.length,
              identityRows: sourceRows,
              rawTextBytes: rawTextRows,
              rawTextColumnIndices: sourceRawTextColumnIndices,
              rawTextValidationUnavailable: containmentQuery.rawTextValidationUnavailable,
              textEncoding: textEncoding!,
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
        // Anchors come from the exact source rows (BigInt-preserving, already
        // in display order) so every OFFSET or keyset page re-anchors itself.
        const keysetAnchors = keysetKey && keysetTag !== undefined
          ? mintKeysetAnchors({
              tag: keysetTag,
              key: keysetKey,
              projectionColumns: headers,
              rows: sourceRows,
              oversizedCells,
              excludedRowIndices: unrepresentableKeysetTextRows
            })
          : undefined;
        if (primaryKeyContext && remapped) {
          const resultHeaders = ['rowid', ...primaryKeyContext.visibleColumns];
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
        return {
            headers,
            rows: shadowedRowId?.rows ?? rows,
            columns: headers,
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
      });
    } catch (err) {
        const errorDetail = err instanceof Error ? err.message : String(err);
        throw new Error(`Fetch failed: ${errorDetail}`);
    } finally {
      executionState.headerStmt?.free();
      executionState.stmt?.free();
      executionState.rowIdStmt?.free();
    }
  }

  /**
   * Fetch table row count using options.
   */
  async fetchTableCount(table: string, options: TableCountOptions): Promise<TableCountResult> {
    const queryOptions = { ...options };
    queryOptions.columns = await this.resolveQueryColumns(table, queryOptions.columns, queryOptions.globalFilter);

    const { sql, params } = buildCountQuery(table, queryOptions);
    // Shared paged count policy (see src/core/paged-count.ts): large paged
    // opens answer unfiltered counts without a complete b-tree scan — rowid
    // tables use their span, while WITHOUT ROWID tables use a capped probe.
    // OP_Count never yields to the progress handler and a full scan through
    // per-page host reads starves RPC deadlines. Every WHERE condition
    // buildCountQuery emits binds at least one parameter, so params.length
    // is exactly the "filtered" signal the demo worker derives from its own
    // WHERE clauses.
    const countPolicyInput = this.pagedState && {
        storage: 'paged',
        filtered: params.length > 0,
        // Stage the cheap size/filter decision before paying for authority.
        authorityConfirmedRowIdTable: true,
        pagedFileSizeBytes: this.pagedState.fileSizeBytes,
        exactCountMaxFileBytes: this.pagedState.exactCountMaxFileBytes
      } as const;
    if (countPolicyInput && shouldAnswerCountWithUpperBound(countPolicyInput)) {
      let authorityConfirmedRowIdTable = false;
      try {
        const authority = await this.executeQuery(ROWID_TABLE_AUTHORITY_SQL, [table, table]);
        authorityConfirmedRowIdTable = (authority[0]?.rows.length ?? 0) > 0;
        if (shouldAnswerCountWithUpperBound({
          ...countPolicyInput,
          authorityConfirmedRowIdTable
        })) {
          const bound = await this.executeQuery(buildCountUpperBoundSql(table));
          const upperBound = resolveCountUpperBound(bound[0]?.rows?.[0]);
          if (upperBound !== undefined) return { count: upperBound, isExact: false };
        }
      } catch {
        // A failed rowid shortcut may still be a WITHOUT ROWID table below.
      }

      if (!authorityConfirmedRowIdTable) {
        let withoutRowIdTable = false;
        try {
          const metadata = await this.executeQuery(WITHOUT_ROWID_TABLE_SQL, [table]);
          withoutRowIdTable = (metadata[0]?.rows.length ?? 0) > 0;
        } catch {
          // Preserve exact semantics for views and relations we cannot classify.
        }
        if (withoutRowIdTable) {
          try {
            const probe = await this.executeQuery(
              buildCappedCountProbeSql(table),
              [PAGED_COUNT_PROBE_MAX_ROWS + 1]
            );
            const resolved = resolveCappedCount(
              probe[0]?.rows?.[0]?.[0],
              this.pagedState.fileSizeBytes
            );
            if (resolved) return resolved;
          } catch {
            // Never trade a failed bounded probe for the non-interruptible scan.
          }
          return {
            count: resolveFileSizeRowUpperBound(this.pagedState.fileSizeBytes),
            isExact: false
          };
        }
      }
    }
    const result = await this.executeQuery(sql, params);
    if (result && result.length > 0 && result[0].rows.length > 0) {
      const count = result[0].rows[0][0];
      return { count: typeof count === 'number' ? count : 0, isExact: true };
    }
    return { count: 0, isExact: true };
  }

  /**
   * Fetch database schema.
   */
  async fetchSchema(): Promise<SchemaSnapshot> {
    const [schemaResult, identityResult] = await Promise.all([
      this.executeQuery(
        "SELECT type, name, tbl_name, sql FROM main.sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name"
      ),
      this.executeQuery(TABLE_IDENTITY_METADATA_SQL)
    ]);

    const rows = schemaResult[0]?.rows || [];
    const identities = buildTableIdentityMap(identityResult[0]?.rows || []);

    const tables = rows
        .filter(r => r[0] === 'table')
        .map(r => {
          const identifier = r[1] as string;
          const identity = identities.get(identifier);
          if (!identity) throw new Error(`Table not found: ${identifier}`);
          return { identifier, identity };
        });

    const views = rows
        .filter(r => r[0] === 'view')
        .map(r => ({ identifier: r[1] as string }));

    const indexes = rows
        .filter(r => r[0] === 'index')
        .map(r => ({ identifier: r[1] as string, parentTable: r[2] as string }));

    return { tables, views, indexes };
  }

  /**
   * Get table metadata.
   */
  async getTableInfo(table: string): Promise<ColumnMetadata[]> {
    const result = await this.executeQuery(TABLE_XINFO_WITH_ROWID_ALIAS_SQL, [table]);
    return (result[0]?.rows || [])
      // table_xinfo also exposes hidden virtual-table implementation columns
      // (hidden=1). Preserve table_info's user-facing surface while adding the
      // generated VIRTUAL/STORED columns represented by hidden=2/3.
      .filter(row => Number(row[6] ?? 0) !== 1)
      .map(row => ({
        ordinal: row[0] as number,
        identifier: row[1] as string,
        declaredType: row[2] as string,
        isRequired: row[3] as number,
        defaultExpression: row[4],
        primaryKeyPosition: row[5] as number,
        isGenerated: Number(row[6] ?? 0) === 2 || Number(row[6] ?? 0) === 3,
        isRowidAlias: Number(row[7] ?? 0) === 1
      }));
  }

  /**
   * Get PRAGMA settings.
   */
  async getPragmas(): Promise<Record<string, CellValue>> {
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

    const result: Record<string, CellValue> = {};
    const query = pragmasToFetch.map(pragma => `PRAGMA ${pragma};`).join('\n');
    const res = await this.executeQuery(query);

    for (let i = 0; i < pragmasToFetch.length; i++) {
      if (res[i]?.rows?.[0]) {
        result[pragmasToFetch[i]] = res[i].rows[0][0];
      }
    }

    return result;
  }

  /**
   * Set PRAGMA value.
   */
  async setPragma(pragma: string, value: CellValue): Promise<void> {
    this.assertWritableMutation('PRAGMA changes');
    // Validate pragma name to prevent SQL injection
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
    // String values use a strict whitelist to prevent injection — only
    // alphanumeric, underscores, and hyphens are allowed (covers all
    // valid PRAGMA string values like 'wal', 'delete', 'normal', etc.)
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

    await this.executeQuery(sql);
  }

  /** Replay a persistent PRAGMA and refuse a normalized/no-op mismatch. */
  private async applyPragmaHistoryValue(pragma: string, value: CellValue): Promise<void> {
    await this.setPragma(pragma, value);
    const effective = (await this.getPragmas())[pragma];
    const matches = typeof effective === 'string' && typeof value === 'string'
      ? effective.toLowerCase() === value.toLowerCase()
      : Object.is(effective, value);
    if (!matches) {
      throw new Error(`SQLite did not apply the recorded PRAGMA ${pragma} value`);
    }
  }

  /**
   * Test connection.
   */
  async ping(): Promise<boolean> {
    try {
      await this.executeQuery('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Release database resources.
   */
  shutdown(): void {
    if (this.queryReadSession) {
      try {
        const { sessionId } = this.queryReadSession;
        this.queryReadSession.statement.free();
        this.queryReadSession = undefined;
        this.closedQueryReadSessionIds.add(sessionId);
      } catch (error) {
        this.logger('error', 'Failed to release query read session during shutdown:', error);
      }
    }
    if (this.cellReadSession) {
      try {
        this.releaseCellReadSession(this.cellReadSession);
      } catch (error) {
        this.logger('error', 'Failed to release cell read session during shutdown:', error);
      }
    }
    if (!this.instanceClosed) {
      this.instance.close();
      this.instanceClosed = true;
      // Release host read resources (the fd behind a paged open) only after
      // the WASM instance has closed, so no read callback can race a closed
      // descriptor. Failures must not mask the shutdown itself.
      try {
        this.pagedState?.dispose?.();
      } catch (error) {
        this.logger('error', 'Failed to release paged host I/O during shutdown:', error);
      }
    }
  }

  /**
   * Write database directly to file system.
   */
  async writeToFile(
    path: string,
    cancellation?: WasmOperationCancellation
  ): Promise<DatabaseWriteResult | void> {
    if (this.pagedState?.writable) {
      throw new Error(
        'Internal error: writable page-on-demand databases must be saved by the desktop host stream writer.'
      );
    }
    const fs = getNodeFs();
    if (!fs) throw new Error('File system access not available');

    const signal = cancellationCheck(cancellation);
    signal?.throwIfAborted();
    const data = this.exportDatabaseImage();
    return writeDatabaseSnapshotAtomically(
      fs,
      undefined,
      path,
      async temporaryPath => {
        // The helper supplies a collision-resistant sibling path. `wx` keeps
        // an unexpected local race from converting it into an overwrite.
        await fs.promises.writeFile(temporaryPath, data, { flag: 'wx' });
      },
      signal,
      (level, message, error) => this.logger(level, message, error)
    );
  }
}
