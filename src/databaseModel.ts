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

import { createDatabaseConnection } from './workerFactory';
import { getMaximumFileSizeBytes } from './config';
import { GlobalOutputChannel } from './main';

import { ModificationTracker } from './core/undo-history';
import { reconcileRestoredDatabase, revertDatabaseToSaved } from './core/restore-reconciler';
import { isInvocationTimeoutError } from './core/rpc';
import type { LabeledModification, DatabaseOperations } from './core/types';
import { LoggingDatabaseOperations } from './loggingDatabaseOperations';

// ============================================================================
// Types
// ============================================================================

/**
 * Modification entry with display label.
 */
export type DocumentModification = LabeledModification;

/** Database content change, optionally tied to the history entry just applied. */
export interface DocumentContentChange {
  readonly modification?: DocumentModification;
  /** Whether history applied the entry forward or restored its prior state. */
  readonly modificationDirection?: 'forward' | 'undo';
  /** The whole live database was replaced, so every open schema document is stale. */
  readonly invalidateAllViewDocuments?: boolean;
}

// ============================================================================
// Environment Detection
// ============================================================================

/** Reference to the running extension */
const CurrentExtension = vsc.extensions.getExtension(FullExtensionId);

/** Running on local machine (not remote) */
const IsLocalMode = !vsc.env.remoteName;

/** Running inside the browser extension host used by VS Code for Web */
const IsBrowserExtensionHost = !!import.meta.env?.VSCODE_BROWSER_EXT;

/** Running on remote with workspace extension */
export const IsRemoteWorkspaceMode =
  !!vsc.env.remoteName &&
  CurrentExtension?.extensionKind === vsc.ExtensionKind.Workspace;

/** Editor supports read-write operations */
export const SupportsWriteMode = IsLocalMode || IsRemoteWorkspaceMode || IsBrowserExtensionHost;

// ============================================================================
// Configuration
// ============================================================================

/** Maximum modifications to track */
const MODIFICATION_LIMIT = 100;

/** Default maximum memory for undo history (50MB) */
const DEFAULT_MAX_UNDO_MEMORY = 50 * 1024 * 1024;

/**
 * Get auto-commit setting from configuration.
 */
export function isAutoCommitEnabled(): boolean {
  const config = vsc.workspace.getConfiguration(ConfigurationSection);
  const setting = config.get<string>('instantCommit', 'never');
  return setting === 'always' || (setting === 'remote-only' && IsRemoteWorkspaceMode);
}

/**
 * Get maximum undo memory from configuration.
 */
function getMaxUndoMemory(): number {
  const config = vsc.workspace.getConfiguration(ConfigurationSection);
  return config.get<number>('maxUndoMemory', DEFAULT_MAX_UNDO_MEMORY);
}

