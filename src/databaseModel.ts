/**
 * Database Document Model
 *
 * Represents a SQLite database as a VS Code CustomDocument.
 * Handles document lifecycle, modification tracking, and persistence.
 */

import type { TelemetryReporter } from '@vscode/extension-telemetry';
import type { DatabaseViewerProvider } from './editorController';

import * as vsc from 'vscode';

import { ConfigurationSection, FullExtensionId, getMaxUndoMemoryBytes } from './config';
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
import { DatabaseFileSizeLimitError } from './databaseFileSizeLimit';
import { GlobalOutputChannel } from './main';

import { ModificationTracker } from './core/undo-history';
import { reconcileRestoredDatabase, revertDatabaseToSaved } from './core/restore-reconciler';
import { isInvocationTimeoutError } from './core/rpc';
import { type DatabaseConnectionInvalidatedError, isDatabaseConnectionInvalidatedError } from './core/database-connection-invalidated';
import type { LabeledModification, DatabaseOperations } from './core/types';
import { LoggingDatabaseOperations } from './loggingDatabaseOperations';
import {
  captureWorkspaceFileGeneration,
  writeWorkspaceFileAtomically
} from './atomicWorkspaceWrite';

// ============================================================================
// Types
// ============================================================================

/**
 * Modification entry with display label.
 */
export type DocumentModification = LabeledModification;

interface DocumentEdit {
  readonly label: string;
  undo(): void | Promise<void>;
  redo(): void | Promise<void>;
}

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
/** Refuse materialization when a paged document cannot reach the local streaming writer. */
function pagedNonFilePersistenceError(): Error {
  return new Error(vsc.l10n.t(
    'Page-on-demand databases cannot be saved to non-file providers because they do not offer ' +
    'the required streaming path. Save locally, then copy the file.'
  ));
}

