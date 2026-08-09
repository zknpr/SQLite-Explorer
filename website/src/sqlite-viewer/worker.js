/**
 * SQLite Web Worker for Browser-based Database Operations
 *
 * This worker runs sql.js (SQLite compiled to WebAssembly) in a separate
 * thread to keep the UI responsive. It communicates with the main thread
 * using the same RPC protocol as the VS Code extension.
 *
 * Architecture:
 * - Loads the repository-pinned sql.js fork from self-hosted public assets
 * - Handles RPC messages for database operations
 * - All SQL execution happens in this worker
 */

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
  normalizeViewSelectSql
} from '../../../src/core/view-utils.ts';
import {
  escapeIdentifier,
  escapeLikePattern,
  validateRowId
} from '../../../src/core/sql-utils.ts';
import {
  encodeCsvExportCell,
  encodeJsonExportCell,
  encodeSqlExportCell
} from '../../../src/core/export-encoding.ts';
import { executeSchemaPreservingColumnDrop } from '../../../src/core/column-drop.ts';
import { getActiveFilterValue } from '../../../src/core/filter-utils.ts';
import {
  applyMergePatch,
  computeJsonPatchUndo,
  parseJsonValueForPatching,
  prepareCellUpdateForStorage
} from '../../../src/core/json-utils.ts';
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
} from '../../../src/core/row-identity.ts';
import {
  buildExactNumericTextQuery,
  buildRowIdExactRealTextQueries,
  collectRowIdExactRealTexts,
  hasUnsafeBigIntAtColumn,
  normalizeIntegerRowsForTransport,
  ROWID_TABLE_AUTHORITY_SQL
} from '../../../src/core/integer-utils.ts';
import {
  buildCellContainmentQuery,
  decodeCellContainment,
  DEFAULT_MAX_INLINE_CELL_BYTES,
  DEFAULT_MAX_PAGE_RESPONSE_BYTES,
  remapPrimaryKeyContainment
} from '../../../src/core/cell-containment.ts';
import {
  assembleKeysetSelect,
  computeKeysetKey,
  computeKeysetQueryTag,
  keysetFallbackOrder,
  mintKeysetAnchors,
  resolveKeysetPlan
} from '../../../src/core/keyset-pagination.ts';
import {
  buildCellChunkQuery,
  buildCellMetadataQuery,
  decodeCellMetadata,
  DEFAULT_CELL_READ_SESSION_ABSOLUTE_TIMEOUT_MS,
  DEFAULT_CELL_READ_SESSION_IDLE_TIMEOUT_MS,
  normalizeCellReadTimeout,
  normalizeCellTextEncoding,
  validateCellReadTarget,
  validateCellReadWindow
} from '../../../src/core/cell-read.ts';
import {
  assertCellValueWithinEditLimit,
  assertCellValuesWithinEditLimit,
  assertOversizedCellReplacementExpectation,
  OVERSIZED_CELL_REPLACEMENT_CONFLICT_MESSAGE,
  OversizedCellReplacementRequiredError,
  toCellEditRpcErrorData
} from '../../../src/core/cell-edit-policy.ts';
import {
  BUFFER_OPEN_CEILING_BYTES,
  decideOpenPlan,
  isWalMarkedHeader,
  SQLITE_HEADER_PROBE_BYTES
} from '../../../src/core/paged-open.ts';
import {
  buildCountUpperBoundSql,
  resolvePagedExactCountMaxFileBytes,
  resolveCountUpperBound,
  shouldAnswerCountWithUpperBound
} from '../../../src/core/paged-count.ts';
import { createChunkedReadCache } from '../../../src/core/chunked-read-cache.ts';

// ============================================================================
// Configuration
// ============================================================================

const SQL_JS_GLUE_URL = './sql-wasm.js';
const SQL_JS_WASM_URL = './sql-wasm.wasm';
const DEFAULT_QUERY_TIMEOUT_MS = 30000;
const PROGRESS_HANDLER_INTERVAL = 1000;
const WEB_DEMO_EXPORT_MAX_BYTES = 16 * 1024 * 1024;
const WEB_DEMO_EXPORT_CHUNK_CHARS = 64 * 1024;
const WEB_DEMO_EXPORT_LIMIT_DESCRIPTION = '16 MiB (16,777,216 bytes)';
// RPC payloads cannot forge this Symbol; only in-worker history restoration
// may bypass the new-value policy for a value that already existed.
const HISTORY_REPLAY_EDIT_TOKEN = Symbol('history-replay-edit');

// ============================================================================
// State
// ============================================================================

/**
 * The active sql.js database instance.
 * @type {Object|null}
 */
let db = null;

/**
 * The sql.js module (SQL object).
 * @type {Object|null}
 */
let SQL = null;
let queryTimeout = DEFAULT_QUERY_TIMEOUT_MS;
let readOnlyMode = false;
/** User-facing explanation when safety policy forces a read-only open. */
let readOnlyReason = null;
/**
 * How the active database is backed: 'memory' (bytes in the WASM-side
 * filesystem — today's buffer path) or 'paged' (page-on-demand reads
 * through host callbacks, optionally with the fork's copy-on-write
 * overlay). Count queries consult this to keep full-table scans bounded
 * on paged storage.
 * @type {'memory' | 'paged'}
 */
let storageMode = 'memory';
/** File size behind the current paged open; 0 for buffer opens. */
let pagedFileSizeBytes = 0;
/**
 * A writable paged export materializes the complete merged database in
 * browser memory. Keep the hard ceiling at the browser buffer-path limit;
 * the page warns before every paged download because the transient peak is
 * still materially larger than the on-disk image.
 */
let pagedExportMaxBytes = BUFFER_OPEN_CEILING_BYTES;
/**
 * Exact-count gate for paged opens; policy and default live in the shared
 * src/core/paged-count.ts module (also consumed by the desktop engine).
 */
let pagedExactCountMaxFileBytes = resolvePagedExactCountMaxFileBytes(undefined);
let cellReadSessionIdleTimeoutMs = DEFAULT_CELL_READ_SESSION_IDLE_TIMEOUT_MS;
let cellReadSessionAbsoluteTimeoutMs = DEFAULT_CELL_READ_SESSION_ABSOLUTE_TIMEOUT_MS;
let activeCellReadSession = null;
const closedCellReadSessionIds = new Set();

// ============================================================================
// sql.js Loading
// ============================================================================

/**
 * Load the self-hosted sql.js glue using importScripts.
 * This populates the global `initSqlJs` function.
 */
async function loadSqlJs() {
  if (SQL) return SQL;

  // Import the sql.js script
  importScripts(SQL_JS_GLUE_URL);

  // Initialize sql.js with WASM binary
  // The WASM file will be provided via initializeDatabase call
  return null;
}

// ============================================================================
// SQL Validation Utilities
// ============================================================================

/**
 * Validate a SQL type definition to ensure it is safe.
 * Allows standard SQLite types and common variants.
 *
 * @param {string} type - The type string to validate (e.g. "INTEGER", "VARCHAR(255)")
 * @throws Error if the type is potentially unsafe
 */
function validateSqlType(type) {
  if (!type || typeof type !== 'string') {
    throw new Error('Invalid SQL type: Type must be a non-empty string');
  }

  // Check for dangerous characters that could be used for injection
  // Disallow: quotes, semicolons, dashes (comments), slashes, asterisks
  if (/['";\-\/\*]/.test(type)) {
     throw new Error(`Invalid SQL type: "${type}" contains potentially unsafe characters`);
  }

  // Strict validation pattern
  // Matches:
  // 1. Start with alphanumeric words/spaces (e.g. "INTEGER", "UNSIGNED INT")
  // 2. Optional: Parentheses with numbers/commas (e.g. "(255)", "(10, 2)")
  // 3. Optional: Trailing alphanumeric words/spaces (e.g. "UNSIGNED")
  const validPattern = /^[a-zA-Z0-9_\s]+(?:\([0-9\s,]+\)[a-zA-Z0-9_\s]*)?$/;

  if (!validPattern.test(type.trim())) {
     throw new Error(`Invalid SQL type: "${type}" does not match allowed format`);
  }
}

/**
 * Format a default value for SQL inclusion, ensuring it is properly escaped.
 *
 * @param {string|number} defaultValue - The default value to format
 * @returns {string} The safely formatted default value expression
 */
function formatDefaultValue(defaultValue) {
  const strValue = String(defaultValue);

  if (strValue.toLowerCase() === 'null') {
    return 'NULL';
  } else if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(strValue)) {
    // Strict numeric pattern: optional sign, digits with optional decimal, optional exponent
    // This prevents hex (0x), special values, and other edge cases
    return strValue;
  } else {
    // Standard string literal - escape internal single quotes and wrap in single quotes
    return `'${strValue.replace(/'/g, "''")}'`;
  }
}

let viewSavepointCounter = 0;

function createViewSavepointName(prefix) {
  viewSavepointCounter++;
  return escapeIdentifier(`${prefix}_${viewSavepointCounter}`);
}

function prepareSingleStatement(sql) {
  const boundary = `/*sqlite_explorer_boundary_${crypto.randomUUID().replace(/-/g, '')}*/`;
  const statement = db.prepare(`${sql}\n${boundary}`);
  if (!statement.getSQL().trimEnd().endsWith(boundary)) {
    statement.free();
    throw new Error('Exactly one SQL statement is required');
  }
  return statement;
}

function runSingleStatement(sql) {
  const checkedStatement = prepareSingleStatement(sql);
  checkedStatement.free();
  const statement = db.prepare(sql);
  try {
    statement.run();
  } finally {
    statement.free();
  }
}

function normalizeBindParams(params) {
  return params?.map(value => {
    if (typeof value !== 'bigint') return value;
    const numericValue = Number(value);
    return Number.isSafeInteger(numericValue) ? numericValue : value.toString();
  });
}

function bindPlaceholder(value) {
  return typeof value === 'bigint' && !Number.isSafeInteger(Number(value))
    ? 'CAST(? AS INTEGER)'
    : '?';
}

function compileSingleStatement(sql) {
  const statement = prepareSingleStatement(sql);
  statement.free();
}

function executeWithProgressHandler(operation, cancellationFlag) {
  if (cancellationFlag !== undefined) {
    const hasSharedBuffer = typeof SharedArrayBuffer === 'function' &&
      cancellationFlag instanceof Int32Array &&
      cancellationFlag.length > 0 &&
      cancellationFlag.buffer instanceof SharedArrayBuffer;
    if (!hasSharedBuffer) throw new Error('Invalid query cancellation flag');
  }
  const isCancelled = () => cancellationFlag !== undefined &&
    Atomics.load(cancellationFlag, 0) !== 0;
  const throwCancellation = () => {
    const error = new Error('Query execution cancelled');
    error.name = 'AbortError';
    throw error;
  };
  if (isCancelled()) throwCancellation();

  const deadline = Date.now() + queryTimeout;
  let termination;
  db.progress_handler(PROGRESS_HANDLER_INTERVAL, () => {
    if (isCancelled()) {
      termination = 'cancelled';
      return true;
    }
    if (Date.now() < deadline) return false;
    termination = 'timeout';
    return true;
  });

  try {
    return operation();
  } catch (error) {
    if (termination === 'timeout') {
      throw new Error(`Query execution timed out after ${queryTimeout}ms`);
    }
    if (termination === 'cancelled' || isCancelled()) throwCancellation();
    throw error;
  } finally {
    db.progress_handler(null);
  }
}

function querySingleStatement(sql, cancellationFlag) {
  return executeWithProgressHandler(() => {
    const sourceStatement = prepareSingleStatement(sql);
    const headers = sourceStatement.getColumnNames();
    sourceStatement.free();
    const transportQuery = buildExactNumericTextQuery(sql, headers.length);
    const statement = prepareSingleStatement(transportQuery.sql);
    const sourceRows = [];
    try {
      while (statement.step()) {
        sourceRows.push(statement.get(null, { useBigInt: true }));
      }
      const { rows, exactIntegerTexts } = normalizeIntegerRowsForTransport(
        sourceRows,
        transportQuery.valueColumnCount
      );
      return { headers, rows, exactIntegerTexts };
    } finally {
      statement.free();
    }
  }, cancellationFlag);
}

