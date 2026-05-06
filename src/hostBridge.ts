/**
 * Host Bridge Module
 *
 * Provides methods exposed to the webview for communicating with VS Code.
 * These methods are called via RPC from the webview to perform operations
 * like file operations, dialogs, and database queries.
 */

import * as vsc from 'vscode';
import * as path from 'path';

import type { DatabaseEditorProvider, DatabaseViewerProvider } from './editorController';
import { ConfigurationSection, ExtensionId, SidebarLeft, SidebarRight, UriScheme } from './config';
import { IsCursorIDE } from './helpers';

import type { DatabaseDocument, DocumentModification } from './databaseModel';
import type { CellValue, RecordId, DialogConfig, DialogButton, CellUpdate, TableQueryOptions, TableCountOptions, QueryResultSet, SchemaSnapshot, ColumnMetadata, CellContentType, ModificationEntry, DbParams, ExportOptions } from './core/types';
import { generateMergePatch } from './core/json-utils';
import { escapeIdentifier } from './core/sql-utils';

// Type for Uint8Array-like objects (transferable over postMessage)
type Uint8ArrayLike = { buffer: ArrayBufferLike, byteOffset: number, byteLength: number };

// Column type information
interface ColumnTypeInfo {
  [key: string]: unknown;
}

// Toast service interface for showing dialogs
interface ToastService {
  showInformationToast<T extends string | DialogButton>(message: string, options?: DialogConfig, ...items: T[]): Promise<T | undefined>;
  showWarningToast<T extends string | DialogButton>(message: string, options?: DialogConfig, ...items: T[]): Promise<T | undefined>;
  showErrorToast<T extends string | DialogButton>(message: string, options?: DialogConfig, ...items: T[]): Promise<T | undefined>;
}

/**
 * Bridge between VS Code host and webview.
 *
 * These methods are called from within the webview via the RPC mechanism.
 * They provide access to VS Code APIs and extension functionality.
 */
export class HostBridge implements ToastService {
  constructor(
    private readonly viewerProvider: DatabaseEditorProvider | DatabaseViewerProvider,
    private readonly document: DatabaseDocument,
  ) { }

  // Getters for provider properties
  private get webviews() { return this.viewerProvider.webviews; }
  private get reporter() { return this.viewerProvider.reporter; }
  private get context() { return this.viewerProvider.context; }

  /**
   * Ensures the database operations are initialized and returns them.
   * Throws an error if they are not.
   */
  private ensureDatabaseInitialized() {
    const ops = this.document.databaseOperations;
    if (!ops) {
      throw new Error("Database not initialized");
    }
    return ops;
  }

  /**
   * Initialize the connection - returns metadata about the database connection.
   * Database operations (executeQuery, serializeDatabase, etc.) are exposed as separate methods
   * on HostBridge to avoid nested proxy issues.
   *
   * @returns Connection info including filename and read-only status
   */
  async initialize() {
    const { document } = this;
    if (this.webviews.has(document.uri)) {
      this.reporter?.sendTelemetryEvent("open");
      // Return connection info instead of proxying databaseOps directly.
      return {
        connected: true,
        filename: document.fileParts.filename,
        readOnly: this.isReadOnly,
      };
    }
    throw new Error("Document not found in webviews");
  }

  /**
   * Test database connection.
   */
  async ping() {
    const { document } = this;
    if (!document.databaseOperations) {
      return false;
    }
    if ('ping' in document.databaseOperations) {
      return await document.databaseOperations.ping();
    }
    return false;
  }

  /**
   * Export the database as a Uint8Array.
   * Exposed directly to avoid nested proxy issues.
   *
   * @param filename - The filename for the export
   * @returns The database as a Uint8Array
   */
  async exportDb(filename: string) {
    const dbOps = this.ensureDatabaseInitialized();
    return dbOps.serializeDatabase(filename);
  }

