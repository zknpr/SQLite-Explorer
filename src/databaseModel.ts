/**
 * Database Document Model
 *
 * Represents a SQLite database as a VS Code CustomDocument.
 * Handles document lifecycle, modification tracking, and persistence.
 */

import type { TelemetryReporter } from '@vscode/extension-telemetry';
import type { DatabaseViewerProvider } from './editorController';

import * as vsc from 'vscode';

import { ConfigurationSection, FullExtensionId } from './config';
import { Disposable } from './lifecycle';
import { cancelTokenToAbortSignal, getUriParts, generateDatabaseDocumentKey } from './helpers';
import { HostBridge } from './hostBridge';
import { DatabaseConnectionBundle } from './connectionTypes';
import { DocumentRegistry } from './documentRegistry';

import { createDatabaseConnection, getMaximumFileSizeBytes } from './workerFactory';

import { ModificationTracker } from './core/undo-history';
import type { LabeledModification, DatabaseOperations } from './core/types';
import { LoggingDatabaseOperations } from './loggingDatabaseOperations';

// ============================================================================
// Types
// ============================================================================

/**
 * Modification entry with display label.
 */
export type DocumentModification = LabeledModification;

// ============================================================================
// Environment Detection
// ============================================================================

/** Reference to the running extension */
const CurrentExtension = vsc.extensions.getExtension(FullExtensionId);

/** Running on local machine (not remote) */
const IsLocalMode = !vsc.env.remoteName;

/** Running on remote with workspace extension */
export const IsRemoteWorkspaceMode =
  !!vsc.env.remoteName &&
  CurrentExtension?.extensionKind === vsc.ExtensionKind.Workspace;

/** Editor supports read-write operations */
export const SupportsWriteMode = IsLocalMode || IsRemoteWorkspaceMode;

// ============================================================================
// Configuration
// ============================================================================

/** Maximum modifications to track */
const MODIFICATION_LIMIT = 100;

/**
 * Get auto-commit setting from configuration.
 */
export function isAutoCommitEnabled(): boolean {
  const config = vsc.workspace.getConfiguration(ConfigurationSection);
  const setting = config.get<string>('instantCommit', 'never');
  return setting === 'always' || (setting === 'remote-only' && IsRemoteWorkspaceMode);
}

// ============================================================================
// Document Class
// ============================================================================

/**
 * Database document implementation.
 *
 * Implements VS Code's CustomDocument for SQLite databases.
 * Manages:
 * - Database connection lifecycle
 * - Modification tracking and undo/redo
 * - Save, save-as, and revert operations
 * - Hot exit backup/restore
 */
export class DatabaseDocument extends Disposable implements vsc.CustomDocument {
  /** Unique document key for registry lookup */
  readonly #documentKey: Promise<string>;

  /**
   * Factory method to create a DatabaseDocument.
   */
  static async create(
    viewerProvider: DatabaseViewerProvider,
    fileUri: vsc.Uri,
    openContext: vsc.CustomDocumentOpenContext,
    cancellation?: vsc.CancellationToken
  ): Promise<DatabaseDocument> {
    const { reporter, isVerified, context: { extensionUri } } = viewerProvider;
    let { forceReadOnly } = viewerProvider;

    // Use WebAssembly-based worker for database operations
    const connectionFactory = createDatabaseConnection;

    const { filename } = getUriParts(fileUri);
    const autoCommit = isAutoCommitEnabled();

    let connectionBundle: DatabaseConnectionBundle;
    let databaseOps: DatabaseOperations;

    try {
      connectionBundle = await connectionFactory(extensionUri, reporter);
      const result = await connectionBundle.establishConnection(
        fileUri,
        filename,
        forceReadOnly,
        autoCommit
      );
      databaseOps = result.databaseOps;
      forceReadOnly = result.isReadOnly;

      // Wrap with logger if output channel is available
      if (viewerProvider.outputChannel) {
        databaseOps = new LoggingDatabaseOperations(
          databaseOps,
          filename,
          viewerProvider.outputChannel
        );
      }
    } catch (err) {
      throw err;
    }

    // Restore modification history from backup
    let tracker: ModificationTracker<DocumentModification> | null = null;
    if (typeof openContext.backupId === 'string' && !autoCommit) {
      const backupUri = vsc.Uri.parse(openContext.backupId);
      const backupData = await vsc.workspace.fs.readFile(backupUri);
      tracker = ModificationTracker.deserialize<DocumentModification>(
        backupData,
        MODIFICATION_LIMIT
      );

      try {
        // Replay uncommitted modifications
        await databaseOps.applyModifications(
          tracker.getUncommittedEntries(),
          cancelTokenToAbortSignal(cancellation)
        );
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : vsc.l10n.t('Unknown error');
        await vsc.window.showErrorMessage(
          vsc.l10n.t('[{0}] occurred while applying unsaved changes', errorMsg),
          {
            modal: true,
            detail: vsc.l10n.t(
              'The document was restored from backup, but changes could not be applied. Opening in read-only mode.'
            )
          }
        );
        forceReadOnly = true;
      }
    }

    return new DatabaseDocument(
      viewerProvider,
      fileUri,
      tracker,
      autoCommit,
      { databaseOps, isReadOnly: forceReadOnly },
      connectionBundle.workerMethods,
      connectionBundle.establishConnection.bind(connectionBundle),
      reporter
    );
  }

