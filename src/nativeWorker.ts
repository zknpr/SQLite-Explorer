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
  QueryResultSet,
  DatabaseOperations,
  DatabaseInitConfig,
  DatabaseInitResult,
  ModificationEntry
} from './core/types';

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Escape a SQL identifier (table name, column name) for safe use in queries.
 * SQL identifiers are wrapped in double quotes, and any internal double quotes
 * are escaped by doubling them (SQL standard).
 *
 * SECURITY: This prevents SQL injection via malicious table/column names.
 * Example: A table named `foo"--DROP TABLE bar` becomes `"foo""--DROP TABLE bar"`
 *
 * @param identifier - The table or column name to escape
 * @returns Safely escaped identifier wrapped in double quotes
 */
function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Convert a CellValue to SQL literal representation.
 * Handles NULL, numbers, strings, and binary data.
 */
function cellValueToSql(value: CellValue | undefined): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    // Escape single quotes by doubling them (SQL standard)
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (value instanceof Uint8Array) {
    // Convert binary to hex blob literal
    const hex = Array.from(value).map(b => b.toString(16).padStart(2, '0')).join('');
    return `X'${hex}'`;
  }
  // Fallback for any other type
  return `'${String(value).replace(/'/g, "''")}'`;
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
            const sqlValue = cellValueToSql(mod.previousValue);
            // Use escapeIdentifier to prevent SQL injection via malicious table/column names
            const sql = `UPDATE ${escapeIdentifier(mod.targetTable)} SET ${escapeIdentifier(mod.targetColumn)} = ${sqlValue} WHERE rowid = ${mod.targetRowId}`;
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
            const sqlValue = cellValueToSql(mod.newValue);
            // Use escapeIdentifier to prevent SQL injection via malicious table/column names
            const sql = `UPDATE ${escapeIdentifier(mod.targetTable)} SET ${escapeIdentifier(mod.targetColumn)} = ${sqlValue} WHERE rowid = ${mod.targetRowId}`;
            await worker.call('query', [sql]);
          }
          // Other modification types can be added as needed
        },

        flushChanges: async () => {},
        discardModifications: async () => {}
      };

      return {
        databaseOps: operationsFacade,
        isReadOnly: forceReadOnly ?? false
      };
    }
  };
}