  /**
   * Update a single cell value.
   */
  async updateCell(table: string, rowId: RecordId, column: string, value: CellValue, originalValue?: CellValue) {
    const dbOps = this.ensureDatabaseInitialized();

    // Check if the document is read-only
    if (this.isReadOnly) {
      throw new Error("Document is read-only");
    }

    const patch = this.tryGeneratePatch(value, originalValue);

    // Use specific method instead of generic exec
    // This allows the backend to handle safe SQL construction
    if ('updateCell' in dbOps) {
      await dbOps.updateCell(table, rowId, column, value, patch);
    } else {
      // Fallback for older backend versions (shouldn't happen if built correctly)
      throw new Error("Backend does not support updateCell");
    }

    // Fire edit event
    this.document.recordExternalModification({
      label: 'Update Cell',
      description: `Update ${table}.${column}`,
      modificationType: 'cell_update',
      targetTable: table,
      targetRowId: rowId,
      targetColumn: column,
      newValue: value,
      priorValue: originalValue
    });
  }

  /**
   * Insert a new row.
   */
  async insertRow(table: string, data: Record<string, CellValue>) {
    const dbOps = this.ensureDatabaseInitialized();

    if (this.isReadOnly) {
      throw new Error("Document is read-only");
    }

    let rowId: RecordId | undefined;

    if ('insertRow' in dbOps) {
      rowId = await dbOps.insertRow(table, data);
    } else {
      throw new Error("Backend does not support insertRow");
    }

    // Fire edit event
    this.document.recordExternalModification({
      label: 'Insert Row',
      description: `Insert row into ${table}`,
      modificationType: 'row_insert',
      targetTable: table,
      targetRowId: rowId,
      rowData: data
    });

    return rowId;
  }

  /**
   * Delete rows.
   */
  async deleteRows(table: string, rowIds: RecordId[]) {
    const dbOps = this.ensureDatabaseInitialized();

    if (this.isReadOnly) {
      throw new Error("Document is read-only");
    }

    // Capture row data before deletion for undo
    let deletedRowsData: { rowId: RecordId; row: Record<string, CellValue> }[] = [];
    try {
        const validIds = rowIds.map(id => Number(id)).filter(n => !isNaN(n));
        if (validIds.length > 0) {
            const placeholders = validIds.map(() => '?').join(', ');
            // We select rowid to map back correctly, though we already have IDs.
            // Using * to get all columns.
            const sql = `SELECT rowid, * FROM ${escapeIdentifier(table)} WHERE rowid IN (${placeholders})`;
            const result = await dbOps.executeQuery(sql, validIds);

            if (result && result.length > 0 && result[0].rows) {
                const headers = result[0].headers;
                const rows = result[0].rows;

                deletedRowsData = rows.map(r => {
                    const rowData: Record<string, CellValue> = {};
                    // First col is rowid because we asked for it
                    const rId = r[0] as number;
                  

                    for (let i = 0; i < headers.length; i++) {
                        const name = headers[i];
                        if (name !== 'rowid') {
                            rowData[name] = r[i];
                        }
                    }
                    // Explicitly include rowid in the row data to ensure it's restored with the same ID
                    rowData['rowid'] = rId;

                    return { rowId: rId, row: rowData };
                });
            }
        }
    } catch (e) {
        console.warn('Failed to fetch rows for undo history:', e);
    }

    if ('deleteRows' in dbOps) {
      await dbOps.deleteRows(table, rowIds);
    } else {
      throw new Error("Backend does not support deleteRows");
    }

    // Fire edit event
    this.document.recordExternalModification({
      label: 'Delete Rows',
      description: `Delete ${rowIds.length} rows from ${table}`,
      modificationType: 'row_delete',
      targetTable: table,
      affectedRowIds: rowIds,
      deletedRows: deletedRowsData
    });
  }

