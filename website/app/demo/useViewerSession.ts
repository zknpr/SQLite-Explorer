'use client';

/**
 * Viewer session: one sql.js worker and the viewer iframe that talks to it.
 *
 * The /demo page and the live preview on the landing page both run through
 * this hook, so they share one RPC bridge and one set of transport guards.
 * Each session listens only to its own iframe (isTrustedViewerMessage checks
 * the iframe's WindowProxy and the page origin), so two sessions on one page
 * would not answer each other's viewers.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { isTrustedViewerMessage } from './messageGuard';
import {
  createDemoExtensionSettings,
  updateDemoExtensionSetting
} from './extensionSettings';
import {
  DemoWorkerRetiredError,
  reloadDemoDatabase,
  retireDemoWorker,
  triggerBrowserDownload,
  type PendingWorkerCall
} from './lifecycle';
import { DEMO_INLINE_CONTENT_MAX_BYTES } from '../../../src/core/paged-open';
import type { QueryResultSet } from '../../../src/core/types';
import {
  demoRpcErrorFields,
  demoRpcErrorFromResponse,
  deserializeDemoIframeRequest,
  guardDemoDatabaseExportResponse,
  guardDemoIframeRequest,
  guardDemoIframeResponse,
  guardDemoWorkerRequest,
  guardDemoWorkerResponse,
  isSafeDemoRpcIdentifier,
  serializeDemoIframeResponse
} from './transport';

export const VIEWER_SRC = `${process.env.NEXT_PUBLIC_SQLITE_VIEWER_BASE_PATH}/viewer.html`;

export type ViewerStatus = 'idle' | 'loading' | 'ready' | 'error';

// ============================================================================
// Types
// ============================================================================

/**
 * RPC message format for worker communication.
 * Matches the protocol used by the VS Code extension.
 */
interface RpcMessage {
  channel: 'rpc';
  content: {
    kind: 'invoke' | 'response';
    messageId: string;
    targetMethod?: string;
    payload?: unknown[];
    success?: boolean;
    data?: unknown;
    errorMessage?: string;
    error?: unknown;
  };
}

function postIframeRpcResponse(
  target: MessageEventSource | null,
  targetOrigin: string,
  content: RpcMessage['content']
): void {
  const wireContent = content.data === undefined
    ? content
    : { ...content, data: serializeDemoIframeResponse(content.data) };
  let envelope: RpcMessage = { channel: 'rpc', content: wireContent };
  try {
    guardDemoIframeResponse(envelope);
  } catch (error) {
    envelope = {
      channel: 'rpc',
      content: {
        kind: 'response',
        messageId: content.messageId,
        success: false,
        ...demoRpcErrorFields(error)
      }
    };
    // The replacement is a fixed-shape, scalar error, but keep the same guard
    // invariant at the actual structured-clone boundary.
    guardDemoIframeResponse(envelope);
  }
  target?.postMessage(envelope, { targetOrigin });
}

const CANCELLATION_PARAMETER_INDEX: Readonly<Record<string, number>> = {
  runQuery: 2,
  executeReadQuery: 2,
  previewViewDefinition: 4
};

function createSharedCancellationFlag(signal?: AbortSignal) {
  // Browsers expose SharedArrayBuffer to this page only when cross-origin
  // isolation is active. Otherwise the worker retains its SQLite deadline but
  // cannot observe a host cancellation while synchronous WASM owns the thread.
  if (
    !signal ||
    globalThis.crossOriginIsolated !== true ||
    typeof SharedArrayBuffer !== 'function'
  ) {
    return undefined;
  }

  let flag: Int32Array;
  try {
    flag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  } catch {
    return undefined;
  }

  const markCancelled = () => Atomics.store(flag, 0, 1);
  if (signal.aborted) markCancelled();
  else signal.addEventListener('abort', markCancelled, { once: true });

  return {
    flag,
    dispose: () => signal.removeEventListener('abort', markCancelled)
  };
}

// ============================================================================
// Session Hook
// ============================================================================

