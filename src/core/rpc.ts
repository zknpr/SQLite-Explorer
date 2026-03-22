/**
 * Inter-Process Communication Module
 *
 * Provides bidirectional message passing between execution contexts.
 * Implements a request-response protocol over postMessage.
 *
 * Architecture:
 * - Extension Host <-> Worker Thread
 * - Extension Host <-> Webview Panel
 */

// ============================================================================
// Message Protocol Types
// ============================================================================

/**
 * Unique identifier for tracking message exchanges.
 */
export type MessageCorrelationId = string;

/**
 * Outgoing invocation request.
 */
interface InvocationEnvelope {
  readonly kind: 'invoke';
  readonly correlationId: MessageCorrelationId;
  readonly methodName: string;
  readonly parameters: unknown[];
}

/**
 * Incoming response to a prior invocation.
 */
interface ResponseEnvelope {
  readonly kind: 'result';
  readonly correlationId: MessageCorrelationId;
  readonly payload?: unknown;
  readonly errorText?: string;
}

/**
 * Log message forwarded from worker to host.
 */
interface LogEnvelope {
  readonly kind: 'log';
  readonly level: 'log' | 'warn' | 'error';
  readonly args: unknown[];
}

/**
 * Union of all protocol message types.
 */
type ProtocolEnvelope = InvocationEnvelope | ResponseEnvelope | LogEnvelope;

// ============================================================================
// State Management
// ============================================================================

/**
 * Counter for generating unique correlation IDs.
 */
let correlationCounter = 0;

/**
 * Generate a unique correlation ID for message tracking.
 */
function generateCorrelationId(): MessageCorrelationId {
  const timestamp = Date.now().toString(36);
  const sequence = (++correlationCounter).toString(36);
  return `ipc_${timestamp}_${sequence}`;
}

/**
 * Pending invocations awaiting responses.
 */
export interface PendingInvocation {
  readonly onComplete: (value: unknown) => void;
  readonly onFault: (error: Error) => void;
  readonly expirationTimer: ReturnType<typeof setTimeout>;
}

/**
 * Default timeout for remote invocations (60 seconds to accommodate large blob operations).
 */
const INVOCATION_TIMEOUT_MS = 60000;

// ============================================================================
// Proxy Factory
// ============================================================================

/**
 * Wrapper to explicitly mark data for transfer (zero-copy)
 */
export class Transfer<T> {
  constructor(public readonly value: T, public readonly transferables: Transferable[]) {}
}

/**
 * Dispatcher function type for sending messages.
 */
type MessageDispatcher = (envelope: ProtocolEnvelope, transfer?: Transferable[]) => void;

/**
 * A proxy object that includes the pending invocations map for response routing.
 */
export type ProxyWithPendingInvocations<T> = T & {
  __pendingInvocations: Map<MessageCorrelationId, PendingInvocation>;
};

/**
 * Build a proxy object that forwards method calls to a remote context.
 *
 * Each method on the proxy returns a Promise that resolves when the
 * remote handler sends a response.
 *
 * @param dispatcher - Function to send messages to remote context
 * @param methodNames - List of method names to expose on proxy
 * @param timeoutMs - Timeout for each invocation (default 30s)
 * @returns Proxy object with specified methods
 */
export function buildMethodProxy<T extends object>(
  dispatcher: MessageDispatcher,
  methodNames: string[],
  timeoutMs: number = INVOCATION_TIMEOUT_MS
): ProxyWithPendingInvocations<T> {
  // Each proxy gets its own isolated pending invocations map to prevent
  // cross-connection correlation ID collisions when multiple workers are active.
  const pendingInvocations = new Map<MessageCorrelationId, PendingInvocation>();
  const proxyObject: Record<string, (...args: unknown[]) => Promise<unknown>> = {};

  /**
   * Recursively extract Transfer wrappers from a value.
   * Returns the unwrapped value and collects transferables into the provided array.
   */
  const extractTransferables = (value: unknown, transferList: Transferable[]): unknown => {
    // Handle Transfer wrapper
    if (value instanceof Transfer) {
      if (value.transferables) {
        transferList.push(...value.transferables);
      }
      return value.value;
    }
    // Recursively handle arrays
    if (Array.isArray(value)) {
      return value.map(item => extractTransferables(item, transferList));
    }
    // Recursively handle plain objects
    if (value && typeof value === 'object' && Object.prototype.toString.call(value) === '[object Object]') {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>)) {
        result[key] = extractTransferables((value as Record<string, unknown>)[key], transferList);
      }
      return result;
    }
    // Return primitives and other types as-is
    return value;
  };

  for (const methodName of methodNames) {
    proxyObject[methodName] = (...parameters: unknown[]) => {
      return new Promise((resolve, reject) => {
        const correlationId = generateCorrelationId();

        // Handle Transfer wrappers (including nested ones)
        const transferList: Transferable[] = [];
        const cleanParameters = parameters.map(p => extractTransferables(p, transferList));

        // Set up expiration timer
        const expirationTimer = setTimeout(() => {
          if (pendingInvocations.has(correlationId)) {
            pendingInvocations.delete(correlationId);
            reject(new Error(`Invocation timeout: ${methodName}`));
          }
        }, timeoutMs);

        // Register pending invocation
        pendingInvocations.set(correlationId, {
          onComplete: resolve,
          onFault: reject,
          expirationTimer
        });

        // Dispatch the invocation
        dispatcher({
          kind: 'invoke',
          correlationId,
          methodName,
          parameters: cleanParameters
        }, transferList);
      });
    };
  }

  // Expose the pending invocations map so processProtocolMessage can resolve responses
  // for this specific proxy instance (avoids cross-connection collisions).
  // Non-enumerable to prevent leaking in Object.keys(), JSON.stringify(), or logging.
  Object.defineProperty(proxyObject, '__pendingInvocations', {
    value: pendingInvocations,
    enumerable: false,
    configurable: false,
    writable: false
  });

  return proxyObject as ProxyWithPendingInvocations<T>;
}

