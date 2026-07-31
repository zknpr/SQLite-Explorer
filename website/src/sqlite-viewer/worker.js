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

import {
  buildCreateViewSql,
  extractViewColumnListSql,
  extractViewSelectSql,
  normalizeViewSelectSql
} from '../../../src/core/view-utils.ts';

// ============================================================================
// Configuration
// ============================================================================

/**
 * sql.js CDN URL for the JavaScript module.
 * Using jsDelivr for reliable global CDN delivery.
 */
const SQL_JS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/sql-wasm.js';
const DEFAULT_QUERY_TIMEOUT_MS = 30000;

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
// SQL Validation Utilities
// ============================================================================

/**
 * Escape a SQL identifier (table name, column name) for safe use in queries.
 * @param {string} identifier
 * @returns {string}
 */
function escapeIdentifier(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

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

function compileSingleStatement(sql) {
  const statement = prepareSingleStatement(sql);
  statement.free();
}

function querySingleStatement(sql) {
  const statement = prepareSingleStatement(sql);
  const rows = [];
  const startedAt = Date.now();
  try {
    while (true) {
      const hasRow = statement.step();
      if (Date.now() - startedAt > queryTimeout) {
        throw new Error(`Query execution timed out after ${queryTimeout}ms`);
      }
      if (!hasRow) break;
      rows.push(statement.get());
    }
    const headers = statement.getColumnNames();
    return { headers, rows };
  } finally {
    statement.free();
  }
}

function safeRollbackViewSavepoint(savepointName, context) {
  try {
    runSingleStatement(`ROLLBACK TO ${savepointName}`);
    runSingleStatement(`RELEASE ${savepointName}`);
  } catch (rollbackError) {
    console.warn(`Failed to rollback view savepoint (${context}):`, rollbackError);
  }
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
  // Close existing database
  if (db) {
    db.close();
    db = null;
  }

  queryTimeout = Number.isFinite(config.queryTimeout) && config.queryTimeout > 0
    ? config.queryTimeout
    : DEFAULT_QUERY_TIMEOUT_MS;
  readOnlyMode = config.readOnlyMode === true;

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
      sqlConfig.locateFile = (file) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/${file}`;
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

  return {
    operations: {},
    isReadOnly: readOnlyMode
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
 * Export a table to various formats (CSV, JSON, SQL).
 * For web demo, returns the data which the parent page will download.
 *
 * @param {Object} dbParams - Database parameters with 'table' property
 * @param {Array<string>} columns - Columns to export
 * @param {Object} _dbOptions - Database options (unused)
 * @param {Object} _tableStore - Table store (unused)
 * @param {Object} exportOptions - Export options including 'format'
 * @returns {Promise<Object>} Export result with content and filename
 */
async function exportTable(dbParams, columns, _dbOptions, _tableStore, exportOptions = {}) {
  if (!db) throw new Error('No database initialized');

  const table = dbParams?.table;
  if (!table) throw new Error('No table specified');

  const { format = 'csv', header = true, includeTableName = true, rowIds = null } = exportOptions;
  const safeTable = table.replace(/"/g, '""');

  // Build column list
  const columnList = columns && columns.length > 0
    ? columns.map(c => `"${c.replace(/"/g, '""')}"`).join(', ')
    : '*';

  // Build query
  let sql = `SELECT ${columnList} FROM "${safeTable}"`;

  // Filter by rowIds if specified
  if (rowIds && rowIds.length > 0) {
    const placeholders = rowIds.map(() => '?').join(', ');
    sql += ` WHERE rowid IN (${placeholders})`;
  }

  const results = db.exec(sql, rowIds || []);

  if (results.length === 0) {
    return { content: '', filename: `${table}.${format}`, mimeType: 'text/plain' };
  }

  const headers = results[0].columns;
  const rows = results[0].values;

  let content = '';
  let mimeType = 'text/plain';
  let filename = `${table}.${format}`;

  switch (format) {
    case 'csv':
      content = exportToCsv(headers, rows, header);
      mimeType = 'text/csv';
      break;
    case 'json':
      content = exportToJson(headers, rows);
      mimeType = 'application/json';
      break;
    case 'sql':
      content = exportToSql(table, headers, rows, includeTableName);
      mimeType = 'text/sql';
      break;
    case 'excel':
      // For Excel, just use CSV format (Excel can open CSV)
      content = exportToCsv(headers, rows, header);
      mimeType = 'text/csv';
      filename = `${table}.csv`;
      break;
    default:
      throw new Error(`Unsupported export format: ${format}`);
  }

  return { content, filename, mimeType };
}

