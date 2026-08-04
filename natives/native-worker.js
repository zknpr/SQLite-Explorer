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
 * - Response: { id: number, result?: any, error?: string, cancelled?: boolean }
 */

import * as sqlite from "tjs:sqlite";
import * as v8 from "tjs:v8";

const { Database } = sqlite;
const AsyncDatabase = sqlite.AsyncDatabase;

// ============================================================================
// Constants
// ============================================================================

const HEADER_SIZE = 4;

// ============================================================================
// Database State
// ============================================================================

/** Currently open database instance */
let db = null;

/** Optional second connection used only for bounded reads outside transactions. */
let asyncDb = null;
let asyncCapabilityProbed = false;
let asyncCapabilitySupported = false;

/** AbortControllers for async operations addressable by their request id. */
const activeOperations = new Map();

/** Map of prepared statements by ID */
const statements = new Map();
let stmtCounter = 0;
let savepointCounter = 0;

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

/**
 * Probe the exact AsyncDatabase surface used by this worker. Aborting a finite
 * in-flight query must reject with the bundled binding's "Aborted" error, and
 * the same connection must remain usable afterwards. The finite upper bound is
 * essential: a binary that ignores signals must still complete the probe.
 */
function probeAsyncDatabase(candidate) {
  return (async () => {
    if (
      !candidate ||
      typeof candidate.close !== 'function' ||
      typeof candidate.run !== 'function' ||
      typeof candidate.all !== 'function'
    ) {
      return false;
    }

    const controller = new AbortController();
    const probeSql =
      'WITH RECURSIVE sqlite_explorer_probe(value) AS (' +
      'SELECT 1 UNION ALL SELECT value + 1 FROM sqlite_explorer_probe WHERE value < 1000000' +
      ') SELECT max(value) AS value FROM sqlite_explorer_probe';
    const abortTimer = setTimeout(() => controller.abort(), 0);
    try {
      await candidate.all(probeSql, [], { signal: controller.signal });
      return false;
    } catch (err) {
      if ((err && err.message) !== 'Aborted') return false;
    } finally {
      clearTimeout(abortTimer);
    }

    try {
      const rows = await candidate.all('SELECT 1 AS value', []);
      return Array.isArray(rows) && rows[0]?.value === 1;
    } catch {
      return false;
    }
  })();
}

/** Fail closed to the sync connection unless transaction absence is explicit. */
function shouldUseAsyncDatabase(database, asyncDatabase) {
  if (!asyncDatabase || !database) return false;
  try {
    const transactionState = typeof database.inTransaction === 'function'
      ? database.inTransaction()
      : database.inTransaction;
    return transactionState === false;
  } catch {
    return false;
  }
}

/** Abort one active async operation without affecting queued or future work. */
function cancelOperation(correlationId) {
  const operation = activeOperations.get(correlationId);
  if (!operation) return false;
  if (operation.reason === undefined) {
    operation.reason = 'host';
    operation.controller.abort();
  }
  return true;
}

function closeAsyncDatabase() {
  return (async () => {
    const connection = asyncDb;
    asyncDb = null;
    if (!connection || typeof connection.close !== 'function') return;
    await connection.close();
  })();
}

/** Open and probe the optional second connection without breaking sync use. */
function openAsyncDatabase(path, readOnly) {
  return (async () => {
    await closeAsyncDatabase();
    if (asyncCapabilityProbed && !asyncCapabilitySupported) return;
    if (typeof AsyncDatabase !== 'function') {
      asyncCapabilityProbed = true;
      asyncCapabilitySupported = false;
      return;
    }

    let candidate;
    try {
      candidate = new AsyncDatabase(path, { readonly: readOnly });
      if (!asyncCapabilityProbed) {
        asyncCapabilitySupported = await probeAsyncDatabase(candidate);
        asyncCapabilityProbed = true;
      }
      if (!asyncCapabilitySupported) {
        await candidate.close();
        console.error('[native-worker] AsyncDatabase signal probe unavailable; using sync fallback');
        return;
      }
      asyncDb = candidate;
    } catch (err) {
      if (candidate && typeof candidate.close === 'function') {
        try { await candidate.close(); } catch { /* best-effort capability fallback */ }
      }
      console.error('[native-worker] AsyncDatabase unavailable; using sync fallback:', err?.message || String(err));
    }
  })();
}

// ============================================================================
// Database Operations
// ============================================================================

