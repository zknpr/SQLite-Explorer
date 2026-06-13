import { MessageCorrelationId, PendingInvocation, processProtocolMessage } from './core/rpc';
import { deserializeArgs, serializeValue } from './core/serialization';
import type { HostBridge } from './hostBridge';

interface WebviewRpcInvokeMessage {
  channel: 'rpc';
  content: {
    kind: 'invoke';
    messageId: string;
    targetMethod: string;
    payload?: unknown[];
  };
}

interface WebviewLegacyRpcMessage {
  type: 'rpc-request';
  method: string;
  id: string | number;
  args?: unknown[];
}

function isWebviewRpcInvokeMessage(message: unknown): message is WebviewRpcInvokeMessage {
  if (!message || typeof message !== 'object') return false;
  const msg = message as Record<string, unknown>;
  const content = msg.content as Record<string, unknown> | undefined;
  return msg.channel === 'rpc' && content?.kind === 'invoke';
}

function isWebviewLegacyRpcMessage(message: unknown): message is WebviewLegacyRpcMessage {
  if (!message || typeof message !== 'object') return false;
  const msg = message as Record<string, unknown>;
  return msg.type === 'rpc-request';
}

/**
 * SECURITY: Set of Object.prototype method names that must never be invoked via RPC.
 * Prevents prototype pollution attacks where a crafted message could invoke
 * inherited methods like 'constructor', '__defineGetter__', or 'toString'.
 */
const BLOCKED_METHODS = new Set(Object.getOwnPropertyNames(Object.prototype));

/**
 * Handles messages received from the webview.
 * Decouples message processing logic from VS Code API.
 */
export class WebviewMessageHandler {
  constructor(
    private readonly postMessage: (message: unknown) => PromiseLike<boolean>,
    private readonly hostBridge: HostBridge,
    private readonly pendingInvocations?: Map<MessageCorrelationId, PendingInvocation>
  ) {}

  /**
   * Process an incoming message from the webview.
   * @param message - The message object received from the webview
   */
  handleMessage(message: unknown) {
    // Handle RPC responses (for calls we make to the webview).
    // Pass the per-proxy pending invocations map so responses are routed correctly.
    processProtocolMessage(message, undefined, undefined, undefined, this.pendingInvocations);

    if (isWebviewRpcInvokeMessage(message)) {
      this.#handleRpcInvoke(message);
    }

    if (isWebviewLegacyRpcMessage(message)) {
      this.#handleLegacyRpcRequest(message);
    }
  }

  /**
   * Handle standard RPC invocation request.
   * Format: { channel: 'rpc', content: { kind: 'invoke', messageId, targetMethod, payload } }
   */
  #handleRpcInvoke(message: WebviewRpcInvokeMessage) {
    const { messageId, targetMethod, payload } = message.content;
    const hostBridge = this.hostBridge;

    // Deserialize payload to restore Uint8Array instances
    const deserializedPayload = deserializeArgs(payload || []);

    // SECURITY: Block Object.prototype methods to prevent prototype pollution attacks.
    // Allow class prototype methods (e.g., HostBridge.initialize) but reject inherited
    // Object methods like 'constructor', '__defineGetter__', 'toString'.
    if (!BLOCKED_METHODS.has(targetMethod) && targetMethod in hostBridge && typeof (hostBridge as unknown as Record<string, unknown>)[targetMethod] === 'function') {
      const fn = (hostBridge as unknown as Record<string, unknown>)[targetMethod] as Function;
      Promise.resolve(fn.apply(hostBridge as unknown, deserializedPayload))
        .then(result => {
          // Serialize result to handle Uint8Array and other typed arrays
          // which get converted to {} by postMessage JSON serialization
          const serializedResult = serializeValue(result);
          this.postMessage({
            channel: 'rpc',
            content: {
              kind: 'response',
              messageId,
              success: true,
              data: serializedResult
            }
          });
        })
        .catch(err => {
          this.postMessage({
            channel: 'rpc',
            content: {
              kind: 'response',
              messageId,
              success: false,
              errorMessage: err instanceof Error ? err.message : String(err)
            }
          });
        });
    } else {
      // Method not found
      this.postMessage({
        channel: 'rpc',
        content: {
          kind: 'response',
          messageId,
          success: false,
          errorMessage: `Method '${targetMethod}' not found on hostBridge`
        }
      });
    }
  }

  /**
   * Handle legacy RPC request format.
   * Format: { type: 'rpc-request', method, id, args }
   */
  #handleLegacyRpcRequest(message: WebviewLegacyRpcMessage) {
    const hostBridge = this.hostBridge;
    // SECURITY: Same prototype pollution guard as #handleRpcInvoke
    if (BLOCKED_METHODS.has(message.method) || !(message.method in hostBridge)) return;
    const fn = (hostBridge as unknown as Record<string, unknown>)[message.method];
    if (typeof fn === 'function') {
      Promise.resolve((fn as Function).apply(hostBridge as unknown, deserializeArgs(message.args || [])))
        .then(result => {
          // Serialize result to handle Uint8Array
          const serializedResult = serializeValue(result);
          this.postMessage({
            type: 'rpc-response',
            id: message.id,
            result: serializedResult
          });
        })
        .catch(err => {
          this.postMessage({
            type: 'rpc-response',
            id: message.id,
            error: err instanceof Error ? err.message : String(err)
          });
        });
    }
  }
}
