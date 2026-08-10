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
import { ConfigurationSection, ExtensionId, getMaxInlineCellBytes, getMaxUndoMemoryBytes, SidebarLeft, SidebarRight, UriScheme } from './config';
import { IsCursorIDE } from './helpers';

import type { DatabaseDocument } from './databaseModel';
import type { CellValue, RecordId, DialogConfig, DialogButton, CellUpdate, TableQueryOptions, TableCountOptions, TableCountResult, QueryResultSet, WebviewQueryResultSet, SchemaSnapshot, ColumnMetadata, CellContentType, DbParams, ExportOptions, ViewDefinitionIntent, ViewTriggerDefinition, TableIdentity, ColumnDropTableState } from './core/types';
import { prepareCellUpdateForStorage } from './core/json-utils';
import {
  assertMutableRecordId,
  buildRecordIdentityPredicate,
  classifyTableIdentity,
  decodePrimaryKeyRecordId,
  encodePrimaryKeyRecordId,
  isPrimaryKeyRecordId,
  primaryKeyColumnsFromTableInfo
} from './core/row-identity';
import { escapeIdentifier, validateRowId } from './core/sql-utils';
import {
  COLUMN_DROP_TABLE_STATE_SQL,
  mapColumnDropTableState
} from './core/column-drop';
import { isViewDefinitionConflictError } from './core/view-utils';
import { DEFAULT_MAX_PAGE_RESPONSE_BYTES } from './core/cell-containment';
import { assertDocumentModification } from './core/modification-validation';
import { estimateUndoMemoryBytes } from './core/undo-history';
import type { CellMaterializationService } from './cellMaterialization';
import {
  assertCellValueWithinEditLimit,
  assertCellValuesWithinEditLimit,
  CellEditPolicyError,
  DEFAULT_MAX_CELL_EDIT_BYTES,
  formatOversizedCellReplacementWarning,
  isOversizedCellReplacementConflictError,
  isOversizedCellReplacementRequiredError
} from './core/cell-edit-policy';

interface ActiveCellMediaPreview {
  previewId: string;
  uri: vsc.Uri;
  panel: vsc.WebviewPanel;
}

interface CellMediaPreviewOptions {
  type: CellContentType;
  webviewId: string;
  /** Informational only; the host re-reads authoritative cell metadata. */
  sourceByteLength?: number;
}

const OVERSIZED_MEDIA_TYPES: Readonly<Record<string, {
  type: 'image' | 'audio' | 'video' | 'pdf';
  extension: string;
}>> = {
  'image/png': { type: 'image', extension: 'png' },
  'image/jpeg': { type: 'image', extension: 'jpg' },
  'image/gif': { type: 'image', extension: 'gif' },
  'image/bmp': { type: 'image', extension: 'bmp' },
  'image/webp': { type: 'image', extension: 'webp' },
  'audio/mpeg': { type: 'audio', extension: 'mp3' },
  'audio/ogg': { type: 'audio', extension: 'ogg' },
  'audio/wav': { type: 'audio', extension: 'wav' },
  'audio/flac': { type: 'audio', extension: 'flac' },
  'video/mp4': { type: 'video', extension: 'mp4' },
  'video/quicktime': { type: 'video', extension: 'mov' },
  'video/webm': { type: 'video', extension: 'webm' },
  'video/avi': { type: 'video', extension: 'avi' },
  'application/pdf': { type: 'pdf', extension: 'pdf' }
};

/** A webview result has one canonical row matrix; sql.js aliases stay internal. */
export function toWebviewQueryResultSet(result: QueryResultSet): WebviewQueryResultSet {
  const { values: _values, records: _records, ...webviewResult } = result;
  return webviewResult;
}

// Type for Uint8Array-like objects (transferable over postMessage)
type Uint8ArrayLike = { buffer: ArrayBufferLike, byteOffset: number, byteLength: number };

/**
 * SECURITY: true when `candidate` names the base directory itself or a resource
 * inside it, decided on fully normalized paths. This is the single containment
 * implementation for readWorkspaceFileUri — both the workspace-folder branch
 * and the document-directory branch must go through it, because two subtly
 * different checks are exactly what allowed traversal bypasses in the past.
 *
 * `base` is either the directory itself (a workspace folder) or a file whose
 * parent directory is the boundary (the open database document).
 *
 * file: URIs compare with the platform path rules on fsPath — path.resolve
 * collapses dot segments and, on Windows, honours `\` as a separator. Every
 * other provider addresses resources by POSIX uri.path; there a candidate
 * containing `\` is rejected outright, because posix.resolve treats `\` as an
 * ordinary filename character while Windows-backed remote providers treat it
 * as a separator — normalizing instead of rejecting would misjudge either kind
 * of provider. (Module-level on purpose: webviewMessageHandler dispatches any
 * function-valued HostBridge property by name, and this must not be callable.)
 */
function isUriContainedInDirectory(
  candidate: vsc.Uri,
  base: vsc.Uri,
  baseKind: 'directory' | 'parent-of-file'
): boolean {
  // An equal path on a different provider/authority is a different resource
  // space entirely.
  if (candidate.scheme !== base.scheme || candidate.authority !== base.authority) {
    return false;
  }
  if (candidate.scheme === 'file') {
    const baseDir = baseKind === 'directory' ? base.fsPath : path.dirname(base.fsPath);
    const resolvedDir = path.resolve(baseDir);
    const resolvedCandidate = path.resolve(candidate.fsPath);
    // Match the directory itself or require the separator after the prefix:
    // this prevents prefix spoofing (e.g. '/path/to/dir-fake'). If resolvedDir
    // is root it already ends with the separator.
    const prefix = resolvedDir.endsWith(path.sep) ? resolvedDir : resolvedDir + path.sep;
    return resolvedCandidate === resolvedDir || resolvedCandidate.startsWith(prefix);
  }
  if (candidate.path.includes('\\')) {
    return false;
  }
  const baseDir = baseKind === 'directory' ? base.path : path.posix.dirname(base.path);
  const resolvedDir = path.posix.resolve('/', baseDir);
  const resolvedCandidate = path.posix.resolve('/', candidate.path);
  const prefix = resolvedDir.endsWith('/') ? resolvedDir : resolvedDir + '/';
  return resolvedCandidate === resolvedDir || resolvedCandidate.startsWith(prefix);
}

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

