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

/**
 * Minimal browser worker global scope surface used by the parentPort adapter.
 * DedicatedWorkerGlobalScope provides these DOM APIs for communication with the
 * spawning context.
 */
interface BrowserParentPortScope {
  postMessage(data: unknown, transfer?: Transferable[]): void;
  addEventListener: EventTarget['addEventListener'];
  removeEventListener: EventTarget['removeEventListener'];
}

/**
 * Create a Node-style parentPort facade for browser workers.
 *
 * Node's parentPort.on('message', cb) delivers the message payload directly,
 * while browser worker "message" listeners receive a MessageEvent whose data
 * property contains the payload. The adapter preserves Node-style delivery for
 * message events and forwards other events, such as "error", unchanged.
 */
export function createBrowserParentPort(scope: BrowserParentPortScope): NodeMessagePort {
  // Keyed by handler, then by event name. A single handler may be registered for
  // more than one event (e.g. the same callback for 'message' and 'error'), so a
  // flat handler->wrapped map would let the second registration overwrite the
  // first — leaking the earlier DOM listener and making off() remove the wrong
  // one. The per-event inner map keeps each (handler, event) wrapper distinct.
  const browserListeners = new WeakMap<EventListenerOrEventListenerObject, Map<string, EventListener>>();

  return {
    postMessage: (data: unknown, transfer?: Transferable[]) =>
      transfer ? scope.postMessage(data, transfer) : scope.postMessage(data),
    on: (event: string, handler: EventListenerOrEventListenerObject) => {
      // Node's parentPort.on('message', cb) passes the message DATA directly; the
      // DOM 'message' event wraps it in event.data. For other events (e.g.
      // 'error') pass the event through so consumers can read `.message`.
      const cb = handler as (payload: unknown) => void;
      const wrapped: EventListener = (e: Event) =>
        cb(event === 'message' ? (e as MessageEvent).data : e);
      let byEvent = browserListeners.get(handler);
      if (!byEvent) {
        byEvent = new Map<string, EventListener>();
        browserListeners.set(handler, byEvent);
      }
      byEvent.set(event, wrapped);
      scope.addEventListener(event, wrapped);
    },
    off: (event: string, handler: EventListenerOrEventListenerObject) => {
      const byEvent = browserListeners.get(handler);
      const wrapped = byEvent?.get(event);
      if (wrapped) {
        scope.removeEventListener(event, wrapped);
        byEvent!.delete(event);
        if (byEvent!.size === 0) browserListeners.delete(handler);
      }
    },
  };
}

// ============================================================================
// Runtime Detection and API Export
// ============================================================================

let WorkerImpl: any;
let MessageChannelImpl: any;
let MessagePortImpl: any;
let BroadcastChannelImpl: any;
let parentPortImpl: any;

if (import.meta.env?.VSCODE_BROWSER_EXT) {
  WorkerImpl = globalThis.Worker;
  MessageChannelImpl = globalThis.MessageChannel;
  MessagePortImpl = globalThis.MessagePort;
  BroadcastChannelImpl = globalThis.BroadcastChannel;
  // In a browser Web Worker the global scope (DedicatedWorkerGlobalScope) is the
  // channel to the host, but it exposes addEventListener/postMessage — NOT the
  // Node worker_threads `.on()` API that the worker entry (databaseWorker.ts) is
  // written against. Without this adapter, `parentPort.on('message', ...)` throws
  // `TypeError: parentPort.on is not a function`, so the worker never wires up its
  // message handler and the host's RPC hangs forever (VS Code Web "stuck loading").
  const workerScope = globalThis as unknown as BrowserParentPortScope;
  parentPortImpl = createBrowserParentPort(workerScope);
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
       if (!wt.isMainThread) {
          console.error('[ThreadPool] worker_threads.parentPort is null in a worker thread!');
       }
    }
  } catch (e) {
    console.error('[ThreadPool] Failed to load worker_threads:', e);
   
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
