/**
 * Core Type Definitions for SQLite Explorer
 *
 * Contains all type definitions used throughout the extension.
 * Uses a consistent naming scheme different from external libraries.
 */

// ============================================================================
// Primitive Types
// ============================================================================

/**
 * Content type information for cell values.
 * Used when opening cell editors to determine file extension and handling.
 */
export interface CellContentType {
  /** MIME type (e.g., 'image/png', 'application/json') */
  mime?: string;
  /** File extension (e.g., 'png', 'json') */
  ext?: string;
  /** Content type category or SQL type name */
  type?: string;
}

/**
 * Represents any value that can be stored in a SQLite cell.
 * Includes text, integers, floats, binary data, and NULL.
 */
export type CellValue = string | number | bigint | null | Uint8Array;

/**
 * Sparse exact SQLite text for numeric cells whose Number transport is lossy
 * (unsafe INTEGERs) or whose REAL text differs from JavaScript formatting.
 */
export type ExactIntegerTextMap = Record<number, Record<number, string>>;

/**
 * Unique identifier for a database row.
 * Can be numeric ROWID or string for compatibility.
 */
export type RecordId = string | number;

// ============================================================================
// Query Types
// ============================================================================

/**
 * Result set from a database query execution.
 * Contains column headers and row data.
 * Includes multiple naming conventions for compatibility:
 * - headers/rows: Primary naming convention
 * - columns/values: sql.js compatible aliases
 * - columnNames/records: Used by webview (core/ui/viewer.html) for schema queries
 */
export interface QueryResultSet {
  /** Column names in order (primary naming) */
  headers: string[];
  /** Row data as 2D array (primary naming) */
  rows: CellValue[][];
  /** Sparse row/column sidecar for numeric text lost by the number-based grid contract. */
  exactIntegerTexts?: ExactIntegerTextMap;
  /** Column names - sql.js compatible alias for webview */
  columns?: string[];
  /** Row data - sql.js compatible alias for webview */
  values?: CellValue[][];
  /** Column names - webview schema query compatibility */
  columnNames?: string[];
  /** Row data - webview schema query compatibility (core/ui/viewer.html) */
  records?: CellValue[][];
}

/**
 * Column metadata from PRAGMA table_info.
 */
export interface ColumnMetadata {
  /** Column index (0-based) */
  ordinal: number;
  /** Column name */
  identifier: string;
  /** Declared type */
  declaredType: string;
  /** NOT NULL constraint flag */
  isRequired: number;
  /** Default value expression */
  defaultExpression: CellValue;
  /** Primary key position (0 if not PK) */
  primaryKeyPosition: number;
}

/**
 * Table metadata for schema display.
 */
export interface TableMetadata {
  /** Table name */
  identifier: string;
  /** Number of columns */
  columnCount?: number;
}

/**
 * View metadata for schema display.
 */
export interface ViewMetadata {
  /** View name */
  identifier: string;
}

/**
 * SQL definition for an INSTEAD OF trigger attached to a view.
 */
export interface ViewTriggerDefinition {
  /** Trigger name */
  identifier: string;
  /** Original CREATE TRIGGER statement from sqlite_schema */
  sql: string;
  /** True when the trigger belongs to the connection-local temp schema. */
  temporary?: boolean;
}

/**
 * Complete definition needed to recreate a view without losing its triggers.
 */
export interface ViewDefinition {
  /** View name */
  identifier: string;
  /** Original CREATE VIEW statement from sqlite_schema */
  sql: string;
  /** SELECT body editable by the user */
  selectSql: string;
  /** Verbatim explicit output column-list SQL, including parentheses. */
  columnListSql?: string;
  /** Legacy reconstructed output names retained for serialized history compatibility. */
  columns?: string[];
  /** INSTEAD OF triggers owned by the view */
  triggers: ViewTriggerDefinition[];
}

/** Whether validation/preview is for a new view or an existing replacement. */
export type ViewDefinitionIntent = 'create' | 'edit';

/**
 * Atomic view replacement result used by undo/redo tracking.
 */
export interface ViewEditResult {
  before: ViewDefinition;
  after: ViewDefinition;
}

/**
 * Index metadata for schema display.
 */
export interface IndexMetadata {
  /** Index name */
  identifier: string;
  /** Parent table name */
  parentTable: string;
}

/**
 * Complete database schema structure.
 */
export interface SchemaSnapshot {
  /** All tables in database */
  tables: TableMetadata[];
  /** All views in database */
  views: ViewMetadata[];
  /** All indexes in database */
  indexes: IndexMetadata[];
}

// ============================================================================
// Edit Tracking Types
// ============================================================================

/**
 * Types of database modifications that can be tracked.
 */
