/**
 * Native SQLite Worker for txiki-js
 *
 * This script runs in the txiki-js runtime and provides native SQLite
 * operations. It communicates with the VS Code extension via stdin/stdout
 * using V8 serialization format for compatibility with Node.js.
 *
 * Protocol:
 * - Messages are length-prefixed: 4 bytes (big-endian) + V8 serialized data
 * - Request: { id: number, method: string, args: any[] }
 * - Response: { id: number, result?: any, error?: string }
 */

import { Database } from "tjs:sqlite";
import * as v8 from "tjs:v8";

// ============================================================================
// Constants
// ============================================================================

const HEADER_SIZE = 4;

// ============================================================================
// Database State
// ============================================================================

/** Currently open database instance */
let db = null;

/** Map of prepared statements by ID */
const statements = new Map();
let stmtCounter = 0;

// ============================================================================
// Message Protocol
// ============================================================================

/**
 * Write a length-prefixed V8-serialized message to stdout.
 *
 * @param {object} msg - Message to send
 */
async function writeMessage(msg) {
  const serialized = v8.serialize(msg);
  const header = new Uint8Array(HEADER_SIZE);
  const view = new DataView(header.buffer);
  view.setUint32(0, serialized.byteLength, false); // big-endian

  await tjs.stdout.write(header);
  await tjs.stdout.write(serialized);
}

/**
 * Read exactly N bytes from stdin into buffer.
 * txiki-js stdin.read() API: read(buffer: Uint8Array) => Promise<number>
 * It reads into the provided buffer and returns the number of bytes read.
 *
 * @param {Uint8Array} buffer - Buffer to read into
 * @returns {Promise<number>} Total bytes read, 0 on EOF
 */
async function readExact(buffer) {
  let totalRead = 0;
  const length = buffer.byteLength;

  while (totalRead < length) {
    // Create a view into the remaining portion of the buffer
    const remaining = new Uint8Array(buffer.buffer, buffer.byteOffset + totalRead, length - totalRead);
    const n = await tjs.stdin.read(remaining);

    if (n === 0 || n === null || n === undefined) {
      // EOF reached before filling buffer
      return totalRead;
    }

    totalRead += n;
  }

  return totalRead;
}

/**
 * Read a length-prefixed V8-serialized message from stdin.
 *
 * @returns {Promise<object|null>} Parsed message or null on EOF
 */
async function readMessage() {
  // Read 4-byte length header
  const header = new Uint8Array(HEADER_SIZE);
  const headerRead = await readExact(header);

  if (headerRead === 0) {
    return null; // EOF
  }

  if (headerRead < HEADER_SIZE) {
    throw new Error(`Incomplete header: got ${headerRead} bytes, expected ${HEADER_SIZE}`);
  }

  const view = new DataView(header.buffer);
  const length = view.getUint32(0, false); // big-endian

  if (length === 0) {
    return {};
  }

  // Read message body
  const body = new Uint8Array(length);
  const bodyRead = await readExact(body);

  if (bodyRead < length) {
    throw new Error(`Incomplete body: got ${bodyRead} bytes, expected ${length}`);
  }

  return v8.deserialize(body);
}

// ============================================================================
// Database Operations
// ============================================================================

/**
 * Handle incoming RPC request.
 *
 * @param {object} request - RPC request { id, method, args }
 * @returns {Promise<object>} Response { id, result } or { id, error }
 */