/** Calls that create a new history entry after their backend mutation succeeds. */
const HISTORY_RECORDING_METHODS = [
  'updateCell',
  'insertRow',
  'deleteRows',
  'deleteColumns',
  'createTable',
  'createView',
  'editView',
  'dropView',
  'updateCellBatch',
  'addColumn',
  'setPragma',
  'fireEditEvent'
] as const;

/** Methods whose complete host-side lifecycle must precede a paged snapshot. */
const TRACKED_MUTATION_METHODS = [
  ...HISTORY_RECORDING_METHODS,
  'triggerUndo',
  'triggerRedo'
] as const;

const HISTORY_RECORDING_METHOD_NAMES = new Set<string>(HISTORY_RECORDING_METHODS);

/** Keep this paired with the settings modal's stored-vs-session-only wording. */
const PAGED_PERSISTENT_PRAGMAS = new Set(['journal_mode', 'auto_vacuum']);

function sameEffectivePragmaValue(left: CellValue, right: CellValue): boolean {
  return typeof left === 'string' && typeof right === 'string'
    ? left.toLowerCase() === right.toLowerCase()
    : Object.is(left, right);
}

/**
 * Bridge between VS Code host and webview.
 *
 * These methods are called from within the webview via the RPC mechanism.
 * They provide access to VS Code APIs and extension functionality.
 */
export class HostBridge implements ToastService {
  private activePreviewController: AbortController | undefined;
  private activeCellMaterializationController: AbortController | undefined;
  private readonly activeCellMediaPreviews = new Map<string, ActiveCellMediaPreview>();
  private readonly activeCellMediaControllers = new Map<string, AbortController>();
  private readonly mediaPanelSubscriptions = new Map<vsc.WebviewPanel, vsc.Disposable>();