function resolveGlobalFilterColumns(columns, globalFilterColumns) {
  if (globalFilterColumns != null) return globalFilterColumns;

  const fallbackColumns = columns ?? [];
  // Only the leading rowid that this worker prepends for table identity is
  // synthetic. An explicitly supplied list may legitimately name a declared
  // column "rowid" and must be trusted verbatim.
  return fallbackColumns[0] === 'rowid' ? fallbackColumns.slice(1) : fallbackColumns;
}

function safeRollbackSavepoint(savepointName, context) {
  try {
    runSingleStatement(`ROLLBACK TO ${savepointName}`);
    runSingleStatement(`RELEASE ${savepointName}`);
  } catch (rollbackError) {
    console.warn(`Failed to rollback savepoint (${context}):`, rollbackError);
  }
}

function rememberClosedCellReadSession(sessionId) {
  closedCellReadSessionIds.add(sessionId);
  while (closedCellReadSessionIds.size > 64) {
    closedCellReadSessionIds.delete(closedCellReadSessionIds.values().next().value);
  }
}

function rollbackAndReleaseCellReadSavepoint(savepointName) {
  runSingleStatement(`ROLLBACK TO ${savepointName}`);
  runSingleStatement(`RELEASE ${savepointName}`);
}

function closeActiveCellReadSession(expectedSessionId) {
  const session = activeCellReadSession;
  if (!session) return false;
  if (expectedSessionId !== undefined && session.sessionId !== expectedSessionId) return false;

  activeCellReadSession = null;
  rememberClosedCellReadSession(session.sessionId);
  if (session.expiryTimer !== undefined) clearTimeout(session.expiryTimer);
  try {
    runSingleStatement(`RELEASE ${session.savepointName}`);
  } catch (releaseError) {
    try {
      rollbackAndReleaseCellReadSavepoint(session.savepointName);
    } catch (rollbackError) {
      // Closing the only connection is the final fail-closed release mechanism:
      // a damaged bracket must never retain a snapshot indefinitely.
      const cleanupErrors = [releaseError, rollbackError];
      try {
        db?.close();
      } catch (closeError) {
        cleanupErrors.push(closeError);
      } finally {
        db = null;
      }
      throw new AggregateError(
        cleanupErrors,
        'Cell read snapshot cleanup failed; the owning web database was closed'
      );
    }
  }
  return true;
}

function scheduleCellReadSessionExpiry(session) {
  if (session.expiryTimer !== undefined) clearTimeout(session.expiryTimer);
  session.expiresAt = Math.min(
    session.absoluteExpiresAt,
    session.lastAccessAt + cellReadSessionIdleTimeoutMs
  );
  session.expiryTimer = setTimeout(() => {
    try {
      closeActiveCellReadSession(session.sessionId);
    } catch (error) {
      console.error('[Worker] Failed to expire cell read session:', error);
    }
  }, Math.max(1, session.expiresAt - Date.now()));
}

async function resolveCellReadSqlTarget(target) {
  validateCellReadTarget(target);
  const identity = await resolveTableIdentity(target.table);
  const predicate = buildRecordIdentityPredicate(target.rowId, identity);
  return {
    table: target.table,
    column: target.column,
    predicateSql: predicate.sql,
    predicateParams: predicate.params
  };
}

function queryCellMetadata(target, sqlTarget) {
  const query = buildCellMetadataQuery(sqlTarget);
  const result = db.exec(
    query.sql,
    normalizeBindParams(query.params),
    { useBigInt: true }
  );
  const encodingResult = db.exec('PRAGMA encoding');
  const textEncoding = normalizeCellTextEncoding(encodingResult[0]?.values?.[0]?.[0]);
  return decodeCellMetadata(result[0]?.values ?? [], textEncoding, target);
}

async function getCellMetadata(target) {
  if (!db) throw new Error('No database initialized');
  const sqlTarget = await resolveCellReadSqlTarget(target);
  return queryCellMetadata(target, sqlTarget);
}

async function openCellReadSession(target) {
  if (!db) throw new Error('No database initialized');
  if (activeCellReadSession) {
    throw new Error('At most one web cell read session may be open');
  }
  const sqlTarget = await resolveCellReadSqlTarget(target);
  const savepointName = createViewSavepointName('sp_cell_read');
  runSingleStatement(`SAVEPOINT ${savepointName}`);
  try {
    // This first read fixes sql.js's connection snapshot before returning.
    const metadata = queryCellMetadata(target, sqlTarget);
    const now = Date.now();
    const session = {
      sessionId: crypto.randomUUID(),
      target,
      sqlTarget,
      metadata,
      savepointName,
      lastAccessAt: now,
      absoluteExpiresAt: now + cellReadSessionAbsoluteTimeoutMs,
      expiresAt: now + cellReadSessionIdleTimeoutMs,
      expiryTimer: undefined
    };
    activeCellReadSession = session;
    scheduleCellReadSessionExpiry(session);
    return {
      sessionId: session.sessionId,
      metadata,
      expiresAt: session.expiresAt
    };
  } catch (error) {
    try {
      rollbackAndReleaseCellReadSavepoint(savepointName);
    } catch (cleanupError) {
      const cleanupErrors = [error, cleanupError];
      try {
        db?.close();
      } catch (closeError) {
        cleanupErrors.push(closeError);
      } finally {
        db = null;
      }
      throw new AggregateError(
        cleanupErrors,
        'Cell read session open failed; the owning web database was closed'
      );
    }
    throw error;
  }
}

async function readCellChunk(sessionId, byteOffset, maxBytes) {
  validateCellReadWindow(byteOffset, maxBytes);
  const session = activeCellReadSession;
  if (!session || session.sessionId !== sessionId) {
    throw new Error(
      closedCellReadSessionIds.has(sessionId)
        ? `Cell read session ${sessionId} is closed or expired`
        : `Unknown cell read session: ${String(sessionId)}`
    );
  }
  if (Date.now() >= session.expiresAt) {
    closeActiveCellReadSession(sessionId);
    throw new Error(`Cell read session ${sessionId} is closed or expired`);
  }
  const query = buildCellChunkQuery(session.sqlTarget);
  const result = db.exec(
    query.sql,
    normalizeBindParams([byteOffset, maxBytes, ...query.params])
  );
  const rows = result[0]?.values ?? [];
  if (rows.length !== 1) {
    throw new Error(
      rows.length === 0
        ? `Cell ${session.target.table}.${session.target.column} no longer exists in its snapshot`
        : `Cell ${session.target.table}.${session.target.column} matched more than one row`
    );
  }
  const value = rows[0][0];
  const bytes = value === null ? new Uint8Array(0) : value;
  if (!(bytes instanceof Uint8Array)) {
    throw new Error(
      `SQLite returned a non-BLOB chunk for ${session.target.table}.${session.target.column}`
    );
  }
  session.lastAccessAt = Date.now();
  scheduleCellReadSessionExpiry(session);
  return {
    byteOffset,
    bytes: bytes.slice(),
    done: byteOffset + bytes.byteLength >= session.metadata.byteLength
  };
}

async function closeCellReadSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('Cell read session id is required');
  }
  if (!closeActiveCellReadSession(sessionId) && !closedCellReadSessionIds.has(sessionId)) {
    throw new Error(`Unknown cell read session: ${sessionId}`);
  }
}

function assertCellReadSessionAllowsMethod(targetMethod) {
  if (
    activeCellReadSession &&
    !['readCellChunk', 'closeCellReadSession', 'initializeDatabase'].includes(targetMethod)
  ) {
    throw new Error('A cell read snapshot is active; close it before another database operation');
  }
}

// ============================================================================
// Database Operations
// ============================================================================

/**
 * True for File-like handles posted by the demo page. Duck-typed rather
 * than `instanceof File` so the unit harness can drive this path with a
 * stub File class from outside the worker realm.
 *
 * @param {unknown} candidate
 * @returns {candidate is File}
 */
function isFileLike(candidate) {
  return !!candidate
    && typeof candidate === 'object'
    && typeof (/** @type {File} */ (candidate).slice) === 'function'
    && typeof (/** @type {File} */ (candidate).size) === 'number';
}

/**
 * Host I/O adapter shared by both paged database variants: serves absolute-
 * offset reads of the File through FileReaderSync. Blob.slice clamps overhangs,
 * so reads at EOF come back short — the paged VFS zero-fills and reports
 * the short read to SQLite per the VFS contract. The size is pinned at
 * open time: Chromium invalidates a File snapshot whose backing file
 * changes on disk, making later reads throw, which the VFS surfaces as
 * an I/O error rather than serving torn pages.
 *
 * Reads go through the shared chunked read cache
 * (src/core/chunked-read-cache.ts): the flat FileReaderSync per-call cost
 * dominates per-4KB-page reads, so SQLite's page requests are coalesced
 * into 64KiB host reads. The cache is created per open (this function is
 * called once per initializeDatabase) and dropped with the handle.
 *
 * @param {File} file
 * @param {FileReaderSync} reader
 */
function createFileHostIo(file, reader) {
  const size = file.size;
  const read = createChunkedReadCache((offset, length) => new Uint8Array(
    reader.readAsArrayBuffer(file.slice(offset, offset + length))
  ));
  return {
    size: () => size,
    read
  };
}

/**
 * Resolve optional open-routing limit overrides from the init config.
 * Bounds tuning is compile-time (src/core/paged-open.ts); these exist so
 * tests can exercise the ladder without multi-GB fixtures.
 *
 * @param {Object} config
 * @returns {{pagedThresholdBytes?: number, bufferCeilingBytes?: number}}
 */
function resolveOpenLimits(config) {
  const limits = {};
  if (config.pagedOpenThresholdBytes !== undefined) {
    limits.pagedThresholdBytes = config.pagedOpenThresholdBytes;
  }
  if (config.bufferOpenCeilingBytes !== undefined) {
    limits.bufferCeilingBytes = config.bufferOpenCeilingBytes;
  }
  return limits;
}

/**
 * Resolve the hard merged-image download ceiling. The override is internal
 * test plumbing; production stays pinned to the measured browser ArrayBuffer
 * ceiling and callers cannot raise it beyond that bound.
 *
 * @param {unknown} value
 * @returns {number}
 */
function resolvePagedExportMaxBytes(value) {
  if (value === undefined) return BUFFER_OPEN_CEILING_BYTES;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('pagedExportMaxBytes must be a positive safe integer');
  }
  if (value > BUFFER_OPEN_CEILING_BYTES) {
    throw new Error(
      `pagedExportMaxBytes must not exceed ${BUFFER_OPEN_CEILING_BYTES} bytes`
    );
  }
  return value;
}

/** Preserve useful messages from worker, VM, and browser exception realms. */
function getErrorMessage(error) {
  return error
    && typeof error === 'object'
    && typeof error.message === 'string'
    ? error.message
    : String(error);
}

/**
 * Initialize a new database from binary content or a File handle.
 *
 * @param {string} filename - Display name for the database
 * @param {Object} config - Configuration object
 * @param {Uint8Array} [config.content] - SQLite database binary content
 * @param {File} [config.file] - Database file handle; opens page-on-demand
 *   with a copy-on-write overlay when large and the runtime supports it,
 *   otherwise degrades through read-only paging to the buffer path
 * @param {Uint8Array} [config.wasmBinary] - Optional WASM binary
 * @returns {Promise<Object>} Database handle info
 */
