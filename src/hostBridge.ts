/**
 * Host Bridge Module
 *
 * Provides methods exposed to the webview for communicating with VS Code.
 * These methods are called via RPC from the webview to perform operations
 * like file operations, dialogs, and database queries.
 */

import * as vsc from 'vscode';
import * as path from 'path';

import { DatabaseEditorProvider, DatabaseViewerProvider } from './editorController';
import { ConfigurationSection, ExtensionId, FullExtensionId, SidebarLeft, SidebarRight, UriScheme } from './config';
import { IsCursorIDE } from './helpers';

import type { DatabaseDocument, DocumentModification } from './databaseModel';
import type { CellValue, RecordId, DialogConfig, DialogButton, CellUpdate, TableQueryOptions, TableCountOptions, QueryResultSet, SchemaSnapshot, ColumnMetadata } from './core/types';
import { generateMergePatch } from './core/json-utils';

// Legacy DbParams type for backward compatibility with webview
interface DbParams {
  filename?: string;
  table: string;
  name?: string;
  uri?: string;
}

// Type for Uint8Array-like objects (transferable over postMessage)
type Uint8ArrayLike = { buffer: ArrayBufferLike, byteOffset: number, byteLength: number };

// Column type information
interface ColumnTypeInfo {
  [key: string]: any;
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
      return await (document.databaseOperations as any).ping();
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
    const { document } = this;
    if (!document.databaseOperations) {
      throw new Error("Database not initialized");
    }
    return document.databaseOperations.serializeDatabase(filename);
  }

  /**
   * Update a single cell value.
   */
  async updateCell(table: string, rowId: RecordId, column: string, value: CellValue, originalValue?: CellValue) {
    const { document } = this;
    if (!document.databaseOperations) {
      throw new Error("Database not initialized");
    }

    // Check if the document is read-only
    if (this.isReadOnly) {
      throw new Error("Document is read-only");
    }

    let patch: string | undefined;

    // Try to generate a JSON patch if applicable
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
                patch = JSON.stringify(patchObj);
            }
        }
      } catch {
        // Not valid JSON or parse error, ignore and do full update
      }
    }

    // Use specific method instead of generic exec
    // This allows the backend to handle safe SQL construction
    if ('updateCell' in document.databaseOperations) {
      await document.databaseOperations.updateCell(table, rowId, column, value, patch);
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
    const { document } = this;
    if (!document.databaseOperations) {
      throw new Error("Database not initialized");
    }

    if (this.isReadOnly) {
      throw new Error("Document is read-only");
    }

    let rowId: RecordId | undefined;

    if ('insertRow' in document.databaseOperations) {
      rowId = await (document.databaseOperations as any).insertRow(table, data);
    } else {
      throw new Error("Backend does not support insertRow");
    }

    // Fire edit event
    this.document.recordExternalModification({
      label: 'Insert Row',
      description: `Insert row into ${table}`,
      modificationType: 'row_insert',
      targetTable: table,
      targetRowId: rowId
    });

    return rowId;
  }

  /**
   * Delete rows.
   */
  async deleteRows(table: string, rowIds: RecordId[]) {
    const { document } = this;
    if (!document.databaseOperations) {
      throw new Error("Database not initialized");
    }

    if (this.isReadOnly) {
      throw new Error("Document is read-only");
    }

    if ('deleteRows' in document.databaseOperations) {
      await (document.databaseOperations as any).deleteRows(table, rowIds);
    } else {
      throw new Error("Backend does not support deleteRows");
    }

    // Fire edit event
    this.document.recordExternalModification({
      label: 'Delete Rows',
      description: `Delete ${rowIds.length} rows from ${table}`,
      modificationType: 'row_delete',
      targetTable: table,
      affectedRowIds: rowIds
    });
  }

  /**
   * Delete columns.
   */
  async deleteColumns(table: string, columns: string[]) {
    const { document } = this;
    if (!document.databaseOperations) {
      throw new Error("Database not initialized");
    }

    if (this.isReadOnly) {
      throw new Error("Document is read-only");
    }

    if ('deleteColumns' in document.databaseOperations) {
      await (document.databaseOperations as any).deleteColumns(table, columns);
    } else {
      throw new Error("Backend does not support deleteColumns");
    }

    // Fire edit event
    this.document.recordExternalModification({
      label: 'Delete Columns',
      description: `Delete columns ${columns.join(', ')} from ${table}`,
      modificationType: 'table_drop', // Approximate type
      targetTable: table
    });
  }

  /**
   * Create a new table.
   */
  async createTable(table: string, columns: string[]) {
    const { document } = this;
    if (!document.databaseOperations) {
      throw new Error("Database not initialized");
    }

    if (this.isReadOnly) {
      throw new Error("Document is read-only");
    }

    if ('createTable' in document.databaseOperations) {
      await (document.databaseOperations as any).createTable(table, columns);
    } else {
      throw new Error("Backend does not support createTable");
    }

    // Fire edit event
    this.document.recordExternalModification({
      label: 'Create Table',
      description: `Create table ${table}`,
      modificationType: 'table_create',
      targetTable: table
    });
  }

  /**
   * Update multiple cells in batch.
   */
  async updateCellBatch(table: string, updates: CellUpdate[], label: string) {
    const { document } = this;
    if (!document.databaseOperations) {
      throw new Error("Database not initialized");
    }

    if (this.isReadOnly) {
      throw new Error("Document is read-only");
    }

    if ('updateCellBatch' in document.databaseOperations) {
      await (document.databaseOperations as any).updateCellBatch(table, updates);
    } else {
      // Fallback: execute updates sequentially
      for (const update of updates) {
        await this.updateCell(table, update.rowId, update.column, update.value);
      }
      return;
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
        newValue: u.value
      }))
    });
  }

  /**
   * Add a new column to a table.
   */
  async addColumn(table: string, column: string, type: string, defaultValue?: string) {
    const { document } = this;
    if (!document.databaseOperations) {
      throw new Error("Database not initialized");
    }

    if (this.isReadOnly) {
      throw new Error("Document is read-only");
    }

    if ('addColumn' in document.databaseOperations) {
      await (document.databaseOperations as any).addColumn(table, column, type, defaultValue);
    } else {
      throw new Error("Backend does not support addColumn");
    }

    // Fire edit event
    this.document.recordExternalModification({
      label: 'Add Column',
      description: `Add column ${column} to ${table}`,
      modificationType: 'column_add',
      targetTable: table,
      targetColumn: column
    });
  }

  /**
   * Fetch table data (SELECT).
   */
  async fetchTableData(table: string, options: TableQueryOptions): Promise<QueryResultSet> {
    const { document } = this;
    if (!document.databaseOperations) {
      throw new Error("Database not initialized");
    }

    if ('fetchTableData' in document.databaseOperations) {
      return await (document.databaseOperations as any).fetchTableData(table, options);
    } else {
      // Fallback or error? Since we are upgrading everything, throw error.
      // Alternatively, we could implement fallback using exec, but that defeats the purpose of moving logic to backend.
      throw new Error("Backend does not support fetchTableData");
    }
  }

  /**
   * Fetch table count (SELECT COUNT(*)).
   */
  async fetchTableCount(table: string, options: TableCountOptions): Promise<number> {
    const { document } = this;
    if (!document.databaseOperations) {
      throw new Error("Database not initialized");
    }

    if ('fetchTableCount' in document.databaseOperations) {
      return await (document.databaseOperations as any).fetchTableCount(table, options);
    } else {
      throw new Error("Backend does not support fetchTableCount");
    }
  }

  /**
   * Fetch schema (tables, views, indexes).
   */
  async fetchSchema(): Promise<SchemaSnapshot> {
    const { document } = this;
    if (!document.databaseOperations) {
      throw new Error("Database not initialized");
    }

    if ('fetchSchema' in document.databaseOperations) {
      return await (document.databaseOperations as any).fetchSchema();
    } else {
      throw new Error("Backend does not support fetchSchema");
    }
  }

  /**
   * Get table columns metadata.
   */
  async getTableInfo(table: string): Promise<ColumnMetadata[]> {
    const { document } = this;
    if (!document.databaseOperations) {
      throw new Error("Database not initialized");
    }

    if ('getTableInfo' in document.databaseOperations) {
      return await (document.databaseOperations as any).getTableInfo(table);
    } else {
      throw new Error("Backend does not support getTableInfo");
    }
  }

  /**
   * Get database PRAGMA settings.
   */
  async getPragmas(): Promise<Record<string, CellValue>> {
    const { document } = this;
    if (!document.databaseOperations) {
      throw new Error("Database not initialized");
    }

    if ('getPragmas' in document.databaseOperations) {
      return await (document.databaseOperations as any).getPragmas();
    } else {
      throw new Error("Backend does not support getPragmas");
    }
  }

  /**
   * Set database PRAGMA value.
   */
  async setPragma(pragma: string, value: CellValue): Promise<void> {
    const { document } = this;
    if (!document.databaseOperations) {
      throw new Error("Database not initialized");
    }

    if (this.isReadOnly) {
      throw new Error("Document is read-only");
    }

    if ('setPragma' in document.databaseOperations) {
      await (document.databaseOperations as any).setPragma(pragma, value);
    } else {
      throw new Error("Backend does not support setPragma");
    }
  }



  /**
   * Apply edits to the database.
   */
  async applyEdits(edits: any, signal?: any) {
    const { document } = this;
    if (!document.databaseOperations) {
      throw new Error("Database not initialized");
    }
    return document.databaseOperations.applyModifications(edits, signal);
  }

  /**
   * Undo a database edit.
   */
  async undo(edit: any) {
    const { document } = this;
    if (!document.databaseOperations) {
      throw new Error("Database not initialized");
    }
    return document.databaseOperations.undoModification(edit);
  }

  /**
   * Redo a database edit.
   */
  async redo(edit: any) {
    const { document } = this;
    if (!document.databaseOperations) {
      throw new Error("Database not initialized");
    }
    return document.databaseOperations.redoModification(edit);
  }

  /**
   * Commit changes to the database.
   */
  async commit(signal?: any) {
    const { document } = this;
    if (!document.databaseOperations) {
      throw new Error("Database not initialized");
    }
    return document.databaseOperations.flushChanges(signal);
  }

  /**
   * Rollback changes to the database.
   */
  async rollback(edits: any, signal?: any) {
    const { document } = this;
    if (!document.databaseOperations) {
      throw new Error("Database not initialized");
    }
    return document.databaseOperations.discardModifications(edits, signal);
  }

  /**
   * Check if the document is read-only.
   */
  get isReadOnly() {
    return this.viewerProvider instanceof DatabaseViewerProvider && !(this.viewerProvider instanceof DatabaseEditorProvider);
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
   * Download a blob to the filesystem.
   *
   * SECURITY: The filename is sanitized using path.basename to prevent
   * path traversal attacks. An attacker could try to pass filenames like
   * "../../etc/passwd" to write outside the intended directory.
   *
   * @param data - Binary data to write
   * @param download - Filename for the download (will be sanitized)
   * @param preserveFocus - Whether to keep focus on current editor
   */
  async downloadBlob(data: Uint8Array, download: string, preserveFocus: boolean) {
    const { document } = this;
    const { dirname } = document.fileParts;

    // SECURITY: Sanitize filename to prevent path traversal attacks.
    // path.basename extracts just the filename, stripping any directory components.
    // Example: "../../etc/passwd" becomes "passwd"
    const sanitizedFilename = path.basename(download);
    if (!sanitizedFilename) {
      throw new Error('Invalid filename');
    }

    const dlUri = vsc.Uri.joinPath(vsc.Uri.parse(dirname), sanitizedFilename);

    await vsc.workspace.fs.writeFile(dlUri, data);
    if (!preserveFocus) await vsc.commands.executeCommand('vscode.open', dlUri);
    return;
  }

  /**
   * Open the extension store page.
   */
  async openExtensionStorePage() {
    await vsc.commands.executeCommand('extension.open', FullExtensionId);
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
   * Enter license key dialog.
   */
  async enterLicenseKey() {
    try {
      await this.viewerProvider.enterLicenseKey();
    } catch (err) {
      vsc.window.showErrorMessage(`'Enter License Key' resulted in an error`, {
        modal: true,
        detail: err instanceof Error ? err.message : String(err)
      });
    }
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
    return await vsc.window.showInformationMessage(message, options as any, ...items as any[]);
  }

  /**
   * Show a warning toast message.
   */
  async showWarningToast<T extends string | DialogButton>(message: string, options?: DialogConfig, ...items: T[]): Promise<T | undefined> {
    return await vsc.window.showWarningMessage(message, options as any, ...items as any[]);
  }

  /**
   * Show an error toast message.
   */
  async showErrorToast<T extends string | DialogButton>(message: string, options?: DialogConfig, ...items: T[]): Promise<T | undefined> {
    return await vsc.window.showErrorMessage(message, options as any, ...items as any[]);
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
    type?: any,
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
        const extname = await determineCellExtension(colTypes, value, type);
        const cellFilename = (colName || 'cell') + extname;

        // Use simple path structure
        cellParts = [params.table, params.name || '-', String(rowId), cellFilename];
      }

      // Ensure documentKey is safe for URI path
      const docKey = await document.documentKey;

      // Construct URI path explicitly: /docKey/table/schema/rowId/filename
      // We map empty strings to empty strings, join will produce // for empty schema
      // But we filter empty segments in FS provider, so we should arguably NOT produce empty segments here if we want to match length 4 logic?
      // Or we produce empty segment and FS provider sees 5 parts with one empty?
      // filter(p => p.length > 0) removes empty segments!
      // So if schema is empty, [docKey, table, '', rowId, filename] -> join('/') -> docKey/table//rowId/filename
      // split('/').filter(...) -> [docKey, table, rowId, filename] (4 parts)
      // This matches the 4-part logic in virtualFileSystem.ts!

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
    return {
      autoCommit: this.document.autoCommitEnabled,
      cellEditBehavior: this.document.cellEditBehavior
    };
  }

  /**
   * Update extension setting.
   */
  async updateExtensionSetting(key: string, value: any) {
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
   * Update the auto-commit setting.
   *
   * @param value - New auto-commit value
   */
  updateAutoCommit(value: boolean) {
    this.document.autoCommitEnabled = value;
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
  async exportTable(dbParams: DbParams, columns: string[], dbOptions?: any, tableStore?: any, exportOptions?: any, extras?: any) {
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
    return await vsc.workspace.fs.readFile(uri);
  }
}

/**
 * Determine the file extension for a cell based on its content type.
 *
 * @param colTypes - Column type information
 * @param value - Cell value
 * @param type - File type result
 * @returns File extension including the dot
 */
async function determineCellExtension(colTypes: ColumnTypeInfo, value?: CellValue, type?: any): Promise<string> {
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
