/**
 * Database Worker Thread
 *
 * Runs SQLite operations in a separate thread using sql.js WebAssembly.
 * Communicates with the extension host via a message-based protocol.
 */

import { parentPort } from "./platform/threadPool";
import { processProtocolMessage, type LogEnvelope } from "./core/rpc";
import { createWorkerEndpoint } from "./core/sqlite-db";

// ============================================================================
// Worker Initialization
// ============================================================================

/**
 * Send log message to the extension host.
 */
function log(message: string, level: 'info' | 'warn' | 'error' = 'info') {
  if (parentPort) {
    const envelope: LogEnvelope = {
      kind: 'log',
      message,
      level
    };
    parentPort.postMessage(envelope);
  }
}

log('[DatabaseWorker] Starting...');

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
      (response, transfer) => {
        parentPort!.postMessage(response, transfer);
      }
    );

    // Log unhandled messages for debugging
    if (!wasHandled) {
      const msg = envelope as { kind?: string };
      if (msg?.kind !== 'result') {
        log(`[DatabaseWorker] Unrecognized message: ${msg?.kind}`, 'warn');
      }
    }
  });

  /**
   * Handle port errors.
   */
  parentPort.on('error', (err: Error) => {
    log(`[DatabaseWorker] Port error: ${err.message}`, 'error');
  });

  log('[DatabaseWorker] Ready for connections');
} else {
  console.error('[DatabaseWorker] No parent port - invalid execution context');
}