  /** Get configured max file size */
  getFileSizeLimit(): number {
    return getMaximumFileSizeBytes();
  }

  // Private state
  readonly #modificationTracker: ModificationTracker<DocumentModification>;
  readonly #hostBridge: HostBridge;

  private constructor(
    readonly viewerProvider: DatabaseViewerProvider,
    readonly uri: vsc.Uri,
    tracker: ModificationTracker<DocumentModification> | null,
    public autoCommitEnabled: boolean,
    private connectionState: { databaseOps: DatabaseOperations; isReadOnly?: boolean },
    private readonly workerMethods: DatabaseConnectionBundle['workerMethods'],
    private readonly establishConnection: DatabaseConnectionBundle['establishConnection'],
    private readonly reporter?: TelemetryReporter
  ) {
    super();
    this.#modificationTracker = tracker ?? new ModificationTracker<DocumentModification>(MODIFICATION_LIMIT);
    this.#hostBridge = new HostBridge(viewerProvider, this);
    this.#documentKey = generateDatabaseDocumentKey(this.uri);
    this.#documentKey.then(key => DocumentRegistry.set(key, this));
  }

  // Public accessors
  get fileParts() { return getUriParts(this.uri); }
  get hostBridge() { return this.#hostBridge; }
  get documentKey() { return this.#documentKey; }

  // ============================================================================
  // Event Emitters
  // ============================================================================

  readonly #disposeEmitter = this._register(new vsc.EventEmitter<void>());
  readonly onDidDispose = this.#disposeEmitter.event;

  readonly #contentChangeEmitter = this._register(new vsc.EventEmitter<{}>());
  readonly onDidChangeContent = this.#contentChangeEmitter.event;

  readonly #modificationEmitter = this._register(
    new vsc.EventEmitter<{
      readonly label: string;
      undo(): void | Promise<void>;
      redo(): void | Promise<void>;
    }>()
  );
  readonly onDidChange = this.#modificationEmitter.event;

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async dispose(): Promise<void> {
    const key = await this.#documentKey;
    DocumentRegistry.delete(key);
    this.workerMethods[Symbol.dispose]();
    super.dispose();
    this.#disposeEmitter.fire();
  }

  // ============================================================================
  // Modification Tracking
  // ============================================================================

  /**
   * Record a modification for undo/redo tracking.
   */
  recordModification(modification: DocumentModification): void {
    const tracker = this.#modificationTracker;
    tracker.record(modification);

    this.#modificationEmitter.fire({
      label: modification.label,
      undo: async () => {
        const undoneEntry = tracker.stepBack();
        if (!undoneEntry) return;
        await this.databaseOperations.undoModification(undoneEntry);
        this.#contentChangeEmitter.fire({});
        this.#autoSaveIfNeeded();
      },
      redo: async () => {
        const redoneEntry = tracker.stepForward();
        if (!redoneEntry) return;
        await this.databaseOperations.redoModification(redoneEntry);
        this.#contentChangeEmitter.fire({});
        this.#autoSaveIfNeeded();
      }
    });

