'use client';

/**
 * Demo Page Client Component
 *
 * Standalone SQLite database viewer that runs entirely in the browser.
 * Users can upload their own .db files or load sample databases.
 *
 * Architecture:
 * - Uses sql.js (SQLite compiled to WebAssembly) running in a Web Worker
 * - Communicates with worker via postMessage/onmessage
 * - Renders the database using an iframe containing the viewer UI
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { Upload, Database, FileUp, ArrowLeft, Download, RefreshCw, AlertCircle } from 'lucide-react';
import { isTrustedViewerMessage } from './messageGuard';
import { DEMO_INLINE_CONTENT_MAX_BYTES } from '../../../src/core/paged-open';
import {
  demoRpcErrorFields,
  demoRpcErrorFromResponse,
  deserializeDemoIframeRequest,
  guardDemoIframeRequest,
  guardDemoIframeResponse,
  guardDemoWorkerRequest,
  guardDemoWorkerResponse
} from './transport';

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
  let envelope: RpcMessage = { channel: 'rpc', content };
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

// ============================================================================
// Sample Databases
// ============================================================================

/**
 * Sample databases available for demo.
 * These are small SQLite databases hosted in the public folder.
 */
const SAMPLE_DATABASES = [
  {
    name: 'Chinook',
    description: 'Music store with albums, artists, tracks',
    url: '/samples/chinook.db',
    size: '1.0 MB'
  },
  {
    name: 'Northwind',
    description: 'Classic business database with orders',
    url: '/samples/northwind.db',
    size: '24.7 MB'
  }
];

