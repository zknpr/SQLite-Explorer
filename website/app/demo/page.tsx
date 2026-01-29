/**
 * Web Demo Page
 *
 * Standalone SQLite database viewer that runs entirely in the browser.
 * Users can upload their own .db files or load sample databases.
 *
 * Architecture:
 * - Uses sql.js (SQLite compiled to WebAssembly) running in a Web Worker
 * - Communicates with worker via postMessage/onmessage
 * - Renders the database using an iframe containing the viewer UI
 */

'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Upload, Database, FileUp, ArrowLeft, Download, RefreshCw, AlertCircle } from 'lucide-react';

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
  };
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

// ============================================================================
// Demo Page Component
// ============================================================================

export default function DemoPage() {
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

  /**
   * Message ID counter for RPC calls.
   */
  const messageIdCounter = useRef(0);

  /**
   * Binary content of the loaded database (for download).
   */
  const databaseBinary = useRef<Uint8Array | null>(null);

  // -------------------------------------------------------------------------
  // Worker Communication
  // -------------------------------------------------------------------------

  /**
   * Send an RPC request to the worker and wait for response.
   */
  const callWorker = useCallback((method: string, args: unknown[]): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      if (!workerRef.current) {
        reject(new Error('Worker not initialized'));
        return;
      }

      const messageId = `rpc_${++messageIdCounter.current}_${Date.now()}`;
      pendingCalls.current.set(messageId, { resolve, reject });

      const message: RpcMessage = {
        channel: 'rpc',
        content: {
          kind: 'invoke',
          messageId,
          targetMethod: method,
          payload: args
        }
      };

      workerRef.current.postMessage(message);
    });
  }, []);

  /**
   * Forward RPC calls from iframe to worker and back.
   */
  const handleIframeMessage = useCallback((event: MessageEvent) => {
    // Only handle messages from our iframe
    if (event.source !== iframeRef.current?.contentWindow) return;

    const envelope = event.data;

    // Handle RPC requests from iframe
    if (envelope?.channel === 'rpc' && envelope.content?.kind === 'invoke') {
      const { messageId, targetMethod, payload } = envelope.content;

      // Special handling for extension-specific methods
      if (targetMethod === 'initialize') {
        // Already initialized, just return success
        event.source?.postMessage({
          channel: 'rpc',
          content: {
            kind: 'response',
            messageId,
            success: true,
            data: { isReadOnly: false }
          }
        }, '*' as WindowPostMessageOptions);
        return;
      }

      if (targetMethod === 'getExtensionSettings') {
        // Return default settings for web mode
        event.source?.postMessage({
          channel: 'rpc',
          content: {
            kind: 'response',
            messageId,
            success: true,
            data: {
              maxRows: 0,
              defaultPageSize: 1000,
              instantCommit: 'never',
              doubleClickBehavior: 'inline'
            }
          }
        }, '*' as WindowPostMessageOptions);
        return;
      }

      // Forward all other calls to worker
      callWorker(targetMethod as string, payload as unknown[] || [])
        .then((result) => {
          event.source?.postMessage({
            channel: 'rpc',
            content: {
              kind: 'response',
              messageId,
              success: true,
              data: result
            }
          }, '*' as WindowPostMessageOptions);
        })
        .catch((error) => {
          event.source?.postMessage({
            channel: 'rpc',
            content: {
              kind: 'response',
              messageId,
              success: false,
              errorMessage: error.message
            }
          }, '*' as WindowPostMessageOptions);
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
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, [handleIframeMessage]);

  /**
   * Create and initialize the worker with a database file.
   */
  const initializeWorker = useCallback(async (binary: Uint8Array, filename: string) => {
    // Terminate existing worker
    if (workerRef.current) {
      workerRef.current.terminate();
    }

    // Create new worker (classic worker, not module, to support importScripts)
    const worker = new Worker('/demo/worker.js');
    workerRef.current = worker;

    // Handle worker messages
    worker.onmessage = (event) => {
      const envelope = event.data as RpcMessage;
      if (envelope?.channel === 'rpc' && envelope.content?.kind === 'response') {
        const { messageId, success, data, errorMessage } = envelope.content;
        const pending = pendingCalls.current.get(messageId);
        if (pending) {
          pendingCalls.current.delete(messageId);
          if (success) {
            pending.resolve(data);
          } else {
            pending.reject(new Error(errorMessage || 'RPC failed'));
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
    // The worker loads sql.js WASM from CDN automatically
    try {
      await callWorker('initializeDatabase', [
        filename,
        {
          content: binary
          // wasmBinary is loaded from CDN by the worker
        }
      ]);

      databaseBinary.current = binary;
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
   */
  const loadDatabaseFile = useCallback(async (file: File) => {
    setStatus('loading');
    setErrorMessage(null);

    try {
      const buffer = await file.arrayBuffer();
      const binary = new Uint8Array(buffer);

      // Basic validation: Check SQLite magic header
      const magic = 'SQLite format 3\0';
      const header = new TextDecoder().decode(binary.slice(0, 16));
      if (header !== magic) {
        throw new Error('Not a valid SQLite database file');
      }

      await initializeWorker(binary, file.name);
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
      await initializeWorker(binary, name);
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
   * Reload the current database (discard changes).
   */
  const handleReload = useCallback(() => {
    if (databaseBinary.current && databaseName) {
      initializeWorker(databaseBinary.current, databaseName);
    }
  }, [initializeWorker, databaseName]);

  /**
   * Close the current database and return to upload UI.
   */
  const handleClose = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    databaseBinary.current = null;
    setDatabaseName(null);
    setStatus('idle');
    setErrorMessage(null);
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="min-h-screen bg-neutral-950 text-white flex flex-col">
      {/* Header */}
      <header className="border-b border-neutral-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <a
            href="/"
            className="flex items-center gap-2 text-neutral-400 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="text-sm">Back</span>
          </a>
          <div className="h-6 w-px bg-neutral-700" />
          <div className="flex items-center gap-2">
            <Database className="w-5 h-5 text-blue-400" />
            <h1 className="text-lg font-semibold">SQLite Explorer Demo</h1>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {status === 'ready' && (
            <>
              <span className="text-sm text-neutral-400">{databaseName}</span>
              <button
                onClick={handleReload}
                className="p-2 text-neutral-400 hover:text-white transition-colors"
                title="Reload database"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
              <button
                onClick={handleDownload}
                className="p-2 text-neutral-400 hover:text-white transition-colors"
                title="Download database"
              >
                <Download className="w-4 h-4" />
              </button>
              <button
                onClick={handleClose}
                className="px-3 py-1.5 text-sm bg-neutral-800 hover:bg-neutral-700 rounded-md transition-colors"
              >
                Close
              </button>
            </>
          )}
          <a
            href="https://github.com/nicepkg/sqlite-explorer"
            target="_blank"
            rel="noopener noreferrer"
            className="p-2 text-neutral-400 hover:text-white transition-colors"
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
                  ? 'border-blue-400 bg-blue-400/10'
                  : 'border-neutral-700 hover:border-neutral-500 hover:bg-neutral-900/50'
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
                <div className="w-16 h-16 rounded-full bg-neutral-800 flex items-center justify-center mb-4">
                  <Upload className="w-8 h-8 text-neutral-400" />
                </div>
                <h2 className="text-xl font-semibold mb-2">Drop your SQLite database</h2>
                <p className="text-neutral-400 mb-4">
                  or click to browse (.db, .sqlite, .sqlite3)
                </p>
                <div className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors">
                  <FileUp className="w-4 h-4" />
                  <span>Choose File</span>
                </div>
              </div>
            </div>

            {/* Sample Databases */}
            <div className="mt-12 w-full max-w-xl">
              <h3 className="text-sm font-medium text-neutral-400 mb-4 uppercase tracking-wide">
                Or try a sample database
              </h3>
              <div className="grid gap-3">
                {SAMPLE_DATABASES.map((db) => (
                  <button
                    key={db.name}
                    onClick={() => loadSampleDatabase(db.url, `${db.name.toLowerCase()}.db`)}
                    className="flex items-center gap-4 p-4 bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 hover:border-neutral-700 rounded-lg transition-colors text-left"
                  >
                    <Database className="w-8 h-8 text-blue-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">{db.name}</div>
                      <div className="text-sm text-neutral-400">{db.description}</div>
                    </div>
                    <div className="text-sm text-neutral-500">{db.size}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Info Box */}
            <div className="mt-12 max-w-xl text-center text-sm text-neutral-500">
              <p>
                Your database runs entirely in your browser using WebAssembly.
                No data is sent to any server.
              </p>
            </div>
          </div>
        )}

        {status === 'loading' && (
          <div className="flex-1 flex flex-col items-center justify-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-400 mb-4" />
            <p className="text-neutral-400">Loading database...</p>
          </div>
        )}

        {status === 'error' && (
          <div className="flex-1 flex flex-col items-center justify-center p-8">
            <div className="w-16 h-16 rounded-full bg-red-900/30 flex items-center justify-center mb-4">
              <AlertCircle className="w-8 h-8 text-red-400" />
            </div>
            <h2 className="text-xl font-semibold mb-2">Failed to load database</h2>
            <p className="text-neutral-400 mb-6 text-center max-w-md">
              {errorMessage || 'An unknown error occurred'}
            </p>
            <button
              onClick={handleClose}
              className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 rounded-lg transition-colors"
            >
              Try Again
            </button>
          </div>
        )}

        {status === 'ready' && (
          <iframe
            ref={iframeRef}
            src="/demo/viewer.html"
            className="flex-1 border-0"
            title="SQLite Viewer"
          />
        )}
      </main>
    </div>
  );
}