function isSaveCancellation(error: unknown): boolean {
  // VS Code's RPC revives errors without their original class prototype.
  return error instanceof vsc.CancellationError
    || (error instanceof Error && error.name === 'Canceled' && error.message === 'Canceled');
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

type DatabaseConnectionFactory = () => Promise<DatabaseConnectionBundle>;

interface OpenedDocumentConnection {
  connectionState: EstablishedDatabaseConnection;
  workerMethods: DatabaseConnectionBundle['workerMethods'];
  tracker: ModificationTracker<DocumentModification> | null;
  autoCommit: boolean;
  forceReadOnlyOnReconnect: boolean;
}

type InitialConnectionFactory = (cancellation?: vsc.CancellationToken) => Promise<OpenedDocumentConnection>;
type DisconnectedDocumentConnection = {
  databaseOps?: undefined;
  isReadOnly: true;
  storage?: undefined;
};

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
    if (cancellation?.isCancellationRequested) throw new vsc.CancellationError();
    const { reporter, context: { extensionUri } } = viewerProvider;
    const documentKey = knownDocumentKey ?? await generateDatabaseDocumentKey(fileUri);
    const connectionFactory: DatabaseConnectionFactory = () => createDatabaseConnection(extensionUri, reporter);
    const initialConnectionFactory: InitialConnectionFactory = async cancellation => {
      if (cancellation?.isCancellationRequested) throw new vsc.CancellationError();
      const bundle = await connectionFactory();
      try {
        const opened = await DatabaseDocument.#initializeConnection(viewerProvider, fileUri, openContext, bundle, cancellation);
        if (cancellation?.isCancellationRequested) throw new vsc.CancellationError();
        return opened;
      } catch (error) {
        try { bundle.workerMethods[Symbol.dispose](); }
        catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Opening the database failed and its worker could not be disposed');
        }
        throw error;
      }
    };
    let opened: OpenedDocumentConnection;
    try {
      opened = await initialConnectionFactory(cancellation);
    } catch (error) {
      if (!(error instanceof DatabaseFileSizeLimitError)) throw error;
      if (cancellation?.isCancellationRequested) throw new vsc.CancellationError();
      // VS Code retains a rejected custom-document creation promise, including
      // after close/reopen. Register a real disconnected document for a settings
      // refusal so Retry can open a fresh worker without changing resource identity.
      return new DatabaseDocument(
        viewerProvider, fileUri, null, isAutoCommitEnabled(), { isReadOnly: true },
        undefined, connectionFactory, reporter, viewerProvider.forceReadOnly ?? false,
        documentKey, { factory: initialConnectionFactory, error }
      );
    }
    return new DatabaseDocument(
      viewerProvider, fileUri, opened.tracker, opened.autoCommit,
      opened.connectionState, opened.workerMethods, connectionFactory, reporter,
      opened.forceReadOnlyOnReconnect, documentKey
    );
  }

  static async #initializeConnection(
    viewerProvider: DatabaseViewerProvider,
    fileUri: vsc.Uri,
    openContext: vsc.CustomDocumentOpenContext,
    connectionBundle: DatabaseConnectionBundle,
    cancellation?: vsc.CancellationToken
  ): Promise<OpenedDocumentConnection> {
    const configuredForceReadOnly = viewerProvider.forceReadOnly ?? false;
    let forceReadOnlyOnReconnect = configuredForceReadOnly;
    const { filename } = getUriParts(fileUri);
    const autoCommit = isAutoCommitEnabled();
    let databaseOps: DatabaseOperations;
    let result = await connectionBundle.establishConnection(
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
        MODIFICATION_LIMIT,
        getMaxUndoMemoryBytes()
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
        isReadOnly = true;
        // The failed replay may already have applied an earlier history run.
        // Reopen the checkpoint bytes before exposing any query surface so a
        // read-only document never displays a half-restored synthetic state.
        forceReadOnlyOnReconnect = true;
        let recoveryError: unknown;
        let recoveryFailed = false;
        try {
          result = await connectionBundle.establishConnection(
            fileUri,
            filename,
            true,
            autoCommit
          );
          databaseOps = withSqlLogging(
            result.databaseOps,
            filename,
            viewerProvider.outputChannel
          );
        } catch (error) {
          recoveryFailed = true;
          recoveryError = error;
        }
        await vsc.window.showErrorMessage(
          vsc.l10n.t('[{0}] occurred while applying unsaved changes', errorMsg),
          {
            modal: true,
            detail: !recoveryFailed
              ? vsc.l10n.t(
                  'The document was restored from backup, but changes could not be applied. '
                  + 'The saved database was reopened in read-only mode.'
                )
              : vsc.l10n.t(
                  'The document was restored from backup, but changes could not be applied. '
                  + 'Reopening the saved database also failed: {0}',
                  recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
                )
          }
        );
        if (recoveryFailed) throw recoveryError;
      }
    }

    return {
      tracker,
      autoCommit,
      connectionState: { databaseOps, isReadOnly, storage: result.storage, onDidInvalidate: result.onDidInvalidate },
      workerMethods: connectionBundle.workerMethods,
      forceReadOnlyOnReconnect
    };
  }

  /** Get configured max file size */
  getFileSizeLimit(): number {
    return getMaximumFileSizeBytes();
  }

  // Private state
  #modificationTracker: ModificationTracker<DocumentModification>;
  #historyGeneration = 0;
  #hasPublishedHistory = false;
  #acknowledgingReloadedCheckpoint = false;
  readonly #hostBridge: HostBridge;
  #forceReadOnlyOnReconnect: boolean;
  #initialConnectionFactory: InitialConnectionFactory | undefined;
  #initialOpenError: Error | undefined;
  #connectionGeneration = 0;
  #connectionInvalidatedError: DatabaseConnectionInvalidatedError | undefined;
  #connectionInvalidationListener: vsc.Disposable | undefined;
  #activeMutations = 0;
  #activePersistenceOperations = 0;
  /** Serializes history admission through post-backend recording. */
  #historyMutationTail: Promise<void> = Promise.resolve();
  #pagedSaveExclusive = false;
  #pagedSaveRecoveryRequired = false;
  #connectionExclusiveOperation: 'Reload' | 'File Revert' | 'Save As' | undefined;
  readonly #mutationDrainWaiters = new Set<() => void>();
  readonly #reloadDrainWaiters = new Set<() => void>();
  #referenceCount = 1;
  #workerDisposeRequested = false;
  readonly #restoredEditEvents = new WeakMap<DocumentModification, DocumentEdit>();

  private constructor(
    readonly viewerProvider: DatabaseViewerProvider,
    readonly uri: vsc.Uri,
    tracker: ModificationTracker<DocumentModification> | null,
    public autoCommitEnabled: boolean,
    private connectionState: EstablishedDatabaseConnection | DisconnectedDocumentConnection,
    private workerMethods: DatabaseConnectionBundle['workerMethods'] | undefined,
    private readonly connectionFactory: DatabaseConnectionFactory,
    private readonly reporter?: TelemetryReporter,
    forceReadOnlyOnReconnect: boolean = viewerProvider.forceReadOnly ?? false,
    documentKey: string = '',
    initialOpen?: { factory: InitialConnectionFactory; error: Error }
  ) {
    super();
    this.#forceReadOnlyOnReconnect = forceReadOnlyOnReconnect;
    this.#initialConnectionFactory = initialOpen?.factory;
    this.#initialOpenError = initialOpen?.error;
    this.#modificationTracker = tracker ?? new ModificationTracker<DocumentModification>(
      MODIFICATION_LIMIT,
      getMaxUndoMemoryBytes()
    );
    if (tracker && !connectionState.isReadOnly) {
      for (const entry of tracker.getUncommittedEntries()) {
        this.#restoredEditEvents.set(entry, this.#createEditEvent(entry));
      }
    }
    this.#hostBridge = new HostBridge(viewerProvider, this);
    this.#documentKey = Promise.resolve(documentKey);
    if (connectionState.databaseOps) this.#observeConnectionInvalidation(connectionState);
    DocumentRegistry.set(documentKey, this);
  }

  #observeConnectionInvalidation(connection: EstablishedDatabaseConnection): void {
    this.#connectionInvalidationListener?.dispose();
    this.#connectionInvalidatedError = undefined;
    this.#connectionInvalidationListener = connection.onDidInvalidate?.(error => {
      if (this.connectionState !== connection || this.#connectionInvalidatedError || this.#workerDisposeRequested) return;
      this.#connectionInvalidatedError = error;
      this.#connectionGeneration++;
      this.connectionState.isReadOnly = true;
      // The retired connection's history cannot safely be replayed or restored
      // through hot exit after its file identity or transaction state was lost.
      this.#resetHistoryToClean();
      this.#contentChangeEmitter.fire({ invalidateAllViewDocuments: true });
    });
  }

  // Public accessors
  get fileParts() { return getUriParts(this.uri); }
  get hostBridge() { return this.#hostBridge; }
  get documentKey() { return this.#documentKey; }
  get undoMemoryLimitBytes() { return this.#modificationTracker.memoryLimitBytes; }
  /** Monotonic barrier for host operations that span a database reload. */
  get connectionGeneration() { return this.#connectionGeneration; }
  get isConnected() { return !!this.connectionState.databaseOps && !this.#workerDisposeRequested; }
  get reloadRequiredReason() { return this.#initialOpenError?.message ?? this.#connectionInvalidatedError?.message; }

  /** Bind provider-created listeners to this document's actual lifetime. */
  registerLifecycleDisposable<T extends vsc.Disposable>(disposable: T): T {
    return this._register(disposable);
  }

  /** Applied recovery edits whose callbacks can be installed in a new editor. */
  getRestoredEditEvents(): readonly DocumentEdit[] {
    if (this.isReadOnlyMode) return [];
    // VS Code exposes neither a restored save-point index nor a way to seed
    // its Redo stack. Publishing saved history would let Undo mark unsaved
    // reversions clean, so only restore the applied suffix after the checkpoint.
    return this.#modificationTracker.getUncommittedEntries().flatMap(entry => {
      const edit = this.#restoredEditEvents.get(entry);
      return edit ? [edit] : [];
    });
  }

  /**
   * Keep a complete host mutation, including its history/event update, visible
   * to connection operations that must replace or snapshot a stable database.
   */
  async runTrackedMutation<T>(
    operation: () => T | PromiseLike<T>,
    recordsHistory: boolean = false
  ): Promise<T> {
    if (this.#initialOpenError) throw this.#initialOpenError;
    if (this.#connectionInvalidatedError) throw this.#connectionInvalidatedError;
    if (this.#pagedSaveExclusive) {
      throw new Error(vsc.l10n.t(
        'The document is temporarily read-only while its page-on-demand save is in progress.'
      ));
    }
    if (this.#connectionExclusiveOperation) {
      throw new Error(vsc.l10n.t(
        this.#connectionExclusiveOperation === 'Reload'
          ? 'The document is temporarily read-only while Reload is in progress.'
          : this.#connectionExclusiveOperation === 'File Revert'
            ? 'The document is temporarily read-only while File Revert is in progress.'
            : 'The document is temporarily read-only while Save As is in progress.'
      ));
    }
    this.#activeMutations++;
    let waitForHistoryMutation: Promise<void> | undefined;
    let releaseHistoryMutation: (() => void) | undefined;
    if (recordsHistory) {
      // Keep admission, backend mutation, and history recording in one ordered
      // lifecycle. Otherwise two concurrent edits can both pass the last slot;
      // the loser would mutate SQLite before recordEntry observes saturation.
      waitForHistoryMutation = this.#historyMutationTail;
      this.#historyMutationTail = new Promise<void>(resolve => {
        releaseHistoryMutation = resolve;
      });
    }
    try {
      if (waitForHistoryMutation) {
        await waitForHistoryMutation;
        if (this.#connectionInvalidatedError) throw this.#connectionInvalidatedError;
        this.#modificationTracker.ensureCanRecord();
      }
      return await operation();
    } finally {
      releaseHistoryMutation?.();
      this.#activeMutations--;
      if (this.#activeMutations === 0) {
        for (const resolve of this.#mutationDrainWaiters) resolve();
        this.#mutationDrainWaiters.clear();
        this.#resolveReloadDrainIfIdle();
      }
    }
  }

  /** Keep Save/Save As from crossing a connection replacement in either direction. */
  #beginPersistenceOperation(): void {
    if (this.#initialOpenError) throw this.#initialOpenError;
    if (this.#connectionInvalidatedError) throw this.#connectionInvalidatedError;
    if (this.#connectionExclusiveOperation) {
      throw new Error(vsc.l10n.t(
        this.#connectionExclusiveOperation === 'Reload'
          ? 'The document is temporarily read-only while Reload is in progress.'
          : this.#connectionExclusiveOperation === 'File Revert'
            ? 'The document is temporarily read-only while File Revert is in progress.'
            : 'The document is temporarily read-only while Save As is in progress.'
      ));
    }
    this.#activePersistenceOperations++;
  }

  #endPersistenceOperation(): void {
    this.#activePersistenceOperations--;
    this.#resolveReloadDrainIfIdle();
  }

  #resolveReloadDrainIfIdle(): void {
    if (this.#activeMutations !== 0 || this.#activePersistenceOperations !== 0) return;
    for (const resolve of this.#reloadDrainWaiters) resolve();
    this.#reloadDrainWaiters.clear();
  }

  /** Reject new mutations, then wait until prior writes have updated history. */
  #beginPagedSaveExclusive(): Promise<void> {
    if (this.#pagedSaveExclusive) {
      throw new Error(vsc.l10n.t('A page-on-demand save is already in progress.'));
    }
    this.#pagedSaveExclusive = true;
    return (async () => {
      if (this.#activeMutations > 0) {
        await new Promise<void>(resolve => this.#mutationDrainWaiters.add(resolve));
      }
      // A tracked mutation releases only after its history/event work, but this
      // extra turn also drains promise continuations from backend calls that were
      // already resolving as the exclusive flag was raised.
      await Promise.resolve();
      // Only a connection replacement invalidates the post-RPC generation
      // checks captured by an earlier tracked mutation. Advancing this before
      // the drain makes a successful backend write look like a failed reload
      // and drops its history entry even though the save persists the edit.
      this.#connectionGeneration++;
      this.connectionState.isReadOnly = true;
      // The worker endpoint serializes writable-paged operations. Its ping is a
      // real worker-side drain even if an earlier host RPC timed out first.
      await this.databaseOperations.ping();
    })();
  }

  #endPagedSaveExclusive(): void {
    this.#pagedSaveExclusive = false;
    this.#pagedSaveRecoveryRequired = false;
  }

  /** Reject new work and drain admitted mutations/persistence before Reload. */
  #beginReloadExclusive(
    operation: 'Reload' | 'File Revert' | 'Save As' = 'Reload'
  ): Promise<void> | undefined {
    if (this.#pagedSaveExclusive) {
      throw new Error(vsc.l10n.t(
        'The document is temporarily read-only while its page-on-demand save is in progress.'
      ));
    }
    if (this.#connectionExclusiveOperation) {
      throw new Error(vsc.l10n.t(
        this.#connectionExclusiveOperation === 'Reload'
          ? 'A Reload operation is already in progress.'
          : this.#connectionExclusiveOperation === 'File Revert'
            ? 'A File Revert operation is already in progress.'
            : 'A Save As operation is already in progress.'
      ));
    }
    this.#connectionExclusiveOperation = operation;
    if (this.#activeMutations === 0 && this.#activePersistenceOperations === 0) {
      return undefined;
    }
    return new Promise<void>(resolve => this.#reloadDrainWaiters.add(resolve));
  }

  #endReloadExclusive(): void {
    this.#connectionExclusiveOperation = undefined;
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
    this.#workerDisposeRequested = true;
    this.#connectionInvalidationListener?.dispose();
    this.#connectionInvalidationListener = undefined;
    this.workerMethods?.[Symbol.dispose]();
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
    if (this.#initialOpenError) throw this.#initialOpenError;
    if (this.#connectionInvalidatedError) throw this.#connectionInvalidatedError;
    const tracker = this.#modificationTracker;
    const historyWasBlocked = tracker.isHistoryRecordingBlockedByBarrierLimit;
    if (modification.undoPolicy === 'barrier') {
      tracker.recordBarrier(modification);
    } else {
      tracker.record(modification);
    }

    this.#modificationEmitter.fire(this.#createEditEvent(modification));

    if (
      !historyWasBlocked
      && tracker.isHistoryRecordingBlockedByBarrierLimit
    ) {
      const message = vsc.l10n.t(
        'Undo history reached its configured limit after a forward-only edit. ' +
        'Current changes remain dirty and protected for recovery, but further edits are blocked. ' +
        'Save the database before making more changes.'
      );
      try {
        void Promise.resolve(vsc.window.showWarningMessage(message)).catch(error => {
          GlobalOutputChannel?.appendLine(
            `[Undo history warning failed] ${error instanceof Error ? error.message : String(error)}`
          );
        });
      } catch (error) {
        GlobalOutputChannel?.appendLine(
          `[Undo history warning failed] ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    this.#autoSaveIfNeeded();
  }

  #createEditEvent(modification: DocumentModification): DocumentEdit {
    const tracker = this.#modificationTracker;
    const historyGeneration = this.#historyGeneration;
    this.#hasPublishedHistory = true;
    // VS Code keeps one custom-document model per viewType. When two viewTypes
    // share this DatabaseDocument, both models receive this event and retain
    // distinct host edit IDs whose callbacks point at this one logical edit.
    // Keep those callbacks synchronized so consuming the duplicate host entry
    // cannot advance the shared tracker to an unrelated modification.
    let editState: 'applied' | 'undoing' | 'undone' | 'redoing' = 'applied';

    return {
      label: modification.label,
      undo: () => this.#runHistoryCallback(historyGeneration, async () => {
        if (editState !== 'applied') return;
        editState = 'undoing';

        const undoneEntry = tracker.stepBack();
        if (!undoneEntry) {
          editState = 'applied';
          if (tracker.isUndoBlockedByBarrier) {
            const blocked = tracker.undoBlockingEntry;
            await vsc.window.showWarningMessage(vsc.l10n.t(
              blocked?.undoBarrierKind === 'persistent_pragma'
                ? 'Persistent PRAGMA changes cannot be undone reliably. Use File Revert or Reload to restore the saved database.'
                : 'This oversized cell replacement cannot be undone. Undo cannot cross its history barrier.'
            ));
            return;
          }
          GlobalOutputChannel?.appendLine('[Undo] No entry found in tracker');
          return;
        }
        if (undoneEntry !== modification) {
          const restoredEntry = tracker.stepForward();
          editState = 'applied';
          if (restoredEntry !== undoneEntry) {
            GlobalOutputChannel?.appendLine(
              '[Undo] Failed to restore tracker after an out-of-order custom-editor callback'
            );
          }
          GlobalOutputChannel?.appendLine(
            `[Undo] Ignored out-of-order custom-editor callback for ${modification.label}`
          );
          return;
        }
        try {
            await this.databaseOperations.undoModification(undoneEntry);
            editState = 'undone';
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
            editState = 'applied';
            const errorMessage = e instanceof Error ? e.message : String(e);
            GlobalOutputChannel?.appendLine(`[Undo] Failed: ${errorMessage}`);
            vsc.window.showErrorMessage(vsc.l10n.t('Undo failed: {0}', errorMessage));
            // A fulfilled callback tells VS Code that its edit was undone and
            // can clear the dirty marker, even though SQLite rolled it back.
            throw e;
        }
      }),
      redo: () => this.#runHistoryCallback(historyGeneration, async () => {
        if (editState !== 'undone') return;
        editState = 'redoing';

        const redoneEntry = tracker.stepForward();
        if (!redoneEntry) {
            editState = 'undone';
            GlobalOutputChannel?.appendLine('[Redo] No entry found in tracker');
            return;
        }
        if (redoneEntry !== modification) {
            const restoredEntry = tracker.stepBack();
            editState = 'undone';
            if (restoredEntry !== redoneEntry) {
                GlobalOutputChannel?.appendLine(
                  '[Redo] Failed to restore tracker after an out-of-order custom-editor callback'
                );
            }
            GlobalOutputChannel?.appendLine(
              `[Redo] Ignored out-of-order custom-editor callback for ${modification.label}`
            );
            return;
        }
        try {
            await this.databaseOperations.redoModification(redoneEntry);
            editState = 'applied';
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
             editState = 'undone';
             const errorMessage = e instanceof Error ? e.message : String(e);
             GlobalOutputChannel?.appendLine(`[Redo] Failed: ${errorMessage}`);
             vsc.window.showErrorMessage(vsc.l10n.t('Redo failed: {0}', errorMessage));
             throw e;
        }
      })
    };
  }

  #runHistoryCallback(generation: number, operation: () => Promise<void>): Promise<void> {
    return generation === this.#historyGeneration
      ? this.runTrackedMutation(operation)
      : this.#acknowledgeObsoleteHostEdit();
  }

  #resetHistoryToClean(): void {
    this.#modificationTracker.resetToCleanState();
    this.#historyGeneration++;
  }

  async #acknowledgeObsoleteHostEdit(): Promise<void> {
    if (this.#initialOpenError) throw this.#initialOpenError;
    if (this.#connectionInvalidatedError) throw this.#connectionInvalidatedError;
    const drain = this.#beginReloadExclusive();
    try {
      if (drain) await drain;
      // VS Code moves its undo cursor before invoking our callback. Old host
      // entries survive a connection reload, but cannot describe or save any
      // new edits. Only acknowledge a still-clean replacement checkpoint.
      if (!this.#modificationTracker.hasUncommittedChanges()) {
        await this.#acknowledgeReloadedHostCheckpoint();
      }
    } finally {
      this.#endReloadExclusive();
    }
  }

  async #acknowledgeReloadedHostCheckpoint(): Promise<void> {
    if (!this.#hasPublishedHistory) return;
    // The custom-editor API has no mark-clean/reset-history event. A scoped
    // Save can acknowledge bytes already loaded from disk, without rewriting
    // them. Keep the connection barrier raised for the entire host round trip;
    // no new mutation may become part of this no-write acknowledgement.
    this.#acknowledgingReloadedCheckpoint = true;
    try {
      if (!await vsc.workspace.save(this.uri)) {
        throw new Error(vsc.l10n.t(
          'The database was reloaded, but VS Code could not acknowledge its saved checkpoint. Close and reopen this database editor.'
        ));
      }
      this.#saveRequestGeneration++;
      this.#savePending = false;
      this.#autoSaveFailureNotified = false;
    } finally {
      this.#acknowledgingReloadedCheckpoint = false;
    }
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
    if (this.#initialOpenError) throw this.#initialOpenError;
    if (this.#connectionInvalidatedError) throw this.#connectionInvalidatedError;
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
    if (this.#acknowledgingReloadedCheckpoint) {
      if (cancellation?.isCancellationRequested) throw new vsc.CancellationError();
      if (this.#connectionInvalidatedError) throw this.#connectionInvalidatedError;
      if (!this.#connectionExclusiveOperation || this.#activeMutations !== 0
        || this.#activePersistenceOperations !== 0 || this.#modificationTracker.hasUncommittedChanges()) {
        throw new Error('The reloaded checkpoint changed before VS Code could acknowledge it');
      }
      return;
    }
    this.#beginPersistenceOperation();
    const requestGeneration = this.#saveRequestGeneration;
    try {
      await this.#save(cancellation);
      // Manual Save bypasses triggerSave. A completed current checkpoint also
      // clears its cancelled auto-save retry, but cannot clear a newer request.
      if (requestGeneration === this.#saveRequestGeneration
        && !this.#modificationTracker.hasUncommittedChanges()) {
        this.#savePending = false;
        this.#autoSaveFailureNotified = false;
      }
    } finally {
      this.#endPersistenceOperation();
    }
  }

  async #save(cancellation?: vsc.CancellationToken): Promise<void> {
    if (cancellation?.isCancellationRequested) {
      throw new vsc.CancellationError();
    }
    const saveSignal = cancelTokenToAbortSignal(cancellation);
    await this.ensureWritable();

    // Check if using native engine - changes are already on disk
    const engineKind = await this.databaseOperations.engineKind;
    if (engineKind === 'native') {
      await this.#historyMutationTail;
      // Native SQLite writes directly to file - no export needed
      // Just ensure WAL is checkpointed for consistency
      try {
        await this.databaseOperations.executeQuery('PRAGMA wal_checkpoint(PASSIVE)');
      } catch (err) {
        if (isDatabaseConnectionInvalidatedError(err)) throw err;
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
              saveSignal?.throwIfAborted();
            }
            // Capture the tracker position that matches the database snapshot
            // exported by writeToFile(). If undo, rollback, or history eviction
            // changes the retained timeline while the async filesystem write is
            // pending, the saved bytes no longer match the live tracker state.
            // Paged saves take this position only after their mutation drain.
            // Memory saves also wait for admitted edits to record their history.
            // Keep checkpoint capture and backend snapshot admission contiguous.
            await this.#historyMutationTail;
            const fileCheckpoint = this.#modificationTracker.getCurrentPosition();
            const fileCheckpointInvalidationRevision =
              this.#modificationTracker.getCheckpointInvalidationRevision();
            await this.databaseOperations.writeToFile(
              this.uri.fsPath,
              saveSignal
            );
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
                if (saveSignal?.aborted && e === saveSignal.reason) {
                  throw new vsc.CancellationError();
                }
                throw e;
              }
              // Rename completed but the replacement connection failed. The
              // saved file is durable; fail closed because the old engine still
              // references the pre-rename inode (or was shut down while reopening).
              this.connectionState.isReadOnly = true;
              this.#pagedSaveRecoveryRequired = true;
              throw new Error(
                'Database was saved, but its page-on-demand session could not be reopened. '
                + 'Reload the document before making more edits.',
                { cause: e }
              );
            }
            if (saveSignal?.aborted && e === saveSignal.reason) {
              throw new vsc.CancellationError();
            }
            throw new Error(
              `Failed to save database atomically: ${e instanceof Error ? e.message : String(e)}`,
              { cause: e }
            );
        }
    }

    // Local writers must complete through their sibling-temp atomic path; a
    // failed direct snapshot is never retried by truncating the destination.
    // Whole-image transfer remains only for non-file workspace providers.
    const destinationGeneration = await captureWorkspaceFileGeneration(this.uri);
    saveSignal?.throwIfAborted();
    // Pair history with snapshot admission; later edits must remain dirty.
    await this.#historyMutationTail;
    const serializedCheckpoint = this.#modificationTracker.getCurrentPosition();
    const serializedCheckpointInvalidationRevision =
      this.#modificationTracker.getCheckpointInvalidationRevision();
    const binaryContent = await this.databaseOperations.serializeDatabase(saveSignal);
    saveSignal?.throwIfAborted();
    try {
      await writeWorkspaceFileAtomically(
        this.uri,
        binaryContent,
        destinationGeneration,
        saveSignal
      );
    } catch (err) {
      if (saveSignal?.aborted && err === saveSignal.reason) {
        throw new vsc.CancellationError();
      }
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
    this.#beginPersistenceOperation();
    try {
      await this.#saveAs(targetUri, cancellation);
    } finally {
      this.#endPersistenceOperation();
    }
  }

  /** Keep an already-open destination authoritative across another document's Save As. */
  async replaceFromSaveAs(write: () => Promise<void>, cancellation: vsc.CancellationToken): Promise<void> {
    if (cancellation?.isCancellationRequested) throw new vsc.CancellationError();
    this.retainReference();
    let exclusiveOwned = false;
    let workerRetired = false;
    let written = false;
    try {
      const drain = this.#beginReloadExclusive('Save As');
      exclusiveOwned = true;
      if (drain) await drain;
      await this.ensureWritable();
      if (cancellation?.isCancellationRequested) throw new vsc.CancellationError();
      if (await this.databaseOperations.engineKind === 'wasm'
        && this.#modificationTracker.hasUncommittedChanges()) {
        throw new Error(vsc.l10n.t(
          'Cannot replace {0}: it has unsaved changes. Save or revert that database before using Save As to replace it.',
          this.fileParts.filename
        ));
      }
      await this.databaseOperations.ping();
      if (cancellation?.isCancellationRequested) throw new vsc.CancellationError();
      this.#connectionGeneration++;
      this.connectionState.isReadOnly = true;
      this.#connectionInvalidationListener?.dispose();
      this.#connectionInvalidationListener = undefined;
      // Windows also requires the destination's existing SQLite handle to be
      // closed before replacement. The barrier keeps its clients from writing
      // while the source owns the snapshot/rename, and its URI stays unchanged.
      workerRetired = true;
      this.workerMethods?.[Symbol.dispose]();
      await write();
      written = true;
      this.#resetHistoryToClean();
      try {
        await this.#reconnectFromDisk(false);
      } catch (error) {
        throw new Error(vsc.l10n.t(
          'The database was saved, but the destination could not be reopened. Use Reload Database before editing it.'
        ), { cause: error });
      }
      workerRetired = false;
      await this.#acknowledgeReloadedHostCheckpoint();
      this.#contentChangeEmitter.fire({ invalidateAllViewDocuments: true });
    } catch (error) {
      if (workerRetired && !written) {
        try {
          await this.#reconnectFromDisk(false);
          this.#contentChangeEmitter.fire({ invalidateAllViewDocuments: true });
        } catch (recoveryError) {
          throw new AggregateError([error, recoveryError], vsc.l10n.t(
            'Save As failed and the destination could not be reopened. Use Reload Database before editing it.'
          ));
        }
      }
      throw error;
    } finally {
      if (exclusiveOwned) this.#endReloadExclusive();
      await this.dispose();
    }
  }

  async #saveAs(targetUri: vsc.Uri, cancellation: vsc.CancellationToken): Promise<void> {
    if (cancellation?.isCancellationRequested) {
      throw new vsc.CancellationError();
    }
    const saveSignal = cancelTokenToAbortSignal(cancellation);
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
              saveSignal?.throwIfAborted();
            }
            // Use optimized write/vacuum if available
            const result = await this.databaseOperations.writeToFile(
              targetUri.fsPath,
              saveSignal
            );
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
                 if (saveSignal?.aborted && e === saveSignal.reason) {
                   throw new vsc.CancellationError();
                 }
                 throw e;
               }
               this.connectionState.isReadOnly = true;
               this.#pagedSaveRecoveryRequired = true;
               throw new Error(
                 'Database was saved, but its page-on-demand session could not be reopened. '
                 + 'Reload the document before making more edits.',
                 { cause: e }
               );
             }
             if (saveSignal?.aborted && e === saveSignal.reason) {
               throw new vsc.CancellationError();
             }
             throw new Error(
               `Failed to save database atomically: ${e instanceof Error ? e.message : String(e)}`,
               { cause: e }
             );
        }
    }

    // The paged and local-file cases cannot reach this whole-image path. It is
    // reserved for non-file workspace providers.
    const destinationGeneration = await captureWorkspaceFileGeneration(targetUri);
    saveSignal?.throwIfAborted();
    const binaryContent = await this.databaseOperations.serializeDatabase(saveSignal);
    saveSignal?.throwIfAborted();
    const fileSizeLimit = this.getFileSizeLimit();
    if (fileSizeLimit !== 0 && binaryContent.byteLength > fileSizeLimit) {
      throw new Error(vsc.l10n.t('Database too large for copy operation'));
    }

    try {
      await writeWorkspaceFileAtomically(
        targetUri,
        binaryContent,
        destinationGeneration,
        saveSignal
      );
    } catch (error) {
      if (saveSignal?.aborted && error === saveSignal.reason) {
        throw new vsc.CancellationError();
      }
      throw error;
    }
  }

  /**
   * Revert to last saved state.
   */
  async revert(cancellation: vsc.CancellationToken): Promise<void> {
    const mutationDrain = this.#beginReloadExclusive('File Revert');
    try {
      if (mutationDrain) await mutationDrain;
      await this.#revert(cancellation);
    } finally {
      this.#endReloadExclusive();
    }
  }

  async #revert(cancellation: vsc.CancellationToken): Promise<void> {
    await this.ensureWritable();
    const historyBarriers = this.#modificationTracker.getUncommittedHistoryBarriers();
    if (historyBarriers.some(entry => entry.undoBarrierKind !== 'persistent_pragma')) {
      const message = vsc.l10n.t(
        'The prior value was not retained for an oversized-cell replacement. ' +
        'File Revert cannot cross that edit; save the database first to establish a new baseline.'
      );
      await vsc.window.showWarningMessage(message);
      throw new Error('File Revert cannot cross an unsaved oversized-cell history barrier');
    }
    let invalidatedByRecoveryReload = false;
    try {
      if (historyBarriers.length > 0) {
        // Persistent PRAGMAs are deliberately forward-only: auto_vacuum in
        // particular cannot always be restored by assigning the prior value.
        // File Revert can safely discard the overlay by reopening saved bytes.
        await this.#reloadFromDisk();
        this.#modificationTracker.rollbackToCheckpoint();
        invalidatedByRecoveryReload = true;
      } else {
        // Revert mutates the live engine by replaying retained history; it never
        // serializes a whole database image, including for paged documents.
        await revertDatabaseToSaved(
          this.databaseOperations,
          this.#modificationTracker,
          cancelTokenToAbortSignal(cancellation)
        );
      }
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
          // This recovery already runs inside revert's tracked mutation. Calling
          // the public Reload entry point would wait for its own active mutation
          // forever; use the internal replacement operation and retain Revert's
          // existing checkpoint rollback below.
          await this.#reloadFromDisk();
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
  }

  // ============================================================================
  // Auto-save
  // ============================================================================

  #autoSaveFailureNotified = false;

  async #autoSaveIfNeeded(): Promise<void> {
    try {
      if (this.autoCommitEnabled) {
        await this.triggerSave();
      }
    } catch (err) {
      if (isSaveCancellation(err)) {
        // Starting another custom-editor Save cancels the previous host request.
        // Keep unsaved edits retryable; cancellation is not a failed write.
        GlobalOutputChannel?.appendLine('[Auto-save cancelled]');
        return;
      }
      const errorMessage = err instanceof Error ? err.message : String(err);
      GlobalOutputChannel?.appendLine(`[Auto-save failed] ${errorMessage}`);
      if (!this.#autoSaveFailureNotified) {
        // One failed-save episode can contain many edits. Keep its retry state
        // and one visible warning until a current save request actually succeeds.
        this.#autoSaveFailureNotified = true;
        try {
          void Promise.resolve(vsc.window.showErrorMessage(vsc.l10n.t(
            'Auto-save failed for {0}: {1}. Changes remain unsaved. Keep the database editor open and retry Save.',
            this.fileParts.filename,
            errorMessage
          ))).catch(error => {
            GlobalOutputChannel?.appendLine(`[Auto-save notification failed] ${error instanceof Error ? error.message : String(error)}`);
          });
        } catch (error) {
          GlobalOutputChannel?.appendLine(`[Auto-save notification failed] ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  // A document can be shared by panels owned by different editor providers.
  // Track every panel here so an inactive sibling cannot hide an active view.
  readonly #activeViewers = new Set<vsc.WebviewPanel>();

  setViewerActive(viewer: vsc.WebviewPanel, active: boolean): void {
    if (active) {
      this.#activeViewers.add(viewer);
    } else {
      this.#activeViewers.delete(viewer);
    }
  }

  removeViewer(viewer: vsc.WebviewPanel): void {
    this.#activeViewers.delete(viewer);
  }

  #savePending = false;
  #saveRequestGeneration = 0;
  get hasPendingSave(): boolean {
    return this.#savePending;
  }

  async triggerSave(): Promise<void> {
    const requestGeneration = ++this.#saveRequestGeneration;
    this.#savePending = true;
    try {
      // Imports and SQL workspaces can edit a database while a text preview is
      // active. Save its URI through VS Code so the custom-editor save point
      // advances with the database's checkpoint without changing editor focus.
      const saved = await vsc.workspace.save(this.uri);
      if (!saved) {
        throw new Error(vsc.l10n.t(
          'VS Code could not save {0}. Keep the database editor open and retry Save.',
          this.fileParts.filename
        ));
      }
      // A newer request owns the pending state. Its result, not this older
      // request, determines whether another activation must retry the save.
      if (requestGeneration === this.#saveRequestGeneration) {
        this.#savePending = false;
        this.#autoSaveFailureNotified = false;
      }
    } catch (error) {
      if (requestGeneration === this.#saveRequestGeneration) {
        this.#savePending = !isSaveCancellation(error)
          || this.#modificationTracker.hasUncommittedChanges();
      }
      throw error;
    }
  }

  // ============================================================================
  // Database Access
  // ============================================================================

  get databaseOperations(): DatabaseOperations {
    if (!this.connectionState.databaseOps) {
      throw this.#initialOpenError ?? new Error('The database is not connected');
    }
    return this.connectionState.databaseOps;
  }

  get isReadOnlyMode(): boolean {
    return this.connectionState.isReadOnly ?? false;
  }

  /** True only while edits can persist through the page-on-demand overlay. */
  get isPagedWritableMode(): boolean {
    return this.connectionState.storage === 'paged' && !this.isReadOnlyMode;
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
    if (this.#pagedSaveRecoveryRequired) {
      // The atomic rename already committed the saved image. The stale engine
      // cannot be mutated while #pagedSaveExclusive remains raised, so this one
      // disk reopen is safe by construction and is the recovery prescribed by
      // the post-save error. Claim the attempt before awaiting so concurrent
      // Reload requests still hit the ordinary exclusive barrier.
      this.#pagedSaveRecoveryRequired = false;
      try {
        const reloaded = await this.#reloadFromDisk();
        this.#endPagedSaveExclusive();
        return reloaded;
      } catch (error) {
        this.#pagedSaveRecoveryRequired = true;
        throw error;
      }
    }

    // Reload is a destructive connection operation, not an ordinary mutation.
    // Claim exclusivity synchronously, then wait for every already-admitted
    // backend write to finish its history/event bookkeeping before deciding
    // whether there is anything to discard.
    const mutationDrain = this.#beginReloadExclusive();
    try {
      if (mutationDrain) await mutationDrain;
      if (this.#initialConnectionFactory) return await this.#retryInitialConnection();
      if (this.#modificationTracker.hasUncommittedChanges()) {
        const answer = await vsc.window.showWarningMessage(
          vsc.l10n.t(
            'Reloading from disk clears the current undo/redo history. ' +
            'Changes not present in the database file will be discarded. Continue?'
          ),
          { modal: true },
          { title: vsc.l10n.t('Reload from Disk'), value: true },
          { title: vsc.l10n.t('Cancel'), value: false, isCloseAffordance: true }
        );
        if (!answer?.value) throw new vsc.CancellationError();
      }

      const reloaded = await this.#reloadFromDisk();
      this.#resetHistoryToClean();
      await this.#acknowledgeReloadedHostCheckpoint();
      return reloaded;
    } finally {
      this.#endReloadExclusive();
    }
  }

  async #reloadFromDisk(): Promise<DatabaseOperations> {
    // Advance before the first await. Host mutations that already captured this
    // document must not finish a preliminary read and then dispatch their write
    // into the replacement worker endpoint.
    this.#connectionGeneration++;
    const currentOps = this.databaseOperations;
    await currentOps.engineKind;

    // Native SQLite retains an open descriptor. An external atomic rename leaves
    // that handle attached to the old inode just as surely as a WASM database
    // retains its old in-memory image, so both engines must reopen here.
    const reloadedOps = await this.#reconnectFromDisk();

    // File Revert and sidebar Reload both replace the database's externally
    // observable contents. Invalidate every open virtual view definition so
    // VS Code re-reads its SQL and mtime from the active engine.
    this.#contentChangeEmitter.fire({ invalidateAllViewDocuments: true });
    return reloadedOps;
  }

  async #retryInitialConnection(): Promise<DatabaseOperations> {
    const factory = this.#initialConnectionFactory;
    if (!factory) throw new Error('The database has no pending initial connection');
    this.#connectionGeneration++;
    let opened: OpenedDocumentConnection;
    try {
      opened = await factory();
    } catch (error) {
      this.#initialOpenError = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
    if (this.#workerDisposeRequested || this.#referenceCount === 0) {
      const error = new Error('Database document was disposed while opening its connection');
      try { opened.workerMethods[Symbol.dispose](); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'The document was disposed and its new worker could not be closed');
      }
      throw error;
    }

    this.connectionState = opened.connectionState;
    this.workerMethods = opened.workerMethods;
    this.autoCommitEnabled = opened.autoCommit;
    this.#forceReadOnlyOnReconnect = opened.forceReadOnlyOnReconnect;
    if (opened.tracker) {
      this.#modificationTracker = opened.tracker;
      if (!opened.connectionState.isReadOnly) {
        for (const entry of opened.tracker.getUncommittedEntries()) {
          this.#restoredEditEvents.set(entry, this.#createEditEvent(entry));
        }
      }
    }
    this.#initialConnectionFactory = undefined;
    this.#initialOpenError = undefined;
    this.#observeConnectionInvalidation(opened.connectionState);
    this.#contentChangeEmitter.fire({ invalidateAllViewDocuments: true });
    return opened.connectionState.databaseOps;
  }

  /** Replace the active engine handle with a newly opened connection to this file. */
  async #reconnectFromDisk(disposePrevious: boolean = true): Promise<DatabaseOperations> {
    const filename = this.fileParts.filename;
    const replacementBundle = await this.connectionFactory();
    let result: EstablishedDatabaseConnection;
    let databaseOps: DatabaseOperations;
    try {
      result = await replacementBundle.establishConnection(
        this.uri,
        filename,
        this.#forceReadOnlyOnReconnect,
        this.autoCommitEnabled
      );
      databaseOps = withSqlLogging(
        result.databaseOps,
        filename,
        this.viewerProvider.outputChannel
      );
    } catch (error) {
      try {
        replacementBundle.workerMethods[Symbol.dispose]();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Opening the replacement database connection failed and its worker could not be disposed'
        );
      }
      throw error;
    }

    if (this.#workerDisposeRequested) {
      const disposedError = new Error('Database document was disposed while reopening its connection');
      try {
        replacementBundle.workerMethods[Symbol.dispose]();
      } catch (cleanupError) {
        throw new AggregateError(
          [disposedError, cleanupError],
          'The document was disposed while reopening and the replacement worker could not be disposed'
        );
      }
      throw disposedError;
    }

    const nextConnectionState: EstablishedDatabaseConnection = {
      databaseOps,
      isReadOnly: this.#forceReadOnlyOnReconnect || !!result.isReadOnly,
      storage: result.storage,
      onDidInvalidate: result.onDidInvalidate
    };

    const previousWorkerMethods = this.workerMethods;
    this.workerMethods = replacementBundle.workerMethods;
    this.connectionState = nextConnectionState;
    this.#observeConnectionInvalidation(nextConnectionState);
    try {
      if (disposePrevious) previousWorkerMethods?.[Symbol.dispose]();
    } catch (error) {
      // The new connection is already authoritative. Failing the Reload now
      // would leave callers believing the old database is still active, so
      // surface cleanup failure diagnostically without rolling back the swap.
      const message = error instanceof Error ? error.message : String(error);
      (this.viewerProvider.outputChannel ?? GlobalOutputChannel)?.appendLine(
        `[Connection cleanup failed] ${message}`
      );
      void vsc.window.showErrorMessage(vsc.l10n.t(
        'The database was reloaded, but its previous worker could not be closed: {0}',
        message
      ));
    }
    return databaseOps;
  }

  // ============================================================================
  // Backup (Hot Exit)
  // ============================================================================

  async backup(
    destination: vsc.Uri,
    cancellation: vsc.CancellationToken
  ): Promise<vsc.CustomDocumentBackup> {
    if (cancellation?.isCancellationRequested) {
      throw new vsc.CancellationError();
    }
    if (this.#initialOpenError) throw this.#initialOpenError;
    if (!this.#connectionInvalidatedError && await this.databaseOperations.engineKind === 'native') {
      try {
        // Backup can be the first activity after an external replacement. Let
        // native identity admission retire that file's history before encoding
        // it, without materializing the database or replaying any edits.
        await this.databaseOperations.ping();
      } catch (error) {
        if (!isDatabaseConnectionInvalidatedError(error) || !this.#connectionInvalidatedError) throw error;
      }
    }
    // Hot-exit persists only ModificationTracker history. It never copies the
    // database image, so a multi-gigabyte paged base is not materialized here.
    const serializedState = this.#modificationTracker.serialize();
    if (cancellation?.isCancellationRequested) {
      throw new vsc.CancellationError();
    }
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