export type ModificationType =
  | 'cell_update'
  | 'row_insert'
  | 'row_delete'
  | 'table_create'
  | 'column_add'
  | 'column_drop'
  | 'table_drop'
  | 'view_create'
  | 'view_edit'
  | 'view_drop';

/**
 * How a cell value should be applied when replaying a cell update.
 */
export type CellUpdateOperation = 'set' | 'json_patch';

/**
 * Record of a single database modification for undo/redo.
 */
export interface ModificationEntry {
  /** Human-readable description */
  description: string;
  /** Type of modification */
  modificationType: ModificationType;
  /** Affected table name */
  targetTable?: string;
  /** Affected row ID */
  targetRowId?: RecordId;
  /** Affected column name */
  targetColumn?: string;
  /** Value before modification */
  priorValue?: CellValue;
  /** Value after modification */
  newValue?: CellValue;
  /** Cell update operation; missing values from older backups are treated as set. */
  operation?: CellUpdateOperation;
  /** Raw SQL executed */
  executedQuery?: string;
  /** Multiple affected rows */
  affectedRowIds?: RecordId[];
  /** Multiple affected cells (for batch updates) */
  affectedCells?: {
    rowId: RecordId;
    columnName: string;
    priorValue?: CellValue;
    newValue?: CellValue;
    /** Per-cell operation; missing values from older backups are treated as set. */
    operation?: CellUpdateOperation;
  }[];
  /** Row data for insert/delete undo/redo */
  rowData?: Record<string, CellValue>;
  /** Multiple deleted rows data */
  deletedRows?: { rowId: RecordId; row: Record<string, CellValue> }[];
  /** Table definition for create/drop undo/redo */
  tableDef?: { columns: ColumnDefinition[] };
  /** Column definition for add/drop undo/redo */
  columnDef?: { type: string; defaultValue?: string };
  /** Deleted columns data for column_drop undo */
  deletedColumns?: {
      name: string;
      type: string;
      data: { rowId: RecordId; value: CellValue }[];
  }[];
  /** Indexes dropped before a column_drop; missing values from older backups mean none. */
  droppedIndexes?: string[];
  /** View definition before an edit/drop. */
  viewDefBefore?: ViewDefinition;
  /** View definition after a create/edit. */
  viewDefAfter?: ViewDefinition;
}

/**
 * Extended modification entry with UI label.
 */
export interface LabeledModification extends ModificationEntry {
  /** Short label for undo/redo menu */
  label: string;
}

// ============================================================================
// Database Interface Types
// ============================================================================

/**
 * Interface for database operations exposed by worker.
 */
export interface DatabaseOperations {
  /** Engine type identifier: 'wasm' for sql.js, 'native' for txiki-js */
  readonly engineKind: Promise<'wasm' | 'native'>;

  /** Execute SQL query */
  executeQuery(sql: string, params?: CellValue[]): Promise<QueryResultSet[]>;

  /** Export database to binary */
  serializeDatabase(): Promise<Uint8Array>;

  /** Apply pending modifications */
  applyModifications(mods: ModificationEntry[], signal?: AbortSignal): Promise<void>;

  /** Undo a single modification */
  undoModification(mod: ModificationEntry): Promise<void>;

  /** Redo a single modification */
  redoModification(mod: ModificationEntry): Promise<void>;

  /** Persist all changes */
  flushChanges(signal?: AbortSignal): Promise<void>;

  /** Discard pending changes */
  discardModifications(mods: ModificationEntry[], signal?: AbortSignal): Promise<void>;

  /** Update a single cell value */
  updateCell(table: string, rowId: RecordId, column: string, value: CellValue, patch?: string): Promise<void>;

  /** Insert a new row */
  insertRow(table: string, data: Record<string, CellValue>): Promise<RecordId | undefined>;

  /** Insert multiple rows in a batch */
  insertRowBatch(table: string, rows: Record<string, CellValue>[]): Promise<void>;

  /** Delete rows by ID */
  deleteRows(table: string, rowIds: RecordId[]): Promise<void>;

  /** Delete columns by name */
  deleteColumns(table: string, columns: string[], dropDependentIndexes?: string[]): Promise<void>;

  /** Find indexes that depend on specific columns */
  findDependentIndexes(table: string, columns: string[]): Promise<string[]>;

  /** Create a new table */
  createTable(table: string, columns: ColumnDefinition[]): Promise<void>;

  /** Read a view and the INSTEAD OF triggers that must survive replacement. */
  getViewDefinition(view: string): Promise<ViewDefinition>;

  /** Compile a proposed SELECT body without changing the schema. */
  validateViewDefinition(
    view: string,
    selectSql: string,
    intent?: ViewDefinitionIntent
  ): Promise<void>;

  /** Compile and execute a bounded preview of a proposed SELECT body. */
  previewViewDefinition(
    view: string,
    selectSql: string,
    limit?: number,
    intent?: ViewDefinitionIntent
  ): Promise<QueryResultSet>;