  /**
   * Delete columns.
   *
   * If columns have dependent indexes, shows a confirmation dialog to the user.
   * User can choose to drop the indexes and continue, or cancel the operation.
   *
   * @returns Object with `cancelled: true` if user cancelled, otherwise undefined
   */
  async deleteColumns(table: string, columns: string[]): Promise<{ cancelled: boolean } | void> {
    const dbOps = this.ensureDatabaseInitialized();

    if (this.isReadOnly) {
      throw new Error("Document is read-only");
    }

    // Check for dependent indexes before deletion
    let dependentIndexes: string[] = [];
    if ('findDependentIndexes' in dbOps) {
      dependentIndexes = await dbOps.findDependentIndexes(table, columns);
    }

    // If there are dependent indexes, ask the user for confirmation
    if (dependentIndexes.length > 0) {
      const indexList = dependentIndexes.join(', ');
      const message = vsc.l10n.t(
        'The following indexes depend on the selected column(s) and will be dropped: {0}',
        indexList
      );

      const result = await vsc.window.showWarningMessage(
        message,
        { modal: true },
        { title: vsc.l10n.t('Drop Indexes & Continue'), value: true },
        { title: vsc.l10n.t('Cancel'), value: false, isCloseAffordance: true }
      );

      if (!result?.value) {
        // User cancelled the operation - return cancelled flag
        return { cancelled: true };
      }
    }

    // Capture column data before deletion for undo
    let deletedColumnsData: { name: string; type: string; data: { rowId: RecordId; value: CellValue }[] }[] = [];
    try {
        // Get column types first
        const tableInfo = await dbOps.getTableInfo(table);
        const colMap = new Map(tableInfo.map(c => [c.identifier, c.declaredType]));

        // Fetch data for all columns in a single query to avoid N+1 query overhead
        if (columns.length > 0) {
            const escapedCols = columns.map(col => escapeIdentifier(col)).join(', ');
            const sql = `SELECT rowid, ${escapedCols} FROM ${escapeIdentifier(table)}`;
            const result = await dbOps.executeQuery(sql);

            if (result && result.length > 0 && result[0].rows) {
                const rows = result[0].rows;
                const colsData = columns.map(() => [] as { rowId: RecordId; value: CellValue }[]);

                for (const r of rows) {
                    const rowId = r[0] as RecordId;
                    for (let i = 0; i < columns.length; i++) {
                        colsData[i].push({ rowId, value: r[i + 1] });
                    }
                }

                for (let i = 0; i < columns.length; i++) {
                    deletedColumnsData.push({
                        name: columns[i],
                        type: colMap.get(columns[i]) || 'TEXT',
                        data: colsData[i]
                    });
                }
            } else {
                // Empty table or no results, still track the column definition
                for (const col of columns) {
                    deletedColumnsData.push({
                        name: col,
                        type: colMap.get(col) || 'TEXT',
                        data: []
                    });
                }
            }
        }
    } catch (e) {
        console.warn('Failed to fetch column data for undo history:', e);
        // Proceed with deletion even if history capture fails, but warn
    }

    if ('deleteColumns' in dbOps) {
      // Pass dependent indexes to be dropped first if user confirmed
      await dbOps.deleteColumns(table, columns, dependentIndexes.length > 0 ? dependentIndexes : undefined);
    } else {
      throw new Error("Backend does not support deleteColumns");
    }

    // Fire edit event
    this.document.recordExternalModification({
      label: 'Delete Columns',
      description: `Delete columns ${columns.join(', ')} from ${table}`,
      modificationType: 'column_drop',
      targetTable: table,
      deletedColumns: deletedColumnsData
    });
  }

  /**
   * Create a new table.
   */
  async createTable(table: string, columns: import('./core/types').ColumnDefinition[]) {
    const dbOps = this.ensureDatabaseInitialized();

    if (this.isReadOnly) {
      throw new Error("Document is read-only");
    }

    if ('createTable' in dbOps) {
      await dbOps.createTable(table, columns);
    } else {
      throw new Error("Backend does not support createTable");
    }

    // Fire edit event
    this.document.recordExternalModification({
      label: 'Create Table',
      description: `Create table ${table}`,
      modificationType: 'table_create',
      targetTable: table,
      tableDef: { columns }
    });
  }