/**
 * Convert data to CSV format.
 */
function exportToCsv(headers, rows, includeHeader) {
  const escapeCell = (val) => {
    if (val === null || val === undefined) return '';
    if (val instanceof Uint8Array) return '[BLOB]';
    const str = String(val);
    // Escape quotes and wrap in quotes if contains comma, quote, or newline
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [];
  if (includeHeader) {
    lines.push(headers.map(escapeCell).join(','));
  }
  for (const row of rows) {
    lines.push(row.map(escapeCell).join(','));
  }
  return lines.join('\n');
}

/**
 * Convert data to JSON format.
 */
function exportToJson(headers, rows) {
  const data = rows.map(row => {
    const obj = {};
    for (let i = 0; i < headers.length; i++) {
      let val = row[i];
      if (val instanceof Uint8Array) {
        val = `[BLOB: ${val.length} bytes]`;
      }
      obj[headers[i]] = val;
    }
    return obj;
  });
  return JSON.stringify(data, null, 2);
}

/**
 * Convert data to SQL INSERT statements.
 */
function exportToSql(table, headers, rows, includeTableName) {
  const tableName = includeTableName ? `"${table.replace(/"/g, '""')}"` : '"table_name"';
  const columnList = headers.map(h => `"${h.replace(/"/g, '""')}"`).join(', ');

  const escapeValue = (val) => {
    if (val === null || val === undefined) return 'NULL';
    if (val instanceof Uint8Array) return 'NULL'; // Can't represent BLOB in SQL text
    if (typeof val === 'number') return String(val);
    return `'${String(val).replace(/'/g, "''")}'`;
  };

  const statements = rows.map(row => {
    const values = row.map(escapeValue).join(', ');
    return `INSERT INTO ${tableName} (${columnList}) VALUES (${values});`;
  });

  return statements.join('\n');
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
    globalFilter = ''
  } = options;

  const safeTable = table.replace(/"/g, '""');

  // Build column list - if columns specified, use them; otherwise SELECT *
  let columnList;
  if (columns && columns.length > 0) {
    columnList = columns.map(c => `"${c.replace(/"/g, '""')}"`).join(', ');
  } else {
    columnList = '*';
  }

  let sql = `SELECT ${columnList} FROM "${safeTable}"`;

  // Build WHERE clause from filters array and globalFilter
  const whereClauses = [];
  const params = [];

  // Column-specific filters: [{column: 'name', value: 'foo'}, ...]
  if (filters && filters.length > 0) {
    for (const f of filters) {
      if (f.column && f.value) {
        const safeCol = f.column.replace(/"/g, '""');
        whereClauses.push(`"${safeCol}" LIKE ?`);
        params.push(`%${f.value}%`);
      }
    }
  }

  // Global filter: search across all text columns
  if (globalFilter && globalFilter.trim()) {
    // Get column names to search
    const searchCols = columns ? columns.filter(c => c !== 'rowid') : [];
    if (searchCols.length > 0) {
      const globalClauses = searchCols.map(c => {
        const safeCol = c.replace(/"/g, '""');
        return `"${safeCol}" LIKE ?`;
      });
      whereClauses.push(`(${globalClauses.join(' OR ')})`);
      // Add the global filter parameter for each column in the OR clause
      for (let i = 0; i < searchCols.length; i++) {
        params.push(`%${globalFilter}%`);
      }
    }
  }

  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(' AND ')}`;
  }

  // Add ordering
  if (orderBy) {
    sql += ` ORDER BY "${orderBy.replace(/"/g, '""')}" ${orderDir === 'DESC' ? 'DESC' : 'ASC'}`;
  }

  // Add pagination
  sql += ` LIMIT ${parseInt(limit, 10)} OFFSET ${parseInt(offset, 10)}`;

  const results = db.exec(sql, params);

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

  const {
    columns = [],
    filters = [],
    globalFilter = ''
  } = options;

  const safeTable = table.replace(/"/g, '""');
  let sql = `SELECT COUNT(*) FROM "${safeTable}"`;

  // Build WHERE clause from filters array and globalFilter
  const whereClauses = [];
  const params = [];

  // Column-specific filters
  if (filters && filters.length > 0) {
    for (const f of filters) {
      if (f.column && f.value) {
        const safeCol = f.column.replace(/"/g, '""');
        whereClauses.push(`"${safeCol}" LIKE ?`);
        params.push(`%${f.value}%`);
      }
    }
  }

  // Global filter
  if (globalFilter && globalFilter.trim()) {
    const searchCols = columns.filter(c => c !== 'rowid');
    if (searchCols.length > 0) {
      const globalClauses = searchCols.map(c => {
        const safeCol = c.replace(/"/g, '""');
        return `"${safeCol}" LIKE ?`;
      });
      whereClauses.push(`(${globalClauses.join(' OR ')})`);
      // Add the global filter parameter for each column in the OR clause
      for (let i = 0; i < searchCols.length; i++) {
        params.push(`%${globalFilter}%`);
      }
    }
  }

  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(' AND ')}`;
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
  const tables = (tablesResult[0]?.values || []).map(row => ({ identifier: row[0] }));

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

  if (columns.length === 0) {
    db.run(`INSERT INTO "${safeTable}" DEFAULT VALUES`);
  } else {
    const columnList = columns.map(c => `"${c.replace(/"/g, '""')}"`).join(', ');
    const placeholders = columns.map(() => '?').join(', ');

    db.run(
      `INSERT INTO "${safeTable}" (${columnList}) VALUES (${placeholders})`,
      values
    );
  }

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
  const columnsSet = new Set(columns);
  const remainingColumns = tableInfo.filter(c => !columnsSet.has(c.identifier));

  if (remainingColumns.length === 0) {
    throw new Error('Cannot delete all columns');
  }

  const safeTable = table.replace(/"/g, '""');
  const columnList = remainingColumns.map(c => `"${c.identifier.replace(/"/g, '""')}"`).join(', ');

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

async function readViewDefinition(view, allowUnparsed = false) {
  if (!db) throw new Error('No database initialized');
  const viewResult = db.exec(
    "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = ?",
    [view]
  );
  const createSql = viewResult[0]?.values?.[0]?.[0];
  if (typeof createSql !== 'string') throw new Error(`View not found: ${view}`);

  const triggerResult = db.exec(
    "SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ? ORDER BY rowid",
    [view]
  );
  const triggers = (triggerResult[0]?.values || []).map(row => {
    if (typeof row[0] !== 'string' || typeof row[1] !== 'string') {
      throw new Error(`View trigger definition is unavailable for ${view}`);
    }
    return { identifier: row[0], sql: row[1] };
  });

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
    triggers
  };
}

