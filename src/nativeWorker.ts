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
  ColumnMetadata
} from './core/types';
import { escapeIdentifier, cellValueToSql } from './core/sql-utils';
import { buildSelectQuery, buildCountQuery } from './core/query-builder';

// ============================================================================
// Utility Functions
// ============================================================================

// Utility functions moved to src/core/sql-utils.ts

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
function getNativeBinaryPath(extensionPath: string): string | null {
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
  if (fs.existsSync(binaryPath)) {
    return binaryPath;
  }

  return null;
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

  private buffer = Buffer.alloc(0);
  private expectedLength = -1;

  constructor(
    private readonly binaryPath: string,
    private readonly workerScript: string
  ) {}

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
        env: { ...process.env }
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
    // Append to buffer
    this.buffer = Buffer.concat([this.buffer, chunk]);

    // Process complete messages
    while (this.buffer.length >= HEADER_SIZE) {
      if (this.expectedLength < 0) {
        // Read length header
        this.expectedLength = this.buffer.readUInt32BE(0);
      }

      const totalNeeded = HEADER_SIZE + this.expectedLength;
      if (this.buffer.length < totalNeeded) {
        // Need more data
        break;
      }

      // Extract message body
      const body = this.buffer.slice(HEADER_SIZE, totalNeeded);
      this.buffer = this.buffer.slice(totalNeeded);
      this.expectedLength = -1;

      // Deserialize and handle
      try {
        const msg = v8.deserialize(body);
        this.handleMessage(msg);
      } catch (err) {
        console.error('[NativeWorker] Failed to deserialize message:', err);
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

// Helper to safely map rows by column name
function mapRowsByName(result: any, mapping: Record<string, string>) {
  if (!result || !result.columns || !result.values) return [];

  const headers = result.columns as string[];
  const headerMap = new Map(headers.map((h, i) => [h, i]));

  return result.values.map((row: any[]) => {
    const obj: any = {};
    for (const [targetProp, sourceCol] of Object.entries(mapping)) {
      const idx = headerMap.get(sourceCol);
      if (idx !== undefined) {
        obj[targetProp] = row[idx];
      }
    }
    return obj;
  });
}

/**
 * Check if native SQLite is available on this platform.
 *
 * @param extensionPath - Extension installation directory
 * @returns True if native binary is available
 */
export function isNativeAvailable(extensionPath: string): boolean {
  return getNativeBinaryPath(extensionPath) !== null;
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
  const binaryPath = getNativeBinaryPath(extensionPath);

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
          const result = await worker.call<{
            columns: string[];
            values: CellValue[][];
            rowCount: number;
          }>('query', [sql, params]);

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
         * For cell updates: sets the value back to previousValue.
         */
        undoModification: async (mod: ModificationEntry) => {
          if (mod.modificationType === 'cell_update' && mod.targetTable && mod.targetColumn && mod.targetRowId !== undefined) {
            // SECURITY: Validate rowId is a number to prevent SQL injection.
            // RecordId type allows string | number, but rowid should always be numeric.
            // A compromised webview could send a malicious string like "1; DROP TABLE users; --"
            const rowIdNum = Number(mod.targetRowId);
            if (!Number.isFinite(rowIdNum)) {
              throw new Error(`Invalid rowid: ${mod.targetRowId}`);
            }

            const sqlValue = cellValueToSql(mod.priorValue);
            // Use escapeIdentifier to prevent SQL injection via malicious table/column names
            const sql = `UPDATE ${escapeIdentifier(mod.targetTable)} SET ${escapeIdentifier(mod.targetColumn)} = ${sqlValue} WHERE rowid = ${rowIdNum}`;
            await worker.call('query', [sql]);
          }
          // Other modification types can be added as needed
        },

        /**
         * Redo a modification by re-executing the original change.
         * For cell updates: sets the value to newValue.
         */
        redoModification: async (mod: ModificationEntry) => {
          if (mod.modificationType === 'cell_update' && mod.targetTable && mod.targetColumn && mod.targetRowId !== undefined) {
            // SECURITY: Validate rowId is a number to prevent SQL injection.
            // RecordId type allows string | number, but rowid should always be numeric.
            // A compromised webview could send a malicious string like "1; DROP TABLE users; --"
            const rowIdNum = Number(mod.targetRowId);
            if (!Number.isFinite(rowIdNum)) {
              throw new Error(`Invalid rowid: ${mod.targetRowId}`);
            }

            const sqlValue = cellValueToSql(mod.newValue);
            // Use escapeIdentifier to prevent SQL injection via malicious table/column names
            const sql = `UPDATE ${escapeIdentifier(mod.targetTable)} SET ${escapeIdentifier(mod.targetColumn)} = ${sqlValue} WHERE rowid = ${rowIdNum}`;
            await worker.call('query', [sql]);
          }
          // Other modification types can be added as needed
        },

        flushChanges: async () => {},
        discardModifications: async () => {},

        /**
         * Update a single cell value.
         */
        updateCell: async (table: string, rowId: RecordId, column: string, value: CellValue) => {
          // Validate rowId is a number
          const rowIdNum = Number(rowId);
          if (!Number.isFinite(rowIdNum)) {
            throw new Error(`Invalid rowid: ${rowId}`);
          }

          const sql = `UPDATE ${escapeIdentifier(table)} SET ${escapeIdentifier(column)} = ? WHERE rowid = ?`;
          await worker.call('run', [sql, [value, rowIdNum]]);
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
         * Delete rows by ID.
         */
        deleteRows: async (table: string, rowIds: RecordId[]) => {
          if (rowIds.length === 0) return;

          // Validate all row IDs
          const validIds = rowIds.map(id => {
            const num = Number(id);
            if (!Number.isFinite(num)) throw new Error(`Invalid rowid: ${id}`);
            return num;
          });

          const placeholders = validIds.map(() => '?').join(', ');
          const sql = `DELETE FROM ${escapeIdentifier(table)} WHERE rowid IN (${placeholders})`;
          await worker.call('run', [sql, validIds]);
        },

        /**
         * Delete columns by name.
         */
        deleteColumns: async (table: string, columns: string[]) => {
          if (columns.length === 0) return;

          const escapedTable = escapeIdentifier(table);

          for (const col of columns) {
            const sql = `ALTER TABLE ${escapedTable} DROP COLUMN ${escapeIdentifier(col)}`;
            await worker.call('run', [sql]);
          }
        },

        /**
         * Create a new table.
         */
        createTable: async (table: string, columns: string[]) => {
          // columns are expected to be valid column definition strings
          const sql = `CREATE TABLE ${escapeIdentifier(table)} (${columns.join(', ')})`;
          await worker.call('run', [sql]);
        },

        /**
         * Fetch table data.
         */
        fetchTableData: async (table: string, options: TableQueryOptions) => {
          const { sql, params } = buildSelectQuery(table, options);
          const result = await worker.call<any>('query', [sql, params]);

          let headers = result.columns;
          let rows = result.values;

          // Native worker returns columns based on Object.keys() which doesn't guarantee order.
          // We need to ensure the result matches the requested column order from options.columns.
          if (options.columns && options.columns.length > 0 && headers && rows) {
            const expected = options.columns;

            // Build map of lower-case header names to indices for robust matching
            // We prioritize exact match, then case-insensitive
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
              rows = rows.map((row: any[]) => mapping.map((idx: number | undefined) =>
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
          const result = await worker.call<any>('query', [sql, params]);
          if (result && result.values && result.values.length > 0) {
            return result.values[0][0];
          }
          return 0;
        },

        /**
         * Fetch database schema.
         */
        fetchSchema: async () => {
          // Get schema using getSchema method on native worker which is optimized
          // native-worker.js has a 'getSchema' method that returns { schema: [...] }
          // Let's check what it returns exactly.
          // src/nativeWorker.js:
          // case "getSchema":
          // ... result = { schema: [{ name, sql, columns: [...] }] }
          // This structure is a bit different from SchemaSnapshot which has { tables, views, indexes }

          // Ideally we should unify. For now, let's use manual queries like WASM to be consistent and simple
          // OR reuse the existing getSchema if it provides everything we need.
          // The existing getSchema gets tables and their columns. It doesn't seem to get views or indexes explicitly in the same way?
          // Actually it queries sqlite_master for tables.
          // Let's stick to the SQL queries used in WASM implementation for consistency and to ensure we get views/indexes.

          // Get tables
          const tablesResult = await worker.call<any>('query', ["SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"]);
          // Get views
          const viewsResult = await worker.call<any>('query', ["SELECT name FROM sqlite_schema WHERE type='view' ORDER BY name"]);
          // Get indexes
          const indexesResult = await worker.call<any>('query', ["SELECT name, tbl_name FROM sqlite_schema WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name"]);

          const tables = mapRowsByName(tablesResult, { identifier: 'name' });
          const views = mapRowsByName(viewsResult, { identifier: 'name' });
          const indexes = mapRowsByName(indexesResult, { identifier: 'name', parentTable: 'tbl_name' });

          return { tables, views, indexes } as SchemaSnapshot;
        },

        /**
         * Get table metadata.
         */
        getTableInfo: async (table: string) => {
          const result = await worker.call<any>('query', [`PRAGMA table_info(${escapeIdentifier(table)})`]);

          // Map columns by name to handle unpredictable column order from native worker
          const headers = result.columns as string[];
          const idx = {
            cid: headers.indexOf('cid'),
            name: headers.indexOf('name'),
            type: headers.indexOf('type'),
            notnull: headers.indexOf('notnull'),
            dflt_value: headers.indexOf('dflt_value'),
            pk: headers.indexOf('pk')
          };

          return (result.values || []).map((row: any[]) => ({
            ordinal: idx.cid >= 0 ? row[idx.cid] : row[0],
            identifier: idx.name >= 0 ? row[idx.name] : row[1],
            declaredType: idx.type >= 0 ? row[idx.type] : row[2],
            isRequired: idx.notnull >= 0 ? row[idx.notnull] : row[3],
            defaultExpression: idx.dflt_value >= 0 ? row[idx.dflt_value] : row[4],
            primaryKeyPosition: idx.pk >= 0 ? row[idx.pk] : row[5]
          }));
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
         * Update multiple cells in a batch.
         */
        updateCellBatch: async (table: string, updates: CellUpdate[]) => {
          if (updates.length === 0) return;

          // Use transaction
          await worker.call('exec', ['BEGIN TRANSACTION']);
          try {
            for (const update of updates) {
              // Validate rowId is a number
              const rowIdNum = Number(update.rowId);
              if (!Number.isFinite(rowIdNum)) {
                throw new Error(`Invalid rowid: ${update.rowId}`);
              }

              const sql = `UPDATE ${escapeIdentifier(table)} SET ${escapeIdentifier(update.column)} = ? WHERE rowid = ?`;
              await worker.call('run', [sql, [update.value, rowIdNum]]);
            }
            await worker.call('exec', ['COMMIT']);
          } catch (err) {
            try { await worker.call('exec', ['ROLLBACK']); } catch {}
            throw err;
          }
        },

        /**
         * Add a new column to a table.
         */
        addColumn: async (table: string, column: string, type: string, defaultValue?: string) => {
          let sql = `ALTER TABLE ${escapeIdentifier(table)} ADD COLUMN ${escapeIdentifier(column)} ${type}`;

          if (defaultValue !== undefined && defaultValue !== null && defaultValue !== '') {
            if (defaultValue.toLowerCase() === 'null') {
              sql += ' DEFAULT NULL';
            } else if (!isNaN(Number(defaultValue))) {
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