async function initializeDatabase(filename, config) {
  // Close existing database
  closeActiveCellReadSession();
  if (db) {
    db.close();
    db = null;
  }

  queryTimeout = Number.isFinite(config.queryTimeout) && config.queryTimeout > 0
    ? config.queryTimeout
    : DEFAULT_QUERY_TIMEOUT_MS;
  readOnlyMode = config.readOnlyMode === true;
  readOnlyReason = null;
  storageMode = 'memory';
  pagedFileSizeBytes = 0;
  pagedExportMaxBytes = resolvePagedExportMaxBytes(config.pagedExportMaxBytes);
  pagedExactCountMaxFileBytes = resolvePagedExactCountMaxFileBytes(
    config.pagedExactCountMaxFileBytes
  );
  cellReadSessionIdleTimeoutMs = normalizeCellReadTimeout(
    config.cellReadSessionIdleTimeoutMs,
    DEFAULT_CELL_READ_SESSION_IDLE_TIMEOUT_MS
  );
  cellReadSessionAbsoluteTimeoutMs = normalizeCellReadTimeout(
    config.cellReadSessionAbsoluteTimeoutMs,
    DEFAULT_CELL_READ_SESSION_ABSOLUTE_TIMEOUT_MS
  );
  closedCellReadSessionIds.clear();

  // Initialize sql.js with WASM
  if (!SQL) {
    // Load sql.js script
    importScripts(SQL_JS_GLUE_URL);

    // Initialize with WASM binary if provided
    const sqlConfig = {};
    if (config.wasmBinary) {
      sqlConfig.wasmBinary = config.wasmBinary;
    } else {
      sqlConfig.locateFile = () => SQL_JS_WASM_URL;
    }

    SQL = await self.initSqlJs(sqlConfig);
  }

  // Create the database. A File handle runs the open ladder (WAL sniff,
  // then paged-vs-buffer by size — see src/core/paged-open.ts); inline
  // bytes keep today's buffer path unchanged.
  if (isFileLike(config.file)) {
    storageMode = openDatabaseFromFile(config.file, resolveOpenLimits(config));
  } else if (config.content && config.content.length > 0) {
    db = new SQL.Database(config.content);
  } else {
    // Create empty database
    db = new SQL.Database();
  }
  if (readOnlyMode) {
    // Defense in depth for every current and future RPC path. Public mutators
    // still fail early with operation-specific errors, while SQLite itself
    // refuses an accidentally unguarded write on this connection. Read-only
    // paged databases are additionally immutable at the VFS level.
    db.run('PRAGMA query_only = ON');
  }

  return {
    operations: {},
    isReadOnly: readOnlyMode,
    storage: storageMode,
    ...(readOnlyReason ? { readOnlyReason } : {})
  };
}

/**
 * Open a database from a File handle, choosing between the paged
 * (page-on-demand, writable when supported) and buffer (in-memory) paths.
 *
 * Sets the module-level `db`, and widens `readOnlyMode` when the chosen
 * path is a read-only one (read-only paged fallback, or WAL-marked above
 * the paged threshold). Writable paging is preferred for an editable open;
 * failure degrades to read-only openPaged, then re-enters the ladder with
 * paging unavailable. Oversized files therefore fail with one clear message
 * instead of an opaque reader error or a doomed multi-GB allocation.
 *
 * @param {File} file
 * @param {{pagedThresholdBytes?: number, bufferCeilingBytes?: number}} limits
 * @returns {'paged' | 'memory'} storage mode actually opened
 */
function openDatabaseFromFile(file, limits) {
  const reader = new FileReaderSync();
  const header = new Uint8Array(
    reader.readAsArrayBuffer(file.slice(0, SQLITE_HEADER_PROBE_BYTES))
  );
  const canOpenPagedWritable = !readOnlyMode
    && typeof SQL.Database.openPagedWritable === 'function';
  const canOpenPagedReadOnly = typeof SQL.Database.openPaged === 'function';
  const input = {
    sizeBytes: file.size,
    walMarked: isWalMarkedHeader(header),
    pagedAvailable: canOpenPagedWritable || canOpenPagedReadOnly
  };

  let plan = decideOpenPlan(input, limits);
  let pagedFailure = null;
  if (plan.mode === 'paged') {
    const writablePagedMaxBytes = Math.min(
      pagedExportMaxBytes,
      limits.bufferCeilingBytes ?? BUFFER_OPEN_CEILING_BYTES
    );
    const exceedsWritableSaveLimit = file.size > writablePagedMaxBytes;
    const forcedReadOnlyReason = !readOnlyMode && exceedsWritableSaveLimit
      ? `This database exceeds the ${writablePagedMaxBytes}-byte browser save limit ` +
        'and is open read-only so edits cannot be stranded. Use the desktop extension ' +
        'to edit and save it.'
      : null;
    // Both VFS variants use exactly the same guarded/cached reader. The
    // writable fork layers changed pages in host memory; base reads remain
    // pinned to the File snapshot captured above.
    const hostIo = createFileHostIo(file, reader);
    const failures = [];
    if (canOpenPagedWritable && !exceedsWritableSaveLimit) {
      try {
        db = SQL.Database.openPagedWritable(hostIo);
        pagedFileSizeBytes = file.size;
        return 'paged';
      } catch (error) {
        const message = getErrorMessage(error);
        failures.push(`writable paged open failed: ${message}`);
        db = null;
      }
    }
    if (canOpenPagedReadOnly) {
      try {
        db = SQL.Database.openPaged(hostIo);
        readOnlyMode = true;
        // Download is the demo's only persistence path. Publish the notice only
        // after the read-only fallback actually wins; a safe buffer fallback may
        // still remain available under test-configured limits.
        readOnlyReason = forcedReadOnlyReason;
        pagedFileSizeBytes = file.size;
        return 'paged';
      } catch (error) {
        const message = getErrorMessage(error);
        failures.push(`read-only paged open failed: ${message}`);
        db = null;
      }
    }
    // Fall back exactly as if paging were absent; keep the causes for the
    // oversized-rejection message below.
    pagedFailure = failures.length > 0 ? new Error(failures.join('; ')) : null;
    plan = decideOpenPlan({ ...input, pagedAvailable: false }, limits);
  }
  if (plan.mode === 'reject') {
    throw new Error(
      pagedFailure
        ? `${plan.message} (paged open failed: ${pagedFailure.message})`
        : plan.message
    );
  }
  db = new SQL.Database(new Uint8Array(reader.readAsArrayBuffer(file)));
  if (plan.readOnly) readOnlyMode = true;
  return 'memory';
}

/**
 * Execute a SQL query and return results.
 *
 * @param {string} sql - SQL statement to execute
 * @param {Array} [params] - Bound parameters
 * @returns {Promise<Array>} Array of result sets
 */
async function runQuery(sql, params = [], cancellationFlag) {
  if (!db) throw new Error('No database initialized');
  if (readOnlyMode) {
    // This low-level test/debug RPC accepts arbitrary SQL, so there is no safe
    // statement-level capability distinction to infer in JavaScript.
    throw new Error('Ad hoc SQL execution is unavailable because the database is read-only');
  }

  try {
    const results = executeWithProgressHandler(
      () => db.exec(sql, params),
      cancellationFlag
    );

    // Convert to our result format
    return results.map(result => ({
      headers: result.columns,
      rows: result.values
    }));
  } catch (error) {
    console.error('[Worker] Query error:', error);
    throw error;
  }
}

/**
 * Export the database to binary.
 *
 * @param {string} _name - Database name (ignored, uses 'main')
 * @returns {Promise<Uint8Array>} Binary database content
 */
async function exportDatabase(_name) {
  if (!db) throw new Error('No database initialized');
  const writablePaged = storageMode === 'paged' && !readOnlyMode;
  if (storageMode === 'paged' && readOnlyMode) {
    throw new Error(
      'paged databases are read-only snapshots; export() is only available ' +
      'on openPagedWritable instances'
    );
  }
  const limitError = () => new Error(
    'Cannot download this page-on-demand database: the merged image would ' +
    `exceed the ${pagedExportMaxBytes}-byte browser memory limit. Saving ` +
    'materializes the complete database in memory; use the desktop extension ' +
    'or reduce the database size.'
  );
  if (writablePaged && pagedFileSizeBytes > pagedExportMaxBytes) {
    throw limitError();
  }

  let exported;
  try {
    exported = db.export();
  } catch (error) {
    const message = getErrorMessage(error);
    if (writablePaged && /transaction is open|while a transaction/i.test(message)) {
      throw new Error(
        'Cannot save while a database transaction is open; retry after the edit completes.',
        { cause: error }
      );
    }
    throw error;
  }
  // Inserts can grow the merged image beyond the snapshotted base size. This
  // post-check cannot undo the allocation, but it prevents another oversized
  // transfer/Blob allocation and keeps the external limit exact.
  if (writablePaged && exported.byteLength > pagedExportMaxBytes) {
    throw limitError();
  }
  return exported;
}

/**
 * Export a table to various formats (CSV, JSON, SQL).
 * The worker RPC is request/response only: it cannot progressively transfer a
 * download. Keep the honest bounded fallback explicit by refusing a worst-case
 * source/output estimate above 16 MiB, then return small assembly chunks rather
 * than one monolithic string. The desktop extension owns genuinely streamed
 * exports.
 *
 * @param {Object} dbParams - Database parameters with 'table' property
 * @param {Array<string>} columns - Columns to export
 * @param {Object} _dbOptions - Database options (unused)
 * @param {Object} _tableStore - Table store (unused)
 * @param {Object} exportOptions - Export options including 'format'
 * @returns {Promise<Object>} Export result with contentChunks and filename
 */
async function exportTable(dbParams, columns, _dbOptions, _tableStore, exportOptions = {}) {
  if (!db) throw new Error('No database initialized');

  const table = dbParams?.table;
  if (!table) throw new Error('No table specified');

  const { format = 'csv', header = true, includeTableName = true, rowIds = null } = exportOptions;
  if (!['csv', 'json', 'sql', 'excel'].includes(format)) {
    throw new Error(`Unsupported export format: ${format}`);
  }
  let whereSql = '';
  let params = [];

  // Filter by rowIds if specified
  if (rowIds && rowIds.length > 0) {
    const identity = await resolveTableIdentity(table);
    if (rowIds.some(isPrimaryKeyRecordId) && !rowIds.every(isPrimaryKeyRecordId)) {
      throw new Error('Cannot mix rowid and primary-key row identities');
    }
    const predicate = buildRecordIdentitiesPredicate(rowIds, identity);
    whereSql = ` WHERE ${predicate.sql}`;
    params = predicate.params;
  }

  const selectedColumns = columns && columns.length > 0
    ? columns
    : getExportProjectionColumns(table);
  assertWebDemoExportWithinLimit(table, selectedColumns, whereSql, params);

  // Project exact INTEGER text and raw TEXT bytes at the SQLite boundary.
  // Raw sql.js values can round int64 and truncate strings at the first NUL.
  const projection = selectedColumns.flatMap((column, index) => {
    const identifier = escapeIdentifier(column);
    const storageClass = `typeof(${identifier})`;
    const value =
      `CASE WHEN ${storageClass} = 'integer' THEN CAST(${identifier} AS TEXT) ` +
      `WHEN ${storageClass} = 'text' THEN CAST(${identifier} AS BLOB) ` +
      `ELSE ${identifier} END`;
    return [
      `${storageClass} AS ${escapeIdentifier(`__export_type_${index}`)}`,
      `${value} AS ${escapeIdentifier(`__export_value_${index}`)}`
    ];
  }).join(', ');
  const sql =
    `SELECT ${projection} FROM ${escapeIdentifier(table)}${whereSql}`;
  const results = db.exec(sql, params);

  if (results.length === 0) {
    return { contentChunks: [], filename: `${table}.${format}`, mimeType: 'text/plain' };
  }

  const headers = selectedColumns;
  const textEncoding = normalizeCellTextEncoding(
    db.exec('PRAGMA encoding')[0]?.values?.[0]?.[0]
  );
  const textDecoder = new TextDecoder(textEncoding, { fatal: true });
  const storageClasses = new Set(['null', 'integer', 'real', 'text', 'blob']);
  const rows = results[0].values.map(row => selectedColumns.map((column, index) => {
    const storageClass = row[index * 2];
    if (typeof storageClass !== 'string' || !storageClasses.has(storageClass)) {
      throw new Error(`SQLite returned an invalid storage class for ${table}.${column}`);
    }
    const rawValue = row[index * 2 + 1];
    let value = rawValue;
    if (storageClass === 'text') {
      if (!(rawValue instanceof Uint8Array)) {
        throw new Error(`SQLite returned invalid TEXT bytes for ${table}.${column}`);
      }
      value = textDecoder.decode(rawValue);
    }
    if (storageClass === 'null' && value !== null) {
      throw new Error(`SQLite returned a value for NULL cell ${table}.${column}`);
    }
    return { storageClass, value };
  }));

  const output = new WebDemoExportChunkCollector();
  let mimeType = 'text/plain';
  let filename = `${table}.${format}`;

  switch (format) {
    case 'csv':
      exportToCsv(headers, rows, header, output);
      mimeType = 'text/csv';
      break;
    case 'json':
      exportToJson(headers, rows, output);
      mimeType = 'application/json';
      break;
    case 'sql':
      exportToSql(table, headers, rows, includeTableName, output);
      mimeType = 'text/sql';
      break;
    case 'excel':
      // For Excel, just use CSV format (Excel can open CSV)
      exportToCsv(headers, rows, header, output);
      mimeType = 'text/csv';
      filename = `${table}.csv`;
      break;
  }

  return { contentChunks: output.finish(), filename, mimeType };
}

