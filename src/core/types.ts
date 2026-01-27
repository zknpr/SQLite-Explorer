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
 * Represents any value that can be stored in a SQLite cell.
 * Includes text, integers, floats, binary data, and NULL.
 */
export type CellValue = string | number | null | Uint8Array;

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
  | 'table_drop';

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
  serializeDatabase(name: string): Promise<Uint8Array>;

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

  /** Delete rows by ID */
  deleteRows(table: string, rowIds: RecordId[]): Promise<void>;

  /** Delete columns by name */
  deleteColumns(table: string, columns: string[]): Promise<void>;

  /** Create a new table */
  createTable(table: string, columns: ColumnDefinition[]): Promise<void>;

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
  operation?: 'set' | 'json_patch';
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
  filters?: {
    column: string;
    value: string;
  }[];
  globalFilter?: string;
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
}

/**
 * Result from database initialization.
 */
export interface DatabaseInitResult {
  /** Database operations handle */
  operations: DatabaseOperations;
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
