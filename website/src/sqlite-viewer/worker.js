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
import { escapeLikePattern, validateRowId } from '../../../src/core/sql-utils.ts';
import { getActiveFilterValue } from '../../../src/core/filter-utils.ts';
import {
  applyMergePatch,
  computeJsonPatchUndo,
  parseJsonValueForPatching,
  prepareCellUpdateForStorage
} from '../../../src/core/json-utils.ts';
import {
  buildRecordIdentitiesPredicate,
  buildRecordIdentityPredicate,
  encodePrimaryKeyRecordId,
  isPrimaryKeyRecordId,
  primaryKeyColumnsFromTableInfo
} from '../../../src/core/row-identity.ts';
import {
  buildExactNumericTextQuery,
  buildRowIdExactRealTextQueries,
  collectRowIdExactRealTexts,
  hasUnsafeBigIntAtColumn,
  normalizeIntegerRowsForTransport,
  ROWID_TABLE_AUTHORITY_SQL
} from '../../../src/core/integer-utils.ts';

// ============================================================================
// Configuration
// ============================================================================

/** Package-aligned sql.js CDN base shared by the loader and WASM resolver. */
const SQL_JS_VERSION = '1.14.1';
const SQL_JS_CDN_BASE = `https://cdnjs.cloudflare.com/ajax/libs/sql.js/${SQL_JS_VERSION}`;
const SQL_JS_CDN = `${SQL_JS_CDN_BASE}/sql-wasm.js`;
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

function normalizeBindParams(params) {
  return params?.map(value => typeof value === 'bigint' ? value.toString() : value);
}

function compileSingleStatement(sql) {
  const statement = prepareSingleStatement(sql);
  statement.free();
}