function webDemoExportLimitError() {
  return new Error(
    `Web demo exports are limited to ${WEB_DEMO_EXPORT_LIMIT_DESCRIPTION} because ` +
    'the worker RPC cannot stream downloads; use the desktop extension for larger exports.'
  );
}

function getExportProjectionColumns(table) {
  const statement = db.prepare(`SELECT * FROM ${escapeIdentifier(table)} LIMIT 0`);
  try {
    return statement.getColumnNames();
  } finally {
    statement.free();
  }
}

function assertWebDemoExportWithinLimit(table, columns, whereSql, params) {
  const estimateCells = columns.map(column => {
    const identifier = escapeIdentifier(column);
    return `CASE typeof(${identifier}) ` +
      `WHEN 'text' THEN length(CAST(${identifier} AS BLOB)) * 6 + 64 ` +
      `WHEN 'blob' THEN length(${identifier}) + 64 ELSE 64 END`;
  }).join(' + ') || '0';
  const result = db.exec(
    `SELECT COUNT(*), COALESCE(SUM(${estimateCells}), 0) ` +
    `FROM ${escapeIdentifier(table)}${whereSql}`,
    params
  );
  const row = result[0]?.values?.[0] ?? [0, 0];
  const rowCount = Number(row[0]);
  const estimatedBytes = Number(row[1]) + rowCount * 128 + 1024;
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes > WEB_DEMO_EXPORT_MAX_BYTES) {
    throw webDemoExportLimitError();
  }
}

function utf8ByteLength(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

class WebDemoExportChunkCollector {
  constructor() {
    this.chunks = [];
    this.pending = '';
    this.outputBytes = 0;
  }

  append(value) {
    this.outputBytes += utf8ByteLength(value);
    if (!Number.isSafeInteger(this.outputBytes) || this.outputBytes > WEB_DEMO_EXPORT_MAX_BYTES) {
      throw webDemoExportLimitError();
    }

    let offset = 0;
    while (offset < value.length) {
      let take = Math.min(
        WEB_DEMO_EXPORT_CHUNK_CHARS - this.pending.length,
        value.length - offset
      );
      const boundary = offset + take;
      if (
        boundary < value.length &&
        take > 0 &&
        value.charCodeAt(boundary - 1) >= 0xd800 &&
        value.charCodeAt(boundary - 1) <= 0xdbff &&
        value.charCodeAt(boundary) >= 0xdc00 &&
        value.charCodeAt(boundary) <= 0xdfff
      ) {
        take--;
      }
      if (take === 0) {
        this.flush();
        continue;
      }
      this.pending += value.slice(offset, offset + take);
      offset += take;
      if (this.pending.length >= WEB_DEMO_EXPORT_CHUNK_CHARS) this.flush();
    }
  }

  flush() {
    if (this.pending.length > 0) {
      this.chunks.push(this.pending);
      this.pending = '';
    }
  }

  finish() {
    this.flush();
    return this.chunks;
  }
}

/**
 * Convert data to CSV format.
 */
function exportToCsv(headers, rows, includeHeader, output) {
  let wroteLine = false;
  const writeLine = cells => {
    if (wroteLine) output.append('\n');
    output.append(cells.join(','));
    wroteLine = true;
  };
  if (includeHeader) {
    writeLine(headers.map(value => encodeCsvExportCell({
      storageClass: 'text',
      value
    })));
  }
  for (const row of rows) {
    writeLine(row.map(encodeCsvExportCell));
  }
}

/**
 * Convert data to JSON format.
 */
function exportToJson(headers, rows, output) {
  output.append('[');
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    const obj = {};
    for (let i = 0; i < headers.length; i++) {
      obj[headers[i]] = row[i];
    }
    output.append(rowIndex === 0 ? '\n' : ',\n');
    const keys = Object.keys(obj);
    if (keys.length === 0) {
      output.append('  {}');
      continue;
    }
    output.append('  {\n');
    keys.forEach((key, keyIndex) => {
      if (keyIndex > 0) output.append(',\n');
      output.append(`    ${JSON.stringify(key)}: ${encodeJsonExportCell(obj[key])}`);
    });
    output.append('\n  }');
  }
  output.append(rows.length === 0 ? ']' : '\n]');
}

/**
 * Convert data to SQL INSERT statements.
 */
function exportToSql(table, headers, rows, includeTableName, output) {
  const tableName = includeTableName ? escapeIdentifier(table) : '"table_name"';
  const columnList = headers.map(escapeIdentifier).join(', ');

  rows.forEach((row, rowIndex) => {
    const values = row.map(encodeSqlExportCell).join(', ');
    if (rowIndex > 0) output.append('\n');
    output.append(`INSERT INTO ${tableName} (${columnList}) VALUES (${values});`);
  });
}

async function findTableIdentity(table) {
  const metadata = db.exec(
    `SELECT "type", "wr" FROM pragma_table_list ` +
    `WHERE "schema" = 'main' AND "name" = ? LIMIT 1`,
    [table]
  );
  if ((metadata[0]?.values.length ?? 0) === 0) return undefined;
  const kind = classifyTableIdentity(metadata[0].values[0][0], metadata[0].values[0][1]);
  if (!kind) return undefined;
  if (kind === 'rowid') return { kind: 'rowid' };
  const columns = primaryKeyColumnsFromTableInfo(await getTableInfo(table));
  if (columns.length === 0) {
    throw new Error(`WITHOUT ROWID table ${table} has no declared primary key`);
  }
  return { kind: 'primaryKey', columns };
}

async function resolveTableIdentity(table) {
  const identity = await findTableIdentity(table);
  if (!identity) throw new Error(`Table not found: ${table}`);
  return identity;
}

function readPrimaryKeyRecordId(table, identity, predicate) {
  const result = db.exec(
    `SELECT ${identity.columns.map(column => escapeIdentifier(column.identifier)).join(', ')} ` +
    `FROM ${escapeIdentifier(table)} WHERE ${predicate.sql} LIMIT 2`,
    normalizeBindParams(predicate.params),
    { useBigInt: true }
  );
  const rows = result[0]?.values ?? [];
  if (rows.length !== 1) {
    throw new Error(
      rows.length === 0
        ? `Updated row in ${table} no longer exists`
        : `Primary-key identity for ${table} matched more than one row`
    );
  }
  return encodePrimaryKeyRecordId(identity.columns, rows[0]);
}

function applyJsonPatchValue(currentValue, patch) {
  const currentObject = parseJsonValueForPatching(currentValue, 'updateCellBatch');
  const patchObject = typeof patch === 'string' ? JSON.parse(patch) : patch;
  return JSON.stringify(applyMergePatch(currentObject, patchObject));
}

/**
 * Fetch table data with pagination and filtering.
 *
 * @param {string} table - Table name
 * @param {Object} options - Query options
 * @returns {Promise<Object>} Result set with headers and rows
 */