    this.#autoSaveIfNeeded();
  }

  /**
   * Record a modification from external source.
   */
  recordExternalModification(modification: DocumentModification): void {
    this.recordModification(modification);
    this.#contentChangeEmitter.fire({});
  }

  // ============================================================================
  // Persistence
  // ============================================================================

  /** Verify document is writable */
  ensureWritable = async (): Promise<void> => {
    if (this.isReadOnlyMode) {
      throw new Error(vsc.l10n.t('Document is read-only'));
    }
  };

  /**
   * Save document to disk.
   *
   * For native SQLite engine: changes are already persisted to disk via SQLite's
   * auto-commit, so we just need to create a checkpoint for undo/redo tracking.
   *
   * For WASM engine: we need to serialize the in-memory database and write to disk.
   */
  async save(cancellation?: vsc.CancellationToken): Promise<void> {
    await this.ensureWritable();
    await this.#modificationTracker.createCheckpoint();

    // Check if using native engine - changes are already on disk
    const engineKind = await this.databaseOperations.engineKind;
    if (engineKind === 'native') {
      // Native SQLite writes directly to file - no export needed
      // Just ensure WAL is checkpointed for consistency
      try {
        await this.databaseOperations.executeQuery('PRAGMA wal_checkpoint(PASSIVE)');
      } catch {
        // Ignore checkpoint errors - database may not be using WAL mode
      }
      return;
    }

    // Export in-memory database to file (WASM engine only)
    // We always do this for WASM, regardless of auto-commit setting, because WASM is in-memory.
    if (this.uri.scheme === 'file') {
        try {
            await this.databaseOperations.writeToFile(this.uri.fsPath);
            return;
        } catch (e) {
            // Fallback if direct write fails
            console.warn('Direct write failed, falling back to buffer transfer', e);
        }
    }

    const { filename } = this.fileParts;
    const binaryContent = await this.databaseOperations.serializeDatabase(filename);
    await vsc.workspace.fs.writeFile(this.uri, binaryContent);
  }

  /**
   * Save document to new location.
   */
  async saveAs(targetUri: vsc.Uri, cancellation: vsc.CancellationToken): Promise<void> {
    await this.ensureWritable();

    if (targetUri.scheme === 'file') {
        try {
            // Use optimized write/vacuum if available
            await this.databaseOperations.writeToFile(targetUri.fsPath);
            return;
        } catch (e) {
             console.warn('Direct write failed, falling back to buffer transfer', e);
        }
    }

    const fileStat = await vsc.workspace.fs.stat(this.uri);
    if (fileStat.size > this.getFileSizeLimit()) {
      throw new Error(vsc.l10n.t('Database too large for copy operation'));
    }

    const { filename } = this.fileParts;
    const binaryContent = await this.databaseOperations.serializeDatabase(filename);
    await vsc.workspace.fs.writeFile(targetUri, binaryContent);
  }

  /**
   * Revert to last saved state.
   */
  async revert(cancellation: vsc.CancellationToken): Promise<void> {
    await this.ensureWritable();
    this.#modificationTracker.rollbackToCheckpoint();
    await this.databaseOperations.discardModifications(
      this.#modificationTracker.getUncommittedEntries(),
      cancelTokenToAbortSignal(cancellation)
    );
    this.#contentChangeEmitter.fire({});
    this.#autoSaveIfNeeded();
  }

  // ============================================================================
  // Auto-save
  // ============================================================================

  async #autoSaveIfNeeded(): Promise<void> {
    try {
      if (this.autoCommitEnabled) {
        if (this.#hasActiveViewer) {
          await this.triggerSave();
        } else {
          this.#savePending = true;
        }
      }
    } catch { }
  }

  #hasActiveViewer = false;
  set hasActiveViewer(value: boolean) {
    this.#hasActiveViewer = value;
  }

  #savePending = false;
  get hasPendingSave(): boolean {
    return this.#savePending;
  }

  async triggerSave(): Promise<void> {
    this.#savePending = false;
    await vsc.commands.executeCommand('workbench.action.files.save');
  }

  // ============================================================================
  // Database Access
  // ============================================================================

  get databaseOperations(): DatabaseOperations {
    return this.connectionState.databaseOps;
  }

  get isReadOnlyMode(): boolean {
    return this.connectionState.isReadOnly ?? false;
  }

  get cellEditBehavior(): string {
    const config = vsc.workspace.getConfiguration(ConfigurationSection);
    return config.get<string>('doubleClickBehavior', 'inline');
  }

  /**
   * Reload database from disk.
   */
  async reloadFromDisk(): Promise<DatabaseOperations> {
    const currentOps = this.databaseOperations;

    if ((await currentOps.engineKind) === 'wasm') {
      const result = await this.establishConnection(
        this.uri,
        this.fileParts.filename
      );
      this.connectionState = {
        databaseOps: result.databaseOps,
        isReadOnly: result.isReadOnly
      };
      return result.databaseOps;
    }

    return currentOps;
  }

  // ============================================================================
  // Backup (Hot Exit)
  // ============================================================================

  async backup(
    destination: vsc.Uri,
    _cancellation: vsc.CancellationToken
  ): Promise<vsc.CustomDocumentBackup> {
    const serializedState = this.#modificationTracker.serialize();
    await vsc.workspace.fs.writeFile(destination, serializedState);

    return {
      id: destination.toString(),
      delete: async () => {
        try {
          await vsc.workspace.fs.delete(destination);
        } catch { }
      }
    };
  }
}
