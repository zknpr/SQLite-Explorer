/**
 * SQLite Web Worker for Browser-based Database Operations
 *
 * This worker runs sql.js (SQLite compiled to WebAssembly) in a separate
 * thread to keep the UI responsive. It communicates with the main thread
 * using the same RPC protocol as the VS Code extension.
 *
 * Architecture:
 * - Loads sql.js from CDN (sql-wasm.js + sql-wasm.wasm)
 * - Handles RPC messages for database operations
 * - All SQL execution happens in this worker
 */

// ============================================================================
// Configuration
// ============================================================================

/**
 * sql.js CDN URL for the JavaScript module.
 * Using jsDelivr for reliable global CDN delivery.
 */
const SQL_JS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/sql-wasm.js';

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

// ============================================================================
// sql.js Loading
// ============================================================================

/**
 * Load sql.js from CDN using importScripts.
 * This populates the global `initSqlJs` function.
 */
async function loadSqlJs() {
  if (SQL) return SQL;

  // Import the sql.js script
  importScripts(SQL_JS_CDN);

  // Initialize sql.js with WASM binary
  // The WASM file will be provided via initializeDatabase call
  return null;
}

// ============================================================================
// Database Operations
// ============================================================================

/**
 * Initialize a new database from binary content.
 *
 * @param {string} filename - Display name for the database
 * @param {Object} config - Configuration object
 * @param {Uint8Array} config.content - SQLite database binary content
 * @param {Uint8Array} [config.wasmBinary] - Optional WASM binary
 * @returns {Promise<Object>} Database handle info
 */