async function fetchTableData(table, options = {}) {
  if (!db) throw new Error('No database initialized');

  const {
    columns = null,
    offset = 0,
    limit = 1000,
    orderBy = null,
    orderDir = 'ASC',
    filters = [],
    globalFilter = '',
    globalFilterColumns = null
  } = options;

  let projectionColumns = columns;
  let effectiveOrderBy = orderBy;
  let identityOrderBy = null;
  let primaryKeyContext;
  let tableIdentity;
  let isRowIdTable = false;
  if (columns?.[0]?.toLowerCase() === 'rowid') {
    tableIdentity = await findTableIdentity(table);
    if (tableIdentity?.kind === 'primaryKey') {
      const identity = tableIdentity;
      const visibleColumns = columns.slice(1);
      const hiddenPrimaryKeyColumns = identity.columns
        .map(column => column.identifier)
        .filter(column => !visibleColumns.includes(column));
      projectionColumns = [...visibleColumns, ...hiddenPrimaryKeyColumns];
      primaryKeyContext = { identity, visibleColumns };
      if (effectiveOrderBy?.toLowerCase() === 'rowid') {
        effectiveOrderBy = null;
        identityOrderBy = identity.columns.map(column => column.identifier);
      }
    } else if (tableIdentity?.kind === 'rowid') {
      // Keyset seeks and anchors require an unshadowed intrinsic rowid; a
      // declared rowid/_rowid_/oid column would make "rowid" nullable,
      // non-unique table data. The demo owns a private in-memory database,
      // so this early read matches the fetch below.
      const authority = db.exec(ROWID_TABLE_AUTHORITY_SQL, [table, table]);
      isRowIdTable = (authority[0]?.values.length ?? 0) > 0;
    }
  }
  const keysetIdentity = tableIdentity?.kind === 'primaryKey'
    ? tableIdentity
    : (isRowIdTable ? tableIdentity : undefined);
  const keysetKey = computeKeysetKey(options, keysetIdentity);
  const keysetTag = keysetKey ? computeKeysetQueryTag(table, options) : undefined;
  const keysetPlan = keysetKey ? resolveKeysetPlan(table, options, keysetIdentity) : undefined;

  // Build column list - if columns specified, use them; otherwise SELECT *
  let columnList;
  if (projectionColumns && projectionColumns.length > 0) {
    columnList = projectionColumns.map(escapeIdentifier).join(', ');
  } else {
    columnList = '*';
  }

  let sql = `SELECT ${columnList} FROM ${escapeIdentifier(table)}`;

  // Build WHERE clause from filters array and globalFilter
  const whereClauses = [];
  let params = [];

  // Column-specific filters: [{column: 'name', value: 'foo'}, ...]
  if (filters && filters.length > 0) {
    for (const f of filters) {
      const filterValue = getActiveFilterValue(f.value);
      if (f.column && filterValue !== undefined) {
        whereClauses.push(`${escapeIdentifier(f.column)} LIKE ? ESCAPE '\\'`);
        params.push(`%${escapeLikePattern(filterValue)}%`);
      }
    }
  }

  // Global filter: search across all text columns
  const activeGlobalFilter = getActiveFilterValue(globalFilter);
  if (activeGlobalFilter !== undefined) {
    // Get column names to search
    const searchCols = resolveGlobalFilterColumns(columns, globalFilterColumns);
    if (searchCols.length > 0) {
      const globalClauses = searchCols.map(c => (
        `${escapeIdentifier(c)} LIKE ? ESCAPE '\\'`
      ));
      whereClauses.push(`(${globalClauses.join(' OR ')})`);
      // Add the global filter parameter for each column in the OR clause
      for (let i = 0; i < searchCols.length; i++) {
        params.push(`%${escapeLikePattern(activeGlobalFilter)}%`);
      }
    }
  }

  if (keysetPlan) {
    // Validated seek: the shared assembly owns WHERE, ORDER BY, and LIMIT so
    // this worker cannot drift from the extension engines. Any invalid or
    // stale request resolved to no plan and takes the unchanged path below.
    const assembled = assembleKeysetSelect({
      selectListSql: columnList,
      escapedTable: escapeIdentifier(table),
      whereClauses,
      filterParams: params,
      plan: keysetPlan
    });
    sql = assembled.sql;
    params = assembled.params;
  } else {
    if (whereClauses.length > 0) {
      sql += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    // Add ordering. One total order for both paths: an anchorable query's
    // OFFSET fallback adopts the exact keyset ORDER BY (full key columns,
    // key direction) so keyset and OFFSET pages interleave in one session
    // without skips or duplicates. keysetKey is gated on the early authority
    // read above, so shadowed-rowid tables and views keep the pre-keyset SQL
    // byte-identical.
    const fallbackOrder = keysetFallbackOrder(keysetKey, keysetPlan);
    const orderedColumns = fallbackOrder
      ? fallbackOrder.orderByColumns
      : (identityOrderBy ?? (effectiveOrderBy ? [effectiveOrderBy] : []));
    if (orderedColumns.length > 0) {
      const direction = fallbackOrder
        ? fallbackOrder.orderDir
        : (orderDir === 'DESC' ? 'DESC' : 'ASC');
      sql += ` ORDER BY ${orderedColumns
        .map(column => `${escapeIdentifier(column)} ${direction}`)
        .join(', ')}`;
    }

    // Add pagination
    sql += ` LIMIT ${parseInt(limit, 10)} OFFSET ${parseInt(offset, 10)}`;
  }

  const sourceStatement = db.prepare(sql, params);
  const headers = sourceStatement.getColumnNames();
  sourceStatement.free();
  const requestedCellLimit = Number.isSafeInteger(options.maxInlineCellBytes)
    && options.maxInlineCellBytes > 0
    ? options.maxInlineCellBytes
    : DEFAULT_MAX_INLINE_CELL_BYTES;
  const requestedPageLimit = Number.isSafeInteger(options.maxPageResponseBytes)
    && options.maxPageResponseBytes > 0
    ? options.maxPageResponseBytes
    : DEFAULT_MAX_PAGE_RESPONSE_BYTES;
  const containmentOptions = {
    limit: parseInt(limit, 10),
    maxInlineCellBytes: Math.min(DEFAULT_MAX_INLINE_CELL_BYTES, requestedCellLimit),
    maxPageResponseBytes: Math.min(DEFAULT_MAX_PAGE_RESPONSE_BYTES, requestedPageLimit)
  };
  const containmentQuery = buildCellContainmentQuery(
    sql,
    headers.length,
    containmentOptions
  );
  const transportQuery = buildExactNumericTextQuery(
    containmentQuery.sql,
    headers.length + 1
  );
  const results = db.exec(transportQuery.sql, params, { useBigInt: true });

  const sourceRows = results[0]?.values ?? [];
  const companionResults = [];
  const hasRowIdShape = headers[0]?.toLowerCase() === 'rowid';
  const needsExactRowIdIdentity = hasRowIdShape
    && hasUnsafeBigIntAtColumn(sourceRows, 0);
  const needsRowIdCompanions = transportQuery.valueColumnCount === undefined
    && hasRowIdShape;
  // The demo owns a private in-memory database, so no external process can
  // commit between the source read and this authority/companion work. The
  // early keyset-eligibility read above may have settled isRowIdTable already.
  if (
    !isRowIdTable
    && (needsRowIdCompanions || needsExactRowIdIdentity)
    && sourceRows.length > 0
  ) {
    const authority = db.exec(ROWID_TABLE_AUTHORITY_SQL, [table, table]);
    isRowIdTable = (authority[0]?.values.length ?? 0) > 0;
  }
  if (isRowIdTable && needsRowIdCompanions) {
    for (const query of buildRowIdExactRealTextQueries(
      table,
      headers,
      sourceRows.map(row => row[0])
    )) {
      const result = db.exec(query.sql, query.params, { useBigInt: true });
      companionResults.push({ query, rows: result[0]?.values ?? [] });
    }
  }
  const companionExactTexts = collectRowIdExactRealTexts(sourceRows, companionResults);
  const normalized = normalizeIntegerRowsForTransport(
    sourceRows,
    transportQuery.valueColumnCount,
    companionExactTexts,
    isRowIdTable && needsExactRowIdIdentity ? 0 : undefined
  );
  const contained = decodeCellContainment(
    normalized.rows,
    headers.length,
    normalized.exactIntegerTexts,
    containmentOptions.maxPageResponseBytes
  );
  const { rows, oversizedCells, exactIntegerTexts } = contained;
  // Anchors come from the exact source rows (BigInt-preserving, display order)
  // so every OFFSET or keyset page re-anchors itself.
  const keysetAnchors = keysetKey && keysetTag !== undefined
    ? mintKeysetAnchors({
        tag: keysetTag,
        key: keysetKey,
        projectionColumns: headers,
        rows: sourceRows,
        oversizedCells
      })
    : undefined;
  if (primaryKeyContext) {
    const visibleColumnCount = primaryKeyContext.visibleColumns.length;
    const remapped = remapPrimaryKeyContainment({
      identity: primaryKeyContext.identity,
      sourceColumns: headers,
      visibleColumnCount,
      identityRows: sourceRows,
      rows,
      oversizedCells,
      exactIntegerTexts,
      effectiveInlineCellBytes: containmentQuery.effectiveInlineCellBytes,
      rowOffset: parseInt(offset, 10)
    });
    return {
      headers: ['rowid', ...primaryKeyContext.visibleColumns],
      rows: remapped.rows,
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
    rows,
    exactIntegerTexts,
    ...(oversizedCells ? { oversizedCells } : {}),
    ...(keysetAnchors ? { keysetAnchors } : {})
  };
}

/**
 * Count rows in a table.
 *
 * @param {string} table - Table name
 * @param {Object} options - Query options
 * @returns {Promise<number>} Row count
 */
async function fetchTableCount(table, options = {}) {
  if (!db) throw new Error('No database initialized');

  const {
    columns = [],
    filters = [],
    globalFilter = '',
    globalFilterColumns = null
  } = options;

  let sql = `SELECT COUNT(*) FROM ${escapeIdentifier(table)}`;

  // Build WHERE clause from filters array and globalFilter
  const whereClauses = [];
  const params = [];

  // Column-specific filters
  if (filters && filters.length > 0) {
    for (const f of filters) {
      const filterValue = getActiveFilterValue(f.value);
      if (f.column && filterValue !== undefined) {
        whereClauses.push(`${escapeIdentifier(f.column)} LIKE ? ESCAPE '\\'`);
        params.push(`%${escapeLikePattern(filterValue)}%`);
      }
    }
  }

  // Global filter
  const activeGlobalFilter = getActiveFilterValue(globalFilter);
  if (activeGlobalFilter !== undefined) {
    const searchCols = resolveGlobalFilterColumns(columns, globalFilterColumns);
    if (searchCols.length > 0) {
      const globalClauses = searchCols.map(c => (
        `${escapeIdentifier(c)} LIKE ? ESCAPE '\\'`
      ));
      whereClauses.push(`(${globalClauses.join(' OR ')})`);
      // Add the global filter parameter for each column in the OR clause
      for (let i = 0; i < searchCols.length; i++) {
        params.push(`%${escapeLikePattern(activeGlobalFilter)}%`);
      }
    }
  }

  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(' AND ')}`;
  }

  // Shared paged count policy (src/core/paged-count.ts, also consumed by
  // the desktop WASM engine): large paged opens answer unfiltered counts
  // with the intrinsic-rowid span upper bound instead of an exact scan — OP_Count
  // never yields to the progress handler and a full b-tree scan through
  // per-page host callbacks wedges every queued RPC past the webview
  // deadline. Filtered counts have no cheap bound and keep exact semantics.
  const countPolicyInput = {
    storage: storageMode,
    filtered: whereClauses.length > 0,
    // Stage the cheap size/filter decision before paying for authority.
    authorityConfirmedRowIdTable: true,
    pagedFileSizeBytes,
    exactCountMaxFileBytes: pagedExactCountMaxFileBytes
  };
  if (shouldAnswerCountWithUpperBound(countPolicyInput)) {
    try {
      const authority = db.exec(ROWID_TABLE_AUTHORITY_SQL, [table, table]);
      const authorityConfirmedRowIdTable = (authority[0]?.values.length ?? 0) > 0;
      if (shouldAnswerCountWithUpperBound({
        ...countPolicyInput,
        authorityConfirmedRowIdTable
      })) {
        const upperBound = db.exec(buildCountUpperBoundSql(table));
        const resolvedUpperBound = resolveCountUpperBound(upperBound[0]?.values?.[0]);
        if (resolvedUpperBound !== undefined) return resolvedUpperBound;
      }
    } catch {
      // Authority or bound failures retain exact semantics.
    }
  }

  const results = db.exec(sql, params);

  if (results.length === 0 || results[0].values.length === 0) {
    return 0;
  }

  return results[0].values[0][0];
}

/**
 * Fetch database schema (tables, views, indexes).
 *
 * @returns {Promise<Object>} Schema snapshot
 */
async function fetchSchema() {
  if (!db) throw new Error('No database initialized');

  // Get tables
  // Note: Property names must match VS Code extension format (identifier, parentTable, etc.)
  const tablesResult = db.exec(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `);
  const identityResult = db.exec(TABLE_IDENTITY_METADATA_SQL);
  const identities = buildTableIdentityMap(identityResult[0]?.values || []);
  const tables = (tablesResult[0]?.values || []).map(row => {
    const identifier = row[0];
    const identity = identities.get(identifier);
    if (!identity) throw new Error(`Table not found: ${identifier}`);
    return { identifier, identity };
  });

  // Get views
  const viewsResult = db.exec(`
    SELECT name FROM sqlite_master
    WHERE type = 'view'
    ORDER BY name
  `);
  const views = (viewsResult[0]?.values || []).map(row => ({ identifier: row[0] }));

  // Get indexes
  const indexesResult = db.exec(`
    SELECT name, tbl_name FROM sqlite_master
    WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `);
  const indexes = (indexesResult[0]?.values || []).map(row => ({
    identifier: row[0],
    parentTable: row[1]
  }));

  return { tables, views, indexes };
}

/**
 * Get column information for a table.
 *
 * @param {string} table - Table name
 * @returns {Promise<Array>} Column metadata
 */
async function getTableInfo(table) {
  if (!db) throw new Error('No database initialized');

  const results = db.exec(`PRAGMA table_info(${escapeIdentifier(table)})`);

  if (results.length === 0) {
    return [];
  }

  // Property names must match VS Code extension format
  return results[0].values.map(row => ({
    ordinal: row[0],
    identifier: row[1],
    declaredType: row[2],
    isRequired: row[3],
    defaultExpression: row[4],
    primaryKeyPosition: row[5]
  }));
}

function getInsertableColumnNames(table) {
  const result = db.exec(
    'SELECT name FROM pragma_table_xinfo(?) ' +
    'WHERE hidden NOT IN (2, 3) ORDER BY cid',
    [table]
  );
  return (result[0]?.values ?? []).map(row => {
    if (typeof row[0] !== 'string') {
      throw new Error(`SQLite returned invalid column metadata for ${table}`);
    }
    return row[0];
  });
}

/**
 * Get current pragma values.
 *
 * @returns {Promise<Object>} Pragma key-value pairs
 */
async function getPragmas() {
  if (!db) throw new Error('No database initialized');

  const pragmas = {};
  const pragmaNames = [
    'foreign_keys',
    'journal_mode',
    'synchronous',
    'cache_size',
    'locking_mode',
    'temp_store',
    'encoding',
    'auto_vacuum'
  ];

  for (const name of pragmaNames) {
    try {
      const results = db.exec(`PRAGMA ${name}`);
      if (results.length > 0 && results[0].values.length > 0) {
        pragmas[name] = results[0].values[0][0];
      }
    } catch (e) {
      // Pragma not supported
    }
  }

  return pragmas;
}

/**
 * Set a pragma value.
 *
 * @param {string} pragma - Pragma name
 * @param {*} value - Pragma value
 */
async function setPragma(pragma, value) {
  if (!db) throw new Error('No database initialized');
  assertWritableMutation('Pragma updates');

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

  let sql;
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

  runSingleStatement(sql);
}

/**
 * Update a cell value.
 *
 * @param {string} table - Table name
 * @param {string|number} rowId - Row ID (rowid)
 * @param {string} column - Column name
 * @param {*} value - New value
 */
async function updateCell(
  table,
  rowId,
  column,
  value,
  _originalValue,
  maxEditValueBytes,
  historyReplayToken
) {
  const isHistoryReplay = historyReplayToken === HISTORY_REPLAY_EDIT_TOKEN;
  const enforcePriorPolicy = !isHistoryReplay && maxEditValueBytes !== undefined;
  const editLimitBytes = isHistoryReplay
    ? 0
    : assertCellValuesWithinEditLimit([value], maxEditValueBytes);
  assertMutableRecordId(rowId);
  if (!db) throw new Error('No database initialized');
  assertWritableMutation('Cell updates');

  if (isPrimaryKeyRecordId(rowId)) {
    const outcomes = await updateCellBatch(table, [{
      rowId,
      column,
      value,
      operation: 'set'
    }], undefined, maxEditValueBytes, historyReplayToken);
    return outcomes[0]?.newRowId ?? rowId;
  }

  const escapedColumn = escapeIdentifier(column);
  db.run(
    `UPDATE ${escapeIdentifier(table)} SET ${escapedColumn} = ` +
    `${bindPlaceholder(value)} WHERE rowid = ?` +
    (enforcePriorPolicy
      ? ` AND NOT (typeof(${escapedColumn}) IN ('text', 'blob') ` +
        `AND length(CAST(${escapedColumn} AS BLOB)) > ?)`
      : ''),
    normalizeBindParams(
      enforcePriorPolicy ? [value, rowId, editLimitBytes] : [value, rowId]
    )
  );
  if (enforcePriorPolicy) {
    const changes = db.exec('SELECT changes()')[0]?.values?.[0]?.[0];
    if (changes !== 1) {
      const metadata = await getCellMetadata({ table, rowId, column });
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
      throw new Error(`Cannot update ${table}.${column}: row ${rowId} no longer exists`);
    }
  }
  return validateRowId(rowId);
}