  constructor(
    private readonly viewerProvider: DatabaseEditorProvider | DatabaseViewerProvider,
    private readonly document: DatabaseDocument,
  ) {
    // Track the whole bridge call rather than only its worker Promise: history
    // and content-change events are part of the snapshot's logical state.
    // Lightweight document doubles used by focused HostBridge tests predate
    // this lifecycle API and intentionally keep their direct method behavior.
    if (typeof this.document.runTrackedMutation !== 'function') return;
    const methods = this as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const methodName of TRACKED_MUTATION_METHODS) {
      const implementation = methods[methodName].bind(this);
      Object.defineProperty(this, methodName, {
        configurable: false,
        enumerable: false,
        value: (...args: unknown[]) => this.document.runTrackedMutation(
          () => implementation(...args),
          HISTORY_RECORDING_METHOD_NAMES.has(methodName)
        )
      });
    }
  }

  // Getters for provider properties
  private get webviews() { return this.viewerProvider.webviews; }
  private get reporter() { return this.viewerProvider.reporter; }
  private get context() { return this.viewerProvider.context; }
  private get cellMaterializer(): CellMaterializationService | undefined {
    return this.viewerProvider.cellMaterializer;
  }

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

  private captureConnectionGeneration(): number {
    return this.document.connectionGeneration;
  }

  private isConnectionGenerationCurrent(generation: number): boolean {
    return generation === this.document.connectionGeneration;
  }

  /** Refuse a write whose read/confirmation phase belonged to an older database. */
  private assertConnectionGeneration(generation: number): void {
    if (!this.isConnectionGenerationCurrent(generation)) {
      throw new Error(vsc.l10n.t(
        'The document was reloaded while this operation was in progress. No changes were applied.'
      ));
    }
  }

  /** Resolve declared table identity before interpreting an untrusted RecordId. */
  private async resolveTableIdentity(
    dbOps: ReturnType<HostBridge['ensureDatabaseInitialized']>,
    table: string,
    knownColumns?: readonly ColumnMetadata[]
  ): Promise<TableIdentity> {
    const metadata = await dbOps.executeQuery(
      `SELECT "type", "wr" FROM pragma_table_list ` +
      `WHERE "schema" = 'main' AND "name" = ? LIMIT 1`,
      [table]
    );
    if ((metadata[0]?.rows.length ?? 0) === 0) {
      throw new Error(`Table not found: ${table}`);
    }
    const kind = classifyTableIdentity(metadata[0].rows[0][0], metadata[0].rows[0][1]);
    if (!kind) throw new Error(`Table not found: ${table}`);
    if (kind === 'rowid') return { kind: 'rowid' };
    const columns = primaryKeyColumnsFromTableInfo(
      knownColumns ?? await dbOps.getTableInfo(table)
    );
    if (columns.length === 0) throw new Error(`WITHOUT ROWID table ${table} has no declared primary key`);
    return { kind: 'primaryKey', columns };
  }

  /** Capture exact DDL and owned schema objects for guarded column-drop history. */
  private async captureColumnDropTableState(
    dbOps: ReturnType<HostBridge['ensureDatabaseInitialized']>,
    table: string,
    columns: readonly ColumnMetadata[],
    identity: TableIdentity
  ): Promise<ColumnDropTableState> {
    const result = await dbOps.executeQuery(
      COLUMN_DROP_TABLE_STATE_SQL,
      [table, table]
    );
    return mapColumnDropTableState(
      table,
      columns.map(column => column.identifier),
      identity,
      result[0]?.rows ?? []
    );
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
   * This is an explicit user-requested whole-image export, not an automatic
   * document save, so it intentionally remains materializing. Exposed directly
   * to avoid nested proxy issues. Writable paged engines return their merged
   * base-plus-overlay image; read-only paged engines keep the engine's explicit
   * unsupported-export error.
   *
   * @param filename - The filename for the export
   * @returns The database as a Uint8Array
   */
  async exportDb(filename: string) {
    const dbOps = this.ensureDatabaseInitialized();
    return dbOps.serializeDatabase();
  }

  /**
   * Update a single cell value.
   */
  async updateCell(table: string, rowId: RecordId, column: string, value: CellValue, _originalValue?: CellValue) {
    const dbOps = this.ensureDatabaseInitialized();
    const connectionGeneration = this.captureConnectionGeneration();

    // Check if the document is read-only
    if (this.isReadOnly) {
      throw new Error("Document is read-only");
    }
    assertMutableRecordId(rowId);
    const editLimitBytes = DEFAULT_MAX_CELL_EDIT_BYTES;
    // Refuse values the transport cannot carry before any database read or
    // confirmation work. Inline preview settings are read-only concerns.
    assertCellValueWithinEditLimit(value, editLimitBytes);

    const identity = await this.resolveTableIdentity(dbOps, table);
    const predicate = buildRecordIdentityPredicate(rowId, identity);
    this.assertConnectionGeneration(connectionGeneration);

    const escapedColumn = escapeIdentifier(column);
    const byteLengthExpression =
      `CASE WHEN ${escapedColumn} IS NULL THEN 0 ` +
      `ELSE length(CAST(${escapedColumn} AS BLOB)) END`;

    while (true) {
      // The CASE expression is the containment boundary for edit history: a
      // bounded prior follows the existing path, while an oversized prior is
      // represented only by typeof()/exact byte length and is never returned.
      const current = await dbOps.executeQuery(
        `SELECT typeof(${escapedColumn}), ${byteLengthExpression}, ` +
        `CASE WHEN typeof(${escapedColumn}) IN ('text', 'blob') ` +
        `AND ${byteLengthExpression} > ? THEN NULL ELSE ${escapedColumn} END ` +
        `FROM ${escapeIdentifier(table)} WHERE ${predicate.sql} LIMIT 1`,
        [editLimitBytes, ...predicate.params]
      );
      this.assertConnectionGeneration(connectionGeneration);
      const currentRow = current[0]?.rows[0];
      if (!currentRow) {
        throw new Error(`Cannot update ${table}.${column}: row ${rowId} no longer exists`);
      }
      const storageClass = currentRow[0];
      const rawByteLength = currentRow[1];
      const byteLength = typeof rawByteLength === 'bigint'
        ? Number(rawByteLength)
        : rawByteLength;
      if (
        !['null', 'integer', 'real', 'text', 'blob'].includes(String(storageClass))
        || !Number.isSafeInteger(byteLength)
        || Number(byteLength) < 0
      ) {
        throw new Error(`SQLite returned invalid cell metadata for ${table}.${column}`);
      }

      const oversized = (storageClass === 'text' || storageClass === 'blob')
        && Number(byteLength) > editLimitBytes;
      if (oversized) {
        const expected = {
          storageClass,
          byteLength: Number(byteLength)
        } as const;
        const answer = await vsc.window.showWarningMessage(
          formatOversizedCellReplacementWarning(table, column, expected),
          { modal: true },
          { title: vsc.l10n.t('Replace Without Undo'), value: true },
          { title: vsc.l10n.t('Cancel'), value: false, isCloseAffordance: true }
        );
        if (!answer?.value) throw new vsc.CancellationError();

        this.assertConnectionGeneration(connectionGeneration);
        if (!('replaceOversizedCell' in dbOps)) {
          throw new Error('Backend does not support guarded oversized-cell replacement');
        }
        try {
          const updatedRowId = await dbOps.replaceOversizedCell(
            table,
            rowId,
            column,
            value,
            expected,
            editLimitBytes
          );
          this.assertConnectionGeneration(connectionGeneration);
          const newTargetRowId = updatedRowId ?? rowId;
          // This bounded forward entry is the future file-backed-undo hook: a
          // later stage can attach a checksummed prior snapshot and remove the
          // barrier policy without changing the confirmed backend operation.
          this.document.recordExternalModification({
            label: 'Replace Oversized Cell',
            description: `Replace oversized ${table}.${column} without undo`,
            modificationType: 'cell_update',
            targetTable: table,
            targetRowId: rowId,
            ...(isPrimaryKeyRecordId(rowId) ? { newTargetRowId } : {}),
            targetColumn: column,
            newValue: value,
            operation: 'set',
            undoPolicy: 'barrier',
            undoBarrierKind: 'oversized_cell'
          });
          return newTargetRowId;
        } catch (error) {
          // Metadata is exactly what the user confirmed. Re-read and re-confirm
          // if another writer changed it while the modal was open.
          if (isOversizedCellReplacementConflictError(error)) continue;
          throw error;
        }
      }

      const primaryKeyIndex = identity.kind === 'primaryKey'
        ? identity.columns.findIndex(keyColumn => keyColumn.identifier === column)
        : -1;
      const priorValue = primaryKeyIndex >= 0
        ? predicate.primaryKey!.values[primaryKeyIndex]
        : currentRow[2];
      const prepared = prepareCellUpdateForStorage(value, priorValue);
      const patch = prepared.operation === 'json_patch' ? String(prepared.value) : undefined;

      this.assertConnectionGeneration(connectionGeneration);

      // Use specific method instead of generic exec
      // This allows the backend to handle safe SQL construction
      if ('updateCell' in dbOps) {
        let updatedRowId: RecordId | void;
        try {
          updatedRowId = await dbOps.updateCell(
            table,
            rowId,
            column,
            value,
            patch,
            editLimitBytes
          );
        } catch (error) {
          // A concurrent writer can make the prior oversized after our
          // metadata read. Re-enter the metadata/confirmation loop rather than
          // bypassing the extension-host confirmation with a normal update.
          if (isOversizedCellReplacementRequiredError(error)) continue;
          throw error;
        }
        const newTargetRowId = updatedRowId ?? rowId;

        // Fire edit event
        this.document.recordExternalModification({
          label: 'Update Cell',
          description: `Update ${table}.${column}`,
          modificationType: 'cell_update',
          targetTable: table,
          targetRowId: rowId,
          ...(isPrimaryKeyRecordId(rowId) ? { newTargetRowId } : {}),
          targetColumn: column,
          newValue: prepared.value,
          operation: prepared.operation,
          priorValue
        });
        return newTargetRowId;
      } else {
        // Fallback for older backend versions (shouldn't happen if built correctly)
        throw new Error("Backend does not support updateCell");
      }
    }
  }

  /**
   * Insert a new row.
   */
  async insertRow(table: string, data: Record<string, CellValue>) {
    const dbOps = this.ensureDatabaseInitialized();

    if (this.isReadOnly) {
      throw new Error("Document is read-only");
    }

    const editLimitBytes = assertCellValuesWithinEditLimit(
      Object.values(data),
      DEFAULT_MAX_CELL_EDIT_BYTES
    );
    let rowId: RecordId | undefined;

    if ('insertRow' in dbOps) {
      rowId = await dbOps.insertRow(table, data, editLimitBytes);
    } else {
      throw new Error("Backend does not support insertRow");
    }

    let historyRowData: Record<string, CellValue> = {};
    if (rowId !== undefined && isPrimaryKeyRecordId(rowId)) {
      const primaryKey = decodePrimaryKeyRecordId(rowId);
      historyRowData = Object.fromEntries(
        primaryKey.columns.map((column, index) => [column, primaryKey.values[index]])
      );
    }

    // Fire edit event
    this.document.recordExternalModification({
      label: 'Insert Row',
      description: `Insert row into ${table}`,
      modificationType: 'row_insert',
      targetTable: table,
      targetRowId: rowId,
      rowData: { ...data, ...historyRowData }
    });

    return rowId;
  }

  /**
   * Delete rows.
   */
  async deleteRows(table: string, rowIds: RecordId[]) {
    const dbOps = this.ensureDatabaseInitialized();
    const connectionGeneration = this.captureConnectionGeneration();

    if (this.isReadOnly) {
      throw new Error("Document is read-only");
    }
    rowIds.forEach(assertMutableRecordId);

    const modification = {
      label: 'Delete Rows',
      description: `Delete ${rowIds.length} rows from ${table}`,
      modificationType: 'row_delete' as const,
      targetTable: table,
      affectedRowIds: rowIds,
      deletedRows: []
    };
    const undoMemoryLimitBytes = this.document.undoMemoryLimitBytes
      ?? getMaxUndoMemoryBytes();
    const baseMemoryBytes = estimateUndoMemoryBytes(modification);
    if (baseMemoryBytes > undoMemoryLimitBytes) {
      throw new Error(
        `Delete undo metadata exceeds the ${undoMemoryLimitBytes}-byte memory limit; ` +
        'delete fewer rows or increase sqliteExplorer.maxUndoMemory.'
      );
    }

    if (!('deleteRows' in dbOps)) {
      throw new Error("Backend does not support deleteRows");
    }
    const deletedRowsData = await dbOps.deleteRows(
      table,
      rowIds,
      undoMemoryLimitBytes - baseMemoryBytes
    );
    this.assertConnectionGeneration(connectionGeneration);

    // Fire edit event
    this.document.recordExternalModification({
      ...modification,
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
    const connectionGeneration = this.captureConnectionGeneration();

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

    // Capture the exact schema and values before deletion. If this fails, do not
    // perform an operation whose undo record would already be incomplete.
    const tableInfoBefore = await dbOps.getTableInfo(table);
    const identityBefore = await this.resolveTableIdentity(dbOps, table, tableInfoBefore);
    const stateBefore = await this.captureColumnDropTableState(
      dbOps,
      table,
      tableInfoBefore,
      identityBefore
    );
    const colMap = new Map(tableInfoBefore.map(column => [
      column.identifier,
      // An empty declared type is meaningful in SQLite: staging it as TEXT
      // would apply affinity and could change restored INTEGER/BLOB values.
      column.declaredType
    ]));
    for (const column of columns) {
      if (!colMap.has(column)) {
        throw new Error(`Column not found in ${table}: ${column}`);
      }
    }

    const colsData = columns.map(() => [] as { rowId: RecordId; value: CellValue }[]);
    if (columns.length > 0) {
      const identityColumns = identityBefore.kind === 'primaryKey'
        ? identityBefore.columns.map(column => column.identifier)
        : [];
      const identityProjection = identityBefore.kind === 'rowid'
        ? ['CAST(rowid AS TEXT)']
        : identityColumns.map(escapeIdentifier);
      const valueProjection = columns.map(escapeIdentifier);
      const result = await dbOps.executeQuery(
        `SELECT ${[...identityProjection, ...valueProjection].join(', ')} ` +
        `FROM ${escapeIdentifier(table)}`
      );
      const identityWidth = identityBefore.kind === 'rowid' ? 1 : identityColumns.length;
      for (const row of result[0]?.rows ?? []) {
        const rowId = identityBefore.kind === 'rowid'
          ? validateRowId(row[0] as RecordId)
          : encodePrimaryKeyRecordId(
              identityBefore.columns,
              row.slice(0, identityWidth)
            );
        for (let index = 0; index < columns.length; index++) {
          colsData[index].push({
            rowId,
            value: row[identityWidth + index]
          });
        }
      }
    }
    const deletedColumnsData = columns.map((column, index) => ({
      name: column,
      type: colMap.get(column)!,
      data: colsData[index]
    }));

    this.assertConnectionGeneration(connectionGeneration);
    let stateAfter: ColumnDropTableState;
    if ('deleteColumns' in dbOps) {
      // Pass dependent indexes to be dropped first if user confirmed
      stateAfter = await dbOps.deleteColumns(
        table,
        columns,
        dependentIndexes.length > 0 ? dependentIndexes : undefined
      );
    } else {
      throw new Error("Backend does not support deleteColumns");
    }

    // Fire edit event
    this.document.recordExternalModification({
      label: 'Delete Columns',
      description: `Delete columns ${columns.join(', ')} from ${table}`,
      modificationType: 'column_drop',
      targetTable: table,
      deletedColumns: deletedColumnsData,
      columnDropSnapshot: { before: stateBefore, after: stateAfter },
      droppedIndexes: dependentIndexes.length > 0 ? dependentIndexes : undefined
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

  /** Read the editable SELECT body and attached INSTEAD OF triggers for a view. */
  async getViewDefinition(view: string) {
    return this.ensureDatabaseInitialized().getViewDefinition(view);
  }

  /** Ask SQLite to compile a proposed view definition without changing the schema. */
  async validateViewDefinition(
    view: string,
    selectSql: string,
    intent: ViewDefinitionIntent = 'edit'
  ) {
    return this.ensureDatabaseInitialized().validateViewDefinition(view, selectSql, intent);
  }

  /** Return a bounded preview for a proposed view definition. */
  async previewViewDefinition(
    view: string,
    selectSql: string,
    limit: number = 50,
    intent: ViewDefinitionIntent = 'edit'
  ) {
    this.activePreviewController?.abort();
    const controller = new AbortController();
    this.activePreviewController = controller;
    try {
      return toWebviewQueryResultSet(await this.ensureDatabaseInitialized().previewViewDefinition(
        view,
        selectSql,
        limit,
        intent,
        controller.signal
      ));
    } finally {
      if (this.activePreviewController === controller) {
        this.activePreviewController = undefined;
      }
    }
  }

  /** Create a view and record enough state for save, undo, and redo. */
  async createView(view: string, selectSql: string) {
    const dbOps = this.ensureDatabaseInitialized();
    const connectionGeneration = this.captureConnectionGeneration();
    if (this.isReadOnly) {
      throw new Error('Document is read-only');
    }

    this.assertConnectionGeneration(connectionGeneration);
    const definition = await dbOps.createView(view, selectSql);
    this.assertConnectionGeneration(connectionGeneration);
    this.document.recordExternalModification({
      label: 'Create View',
      description: `Create view ${view}`,
      modificationType: 'view_create',
      targetTable: view,
      viewDefAfter: definition
    });
    return definition;
  }

  /**
   * Atomically replace a view. Trigger preservation is the default; discarding
   * attached triggers requires a separate modal confirmation.
   */
  async editView(
    view: string,
    selectSql: string,
    preserveTriggers: boolean = true,
    expectedSql?: string,
    expectedTriggers?: readonly ViewTriggerDefinition[]
  ) {
    const dbOps = this.ensureDatabaseInitialized();
    const connectionGeneration = this.captureConnectionGeneration();
    if (this.isReadOnly) {
      throw new Error('Document is read-only');
    }

    let triggerSnapshot = expectedTriggers;
    if (!preserveTriggers) {
      const current = await dbOps.getViewDefinition(view);
      // Direct callers may not already hold a modal/editor snapshot. Capture
      // the exact trigger state shown in this confirmation so the engine can
      // reject a trigger added or changed while the dialog is open.
      triggerSnapshot ??= current.triggers;
      if (current.triggers.length > 0) {
        const triggerNames = current.triggers.map(trigger => trigger.identifier).join(', ');
        const answer = await vsc.window.showWarningMessage(
          vsc.l10n.t(
            'Editing view "{0}" without preserving triggers will permanently drop: {1}',
            view,
            triggerNames
          ),
          { modal: true },
          { title: vsc.l10n.t('Edit and Drop Triggers'), value: true },
          { title: vsc.l10n.t('Cancel'), value: false, isCloseAffordance: true }
        );
        if (!answer?.value) {
          return { cancelled: true } as const;
        }
      }
    }

    this.assertConnectionGeneration(connectionGeneration);
    const result = await dbOps.editView(
      view,
      selectSql,
      preserveTriggers,
      expectedSql,
      triggerSnapshot
    );
    this.assertConnectionGeneration(connectionGeneration);
    this.document.recordExternalModification({
      label: 'Edit View',
      description: `Edit view ${view}`,
      modificationType: 'view_edit',
      targetTable: view,
      viewDefBefore: result.before,
      viewDefAfter: result.after
    });
    return result;
  }

  /** Drop a view only after a modal confirmation. */
  async dropView(view: string) {
    const dbOps = this.ensureDatabaseInitialized();
    const connectionGeneration = this.captureConnectionGeneration();
    if (this.isReadOnly) {
      throw new Error('Document is read-only');
    }

    while (true) {
      const current = await dbOps.getViewDefinition(view);
      const triggerNames = current.triggers.map(trigger => trigger.identifier).join(', ');
      const confirmationMessage = triggerNames
        ? vsc.l10n.t(
            'Drop view "{0}"? This will permanently drop its INSTEAD OF triggers: {1}',
            view,
            triggerNames
          )
        : vsc.l10n.t('Drop view "{0}"?', view);
      const answer = await vsc.window.showWarningMessage(
        confirmationMessage,
        { modal: true },
        { title: vsc.l10n.t('Drop View'), value: true },
        { title: vsc.l10n.t('Cancel'), value: false, isCloseAffordance: true }
      );
      if (!answer?.value) {
        return { cancelled: true } as const;
      }

      try {
        this.assertConnectionGeneration(connectionGeneration);
        const definition = await dbOps.dropView(
          view,
          current.sql,
          current.triggers
        );
        this.assertConnectionGeneration(connectionGeneration);
        this.document.recordExternalModification({
          label: 'Drop View',
          description: `Drop view ${view}`,
          modificationType: 'view_drop',
          targetTable: view,
          viewDefBefore: definition
        });
        return;
      } catch (err) {
        // Re-read and re-confirm so the dialog always names the exact trigger
        // set guarded by the engine-side compare-and-swap.
        if (isViewDefinitionConflictError(err)) continue;
        throw err;
      }
    }
  }

  /**
   * Update multiple cells in batch.
   */
  async updateCellBatch(table: string, updates: CellUpdate[], label: string) {
    const dbOps = this.ensureDatabaseInitialized();
    const connectionGeneration = this.captureConnectionGeneration();

    if (this.isReadOnly) {
      throw new Error("Document is read-only");
    }
    updates.forEach(update => assertMutableRecordId(update.rowId));

    if (updates.length === 0) return;
    const editLimitBytes = assertCellValuesWithinEditLimit(
      updates.map(update => update.value),
      DEFAULT_MAX_CELL_EDIT_BYTES
    );

    this.assertConnectionGeneration(connectionGeneration);
    const historyCells = await dbOps.updateCellBatch(table, updates, editLimitBytes);
    this.assertConnectionGeneration(connectionGeneration);

    // Fire batch edit event
    this.document.recordExternalModification({
      label: label || `Update ${updates.length} cells`,
      description: `Update ${updates.length} cells in ${table}`,
      modificationType: 'cell_update',
      targetTable: table,
      affectedCells: historyCells
    });
    return historyCells;
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
  async fetchTableData(table: string, options: TableQueryOptions): Promise<WebviewQueryResultSet> {
    const dbOps = this.ensureDatabaseInitialized();

    if ('fetchTableData' in dbOps) {
      const configuredCellLimit = getMaxInlineCellBytes();
      const requestedCellLimit = Number.isSafeInteger(options.maxInlineCellBytes)
        && (options.maxInlineCellBytes ?? 0) > 0
        ? options.maxInlineCellBytes!
        : configuredCellLimit;
      const requestedPageLimit = Number.isSafeInteger(options.maxPageResponseBytes)
        && (options.maxPageResponseBytes ?? 0) > 0
        ? options.maxPageResponseBytes!
        : DEFAULT_MAX_PAGE_RESPONSE_BYTES;
      return toWebviewQueryResultSet(await dbOps.fetchTableData(table, {
        ...options,
        maxInlineCellBytes: Math.min(configuredCellLimit, requestedCellLimit),
        maxPageResponseBytes: Math.min(DEFAULT_MAX_PAGE_RESPONSE_BYTES, requestedPageLimit)
      }));
    } else {
      throw new Error("Backend does not support fetchTableData");
    }
  }

  /**
   * Fetch table count (SELECT COUNT(*)).
   */
  async fetchTableCount(table: string, options: TableCountOptions): Promise<TableCountResult> {
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

    if (!('setPragma' in dbOps)) {
      throw new Error("Backend does not support setPragma");
    }
    const trackPersistentPagedChange = this.document.isPagedWritableMode === true
      && PAGED_PERSISTENT_PRAGMAS.has(pragma);
    if (!trackPersistentPagedChange) {
      await dbOps.setPragma(pragma, value);
      return;
    }
    if (!('getPragmas' in dbOps)) {
      throw new Error('Backend cannot verify a persistent PRAGMA change');
    }

    const priorValue = (await dbOps.getPragmas())[pragma];
    if (priorValue === undefined) {
      throw new Error(`Backend did not report PRAGMA ${pragma} before changing it`);
    }
    await dbOps.setPragma(pragma, value);

    let effectiveValue: CellValue = value;
    try {
      const reportedValue = (await dbOps.getPragmas())[pragma];
      if (reportedValue === undefined) {
        throw new Error(`Backend did not report PRAGMA ${pragma} after changing it`);
      }
      effectiveValue = reportedValue;
    } catch (error) {
      // The mutation already succeeded. Preserve a replayable dirty entry even
      // when the verification read fails, then propagate the diagnostic.
      this.document.recordExternalModification({
        label: `Change PRAGMA ${pragma}`,
        description: `Set PRAGMA ${pragma}`,
        modificationType: 'pragma_update',
        targetPragma: pragma,
        priorValue,
        newValue: value,
        undoPolicy: 'barrier',
        undoBarrierKind: 'persistent_pragma'
      });
      throw new Error(
        `PRAGMA ${pragma} changed, but its effective value could not be verified`,
        { cause: error }
      );
    }

    if (sameEffectivePragmaValue(priorValue, effectiveValue)) return;
    this.document.recordExternalModification({
      label: `Change PRAGMA ${pragma}`,
      description: `Set PRAGMA ${pragma}`,
      modificationType: 'pragma_update',
      targetPragma: pragma,
      priorValue,
      newValue: effectiveValue,
      undoPolicy: 'barrier',
      undoBarrierKind: 'persistent_pragma'
    });
  }

  // History replay (undo/redo/commit/rollback) is driven by DatabaseDocument on the
  // extension side, never by the webview — do not re-add bridge methods for it here:
  // every function-valued property on this class is dispatchable by name over RPC.

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
   *
   * Read-only when EITHER the editor provider is the read-only variant OR the
   * specific connection opened read-only. The latter matters in VS Code for Web:
   * a database with an active WAL opens read-only at the connection level even
   * though the read-write DatabaseEditorProvider is registered, so the edit gate
   * must honor the connection state too — otherwise the webview would allow edits
   * that save()/revert() then reject, stranding the user with unsavable changes.
   */
  get isReadOnly() {
    return this.viewerProvider.isReadOnly || this.document.isReadOnlyMode;
  }

  /**
   * Refresh the database from disk.
   *
   * @returns Refreshed connection capabilities for immediate webview gating
   */
  async refreshFile() {
    const { document } = this;
    if (document.uri.scheme !== 'untitled') {
      await document.reloadFromDisk();
      return {
        connected: true,
        filename: document.fileParts.filename,
        readOnly: this.isReadOnly
      };
    }
    throw new Error(vsc.l10n.t('Reload is unavailable for untitled databases'));
  }


  /**
   * Fire an edit event to mark the document as dirty.
   *
   * @param edit - The edit operation that was performed
   */
  async fireEditEvent(edit: unknown) {
    if (this.isReadOnly) {
      throw new Error('Document is read-only');
    }
    assertDocumentModification(edit);
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
    assertMutableRecordId(rowId);
    const { document } = this;
    if (document.uri.scheme !== 'untitled') {
      let cellParts: string[];

      if (rowId === '__create__.sql') {
        cellParts = [params.table, params.name || '-', '__create__.sql'];
      } else {
        // Determine file extension based on content type
        const extname = await determineCellExtension(value, type);
        const materializer = this.cellMaterializer;
        if (materializer && colName) {
          const target = { table: params.table, rowId, column: colName };
          const metadata = await this.ensureDatabaseInitialized().getCellMetadata(target);
          if (metadata.byteLength > getMaxInlineCellBytes()) {
            let materialized;
            this.activeCellMaterializationController?.abort();
            const materializationController = new AbortController();
            this.activeCellMaterializationController = materializationController;
            const documentDisposeSubscription = document.onDidDispose(
              () => materializationController.abort()
            );
            try {
              materialized = await materializer.materialize(
                this.ensureDatabaseInitialized(),
                target,
                {
                  signal: materializationController.signal,
                  fileExtension: extname.slice(1),
                  owner: document
                }
              );
            } catch (error) {
              const details = error instanceof Error ? error.message : String(error);
              throw new Error(
                `The oversized cell could not be opened from a temporary file: ${details}. ` +
                'Export the cell instead to choose an explicit destination.',
                { cause: error }
              );
            } finally {
              documentDisposeSubscription.dispose();
              if (this.activeCellMaterializationController === materializationController) {
                this.activeCellMaterializationController = undefined;
              }
            }

            try {
              await vsc.commands.executeCommand(
                'vscode.open',
                materialized.uri,
                vsc.ViewColumn.Two
              );
              await vsc.commands.executeCommand(
                'workbench.action.files.setActiveEditorReadonlyInSession'
              );
            } catch (error) {
              materializer.release(materialized.uri);
              throw error;
            }
            return;
          }
        }
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
   * Materialize an oversized media cell and expose only its webview-local URI.
   * The complete value never enters the RPC response or a structured clone.
   */
  async prepareCellMediaPreview(
    params: DbParams,
    rowId: RecordId,
    colName: string,
    options: CellMediaPreviewOptions
  ): Promise<
    | {
      success: true;
      previewId: string;
      uri: string;
      mime: string;
      byteLength: number;
    }
    | { success: false; message: string }
  > {
    assertMutableRecordId(rowId);
    if (!params || typeof params.table !== 'string' || params.table.length === 0) {
      throw new TypeError('Oversized media preview requires a table name');
    }
    if (typeof colName !== 'string' || colName.length === 0) {
      throw new TypeError('Oversized media preview requires a column name');
    }
    if (!options || typeof options.webviewId !== 'string' || options.webviewId.length === 0) {
      throw new TypeError('Oversized media preview requires a webview ID');
    }

    const media = resolveOversizedMediaType(options.type);
    const materializer = this.cellMaterializer;
    if (!materializer) {
      return {
        success: false,
        message: 'Oversized media previews are available only in VS Code Desktop'
      };
    }

    const panel = this.webviews.getByWebviewId(options.webviewId);
    if (!panel || ![...this.webviews.get(this.document.uri)].includes(panel)) {
      throw new Error('Oversized media preview webview does not belong to this database document');
    }

    const target = { table: params.table, rowId, column: colName };
    const operations = this.ensureDatabaseInitialized();
    const metadata = await operations.getCellMetadata(target);
    if (metadata.storageClass !== 'blob') {
      throw new Error('Oversized media preview requires a BLOB cell');
    }
    if (metadata.byteLength <= getMaxInlineCellBytes()) {
      return {
        success: false,
        message: 'This media cell is within the inline transport budget and does not need a temp URI'
      };
    }

    this.activeCellMediaControllers.get(options.webviewId)?.abort();
    const controller = new AbortController();
    this.activeCellMediaControllers.set(options.webviewId, controller);
    const panelDisposeSubscription = panel.onDidDispose(() => controller.abort());

    let materialized;
    try {
      materialized = await materializer.materialize(operations, target, {
        signal: controller.signal,
        fileExtension: media.extension,
        owner: panel
      });
    } finally {
      panelDisposeSubscription.dispose();
      if (this.activeCellMediaControllers.get(options.webviewId) === controller) {
        this.activeCellMediaControllers.delete(options.webviewId);
      }
    }

    if (this.webviews.getByWebviewId(options.webviewId) !== panel) {
      materializer.release(materialized.uri);
      throw new Error('Oversized media preview was cancelled because its webview closed');
    }

    const previewId = crypto.randomUUID();
    const runDirectory = vsc.Uri.file(path.dirname(materialized.uri.fsPath));
    let resourceUri: string;
    try {
      resourceUri = panel.webview.asWebviewUri(materialized.uri).toString();
      panel.webview.options = {
        ...panel.webview.options,
        localResourceRoots: [this.codiconsResourceRoot(), runDirectory]
      };
    } catch (error) {
      materializer.release(materialized.uri);
      throw error;
    }

    const previous = this.activeCellMediaPreviews.get(options.webviewId);
    try {
      if (previous) materializer.release(previous.uri);
    } catch (error) {
      materializer.release(materialized.uri);
      throw error;
    }
    this.activeCellMediaPreviews.set(options.webviewId, {
      previewId,
      uri: materialized.uri,
      panel
    });
    this.trackMediaPanel(panel);

    return {
      success: true,
      previewId,
      uri: resourceUri,
      mime: options.type.mime!,
      byteLength: materialized.byteLength
    };
  }

  /** Release a URI lease. Stale cleanup calls are intentionally idempotent. */
  async releaseCellMediaPreview(webviewId: string, previewId: string): Promise<void> {
    const active = this.activeCellMediaPreviews.get(webviewId);
    if (!active || active.previewId !== previewId) return;

    this.activeCellMediaPreviews.delete(webviewId);
    this.cellMaterializer?.release(active.uri);
    if (this.webviews.getByWebviewId(webviewId) === active.panel) {
      active.panel.webview.options = {
        ...active.panel.webview.options,
        localResourceRoots: [this.codiconsResourceRoot()]
      };
    }
  }

  private codiconsResourceRoot(): vsc.Uri {
    // build.mjs copies codicon.css + codicon.ttf here; the full
    // @vscode/codicons package is not shipped in the .vsix.
    return vsc.Uri.joinPath(this.context.extensionUri, 'assets', 'codicons');
  }

  private trackMediaPanel(panel: vsc.WebviewPanel): void {
    if (this.mediaPanelSubscriptions.has(panel)) return;
    const subscription = panel.onDidDispose(() => {
      for (const [webviewId, active] of this.activeCellMediaPreviews) {
        if (active.panel === panel) this.activeCellMediaPreviews.delete(webviewId);
      }
      this.mediaPanelSubscriptions.delete(panel);
      // Stage B owns panel-disposal file removal. This listener only drops the
      // RPC lease so a later stale release cannot affect another preview.
    });
    this.mediaPanelSubscriptions.set(panel, subscription);
  }

  /** Open a view's SELECT body in the writable virtual filesystem as SQL. */
  async openViewEditor(view: string, webviewId?: string) {
    if (this.isReadOnly) {
      throw new Error('Document is read-only');
    }

    const { document } = this;
    if (document.uri.scheme === 'untitled') {
      throw new Error(vsc.l10n.t(
        'The external view editor is unavailable for untitled databases'
      ));
    }

    const docKey = await document.documentKey;
    const uriPath = [docKey, view, '-', '__view__.sql', 'definition.sql']
      .map(part => encodeURIComponent(part))
      .join('/');
    const viewUri = vsc.Uri.from({
      scheme: UriScheme,
      path: `/${uriPath}`,
      query: webviewId ? `webview-id=${encodeURIComponent(webviewId)}` : ''
    });

    await vsc.commands.executeCommand('vscode.open', viewUri, vsc.ViewColumn.Two);
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

    // SECURITY: Block dangerous URI schemes that could execute code or fetch remote
    // resources. Our own virtual scheme is blocked too: it resolves through the global
    // DocumentRegistry, so it would let this webview read cells out of a different
    // open database.
    const blockedSchemes = ['http', 'https', 'command', 'javascript', 'data', 'vbscript', 'vscode-command', UriScheme];
    if (blockedSchemes.includes(uri.scheme)) {
      throw new Error(`Access denied: Cannot read from scheme "${uri.scheme}"`);
    }

    // SECURITY: Whitelist approach for every scheme — workspace.fs applies per-provider
    // ACLs, not a workspace boundary, so non-file schemes (vscode-userdata:,
    // vscode-vfs:, ...) must not bypass containment. Only allow access to files in:
    // 1. Explicit workspace folders
    // 2. The same directory as the open database (or subdirectories)
    // Both branches run the same normalized containment check
    // (isUriContainedInDirectory); membership lookups alone never authorize a read.

    // 1. Check if file is within workspace folders. getWorkspaceFolder matches
    // scheme/authority/path, so vscode-remote and vscode-vfs workspace folders resolve
    // here — this is what keeps explorer drag-and-drop working in remote workspaces.
    // It is only a lookup, though: it prefix-matches literal path segments without
    // collapsing dot segments ('..' is just another segment to it), so
    // '<folder>/../../etc/passwd' still returns the folder. Containment must be
    // re-verified on normalized paths before the read.
    const workspaceFolder = vsc.workspace.getWorkspaceFolder(uri);
    if (workspaceFolder && isUriContainedInDirectory(uri, workspaceFolder.uri, 'directory')) {
      return await vsc.workspace.fs.readFile(uri);
    }

    // 2. Check if file is in the same directory tree as the open document.
    // This allows drag-and-drop from the same directory tree in single-file mode.
    if (!isUriContainedInDirectory(uri, this.document.uri, 'parent-of-file')) {
      throw new Error(`Access denied: File "${uri.toString()}" is not in the current workspace or document directory.`);
    }

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
            buffer = new Uint8Array(data.buffer || (data as unknown as ArrayBufferLike), data.byteOffset, data.byteLength);
        }
        await vsc.workspace.fs.writeFile(uri, buffer);
    }
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
        const stat = await vsc.workspace.fs.stat(uri);
        if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
            throw new Error('Unable to determine the selected file size safely.');
        }
        if (stat.size > DEFAULT_MAX_CELL_EDIT_BYTES) {
            throw new CellEditPolicyError('blob', stat.size, DEFAULT_MAX_CELL_EDIT_BYTES);
        }
        const data = await vsc.workspace.fs.readFile(uri);
        assertCellValueWithinEditLimit(data, DEFAULT_MAX_CELL_EDIT_BYTES);
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

function resolveOversizedMediaType(type: CellContentType | undefined): {
  type: 'image' | 'audio' | 'video' | 'pdf';
  extension: string;
} {
  const media = type?.mime ? OVERSIZED_MEDIA_TYPES[type.mime] : undefined;
  if (!media || type?.type !== media.type) {
    throw new Error(
      `Unsupported oversized media type: ${type?.mime ?? 'unknown'} (${type?.type ?? 'unknown'})`
    );
  }
  return media;
}