async function handleRequest(request) {
  const { id, method, args = [] } = request;

  try {
    let result;

    switch (method) {
      // ========================================
      // Database lifecycle
      // ========================================

      case "open": {
        // Open a database file
        // args: [path: string, readOnly?: boolean]
        const [path, readOnly = false] = args;
        if (db) {
          try { db.close(); } catch (e) { /* ignore */ }
        }
        db = new Database(path, { readonly: readOnly });
        result = { success: true };
        break;
      }

      case "openMemory": {
        // Open an in-memory database with optional initial content
        // args: [content?: Uint8Array]
        if (db) {
          try { db.close(); } catch (e) { /* ignore */ }
        }
        db = new Database(":memory:");
        result = { success: true };
        break;
      }

      case "close": {
        // Close the database
        if (db) {
          // Finalize all statements first
          for (const [stmtId, stmt] of statements) {
            try { stmt.finalize(); } catch (e) { /* ignore */ }
          }
          statements.clear();

          db.close();
          db = null;
        }
        result = { success: true };
        break;
      }

      // ========================================
      // Query execution
      // ========================================

      case "exec": {
        // Execute SQL without returning results
        // args: [sql: string]
        const [sql] = args;
        if (!db) throw new Error("Database not open");
        db.exec(sql);
        result = { success: true, changes: db.totalChanges };
        break;
      }

      case "query": {
        // Execute SQL and return all results
        // args: [sql: string, params?: any[]]
        const [sql, params] = args;
        console.error("[native-worker] query:", sql.substring(0, 50));
        if (!db) throw new Error("Database not open");

        // Detect if this is a SELECT query or a modification (UPDATE/INSERT/DELETE/etc)
        const trimmedSql = sql.trim().toUpperCase();
        const isSelectQuery = trimmedSql.startsWith("SELECT") ||
                              trimmedSql.startsWith("PRAGMA") ||
                              trimmedSql.startsWith("EXPLAIN") ||
                              trimmedSql.startsWith("WITH");

        console.error("[native-worker] isSelectQuery:", isSelectQuery);

        let columns = [];
        let values = [];
        let rowCount = 0;

        if (isSelectQuery) {
          // For SELECT queries, use prepared statement with stmt.all()
          console.error("[native-worker] preparing SELECT statement");
          const stmt = db.prepare(sql);
          if (params && params.length > 0) {
            stmt.bind(...params);
          }

          console.error("[native-worker] calling stmt.all()");
          const rows = stmt.all();
          console.error("[native-worker] got rows:", rows?.length);

          // Get column information from first row
          if (rows && rows.length > 0) {
            columns = Object.keys(rows[0]);
            values = rows.map(row => columns.map(col => row[col]));
            rowCount = rows.length;
          }

          stmt.finalize();
        } else {
          // For INSERT/UPDATE/DELETE/CREATE/ALTER/DROP, use db.exec()
          // This is simpler and doesn't require prepared statement methods that may not exist
          console.error("[native-worker] executing non-SELECT with db.exec()");
          if (params && params.length > 0) {
            // If there are params, we need to use prepared statement
            console.error("[native-worker] using prepared statement with params");
            const stmt = db.prepare(sql);
            stmt.bind(...params);
            // Try different methods that might exist in txiki-js SQLite
            if (typeof stmt.run === 'function') {
              console.error("[native-worker] using stmt.run()");
              stmt.run();
            } else if (typeof stmt.step === 'function') {
              console.error("[native-worker] using stmt.step()");
              stmt.step();
            } else if (typeof stmt.execute === 'function') {
              console.error("[native-worker] using stmt.execute()");
              stmt.execute();
            } else {
              // Fall back to getting all (returns empty for non-SELECT)
              console.error("[native-worker] fallback to stmt.all()");
              stmt.all();
            }
            stmt.finalize();
          } else {
            // No params, just use db.exec() which is simpler
            console.error("[native-worker] using db.exec() directly");
            db.exec(sql);
          }
          rowCount = db.totalChanges || 0;
          console.error("[native-worker] totalChanges:", rowCount);
        }

        result = {
          columns,
          values,
          rowCount
        };
        console.error("[native-worker] query complete");
        break;
      }

      case "run": {
        // Execute SQL for modifications (INSERT, UPDATE, DELETE)
        // args: [sql: string, params?: any[]]
        const [sql, params] = args;
        if (!db) throw new Error("Database not open");

        const stmt = db.prepare(sql);
        if (params && params.length > 0) {
          stmt.bind(...params);
        }

        stmt.run();
        stmt.finalize();

        result = {
          changes: db.totalChanges,
          lastInsertRowId: db.lastInsertRowId
        };
        break;
      }

      // ========================================
      // Prepared statements
      // ========================================

      case "prepare": {
        // Prepare a statement for repeated execution
        // args: [sql: string]
        const [sql] = args;
        if (!db) throw new Error("Database not open");

        const stmt = db.prepare(sql);
        const stmtId = ++stmtCounter;
        statements.set(stmtId, stmt);

        result = { stmtId };
        break;
      }

      case "stmtRun": {
        // Run a prepared statement
        // args: [stmtId: number, params?: any[]]
        const [stmtId, params] = args;
        const stmt = statements.get(stmtId);
        if (!stmt) throw new Error(`Statement ${stmtId} not found`);

        stmt.reset();
        if (params && params.length > 0) {
          stmt.bind(...params);
        }
        stmt.run();

        result = {
          changes: db.totalChanges,
          lastInsertRowId: db.lastInsertRowId
        };
        break;
      }

      case "stmtAll": {
        // Get all rows from a prepared statement
        // args: [stmtId: number, params?: any[]]
        const [stmtId, params] = args;
        const stmt = statements.get(stmtId);
        if (!stmt) throw new Error(`Statement ${stmtId} not found`);

        stmt.reset();
        if (params && params.length > 0) {
          stmt.bind(...params);
        }

        const rows = stmt.all();
        let columns = [];
        if (rows.length > 0) {
          columns = Object.keys(rows[0]);
        }

        result = {
          columns,
          values: rows.map(row => columns.map(col => row[col])),
          rowCount: rows.length
        };
        break;
      }

      case "stmtFinalize": {
        // Finalize a prepared statement
        // args: [stmtId: number]
        const [stmtId] = args;
        const stmt = statements.get(stmtId);
        if (stmt) {
          stmt.finalize();
          statements.delete(stmtId);
        }
        result = { success: true };
        break;
      }

      // ========================================
      // Database info
      // ========================================

      case "getSchema": {
        // Get database schema
        if (!db) throw new Error("Database not open");

        const tablesStmt = db.prepare(
          "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        );
        const tables = tablesStmt.all();
        tablesStmt.finalize();

        const schema = [];
        for (const table of tables) {
          const columnsStmt = db.prepare(`PRAGMA table_info("${table.name}")`);
          const columns = columnsStmt.all();
          columnsStmt.finalize();

          schema.push({
            name: table.name,
            sql: table.sql,
            columns: columns.map(c => ({
              name: c.name,
              type: c.type,
              notnull: c.notnull === 1,
              pk: c.pk === 1,
              dfltValue: c.dflt_value
            }))
          });
        }

        result = { schema };
        break;
      }

      case "export": {
        // Export database as binary
        // For databases opened directly on a file, changes are already persisted.
        // We just need to read the current file content or use VACUUM INTO for a clean export.
        if (!db) throw new Error("Database not open");

        // Create a temporary file and use VACUUM INTO to get a consistent snapshot
        const tmpPath = `/tmp/sqlite-export-${Date.now()}.db`;
        db.exec(`VACUUM INTO '${tmpPath}'`);

        // Read the file using tjs.readFile which returns a Uint8Array
        const content = await tjs.readFile(tmpPath);

        // Clean up temp file
        await tjs.remove(tmpPath);

        result = { content };
        break;
      }

      case "ping": {
        // Health check
        result = { pong: true, timestamp: Date.now() };
        break;
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }

    return { id, result };

  } catch (err) {
    // Include method name in error for better debugging
    const errorMsg = err.message || String(err);
    return { id, error: `[${method}] ${errorMsg}` };
  }
}

// ============================================================================
// Main Loop
// ============================================================================

async function main() {
  // Send ready signal
  console.error("[native-worker] Starting...");
  await writeMessage({ ready: true, version: "1.0.0" });
  console.error("[native-worker] Sent ready signal");

  // Process messages until stdin closes
  while (true) {
    try {
      const request = await readMessage();

      if (request === null) {
        // EOF - clean shutdown
        console.error("[native-worker] EOF received, shutting down");
        break;
      }

      console.error("[native-worker] Received request:", request?.method);
      const response = await handleRequest(request);
      console.error("[native-worker] Sending response for:", request?.method, response?.error ? "ERROR: " + response.error : "OK");
      await writeMessage(response);

    } catch (err) {
      // Send error response
      console.error("[native-worker] Main loop error:", err.message || String(err));
      await writeMessage({ id: -1, error: err.message || String(err) });
    }
  }

  // Cleanup
  if (db) {
    for (const stmt of statements.values()) {
      try { stmt.finalize(); } catch (e) { /* ignore */ }
    }
    try { db.close(); } catch (e) { /* ignore */ }
  }
}

main().catch(err => {
  console.error("Native worker error:", err);
  tjs.exit(1);
});