async function getViewDefinition(view) {
  return readViewDefinition(view, false);
}

async function validateViewDefinition(view, selectSql) {
  if (!db) throw new Error('No database initialized');
  if (readOnlyMode) {
    throw new Error('View validation is unavailable because the database is read-only');
  }
  const body = normalizeViewSelectSql(selectSql);
  const existingResult = db.exec(
    "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = ?",
    [view]
  );
  const existingSql = existingResult[0]?.values?.[0]?.[0];
  const columnListSql = typeof existingSql === 'string'
    ? extractViewColumnListSql(existingSql)
    : undefined;
  const savepointName = createViewSavepointName('sp_validate_view');
  runSingleStatement(`SAVEPOINT ${savepointName}`);
  try {
    if (typeof existingSql === 'string') {
      runSingleStatement(`DROP VIEW ${escapeIdentifier(view)}`);
    }
    runSingleStatement(buildCreateViewSql(view, body, columnListSql));
    compileSingleStatement(`EXPLAIN SELECT * FROM ${escapeIdentifier(view)}`);
    runSingleStatement(`ROLLBACK TO ${savepointName}`);
    runSingleStatement(`RELEASE ${savepointName}`);
  } catch (error) {
    safeRollbackViewSavepoint(savepointName, 'validateViewDefinition');
    throw error;
  }
}

