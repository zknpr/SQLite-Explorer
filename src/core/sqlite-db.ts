/**
 * SQLite Database Engine Module
 *
 * Slim public surface for the WASM engine. The implementation lives in
 * src/core/engine/wasm/WasmDatabaseEngine.ts; this file owns the factory
 * (createDatabaseEngine) and the worker-side endpoint that wires the
 * RPC dispatcher to the engine instance.
 *
 * WasmDatabaseEngine is re-exported so existing imports
 * (`import { WasmDatabaseEngine } from '.../core/sqlite-db'`) keep working.
 */

import type {
  CellValue,
  RecordId,
  DeletedRow,
  QueryResultSet,
  DatabaseInitConfig,
  DatabaseInitResult,
  CellUpdate,
  CellUpdateResult,
  TableQueryOptions,
  TableCountOptions,
  SchemaSnapshot,
  ColumnMetadata,
  ColumnDefinition,
  ModificationEntry,
  ViewDefinitionIntent,
  ViewTriggerDefinition,
  CellMetadata,
  CellReadChunk,
  CellReadSession,
  CellReadTarget,
  OversizedCellMetadata,
  DatabaseWriteResult
} from './types';
import { getNodeFs } from './platform/fs';
import {
  WasmDatabaseEngine,
  type WasmDatabaseInstance,
  type WasmEngineModule,
  type WasmEngineLogHandler,
  type WasmQueryCancellation
} from './engine/wasm/WasmDatabaseEngine';
import { createChunkedReadCache } from './chunked-read-cache';
import { resolvePagedExactCountMaxFileBytes } from './paged-count';
import { crypto } from '../platform/cryptoShim';
import {
  isWalMarkedHeader,
  patchWalHeaderToRollback,
  SQLITE_HEADER_PROBE_BYTES,
  WAL_HEADER_SIZE_BYTES
} from './paged-open';

export { WasmDatabaseEngine } from './engine/wasm/WasmDatabaseEngine';
export { getNodeFs } from './platform/fs';

// ============================================================================
// Database Factory
// ============================================================================

/**
 * Initialize the sql.js engine and create a database instance.
 *
 * @param config - Initialization configuration
 * @returns Database operations handle and read-only flag
 */
export async function createDatabaseEngine(
  config: DatabaseInitConfig,
  logger?: WasmEngineLogHandler
): Promise<DatabaseInitResult> {
  // Load the pinned fork directly so source tests and both esbuild worker
  // targets cannot silently resolve the stock npm runtime.
  const loadEngine = (await import('../../vendor/sql.js/sql-wasm.js')).default;

  // Configure WASM loading
  const engineConfig: Record<string, unknown> = {};
  if (config.wasmBinary && config.wasmBinary.byteLength > 0) {
    engineConfig.wasmBinary = config.wasmBinary;
  } else if (config.resourceMap?.['sqlite3.wasm']) {
    engineConfig.locateFile = () => config.resourceMap!['sqlite3.wasm'];
  }

  const SqlJsModule = await loadEngine(engineConfig) as unknown as WasmEngineModule;
  return createEngineFromModule(SqlJsModule, config, logger);
}

/**
 * Open a database on an already-initialized sql.js module.
 *
 * Split from createDatabaseEngine so tests can drive the open routing
 * (buffer vs paged vs rejection) against a module whose capabilities they
 * control — e.g. masking openPaged to pin the stale-vendored-build
 * fallback — while production always goes through createDatabaseEngine.
 */
