/**
 * Database Worker Thread
 *
 * Runs SQLite operations in a separate thread using sql.js WebAssembly.
 * Communicates with the extension host via a message-based protocol.
 */

import { parentPort } from "./platform/threadPool";
import { processProtocolMessage } from "./core/rpc";
import { createWorkerEndpoint } from "./core/sqlite-db";

// ============================================================================
// Worker Logging
// ============================================================================

/**
 * Send a log message to the host via RPC.
 * Falls back to console if no parent port is available.
 */
function log(level: 'log' | 'warn' | 'error', ...args: unknown[]) {
  if (parentPort) {
    parentPort.postMessage({ kind: 'log', level, args: args.map(a => a instanceof Error ? a.message : a) }, []);
  } else {
    console[level](...args);
  }
}

// ============================================================================
// Worker Initialization
// ============================================================================

log('log', '[DatabaseWorker] Starting...');

// Create the endpoint that handles database operations
const databaseEndpoint = createWorkerEndpoint();

// ============================================================================
// Message Handler
// ============================================================================

/**
 * The worker exposes these methods to the extension host:
 *
 * - initializeDatabase: Load database from binary content
 * - runQuery: Execute SQL statements
 * - exportDatabase: Serialize database to binary
 */
if (parentPort) {
  /**
   * Handle incoming messages from the extension host.
   * Uses the IPC protocol for request/response communication.
   */
  parentPort.on('message', (envelope: unknown) => {
    // Process RPC messages and dispatch to endpoint methods
    const wasHandled = processProtocolMessage(
      envelope,
      databaseEndpoint as Record<string, (...args: unknown[]) => unknown>,
      (response, transfer?: Transferable[]) => {
        if (transfer) {
          parentPort!.postMessage(response, transfer as any[]);
        } else {
          parentPort!.postMessage(response, []);
        }
      }
    );

    // Log unhandled messages for debugging
    if (!wasHandled) {
      const msg = envelope as { kind?: string };
      if (msg?.kind !== 'result') {
        log('warn', '[DatabaseWorker] Unrecognized message:', msg?.kind);
      }
    }
  });

  /**
   * Handle port errors.
   */
  parentPort.on('error', (err: Error) => {
    log('error', '[DatabaseWorker] Port error:', err.message);
  });

  log('log', '[DatabaseWorker] Ready for connections');
} else {
  console.error('[DatabaseWorker] No parent port - invalid execution context');
}
