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
// Worker Logic
// ============================================================================

/**
 * Send a log message to the host via RPC.
 * Falls back to console if no parent port is available.
 */
function log(port: any, level: 'log' | 'warn' | 'error', ...args: unknown[]) {
  if (port) {
    port.postMessage({ kind: 'log', level, args: args.map((a: any) => a instanceof Error ? a.message : a) });
  } else {
    console[level](...args);
  }
}

/**
 * Sets up the worker message handlers.
 * Extracted as a function to enable unit testing without module loader side effects.
 */
export function setupWorkerMessageHandlers(port: any, endpoint: Record<string, (...args: unknown[]) => unknown>) {
  log(port, 'log', '[DatabaseWorker] Starting...');

  if (port) {
    /**
     * Handle incoming messages from the extension host.
     * Uses the IPC protocol for request/response communication.
     */
    port.on('message', (envelope: unknown) => {
      // Process RPC messages and dispatch to endpoint methods
      const wasHandled = processProtocolMessage(
        envelope,
        endpoint,
        (response, transfer) => {
          port.postMessage(response, transfer);
        }
      );

      // Log unhandled messages for debugging
      if (!wasHandled) {
        const msg = envelope as { kind?: string };
        if (msg?.kind !== 'result') {
          log(port, 'warn', '[DatabaseWorker] Unrecognized message:', msg?.kind);
        }
      }
    });

    /**
     * Handle port errors.
     */
    port.on('error', (err: Error) => {
      log(port, 'error', '[DatabaseWorker] Port error:', err.message);
    });

    log(port, 'log', '[DatabaseWorker] Ready for connections');
  } else {
    console.error('[DatabaseWorker] No parent port - invalid execution context');
  }
}

// ============================================================================
// Worker Initialization
// ============================================================================

// Only execute the wiring if we are actually running inside a worker
// (or if we intentionally bypass this check in the future).
// During unit tests, `parentPort` might be null or undefined depending on the environment,
// but we avoid executing this top-level effect by checking if we are a worker thread.
if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'test') {
  setupWorkerMessageHandlers(parentPort, createWorkerEndpoint() as Record<string, (...args: unknown[]) => unknown>);
} else if (typeof process === 'undefined') {
  // Browser environment worker
  setupWorkerMessageHandlers(parentPort, createWorkerEndpoint() as Record<string, (...args: unknown[]) => unknown>);
}