  /**
   * Update multiple cells in batch.
   */
  async updateCellBatch(table: string, updates: CellUpdate[], label: string) {
    const dbOps = this.ensureDatabaseInitialized();

    if (this.isReadOnly) {
      throw new Error("Document is read-only");
    }

    if ('updateCellBatch' in dbOps) {
      await dbOps.updateCellBatch(table, updates);
    } else {
      // Fallback: execute updates in parallel
      await Promise.all(updates.map(async update => {
        let patch: string | undefined;
        let val = update.value;

        if (update.operation === 'json_patch') {
          patch = update.value as string;
          val = null; // Value is ignored when patch is provided
        } else {
          patch = this.tryGeneratePatch(update.value, update.originalValue);
        }

        await dbOps.updateCell(table, update.rowId, update.column, val, patch);
      }));
    }

    // Fire batch edit event
    this.document.recordExternalModification({
      label: label || `Update ${updates.length} cells`,
      description: `Update ${updates.length} cells in ${table}`,
      modificationType: 'cell_update',
      targetTable: table,
      affectedCells: updates.map(u => ({
        rowId: u.rowId,
        columnName: u.column,
        newValue: u.value,
        priorValue: u.originalValue
      }))
    });
  }

  /**
   * Add a new column to a table.
   */
  async addColumn(table: string, column: string, type: string, defaultValue?: string) {
    const dbOps = this.ensureDatabaseInitialized();

    if (this.isReadOnly) {
      throw new Error("Document is read-only");
    }

    if ('addColumn' in dbOps) {
      await dbOps.addColumn(table, column, type, defaultValue);
    } else {
      throw new Error("Backend does not support addColumn");
    }

    // Fire edit event
    this.document.recordExternalModification({
      label: 'Add Column',
      description: `Add column ${column} to ${table}`,
      modificationType: 'column_add',
      targetTable: table,
      targetColumn: column,
      columnDef: { type, defaultValue }
    });
  }

  /**
   * Fetch table data (SELECT).
   */
  async fetchTableData(table: string, options: TableQueryOptions): Promise<QueryResultSet> {
    const dbOps = this.ensureDatabaseInitialized();

    if ('fetchTableData' in dbOps) {
      return await dbOps.fetchTableData(table, options);
    } else {
      throw new Error("Backend does not support fetchTableData");
    }
  }

  /**
   * Fetch table count (SELECT COUNT(*)).
   */
  async fetchTableCount(table: string, options: TableCountOptions): Promise<number> {
    const dbOps = this.ensureDatabaseInitialized();

    if ('fetchTableCount' in dbOps) {
      return await dbOps.fetchTableCount(table, options);
    } else {
      throw new Error("Backend does not support fetchTableCount");
    }
  }

  /**
   * Fetch schema (tables, views, indexes).
   */
  async fetchSchema(): Promise<SchemaSnapshot> {
    const dbOps = this.ensureDatabaseInitialized();

    if ('fetchSchema' in dbOps) {
      return await dbOps.fetchSchema();
    } else {
      throw new Error("Backend does not support fetchSchema");
    }
  }

  /**
   * Get table columns metadata.
   */
  async getTableInfo(table: string): Promise<ColumnMetadata[]> {
    const dbOps = this.ensureDatabaseInitialized();

    if ('getTableInfo' in dbOps) {
      return await dbOps.getTableInfo(table);
    } else {
      throw new Error("Backend does not support getTableInfo");
    }
  }

  /**
   * Get database PRAGMA settings.
   */
  async getPragmas(): Promise<Record<string, CellValue>> {
    const dbOps = this.ensureDatabaseInitialized();

    if ('getPragmas' in dbOps) {
      return await dbOps.getPragmas();
    } else {
      throw new Error("Backend does not support getPragmas");
    }
  }