// ============================================================================
// Message Processing
// ============================================================================

/**
 * Handler map type for local method implementations.
 */
type MethodImplementations = Record<string, (...args: any[]) => unknown>;

/**
 * Response dispatcher type.
 */
type ResponseDispatcher = (response: ResponseEnvelope, transfer?: Transferable[]) => void;

/**
 * Callback for handling log messages forwarded from a worker.
 */
type LogHandler = (level: 'log' | 'warn' | 'error', args: unknown[]) => void;

/**
 * Process an incoming protocol message.
 *
 * For invocation requests: executes local method and sends response.
 * For response messages: resolves pending promise.
 * For log messages: forwards to the provided log handler.
 *
 * @param envelope - Incoming protocol message
 * @param localMethods - Optional local method implementations
 * @param sendResponse - Optional function to send responses
 * @param onLog - Optional callback for worker log messages
 * @param pendingInvocations - Optional per-proxy pending invocations map for response routing
 * @returns true if message was handled, false otherwise
 */
export function processProtocolMessage(
  envelope: unknown,
  localMethods?: MethodImplementations,
  sendResponse?: ResponseDispatcher,
  onLog?: LogHandler,
  pendingInvocations?: Map<MessageCorrelationId, PendingInvocation>
): boolean {
  // Validate envelope structure
  if (!envelope || typeof envelope !== 'object') return false;
  if (!('kind' in envelope)) return false;

  const msg = envelope as ProtocolEnvelope;

  // Handle incoming invocation request
  if (msg.kind === 'invoke' && localMethods && sendResponse) {
    const { correlationId, methodName, parameters } = msg;

    // SECURITY: Validate method name to prevent prototype pollution attacks.
    // An attacker could try to invoke 'constructor', '__proto__', 'toString', etc.
    // We only allow methods that exist directly on the localMethods object,
    // not inherited from Object.prototype.
    if (!Object.prototype.hasOwnProperty.call(localMethods, methodName)) {
      sendResponse({
        kind: 'result',
        correlationId,
        errorText: `Unknown method: ${methodName}`
      });
      return true;
    }

    const implementation = localMethods[methodName];
    if (typeof implementation !== 'function') {
      sendResponse({
        kind: 'result',
        correlationId,
        errorText: `Unknown method: ${methodName}`
      });
      return true;
    }

    // Execute method and send response
    Promise.resolve()
      .then(() => implementation.apply(localMethods, parameters))
      .then(result => {
        // Handle zero-copy Transfer wrapper in return value
        let payload = result;
        let transferables: Transferable[] | undefined;

        if (result instanceof Transfer) {
          payload = result.value;
          transferables = result.transferables;
        }

        sendResponse({
          kind: 'result',
          correlationId,
          payload
        }, transferables);
      })
      .catch(err => {
        sendResponse({
          kind: 'result',
          correlationId,
          errorText: err instanceof Error ? err.message : String(err)
        });
      });

    return true;
  }

  // Handle log message forwarded from worker
  if (msg.kind === 'log' && 'level' in msg && 'args' in msg) {
    const logMsg = msg as LogEnvelope;
    if (onLog) {
      onLog(logMsg.level, logMsg.args);
    }
    return true;
  }

  // Handle incoming response — look up in the provided pending map
  if (msg.kind === 'result' && pendingInvocations) {
    const { correlationId, payload, errorText } = msg;
    const pending = pendingInvocations.get(correlationId);

    if (pending) {
      clearTimeout(pending.expirationTimer);
      pendingInvocations.delete(correlationId);

      if (errorText) {
        pending.onFault(new Error(errorText));
      } else {
        pending.onComplete(payload);
      }
    }

    return true;
  }

  return false;
}

// ============================================================================
// Worker Thread Helpers
// ============================================================================

/**
 * Worker-like interface for message passing.
 */
interface WorkerPort {
  postMessage(data: unknown, transfer?: Transferable[]): void;
  on(event: 'message', handler: (data: unknown) => void): void;
}

/**
 * Create a method proxy for communicating with a worker thread.
 *
 * @param port - Worker port for message passing
 * @param methodNames - Methods to expose on proxy
 * @returns Proxy object for calling worker methods
 */
export function connectWorkerPort<T extends object>(
  port: WorkerPort,
  methodNames: string[],
  onLog?: LogHandler
): T {
  const dispatcher: MessageDispatcher = (envelope, transfer) => {
    // Check if port supports transfer list (Browser/Node worker compatible)
    if (transfer && transfer.length > 0 && typeof port.postMessage === 'function') {
        // Try to pass transfer list
        try {
            port.postMessage(envelope, transfer);
        } catch (e) {
            // Fallback if transfer fails (e.g. not supported in this env)
            console.warn('Transfer failed, falling back to copy', e);
            port.postMessage(envelope);
        }
    } else {
        port.postMessage(envelope);
    }
  };

  const proxy = buildMethodProxy<T>(dispatcher, methodNames);

  // Extract the per-proxy pending invocations map so response messages are routed
  // to the correct proxy instance (each worker gets its own isolated map).
  const proxyPending = proxy.__pendingInvocations;

  port.on('message', (data) => {
    processProtocolMessage(data, undefined, undefined, onLog, proxyPending);
  });

  return proxy;
}
