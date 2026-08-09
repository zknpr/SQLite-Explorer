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
import type {
  DatabaseConnectionBundle,
  EstablishedDatabaseConnection
} from './connectionTypes';
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

/**
 * Narrow state exposed only through the non-production desktop test API.
 * It observes lifecycle decisions without giving tests an alternate mutation path.
 */
export interface DesktopTestDocumentState {
  referenceCount: number;
  engineKind: 'native' | 'wasm';
  storage: 'native' | 'memory' | 'paged';
  readOnly: boolean;
  dirty: boolean;
  workerDisposeRequested: boolean;
  resolvedEditorCount: number;
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
  // Deliberately configuration-only: the settings modal is a boolean toggle
  // for always/never and cannot represent the remote-only third state.
  return setting === 'always' || (setting === 'remote-only' && IsRemoteWorkspaceMode);
}

/**
 * Get maximum undo memory from configuration.
 */
function getMaxUndoMemory(): number {
  const config = vsc.workspace.getConfiguration(ConfigurationSection);
  return config.get<number>('maxUndoMemory', DEFAULT_MAX_UNDO_MEMORY);
}

/** Refuse materialization when a paged document cannot reach the local streaming writer. */
function pagedNonFilePersistenceError(): Error {
  return new Error(vsc.l10n.t(
    'Page-on-demand databases cannot be saved to non-file providers because they do not offer ' +
    'the required streaming path. Save locally, then copy the file.'
  ));
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
    cancellation?: vsc.CancellationToken,
    knownDocumentKey?: string
  ): Promise<DatabaseDocument> {
    const { reporter, isVerified, context: { extensionUri } } = viewerProvider;
    const configuredForceReadOnly = viewerProvider.forceReadOnly ?? false;
    let forceReadOnlyOnReconnect = configuredForceReadOnly;

    // Use WebAssembly-based worker for database operations
    const connectionFactory = createDatabaseConnection;

    const { filename } = getUriParts(fileUri);
    const documentKey = knownDocumentKey ?? await generateDatabaseDocumentKey(fileUri);
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
    const engineKind = await databaseOps.engineKind;

    if (engineKind === 'native' && !autoCommit) {
      viewerProvider.outputChannel?.appendLine(
        '[Persistence] Native backend active: edits are written to the database file ' +
        'immediately; sqliteExplorer.instantCommit only controls the in-memory WASM backend.'
      );
    }

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
          engineKind,
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
      { databaseOps, isReadOnly, storage: result.storage },
      connectionBundle.workerMethods,
      connectionBundle.establishConnection.bind(connectionBundle),
      reporter,
      forceReadOnlyOnReconnect,
      documentKey
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
  #activeMutations = 0;
  #pagedSaveExclusive = false;
  readonly #mutationDrainWaiters = new Set<() => void>();
  #referenceCount = 1;
  #workerDisposeRequested = false;

  private constructor(
    readonly viewerProvider: DatabaseViewerProvider,
    readonly uri: vsc.Uri,
    tracker: ModificationTracker<DocumentModification> | null,
    public autoCommitEnabled: boolean,
    private connectionState: EstablishedDatabaseConnection,
    private readonly workerMethods: DatabaseConnectionBundle['workerMethods'],
    private readonly establishConnection: DatabaseConnectionBundle['establishConnection'],
    private readonly reporter?: TelemetryReporter,
    forceReadOnlyOnReconnect: boolean = viewerProvider.forceReadOnly ?? false,
    documentKey: string = ''
  ) {
    super();
    this.#forceReadOnlyOnReconnect = forceReadOnlyOnReconnect;
    this.#modificationTracker = tracker ?? new ModificationTracker<DocumentModification>(MODIFICATION_LIMIT, getMaxUndoMemory());
    this.#hostBridge = new HostBridge(viewerProvider, this);
    this.#documentKey = Promise.resolve(documentKey);
    DocumentRegistry.set(documentKey, this);
  }

  // Public accessors
  get fileParts() { return getUriParts(this.uri); }
  get hostBridge() { return this.#hostBridge; }
  get documentKey() { return this.#documentKey; }
  /** Monotonic barrier for host operations that span a database reload. */
  get connectionGeneration() { return this.#connectionGeneration; }

  /**
   * Keep a complete host mutation (backend write plus history/event update)
   * visible to paged save's exclusive barrier. The flag is only raised for a
   * writable paged save, so other storage modes retain their existing behavior.
   */
  async runTrackedMutation<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    if (this.#pagedSaveExclusive) {
      throw new Error(vsc.l10n.t(
        'The document is temporarily read-only while its page-on-demand save is in progress.'
      ));
    }
    this.#activeMutations++;
    try {
      return await operation();
    } finally {
      this.#activeMutations--;
      if (this.#activeMutations === 0) {
        for (const resolve of this.#mutationDrainWaiters) resolve();
        this.#mutationDrainWaiters.clear();
      }
    }
  }

  /** Reject new mutations, then wait until prior writes have updated history. */
  #beginPagedSaveExclusive(): Promise<void> {
    if (this.#pagedSaveExclusive) {
      throw new Error(vsc.l10n.t('A page-on-demand save is already in progress.'));
    }
    this.#pagedSaveExclusive = true;
    this.#connectionGeneration++;
    this.connectionState.isReadOnly = true;
    return (async () => {
      if (this.#activeMutations > 0) {
        await new Promise<void>(resolve => this.#mutationDrainWaiters.add(resolve));
      }
      // A tracked mutation releases only after its history/event work, but this
      // extra turn also drains promise continuations from backend calls that were
      // already resolving as the exclusive flag was raised.
      await Promise.resolve();
      // The worker endpoint serializes writable-paged operations. Its ping is a
      // real worker-side drain even if an earlier host RPC timed out first.
      await this.databaseOperations.ping();
    })();
  }

  #endPagedSaveExclusive(): void {
    this.#pagedSaveExclusive = false;
  }

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

  /** Retain the shared document for another provider-level custom document. */
  retainReference(): void {
    if (this.#referenceCount === 0 || this.isDisposed) {
      throw new Error('Cannot retain a disposed database document');
    }
    this.#referenceCount++;
  }

  async dispose(): Promise<void> {
    if (this.#referenceCount === 0) return;
    this.#referenceCount--;
    if (this.#referenceCount > 0) return;

    const key = await this.#documentKey;
    if (DocumentRegistry.get(key) === this) {
      DocumentRegistry.delete(key);
    }
    this.workerMethods[Symbol.dispose]();
    this.#workerDisposeRequested = true;
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
      undo: () => this.runTrackedMutation(async () => {
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
      }),
      redo: () => this.runTrackedMutation(async () => {
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
      })
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
   * For WASM engine: memory-backed databases serialize to a full image, while
   * writable paged databases use the local streaming writer.
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

    const pagedSave = this.connectionState.storage === 'paged';
    if (pagedSave && this.uri.scheme !== 'file') {
      throw pagedNonFilePersistenceError();
    }

    // Export in-memory database to file (WASM engine only)
    // We always do this for WASM, regardless of auto-commit setting, because WASM is in-memory.
    if (this.uri.scheme === 'file') {
        const priorReadOnlyState = this.connectionState.isReadOnly;
        let baseReplaced = false;
        let pagedExclusiveOwned = false;
        try {
            if (pagedSave) {
              const drain = this.#beginPagedSaveExclusive();
              pagedExclusiveOwned = true;
              await drain;
            }
            // Capture the tracker position that matches the database snapshot
            // exported by writeToFile(). If undo, rollback, or history eviction
            // changes the retained timeline while the async filesystem write is
            // pending, the saved bytes no longer match the live tracker state.
            // Paged saves take this position only after their mutation drain.
            const fileCheckpoint = this.#modificationTracker.getCurrentPosition();
            const fileCheckpointInvalidationRevision =
              this.#modificationTracker.getCheckpointInvalidationRevision();
            await this.databaseOperations.writeToFile(this.uri.fsPath);
            baseReplaced = true;
            if (pagedSave) {
              // The old hostIo still owns a descriptor for the frozen pre-save
              // inode. Reopen before exposing writability so later overlay reads
              // are based on the atomically replaced merged image.
              await this.#reconnectFromDisk();
            }
            if (
              this.#modificationTracker.getCheckpointInvalidationRevision() ===
              fileCheckpointInvalidationRevision
            ) {
              this.#modificationTracker.createCheckpointAt(fileCheckpoint);
            }
            if (pagedExclusiveOwned) {
              this.#endPagedSaveExclusive();
              pagedExclusiveOwned = false;
            }
            return;
        } catch (e) {
            if (pagedSave) {
              if (!baseReplaced) {
                // Export/temporary-write failure leaves the original overlay and
                // base intact, so the user can finish the edit and retry.
                if (pagedExclusiveOwned) {
                  this.#endPagedSaveExclusive();
                  this.connectionState.isReadOnly = priorReadOnlyState;
                }
                throw e;
              }
              // Rename completed but the replacement connection failed. The
              // saved file is durable; fail closed because the old engine still
              // references the pre-rename inode (or was shut down while reopening).
              this.connectionState.isReadOnly = true;
              throw new Error(
                'Database was saved, but its page-on-demand session could not be reopened. '
                + 'Reload the document before making more edits.',
                { cause: e }
              );
            }
            // Fallback if direct write fails
            this.viewerProvider.outputChannel?.appendLine(`[Fallback] Direct write failed, falling back to buffer transfer: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    // Paged documents were refused above unless the local streaming writer
    // handled them. Whole-image materialization remains only for memory-backed
    // WASM saves (including memory-backed non-file providers).
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

    const pagedSaveAs = this.connectionState.storage === 'paged';
    if (pagedSaveAs && targetUri.scheme !== 'file') {
      throw pagedNonFilePersistenceError();
    }

    if (targetUri.scheme === 'file') {
        const priorReadOnlyState = this.connectionState.isReadOnly;
        let baseReplaced = false;
        let pagedExclusiveOwned = false;
        try {
            if (pagedSaveAs) {
              // Freeze and drain for the whole export/write window. This is
              // also required when an alias makes Save As replace the base.
              const drain = this.#beginPagedSaveExclusive();
              pagedExclusiveOwned = true;
              await drain;
            }
            // Use optimized write/vacuum if available
            const result = await this.databaseOperations.writeToFile(targetUri.fsPath);
            baseReplaced = result?.requiresReopen === true;
            if (baseReplaced) {
              await this.#reconnectFromDisk();
            } else if (pagedSaveAs) {
              this.connectionState.isReadOnly = priorReadOnlyState;
            }
            if (pagedExclusiveOwned) {
              this.#endPagedSaveExclusive();
              pagedExclusiveOwned = false;
            }
            return;
        } catch (e) {
             if (pagedSaveAs) {
               if (!baseReplaced) {
                 // No rename of the active base occurred, so the original
                 // overlay remains valid and can be edited/retried.
                 if (pagedExclusiveOwned) {
                   this.#endPagedSaveExclusive();
                   this.connectionState.isReadOnly = priorReadOnlyState;
                 }
                 throw e;
               }
               this.connectionState.isReadOnly = true;
               throw new Error(
                 'Database was saved, but its page-on-demand session could not be reopened. '
                 + 'Reload the document before making more edits.',
                 { cause: e }
               );
             }
             this.viewerProvider.outputChannel?.appendLine(`[Fallback] Direct write failed, falling back to buffer transfer: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    // The paged case cannot reach this full-image fallback. Memory-backed WASM
    // Save As retains the existing materialization behavior for file and
    // non-file targets.
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
    return this.runTrackedMutation(() => this.#revert(cancellation));
  }

  async #revert(cancellation: vsc.CancellationToken): Promise<void> {
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
      // Revert mutates the live engine by replaying retained history; it never
      // serializes a whole database image, including for paged documents.
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

  /** Snapshot for the non-production desktop host-integration API. */
  async getDesktopTestState(): Promise<DesktopTestDocumentState> {
    const engineKind = await this.databaseOperations.engineKind;
    return {
      referenceCount: this.#referenceCount,
      engineKind,
      storage: engineKind === 'native'
        ? 'native'
        : this.connectionState.storage ?? 'memory',
      readOnly: this.isReadOnlyMode,
      dirty: this.#modificationTracker.hasUncommittedChanges(),
      workerDisposeRequested: this.#workerDisposeRequested,
      resolvedEditorCount: Array.from(this.viewerProvider.webviews.get(this.uri)).length
    };
  }

  get cellEditBehavior(): string {
    const config = vsc.workspace.getConfiguration(ConfigurationSection);
    return config.get<string>('doubleClickBehavior', 'inline');
  }

  /**
   * Reload database from disk.
   */
  async reloadFromDisk(): Promise<DatabaseOperations> {
    return this.runTrackedMutation(() => this.#reloadFromDisk());
  }

  async #reloadFromDisk(): Promise<DatabaseOperations> {
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
      isReadOnly: this.#forceReadOnlyOnReconnect || !!result.isReadOnly,
      storage: result.storage
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
    // Hot-exit persists only ModificationTracker history. It never copies the
    // database image, so a multi-gigabyte paged base is not materialized here.
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
