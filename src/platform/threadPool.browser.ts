/**
 * Browser-specific Worker Thread APIs
 *
 * Used when building for the browser environment (VS Code Web).
 * Maps directly to native Web Standards APIs.
 */

// ============================================================================
// Runtime Detection and API Export
// ============================================================================

/**
 * Cross-platform Worker constructor.
 * Browser: Web Worker API
 */
export const Worker = globalThis.Worker;

/**
 * Cross-platform MessageChannel for bidirectional communication.
 * Browser: Web MessageChannel API
 */
export const MessageChannel = globalThis.MessageChannel;

/**
 * Cross-platform MessagePort for message passing.
 * Browser: Web MessagePort API
 */
export const MessagePort = globalThis.MessagePort;

/**
 * Cross-platform BroadcastChannel for pub/sub messaging.
 * Browser: Web BroadcastChannel API
 */
export const BroadcastChannel = globalThis.BroadcastChannel;

/**
 * Reference to the parent context for worker-side communication.
 * Browser: globalThis (messages go to/from spawning window)
 */
export const parentPort = globalThis;