  /**
   * Set database PRAGMA value.
   */
  async setPragma(pragma: string, value: CellValue): Promise<void> {
    const dbOps = this.ensureDatabaseInitialized();

    if (this.isReadOnly) {
      throw new Error("Document is read-only");
    }

    if ('setPragma' in dbOps) {
      await dbOps.setPragma(pragma, value);
    } else {
      throw new Error("Backend does not support setPragma");
    }
  }



  /**
   * Apply edits to the database.
   */
  async applyEdits(edits: ModificationEntry[], signal?: AbortSignal) {
    const dbOps = this.ensureDatabaseInitialized();
    return dbOps.applyModifications(edits, signal);
  }

  /**
   * Undo a database edit.
   */
  async undo(edit: ModificationEntry) {
    const dbOps = this.ensureDatabaseInitialized();
    return dbOps.undoModification(edit);
  }

  /**
   * Redo a database edit.
   */
  async redo(edit: ModificationEntry) {
    const dbOps = this.ensureDatabaseInitialized();
    return dbOps.redoModification(edit);
  }

  /**
   * Commit changes to the database.
   */
  async commit(signal?: AbortSignal) {
    const dbOps = this.ensureDatabaseInitialized();
    return dbOps.flushChanges(signal);
  }

  /**
   * Rollback changes to the database.
   */
  async rollback(edits: ModificationEntry[], signal?: AbortSignal) {
    const dbOps = this.ensureDatabaseInitialized();
    return dbOps.discardModifications(edits, signal);
  }

  /**
   * Trigger VS Code Undo command.
   */
  async triggerUndo() {
    await vsc.commands.executeCommand('undo');
  }

  /**
   * Trigger VS Code Redo command.
   */
  async triggerRedo() {
    await vsc.commands.executeCommand('redo');
  }

  /**
   * Check if the document is read-only.
   */
  get isReadOnly() {
    return this.viewerProvider.isReadOnly;
  }

  /**
   * Refresh the database from disk.
   *
   * @returns The refreshed database operations
   */
  async refreshFile() {
    const { document } = this;
    if (document.uri.scheme !== 'untitled') {
      return document.reloadFromDisk();
    }
    throw new Error("Document not found in webviews");
  }


  /**
   * Fire an edit event to mark the document as dirty.
   *
   * @param edit - The edit operation that was performed
   */
  async fireEditEvent(edit: DocumentModification) {
    this.document.recordExternalModification(edit);
  }


  /**
   * Save sidebar state to global storage.
   *
   * @param side - Which sidebar ('left' or 'right')
   * @param position - Sidebar width in pixels
   */
  saveSidebarState(side: 'left' | 'right', position: number) {
    const key = side === 'left' ? SidebarLeft : SidebarRight;
    return Promise.resolve(this.context.globalState.update(key, position));
  }

  /**
   * Get the output channel for SQL logging.
   *
   * @returns Output channel or null
   */
  acquireOutputChannel() {
    return this.viewerProvider.outputChannel;
  }

  /**
   * Show an information toast message.
   */
  async showInformationToast<T extends string | DialogButton>(message: string, options?: DialogConfig, ...items: T[]): Promise<T | undefined> {
    return showToast(vsc.window.showInformationMessage, message, options, items);
  }

  /**
   * Show a warning toast message.
   */
  async showWarningToast<T extends string | DialogButton>(message: string, options?: DialogConfig, ...items: T[]): Promise<T | undefined> {
    return showToast(vsc.window.showWarningMessage, message, options, items);
  }

  /**
   * Show an error toast message.
   */
  async showErrorToast<T extends string | DialogButton>(message: string, options?: DialogConfig, ...items: T[]): Promise<T | undefined> {
    return showToast(vsc.window.showErrorMessage, message, options, items);
  }

