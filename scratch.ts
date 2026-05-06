import { parentPort } from "./platform/threadPool";
import { processProtocolMessage } from "./core/rpc";
import { createWorkerEndpoint } from "./core/sqlite-db";

// ============================================================================
// Worker Logging
// ============================================================================

export function createLogger(port: any | null) {
  return function log(level: 'log' | 'warn' | 'error', ...args: unknown[]) {
    if (port) {
      port.postMessage({ kind: 'log', level, args: args.map((a: any) => a instanceof Error ? a.message : a) });
    } else {
      console[level](...args);
    }
  };
}

// ============================================================================
// Message Handler
// ============================================================================

export function setupWorkerMessageHandlers(port: any | null, endpoint: Record<string, (...args: unknown[]) => unknown>) {
  const log = createLogger(port);
  log('log', '[DatabaseWorker] Starting...');

  if (port) {
    port.on('message', (envelope: unknown) => {
      const wasHandled = processProtocolMessage(
        envelope,
        endpoint,
        (response: unknown, transfer?: any[]) => {
          port.postMessage(response, transfer);
        }
      );

      if (!wasHandled) {
        const msg = envelope as { kind?: string };
        if (msg?.kind !== 'result') {
          log('warn', '[DatabaseWorker] Unrecognized message:', msg?.kind);
        }
      }
    });

    port.on('error', (err: Error) => {
      log('error', '[DatabaseWorker] Port error:', err.message);
    });

    log('log', '[DatabaseWorker] Ready for connections');
  } else {
    console.error('[DatabaseWorker] No parent port - invalid execution context');
  }
}

// ============================================================================
// Worker Initialization
// ============================================================================

// Only auto-initialize if we aren't in a test environment
// Since we don't have a reliable process.env in all worker environments,
// we just run it. The test will import this file but we don't care because
// it will execute with whatever parentPort is globally.
// BUT we want tests to avoid global effects!