export function useViewerSession() {
  const [queryEditorOpen, setQueryEditorOpen] = useState(false);
  const [querySession, setQuerySession] = useState(0);
  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /**
   * Current state of database loading.
   * - 'idle': No database loaded, showing upload UI
   * - 'loading': Database being loaded into worker
   * - 'ready': Database loaded and viewer active
   * - 'error': Failed to load database
   */
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  /**
   * Error message when status is 'error'.
   */
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  /** Download-only failures leave the active editor usable. */
  const [downloadError, setDownloadError] = useState<string | null>(null);

  /** Why the worker forced the current database into read-only mode. */
  const [readOnlyNotice, setReadOnlyNotice] = useState<string | null>(null);

  /**
   * Name of the currently loaded database file.
   */
  const [databaseName, setDatabaseName] = useState<string | null>(null);

  /**
   * Whether the Download button applies to the current database. Every
   * writable worker database can export its current image; read-only paged
   * fallbacks and WAL-gated buffers cannot.
   */
  const [canDownload, setCanDownload] = useState(false);

  // -------------------------------------------------------------------------
  // Refs
  // -------------------------------------------------------------------------

  /**
   * Reference to the Web Worker running sql.js.
   */
  const workerRef = useRef<Worker | null>(null);

  /**
   * Reference to the iframe containing the viewer UI.
   */
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  /** Session-scoped settings supported by the standalone viewer. */
  const extensionSettings = useRef(createDemoExtensionSettings());

  /**
   * Pending RPC calls waiting for responses.
   */
  const pendingCalls = useRef<Map<string, PendingWorkerCall>>(new Map());

  const activePreviewController = useRef<AbortController | null>(null);

  /**
   * Set when the session unmounts. A load still reading its bytes must not
   * create a worker then: no cleanup would retire it.
   */
  const sessionClosed = useRef(false);

  /** The sample download in flight, aborted when the session closes or another sample loads. */
  const sampleDownload = useRef<AbortController | null>(null);

  /** Latest source-bound reload callback used by iframe RPCs. */
  const reloadDatabaseRef = useRef<(() => Promise<unknown>) | null>(null);

  /**
   * Message ID counter for RPC calls.
   */
  const messageIdCounter = useRef(0);

  /**
   * Binary content of the loaded database (for download).
   * Retained only for inline-bytes opens; File-handle opens keep the
   * handle instead (databaseFile) and never duplicate the bytes.
   */
  const databaseBinary = useRef<Uint8Array | null>(null);

  /**
   * File handle of the loaded database when it was posted to the worker
   * as a File (large databases). Used by Reload to re-open from disk.
   */
  const databaseFile = useRef<File | null>(null);

  /**
   * Whether the worker opened the current database read-only (a stale-runtime
   * paged fallback, or a WAL-marked file routed to the
   * read-only buffer path). Reported to the viewer iframe on
   * `initialize` so its mutation UI disables itself. A ref, not state:
   * it is only read inside the iframe message handler, and the iframe
   * mounts after initialization completes.
   */
  const databaseIsReadOnly = useRef(false);

  /** Worker-reported backing mode and original size for paged-save warnings. */
  const databaseStorage = useRef<'memory' | 'paged'>('memory');
  const databaseFileSizeBytes = useRef(0);

  // -------------------------------------------------------------------------
  // Worker Communication
  // -------------------------------------------------------------------------

  /**
   * Send an RPC request to the worker and wait for response.
   */
  const callWorker = useCallback((
    method: string,
    args: unknown[],
    signal?: AbortSignal
  ): Promise<unknown> => {
    signal?.throwIfAborted();
    const sharedCancellation = createSharedCancellationFlag(signal);
    const workerArgs = [...args];
    const cancellationIndex = CANCELLATION_PARAMETER_INDEX[method];
    if (sharedCancellation && cancellationIndex !== undefined) {
      while (workerArgs.length < cancellationIndex) workerArgs.push(undefined);
      workerArgs[cancellationIndex] = sharedCancellation.flag;
    }

    const invocation = new Promise<unknown>((resolve, reject) => {
      const worker = workerRef.current;
      if (!worker) {
        reject(new Error('Worker not initialized'));
        return;
      }

      const messageId = `rpc_${++messageIdCounter.current}_${Date.now()}`;

      const message: RpcMessage = {
        channel: 'rpc',
        content: {
          kind: 'invoke',
          messageId,
          targetMethod: method,
          payload: workerArgs
        }
      };

      try {
        guardDemoWorkerRequest(message);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      pendingCalls.current.set(messageId, { method, resolve, reject });
      try {
        worker.postMessage(message);
      } catch (error) {
        pendingCalls.current.delete(messageId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return invocation.then(
      result => {
        signal?.throwIfAborted();
        return result;
      },
      error => {
        signal?.throwIfAborted();
        throw error;
      }
    ).finally(() => sharedCancellation?.dispose());
  }, []);

  /**
   * Forward RPC calls from iframe to worker and back.
   */
  const handleIframeMessage = useCallback((event: MessageEvent) => {
    // The viewer iframe is same-origin, and an ancestor can navigate it to a
    // foreign document without changing its WindowProxy — so require the
    // browser-verified origin alongside the source identity, and reply only
    // to our own origin, never to event.origin.
    const viewerOrigin = window.location.origin;
    if (!isTrustedViewerMessage(event, iframeRef.current?.contentWindow, viewerOrigin)) return;

    const envelope = event.data;

    if (envelope?.kind === 'sqlite-explorer-ready') {
      event.source?.postMessage(
        { kind: 'sqlite-explorer-origin' },
        { targetOrigin: viewerOrigin }
      );
      return;
    }

    // Handle RPC requests from iframe
    if (envelope?.channel === 'rpc' && envelope.content?.kind === 'invoke') {
      const { messageId, targetMethod, payload } = envelope.content;

      // Invalid IDs cannot be reflected safely in an error response. Drop the
      // request before decoding or invoking any capability.
      if (!isSafeDemoRpcIdentifier(messageId)) return;

      let deserializedPayload: unknown[];
      try {
        guardDemoIframeRequest(envelope);
        const decoded = deserializeDemoIframeRequest(payload ?? []);
        if (!Array.isArray(decoded)) throw new TypeError('RPC payload must be an array');
        deserializedPayload = decoded;
      } catch (error) {
        postIframeRpcResponse(event.source, viewerOrigin, {
          kind: 'response',
          messageId,
          success: false,
          ...demoRpcErrorFields(error)
        });
        return;
      }

      // Special handling for extension-specific methods
      if (targetMethod === 'openQueryEditor') {
        const connected = workerRef.current !== null;
        if (connected) setQueryEditorOpen(true);
        postIframeRpcResponse(event.source, viewerOrigin, {
          kind: 'response',
          messageId,
          success: connected,
          ...(connected ? {} : { errorMessage: 'No database initialized' })
        });
        return;
      }

      if (targetMethod === 'initialize') {
        // Already initialized, just return success. Read-only reflects how
        // the worker actually opened the database (stale-runtime paged
        // fallbacks and WAL-gated buffers are read-only).
        postIframeRpcResponse(event.source, viewerOrigin, {
          kind: 'response',
          messageId,
          success: true,
          data: { connected: true, isReadOnly: databaseIsReadOnly.current }
        });
        return;
      }

      if (targetMethod === 'getExtensionSettings') {
        postIframeRpcResponse(event.source, viewerOrigin, {
          kind: 'response',
          messageId,
          success: true,
          data: extensionSettings.current
        });
        return;
      }

      if (targetMethod === 'updateExtensionSetting') {
        try {
          const [key, value] = deserializedPayload;
          const updated = updateDemoExtensionSetting(
            extensionSettings.current,
            key,
            value
          );
          extensionSettings.current = updated;
          if (key === 'doubleClickBehavior') {
            event.source?.postMessage(
              {
                kind: 'invoke',
                correlationId: `demo-setting-${messageId}`,
                methodName: 'updateCellEditBehavior',
                parameters: [updated.cellEditBehavior]
              },
              { targetOrigin: viewerOrigin }
            );
          }
          postIframeRpcResponse(event.source, viewerOrigin, {
            kind: 'response',
            messageId,
            success: true,
            data: { success: true }
          });
        } catch (error) {
          postIframeRpcResponse(event.source, viewerOrigin, {
            kind: 'response',
            messageId,
            success: false,
            ...demoRpcErrorFields(error)
          });
        }
        return;
      }

      if (targetMethod === 'refreshFile') {
        const reload = reloadDatabaseRef.current;
        if (!reload) {
          postIframeRpcResponse(event.source, viewerOrigin, {
            kind: 'response',
            messageId,
            success: false,
            errorMessage: 'Reload is unavailable because no database source is open'
          });
          return;
        }
        reload()
          .then(() => {
            postIframeRpcResponse(event.source, viewerOrigin, {
              kind: 'response',
              messageId,
              success: true,
              data: { connected: true, isReadOnly: databaseIsReadOnly.current }
            });
          })
          .catch(error => {
            postIframeRpcResponse(event.source, viewerOrigin, {
              kind: 'response',
              messageId,
              success: false,
              ...demoRpcErrorFields(error)
            });
          });
        return;
      }

      // Special handling for exportTable - trigger download after getting result
      if (targetMethod === 'exportTable') {
        callWorker(targetMethod, deserializedPayload)
          .then((result) => {
            const exportResult = result as {
              contentChunks: string[];
              filename: string;
              mimeType: string;
            };
            // This is bounded chunk assembly, not progressive worker streaming.
            const blob = new Blob(exportResult.contentChunks, { type: exportResult.mimeType });
            triggerBrowserDownload(blob, exportResult.filename);

            postIframeRpcResponse(event.source, viewerOrigin, {
              kind: 'response',
              messageId,
              success: true,
              data: { success: true }
            });
          })
          .catch((error) => {
            postIframeRpcResponse(event.source, viewerOrigin, {
              kind: 'response',
              messageId,
              success: false,
              ...demoRpcErrorFields(error)
            });
          });
        return;
      }

      // Forward all other calls to worker
      let previewController: AbortController | undefined;
      if (targetMethod === 'previewViewDefinition') {
        activePreviewController.current?.abort();
        previewController = new AbortController();
        activePreviewController.current = previewController;
      }
      callWorker(
        targetMethod as string,
        deserializedPayload,
        previewController?.signal
      )
        .then((result) => {
          postIframeRpcResponse(event.source, viewerOrigin, {
            kind: 'response',
            messageId,
            success: true,
            data: result
          });
        })
        .catch((error) => {
          postIframeRpcResponse(event.source, viewerOrigin, {
            kind: 'response',
            messageId,
            success: false,
            ...demoRpcErrorFields(error)
          });
        })
        .finally(() => {
          if (activePreviewController.current === previewController) {
            activePreviewController.current = null;
          }
        });
    }
  }, [callWorker]);

  // -------------------------------------------------------------------------
  // Worker Initialization
  // -------------------------------------------------------------------------

  /**
   * Initialize the Web Worker when component mounts.
   */
  useEffect(() => {
    sessionClosed.current = false;
    // Listen for messages from iframe
    window.addEventListener('message', handleIframeMessage);

    return () => {
      sessionClosed.current = true;
      sampleDownload.current?.abort();
      sampleDownload.current = null;
      window.removeEventListener('message', handleIframeMessage);

      // Cleanup worker on unmount
      activePreviewController.current?.abort();
      activePreviewController.current = null;
      const worker = workerRef.current;
      if (worker) {
        retireDemoWorker(
          worker,
          pendingCalls.current,
          new DemoWorkerRetiredError('Database worker was terminated while the demo closed')
        );
        workerRef.current = null;
      }
    };
  }, [handleIframeMessage]);

  /**
   * Create and initialize the worker with a database.
   *
   * `source` is either the full database bytes (small files — today's
   * path) or the File handle itself. A File is structured-cloned to the
   * worker as a handle, not bytes: the worker reads it via
   * FileReaderSync, and databases above the paged threshold open
   * page-on-demand without the page ever holding a copy. Bytes above
   * the worker-request transport guard's binary cap must travel as a
   * File — the guard rejects larger inline Uint8Arrays.
   */
  const initializeWorker = useCallback(async (source: Uint8Array | File, filename: string) => {
    if (sessionClosed.current) {
      throw new DemoWorkerRetiredError('The demo closed before its database loaded');
    }
    setQueryEditorOpen(false);
    setQuerySession(session => session + 1);
    // Terminate existing worker
    activePreviewController.current?.abort();
    activePreviewController.current = null;
    const previousWorker = workerRef.current;
    if (previousWorker) {
      retireDemoWorker(
        previousWorker,
        pendingCalls.current,
        new DemoWorkerRetiredError('Database worker was replaced before its RPC completed')
      );
      if (workerRef.current === previousWorker) workerRef.current = null;
    }

    // Create new worker (classic worker, not module, to support importScripts)
    const worker = new Worker(`${process.env.NEXT_PUBLIC_SQLITE_VIEWER_BASE_PATH}/worker.js`);
    workerRef.current = worker;

    // Handle worker messages
    worker.onmessage = (event) => {
      const envelope = event.data as RpcMessage;
      if (envelope?.channel === 'rpc' && envelope.content?.kind === 'response') {
        const { messageId, success, data } = envelope.content;
        const pending = pendingCalls.current.get(messageId);
        if (pending) {
          pendingCalls.current.delete(messageId);
          try {
            if (pending.method === 'exportDatabase' && success) {
              guardDemoDatabaseExportResponse(envelope);
            } else {
              guardDemoWorkerResponse(envelope);
            }
          } catch (error) {
            pending.reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          if (success) {
            pending.resolve(data);
          } else {
            pending.reject(demoRpcErrorFromResponse(envelope.content));
          }
        }
      }
    };

    worker.onerror = (error) => {
      if (workerRef.current !== worker) return;
      console.error('[Demo] Worker error:', error);
      const failure = new Error(error.message || 'Database worker failed');
      retireDemoWorker(worker, pendingCalls.current, failure);
      workerRef.current = null;
      setStatus('error');
      setErrorMessage(failure.message);
    };

    worker.onmessageerror = () => {
      if (workerRef.current !== worker) return;
      const failure = new Error('Database worker returned an unreadable message');
      retireDemoWorker(worker, pendingCalls.current, failure);
      workerRef.current = null;
      setStatus('error');
      setErrorMessage(failure.message);
    };

    // Wait for worker to be ready, then initialize database
    // The worker resolves the self-hosted sql.js runtime beside worker.js.
    try {
      const result = await callWorker('initializeDatabase', [
        filename,
        source instanceof Uint8Array
          ? { content: source }
          : { file: source }
        // wasmBinary is loaded from the self-hosted runtime by the worker.
      ]) as {
        isReadOnly?: boolean;
        storage?: 'memory' | 'paged';
        readOnlyReason?: string;
      } | undefined;

      databaseBinary.current = source instanceof Uint8Array ? source : null;
      databaseFile.current = source instanceof Uint8Array ? null : source;
      databaseIsReadOnly.current = result?.isReadOnly === true;
      databaseStorage.current = result?.storage === 'paged' ? 'paged' : 'memory';
      databaseFileSizeBytes.current = source instanceof Uint8Array
        ? source.byteLength
        : source.size;
      setCanDownload(!databaseIsReadOnly.current);
      setDownloadError(null);
      setReadOnlyNotice(result?.readOnlyReason ?? null);
      setDatabaseName(filename);
      setStatus('ready');
      return result;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('Failed to load database');
      if (workerRef.current === worker) {
        console.error('[Demo] Failed to initialize database:', failure);
        retireDemoWorker(worker, pendingCalls.current, failure);
        workerRef.current = null;
        setStatus('error');
        setErrorMessage(failure.message);
        setReadOnlyNotice(null);
      }
      throw failure;
    }
  }, [callWorker]);

  useEffect(() => {
    reloadDatabaseRef.current = () => reloadDemoDatabase(
      databaseBinary.current ?? databaseFile.current,
      databaseName,
      initializeWorker
    );
    return () => {
      reloadDatabaseRef.current = null;
    };
  }, [databaseName, initializeWorker]);

  // -------------------------------------------------------------------------
  // File Handling
  // -------------------------------------------------------------------------

  /**
   * Load a database from a File object.
   *
   * Small files keep today's path: read fully on the main thread and
   * post the bytes. Larger files post the File handle itself — the
   * transport guard rejects inline binaries above its cap, and reading
   * a multi-GB file here would hold a full copy (or two) on the main
   * thread that the worker's paged path is designed to avoid.
   */
  const loadDatabaseFile = useCallback(async (file: File) => {
    setStatus('loading');
    setErrorMessage(null);

    try {
      // Basic validation: Check SQLite magic header (first 16 bytes —
      // one small slice; never the whole file).
      const magic = 'SQLite format 3\0';
      const headerBytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      const header = new TextDecoder().decode(headerBytes);
      if (header !== magic) {
        throw new Error('Not a valid SQLite database file');
      }

      if (file.size <= DEMO_INLINE_CONTENT_MAX_BYTES) {
        await initializeWorker(new Uint8Array(await file.arrayBuffer()), file.name);
      } else {
        await initializeWorker(file, file.name);
      }
    } catch (error) {
      if (error instanceof DemoWorkerRetiredError) return;
      console.error('[Demo] Failed to load file:', error);
      setStatus('error');
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load file');
    }
  }, [initializeWorker]);

  /**
   * Load a sample database from URL.
   */
  const loadSampleDatabase = useCallback(async (url: string, name: string) => {
    setStatus('loading');
    setErrorMessage(null);

    sampleDownload.current?.abort();
    const download = new AbortController();
    sampleDownload.current = download;
    try {
      const response = await fetch(url, { signal: download.signal });
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.statusText}`);
      }
      const buffer = await response.arrayBuffer();
      const binary = new Uint8Array(buffer);
      // Samples above the transport guard's inline cap (e.g. Northwind,
      // 24.7 MB) must cross the worker boundary as a File handle like
      // any other large database; inline bytes would be rejected at the
      // RPC guard.
      const source = binary.byteLength <= DEMO_INLINE_CONTENT_MAX_BYTES
        ? binary
        : new File([binary], name, { type: 'application/x-sqlite3' });
      await initializeWorker(source, name);
    } catch (error) {
      if (error instanceof DemoWorkerRetiredError || download.signal.aborted) return;
      console.error('[Demo] Failed to load sample:', error);
      setStatus('error');
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load sample database');
    } finally {
      if (sampleDownload.current === download) sampleDownload.current = null;
    }
  }, [initializeWorker]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * Download the current database.
   */
  const handleDownload = useCallback(async () => {
    if (!workerRef.current || !databaseName || databaseIsReadOnly.current) return;

    if (databaseStorage.current === 'paged') {
      const sizeGiB = (databaseFileSizeBytes.current / (1024 ** 3)).toFixed(2);
      const confirmed = window.confirm(
        `Download the edited ${sizeGiB} GiB database? ` +
        'The page-on-demand write overlay is bounded by changed pages, but ' +
        'saving must materialize the complete merged image in browser memory.'
      );
      if (!confirmed) return;
    }

    try {
      setDownloadError(null);
      // Get updated database from worker
      const exportedData = await callWorker('exportDatabase', ['main']) as Uint8Array;
      // The worker transfers a dedicated export buffer. Avoid a second explicit
      // Uint8Array copy before handing that buffer to the Blob implementation.
      const exportedBuffer = exportedData.byteOffset === 0
        && exportedData.byteLength === exportedData.buffer.byteLength
        && exportedData.buffer instanceof ArrayBuffer
        ? exportedData.buffer
        : exportedData.slice().buffer;
      const blob = new Blob([exportedBuffer], { type: 'application/x-sqlite3' });
      triggerBrowserDownload(blob, databaseName);
    } catch (error) {
      console.error('[Demo] Failed to export database:', error);
      setDownloadError(error instanceof Error ? error.message : 'Failed to download database');
    }
  }, [callWorker, databaseName]);

  /**
   * Reload the current database (discard changes). File-handle opens
   * re-read from disk; if the file changed since (Chromium invalidates
   * the snapshot), the re-open fails into the normal error surface.
   */
  const handleReload = useCallback(() => {
    void reloadDatabaseRef.current?.().catch(error => {
      if (!(error instanceof DemoWorkerRetiredError)) {
        console.error('[Demo] Failed to reload database:', error);
        setStatus('error');
        setErrorMessage(error instanceof Error ? error.message : 'Failed to reload database');
      }
    });
  }, []);

  /**
   * Close the current database and return to upload UI.
   */
  const handleClose = useCallback(() => {
    activePreviewController.current?.abort();
    activePreviewController.current = null;
    const worker = workerRef.current;
    if (worker) {
      retireDemoWorker(
        worker,
        pendingCalls.current,
        new DemoWorkerRetiredError('Database worker was terminated when the database closed')
      );
      workerRef.current = null;
    }
    databaseBinary.current = null;
    databaseFile.current = null;
    databaseIsReadOnly.current = false;
    databaseStorage.current = 'memory';
    databaseFileSizeBytes.current = 0;
    setCanDownload(false);
    setDownloadError(null);
    setReadOnlyNotice(null);
    setDatabaseName(null);
    setStatus('idle');
    setErrorMessage(null);
  }, []);

  const closeQueryEditor = useCallback(() => setQueryEditorOpen(false), []);

  const executeReadQuery = useCallback(
    async (sql: string, parameters: string) =>
      await callWorker('executeReadQuery', [sql, parameters]) as QueryResultSet,
    [callWorker]
  );

  return {
    iframeRef,
    status,
    errorMessage,
    downloadError,
    readOnlyNotice,
    databaseName,
    canDownload,
    queryEditorOpen,
    querySession,
    closeQueryEditor,
    executeReadQuery,
    loadDatabaseFile,
    loadSampleDatabase,
    handleDownload,
    handleReload,
    handleClose
  };
}