  /**
   * Open a cell editor for viewing/editing cell content.
   *
   * @param params - Database and table parameters
   * @param rowId - Row identifier
   * @param colName - Column name
   * @param colTypes - Column type information
   * @param options - Additional options
   */
  async openCellEditor(params: DbParams, rowId: RecordId, colName?: string, colTypes: ColumnTypeInfo = {}, {
    value, type, webviewId, rowCount
  }: {
    value?: CellValue,
    type?: CellContentType,
    webviewId?: string,
    rowCount?: number,
  } = {}) {
    const { document } = this;
    if (document.uri.scheme !== 'untitled') {
      let cellParts: string[];

      if (rowId === '__create__.sql') {
        cellParts = [params.table, params.name || '-', '__create__.sql'];
      } else {
        // Determine file extension based on content type
        const extname = await determineCellExtension(value, type);
        const cellFilename = (colName || 'cell') + extname;

        // Use simple path structure
        cellParts = [params.table, params.name || '-', String(rowId), cellFilename];
      }

      // Ensure documentKey is safe for URI path
      const docKey = await document.documentKey;

      // Construct URI path explicitly: /docKey/table/rowId/filename
      // Empty segments (like schema name if not present) are filtered out by split().filter()
      // in the file system provider, ensuring the path parts match the expected structure.
      const uriPath = [docKey, ...cellParts].map(p => encodeURIComponent(p)).join('/');

      const cellUri = vsc.Uri.from({
          scheme: UriScheme,
          path: '/' + uriPath,
          query: `webview-id=${webviewId}`
      });

      await vsc.commands.executeCommand('vscode.open', cellUri, vsc.ViewColumn.Two);
    }
  }

  /**
   * Open the AI chat panel.
   */
  async openChat() {
    if (IsCursorIDE) {
      await vsc.commands.executeCommand('workbench.action.focusAuxiliaryBar');
    } else {
      await vsc.commands.executeCommand('workbench.action.chat.open', {
        query: `@db Hello!`,
        mode: "ask",
      });
    }
  }

  /**
   * Show confirmation dialog for large changes.
   *
   * @returns True if the user confirms
   */
  async confirmLargeChanges(): Promise<boolean> {
    const answer = await vsc.window.showWarningMessage(vsc.l10n.t('Large Change Warning'), {
      detail: vsc.l10n.t('You are about to make changes that affect many rows. Do you want to continue?'),
      modal: true,
    }, { title: vsc.l10n.t('Continue'), value: true }, { title: vsc.l10n.t('Cancel'), value: false, isCloseAffordance: true });
    return answer?.value ?? false;
  }

  /**
   * Show confirmation dialog for large selection.
   *
   * @param openExportDialog - Callback to open export dialog
   * @returns True if the user wants to continue with selection
   */
  async confirmLargeSelection(openExportDialog: () => void): Promise<boolean> {
    const answer = await vsc.window.showWarningMessage(vsc.l10n.t('Large Selection Warning'), {
      detail: vsc.l10n.t('You are attempting to select more than 10,000 rows. Large selections may impact performance. Do you want to open the export menu instead?'),
      modal: true,
    }, ...[{ title: vsc.l10n.t('Export data'), value: 'export' }, { title: vsc.l10n.t('Continue'), value: 'continue' }]);
    if (answer?.value === 'export') {
      openExportDialog();
    }
    return answer?.value === 'continue';
  }

  /**
   * Get extension settings.
   */
  async getExtensionSettings() {
    // Read fileOperations setting from VS Code configuration
    const config = vsc.workspace.getConfiguration(ConfigurationSection);
    const fileOperations = config.get<string>('fileOperations', 'native');
    
    return {
      autoCommit: this.document.autoCommitEnabled,
      cellEditBehavior: this.document.cellEditBehavior,
      fileOperations: fileOperations
    };
  }

  /**
   * Update extension setting.
   */
  async updateExtensionSetting(key: string, value: boolean | string) {
    if (key === 'autoCommit') {
      this.document.autoCommitEnabled = !!value;
      // Update persistent configuration
      await vsc.workspace.getConfiguration(ConfigurationSection).update('instantCommit', value ? 'always' : 'never', vsc.ConfigurationTarget.Global);
    } else if (key === 'doubleClickBehavior') {
        // Update persistent configuration
        await vsc.workspace.getConfiguration(ConfigurationSection).update('doubleClickBehavior', value, vsc.ConfigurationTarget.Global);
    }
  }