export async function createEngineFromModule(
  SqlJsModule: WasmEngineModule,
  config: DatabaseInitConfig,
  logger?: WasmEngineLogHandler
): Promise<DatabaseInitResult> {
  // Create database instance
  let wasmInstance: WasmDatabaseInstance;
  let buffer = config.content;

  // If content is missing but filePath is provided, read from disk (Node.js only)
  // NOTE: this reads only the main database file — sql.js cannot merge a
  // sibling -wal file, so committed-but-uncheckpointed WAL frames would be
  // invisible here. The layer that owns file access (workerFactory) checks
  // for WAL data before handing over a filePath (or content bytes) and forces
  // readOnlyMode when it finds any; the only WAL awareness in the engine is
  // the paged fallback's defensive frame recheck (openPagedDatabaseEngine).
  //
  // A filePath that cannot be stat'd/read MUST fail the open. Falling through
  // to the empty-database branch below would show an empty writable view of a
  // real file, and a later save would overwrite that file with it — silent
  // data destruction if the host-side existence check raced a delete or
  // permission change. Only the explicit empty inputs (no filePath and
  // missing/zero-length content, or a filePath whose read yields zero bytes)
  // legitimately mean "start with a fresh empty database".
  if (!buffer && config.filePath) {
    // Dynamic require to avoid bundling fs in browser builds
    // In actual build, this code path only runs in Node worker
    const fs = getNodeFs();
    if (!fs) {
      throw new Error(
        `Failed to open database file '${config.filePath}': file system access is unavailable in this environment`
      );
    }
    try {
      const openOverLimitFile = (actualSize: number): DatabaseInitResult => {
        // Over the in-memory gate. Files this size used to be a hard
        // failure; when the host permits it and the vendored engine
        // carries the fork's paged APIs, editable documents prefer the
        // copy-on-write overlay. Stale builds degrade to read-only paging,
        // then exactly today's size-gate rejection.
        let pagedFailure: unknown;
        if (config.allowPagedFallback) {
          const modes: Array<'writable' | 'readOnly'> = [];
          if (
            config.readOnlyMode !== true
            && typeof SqlJsModule.Database.openPagedWritable === 'function'
          ) {
            modes.push('writable');
          }
          if (typeof SqlJsModule.Database.openPaged === 'function') {
            modes.push('readOnly');
          }
          for (const mode of modes) {
            try {
              return openPagedDatabaseEngine(
                SqlJsModule,
                fs,
                config.filePath!,
                config,
                mode,
                logger
              );
            } catch (pagedError) {
              pagedFailure = pagedError;
              logger?.(
                'warn',
                `${mode === 'writable' ? 'Writable p' : 'P'}age-on-demand open failed for `
                + `'${config.filePath}'; ${mode === 'writable' && modes.includes('readOnly')
                  ? 'trying the read-only paged fallback'
                  : 'falling back to the size-limit rejection'}:`,
                pagedError instanceof Error ? pagedError.message : String(pagedError)
              );
            }
          }
        }
        throw new Error(
          `file size (${actualSize} bytes) exceeds the maximum allowed size (${config.maxSize} bytes)`,
          pagedFailure === undefined ? undefined : { cause: pagedFailure }
        );
      };

      // Validate the metadata size first, then the bytes actually read. The
      // second gate closes the stat/read TOCTOU and distrusts providers that
      // return more data than their stat result advertised.
      const stats = await fs.promises.stat(config.filePath);
      if (config.maxSize > 0 && stats.size > config.maxSize) {
        return openOverLimitFile(stats.size);
      }
      buffer = await fs.promises.readFile(config.filePath);
      if (config.maxSize > 0 && buffer.byteLength > config.maxSize) {
        return openOverLimitFile(buffer.byteLength);
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Failed to open database file '${config.filePath}': ${reason}`,
        { cause: e }
      );
    }
  }

  // Byte-loading providers are outside this worker's trust boundary: their
  // read can exceed the metadata size checked by the host. With no local fd
  // to page from, the only safe outcome is the ordinary size rejection.
  if (buffer && config.maxSize > 0 && buffer.byteLength > config.maxSize) {
    throw new Error(
      `file size (${buffer.byteLength} bytes) exceeds the maximum allowed size (${config.maxSize} bytes)`
    );
  }

  if (buffer && buffer.byteLength > 0) {
    // Open existing database from binary
    // Avoid creating an intermediate copy

    const data = (buffer.buffer && buffer.byteLength === buffer.buffer.byteLength)
        ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        : buffer;

    wasmInstance = new SqlJsModule.Database(data);

    // Help GC
    buffer = null;
    config.content = null;
  } else {
    // Create new empty database
    wasmInstance = new SqlJsModule.Database();
  }

  const engine = new WasmDatabaseEngine(
    wasmInstance,
    config.queryTimeout,
    config.readOnlyMode ?? false,
    logger,
    {
      idleTimeoutMs: config.cellReadSessionIdleTimeoutMs,
      absoluteTimeoutMs: config.cellReadSessionAbsoluteTimeoutMs
    }
  );

  return {
    operations: engine,
    isReadOnly: config.readOnlyMode ?? false,
    storage: 'memory'
  };
}

type NodeFsModule = NonNullable<ReturnType<typeof getNodeFs>>;

interface PagedFileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  mode: bigint;
}

const PAGED_FILE_CHANGED_MESSAGE =
  'Database file changed on disk; reload the document.';

function pagedFileIdentityFromStats(stats: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  mode: bigint;
}): PagedFileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    mode: stats.mode
  };
}

function readPagedFileIdentity(fs: NodeFsModule, fd: number): PagedFileIdentity {
  return pagedFileIdentityFromStats(fs.fstatSync(fd, { bigint: true }));
}

function readPagedPathIdentity(fs: NodeFsModule, filePath: string): PagedFileIdentity {
  return pagedFileIdentityFromStats(fs.statSync(filePath, { bigint: true }));
}

function samePagedFileIdentity(
  expected: PagedFileIdentity,
  actual: PagedFileIdentity
): boolean {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.size === actual.size
    && expected.mtimeNs === actual.mtimeNs;
}

/**
 * Defensive re-check of the sibling `-wal` immediately before a paged
 * open. workerFactory's gate already rejected frame-bearing siblings
 * before permitting the fallback, but a frame could appear between that
 * check and this open (a writer showing up), and a snapshot taken then
 * would silently miss committed rows. Failing here routes the open into
 * the ordinary size-gate rejection instead.
 */
function assertNoSiblingWalFrames(fs: NodeFsModule, filePath: string): void {
  const walPath = `${filePath}-wal`;
  let walSize: number;
  try {
    walSize = fs.statSync(walPath).size;
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    // No sibling: there is no WAL state a main-file snapshot could miss.
    if (code === 'ENOENT') return;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `cannot verify WAL state of '${walPath}': ${reason}`,
      { cause: error }
    );
  }
  if (walSize > WAL_HEADER_SIZE_BYTES) {
    throw new Error(
      `sibling WAL file '${walPath}' holds uncheckpointed frames (${walSize} bytes); `
      + 'a page-on-demand snapshot of the main file would miss them'
    );
  }
}

/**
 * Open an over-limit local database page-on-demand. Writable opens keep all
 * changes in the fork's host-memory overlay; read-only opens retain the stage-0
 * behavior.
 *
 * The hostIo serves absolute-offset reads through a positional
 * fs.readSync loop over one long-lived file descriptor, wrapped in the
 * shared chunked read cache so SQLite's per-4KB-page reads coalesce into
 * 64KiB host reads (see src/core/chunked-read-cache.ts). The descriptor
 * lives exactly as long as the engine: it is closed on shutdown, and on
 * every failure path out of this function — openPaged throwing, engine
 * construction throwing — before the error propagates.
 */
function openPagedDatabaseEngine(
  SqlJsModule: WasmEngineModule,
  fs: NodeFsModule,
  filePath: string,
  config: DatabaseInitConfig,
  mode: 'writable' | 'readOnly',
  logger?: WasmEngineLogHandler
): DatabaseInitResult {
  assertNoSiblingWalFrames(fs, filePath);

  const fd = fs.openSync(filePath, 'r');
  let engineOwnsFd = false;
  let fdClosed = false;
  const closeFd = (context: string): void => {
    if (fdClosed) return;
    fdClosed = true;
    try {
      fs.closeSync(fd);
    } catch (closeError) {
      // Descriptor release must never mask the open's outcome.
      logger?.('warn', `Failed to close paged database file (${context}):`, closeError);
    }
  };

  try {
    const openedIdentity = readPagedFileIdentity(fs, fd);
    const canonicalBasePath = fs.realpathSync(filePath);
    const snapshotFileSizeBytes = Number(openedIdentity.size);
    if (!Number.isSafeInteger(snapshotFileSizeBytes) || snapshotFileSizeBytes < 0) {
      throw new Error(`paged database size is not a safe integer: ${openedIdentity.size}`);
    }
    let pagedReadError: Error | undefined;
    const assertFileGeneration = (): void => {
      if (pagedReadError) throw pagedReadError;
      let descriptorIdentity: PagedFileIdentity;
      let pathIdentity: PagedFileIdentity;
      try {
        descriptorIdentity = readPagedFileIdentity(fs, fd);
        pathIdentity = readPagedPathIdentity(fs, canonicalBasePath);
      } catch (error) {
        pagedReadError = new Error(PAGED_FILE_CHANGED_MESSAGE, { cause: error });
        throw pagedReadError;
      }
      if (
        !samePagedFileIdentity(openedIdentity, descriptorIdentity)
        || !samePagedFileIdentity(openedIdentity, pathIdentity)
      ) {
        pagedReadError = new Error(PAGED_FILE_CHANGED_MESSAGE);
        throw pagedReadError;
      }
    };

    // Positional reads (pread semantics) so no shared file-position state
    // exists. POSIX permits short reads, so loop until the request is
    // filled or EOF (readSync returning 0); the result is short exactly
    // when the request overruns EOF, which is the contract both the paged
    // VFS and the chunked cache are built on.
    const readFromFd = (offset: number, length: number): Uint8Array => {
      // createChunkedReadCache invokes this only on misses. Validate after
      // the read, before returning its bytes to the cache: this also closes
      // the fstat/read window where a writer could otherwise replace bytes
      // immediately after a successful pre-read check.
      if (pagedReadError) throw pagedReadError;
      const out = new Uint8Array(length);
      let filled = 0;
      while (filled < length) {
        const got = fs.readSync(fd, out, filled, length - filled, offset + filled);
        if (got === 0) break;
        filled += got;
      }
      assertFileGeneration();
      return filled === length ? out : out.subarray(0, filled);
    };

    // WAL-at-rest sniff (header bytes 18/19 == 0x02 0x02). Decision:
    // PAGEABLE. The sibling -wal has already been verified frame-free
    // (workerFactory's gate, plus assertNoSiblingWalFrames above), so the
    // main image alone is the complete committed state — there are no
    // invisible frames a snapshot could miss. The engine itself cannot be
    // relied on either way here: SQLite refuses to open a WAL-marked
    // database through a read-only VFS that cannot create the -shm
    // (SQLITE_CANTOPEN, observed with the pinned fork), so the hostIo
    // presents the header as rollback-journal (bytes 18/19 -> 0x01) — the
    // identical rewrite `PRAGMA journal_mode=DELETE` would persist, applied
    // to read results only, never to disk. Patching sits inside the cache
    // wrapper so chunk 0 is patched once when fetched.
    const headerProbe = readFromFd(0, SQLITE_HEADER_PROBE_BYTES);
    const walMarked = isWalMarkedHeader(headerProbe);
    const rawRead = walMarked
      ? (offset: number, length: number): Uint8Array => {
          const out = readFromFd(offset, length);
          patchWalHeaderToRollback(out, offset);
          return out;
        }
      : readFromFd;

    // Fresh cache per open: the paged file is an immutable snapshot from
    // the engine's viewpoint (size pinned below).
    const read = createChunkedReadCache(rawRead);

    // A WAL-marked main image is never writable through the overlay. Even with
    // a frame-free sibling, the header must be presented as rollback-journal;
    // retain the existing read-only paged behavior for that compatibility case.
    const writable = mode === 'writable' && !walMarked;
    const openPaged = writable
      ? SqlJsModule.Database.openPagedWritable
      : SqlJsModule.Database.openPaged;
    if (!openPaged) {
      throw new Error(
        writable
          ? 'Writable page-on-demand mode is unavailable'
          : 'Read-only page-on-demand mode is unavailable'
      );
    }
    const instance = openPaged({
      size: () => snapshotFileSizeBytes,
      read
    });
    try {
      // Close the stat/open race: a writer can create a frame-bearing WAL
      // while openPaged is initializing even when the pre-open stat missed it.
      assertNoSiblingWalFrames(fs, filePath);
      const engine = new WasmDatabaseEngine(
        instance,
        config.queryTimeout,
        !writable,
        logger,
        {
          idleTimeoutMs: config.cellReadSessionIdleTimeoutMs,
          absoluteTimeoutMs: config.cellReadSessionAbsoluteTimeoutMs
        },
        {
          writable,
          fileSizeBytes: snapshotFileSizeBytes,
          exactCountMaxFileBytes: resolvePagedExactCountMaxFileBytes(
            config.pagedExactCountMaxFileBytes
          ),
          getReadError: () => pagedReadError,
          assertBaseUnchanged: assertFileGeneration,
          ...(writable ? {
            writeDatabaseImage: (targetPath: string, data: Uint8Array) => {
              let canonicalTargetPath: string | undefined;
              try {
                canonicalTargetPath = fs.realpathSync(targetPath);
              } catch {
                // A new Save As target has no canonical path yet.
              }
              const targetNamesActiveBase = targetPath === filePath
                || targetPath === canonicalBasePath
                || canonicalTargetPath === canonicalBasePath;
              const targetSharesBaseInode = (() => {
                try {
                  const target = fs.statSync(targetPath, { bigint: true });
                  return target.dev === openedIdentity.dev && target.ino === openedIdentity.ino;
                } catch {
                  return false;
                }
              })();

              if (!targetNamesActiveBase && !targetSharesBaseInode) {
                fs.writeFileSync(targetPath, data);
                return { requiresReopen: false };
              }

              // Never write through any pathname that resolves to the frozen
              // base inode: a distinct hard link would mutate the bytes still
              // served by hostIo just as surely as the document path would.
              // Replace the selected link atomically, but reopen only when the
              // selected pathname is the active document base.
              const replacementPath = targetNamesActiveBase
                ? canonicalBasePath
                : canonicalTargetPath ?? targetPath;
              const requiresReopen = targetNamesActiveBase;

              // The temp lives beside its replacement target, so rename is a
              // same-filesystem atomic replacement. Keep it private while the
              // full merged image is being written, then restore base mode.
              const temporaryPath = `${replacementPath}.sqlite-explorer-`
                + `${crypto.randomUUID()}.tmp`;
              let temporaryFd: number | undefined;
              let renamed = false;
              try {
                assertFileGeneration();
                temporaryFd = fs.openSync(temporaryPath, 'wx', 0o600);
                let written = 0;
                while (written < data.byteLength) {
                  const count = fs.writeSync(
                    temporaryFd,
                    data,
                    written,
                    data.byteLength - written,
                    written
                  );
                  if (count <= 0) {
                    throw new Error('temporary database write made no progress');
                  }
                  written += count;
                }
                fs.fchmodSync(temporaryFd, Number(openedIdentity.mode & 0o777n));
                fs.fsyncSync(temporaryFd);
                fs.closeSync(temporaryFd);
                temporaryFd = undefined;
                // Refuse to overwrite an externally changed base, including
                // when export was served entirely from cached host chunks.
                assertFileGeneration();
                fs.renameSync(temporaryPath, replacementPath);
                renamed = true;
                return { requiresReopen };
              } catch (error) {
                if (temporaryFd !== undefined) {
                  try {
                    fs.closeSync(temporaryFd);
                  } catch (closeError) {
                    logger?.('warn', 'Failed to close paged save temp file:', closeError);
                  }
                }
                if (!renamed) {
                  try {
                    fs.unlinkSync(temporaryPath);
                  } catch (cleanupError) {
                    const code = (cleanupError as { code?: string }).code;
                    if (code !== 'ENOENT') {
                      logger?.('warn', 'Failed to remove paged save temp file:', cleanupError);
                    }
                  }
                }
                throw new Error(
                  `Failed to atomically save paged database '${targetPath}': `
                  + (error instanceof Error ? error.message : String(error)),
                  { cause: error }
                );
              }
            }
          } : {}),
          dispose: () => closeFd('shutdown')
        }
      );
      engineOwnsFd = true;
      return { operations: engine, isReadOnly: !writable, storage: 'paged' };
    } catch (engineError) {
      try {
        instance.close();
      } catch {
        // The construction error is the one that matters.
      }
      throw engineError;
    }
  } finally {
    if (!engineOwnsFd) closeFd('failed open');
  }
}

// ============================================================================
// Worker Entry Point
// ============================================================================

/**
 * Create a handler object for worker-side database operations.
 *
 * This factory creates an object with methods that can be exposed
 * to the extension host via the IPC module.
 */
export function createWorkerEndpoint(logger?: WasmEngineLogHandler) {
  let activeEngine: WasmDatabaseEngine | null = null;
  // Each caller receives its own result, but engine replacement itself is
  // ordered. Without this tail, concurrent RPCs all observe activeEngine=null
  // before their first await and every superseded paged engine leaks its fd.
  let initializationTail: Promise<void> = Promise.resolve();

  function requireEngine(): WasmDatabaseEngine {
    if (!activeEngine) throw new Error('No database initialized');
    return activeEngine;
  }

  async function initializeDatabase(
    filename: string,
    config: DatabaseInitConfig
  ): Promise<DatabaseInitResult> {
    const queued = initializationTail.then(async () => {
      // Shutdown existing engine if present. Clear the reference before the
      // await below: if createDatabaseEngine rejects (e.g. unreadable
      // filePath), requireEngine() must report "no database" instead of
      // handing out the already-shut-down engine.
      if (activeEngine) {
        activeEngine.shutdown();
        activeEngine = null;
      }

      const result = await createDatabaseEngine(config, logger);
      activeEngine = result.operations as WasmDatabaseEngine;

      // Return value is primarily used for the isReadOnly/storage flags.
      // The actual database operations are accessed via the worker endpoint methods below.
      return {
        isReadOnly: result.isReadOnly,
        storage: result.storage
      };
    });
    // A rejected initialization must not poison later queue entries.
    initializationTail = queued.then(() => undefined, () => undefined);
    return queued;
  }

  return {
    /**
     * Initialize a database from binary content. Overlapping calls are
     * serialized so every superseded engine is shut down before replacement.
     *
     * @param filename - Display name for the database
     * @param config - Initialization configuration
     * @returns Database handle and read-only status
     */
    initializeDatabase,

    /**
     * Execute a query on the active database.
     *
     * @param sql - SQL statement
     * @param params - Bound parameters
     * @returns Query result sets
     */
    async runQuery(
      sql: string,
      params?: CellValue[],
      cancellation?: WasmQueryCancellation
    ): Promise<QueryResultSet[]> {
      return requireEngine().executeQuery(sql, params, cancellation);
    },

    async getCellMetadata(target: CellReadTarget): Promise<CellMetadata> {
      return requireEngine().getCellMetadata(target);
    },

    async openCellReadSession(target: CellReadTarget): Promise<CellReadSession> {
      return requireEngine().openCellReadSession(target);
    },

    async readCellChunk(
      sessionId: string,
      byteOffset: number,
      maxBytes: number
    ): Promise<CellReadChunk> {
      return requireEngine().readCellChunk(sessionId, byteOffset, maxBytes);
    },

    async closeCellReadSession(sessionId: string): Promise<void> {
      return requireEngine().closeCellReadSession(sessionId);
    },

    /**
     * Export the active database to binary.
     *
     * @param name - Database name
     * @returns Binary content
     */
    async exportDatabase(): Promise<Uint8Array> {
      return requireEngine().serializeDatabase();
    },

    // Expose undo/history operations for the browser in-process facade, which
    // calls this endpoint directly instead of going through worker RPC.
    async applyModifications(mods: ModificationEntry[], signal?: AbortSignal): Promise<void> {
      return requireEngine().applyModifications(mods, signal);
    },

    async undoModification(mod: ModificationEntry): Promise<void> {
      return requireEngine().undoModification(mod);
    },

    async redoModification(mod: ModificationEntry): Promise<void> {
      return requireEngine().redoModification(mod);
    },

    async flushChanges(signal?: AbortSignal): Promise<void> {
      return requireEngine().flushChanges(signal);
    },

    async discardModifications(mods: ModificationEntry[], signal?: AbortSignal): Promise<void> {
      return requireEngine().discardModifications(mods, signal);
    },

    async updateCell(
      table: string,
      rowId: RecordId,
      column: string,
      value: CellValue,
      patch?: string,
      maxEditValueBytes?: number
    ): Promise<RecordId | void> {
      // Forward the optional JSON merge patch so browser/in-process cell edits
      // can update the current document instead of replacing it with stale data.
      return requireEngine().updateCell(
        table,
        rowId,
        column,
        value,
        patch,
        maxEditValueBytes
      );
    },

    async replaceOversizedCell(
      table: string,
      rowId: RecordId,
      column: string,
      value: CellValue,
      expected: OversizedCellMetadata,
      maxEditValueBytes?: number
    ): Promise<RecordId | void> {
      return requireEngine().replaceOversizedCell(
        table,
        rowId,
        column,
        value,
        expected,
        maxEditValueBytes
      );
    },

    async insertRow(
      table: string,
      data: Record<string, CellValue>,
      maxEditValueBytes?: number
    ): Promise<RecordId | undefined> {
      return requireEngine().insertRow(table, data, maxEditValueBytes);
    },

    async insertRowBatch(
      table: string,
      rows: Record<string, CellValue>[],
      maxEditValueBytes?: number
    ): Promise<void> {
      return requireEngine().insertRowBatch(table, rows, maxEditValueBytes);
    },

    async deleteRows(table: string, rowIds: RecordId[]): Promise<DeletedRow[] | void> {
      return requireEngine().deleteRows(table, rowIds);
    },

    async deleteColumns(table: string, columns: string[], dropDependentIndexes?: string[]): Promise<void> {
      return requireEngine().deleteColumns(table, columns, dropDependentIndexes);
    },

    async findDependentIndexes(table: string, columns: string[]): Promise<string[]> {
      return requireEngine().findDependentIndexes(table, columns);
    },

    async createTable(table: string, columns: ColumnDefinition[]): Promise<void> {
      return requireEngine().createTable(table, columns);
    },

    async getViewDefinition(view: string) {
      return requireEngine().getViewDefinition(view);
    },

    async validateViewDefinition(
      view: string,
      selectSql: string,
      intent?: ViewDefinitionIntent
    ): Promise<void> {
      return requireEngine().validateViewDefinition(view, selectSql, intent);
    },

    async previewViewDefinition(
      view: string,
      selectSql: string,
      limit?: number,
      intent?: ViewDefinitionIntent,
      cancellation?: WasmQueryCancellation
    ) {
      return requireEngine().previewViewDefinition(
        view,
        selectSql,
        limit,
        intent,
        cancellation
      );
    },

    async createView(view: string, selectSql: string) {
      return requireEngine().createView(view, selectSql);
    },

    async editView(
      view: string,
      selectSql: string,
      preserveTriggers?: boolean,
      expectedSql?: string,
      expectedTriggers?: readonly ViewTriggerDefinition[]
    ) {
      return requireEngine().editView(
        view,
        selectSql,
        preserveTriggers,
        expectedSql,
        expectedTriggers
      );
    },

    async dropView(
      view: string,
      expectedSql?: string,
      expectedTriggers?: readonly ViewTriggerDefinition[]
    ) {
      return requireEngine().dropView(view, expectedSql, expectedTriggers);
    },

    async updateCellBatch(
      table: string,
      updates: CellUpdate[],
      maxEditValueBytes?: number
    ): Promise<CellUpdateResult[]> {
      return requireEngine().updateCellBatch(table, updates, maxEditValueBytes);
    },

    async addColumn(table: string, column: string, type: string, defaultValue?: string): Promise<void> {
      return requireEngine().addColumn(table, column, type, defaultValue);
    },

    async fetchTableData(table: string, options: TableQueryOptions): Promise<QueryResultSet> {
      return requireEngine().fetchTableData(table, options);
    },

    async fetchTableCount(table: string, options: TableCountOptions): Promise<number> {
      return requireEngine().fetchTableCount(table, options);
    },

    async fetchSchema(): Promise<SchemaSnapshot> {
      return requireEngine().fetchSchema();
    },

    async getTableInfo(table: string): Promise<ColumnMetadata[]> {
      return requireEngine().getTableInfo(table);
    },

    async getPragmas(): Promise<Record<string, CellValue>> {
      return requireEngine().getPragmas();
    },

    async setPragma(pragma: string, value: CellValue): Promise<void> {
      return requireEngine().setPragma(pragma, value);
    },

    async ping(): Promise<boolean> {
      if (!activeEngine) return false;
      return activeEngine.ping();
    },

    async writeToFile(path: string): Promise<DatabaseWriteResult | void> {
      return requireEngine().writeToFile(path);
    },

    /**
     * Release the active engine and its underlying sql.js WASM heap.
     *
     * Safe to call when no database is active (no-op) and idempotent. The
     * in-process browser connection wires this to its bundle's [Symbol.dispose]
     * so closing a database frees the WASM instance instead of leaking it; the
     * Node worker path tears down the whole worker thread instead.
     */
    dispose(): void {
      if (activeEngine) {
        activeEngine.shutdown();
        activeEngine = null;
      }
    }
  };
}
