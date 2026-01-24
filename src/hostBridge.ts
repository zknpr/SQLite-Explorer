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
import { ExtensionId, FullExtensionId, SidebarLeft, SidebarRight, UriScheme } from './config';
import { IsCursorIDE } from './helpers';

import type { DatabaseDocument, DocumentModification } from './databaseModel';
import type { CellValue, RecordId, DialogConfig, DialogButton } from './core/types';

// Legacy DbParams type for backward compatibility with webview
interface DbParams {
  filename?: string;
  table: string;
  name?: string;
}

// Type for Uint8Array-like objects (transferable over postMessage)
type Uint8ArrayLike = { buffer: ArrayBufferLike, byteOffset: number, byteLength: number };

// Initialization parameters for untitled documents
export type UntitledInit = {
  filename: string,
  untitled: true,
  editable?: boolean,
  maxFileSize: number,
};

// Initialization parameters for regular files
export type RegularInit = {
  filename: string,
  editable?: boolean,
  maxFileSize: number,
  value: Uint8ArrayLike
  walValue?: Uint8ArrayLike
};

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
      // The webview will call executeQuery(), serializeDatabase(), etc. directly on hostBridge.
      return {
        connected: true,
        filename: document.fileParts.filename,
        readOnly: this.isReadOnly,
      };
    }
    throw new Error("Document not found in webviews");
  }

  /**
   * Execute a SQL query on the database.
   * Exposed directly to avoid nested proxy issues.
   *
   * @param sql - The SQL query string to execute
   * @param params - Optional array of parameters for parameterized queries
   * @returns Query results from sql.js
   */
  async exec(sql: string, params?: any[]) {
    const { document } = this;
    if (!document.databaseOperations) {
      throw new Error("Database not initialized");
    }
    const result = await document.databaseOperations.executeQuery(sql, params);

    // Fire edit event if this is a write operation
    // This marks the document as dirty so VS Code knows to save
    if (isWriteOperation(sql)) {
      this.document.recordExternalModification({
        label: 'SQL Query',
        description: 'SQL Query',
        modificationType: 'cell_update',
        executedQuery: sql
      });
    }

    return result;
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
        cellParts = [params.table, params.name || '', '__create__.sql'];
      } else {
        // Determine file extension based on content type
        const extname = await determineCellExtension(colTypes, value, type);
        const cellFilename = (colName || 'cell') + extname;

        // Use simple path structure
        cellParts = [params.table, params.name || '', String(rowId), cellFilename];
      }

      const encodedParts = cellParts.map(x => x.replaceAll(path.sep, encodeURIComponent(path.sep)));
      const cellUri = vsc.Uri.joinPath(vsc.Uri.parse(await document.documentKey), ...encodedParts).with({ scheme: UriScheme, query: `webview-id=${webviewId}` });

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
    await vsc.commands.executeCommand(`${ExtensionId}.exportTable`, dbParams, columns, dbOptions, tableStore, exportOptions, extras);
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
 * Check if a SQL statement is a write operation.
 * Handles edge cases like leading comments and CTEs (WITH clauses).
 *
 * @param sql - SQL query string
 * @returns True if the query modifies data
 */
function isWriteOperation(sql: string): boolean {
  // Remove leading/trailing whitespace
  let normalized = sql.trim();

  // Remove leading SQL comments (both -- and /* */ styles)
  // This prevents attackers from hiding write operations behind comments
  // Example: "/* log */ INSERT INTO..." should still be detected as a write

  // Remove block comments /* ... */
  normalized = normalized.replace(/\/\*[\s\S]*?\*\//g, '');

  // Remove line comments -- ...
  normalized = normalized.replace(/--[^\n]*/g, '');

  // Trim again after removing comments
  normalized = normalized.trim().toUpperCase();

  // Handle CTEs: WITH ... AS (...) INSERT/UPDATE/DELETE
  // A CTE can precede a write operation
  if (normalized.startsWith('WITH')) {
    // Find the actual statement after the CTE(s)
    // CTEs are followed by SELECT, INSERT, UPDATE, or DELETE
    // We need to find the final statement keyword
    const ctePattern = /\bWITH\b[\s\S]*?\b(SELECT|INSERT|UPDATE|DELETE)\b/i;
    const match = normalized.match(ctePattern);
    if (match) {
      const keyword = match[1].toUpperCase();
      return keyword === 'INSERT' || keyword === 'UPDATE' || keyword === 'DELETE';
    }
  }

  // Standard write operation detection
  return normalized.startsWith('INSERT') ||
    normalized.startsWith('UPDATE') ||
    normalized.startsWith('DELETE') ||
    normalized.startsWith('CREATE') ||
    normalized.startsWith('ALTER') ||
    normalized.startsWith('DROP');
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
