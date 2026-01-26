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
// Worker Initialization
// ============================================================================

console.log('[DatabaseWorker] Starting...');

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
      (response) => {
        parentPort!.postMessage(response);
      }
    );

    // Log unhandled messages for debugging
    if (!wasHandled) {
      const msg = envelope as { kind?: string };
      if (msg?.kind !== 'result') {
        console.warn('[DatabaseWorker] Unrecognized message:', msg?.kind);
      }
    }
  });

  /**
   * Handle port errors.
   */
  parentPort.on('error', (err: Error) => {
    console.error('[DatabaseWorker] Port error:', err.message);
  });

  console.log('[DatabaseWorker] Ready for connections');
} else {
  console.error('[DatabaseWorker] No parent port - invalid execution context');
}