  /**
   * Export a table to a file.
   *
   * @param dbParams - Database and table parameters
   * @param columns - Column names to export
   * @param dbOptions - Database options
   * @param tableStore - Table store data
   * @param exportOptions - Export format options
   * @param extras - Additional options
   */
  async exportTable(dbParams: DbParams, columns: string[], dbOptions?: unknown, tableStore?: unknown, exportOptions?: ExportOptions, extras?: unknown) {
    // Inject the URI of the current document so the command knows which database to use
    const enrichedParams = {
      ...dbParams,
      uri: this.document.uri.toString()
    };
    await vsc.commands.executeCommand(`${ExtensionId}.exportTable`, enrichedParams, columns, dbOptions, tableStore, exportOptions, extras);
  }

  /**
   * Read a file from the workspace.
   *
   * @param uriString - URI of the file to read
   * @returns File contents as Uint8Array
   */
  async readWorkspaceFileUri(uriString: string): Promise<Uint8Array> {
    const uri = vsc.Uri.parse(uriString);

    // SECURITY: Block dangerous URI schemes that could execute code or fetch remote resources
    const blockedSchemes = ['http', 'https', 'command', 'javascript', 'data', 'vbscript', 'vscode-command'];
    if (blockedSchemes.includes(uri.scheme)) {
      throw new Error(`Access denied: Cannot read from scheme "${uri.scheme}"`);
    }

    // SECURITY: For file:// URIs, validate the path to prevent directory traversal attacks
    // and restrict access to sensitive system locations
    if (uri.scheme === 'file') {
      const filePath = uri.fsPath;

      // SECURITY: Whitelist approach
      // Only allow access to files in:
      // 1. Explicit workspace folders
      // 2. The same directory as the open database (or subdirectories)

      // 1. Check if file is within workspace folders
      const workspaceFolder = vsc.workspace.getWorkspaceFolder(uri);
      if (workspaceFolder) {
        return await vsc.workspace.fs.readFile(uri);
      }

      // 2. Check if file is in the same directory tree as the open document
      // This allows drag-and-drop from the same directory tree in single-file mode
      const docDir = path.dirname(this.document.uri.fsPath);

      // Use path.resolve to fully resolve both paths
      // This automatically normalizes paths, resolves any '..' or '.',
      // and creates an absolute path, mitigating path traversal attacks.
      const resolvedDocDir = path.resolve(docDir);
      const resolvedFilePath = path.resolve(filePath);

      // Ensure the resolved target path is either the document directory itself
      // or strictly inside it by checking if it starts with the directory path plus a separator.
      // This prevents prefix spoofing (e.g., '/path/to/dir-fake') and directory traversal.
      // Note: If resolvedDocDir is root (e.g., '/'), we don't need to append an extra separator.
      const prefix = resolvedDocDir.endsWith(path.sep) ? resolvedDocDir : resolvedDocDir + path.sep;
      const isInside = resolvedFilePath === resolvedDocDir || resolvedFilePath.startsWith(prefix);

      if (!isInside) {
         throw new Error(`Access denied: File "${filePath}" is not in the current workspace or document directory.`);
      }

      return await vsc.workspace.fs.readFile(uri);
    }

    // For other schemes (vscode-remote, ssh, etc.), delegate to VS Code's fs API
    // which will enforce its own access controls
    return await vsc.workspace.fs.readFile(uri);
  }