/**
 * Execute a statement with parameters.
 *
 * @param {object} db - Database instance
 * @param {string} sql - SQL statement
 * @param {any[]} params - Parameters
 * @returns {object} Result with changes and lastInsertRowId
 */
function executeStatement(db, sql, params) {
  const stmt = db.prepare(sql);
  let result = { changes: 0, lastInsertRowId: 0 };

  try {
    if (typeof stmt.run === 'function') {
      const runResult = params && params.length > 0 ? stmt.run(...params) : stmt.run();
      if (runResult && typeof runResult === 'object') {
        result.changes = runResult.changes !== undefined ? runResult.changes : 0;
        result.lastInsertRowId = runResult.lastInsertRowId !== undefined ? runResult.lastInsertRowId : 0;
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
      for (const _ of stmt) {}
    }
  } finally {
    if (stmt && typeof stmt.finalize === 'function') {
      try { stmt.finalize(); } catch (e) { /* ignore */ }
    }
  }
  return result;
}

/**
 * Execute a query (SELECT or otherwise) and return results.
 *
 * @param {object} db - Database instance
 * @param {string} sql - SQL statement
 * @param {any[]} params - Parameters
 * @returns {object} Result with columns, values, rowCount
 */
function executeQuery(db, sql, params) {
  console.error("[native-worker] query:", sql.substring(0, 50));

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

  return {
    columns,
    values,
    rowCount
  };
}

/** Compact generated numeric metadata before crossing the V8 RPC boundary. */
function compactExactNumericResult(result, transportColumns, valueColumnCount) {
  if (!Array.isArray(transportColumns) || transportColumns.length < 1) {
    throw new Error('Invalid exact numeric transport column list');
  }
  const hasRealTextSidecar = valueColumnCount !== undefined;
  const logicalColumnCount = hasRealTextSidecar ? valueColumnCount : transportColumns.length;
  if (
    !Number.isInteger(logicalColumnCount) ||
    logicalColumnCount < 1 ||
    transportColumns.length !== logicalColumnCount * (hasRealTextSidecar ? 2 : 1)
  ) {
    throw new Error('Invalid exact numeric transport column list');
  }
  const values = [];
  let exactIntegerTexts;

  if (result.values.length === 0) {
    return { columns: transportColumns.slice(0, logicalColumnCount), values, rowCount: 0 };
  }

  const mapping = transportColumns.map(column => result.columns.indexOf(column));
  if (mapping.some(index => index < 0)) {
    throw new Error('Native query result omitted exact numeric transport metadata');
  }

  for (let rowIndex = 0; rowIndex < result.values.length; rowIndex++) {
    const sourceRow = result.values[rowIndex];
    const orderedRow = mapping.map(index => sourceRow[index]);
    values.push(orderedRow.slice(0, logicalColumnCount));
    if (!hasRealTextSidecar) continue;
    for (let columnIndex = 0; columnIndex < logicalColumnCount; columnIndex++) {
      const exactText = orderedRow[logicalColumnCount + columnIndex];
      if (exactText === null || exactText === undefined) continue;
      if (typeof exactText !== 'string') {
        throw new Error(`Exact numeric metadata at row ${rowIndex}, column ${columnIndex} is not text`);
      }
      if (exactText === String(orderedRow[columnIndex])) continue;
      exactIntegerTexts ??= {};
      exactIntegerTexts[rowIndex] ??= {};
      exactIntegerTexts[rowIndex][columnIndex] = exactText;
    }
  }

  const compacted = {
    columns: transportColumns.slice(0, logicalColumnCount),
    values,
    rowCount: values.length
  };
  if (exactIntegerTexts) compacted.exactIntegerTexts = exactIntegerTexts;
  return compacted;
}

/** Execute one prepared query only after SQLite proves it consumed the boundary. */
function executeSingleQuery(db, sql, params, requiredSuffix) {
  const stmt = db.prepare(sql);
  let rows = [];
  try {
    const preparedSql = typeof stmt.toString === 'function' ? stmt.toString().trimEnd() : '';
    if (!requiredSuffix || !preparedSql.endsWith(requiredSuffix)) {
      throw new Error('Exactly one SQL statement is required');
    }

    if (typeof stmt.all === 'function') {
      rows = params && params.length > 0 ? stmt.all(...params) : stmt.all();
    } else {
      if (params && params.length > 0 && typeof stmt.bind === 'function') {
        stmt.bind(...params);
      }
      for (const row of stmt) rows.push(row);
    }
  } finally {
    if (typeof stmt.finalize === 'function') stmt.finalize();
  }

  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return {
    columns,
    values: rows.map(row => columns.map(column => row[column])),
    rowCount: rows.length
  };
}

/** Validate one marked payload and return the exact executable SQL it contains. */
function assertSingleStatementPayload(db, markedSql, sql, requiredSuffix) {
  const marker = requiredSuffix ? `\n${requiredSuffix}` : '';
  if (!marker || !markedSql.endsWith(marker)) {
    throw new Error('Exactly one SQL statement is required');
  }

  // Do not validate one RPC string and execute another. Besides weakening the
  // statement-boundary guarantee, any transport divergence would make SQLite
  // store SQL different from the definition the host compiled. Derive the
  // executable bytes from the boundary-checked payload and use the duplicate
  // argument only as an integrity assertion for protocol compatibility.
  const validatedSql = markedSql.slice(0, -marker.length);
  if (validatedSql !== sql) {
    throw new Error('Single-statement SQL payload mismatch');
  }

  const validationStmt = db.prepare(markedSql);
  try {
    if (
      typeof validationStmt.toString !== 'function' ||
      validationStmt.toString === Object.prototype.toString
    ) {
      throw new Error('Statement introspection unavailable');
    }
    const introspectedSql = validationStmt.toString();
    if (typeof introspectedSql !== 'string') {
      throw new Error('Statement introspection unavailable');
    }
    const preparedSql = introspectedSql.trimEnd();
    if (!requiredSuffix || !preparedSql.endsWith(requiredSuffix)) {
      throw new Error('Exactly one SQL statement is required');
    }
  } finally {
    if (typeof validationStmt.finalize === 'function') validationStmt.finalize();
  }
  return validatedSql;
}

/** Execute one mutation only after the marked SQL proves it has no tail. */
function executeSingleStatement(db, markedSql, sql, params, requiredSuffix) {
  const validatedSql = assertSingleStatementPayload(db, markedSql, sql, requiredSuffix);
  return executeStatement(db, validatedSql, params);
}

/**
 * Sync fallback for a generated SELECT. This remains necessary on older
 * binaries and whenever the main connection has transaction-local state that a
 * second connection cannot observe. Its elapsed checks retain the historical
 * timeout contract even though they can only run after stmt.all() returns.
 */
function executeBoundedQuery(db, markedSql, sql, requiredSuffix, columns, valueColumnCount, limit, timeoutMs) {
  const validatedSql = assertSingleStatementPayload(db, markedSql, sql, requiredSuffix);

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Preview row limit must be an integer between 1 and 100');
  }

  const values = [];
  const startedAt = Date.now();
  const stmt = db.prepare(`${validatedSql}\nLIMIT ${limit}`);
  try {
    // Generated transport aliases keep row-object projection positional even
    // when the logical preview columns contain duplicates. txiki's statement
    // API exposes all() but no step/iterator API, so SQLite executes once and
    // the elapsed bound is checked while serializing each returned row.
    const rows = stmt.all();
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Query execution timed out after ${timeoutMs}ms`);
    }
    for (const row of rows) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Query execution timed out after ${timeoutMs}ms`);
      }
      values.push(columns.map(column => row[column]));
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Query execution timed out after ${timeoutMs}ms`);
      }
    }
  } finally {
    if (typeof stmt.finalize === 'function') stmt.finalize();
  }

  return compactExactNumericResult(
    { columns, values, rowCount: values.length },
    columns,
    valueColumnCount
  );
}

/** Execute one bounded read on AsyncDatabase with deadline and host cancellation. */
function executeBoundedQueryAsync(asyncDatabase, validationDb, requestId, markedSql, sql, requiredSuffix, columns, valueColumnCount, limit, timeoutMs) {
  return (async () => {
    const validatedSql = assertSingleStatementPayload(
      validationDb,
      markedSql,
      sql,
      requiredSuffix
    );
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Preview row limit must be an integer between 1 and 100');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('Query timeout must be a positive finite number');
    }

    const operation = {
      controller: new AbortController(),
      reason: undefined
    };
    activeOperations.set(requestId, operation);
    const deadline = setTimeout(() => {
      if (operation.reason === undefined) {
        operation.reason = 'deadline';
        operation.controller.abort();
      }
    }, timeoutMs);

    try {
      const rows = await asyncDatabase.all(
        `${validatedSql}\nLIMIT ${limit}`,
        [],
        { signal: operation.controller.signal }
      );
      const resultColumns = Array.isArray(rows) && rows.length > 0
        ? Object.keys(rows[0])
        : columns;
      return compactExactNumericResult({
        columns: resultColumns,
        values: (rows || []).map(row => resultColumns.map(column => row[column])),
        rowCount: rows?.length ?? 0
      }, columns, valueColumnCount);
    } catch (err) {
      if ((err && err.message) !== 'Aborted') throw err;
      if (operation.reason === 'deadline') {
        throw new Error(`Query execution timed out after ${timeoutMs}ms`);
      }
      if (operation.reason === 'host') {
        const cancellationError = new Error('Operation cancelled');
        cancellationError.name = 'AbortError';
        cancellationError.cancelled = true;
        throw cancellationError;
      }
      throw err;
    } finally {
      clearTimeout(deadline);
      if (activeOperations.get(requestId) === operation) {
        activeOperations.delete(requestId);
      }
    }
  })();
}

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
        await closeAsyncDatabase();
        if (db) {
          try { db.close(); } catch (e) { /* ignore */ }
        }
        db = new Database(path, { readonly: readOnly });
        await openAsyncDatabase(path, readOnly);
        result = { success: true };
        break;
      }

      case "openMemory": {
        // Open an in-memory database with optional initial content
        // args: [content?: Uint8Array]
        await closeAsyncDatabase();
        if (db) {
          try { db.close(); } catch (e) { /* ignore */ }
        }
        db = new Database(":memory:");
        result = { success: true };
        break;
      }

      case "close": {
        // Close the database
        await closeAsyncDatabase();
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
        if (!db) throw new Error("Database not open");

        result = executeQuery(db, sql, params);
        console.error("[native-worker] query complete");
        break;
      }

      case "queryNumeric": {
        const [sql, params, transportColumns, valueColumnCount] = args;
        if (!db) throw new Error("Database not open");
        result = compactExactNumericResult(
          executeQuery(db, sql, params),
          transportColumns,
          valueColumnCount
        );
        break;
      }

      case "querySingle": {
        // The caller appends an unpredictable comment suffix. SQLite's own
        // parser must retain it in the prepared statement or a tail escaped
        // the wrapper and this request is rejected before anything is stepped.
        const [sql, params, requiredSuffix] = args;
        if (!db) throw new Error("Database not open");
        result = executeSingleQuery(db, sql, params, requiredSuffix);
        break;
      }

      case "queryBounded": {
        const [markedSql, sql, requiredSuffix, columns, valueColumnCount, limit, timeoutMs] = args;
        if (!db) throw new Error("Database not open");
        result = shouldUseAsyncDatabase(db, asyncDb)
          ? await executeBoundedQueryAsync(
              asyncDb,
              db,
              id,
              markedSql,
              sql,
              requiredSuffix,
              columns,
              valueColumnCount,
              limit,
              timeoutMs
            )
          : executeBoundedQuery(
              db,
              markedSql,
              sql,
              requiredSuffix,
              columns,
              valueColumnCount,
              limit,
              timeoutMs
            );
        break;
      }

      case "cancel": {
        const [correlationId] = args;
        if (!Number.isInteger(correlationId)) {
          throw new Error('Cancellation correlation id must be an integer');
        }
        result = { cancelled: cancelOperation(correlationId) };
        break;
      }

      case "queryBatch": {
        // Execute a batch of queries and return results for each
        // args: [queries: { sql: string, params?: any[] }[]]
        const [queries] = args;
        if (!db) throw new Error("Database not open");

        const results = [];
        for (const query of queries) {
            results.push(executeQuery(db, query.sql, query.params));
        }
        result = { results };
        break;
      }

      case "run": {
        // Execute SQL for modifications (INSERT, UPDATE, DELETE)
        // args: [sql: string, params?: any[]]
        const [sql, params] = args;

        // Debug logging - avoid JSON.stringify on binary data
        console.error("[native-worker] Received request: run");
        console.error("[native-worker] DEBUG: sql =", sql);
        // Log param types and sizes instead of full content to avoid huge logs for binary data
        if (params && params.length > 0) {
          const paramInfo = params.map((p, i) => {
            if (p instanceof Uint8Array) return `[${i}]: Uint8Array(${p.length})`;
            if (typeof p === 'string' && p.length > 100) return `[${i}]: string(${p.length} chars)`;
            return `[${i}]: ${typeof p === 'object' ? JSON.stringify(p) : p}`;
          });
          console.error("[native-worker] DEBUG: params =", paramInfo.join(', '));
        } else {
          console.error("[native-worker] DEBUG: params = (none)");
        }

        if (!db) throw new Error("Database not open");

        try {
          const runResult = executeStatement(db, sql, params);

          if (runResult.changes > 0 || runResult.lastInsertRowId > 0) {
             result = runResult;
          } else {
              // tjs sqlite might not expose totalChanges/changes on db object
              // Query for value if missing
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
        } catch (e) {
            console.error("[native-worker] DEBUG: execution failed", e);
            throw e;
        }
        console.error("[native-worker] DEBUG: run complete, changes:", result?.changes);
        break;
      }

      case "runSingle": {
        const [markedSql, sql, params, requiredSuffix] = args;
        if (!db) throw new Error("Database not open");
        result = executeSingleStatement(db, markedSql, sql, params, requiredSuffix);
        break;
      }

      case "execBatch": {
        // SAVEPOINT composes with host-side atomic read/write boundaries; a raw
        // BEGIN here would fail when updateCellBatch is intentionally nested.
        // args: [items: { sql: string, params?: any[], paramsList?: any[][] }[]]
        const [items] = args;
        if (!db) throw new Error("Database not open");

        const savepointName = `sqlite_explorer_exec_batch_${++savepointCounter}`;
        db.exec(`SAVEPOINT "${savepointName}"`);
        try {
          for (const item of items) {
             if (item.paramsList && item.paramsList.length > 0) {
                 const stmt = db.prepare(item.sql);
                 try {
                     for (const params of item.paramsList) {
                         if (params && params.length > 0) stmt.run(...params);
                         else stmt.run();
                     }
                 } finally {
                     if (typeof stmt.free === 'function') stmt.free();
                     else if (typeof stmt.finalize === 'function') stmt.finalize();
                 }
             } else {
                 executeStatement(db, item.sql, item.params);
             }
          }
          db.exec(`RELEASE SAVEPOINT "${savepointName}"`);
          result = { success: true };
        } catch (err) {
          try {
            db.exec(`ROLLBACK TO SAVEPOINT "${savepointName}"`);
            db.exec(`RELEASE SAVEPOINT "${savepointName}"`);
          } catch (rollbackErr) {
            throw new Error(
              `Batch failed (${String(err)}); savepoint cleanup failed (${String(rollbackErr)})`
            );
          }
          throw err;
        }
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
    return {
      id,
      error: `[${method}] ${errorMsg}`,
      ...(err && err.cancelled === true ? { cancelled: true } : {})
    };
  }
}

// ============================================================================
// Main Loop
// ============================================================================

async function main() {
  console.error("[native-worker] Starting...");
  let writeTail = Promise.resolve();
  const enqueueMessage = (message) => {
    const write = writeTail.then(() => writeMessage(message));
    writeTail = write.catch(err => {
      console.error('[native-worker] Message write failed:', err?.message || String(err));
    });
    return write;
  };
  let requestTail = Promise.resolve();

  await enqueueMessage({ ready: true, version: "1.0.0" });
  console.error("[native-worker] Sent ready signal");

  while (true) {
    try {
      const request = await readMessage();

      if (request === null) {
        console.error("[native-worker] EOF received, shutting down");
        break;
      }

      console.error("[native-worker] Received request:", request?.method);
      if (request?.method === 'cancel') {
        // Cancel must bypass the normal FIFO tail so it can reach the
        // AbortController while AsyncDatabase is executing SQLite work.
        const response = await handleRequest(request);
        console.error("[native-worker] Sending response for:", request?.method, response?.error ? "ERROR: " + response.error : "OK");
        await enqueueMessage(response);
        continue;
      }

      const queuedRequest = requestTail.then(async () => {
        const response = await handleRequest(request);
        console.error("[native-worker] Sending response for:", request?.method, response?.error ? "ERROR: " + response.error : "OK");
        await enqueueMessage(response);
      });
      requestTail = queuedRequest.catch(err => {
        console.error('[native-worker] Queued request failed:', err?.message || String(err));
      });

    } catch (err) {
      console.error("[native-worker] Main loop error:", err.message || String(err));
      await enqueueMessage({ id: -1, error: err.message || String(err) });
    }
  }

  await requestTail;
  await writeTail;

  await closeAsyncDatabase();
  if (db) {
    try { db.close(); } catch (e) { /* ignore */ }
  }
}

main().catch(err => {
  console.error("Native worker error:", err);
  tjs.exit(1);
});
