/**
 * Platform-agnostic Worker Thread APIs
 *
 * Provides unified worker communication primitives that work in both:
 * - Browser environments (VS Code Web): Uses native Web Worker APIs
 * - Node.js environments (VS Code Desktop): Uses Node's worker_threads module
 *
 * This abstraction enables multi-threaded database operations across
 * all VS Code runtime environments without conditional imports.
 */

// ============================================================================
// Type Definitions for Cross-Platform Message Passing
// ============================================================================

/**
 * Minimal event receiver interface for message handling.
 * Matches the common subset of browser EventTarget and Node.js EventEmitter.
 */
type MessageReceiver = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/**
 * Browser-style message port interface.
 * Used for communication in web worker environments.
 */
interface BrowserMessagePort extends MessageReceiver {
  postMessage(data: unknown, transfer?: Transferable[]): void;
}

/**
 * Node.js-style message port interface.
 * Used for communication in Node.js worker_threads.
 */
interface NodeMessagePort {
  postMessage(data: unknown, transfer?: unknown[]): void;
  on(event: string, handler: EventListenerOrEventListenerObject, options?: object): void;
  off(event: string, handler: EventListenerOrEventListenerObject, options?: object): void;
}

// ============================================================================
// Runtime Detection and API Export
// ============================================================================

const isBrowserRuntime = import.meta.env.VSCODE_BROWSER_EXT;

let WorkerImpl: any;
let MessageChannelImpl: any;
let MessagePortImpl: any;
let BroadcastChannelImpl: any;
let parentPortImpl: any;

if (isBrowserRuntime) {
  WorkerImpl = globalThis.Worker;
  MessageChannelImpl = globalThis.MessageChannel;
  MessagePortImpl = globalThis.MessagePort;
  BroadcastChannelImpl = globalThis.BroadcastChannel;
  parentPortImpl = globalThis;
} else {
  // Node.js environment
  try {
    // Explicit string for static analysis if needed, but we rely on build config to externalize it
    const wt = require('worker_threads');

    WorkerImpl = wt.Worker;
    MessageChannelImpl = wt.MessageChannel;
    MessagePortImpl = wt.MessagePort;
    BroadcastChannelImpl = wt.BroadcastChannel;
    parentPortImpl = wt.parentPort;

    if (!parentPortImpl) {
       // In main thread, parentPort is null. In worker thread, it should be defined.
       // We can check isMainThread to be sure.
       if (!wt.isMainThread) {
          console.error('[ThreadPool] worker_threads.parentPort is null in a worker thread!');
       }
    }
  } catch (e) {
    console.error('[ThreadPool] Failed to load worker_threads:', e);
    // Fallback? No, we need worker_threads in Node.
    throw e;
  }
}


/**
 * Cross-platform Worker constructor.
 * Browser: Web Worker API
 * Node.js: worker_threads.Worker
 */
export const Worker = WorkerImpl;

/**
 * Cross-platform MessageChannel for bidirectional communication.
 * Browser: Web MessageChannel API
 * Node.js: worker_threads.MessageChannel
 */
export const MessageChannel = MessageChannelImpl;

/**
 * Cross-platform MessagePort for message passing.
 * Browser: Web MessagePort API
 * Node.js: worker_threads.MessagePort
 */
export const MessagePort = MessagePortImpl;

/**
 * Cross-platform BroadcastChannel for pub/sub messaging.
 * Browser: Web BroadcastChannel API
 * Node.js: worker_threads.BroadcastChannel
 */
export const BroadcastChannel = BroadcastChannelImpl;

/**
 * Reference to the parent context for worker-side communication.
 * Browser: globalThis (messages go to/from spawning window)
 * Node.js: worker_threads.parentPort
 */
export const parentPort = parentPortImpl;