/** Exact-metadata compare-and-set that never selects the previous cell value. */
async function replaceOversizedCell(
  table,
  rowId,
  column,
  value,
  expected,
  maxEditValueBytes
) {
  const editLimitBytes = assertCellValuesWithinEditLimit(
    [value],
    maxEditValueBytes
  );
  assertOversizedCellReplacementExpectation(expected, editLimitBytes);
  assertMutableRecordId(rowId);
  if (!db) throw new Error('No database initialized');
  assertWritableMutation('Oversized cell replacement');

  const identity = await resolveTableIdentity(table);
  const predicate = buildRecordIdentityPredicate(rowId, identity);
  const escapedColumn = escapeIdentifier(column);
  const applyGuardedUpdate = () => {
    db.run(
      `UPDATE ${escapeIdentifier(table)} SET ${escapedColumn} = ${bindPlaceholder(value)} ` +
      `WHERE ${predicate.sql} AND typeof(${escapedColumn}) = ? ` +
      `AND length(CAST(${escapedColumn} AS BLOB)) = ?`,
      normalizeBindParams([
        value,
        ...predicate.params,
        expected.storageClass,
        expected.byteLength
      ])
    );
    const changes = db.exec('SELECT changes()')[0]?.values?.[0]?.[0];
    if (changes !== 1) throw new Error(OVERSIZED_CELL_REPLACEMENT_CONFLICT_MESSAGE);
    if (identity.kind === 'rowid') return validateRowId(rowId);

    const candidateValues = [...predicate.primaryKey.values];
    const keyIndex = identity.columns.findIndex(key => key.identifier === column);
    if (keyIndex >= 0) candidateValues[keyIndex] = value;
    const candidateId = encodePrimaryKeyRecordId(identity.columns, candidateValues);
    return readPrimaryKeyRecordId(
      table,
      identity,
      buildRecordIdentityPredicate(candidateId, identity)
    );
  };

  if (identity.kind === 'rowid') return applyGuardedUpdate();
  const savepointName = createViewSavepointName('sp_replace_oversized_cell');
  runSingleStatement(`SAVEPOINT ${savepointName}`);
  try {
    const newRowId = applyGuardedUpdate();
    runSingleStatement(`RELEASE ${savepointName}`);
    return newRowId;
  } catch (error) {
    safeRollbackSavepoint(savepointName, 'replaceOversizedCell');
    throw error;
  }
}

/**
 * Insert a new row.
 *
 * @param {string} table - Table name
 * @param {Object} data - Column-value pairs
 * @returns {Promise<number>} Inserted row ID
 */
async function insertRow(table, data, maxEditValueBytes, historyReplayToken) {
  if (!db) throw new Error('No database initialized');
  assertWritableMutation('Row insertion');
  if (historyReplayToken !== HISTORY_REPLAY_EDIT_TOKEN) {
    assertCellValuesWithinEditLimit(Object.values(data), maxEditValueBytes);
  }

  const columns = Object.keys(data);
  const values = Object.values(data);
  const identity = await resolveTableIdentity(table);

  let insertSql;

  if (columns.length === 0) {
    insertSql = `INSERT INTO ${escapeIdentifier(table)} DEFAULT VALUES`;
  } else {
    const columnList = columns.map(escapeIdentifier).join(', ');
    const placeholders = values.map(bindPlaceholder).join(', ');

    insertSql = `INSERT INTO ${escapeIdentifier(table)} (${columnList}) VALUES (${placeholders})`;
  }

  if (identity.kind === 'primaryKey') {
    const savepointName = createViewSavepointName('sp_insert_pk_row');
    runSingleStatement(`SAVEPOINT ${savepointName}`);
    try {
      const statement = db.prepare(
        `${insertSql} RETURNING ` +
        identity.columns.map(column => escapeIdentifier(column.identifier)).join(', '),
        normalizeBindParams(values)
      );
      let row;
      try {
        if (!statement.step()) {
          throw new Error(`Insert into ${table} did not return a primary-key identity`);
        }
        row = statement.get(null, { useBigInt: true });
        if (!row || statement.step()) {
          throw new Error(`Insert into ${table} did not return exactly one primary-key identity`);
        }
      } finally {
        statement.free();
      }
      const candidateId = encodePrimaryKeyRecordId(identity.columns, row);
      const rowId = readPrimaryKeyRecordId(
        table,
        identity,
        buildRecordIdentityPredicate(candidateId, identity)
      );
      runSingleStatement(`RELEASE ${savepointName}`);
      return rowId;
    } catch (error) {
      safeRollbackSavepoint(savepointName, 'insertPrimaryKeyRow');
      throw error;
    }
  }

  db.run(insertSql, normalizeBindParams(values));

  // Get last inserted row ID
  const result = db.exec('SELECT last_insert_rowid()');
  return result[0]?.values[0]?.[0] || null;
}

/**
 * Delete rows by ID.
 *
 * @param {string} table - Table name
 * @param {Array<string|number>} rowIds - Row IDs to delete
 */
async function deleteRows(table, rowIds) {
  rowIds.forEach(assertMutableRecordId);
  if (!db) throw new Error('No database initialized');
  assertWritableMutation('Row deletion');

  if (rowIds.length === 0) return [];

  if (rowIds.some(isPrimaryKeyRecordId)) {
    if (!rowIds.every(isPrimaryKeyRecordId)) {
      throw new Error('Cannot mix rowid and primary-key row identities');
    }
    const identity = await resolveTableIdentity(table);
    if (identity.kind !== 'primaryKey') {
      throw new Error(`Primary-key identity cannot target rowid table ${table}`);
    }
    const predicate = buildRecordIdentitiesPredicate(rowIds, identity);
    const savepointName = createViewSavepointName('sp_delete_pk_rows');
    runSingleStatement(`SAVEPOINT ${savepointName}`);
    try {
      const insertableColumns = getInsertableColumnNames(table);
      const current = db.exec(
        `SELECT ${insertableColumns.map(escapeIdentifier).join(', ')} ` +
        `FROM ${escapeIdentifier(table)} WHERE ${predicate.sql}`,
        normalizeBindParams(predicate.params),
        { useBigInt: true }
      )[0];
      const headers = current?.columns ?? [];
      const rows = current?.values ?? [];
      const primaryKeyIndices = identity.columns.map(column => {
        const index = headers.indexOf(column.identifier);
        if (index < 0) throw new Error(`Primary-key column missing from ${table}: ${column.identifier}`);
        return index;
      });
      const deletedRows = rows.map(row => ({
        rowId: encodePrimaryKeyRecordId(
          identity.columns,
          primaryKeyIndices.map(index => row[index])
        ),
        row: Object.fromEntries(headers.map((header, index) => [header, row[index]]))
      }));
      if (deletedRows.length !== rowIds.length) {
        throw new Error(`Cannot delete from ${table}: one or more row identities no longer exist`);
      }
      db.run(
        `DELETE FROM ${escapeIdentifier(table)} WHERE ${predicate.sql}`,
        normalizeBindParams(predicate.params)
      );
      runSingleStatement(`RELEASE ${savepointName}`);
      return deletedRows;
    } catch (error) {
      safeRollbackSavepoint(savepointName, 'deletePrimaryKeyRows');
      throw error;
    }
  }

  const validIds = rowIds.map(validateRowId);
  const placeholders = validIds.map(() => '?').join(', ');
  const savepointName = createViewSavepointName('sp_delete_rowid_rows');
  runSingleStatement(`SAVEPOINT ${savepointName}`);
  try {
    const insertableColumns = getInsertableColumnNames(table);
    const current = db.exec(
      `SELECT CAST(rowid AS TEXT), ${insertableColumns.map(escapeIdentifier).join(', ')} ` +
      `FROM ${escapeIdentifier(table)} WHERE rowid IN (${placeholders})`,
      normalizeBindParams(validIds),
      { useBigInt: true }
    )[0];
    const deletedRows = (current?.values ?? []).map(row => {
      const deletedRowId = validateRowId(row[0]);
      return {
        rowId: deletedRowId,
        row: {
          ...Object.fromEntries(
            insertableColumns.map((column, index) => [column, row[index + 1]])
          ),
          rowid: deletedRowId
        }
      };
    });
    if (deletedRows.length !== validIds.length) {
      throw new Error(`Cannot delete from ${table}: one or more row identities no longer exist`);
    }
    db.run(
      `DELETE FROM ${escapeIdentifier(table)} WHERE rowid IN (${placeholders})`,
      normalizeBindParams(validIds)
    );
    runSingleStatement(`RELEASE ${savepointName}`);
    return deletedRows;
  } catch (error) {
    safeRollbackSavepoint(savepointName, 'deleteRowidRows');
    throw error;
  }
}

/**
 * Delete columns from a table.
 * @param {string} table - Table name
 * @param {Array<string>} columns - Columns to delete
 * @param {Array<string>|undefined} dropDependentIndexes - Confirmed indexes to drop first
 */
async function deleteColumns(table, columns, dropDependentIndexes) {
  if (!db) throw new Error('No database initialized');
  assertWritableMutation('Column deletion');
  if (columns.length === 0) return;

  const savepointName = createViewSavepointName('sp_delete_columns');
  runSingleStatement(`SAVEPOINT ${savepointName}`);
  try {
    await executeSchemaPreservingColumnDrop(
      table,
      columns,
      dropDependentIndexes,
      sql => runSingleStatement(sql)
    );
    runSingleStatement(`RELEASE ${savepointName}`);
  } catch (e) {
    safeRollbackSavepoint(savepointName, 'deleteColumns');
    throw e;
  }
}

/**
 * Create a new table.
 *
 * @param {string} table - Table name
 * @param {Array<Object>} columns - Column definitions
 */
