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

/**
 * Cross-platform Worker constructor.
 * Browser: Web Worker API
 * Node.js: worker_threads.Worker
 */
export const Worker: typeof globalThis.Worker = isBrowserRuntime
  ? globalThis.Worker
  : require('worker_threads').Worker;

/**
 * Cross-platform MessageChannel for bidirectional communication.
 * Browser: Web MessageChannel API
 * Node.js: worker_threads.MessageChannel
 */
export const MessageChannel: typeof globalThis.MessageChannel = isBrowserRuntime
  ? globalThis.MessageChannel
  : require('worker_threads').MessageChannel;

/**
 * Cross-platform MessagePort for message passing.
 * Browser: Web MessagePort API
 * Node.js: worker_threads.MessagePort
 */
export const MessagePort: typeof globalThis.MessagePort = isBrowserRuntime
  ? globalThis.MessagePort
  : require('worker_threads').MessagePort;

/**
 * Cross-platform BroadcastChannel for pub/sub messaging.
 * Browser: Web BroadcastChannel API
 * Node.js: worker_threads.BroadcastChannel
 */
export const BroadcastChannel: typeof globalThis.BroadcastChannel = isBrowserRuntime
  ? globalThis.BroadcastChannel
  : require('worker_threads').BroadcastChannel;

/**
 * Reference to the parent context for worker-side communication.
 * Browser: globalThis (messages go to/from spawning window)
 * Node.js: worker_threads.parentPort
 */
export const parentPort: BrowserMessagePort | NodeMessagePort = isBrowserRuntime
  ? globalThis
  : require('worker_threads').parentPort;
