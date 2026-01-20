/**
 * Cross-Context Communication Module
 *
 * Provides bidirectional RPC between different execution contexts:
 * - Extension host <-> Web Worker
 * - Extension host <-> Webview
 *
 * Uses a simple request/response protocol over postMessage.
 */

// Message identifier generator
let sequenceNumber = 0;
function nextMessageId(): string {
  return `msg_${++sequenceNumber}_${Date.now().toString(36)}`;
}

// Tracking pending requests
const awaitingResponse = new Map<string, {
  onSuccess: (data: any) => void;
  onError: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}>();

/**
 * Request message structure
 */
interface InvocationRequest {
  kind: 'invoke';
  messageId: string;
  targetMethod: string;
  payload: any[];
}

/**
 * Response message structure
 */
interface InvocationResponse {
  kind: 'response';
  messageId: string;
  success: boolean;
  data?: any;
  errorMessage?: string;
}

type ProtocolMessage = InvocationRequest | InvocationResponse;

/**
 * Default timeout for remote calls (30 seconds)
 */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Build a proxy object that forwards method calls to a remote context.
 */
export function buildRemoteProxy<T extends object>(
  dispatcher: (message: ProtocolMessage) => void,
  methodList: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): T {
  const proxyTarget: any = {};

  for (const methodName of methodList) {
    proxyTarget[methodName] = (...args: any[]) => {
      return new Promise((resolve, reject) => {
        const messageId = nextMessageId();

        const timeoutId = setTimeout(() => {
          if (awaitingResponse.has(messageId)) {
            awaitingResponse.delete(messageId);
            reject(new Error(`Remote call timed out: ${methodName}`));
          }
        }, timeoutMs);

        awaitingResponse.set(messageId, {
          onSuccess: resolve,
          onError: reject,
          timeoutId
        });

        dispatcher({
          kind: 'invoke',
          messageId,
          targetMethod: methodName,
          payload: args
        });
      });
    };
  }

  return proxyTarget as T;
}

/**
 * Process incoming protocol messages.
 * Handles both requests (executes on target) and responses (resolves promises).
 */
export function processIncomingMessage(
  message: ProtocolMessage,
  localTarget?: Record<string, (...args: any[]) => any>,
  responseDispatcher?: (response: InvocationResponse) => void
): boolean {
  if (!message || typeof message !== 'object' || !('kind' in message)) {
    return false;
  }

  // Handle incoming invocation request
  if (message.kind === 'invoke' && localTarget && responseDispatcher) {
    const { messageId, targetMethod, payload } = message;

    const targetFn = localTarget[targetMethod];
    if (typeof targetFn !== 'function') {
      responseDispatcher({
        kind: 'response',
        messageId,
        success: false,
        errorMessage: `Unknown method: ${targetMethod}`
      });
      return true;
    }

    // Execute and send response
    Promise.resolve()
      .then(() => targetFn.apply(localTarget, payload))
      .then(result => {
        responseDispatcher({
          kind: 'response',
          messageId,
          success: true,
          data: result
        });
      })
      .catch(err => {
        responseDispatcher({
          kind: 'response',
          messageId,
          success: false,
          errorMessage: err instanceof Error ? err.message : String(err)
        });
      });

    return true;
  }

  // Handle incoming response
  if (message.kind === 'response') {
    const { messageId, success, data, errorMessage } = message;
    const pending = awaitingResponse.get(messageId);

    if (pending) {
      clearTimeout(pending.timeoutId);
      awaitingResponse.delete(messageId);

      if (success) {
        pending.onSuccess(data);
      } else {
        pending.onError(new Error(errorMessage || 'Remote call failed'));
      }
    }

    return true;
  }

  return false;
}

/**
 * Create communication channel with a Node.js Worker.
 */
export function connectToWorker<T extends object>(
  worker: { postMessage: (data: any) => void; on: (event: string, handler: (data: any) => void) => void },
  methodList: string[]
): T {
  const dispatcher = (msg: ProtocolMessage) => worker.postMessage(msg);

  worker.on('message', (msg: any) => {
    processIncomingMessage(msg);
  });

  return buildRemoteProxy<T>(dispatcher, methodList);
}

/**
 * Expose local methods to handle requests from a Worker.
 */
export function exposeToWorkerContext(
  localTarget: Record<string, (...args: any[]) => any>,
  worker: { postMessage: (data: any) => void; on: (event: string, handler: (data: any) => void) => void }
): void {
  const responseDispatcher = (msg: InvocationResponse) => worker.postMessage(msg);

  worker.on('message', (msg: any) => {
    processIncomingMessage(msg, localTarget, responseDispatcher);
  });
}

/**
 * Create communication channel with a VS Code Webview.
 */
export function connectToWebview<T extends object>(
  webview: { postMessage: (data: any) => Thenable<boolean> },
  methodList: string[]
): T {
  const dispatcher = (msg: ProtocolMessage) => webview.postMessage(msg);
  return buildRemoteProxy<T>(dispatcher, methodList);
}

/**
 * Process messages received from webview.
 * Call this in the onDidReceiveMessage handler.
 */
export function handleWebviewResponse(message: any): boolean {
  return processIncomingMessage(message);
}