  /**
   * Save a file to the workspace via dialog.
   */
  async saveFile(filename: string, data: Uint8ArrayLike): Promise<void> {
    // Use the database file's directory as the default location
    const dbDir = path.dirname(this.document.uri.fsPath);
    const safeFilename = path.basename(filename);
    const defaultPath = path.join(dbDir, safeFilename);
    
    const uri = await vsc.window.showSaveDialog({
        defaultUri: vsc.Uri.file(defaultPath),
        saveLabel: 'Save Blob'
    });

    if (uri) {
        // Convert data to Uint8Array if needed
        let buffer: Uint8Array;
        if (data instanceof Uint8Array) {
            buffer = data;
        } else {
            buffer = new Uint8Array(data.buffer || (data as any), data.byteOffset, data.byteLength);
        }
        await vsc.workspace.fs.writeFile(uri, buffer);
    }
  }

  /**
   * Attempt to generate a JSON merge patch between two cell values.
   */
  private tryGeneratePatch(value: CellValue, originalValue?: CellValue): string | undefined {
    if (
      typeof value === 'string' &&
      typeof originalValue === 'string' &&
      (value.startsWith('{') || value.startsWith('[')) &&
      (originalValue.startsWith('{') || originalValue.startsWith('['))
    ) {
      try {
        const originalObj = JSON.parse(originalValue);
        const newObj = JSON.parse(value);

        // Only patch if valid JSON objects (not arrays, primitives, null)
        // SQLite json_patch merge behavior is specific to objects.
        // RFC 7396 defines how arrays are replaced entirely.
        if (originalObj && typeof originalObj === 'object' && !Array.isArray(originalObj) &&
            newObj && typeof newObj === 'object' && !Array.isArray(newObj)) {

            const patchObj = generateMergePatch(originalObj, newObj);
            if (patchObj !== undefined) {
                return JSON.stringify(patchObj);
            }
        }
      } catch {
        // Not valid JSON or parse error, ignore and do full update
      }
    }
    return undefined;
  }

  /**
   * Select a file from the workspace via dialog.
   */
  async selectFile(): Promise<{ name: string, data: Uint8Array } | undefined> {
    const uris = await vsc.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Select File to Upload'
    });

    if (uris && uris.length > 0) {
        const uri = uris[0];
        const data = await vsc.workspace.fs.readFile(uri);
        return {
            name: path.basename(uri.fsPath),
            data: data
        };
    }
    return undefined;
  }
}

/**
 * Map DialogConfig/DialogButton to VS Code MessageOptions/MessageItem and invoke the show function.
 *
 * DialogConfig.detailText → MessageOptions.detail
 * DialogButton.caption    → MessageItem.title
 * DialogButton.isCloseAction → MessageItem.isCloseAffordance
 */
async function showToast<T extends string | DialogButton>(
  showFn: typeof vsc.window.showInformationMessage,
  message: string,
  options: DialogConfig | undefined,
  items: T[]
): Promise<T | undefined> {
  // Map DialogConfig → MessageOptions
  const msgOptions: vsc.MessageOptions = options
    ? { modal: options.modal, detail: options.detailText }
    : {};

  // Map DialogButton items → MessageItem, pass strings through
  const msgItems: (string | vsc.MessageItem)[] = items.map(item =>
    typeof item === 'string'
      ? item
      : { title: (item as DialogButton).caption, isCloseAffordance: (item as DialogButton).isCloseAction }
  );

  const result = await (showFn as Function)(message, msgOptions, ...msgItems);

  // Map MessageItem result back to the original DialogButton
  if (result && typeof result === 'object' && 'title' in result) {
    return items.find(
      item => typeof item !== 'string' && (item as DialogButton).caption === result.title
    );
  }
  return result as T | undefined;
}

/**
 * Determine the file extension for a cell based on its content type.
 *
 * @param colTypes - Column type information
 * @param value - Cell value
 * @param type - File type result
 * @returns File extension including the dot
 */
async function determineCellExtension(value?: CellValue, type?: CellContentType): Promise<string> {
  // Default to .txt for text, .bin for binary
  if (value instanceof Uint8Array || (value && typeof value === 'object' && 'buffer' in value)) {
    // Check if it's a known binary format
    if (type?.mime?.startsWith('image/')) {
      return '.' + (type.ext || 'bin');
    }
    return '.bin';
  }
  return '.txt';
}