async function initializeDatabase(filename, config) {
  console.log('[Worker] Initializing database:', filename);

  // Close existing database
  if (db) {
    db.close();
    db = null;
  }

  // Initialize sql.js with WASM
  if (!SQL) {
    // Load sql.js script
    importScripts(SQL_JS_CDN);

    // Initialize with WASM binary if provided
    const sqlConfig = {};
    if (config.wasmBinary) {
      sqlConfig.wasmBinary = config.wasmBinary;
    } else {
      // Default to CDN WASM
      sqlConfig.locateFile = (file) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/${file}`;
    }

    SQL = await self.initSqlJs(sqlConfig);
  }

  // Create database from binary content
  if (config.content && config.content.length > 0) {
    db = new SQL.Database(config.content);
  } else {
    // Create empty database
    db = new SQL.Database();
  }

  console.log('[Worker] Database initialized successfully');

  return {
    operations: {},
    isReadOnly: false
  };
}

/**
 * Execute a SQL query and return results.
 *
 * @param {string} sql - SQL statement to execute
 * @param {Array} [params] - Bound parameters
 * @returns {Promise<Array>} Array of result sets
 */
async function runQuery(sql, params = []) {
  if (!db) throw new Error('No database initialized');

  try {
    const results = db.exec(sql, params);

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
  return db.export();
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
    offset = 0,
    limit = 1000,
    orderBy = null,
    orderDir = 'ASC',
    filter = null
  } = options;

  // Build query with safe table name
  let sql = `SELECT rowid AS _rowid_, * FROM "${table.replace(/"/g, '""')}"`;

  // Add filter clause
  if (filter) {
    sql += ` WHERE ${filter}`;
  }

  // Add ordering
  if (orderBy) {
    sql += ` ORDER BY "${orderBy.replace(/"/g, '""')}" ${orderDir === 'DESC' ? 'DESC' : 'ASC'}`;
  }

  // Add pagination
  sql += ` LIMIT ${parseInt(limit, 10)} OFFSET ${parseInt(offset, 10)}`;

  const results = db.exec(sql);

  if (results.length === 0) {
    return { headers: [], rows: [] };
  }

  return {
    headers: results[0].columns,
    rows: results[0].values
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

  let sql = `SELECT COUNT(*) FROM "${table.replace(/"/g, '""')}"`;

  if (options.filter) {
    sql += ` WHERE ${options.filter}`;
  }

  const results = db.exec(sql);

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
  const tablesResult = db.exec(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `);
  const tables = (tablesResult[0]?.values || []).map(row => ({ name: row[0] }));

  // Get views
  const viewsResult = db.exec(`
    SELECT name FROM sqlite_master
    WHERE type = 'view'
    ORDER BY name
  `);
  const views = (viewsResult[0]?.values || []).map(row => ({ name: row[0] }));

  // Get indexes
  const indexesResult = db.exec(`
    SELECT name, tbl_name FROM sqlite_master
    WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `);
  const indexes = (indexesResult[0]?.values || []).map(row => ({
    name: row[0],
    table: row[1]
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

  const results = db.exec(`PRAGMA table_info("${table.replace(/"/g, '""')}")`);

  if (results.length === 0) {
    return [];
  }

  return results[0].values.map(row => ({
    cid: row[0],
    name: row[1],
    type: row[2],
    notnull: row[3],
    defaultValue: row[4],
    pk: row[5]
  }));
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
    'journal_mode',
    'synchronous',
    'foreign_keys',
    'auto_vacuum',
    'cache_size',
    'page_size',
    'encoding'
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

  // Sanitize pragma name
  const safePragma = pragma.replace(/[^a-z_]/gi, '');
  db.run(`PRAGMA ${safePragma} = ${value}`);
}

/**
 * Update a cell value.
 *
 * @param {string} table - Table name
 * @param {string|number} rowId - Row ID (rowid)
 * @param {string} column - Column name
 * @param {*} value - New value
 */
async function updateCell(table, rowId, column, value) {
  if (!db) throw new Error('No database initialized');

  const safeTable = table.replace(/"/g, '""');
  const safeColumn = column.replace(/"/g, '""');

  db.run(
    `UPDATE "${safeTable}" SET "${safeColumn}" = ? WHERE rowid = ?`,
    [value, rowId]
  );
}

/**
 * Insert a new row.
 *
 * @param {string} table - Table name
 * @param {Object} data - Column-value pairs
 * @returns {Promise<number>} Inserted row ID
 */
async function insertRow(table, data) {
  if (!db) throw new Error('No database initialized');

  const safeTable = table.replace(/"/g, '""');
  const columns = Object.keys(data);
  const values = Object.values(data);

  const columnList = columns.map(c => `"${c.replace(/"/g, '""')}"`).join(', ');
  const placeholders = columns.map(() => '?').join(', ');

  db.run(
    `INSERT INTO "${safeTable}" (${columnList}) VALUES (${placeholders})`,
    values
  );

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
  if (!db) throw new Error('No database initialized');

  const safeTable = table.replace(/"/g, '""');
  const placeholders = rowIds.map(() => '?').join(', ');

  db.run(
    `DELETE FROM "${safeTable}" WHERE rowid IN (${placeholders})`,
    rowIds
  );
}

/**
 * Delete columns from a table.
 * Note: SQLite <3.35.0 doesn't support DROP COLUMN, so we recreate the table.
 *
 * @param {string} table - Table name
 * @param {Array<string>} columns - Columns to delete
 */
async function deleteColumns(table, columns) {
  if (!db) throw new Error('No database initialized');

  // Get current table info
  const tableInfo = await getTableInfo(table);
  const remainingColumns = tableInfo.filter(c => !columns.includes(c.name));

  if (remainingColumns.length === 0) {
    throw new Error('Cannot delete all columns');
  }

  const safeTable = table.replace(/"/g, '""');
  const columnList = remainingColumns.map(c => `"${c.name.replace(/"/g, '""')}"`).join(', ');

  // Use transaction to recreate table without deleted columns
  db.run('BEGIN TRANSACTION');
  try {
    db.run(`CREATE TABLE "_temp_${safeTable}" AS SELECT ${columnList} FROM "${safeTable}"`);
    db.run(`DROP TABLE "${safeTable}"`);
    db.run(`ALTER TABLE "_temp_${safeTable}" RENAME TO "${safeTable}"`);
    db.run('COMMIT');
  } catch (e) {
    db.run('ROLLBACK');
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

  const safeTable = table.replace(/"/g, '""');
  const columnDefs = columns.map(col => {
    const name = col.name.replace(/"/g, '""');
    let def = `"${name}" ${col.type || 'TEXT'}`;
    if (col.pk) def += ' PRIMARY KEY';
    if (col.notnull) def += ' NOT NULL';
    if (col.defaultValue !== undefined && col.defaultValue !== null) {
      def += ` DEFAULT ${col.defaultValue}`;
    }
    return def;
  }).join(', ');

  db.run(`CREATE TABLE "${safeTable}" (${columnDefs})`);
}

/**
 * Batch update cells.
 *
 * @param {string} table - Table name
 * @param {Array<Object>} updates - Array of {rowId, column, value}
 */
async function updateCellBatch(table, updates) {
  if (!db) throw new Error('No database initialized');

  db.run('BEGIN TRANSACTION');
  try {
    for (const update of updates) {
      await updateCell(table, update.rowId, update.column, update.value);
    }
    db.run('COMMIT');
  } catch (e) {
    db.run('ROLLBACK');
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

  const safeTable = table.replace(/"/g, '""');
  const safeColumn = column.replace(/"/g, '""');

  let sql = `ALTER TABLE "${safeTable}" ADD COLUMN "${safeColumn}" ${type}`;
  if (defaultValue !== undefined && defaultValue !== null) {
    sql += ` DEFAULT ${defaultValue}`;
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

// ============================================================================
// RPC Message Handler
// ============================================================================

/**
 * Map of method names to handler functions.
 */
const methods = {
  initializeDatabase,
  runQuery,
  exportDatabase,
  fetchTableData,
  fetchTableCount,
  fetchSchema,
  getTableInfo,
  getPragmas,
  setPragma,
  updateCell,
  insertRow,
  deleteRows,
  deleteColumns,
  createTable,
  updateCellBatch,
  addColumn,
  ping
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
    const result = await handler(...(payload || []));

    self.postMessage({
      channel: 'rpc',
      content: {
        kind: 'response',
        messageId,
        success: true,
        data: result
      }
    });
  } catch (error) {
    console.error('[Worker] Method error:', targetMethod, error);

    self.postMessage({
      channel: 'rpc',
      content: {
        kind: 'response',
        messageId,
        success: false,
        errorMessage: error.message || 'Unknown error'
      }
    });
  }
};

// ============================================================================
// Worker Ready
// ============================================================================

console.log('[Worker] SQLite demo worker initialized');
