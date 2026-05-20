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
  TableQueryOptions,
  TableCountOptions,
  SchemaSnapshot,
  ColumnMetadata,
  ColumnDefinition,
  TableMetadata,
  ViewMetadata,
  IndexMetadata
} from './core/types';
import { escapeIdentifier, validateSqlType, validateRowId, validateRowIds } from './core/sql-utils';
import { buildSelectQuery, buildCountQuery } from './core/query-builder';

// ============================================================================
// Utility Functions
// ============================================================================

// Utility functions moved to src/core/sql-utils.ts

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
const QUERY_TIMEOUT = 30000;

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
class NativeWorkerProcess {
  private process: ChildProcess | null = null;
  private messageId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
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
   * @returns Promise resolving to the result
   */
  async call<T>(method: string, args: unknown[] = []): Promise<T> {
    if (!this.process || !this.process.stdin) {
      throw new Error('Native worker not running');
    }

    const id = ++this.messageId;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, QUERY_TIMEOUT);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout
      });

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
    const typedMsg = msg as { id?: number; result?: unknown; error?: string };

    if (typedMsg.id === undefined) {
      return;
    }

    const pending = this.pendingRequests.get(typedMsg.id);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(typedMsg.id);
    clearTimeout(pending.timeout);

    if (typedMsg.error) {
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
 * @returns Connection bundle with native worker
 */
export async function createNativeDatabaseConnection(
  extensionUri: vsc.Uri,
  _reporter?: TelemetryReporter
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
        throw new Error(`Failed to open database "${displayName}": ${message}. Path: ${filePath}`);
      }

      // Create operations facade
      const operationsFacade: DatabaseOperations = {
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

        serializeDatabase: async (_name: string): Promise<Uint8Array> => {
          const result = await worker.call<{ content: Uint8Array }>('export', []);
          return result.content;
        },

        applyModifications: async () => {},

        /**
         * Undo a modification by executing the inverse SQL.
         */
        undoModification: async (mod: ModificationEntry) => {
          const { modificationType, targetTable, targetRowId, targetColumn, priorValue, affectedCells, deletedRows, columnDef, deletedColumns } = mod;
          if (!targetTable) return;

          switch (modificationType) {
            case 'cell_update':
              if (affectedCells) {
                // Batch undo
                const updates = affectedCells.map(c => ({
                    rowId: c.rowId,
                    column: c.columnName,
                    value: c.priorValue
                } as CellUpdate));
                await worker.call('execBatch', [
                    updates.map(u => ({
                        sql: `UPDATE ${escapeIdentifier(targetTable)} SET ${escapeIdentifier(u.column)} = ? WHERE rowid = ?`,
                        params: [u.value, Number(u.rowId)]
                    }))
                ]);
              } else if (targetRowId !== undefined && targetColumn) {
                const rowIdNum = Number(targetRowId);
                const sql = `UPDATE ${escapeIdentifier(targetTable)} SET ${escapeIdentifier(targetColumn)} = ? WHERE rowid = ?`;
                await worker.call('run', [sql, [priorValue, rowIdNum]]);
              }
              break;

            case 'row_insert':
              if (targetRowId !== undefined) {
                await worker.call('run', [`DELETE FROM ${escapeIdentifier(targetTable)} WHERE rowid = ?`, [Number(targetRowId)]]);
              }
              break;

            case 'row_delete':
              if (deletedRows && deletedRows.length > 0) {
                await operationsFacade.insertRowBatch(targetTable, deletedRows.map(dr => dr.row));
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
                                params: [value, Number(rowId)]
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
          }
        },

        /**
         * Redo a modification by re-executing the original change.
         */
        redoModification: async (mod: ModificationEntry) => {
          const { modificationType, targetTable, targetRowId, targetColumn, newValue, affectedCells, affectedRowIds, rowData, tableDef, columnDef, deletedColumns } = mod;
          if (!targetTable) return;

          switch (modificationType) {
            case 'cell_update':
              if (affectedCells) {
                const updates = affectedCells.map(c => ({
                    rowId: c.rowId,
                    column: c.columnName,
                    value: c.newValue
                } as CellUpdate));
                await worker.call('execBatch', [
                    updates.map(u => ({
                        sql: `UPDATE ${escapeIdentifier(targetTable)} SET ${escapeIdentifier(u.column)} = ? WHERE rowid = ?`,
                        params: [u.value, Number(u.rowId)]
                    }))
                ]);
              } else if (targetRowId !== undefined && targetColumn) {
                const rowIdNum = Number(targetRowId);
                const sql = `UPDATE ${escapeIdentifier(targetTable)} SET ${escapeIdentifier(targetColumn)} = ? WHERE rowid = ?`;
                await worker.call('run', [sql, [newValue, rowIdNum]]);
              }
              break;

            case 'row_insert':
              if (rowData) {
                const dataToInsert = targetRowId !== undefined ? { ...rowData, rowid: targetRowId } : rowData;
                const columns = Object.keys(dataToInsert);
                const colNames = columns.map(escapeIdentifier).join(', ');
                const placeholders = columns.map(() => '?').join(', ');
                const params = columns.map(c => dataToInsert[c]);
                await worker.call('run', [`INSERT INTO ${escapeIdentifier(targetTable)} (${colNames}) VALUES (${placeholders})`, params]);
              }
              break;

            case 'row_delete':
              if (affectedRowIds && affectedRowIds.length > 0) {
                const ids = affectedRowIds.map(id => Number(id));
                const placeholders = ids.map(() => '?').join(', ');
                await worker.call('run', [`DELETE FROM ${escapeIdentifier(targetTable)} WHERE rowid IN (${placeholders})`, ids]);
              }
              break;

            case 'column_add':
              if (targetColumn && columnDef) {
                 validateSqlType(columnDef.type);
                 let sql = `ALTER TABLE ${escapeIdentifier(targetTable)} ADD COLUMN ${escapeIdentifier(targetColumn)} ${columnDef.type}`;
                 if (columnDef.defaultValue !== undefined && columnDef.defaultValue !== null && columnDef.defaultValue !== '') {
                    // Strict numeric validation for default values
                    if (columnDef.defaultValue.toLowerCase() === 'null') {
                        sql += ' DEFAULT NULL';
                    } else if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(columnDef.defaultValue)) {
                        // Strict numeric pattern: optional sign, digits with optional decimal, optional exponent
                        sql += ` DEFAULT ${columnDef.defaultValue}`;
                    } else {
                        sql += ` DEFAULT '${columnDef.defaultValue.replace(/'/g, "''")}'`;
                    }
                 }
                 await worker.call('run', [sql]);
              }
              break;

            case 'column_drop':
              if (deletedColumns) {
                  const batch = [];
                  for (const col of deletedColumns) {
                      batch.push({ sql: `ALTER TABLE ${escapeIdentifier(targetTable)} DROP COLUMN ${escapeIdentifier(col.name)}` });
                  }
                  if (batch.length > 0) {
                      await worker.call('execBatch', [batch]);
                  }
              }
              break;

            case 'table_create':
              if (tableDef && tableDef.columns) {
                  // Re-use createTable logic
                  const colDefs = tableDef.columns.map(col => {
                    validateSqlType(col.type);
                    let def = `${escapeIdentifier(col.name)} ${col.type}`;
                    if (col.primaryKey) def += ' PRIMARY KEY';
                    if (col.notNull && !col.primaryKey) def += ' NOT NULL';
                    return def;
                  });
                  await worker.call('run', [`CREATE TABLE ${escapeIdentifier(targetTable)} (${colDefs.join(', ')})`]);
              }
              break;
          }
        },

        flushChanges: async () => {},
        discardModifications: async (mods: ModificationEntry[]) => {
            for (let i = mods.length - 1; i >= 0; i--) {
                await operationsFacade.undoModification(mods[i]);
            }
        },

        /**
         * Update a single cell value.
         */
        updateCell: async (table: string, rowId: RecordId, column: string, value: CellValue, patch?: string) => {
          // Validate rowId is a number
          const rowIdNum = validateRowId(rowId);

          let sql: string;
          let params: CellValue[];

          if (patch) {
            // COALESCE handles NULL columns: json_patch(NULL, x) returns NULL,
            // but expected behavior is to treat NULL as empty object (matching WASM path)
            sql = `UPDATE ${escapeIdentifier(table)} SET ${escapeIdentifier(column)} = json_patch(COALESCE(${escapeIdentifier(column)}, '{}'), ?) WHERE rowid = ?`;
            params = [patch, rowIdNum];
          } else {
            sql = `UPDATE ${escapeIdentifier(table)} SET ${escapeIdentifier(column)} = ? WHERE rowid = ?`;
            params = [value, rowIdNum];
          }

          await worker.call('run', [sql, params]);
        },

        /**
         * Insert a new row.
         */
        insertRow: async (table: string, data: Record<string, CellValue>) => {
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
        insertRowBatch: async (table: string, rows: Record<string, CellValue>[]) => {
          if (rows.length === 0) return;

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
        deleteRows: async (table: string, rowIds: RecordId[]) => {
          if (rowIds.length === 0) return;

          // Validate all row IDs
          const validIds = validateRowIds(rowIds);

          const placeholders = validIds.map(() => '?').join(', ');
          const sql = `DELETE FROM ${escapeIdentifier(table)} WHERE rowid IN (${placeholders})`;
          await worker.call('run', [sql, validIds]);
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

        /**
         * Fetch table data.
         */
        fetchTableData: async (table: string, options: TableQueryOptions) => {
          const { sql, params } = buildSelectQuery(table, options);
          const result = await worker.call<NativeQueryResult>('query', [sql, params]);

          let headers = result.columns;
          let rows = result.values;

          // Native worker returns columns based on Object.keys() which doesn't guarantee order.
          // Ensure the result matches the requested column order from options.columns.
          if (options.columns && options.columns.length > 0 && headers && rows) {
            const expected = options.columns;

            // Build map of lower-case header names to indices for robust matching
            // Prioritize exact match, then case-insensitive
            const headerIndexMap = new Map<string, number>();
            headers.forEach((h: string, i: number) => {
                headerIndexMap.set(h, i);
                headerIndexMap.set(h.toLowerCase(), i);
                // Also handle potentially quoted headers (though unlikely) by stripping quotes
                const unquoted = h.replace(/^['"`]|['"`]$/g, '');
                if (unquoted !== h) {
                  headerIndexMap.set(unquoted, i);
                  headerIndexMap.set(unquoted.toLowerCase(), i);
                }
            });

            // Map expected columns to their indices in the result
            const mapping = expected.map((c: string) => {
                let idx = headerIndexMap.get(c);
                if (idx === undefined) idx = headerIndexMap.get(c.toLowerCase());
                return idx;
            });

            // If we found at least some columns, we attempt to reconstruct the row
            // Missing columns will be undefined/null
            if (mapping.some((idx: number | undefined) => idx !== undefined)) {
              headers = expected;
              rows = rows.map((row: CellValue[]) => mapping.map((idx: number | undefined) =>
                idx !== undefined ? row[idx as number] : null
              ));
            }
          }

          return {
            headers: headers,
            rows: rows,
            columns: headers,
            values: rows
          };
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
          // Batch all 3 schema queries into a single IPC round-trip for efficiency.
          const queries = [
            { sql: "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name" },
            { sql: "SELECT name FROM sqlite_schema WHERE type='view' ORDER BY name" },
            { sql: "SELECT name, tbl_name FROM sqlite_schema WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name" }
          ];

          const res = await worker.call<NativeQueryBatchResult>('queryBatch', [queries]);

          // Validate the response — throw instead of silently returning empty schema
          if (!res || !res.results || res.results.length < 3) {
            throw new Error('Schema fetch failed: queryBatch returned incomplete results');
          }

          const tables = mapRowsByName<TableMetadata>(res.results[0], { identifier: 'name' });
          const views = mapRowsByName<ViewMetadata>(res.results[1], { identifier: 'name' });
          const indexes = mapRowsByName<IndexMetadata>(res.results[2], { identifier: 'name', parentTable: 'tbl_name' });

          return { tables, views, indexes } as SchemaSnapshot;
        },

        /**
         * Get table metadata.
         */
        getTableInfo: async (table: string) => {
          const result = await worker.call<NativeQueryResult>('query', [`PRAGMA table_info(${escapeIdentifier(table)})`]);

          // Map columns by name to handle unpredictable column order from native worker
          const headers = result.columns;
          const idx = {
            cid: headers.indexOf('cid'),
            name: headers.indexOf('name'),
            type: headers.indexOf('type'),
            notnull: headers.indexOf('notnull'),
            dflt_value: headers.indexOf('dflt_value'),
            pk: headers.indexOf('pk')
          };

          return (result.values || []).map((row: CellValue[]): ColumnMetadata => ({
            ordinal: (idx.cid >= 0 ? row[idx.cid] : row[0]) as number,
            identifier: (idx.name >= 0 ? row[idx.name] : row[1]) as string,
            declaredType: (idx.type >= 0 ? row[idx.type] : row[2]) as string,
            isRequired: (idx.notnull >= 0 ? row[idx.notnull] : row[3]) as number,
            defaultExpression: idx.dflt_value >= 0 ? row[idx.dflt_value] : row[4],
            primaryKeyPosition: (idx.pk >= 0 ? row[idx.pk] : row[5]) as number
          }));
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
        updateCellBatch: async (table: string, updates: CellUpdate[]) => {
          if (updates.length === 0) return;

          const batchItems: { sql: string; paramsList?: CellValue[][], params?: CellValue[] }[] = [];
          const escapedTable = escapeIdentifier(table);

          const updatesByColumn = new Map<string, CellUpdate[]>();
          for (const update of updates) {
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
              // json_patch(col, patch)
              sql = `UPDATE ${escapedTable} SET ${escapedColumn} = json_patch(${escapedColumn}, ?) WHERE rowid = ?`;
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

      return {
        databaseOps: operationsFacade,
        isReadOnly: forceReadOnly ?? false
      };
    }
  };
}