/** Apply the document's SQL logging decorator consistently across reconnects. */
function withSqlLogging(
  databaseOps: DatabaseOperations,
  filename: string,
  outputChannel: vsc.OutputChannel | null | undefined
): DatabaseOperations {
  return outputChannel
    ? new LoggingDatabaseOperations(databaseOps, filename, outputChannel)
    : databaseOps;
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
    const configuredForceReadOnly = viewerProvider.forceReadOnly ?? false;
    let forceReadOnlyOnReconnect = configuredForceReadOnly;

    // Use WebAssembly-based worker for database operations
    const connectionFactory = createDatabaseConnection;

    const { filename } = getUriParts(fileUri);
    const autoCommit = isAutoCommitEnabled();

    let connectionBundle: DatabaseConnectionBundle;
    let databaseOps: DatabaseOperations;

    connectionBundle = await connectionFactory(extensionUri, reporter);
    const result = await connectionBundle.establishConnection(
      fileUri,
      filename,
      configuredForceReadOnly,
      autoCommit
    );
    databaseOps = result.databaseOps;
    let isReadOnly = result.isReadOnly ?? configuredForceReadOnly;

    databaseOps = withSqlLogging(databaseOps, filename, viewerProvider.outputChannel);

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
        // Reconcile the opened database to the live timeline state. WASM opens
        // checkpoint bytes and may need forward replay or saved-edit reverts;
        // native opens the already-live on-disk database and returns unchanged.
        await reconcileRestoredDatabase(
          databaseOps,
          tracker,
          await databaseOps.engineKind,
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
        isReadOnly = true;
        // This is a safety downgrade, not a transient capability such as a WAL
        // observed by the browser backend. Persist it separately so every later
        // reconnect remains forced read-only.
        forceReadOnlyOnReconnect = true;
      }
    }

    return new DatabaseDocument(
      viewerProvider,
      fileUri,
      tracker,
      autoCommit,
      { databaseOps, isReadOnly },
      connectionBundle.workerMethods,
      connectionBundle.establishConnection.bind(connectionBundle),
      reporter,
      forceReadOnlyOnReconnect
    );
  }

  /** Get configured max file size */
  getFileSizeLimit(): number {
    return getMaximumFileSizeBytes();
  }

  // Private state
  readonly #modificationTracker: ModificationTracker<DocumentModification>;
  readonly #hostBridge: HostBridge;
  readonly #forceReadOnlyOnReconnect: boolean;
  #connectionGeneration = 0;

  private constructor(
    readonly viewerProvider: DatabaseViewerProvider,
    readonly uri: vsc.Uri,
    tracker: ModificationTracker<DocumentModification> | null,
    public autoCommitEnabled: boolean,
    private connectionState: { databaseOps: DatabaseOperations; isReadOnly?: boolean },
    private readonly workerMethods: DatabaseConnectionBundle['workerMethods'],
    private readonly establishConnection: DatabaseConnectionBundle['establishConnection'],
    private readonly reporter?: TelemetryReporter,
    forceReadOnlyOnReconnect: boolean = viewerProvider.forceReadOnly ?? false
  ) {
    super();
    this.#forceReadOnlyOnReconnect = forceReadOnlyOnReconnect;
    this.#modificationTracker = tracker ?? new ModificationTracker<DocumentModification>(MODIFICATION_LIMIT, getMaxUndoMemory());
    this.#hostBridge = new HostBridge(viewerProvider, this);
    this.#documentKey = generateDatabaseDocumentKey(this.uri);
    this.#documentKey.then(key => DocumentRegistry.set(key, this));
  }

  // Public accessors
  get fileParts() { return getUriParts(this.uri); }
  get hostBridge() { return this.#hostBridge; }
  get documentKey() { return this.#documentKey; }
  /** Monotonic barrier for host operations that span a database reload. */
  get connectionGeneration() { return this.#connectionGeneration; }

  // ============================================================================
  // Event Emitters
  // ============================================================================

  readonly #disposeEmitter = this._register(new vsc.EventEmitter<void>());
  readonly onDidDispose = this.#disposeEmitter.event;

  readonly #contentChangeEmitter = this._register(new vsc.EventEmitter<DocumentContentChange>());
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
    // Consumers must see disposal before the registered emitter itself is
    // disposed by the base class, otherwise their cleanup callbacks never run.
    this.#disposeEmitter.fire();
    super.dispose();
  }

  // ============================================================================
  // Modification Tracking
  // ============================================================================

  /**
   * Record a modification for undo/redo tracking.
   */
  recordModification(modification: DocumentModification): void {
    const tracker = this.#modificationTracker;
    if (modification.undoPolicy === 'barrier') {
      tracker.recordBarrier(modification);
    } else {
      tracker.record(modification);
    }

    // Ensure future stack is cleared so we don't have stale redo actions
    // This is handled by tracker.record, but explicit check in emitter helps

    this.#modificationEmitter.fire({
      label: modification.label,
      undo: async () => {
        const undoneEntry = tracker.stepBack();
        if (!undoneEntry) {
          if (tracker.isUndoBlockedByBarrier) {
            await vsc.window.showWarningMessage(vsc.l10n.t(
              'This oversized cell replacement cannot be undone. Undo cannot cross its history barrier.'
            ));
            return;
          }
          GlobalOutputChannel?.appendLine('[Undo] No entry found in tracker');
          return;
        }
        try {
            await this.databaseOperations.undoModification(undoneEntry);
            this.#contentChangeEmitter.fire({
              modification: undoneEntry,
              modificationDirection: 'undo'
            });
            this.#autoSaveIfNeeded();
        } catch (e) {
            const restoredEntry = tracker.stepForward();
            if (restoredEntry !== undoneEntry) {
                GlobalOutputChannel?.appendLine(
                  '[Undo] Failed to restore tracker position after database undo failed'
                );
            }
            const errorMessage = e instanceof Error ? e.message : String(e);
            GlobalOutputChannel?.appendLine(`[Undo] Failed: ${errorMessage}`);
            vsc.window.showErrorMessage(vsc.l10n.t('Undo failed: {0}', errorMessage));
        }
      },
      redo: async () => {
        const redoneEntry = tracker.stepForward();
        if (!redoneEntry) {
            GlobalOutputChannel?.appendLine('[Redo] No entry found in tracker');
            return;
        }
        try {
            await this.databaseOperations.redoModification(redoneEntry);
            this.#contentChangeEmitter.fire({
              modification: redoneEntry,
              modificationDirection: 'forward'
            });
            this.#autoSaveIfNeeded();
        } catch (e) {
             const restoredEntry = tracker.stepBack();
             if (restoredEntry !== redoneEntry) {
                 GlobalOutputChannel?.appendLine(
                   '[Redo] Failed to restore tracker position after database redo failed'
                 );
             }
             const errorMessage = e instanceof Error ? e.message : String(e);
             GlobalOutputChannel?.appendLine(`[Redo] Failed: ${errorMessage}`);
             vsc.window.showErrorMessage(vsc.l10n.t('Redo failed: {0}', errorMessage));
        }
      }
    });

    this.#autoSaveIfNeeded();
  }

  /**
   * Record a modification from external source.
   */
  recordExternalModification(modification: DocumentModification): void {
    this.recordModification(modification);
    this.#contentChangeEmitter.fire({
      modification,
      modificationDirection: 'forward'
    });
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
    if (cancellation?.isCancellationRequested) {
      throw new vsc.CancellationError();
    }
    await this.ensureWritable();

    // Check if using native engine - changes are already on disk
    const engineKind = await this.databaseOperations.engineKind;
    if (engineKind === 'native') {
      // Native SQLite writes directly to file - no export needed
      // Just ensure WAL is checkpointed for consistency
      try {
        await this.databaseOperations.executeQuery('PRAGMA wal_checkpoint(PASSIVE)');
      } catch (err) {
        // Ignore checkpoint errors - database may not be using WAL mode
        // Log at debug level for troubleshooting if needed
        GlobalOutputChannel?.appendLine(`[WAL checkpoint skipped] ${err instanceof Error ? err.message : String(err)}`);
      }
      await this.#modificationTracker.createCheckpoint();
      return;
    }

    // The WASM serialize + filesystem write can be slow for large databases or
    // remote web filesystems; re-check cancellation before starting that work.
    if (cancellation?.isCancellationRequested) {
      throw new vsc.CancellationError();
    }

    // Export in-memory database to file (WASM engine only)
    // We always do this for WASM, regardless of auto-commit setting, because WASM is in-memory.
    if (this.uri.scheme === 'file') {
        try {
            // Capture the tracker position that matches the database snapshot
            // exported by writeToFile(). If undo, rollback, or history eviction
            // changes the retained timeline while the async filesystem write is
            // pending, the saved bytes no longer match the live tracker state.
            const fileCheckpoint = this.#modificationTracker.getCurrentPosition();
            const fileCheckpointInvalidationRevision =
              this.#modificationTracker.getCheckpointInvalidationRevision();
            await this.databaseOperations.writeToFile(this.uri.fsPath);
            if (
              this.#modificationTracker.getCheckpointInvalidationRevision() ===
              fileCheckpointInvalidationRevision
            ) {
              this.#modificationTracker.createCheckpointAt(fileCheckpoint);
            }
            return;
        } catch (e) {
            // Fallback if direct write fails
            this.viewerProvider.outputChannel?.appendLine(`[Fallback] Direct write failed, falling back to buffer transfer: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    const { filename } = this.fileParts;
    const binaryContent = await this.databaseOperations.serializeDatabase();
    // Capture the tracker position immediately after serialization. The bytes
    // below represent edits up to this position only; edits recorded while the
    // asynchronous workspace write is pending must remain dirty.
    const serializedCheckpoint = this.#modificationTracker.getCurrentPosition();
    const serializedCheckpointInvalidationRevision =
      this.#modificationTracker.getCheckpointInvalidationRevision();
    try {
      await vsc.workspace.fs.writeFile(this.uri, binaryContent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to save database: ${message}`);
    }
    // Only mark the tracker clean after bytes are persisted. If a web filesystem
    // rejects writeFile, the edit history remains uncommitted for backup/retry.
    // The saved checkpoint is limited to the serialized snapshot so concurrent
    // edits are not acknowledged before their bytes reach storage.
    //
    // If undo/rollback/eviction changed the retained timeline while writeFile
    // was pending, the serialized bytes no longer match the live in-memory
    // state. In that case leave the document dirty so the next save serializes
    // the current state instead of clamping the checkpoint onto a shorter
    // timeline.
    if (
      this.#modificationTracker.getCheckpointInvalidationRevision() ===
      serializedCheckpointInvalidationRevision
    ) {
      this.#modificationTracker.createCheckpointAt(serializedCheckpoint);
    }
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
             this.viewerProvider.outputChannel?.appendLine(`[Fallback] Direct write failed, falling back to buffer transfer: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    const fileStat = await vsc.workspace.fs.stat(this.uri);
    if (fileStat.size > this.getFileSizeLimit()) {
      throw new Error(vsc.l10n.t('Database too large for copy operation'));
    }

    const { filename } = this.fileParts;
    const binaryContent = await this.databaseOperations.serializeDatabase();
    await vsc.workspace.fs.writeFile(targetUri, binaryContent);
  }

  /**
   * Revert to last saved state.
   */
  async revert(cancellation: vsc.CancellationToken): Promise<void> {
    await this.ensureWritable();
    if (this.#modificationTracker.hasUncommittedHistoryBarrier) {
      const message = vsc.l10n.t(
        'The prior value was not retained for an oversized-cell replacement. ' +
        'File Revert cannot cross that edit; save the database first to establish a new baseline.'
      );
      await vsc.window.showWarningMessage(message);
      throw new Error('File Revert cannot cross an unsaved oversized-cell history barrier');
    }
    let invalidatedByRecoveryReload = false;
    try {
      await revertDatabaseToSaved(
        this.databaseOperations,
        this.#modificationTracker,
        cancelTokenToAbortSignal(cancellation)
      );
    } catch (error) {
      if (!isInvocationTimeoutError(error)) throw error;

      // The worker may still be mutating after a host-side timeout. Queue a
      // fresh connection behind it and only reconcile history after the active
      // database has been reopened, preventing the tracker from describing an
      // unknown intermediate database state.
      GlobalOutputChannel?.appendLine(
        `[Revert recovery] ${error.message}; the document state may be inconsistent. Reloading from disk.`
      );
      try {
        const engineKind = await this.databaseOperations.engineKind;
        if (engineKind === 'native') {
          // Native requests are processed serially by the txiki worker. Reopening
          // through the same bundle therefore waits behind the timed-out mutation
          // and gives this document a fresh handle to its post-mortem disk state.
          // Do not clean the tracker until that reconnect barrier has completed.
          this.#connectionGeneration++;
          await this.#reconnectFromDisk();
          this.#contentChangeEmitter.fire({ invalidateAllViewDocuments: true });
        } else {
          await this.reloadFromDisk();
        }
        this.#modificationTracker.rollbackToCheckpoint();
        invalidatedByRecoveryReload = true;
      } catch (reloadError) {
        const details = reloadError instanceof Error ? reloadError.message : String(reloadError);
        throw new Error(
          `File Revert timed out and the document state may be inconsistent. Automatic reload failed: ${details}`,
          { cause: error }
        );
      }
    }
    if (!invalidatedByRecoveryReload) {
      this.#contentChangeEmitter.fire({ invalidateAllViewDocuments: true });
    }
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
    } catch (err) {
      // Record auto-save failures in the output channel for debugging instead of showing a UI error
      const errorMessage = err instanceof Error ? err.message : String(err);
      GlobalOutputChannel?.appendLine(`[Auto-save failed] ${errorMessage}`);
    }
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
    // Advance before the first await. Host mutations that already captured this
    // document must not finish a preliminary read and then dispatch their write
    // into the replacement worker endpoint.
    this.#connectionGeneration++;
    const currentOps = this.databaseOperations;
    let reloadedOps = currentOps;

    if ((await currentOps.engineKind) === 'wasm') {
      reloadedOps = await this.#reconnectFromDisk();
    }

    // File Revert and sidebar Reload both replace the database's externally
    // observable contents. Invalidate every open virtual view definition so
    // VS Code re-reads its SQL and mtime from the active engine.
    this.#contentChangeEmitter.fire({ invalidateAllViewDocuments: true });
    return reloadedOps;
  }

  /** Replace the active engine handle with a newly opened connection to this file. */
  async #reconnectFromDisk(): Promise<DatabaseOperations> {
    const filename = this.fileParts.filename;
    const result = await this.establishConnection(
      this.uri,
      filename,
      this.#forceReadOnlyOnReconnect,
      this.autoCommitEnabled
    );
    const databaseOps = withSqlLogging(
      result.databaseOps,
      filename,
      this.viewerProvider.outputChannel
    );
    this.connectionState = {
      databaseOps,
      isReadOnly: this.#forceReadOnlyOnReconnect || !!result.isReadOnly
    };
    return databaseOps;
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
        } catch (err) {
          // Ignore errors during backup deletion (e.g. file already deleted)
          GlobalOutputChannel?.appendLine(`[Backup deletion failed] ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };
  }
}