async function createTable(table, columns) {
  if (!db) throw new Error('No database initialized');
  assertWritableMutation('Table creation');

  const safeTable = table.replace(/"/g, '""');
  const columnDefs = columns.map(col => {
    const name = col.name.replace(/"/g, '""');
    const type = col.type || 'TEXT';

    validateSqlType(type);

    let def = `"${name}" ${type}`;
    if (col.pk) def += ' PRIMARY KEY';
    if (col.notnull) def += ' NOT NULL';
    if (col.defaultValue !== undefined && col.defaultValue !== null && col.defaultValue !== "") {
      def += ` DEFAULT ${formatDefaultValue(col.defaultValue)}`;
    }
    return def;
  }).join(', ');

  db.run(`CREATE TABLE "${safeTable}" (${columnDefs})`);
}

async function findViewDefinition(view, allowUnparsed = false) {
  if (!db) throw new Error('No database initialized');
  const viewResult = db.exec(
    "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = ?",
    [view]
  );
  const createSql = viewResult[0]?.values?.[0]?.[0];
  if (typeof createSql !== 'string') return null;

  const triggerRows = VIEW_TRIGGER_SCHEMA_QUERIES.map(source => (
    db.exec(source.sql, source.params(view))[0]?.values || []
  ));
  const { triggers, ambiguousTemporaryTriggerNames } = mapViewTriggerRows(
    view,
    triggerRows
  );

  let selectSql;
  let columnListSql;
  try {
    selectSql = extractViewSelectSql(createSql);
    columnListSql = extractViewColumnListSql(createSql);
  } catch (error) {
    if (!allowUnparsed) throw error;
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

async function readViewDefinition(view, allowUnparsed = false) {
  const definition = await findViewDefinition(view, allowUnparsed);
  if (!definition) throw new Error(`View not found: ${view}`);
  return definition;
}

async function getViewDefinition(view) {
  return readViewDefinition(view, false);
}

/** Resolve one canonical installed-view snapshot for intent checks and column preservation. */
function resolveExistingViewForIntent(view, intent) {
  const result = db.exec(
    "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = ?",
    [view]
  );
  const row = result[0]?.values?.[0];
  assertViewDefinitionIntent(view, row !== undefined, intent);
  const storedSql = row?.[0];
  return {
    storedSql,
    columnListSql: typeof storedSql === 'string'
      ? extractViewColumnListSql(storedSql)
      : undefined
  };
}

function assertWritableMutation(operation) {
  if (readOnlyMode) {
    throw new Error(`${operation} is unavailable because the database is read-only`);
  }
}

async function validateViewDefinition(view, selectSql, intent = 'edit') {
  if (!db) throw new Error('No database initialized');
  if (readOnlyMode) {
    throw new Error('View validation is unavailable because the database is read-only');
  }
  const body = normalizeViewSelectSql(selectSql);
  const { storedSql: existingSql, columnListSql } =
    resolveExistingViewForIntent(view, intent);
  const savepointName = createViewSavepointName('sp_validate_view');
  runSingleStatement(`SAVEPOINT ${savepointName}`);
  try {
    if (typeof existingSql === 'string') {
      runSingleStatement(`DROP VIEW ${escapeMainViewIdentifier(view)}`);
    }
    runSingleStatement(buildCreateViewSql(view, body, columnListSql));
    compileSingleStatement(`EXPLAIN SELECT * FROM ${escapeMainViewIdentifier(view)}`);
    runSingleStatement(`ROLLBACK TO ${savepointName}`);
    runSingleStatement(`RELEASE ${savepointName}`);
  } catch (error) {
    safeRollbackSavepoint(savepointName, 'validateViewDefinition');
    throw error;
  }
}

async function previewViewDefinition(
  view,
  selectSql,
  limit = 50,
  intent = 'edit',
  cancellationFlag
) {
  if (!db) throw new Error('No database initialized');
  const body = normalizeViewSelectSql(selectSql);
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 50));
  const { storedSql: existingSql, columnListSql } =
    resolveExistingViewForIntent(view, intent);

  if (readOnlyMode) {
    // Read-only demo databases cannot run disposable schema DDL. Match WASM's
    // target-named CTE fallback; writable previews below use the exact CREATE
    // VIEW context and therefore also catch schema-qualified self-references.
    const previewSource = escapeIdentifier(view);
    if (columnListSql) {
      return querySingleStatement(
        `WITH ${previewSource} ${columnListSql} AS (${body}\n) ` +
        `SELECT * FROM ${previewSource} LIMIT ${boundedLimit}`,
        cancellationFlag
      );
    }
    return querySingleStatement(
      `WITH ${previewSource} AS (${body}\n) ` +
      `SELECT * FROM ${previewSource} LIMIT ${boundedLimit}`,
      cancellationFlag
    );
  }

  const savepointName = createViewSavepointName('sp_preview_view');
  runSingleStatement(`SAVEPOINT ${savepointName}`);
  try {
    if (typeof existingSql === 'string') {
      runSingleStatement(`DROP VIEW ${escapeMainViewIdentifier(view)}`);
    }
    runSingleStatement(buildCreateViewSql(view, body, columnListSql));
    compileSingleStatement(`EXPLAIN SELECT * FROM ${escapeMainViewIdentifier(view)}`);
    const result = querySingleStatement(
      `SELECT * FROM ${escapeMainViewIdentifier(view)} LIMIT ${boundedLimit}`,
      cancellationFlag
    );
    runSingleStatement(`ROLLBACK TO ${savepointName}`);
    runSingleStatement(`RELEASE ${savepointName}`);
    return result;
  } catch (error) {
    safeRollbackSavepoint(savepointName, 'previewViewDefinition');
    throw error;
  }
}

async function createView(view, selectSql) {
  if (!db) throw new Error('No database initialized');
  assertWritableMutation('View creation');
  const body = normalizeViewSelectSql(selectSql);
  compileSingleStatement(`EXPLAIN SELECT * FROM (${body}\n) LIMIT 0`);
  const savepointName = createViewSavepointName('sp_create_view');
  runSingleStatement(`SAVEPOINT ${savepointName}`);
  try {
    runSingleStatement(buildCreateViewSql(view, body));
    compileSingleStatement(`EXPLAIN SELECT * FROM ${escapeMainViewIdentifier(view)}`);
    const definition = await getViewDefinition(view);
    runSingleStatement(`RELEASE ${savepointName}`);
    return definition;
  } catch (error) {
    safeRollbackSavepoint(savepointName, 'createView');
    throw error;
  }
}

async function editView(
  view,
  selectSql,
  preserveTriggers = true,
  expectedSql,
  expectedTriggers
) {
  if (!db) throw new Error('No database initialized');
  assertWritableMutation('View editing');
  const body = normalizeViewSelectSql(selectSql);
  compileSingleStatement(`EXPLAIN SELECT * FROM (${body}\n) LIMIT 0`);
  const savepointName = createViewSavepointName('sp_edit_view');
  runSingleStatement(`SAVEPOINT ${savepointName}`);
  try {
    const before = await getViewDefinition(view);
    assertViewTriggerSnapshotIsMutationSafe(before);
    assertViewDefinitionSnapshotCurrent(
      expectedSql,
      before.sql,
      expectedTriggers,
      before.triggers
    );
    runSingleStatement(`DROP VIEW ${escapeMainViewIdentifier(view)}`);
    runSingleStatement(buildCreateViewSql(view, body, before.columnListSql, before.columns));
    compileSingleStatement(`EXPLAIN SELECT * FROM ${escapeMainViewIdentifier(view)}`);
    if (preserveTriggers) {
      const columnResult = db.exec(`PRAGMA main.table_info(${escapeIdentifier(view)})`);
      const columns = (columnResult[0]?.values ?? []).map(row => {
        if (typeof row[1] !== 'string') {
          throw new Error(`SQLite returned invalid column metadata for view ${view}`);
        }
        return row[1];
      });
      assertViewTriggersCompatibleWithColumns(before.triggers, columns);
      for (const trigger of before.triggers) {
        runSingleStatement(buildCreateViewTriggerSql(trigger));
      }
    }
    const after = await getViewDefinition(view);
    runSingleStatement(`RELEASE ${savepointName}`);
    return { before, after };
  } catch (error) {
    safeRollbackSavepoint(savepointName, 'editView');
    throw error;
  }
}

async function dropView(view, expectedSql, expectedTriggers) {
  if (!db) throw new Error('No database initialized');
  assertWritableMutation('View deletion');
  const savepointName = createViewSavepointName('sp_drop_view');
  runSingleStatement(`SAVEPOINT ${savepointName}`);
  try {
    const before = await readViewDefinition(view, true);
    assertViewTriggerSnapshotIsMutationSafe(before);
    assertViewDefinitionSnapshotCurrent(
      expectedSql,
      before.sql,
      expectedTriggers,
      before.triggers
    );
    runSingleStatement(`DROP VIEW ${escapeMainViewIdentifier(view)}`);
    runSingleStatement(`RELEASE ${savepointName}`);
    return before;
  } catch (error) {
    safeRollbackSavepoint(savepointName, 'dropView');
    throw error;
  }
}

async function applyViewHistoryState(view, expectedCurrent, replacement) {
  assertWritableMutation('View history replay');
  const savepointName = createViewSavepointName('sp_restore_view');
  runSingleStatement(`SAVEPOINT ${savepointName}`);
  try {
    const current = await findViewDefinition(view, true);
    if (current) assertViewTriggerSnapshotIsMutationSafe(current);
    assertViewDefinitionStateCurrent(expectedCurrent, current);
    if (current) {
      runSingleStatement(`DROP VIEW ${escapeMainViewIdentifier(view)}`);
    }
    if (replacement) {
      runSingleStatement(replacement.sql);
      compileSingleStatement(
        `EXPLAIN SELECT * FROM ${escapeMainViewIdentifier(replacement.identifier)}`
      );
      for (const trigger of replacement.triggers) {
        runSingleStatement(buildCreateViewTriggerSql(trigger));
      }
    }
    runSingleStatement(`RELEASE ${savepointName}`);
  } catch (error) {
    safeRollbackSavepoint(savepointName, 'restoreViewDefinition');
    throw error;
  }
}

async function undoModification(modification) {
  const {
    modificationType,
    targetTable,
    viewDefBefore,
    viewDefAfter,
    affectedCells,
    targetRowId,
    newTargetRowId,
    targetColumn,
    priorValue,
    newValue,
    operation,
    deletedRows
  } = modification;
  if (!targetTable) return;
  switch (modificationType) {
    case 'cell_update': {
      const cells = affectedCells ?? (targetRowId !== undefined && targetColumn
        ? [{
            rowId: targetRowId,
            newRowId: newTargetRowId,
            columnName: targetColumn,
            priorValue,
            newValue,
            operation
          }]
        : []);
      const updates = [];
      // Reverse identity-changing batches so a key occupied by a later row is
      // vacated first, without reordering ordinary history replay.
      const hasIdentityTransition = cells.some(cell => (
        cell.newRowId !== undefined && cell.newRowId !== cell.rowId
      ));
      const undoCells = hasIdentityTransition ? [...cells].reverse() : cells;
      for (const cell of undoCells) {
        const currentRowId = cell.newRowId ?? cell.rowId;
        let value = cell.priorValue ?? null;
        if (cell.operation === 'json_patch') {
          const identity = isPrimaryKeyRecordId(currentRowId)
            ? await resolveTableIdentity(targetTable)
            : { kind: 'rowid' };
          const predicate = buildRecordIdentityPredicate(currentRowId, identity);
          const current = db.exec(
            `SELECT ${escapeIdentifier(cell.columnName)} FROM ${escapeIdentifier(targetTable)} ` +
            `WHERE ${predicate.sql}`,
            normalizeBindParams(predicate.params)
          );
          const currentValue = current[0]?.values[0]?.[0] ?? null;
          const plan = computeJsonPatchUndo(currentValue, cell.newValue, cell.priorValue);
          if (plan.kind === 'restore') value = plan.value;
        }
        updates.push({ rowId: currentRowId, column: cell.columnName, value });
      }
      await updateCellBatch(
        targetTable,
        updates,
        undefined,
        undefined,
        HISTORY_REPLAY_EDIT_TOKEN
      );
      return;
    }
    case 'row_insert':
      if (targetRowId !== undefined) await deleteRows(targetTable, [targetRowId]);
      return;
    case 'row_delete': {
      if (!deletedRows || deletedRows.length === 0) return;
      const savepointName = createViewSavepointName('sp_restore_deleted_rows');
      runSingleStatement(`SAVEPOINT ${savepointName}`);
      try {
        for (const deletedRow of deletedRows) {
          await insertRow(
            targetTable,
            deletedRow.row,
            undefined,
            HISTORY_REPLAY_EDIT_TOKEN
          );
        }
        runSingleStatement(`RELEASE ${savepointName}`);
      } catch (error) {
        safeRollbackSavepoint(savepointName, 'restoreDeletedRows');
        throw error;
      }
      return;
    }
    case 'view_create':
      if (viewDefAfter) {
        await applyViewHistoryState(targetTable, viewDefAfter, null);
      } else {
        console.warn('[DemoWorker] Skipping view undo: definition missing from history entry');
      }
      return;
    case 'view_edit':
      if (viewDefBefore && viewDefAfter) {
        await applyViewHistoryState(targetTable, viewDefAfter, viewDefBefore);
      } else {
        console.warn('[DemoWorker] Skipping view undo: definition missing from history entry');
      }
      return;
    case 'view_drop':
      if (viewDefBefore) {
        await applyViewHistoryState(targetTable, null, viewDefBefore);
      } else {
        console.warn('[DemoWorker] Skipping view undo: definition missing from history entry');
      }
      return;
    default:
      throw new Error(`Demo history replay does not support undoing ${String(modificationType)}`);
  }
}

async function redoModification(modification) {
  const {
    modificationType,
    targetTable,
    viewDefBefore,
    viewDefAfter,
    affectedCells,
    targetRowId,
    targetColumn,
    newValue,
    operation,
    rowData,
    affectedRowIds
  } = modification;
  if (!targetTable) return;
  switch (modificationType) {
    case 'cell_update': {
      const updates = affectedCells?.map(cell => ({
        rowId: cell.rowId,
        column: cell.columnName,
        value: cell.newValue ?? null,
        operation: cell.operation ?? 'set'
      })) ?? (targetRowId !== undefined && targetColumn
        ? [{
            rowId: targetRowId,
            column: targetColumn,
            value: newValue ?? null,
            operation: operation ?? 'set'
          }]
        : []);
      await updateCellBatch(
        targetTable,
        updates,
        undefined,
        undefined,
        HISTORY_REPLAY_EDIT_TOKEN
      );
      return;
    }
    case 'row_insert': {
      const dataToInsert = targetRowId !== undefined && !isPrimaryKeyRecordId(targetRowId)
        ? { rowid: targetRowId, ...(rowData ?? {}) }
        : (rowData ?? {});
      await insertRow(
        targetTable,
        dataToInsert,
        undefined,
        HISTORY_REPLAY_EDIT_TOKEN
      );
      return;
    }
    case 'row_delete':
      await deleteRows(targetTable, affectedRowIds ?? []);
      return;
    case 'view_create':
      if (viewDefAfter) {
        await applyViewHistoryState(targetTable, null, viewDefAfter);
      } else {
        console.warn('[DemoWorker] Skipping view redo: definition missing from history entry');
      }
      return;
    case 'view_edit':
      if (viewDefBefore && viewDefAfter) {
        await applyViewHistoryState(targetTable, viewDefBefore, viewDefAfter);
      } else {
        console.warn('[DemoWorker] Skipping view redo: definition missing from history entry');
      }
      return;
    case 'view_drop':
      if (viewDefBefore) {
        await applyViewHistoryState(targetTable, viewDefBefore, null);
      } else {
        console.warn('[DemoWorker] Skipping view redo: definition missing from history entry');
      }
      return;
    default:
      throw new Error(`Demo history replay does not support redoing ${String(modificationType)}`);
  }
}

/**
 * Batch update cells.
 *
 * @param {string} table - Table name
 * @param {Array<Object>} updates - Array of {rowId, column, value}
 */
async function updateCellBatch(
  table,
  updates,
  _label,
  maxEditValueBytes,
  historyReplayToken
) {
  updates.forEach(update => assertMutableRecordId(update.rowId));
  if (!db) throw new Error('No database initialized');
  assertWritableMutation('Batch cell updates');

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
    const identity = await resolveTableIdentity(table);
    if (identity.kind !== 'primaryKey') {
      throw new Error(`Primary-key identity cannot target rowid table ${table}`);
    }

    const savepointName = createViewSavepointName('sp_update_pk_batch');
    runSingleStatement(`SAVEPOINT ${savepointName}`);
    try {
      if (!isHistoryReplay && maxEditValueBytes !== undefined) {
        for (const update of updates) {
          const metadata = await getCellMetadata({
            table,
            rowId: update.rowId,
            column: update.column
          });
          if (
            (metadata.storageClass === 'text' || metadata.storageClass === 'blob')
            && metadata.byteLength > editLimitBytes
          ) {
            throw new OversizedCellReplacementRequiredError(
              table,
              update.column,
              metadata.storageClass,
              metadata.byteLength,
              editLimitBytes
            );
          }
        }
      }
      const updatesByRow = new Map();
      for (const update of updates) {
        const rowUpdates = updatesByRow.get(update.rowId) ?? [];
        rowUpdates.push(update);
        updatesByRow.set(update.rowId, rowUpdates);
      }

      const results = [];
      for (const [rowId, rowUpdates] of updatesByRow) {
        const oldPredicate = buildRecordIdentityPredicate(rowId, identity);
        const columns = [...new Set(rowUpdates.map(update => update.column))];
        if (columns.length !== rowUpdates.length) {
          throw new Error(`Batch update for ${table} contains the same column more than once`);
        }
        const current = db.exec(
          `SELECT ${columns.map(escapeIdentifier).join(', ')} ` +
          `FROM ${escapeIdentifier(table)} WHERE ${oldPredicate.sql} LIMIT 2`,
          normalizeBindParams(oldPredicate.params),
          { useBigInt: true }
        )[0];
        if ((current?.values.length ?? 0) !== 1) {
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
            ? applyJsonPatchValue(priorValue, prepared.value)
            : prepared.value;
          if (!isHistoryReplay && prepared.operation === 'json_patch') {
            // The resulting JSON can exceed the limit even when the patch does not.
            assertCellValueWithinEditLimit(storedValue, editLimitBytes);
          }
          return { update, priorValue, prepared, storedValue };
        });
        const setClause = preparedUpdates.map(({ update, storedValue }) => (
          `${escapeIdentifier(update.column)} = ${bindPlaceholder(storedValue)}`
        )).join(', ');
        db.run(
          `UPDATE ${escapeIdentifier(table)} SET ${setClause} WHERE ${oldPredicate.sql}`,
          normalizeBindParams([
            ...preparedUpdates.map(update => update.storedValue),
            ...oldPredicate.params
          ])
        );

        const candidateValues = [...oldPredicate.primaryKey.values];
        for (const preparedUpdate of preparedUpdates) {
          const keyIndex = identity.columns.findIndex(
            keyColumn => keyColumn.identifier === preparedUpdate.update.column
          );
          if (keyIndex >= 0) candidateValues[keyIndex] = preparedUpdate.storedValue;
        }
        const candidateId = encodePrimaryKeyRecordId(identity.columns, candidateValues);
        const newRowId = readPrimaryKeyRecordId(
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

      runSingleStatement(`RELEASE ${savepointName}`);
      return results;
    } catch (error) {
      safeRollbackSavepoint(savepointName, 'updatePrimaryKeyCellBatch');
      throw error;
    }
  }

  const savepointName = createViewSavepointName('sp_update_cell_batch');
  runSingleStatement(`SAVEPOINT ${savepointName}`);
  try {
    if (!isHistoryReplay && maxEditValueBytes !== undefined) {
      for (const update of updates) {
        const metadata = await getCellMetadata({
          table,
          rowId: update.rowId,
          column: update.column
        });
        if (
          (metadata.storageClass === 'text' || metadata.storageClass === 'blob')
          && metadata.byteLength > editLimitBytes
        ) {
          throw new OversizedCellReplacementRequiredError(
            table,
            update.column,
            metadata.storageClass,
            metadata.byteLength,
            editLimitBytes
          );
        }
      }
    }
    const rowIds = [...new Set(updates.map(update => validateRowId(update.rowId)))];
    const columns = [...new Set(updates.map(update => update.column))];
    const placeholders = rowIds.map(() => '?').join(', ');
    const escapedTable = escapeIdentifier(table);
    const currentResult = db.exec(
      `SELECT CAST(rowid AS TEXT), ${columns.map(escapeIdentifier).join(', ')} ` +
      `FROM ${escapedTable} WHERE rowid IN (${placeholders})`,
      rowIds,
      { useBigInt: true }
    )[0];
    const currentValues = new Map();
    for (const row of currentResult?.values ?? []) {
      const values = new Map();
      columns.forEach((column, index) => values.set(column, row[index + 1]));
      currentValues.set(String(validateRowId(row[0])), values);
    }
    const results = [];
    const processedUpdates = updates.map(update => {
      const rowId = validateRowId(update.rowId);
      const row = currentValues.get(String(rowId));
      if (!row) {
        throw new Error(`Cannot update ${table}.${update.column}: row ${update.rowId} no longer exists`);
      }
      const priorValue = row.get(update.column);
      const prepared = prepareCellUpdateForStorage(
        update.value,
        priorValue,
        update.operation ?? 'set'
      );
      if (!isHistoryReplay && prepared.operation === 'json_patch') {
        const storedValue = applyJsonPatchValue(priorValue, prepared.value);
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
    for (const update of processedUpdates) {
      const escapedColumn = escapeIdentifier(update.column);
      const sql = update.operation === 'json_patch'
        ? `UPDATE ${escapedTable} SET ${escapedColumn} = json_patch(COALESCE(${escapedColumn}, '{}'), ?) WHERE rowid = ?`
        : `UPDATE ${escapedTable} SET ${escapedColumn} = ${bindPlaceholder(update.value)} WHERE rowid = ?`;
      db.run(sql, normalizeBindParams([update.value, update.rowId]));
    }
    runSingleStatement(`RELEASE ${savepointName}`);
    return results;
  } catch (e) {
    safeRollbackSavepoint(savepointName, 'updateCellBatch');
    throw e;
  }
}

/**
 * Add a column to a table.
 *
 * @param {string} table - Table name
 * @param {string} column - Column name
 * @param {string} type - Column type
 * @param {string} [defaultValue] - Default value
 */
async function addColumn(table, column, type, defaultValue) {
  if (!db) throw new Error('No database initialized');
  assertWritableMutation('Column creation');

  validateSqlType(type);

  const safeTable = table.replace(/"/g, '""');
  const safeColumn = column.replace(/"/g, '""');

  let sql = `ALTER TABLE "${safeTable}" ADD COLUMN "${safeColumn}" ${type}`;
  if (defaultValue !== undefined && defaultValue !== null && defaultValue !== "") {
    sql += ` DEFAULT ${formatDefaultValue(defaultValue)}`;
  }

  db.run(sql);
}

/**
 * Ping to check if database is responsive.
 *
 * @returns {Promise<boolean>} True if responsive
 */
async function ping() {
  if (!db) return false;
  try {
    db.exec('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Refresh file from disk - no-op in web mode since there's no disk file.
 * Just returns success to satisfy the viewer's reload request.
 *
 * @returns {Promise<void>}
 */
async function refreshFile() {
  // In web demo, there's no file to refresh from
  // The database exists only in memory
  return;
}

/**
 * Fire an edit event - no-op in web mode.
 * VS Code extension uses this for undo/redo tracking.
 *
 * @param {Object} _edit - Edit details (ignored)
 * @returns {Promise<void>}
 */
async function fireEditEvent(_edit) {
  // No-op in web demo - no undo/redo integration
  return;
}

// ============================================================================
// RPC Message Handler
// ============================================================================

/**
 * Map of method names to handler functions.
 */
const methods = {
  initializeDatabase,
  runQuery,
  getCellMetadata,
  openCellReadSession,
  readCellChunk,
  closeCellReadSession,
  exportDatabase,
  exportTable,
  fetchTableData,
  fetchTableCount,
  fetchSchema,
  getTableInfo,
  getPragmas,
  setPragma,
  updateCell,
  replaceOversizedCell,
  insertRow,
  deleteRows,
  deleteColumns,
  createTable,
  getViewDefinition,
  validateViewDefinition,
  previewViewDefinition,
  createView,
  editView,
  dropView,
  undoModification,
  redoModification,
  updateCellBatch,
  addColumn,
  ping,
  refreshFile,
  fireEditEvent
};

/**
 * Handle incoming RPC messages from the main thread.
 */
self.onmessage = async (event) => {
  const envelope = event.data;

  // Validate message format
  if (!envelope || envelope.channel !== 'rpc' || !envelope.content) {
    console.warn('[Worker] Invalid message format:', envelope);
    return;
  }

  const { kind, messageId, targetMethod, payload } = envelope.content;

  // Only handle invoke messages
  if (kind !== 'invoke') {
    return;
  }

  // Find handler
  const handler = methods[targetMethod];
  if (!handler) {
    self.postMessage({
      channel: 'rpc',
      content: {
        kind: 'response',
        messageId,
        success: false,
        errorMessage: `Unknown method: ${targetMethod}`
      }
    });
    return;
  }

  // Execute handler
  try {
    assertCellReadSessionAllowsMethod(targetMethod);
    const result = await handler(...(payload || []));

    const response = {
      channel: 'rpc',
      content: {
        kind: 'response',
        messageId,
        success: true,
        data: result
      }
    };
    // A merged database image is already a dedicated Uint8Array from sql.js.
    // Transfer its buffer so the page does not retain a second structured-
    // clone copy before constructing the download Blob.
    if (targetMethod === 'exportDatabase' && result instanceof Uint8Array) {
      const transferableResult = result.byteOffset === 0
        && result.byteLength === result.buffer.byteLength
        && result.buffer instanceof ArrayBuffer
        ? result
        : result.slice();
      response.content.data = transferableResult;
      self.postMessage(response, [transferableResult.buffer]);
    } else {
      self.postMessage(response);
    }
  } catch (error) {
    console.error('[Worker] Method error:', targetMethod, error);

    const errorData = toCellEditRpcErrorData(error);
    self.postMessage({
      channel: 'rpc',
      content: {
        kind: 'response',
        messageId,
        success: false,
        errorMessage: error.message || 'Unknown error',
        ...(errorData ? { error: errorData } : {})
      }
    });
  }
};

// ============================================================================
// Worker Ready
// ============================================================================