const CANCELLATION_PARAMETER_INDEX: Readonly<Record<string, number>> = {
  runQuery: 2,
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
// Demo Page Component
// ============================================================================

export default function DemoClient() {
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

  /**
   * Name of the currently loaded database file.
   */
  const [databaseName, setDatabaseName] = useState<string | null>(null);

  /**
   * Whether the drop zone is currently being hovered over.
   */
  const [isDragOver, setIsDragOver] = useState(false);

  /**
   * Whether the Download button applies to the current database. Only
   * inline-bytes opens retain a binary to re-export; File-handle opens
   * (large or paged databases) have nothing meaningful to download — the
   * original file is already on the user's disk and paged snapshots are
   * read-only.
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

  /**
   * Pending RPC calls waiting for responses.
   */
  const pendingCalls = useRef<Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>>(new Map());

  const activePreviewController = useRef<AbortController | null>(null);

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
   * Whether the worker opened the current database read-only (paged
   * page-on-demand snapshot, or a WAL-marked file routed to the
   * read-only buffer path). Reported to the viewer iframe on
   * `initialize` so its mutation UI disables itself. A ref, not state:
   * it is only read inside the iframe message handler, and the iframe
   * mounts after initialization completes.
   */
  const databaseIsReadOnly = useRef(false);

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
      if (!workerRef.current) {
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

      pendingCalls.current.set(messageId, { resolve, reject });
      workerRef.current.postMessage(message);
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
      if (targetMethod === 'initialize') {
        // Already initialized, just return success. Read-only reflects
        // how the worker actually opened the database (paged snapshots
        // and WAL-gated buffers are read-only).
        postIframeRpcResponse(event.source, viewerOrigin, {
          kind: 'response',
          messageId,
          success: true,
          data: { connected: true, isReadOnly: databaseIsReadOnly.current }
        });
        return;
      }

      if (targetMethod === 'getExtensionSettings') {
        // Return default settings for web mode
        postIframeRpcResponse(event.source, viewerOrigin, {
          kind: 'response',
          messageId,
          success: true,
          data: {
            maxRows: 0,
            defaultPageSize: 5000,
            instantCommit: 'never',
            doubleClickBehavior: 'inline'
          }
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
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = exportResult.filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

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
    // Listen for messages from iframe
    window.addEventListener('message', handleIframeMessage);

    return () => {
      window.removeEventListener('message', handleIframeMessage);

      // Cleanup worker on unmount
      activePreviewController.current?.abort();
      activePreviewController.current = null;
      if (workerRef.current) {
        workerRef.current.terminate();
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
    // Terminate existing worker
    activePreviewController.current?.abort();
    activePreviewController.current = null;
    if (workerRef.current) {
      workerRef.current.terminate();
    }

    // Create new worker (classic worker, not module, to support importScripts)
    const worker = new Worker('/sqlite-viewer/worker.js');
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
            guardDemoWorkerResponse(envelope);
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
      console.error('[Demo] Worker error:', error);
      setStatus('error');
      setErrorMessage('Worker failed to initialize');
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
      ]) as { isReadOnly?: boolean } | undefined;

      databaseBinary.current = source instanceof Uint8Array ? source : null;
      databaseFile.current = source instanceof Uint8Array ? null : source;
      databaseIsReadOnly.current = result?.isReadOnly === true;
      setCanDownload(source instanceof Uint8Array);
      setDatabaseName(filename);
      setStatus('ready');
    } catch (error) {
      console.error('[Demo] Failed to initialize database:', error);
      setStatus('error');
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load database');
    }
  }, [callWorker]);

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

    try {
      const response = await fetch(url);
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
      console.error('[Demo] Failed to load sample:', error);
      setStatus('error');
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load sample database');
    }
  }, [initializeWorker]);

  // -------------------------------------------------------------------------
  // Drag and Drop Handlers
  // -------------------------------------------------------------------------

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      loadDatabaseFile(files[0]);
    }
  }, [loadDatabaseFile]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * Download the current database.
   */
  const handleDownload = useCallback(async () => {
    if (!databaseBinary.current || !databaseName) return;

    try {
      // Get updated database from worker
      const exportedData = await callWorker('exportDatabase', ['main']) as Uint8Array;
      const blob = new Blob([new Uint8Array(exportedData)], { type: 'application/x-sqlite3' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = databaseName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('[Demo] Failed to export database:', error);
    }
  }, [callWorker, databaseName]);

  /**
   * Reload the current database (discard changes). File-handle opens
   * re-read from disk; if the file changed since (Chromium invalidates
   * the snapshot), the re-open fails into the normal error surface.
   */
  const handleReload = useCallback(() => {
    const source = databaseBinary.current ?? databaseFile.current;
    if (source && databaseName) {
      initializeWorker(source, databaseName);
    }
  }, [initializeWorker, databaseName]);

  /**
   * Close the current database and return to upload UI.
   */
  const handleClose = useCallback(() => {
    activePreviewController.current?.abort();
    activePreviewController.current = null;
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    databaseBinary.current = null;
    databaseFile.current = null;
    databaseIsReadOnly.current = false;
    setCanDownload(false);
    setDatabaseName(null);
    setStatus('idle');
    setErrorMessage(null);
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="min-h-screen bg-(--ui-bg) text-(--ui-fg) flex flex-col">
      {/* Header */}
      <header className="border-b border-(--ui-edge) px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <a
            href="/"
            className="flex items-center gap-2 text-(--ui-subtle-fg) hover:text-(--ui-fg) transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="text-sm">Back</span>
          </a>
          <div className="h-6 w-px bg-(--ui-edge)" />
          <div className="flex items-center gap-2">
            <Database className="w-5 h-5 text-(--ui-accent)" />
            <h1 className="text-lg font-semibold">SQLite Explorer Demo</h1>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {status === 'ready' && (
            <>
              <span className="text-sm text-(--ui-subtle-fg)">{databaseName}</span>
              <button
                onClick={handleReload}
                className="p-2 text-(--ui-subtle-fg) hover:text-(--ui-fg) transition-colors"
                title="Reload database"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
              {canDownload && (
                <button
                  onClick={handleDownload}
                  className="p-2 text-(--ui-subtle-fg) hover:text-(--ui-fg) transition-colors"
                  title="Download database"
                >
                  <Download className="w-4 h-4" />
                </button>
              )}
              <button
                onClick={handleClose}
                className="px-3 py-1.5 text-sm bg-(--ui-subtle) hover:opacity-80 rounded-md transition-colors"
              >
                Close
              </button>
            </>
          )}
          <a
            href="https://github.com/zknpr/sqlite-explorer"
            target="_blank"
            rel="noopener noreferrer"
            className="p-2 text-(--ui-subtle-fg) hover:text-(--ui-fg) transition-colors"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
            </svg>
          </a>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex">
        {status === 'idle' && (
          <div className="flex-1 flex flex-col items-center justify-center p-8">
            {/* Upload Zone */}
            <div
              className={`
                relative w-full max-w-xl p-12 border-2 border-dashed rounded-xl
                transition-all duration-200 cursor-pointer
                ${isDragOver
                  ? 'border-(--ui-accent) bg-(--ui-accent)/10'
                  : 'border-(--ui-edge) hover:border-(--ui-subtle-fg) hover:bg-(--ui-subtle)/50'
                }
              `}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => document.getElementById('file-input')?.click()}
            >
              <input
                id="file-input"
                type="file"
                accept=".db,.sqlite,.sqlite3,.db3"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.[0]) {
                    loadDatabaseFile(e.target.files[0]);
                  }
                }}
              />
              <div className="flex flex-col items-center text-center">
                <div className="w-16 h-16 rounded-full bg-(--ui-subtle) flex items-center justify-center mb-4">
                  <Upload className="w-8 h-8 text-(--ui-subtle-fg)" />
                </div>
                <h2 className="text-xl font-semibold mb-2">Drop your SQLite database</h2>
                <p className="text-(--ui-subtle-fg) mb-4">
                  or click to browse (.db, .sqlite, .sqlite3)
                </p>
                <div className="inline-flex items-center gap-2 px-4 py-2 bg-(--ui-accent) text-(--ui-accent-fg) hover:opacity-90 rounded-lg transition-colors">
                  <FileUp className="w-4 h-4" />
                  <span>Choose File</span>
                </div>
              </div>
            </div>

            {/* Sample Databases */}
            <div className="mt-12 w-full max-w-xl">
              <h3 className="text-sm font-medium text-(--ui-subtle-fg) mb-4 uppercase tracking-wide">
                Or try a sample database
              </h3>
              <div className="grid gap-3">
                {SAMPLE_DATABASES.map((db) => (
                  <button
                    key={db.name}
                    onClick={() => loadSampleDatabase(db.url, `${db.name.toLowerCase()}.db`)}
                    className="flex items-center gap-4 p-4 bg-(--ui-subtle) hover:opacity-80 border border-(--ui-edge) hover:border-(--ui-subtle-fg) rounded-lg transition-colors text-left"
                  >
                    <Database className="w-8 h-8 text-(--ui-accent) shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">{db.name}</div>
                      <div className="text-sm text-(--ui-subtle-fg)">{db.description}</div>
                    </div>
                    <div className="text-sm text-(--ui-subtle-fg)">{db.size}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Info Box */}
            <div className="mt-12 max-w-xl text-center text-sm text-(--ui-subtle-fg)">
              <p>
                Your database runs entirely in your browser using WebAssembly.
                No data is sent to any server.
              </p>
            </div>
          </div>
        )}

        {status === 'loading' && (
          <div className="flex-1 flex flex-col items-center justify-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-(--ui-accent) mb-4" />
            <p className="text-(--ui-subtle-fg)">Loading database...</p>
          </div>
        )}

        {status === 'error' && (
          <div className="flex-1 flex flex-col items-center justify-center p-8">
            <div className="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center mb-4">
              <AlertCircle className="w-8 h-8 text-red-500" />
            </div>
            <h2 className="text-xl font-semibold mb-2">Failed to load database</h2>
            <p className="text-(--ui-subtle-fg) mb-6 text-center max-w-md">
              {errorMessage || 'An unknown error occurred'}
            </p>
            <button
              onClick={handleClose}
              className="px-4 py-2 bg-(--ui-subtle) hover:opacity-80 rounded-lg transition-colors"
            >
              Try Again
            </button>
          </div>
        )}

        {status === 'ready' && (
          <iframe
            ref={iframeRef}
            src="/sqlite-viewer/viewer.html"
            className="flex-1 border-0"
            title="SQLite Viewer"
          />
        )}
      </main>
    </div>
  );
}