  /** Create a view from a SELECT body. */
  createView(view: string, selectSql: string): Promise<ViewDefinition>;

  /** Atomically replace a view, optionally guarded by its expected stored definition. */
  editView(
    view: string,
    selectSql: string,
    preserveTriggers?: boolean,
    expectedSql?: string,
    expectedTriggers?: readonly ViewTriggerDefinition[]
  ): Promise<ViewEditResult>;

  /** Drop a view and return its undo definition, optionally guarded by a confirmed snapshot. */
  dropView(
    view: string,
    expectedSql?: string,
    expectedTriggers?: readonly ViewTriggerDefinition[]
  ): Promise<ViewDefinition>;

  /** Update multiple cells in a batch */
  updateCellBatch(table: string, updates: CellUpdate[]): Promise<void>;

  /** Add a new column to a table */
  addColumn(table: string, column: string, type: string, defaultValue?: string): Promise<void>;

  /** Fetch table data */
  fetchTableData(table: string, options: TableQueryOptions): Promise<QueryResultSet>;

  /** Fetch table row count */
  fetchTableCount(table: string, options: TableCountOptions): Promise<number>;

  /** Fetch database schema */
  fetchSchema(): Promise<SchemaSnapshot>;

  /** Get table metadata (columns) */
  getTableInfo(table: string): Promise<ColumnMetadata[]>;

  /** Get PRAGMA settings */
  getPragmas(): Promise<Record<string, CellValue>>;

  /** Set PRAGMA value */
  setPragma(pragma: string, value: CellValue): Promise<void>;

  /** Test database connection */
  ping(): Promise<boolean>;

  /** Write database directly to file system (optimization) */
  writeToFile(path: string): Promise<void>;
}

/**
 * Represents a single cell update.
 */
export interface CellUpdate {
  rowId: RecordId;
  column: string;
  value: CellValue;
  originalValue?: CellValue;
  operation?: CellUpdateOperation;
}

/**
 * Definition for a new column when creating a table.
 */
export interface ColumnDefinition {
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  defaultValue?: string;
}

// ============================================================================
// Read Query Types
// ============================================================================

export interface TableQueryOptions {
  columns?: string[];
  /** Displayed columns eligible for the global filter, excluding identity-only SELECT fields. */
  globalFilterColumns?: string[];
  orderBy?: string;
  orderDir?: 'ASC' | 'DESC';
  limit?: number;
  offset?: number;
  filters?: {
    column: string;
    value: string;
  }[];
  globalFilter?: string;
}

export interface TableCountOptions {
  columns?: string[];
  /** Displayed columns eligible for the global filter, matching TableQueryOptions. */
  globalFilterColumns?: string[];
  filters?: {
    column: string;
    value: string;
  }[];
  globalFilter?: string;
}

// ============================================================================
// Export Types
// ============================================================================

/**
 * Parameters identifying the database and table for export.
 */
export interface DbParams {
  /** Database filename */
  filename?: string;
  /** Table name to export */
  table: string;
  /** Schema/display name */
  name?: string;
  /** Document URI */
  uri?: string;
}

/**
 * Options controlling export format and behavior.
 */
export interface ExportOptions {
  /** Output format */
  format?: string;
  /** Include column header row */
  header?: boolean;
  /** Include table name in SQL output */
  includeTableName?: boolean;
  /** Specific row IDs to export */
  rowIds?: (string | number)[];
}

// ============================================================================
// Worker Communication Types
// ============================================================================

/**
 * Configuration for initializing a database connection.
 */
export interface DatabaseInitConfig {
  /** Database binary content */
  content: Uint8Array | null;
  /** Path to database file (for direct reading in worker) */
  filePath?: string;
  /** WAL file content if present */
  walContent?: Uint8Array | null;
  /** Maximum allowed file size */
  maxSize: number;
  /** Path mappings for resources */
  resourceMap?: Record<string, string>;
  /** Pre-loaded WASM module */
  wasmBinary?: Uint8Array;
  /** Open in read-only mode */
  readOnlyMode?: boolean;
  /** Query execution timeout in milliseconds */
  queryTimeout?: number;
}

/**
 * Result from database initialization.
 */
export interface DatabaseInitResult {
  /** Database operations handle */
  operations?: DatabaseOperations;
  /** Whether opened in read-only mode */
  isReadOnly: boolean;
}

// ============================================================================
// Dialog Types
// ============================================================================

/**
 * Options for modal dialogs.
 */
export interface DialogConfig {
  /** Show as modal dialog */
  modal?: boolean;
  /** Additional detail text */
  detailText?: string;
}

/**
 * Button in a dialog.
 */
export interface DialogButton {
  /** Button label */
  caption: string;
  /** Whether clicking closes dialog */
  isCloseAction?: boolean;
}