function querySingleStatement(sql) {
  const sourceStatement = prepareSingleStatement(sql);
  const headers = sourceStatement.getColumnNames();
  sourceStatement.free();
  const transportQuery = buildExactNumericTextQuery(sql, headers.length);
  const statement = prepareSingleStatement(transportQuery.sql);
  const sourceRows = [];
  const startedAt = Date.now();
  try {
    while (true) {
      const hasRow = statement.step();
      if (Date.now() - startedAt > queryTimeout) {
        throw new Error(`Query execution timed out after ${queryTimeout}ms`);
      }
      if (!hasRow) break;
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
      sqlConfig.locateFile = (file) => `${SQL_JS_CDN_BASE}/${file}`;
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
  if (readOnlyMode) {
    // Defense in depth for every current and future RPC path. Public mutators
    // still fail early with operation-specific errors, while SQLite itself
    // refuses an accidentally unguarded write on this connection.
    db.run('PRAGMA query_only = ON');
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
  if (readOnlyMode) {
    // This low-level test/debug RPC accepts arbitrary SQL, so there is no safe
    // statement-level capability distinction to infer in JavaScript.
    throw new Error('Ad hoc SQL execution is unavailable because the database is read-only');
  }

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
  // Build column list
  const columnList = columns && columns.length > 0
    ? columns.map(escapeIdentifier).join(', ')
    : '*';

  // Build query
  let sql = `SELECT ${columnList} FROM ${escapeIdentifier(table)}`;
  let params = [];

  // Filter by rowIds if specified
  if (rowIds && rowIds.length > 0) {
    const identity = await resolveTableIdentity(table);
    if (rowIds.some(isPrimaryKeyRecordId) && !rowIds.every(isPrimaryKeyRecordId)) {
      throw new Error('Cannot mix rowid and primary-key row identities');
    }
    const predicate = buildRecordIdentitiesPredicate(rowIds, identity);
    sql += ` WHERE ${predicate.sql}`;
    params = predicate.params;
  }

  const results = db.exec(sql, params);

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

async function findTableIdentity(table) {
  const metadata = db.exec(
    `SELECT "wr" FROM pragma_table_list ` +
    `WHERE "schema" = 'main' AND "name" = ? AND "type" = 'table' LIMIT 1`,
    [table]
  );
  if ((metadata[0]?.values.length ?? 0) === 0) return undefined;
  if (Number(metadata[0].values[0][0]) !== 1) return { kind: 'rowid' };
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
  if (columns?.[0]?.toLowerCase() === 'rowid') {
    const identity = await findTableIdentity(table);
    if (identity?.kind === 'primaryKey') {
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
    }
  }

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
  const params = [];

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

  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(' AND ')}`;
  }

  // Add ordering
  const orderedColumns = identityOrderBy ?? (effectiveOrderBy ? [effectiveOrderBy] : []);
  if (orderedColumns.length > 0) {
    const direction = orderDir === 'DESC' ? 'DESC' : 'ASC';
    sql += ` ORDER BY ${orderedColumns
      .map(column => `${escapeIdentifier(column)} ${direction}`)
      .join(', ')}`;
  }

  // Add pagination
  sql += ` LIMIT ${parseInt(limit, 10)} OFFSET ${parseInt(offset, 10)}`;

  const sourceStatement = db.prepare(sql, params);
  const headers = sourceStatement.getColumnNames();
  sourceStatement.free();
  const transportQuery = buildExactNumericTextQuery(sql, headers.length);
  const results = db.exec(transportQuery.sql, params, { useBigInt: true });

  const sourceRows = results[0]?.values ?? [];
  const companionResults = [];
  let isRowIdTable = false;
  const hasRowIdShape = headers[0]?.toLowerCase() === 'rowid';
  const needsExactRowIdIdentity = hasRowIdShape
    && hasUnsafeBigIntAtColumn(sourceRows, 0);
  const needsRowIdCompanions = transportQuery.valueColumnCount === undefined
    && hasRowIdShape;
  // The demo owns a private in-memory database, so no external process can
  // commit between the source read and this authority/companion work.
  if (
    (needsRowIdCompanions || needsExactRowIdIdentity)
    && sourceRows.length > 0
  ) {
    const authority = db.exec(ROWID_TABLE_AUTHORITY_SQL, [table]);
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
  const { rows, exactIntegerTexts } = normalizeIntegerRowsForTransport(
    sourceRows,
    transportQuery.valueColumnCount,
    companionExactTexts,
    isRowIdTable && needsExactRowIdIdentity ? 0 : undefined
  );
  if (primaryKeyContext) {
    const primaryKeyIndices = primaryKeyContext.identity.columns.map(column => {
      const index = headers.indexOf(column.identifier);
      if (index < 0) {
        throw new Error(`Primary-key column missing from table fetch: ${column.identifier}`);
      }
      return index;
    });
    const visibleColumnCount = primaryKeyContext.visibleColumns.length;
    const identities = sourceRows.map(row => encodePrimaryKeyRecordId(
      primaryKeyContext.identity.columns,
      primaryKeyIndices.map(index => row[index])
    ));
    let shiftedExactIntegerTexts;
    if (exactIntegerTexts) {
      for (const [rowIndexText, exactRow] of Object.entries(exactIntegerTexts)) {
        for (const [columnIndexText, exactText] of Object.entries(exactRow)) {
          const columnIndex = Number(columnIndexText);
          if (columnIndex >= visibleColumnCount) continue;
          shiftedExactIntegerTexts ??= {};
          shiftedExactIntegerTexts[Number(rowIndexText)] ??= {};
          shiftedExactIntegerTexts[Number(rowIndexText)][columnIndex + 1] = exactText;
        }
      }
    }
    return {
      headers: ['rowid', ...primaryKeyContext.visibleColumns],
      rows: rows.map((row, index) => [
        identities[index],
        ...row.slice(0, visibleColumnCount)
      ]),
      exactIntegerTexts: shiftedExactIntegerTexts
    };
  }
  return {
    headers,
    rows,
    exactIntegerTexts
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
  const tables = await Promise.all((tablesResult[0]?.values || []).map(async row => ({
    identifier: row[0],
    identity: await resolveTableIdentity(row[0])
  })));

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
async function updateCell(table, rowId, column, value) {
  if (!db) throw new Error('No database initialized');
  assertWritableMutation('Cell updates');

  if (isPrimaryKeyRecordId(rowId)) {
    const outcomes = await updateCellBatch(table, [{
      rowId,
      column,
      value,
      operation: 'set'
    }]);
    return outcomes[0]?.newRowId ?? rowId;
  }

  db.run(
    `UPDATE ${escapeIdentifier(table)} SET ${escapeIdentifier(column)} = ? WHERE rowid = ?`,
    [value, rowId]
  );
  return validateRowId(rowId);
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
  assertWritableMutation('Row insertion');

  const columns = Object.keys(data);
  const values = Object.values(data);
  const identity = await resolveTableIdentity(table);

  let insertSql;

  if (columns.length === 0) {
    insertSql = `INSERT INTO ${escapeIdentifier(table)} DEFAULT VALUES`;
  } else {
    const columnList = columns.map(escapeIdentifier).join(', ');
    const placeholders = columns.map(() => '?').join(', ');

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
      const current = db.exec(
        `SELECT * FROM ${escapeIdentifier(table)} WHERE ${predicate.sql}`,
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

  const placeholders = rowIds.map(() => '?').join(', ');

  db.run(
    `DELETE FROM ${escapeIdentifier(table)} WHERE rowid IN (${placeholders})`,
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
  assertWritableMutation('Column deletion');

  // Get current table info
  const tableInfo = await getTableInfo(table);
  const columnsSet = new Set(columns);
  const remainingColumns = tableInfo.filter(c => !columnsSet.has(c.identifier));

  if (remainingColumns.length === 0) {
    throw new Error('Cannot delete all columns');
  }

  const safeTable = table.replace(/"/g, '""');
  const columnList = remainingColumns.map(c => `"${c.identifier.replace(/"/g, '""')}"`).join(', ');

  const savepointName = createViewSavepointName('sp_delete_columns');
  runSingleStatement(`SAVEPOINT ${savepointName}`);
  try {
    db.run(`CREATE TABLE "_temp_${safeTable}" AS SELECT ${columnList} FROM "${safeTable}"`);
    db.run(`DROP TABLE "${safeTable}"`);
    db.run(`ALTER TABLE "_temp_${safeTable}" RENAME TO "${safeTable}"`);
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

async function previewViewDefinition(view, selectSql, limit = 50, intent = 'edit') {
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
        `SELECT * FROM ${previewSource} LIMIT ${boundedLimit}`
      );
    }
    return querySingleStatement(
      `WITH ${previewSource} AS (${body}\n) ` +
      `SELECT * FROM ${previewSource} LIMIT ${boundedLimit}`
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
      `SELECT * FROM ${escapeMainViewIdentifier(view)} LIMIT ${boundedLimit}`
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
      for (const cell of cells) {
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
      await updateCellBatch(targetTable, updates);
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
          await insertRow(targetTable, deletedRow.row);
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
      await updateCellBatch(targetTable, updates);
      return;
    }
    case 'row_insert': {
      const dataToInsert = targetRowId !== undefined && !isPrimaryKeyRecordId(targetRowId)
        ? { rowid: targetRowId, ...(rowData ?? {}) }
        : (rowData ?? {});
      await insertRow(targetTable, dataToInsert);
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
async function updateCellBatch(table, updates) {
  if (!db) throw new Error('No database initialized');
  assertWritableMutation('Batch cell updates');

  if (updates.length === 0) return [];

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
          return { update, priorValue, prepared, storedValue };
        });
        const setClause = preparedUpdates.map(({ update }) => (
          `${escapeIdentifier(update.column)} = ?`
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
        : `UPDATE ${escapedTable} SET ${escapedColumn} = ? WHERE rowid = ?`;
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