async function previewViewDefinition(_view, selectSql, limit = 50) {
  if (!db) throw new Error('No database initialized');
  const body = normalizeViewSelectSql(selectSql);
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 50));
  return querySingleStatement(`SELECT * FROM (${body}\n) LIMIT ${boundedLimit}`);
}

async function createView(view, selectSql) {
  if (!db) throw new Error('No database initialized');
  const body = normalizeViewSelectSql(selectSql);
  compileSingleStatement(`EXPLAIN SELECT * FROM (${body}\n) LIMIT 0`);
  const savepointName = createViewSavepointName('sp_create_view');
  runSingleStatement(`SAVEPOINT ${savepointName}`);
  try {
    runSingleStatement(buildCreateViewSql(view, body));
    compileSingleStatement(`EXPLAIN SELECT * FROM ${escapeIdentifier(view)}`);
    const definition = await getViewDefinition(view);
    runSingleStatement(`RELEASE ${savepointName}`);
    return definition;
  } catch (error) {
    safeRollbackViewSavepoint(savepointName, 'createView');
    throw error;
  }
}

async function editView(view, selectSql, preserveTriggers = true) {
  if (!db) throw new Error('No database initialized');
  const body = normalizeViewSelectSql(selectSql);
  const before = await getViewDefinition(view);
  compileSingleStatement(`EXPLAIN SELECT * FROM (${body}\n) LIMIT 0`);
  const savepointName = createViewSavepointName('sp_edit_view');
  runSingleStatement(`SAVEPOINT ${savepointName}`);
  try {
    runSingleStatement(`DROP VIEW ${escapeIdentifier(view)}`);
    runSingleStatement(buildCreateViewSql(view, body, before.columnListSql, before.columns));
    compileSingleStatement(`EXPLAIN SELECT * FROM ${escapeIdentifier(view)}`);
    if (preserveTriggers) {
      for (const trigger of before.triggers) runSingleStatement(trigger.sql);
    }
    const after = await getViewDefinition(view);
    runSingleStatement(`RELEASE ${savepointName}`);
    return { before, after };
  } catch (error) {
    safeRollbackViewSavepoint(savepointName, 'editView');
    throw error;
  }
}

async function dropView(view) {
  if (!db) throw new Error('No database initialized');
  const before = await readViewDefinition(view, true);
  const savepointName = createViewSavepointName('sp_drop_view');
  runSingleStatement(`SAVEPOINT ${savepointName}`);
  try {
    runSingleStatement(`DROP VIEW ${escapeIdentifier(view)}`);
    runSingleStatement(`RELEASE ${savepointName}`);
    return before;
  } catch (error) {
    safeRollbackViewSavepoint(savepointName, 'dropView');
    throw error;
  }
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
  exportDatabase,
  exportTable,
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
  getViewDefinition,
  validateViewDefinition,
  previewViewDefinition,
  createView,
  editView,
  dropView,
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
