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
type MessageCorrelationId = string;

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
 * Union of all protocol message types.
 */
type ProtocolEnvelope = InvocationEnvelope | ResponseEnvelope;

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
interface PendingInvocation {
  readonly onComplete: (value: unknown) => void;
  readonly onFault: (error: Error) => void;
  readonly expirationTimer: ReturnType<typeof setTimeout>;
}

const pendingInvocations = new Map<MessageCorrelationId, PendingInvocation>();

/**
 * Default timeout for remote invocations (30 seconds).
 */
const INVOCATION_TIMEOUT_MS = 30000;

// ============================================================================
// Proxy Factory
// ============================================================================

/**
 * Wrapper to explicitly mark data for transfer (zero-copy)
 */
export class Transfer<T> {
  constructor(public readonly value: T, public readonly transferables: any[]) {}
}

/**
 * Dispatcher function type for sending messages.
 */
type MessageDispatcher = (envelope: ProtocolEnvelope, transfer?: any[]) => void;

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
): T {
  const proxyObject: Record<string, (...args: unknown[]) => Promise<unknown>> = {};

  for (const methodName of methodNames) {
    proxyObject[methodName] = (...parameters: unknown[]) => {
      return new Promise((resolve, reject) => {
        const correlationId = generateCorrelationId();

        // Handle Transfer wrappers
        const transferList: any[] = [];
        const cleanParameters = parameters.map(p => {
          if (p instanceof Transfer) {
            if (p.transferables) {
                transferList.push(...p.transferables);
            }
            return p.value;
          }
          return p;
        });

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

  return proxyObject as T;
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
type ResponseDispatcher = (response: ResponseEnvelope) => void;

/**
 * Process an incoming protocol message.
 *
 * For invocation requests: executes local method and sends response.
 * For response messages: resolves pending promise.
 *
 * @param envelope - Incoming protocol message
 * @param localMethods - Optional local method implementations
 * @param sendResponse - Optional function to send responses
 * @returns true if message was handled, false otherwise
 */
export function processProtocolMessage(
  envelope: unknown,
  localMethods?: MethodImplementations,
  sendResponse?: ResponseDispatcher
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
        sendResponse({
          kind: 'result',
          correlationId,
          payload: result
        });
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

  // Handle incoming response
  if (msg.kind === 'result') {
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
  postMessage(data: unknown): void;
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
  methodNames: string[]
): T {
  const dispatcher: MessageDispatcher = (envelope, transfer) => {
    // Check if port supports transfer list (Browser/Node worker compatible)
    if (transfer && transfer.length > 0 && typeof port.postMessage === 'function') {
        // Try to pass transfer list
        try {
            // @ts-ignore - Handle mixed signatures of postMessage
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

  port.on('message', (data) => {
    processProtocolMessage(data);
  });

  return buildMethodProxy<T>(dispatcher, methodNames);
}
