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
        // Try to get changes if possible, though exec usually returns nothing
        let changes = 0;
        try { changes = db.totalChanges; } catch(e) {}
        result = { success: true, changes };
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
          const stmt = db.prepare(sql);
          let rows;
          try {
            if (typeof stmt.all === 'function') {
                if (params && params.length > 0) {
                    rows = stmt.all(...params);
                } else {
                    rows = stmt.all();
                }
            } else {
                // Fallback for iterators
                rows = [];
                if (params && params.length > 0 && typeof stmt.bind === 'function') {
                    try { stmt.bind(...params); } catch(e) { console.error("bind failed", e); }
                }
                for (const row of stmt) {
                    rows.push(row);
                }
            }
          } finally {
             if (typeof stmt.finalize === 'function') stmt.finalize();
          }

          console.error("[native-worker] got rows:", rows?.length);

          if (rows && rows.length > 0) {
            columns = Object.keys(rows[0]);
            values = rows.map(row => columns.map(col => row[col]));
            rowCount = rows.length;
          }
        } else {
          // Non-SELECT via query() - typically shouldn't happen for updateCell but good to support
          console.error("[native-worker] executing non-SELECT via query()");
          if (params && params.length > 0) {
            const stmt = db.prepare(sql);
            try {
                if (typeof stmt.run === 'function') {
                    stmt.run(...params);
                } else if (typeof stmt.execute === 'function') {
                    if (typeof stmt.bind === 'function') stmt.bind(...params);
                    stmt.execute();
                } else {
                    if (typeof stmt.bind === 'function') stmt.bind(...params);
                    stmt.step(); // or iterate
                }
            } finally {
                if (typeof stmt.finalize === 'function') stmt.finalize();
            }
          } else {
            db.exec(sql);
          }

          // Get changes
          try {
             const chg = db.prepare("SELECT changes() as c").all()[0].c;
             rowCount = chg;
          } catch(e) { rowCount = 0; }
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

        // Debug logging to help diagnose edit issues
        console.error("[native-worker] DEBUG: run called");
        console.error("[native-worker] DEBUG: sql =", sql);
        console.error("[native-worker] DEBUG: params =", JSON.stringify(params));

        if (!db) throw new Error("Database not open");

        // Use Prepared Statement for safety and consistency
        let stmt;
        try {
          stmt = db.prepare(sql);
        } catch (e) {
          console.error("[native-worker] DEBUG: prepare failed", e);
          throw new Error(`Prepare failed: ${e.message}`);
        }

        if (!stmt) {
          throw new Error("Prepare returned null/undefined");
        }

        try {
          // Execute
          if (typeof stmt.run === 'function') {
            const runResult = params && params.length > 0 ? stmt.run(...params) : stmt.run();
             // If run() returns an object with changes, use it
             if (runResult && typeof runResult === 'object') {
                result = {
                    changes: runResult.changes !== undefined ? runResult.changes : 0,
                    lastInsertRowId: runResult.lastInsertRowId !== undefined ? runResult.lastInsertRowId : 0
                };
             }
          } else if (typeof stmt.step === 'function') {
             if (params && params.length > 0 && typeof stmt.bind === 'function') {
               try { stmt.bind(...params); } catch(e) { /* ignore */ }
             }
            stmt.step();
          } else if (typeof stmt.execute === 'function') {
             if (params && params.length > 0 && typeof stmt.bind === 'function') {
               try { stmt.bind(...params); } catch(e) { /* ignore */ }
             }
            stmt.execute();
          } else {
             if (params && params.length > 0 && typeof stmt.bind === 'function') {
               try { stmt.bind(...params); } catch(e) { /* ignore */ }
             }
             // Fallback: iterate
             for (const _ of stmt) {}
          }
        } catch (e) {
            console.error("[native-worker] DEBUG: execution failed", e);
            throw e;
        } finally {
          if (stmt && typeof stmt.finalize === 'function') {
            try { stmt.finalize(); } catch (e) { /* ignore */ }
          }
        }

        if (!result) {
            // tjs sqlite might not expose totalChanges/changes on db object
            // We need to query for it if missing
            if (db.changes !== undefined) {
               result = {
                 changes: db.changes,
                 lastInsertRowId: db.lastInsertRowId || 0
               };
            } else {
               try {
                   const changesStmt = db.prepare("SELECT changes() as c, last_insert_rowid() as id");
                   let row;
                   if (typeof changesStmt.all === 'function') {
                       const rows = changesStmt.all();
                       if (rows && rows.length > 0) row = rows[0];
                   } else {
                       for (const r of changesStmt) { row = r; break; }
                   }

                   if (typeof changesStmt.finalize === 'function') {
                       changesStmt.finalize();
                   }

                   if (row) {
                       console.error("[native-worker] DEBUG: changes() query result:", JSON.stringify(row));
                       result = {
                           changes: row.c,
                           lastInsertRowId: row.id
                       };
                   } else {
                       result = { changes: 0, lastInsertRowId: 0 };
                   }
               } catch (e) {
                   console.error("[native-worker] Failed to query changes:", e);
                   result = { changes: 0, lastInsertRowId: 0 };
               }
            }
        }
        console.error("[native-worker] DEBUG: returning result:", JSON.stringify(result));
        break;
      }

      // ========================================
      // Prepared statements
      // ========================================

      case "prepare": {
        const [sql] = args;
        if (!db) throw new Error("Database not open");
        const stmt = db.prepare(sql);
        const stmtId = ++stmtCounter;
        statements.set(stmtId, stmt);
        result = { stmtId };
        break;
      }

      case "stmtRun": {
        const [stmtId, params] = args;
        const stmt = statements.get(stmtId);
        if (!stmt) throw new Error(`Statement ${stmtId} not found`);
        stmt.reset();
        // if (params) stmt.bind(...params); // Simplified
        if (params && params.length > 0) {
            if (typeof stmt.bind === 'function') stmt.bind(...params);
        }
        stmt.run();
        result = {
          changes: db.totalChanges,
          lastInsertRowId: db.lastInsertRowId
        };
        break;
      }

      case "stmtAll": {
        const [stmtId, params] = args;
        const stmt = statements.get(stmtId);
        if (!stmt) throw new Error(`Statement ${stmtId} not found`);
        stmt.reset();
         if (params && params.length > 0) {
            if (typeof stmt.bind === 'function') stmt.bind(...params);
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
        if (!db) throw new Error("Database not open");
        // Create a temporary file and use VACUUM INTO to get a consistent snapshot
        const tmpPath = `/tmp/sqlite-export-${Date.now()}.db`;
        db.exec(`VACUUM INTO '${tmpPath}'`);
        const content = await tjs.readFile(tmpPath);
        await tjs.remove(tmpPath);
        result = { content };
        break;
      }

      case "ping": {
        result = { pong: true, timestamp: Date.now() };
        break;
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }

    return { id, result };

  } catch (err) {
    const errorMsg = err.message || String(err);
    console.error(`[native-worker] ERROR in ${method}:`, errorMsg);
    return { id, error: `[${method}] ${errorMsg}` };
  }
}

// ============================================================================
// Main Loop
// ============================================================================

async function main() {
  console.error("[native-worker] Starting...");
  await writeMessage({ ready: true, version: "1.0.0" });
  console.error("[native-worker] Sent ready signal");

  while (true) {
    try {
      const request = await readMessage();

      if (request === null) {
        console.error("[native-worker] EOF received, shutting down");
        break;
      }

      console.error("[native-worker] Received request:", request?.method);
      const response = await handleRequest(request);
      console.error("[native-worker] Sending response for:", request?.method, response?.error ? "ERROR: " + response.error : "OK");
      await writeMessage(response);

    } catch (err) {
      console.error("[native-worker] Main loop error:", err.message || String(err));
      await writeMessage({ id: -1, error: err.message || String(err) });
    }
  }

  if (db) {
    try { db.close(); } catch (e) { /* ignore */ }
  }
}

main().catch(err => {
  console.error("Native worker error:", err);
  tjs.exit(1);
});
