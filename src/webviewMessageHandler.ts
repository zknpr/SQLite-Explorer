import { MessageCorrelationId, PendingInvocation, processProtocolMessage } from './core/rpc';
import { deserializeArgs, serializeValue } from './core/serialization';
import {
  WEBVIEW_TRANSPORT_SURFACES,
  assertWebviewTransportPayload,
  fromWebviewPayloadLimitErrorData,
  toWebviewPayloadLimitErrorData
} from './core/webview-transport';
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
    if (this.#handleCoreRpcResponse(message)) return;

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
    let deserializedPayload: unknown[];
    try {
      assertWebviewTransportPayload(message, {
        surface: WEBVIEW_TRANSPORT_SURFACES.webviewRequest
      });
      deserializedPayload = deserializeArgs(payload || [], {
        surface: WEBVIEW_TRANSPORT_SURFACES.webviewRequest
      });
    } catch (error) {
      this.#postRpcFailure(messageId, error);
      return;
    }

    // SECURITY: Block Object.prototype methods to prevent prototype pollution attacks.
    // Allow class prototype methods (e.g., HostBridge.initialize) but reject inherited
    // Object methods like 'constructor', '__defineGetter__', 'toString'.
    if (!BLOCKED_METHODS.has(targetMethod) && targetMethod in hostBridge && typeof (hostBridge as unknown as Record<string, unknown>)[targetMethod] === 'function') {
      const fn = (hostBridge as unknown as Record<string, unknown>)[targetMethod] as Function;
      Promise.resolve(fn.apply(hostBridge, deserializedPayload))
        .then(result => {
          const rawResponse = {
            channel: 'rpc' as const,
            content: {
              kind: 'response' as const,
              messageId,
              success: true,
              data: result
            }
          };
          assertWebviewTransportPayload(rawResponse, {
            surface: WEBVIEW_TRANSPORT_SURFACES.hostResponse
          });
          const serializedResult = serializeValue(result, {
            surface: WEBVIEW_TRANSPORT_SURFACES.hostResponse
          });
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
          this.#postRpcFailure(messageId, err);
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
    const fn = (hostBridge as unknown as Record<string, unknown>)[message.method] as Function;
    if (typeof fn === 'function') {
      let deserializedArgs: unknown[];
      try {
        assertWebviewTransportPayload(message, {
          surface: WEBVIEW_TRANSPORT_SURFACES.webviewRequest
        });
        deserializedArgs = deserializeArgs(message.args || [], {
          surface: WEBVIEW_TRANSPORT_SURFACES.webviewRequest
        });
      } catch (error) {
        this.#postLegacyFailure(message.id, error);
        return;
      }
      Promise.resolve(fn.apply(hostBridge, deserializedArgs))
        .then(result => {
          assertWebviewTransportPayload({
            type: 'rpc-response',
            id: message.id,
            result
          }, {
            surface: WEBVIEW_TRANSPORT_SURFACES.hostResponse
          });
          const serializedResult = serializeValue(result, {
            surface: WEBVIEW_TRANSPORT_SURFACES.hostResponse
          });
          this.postMessage({
            type: 'rpc-response',
            id: message.id,
            result: serializedResult
          });
        })
        .catch(err => {
          this.#postLegacyFailure(message.id, err);
        });
    }
  }

  /**
   * Guard host-initiated RPC responses before protocol routing. A receiver-side
   * rejection faults the exact pending call instead of throwing from the
   * message event or waiting for its timeout.
   */
  #handleCoreRpcResponse(message: unknown): boolean {
    if (!message || typeof message !== 'object') return false;
    const response = message as { kind?: unknown; correlationId?: unknown; error?: unknown };
    if (response.kind !== 'result' || typeof response.correlationId !== 'string') return false;

    let fault: Error | undefined;
    try {
      assertWebviewTransportPayload(message, {
        surface: WEBVIEW_TRANSPORT_SURFACES.webviewResponse
      });
      fault = fromWebviewPayloadLimitErrorData(response.error);
    } catch (error) {
      fault = error instanceof Error ? error : new Error(String(error));
    }
    if (!fault) return false;

    const pending = this.pendingInvocations?.get(response.correlationId);
    if (pending) {
      clearTimeout(pending.expirationTimer);
      this.pendingInvocations!.delete(response.correlationId);
      pending.onFault(fault);
    }
    return true;
  }

  #postRpcFailure(messageId: string, error: unknown): void {
    const errorData = toWebviewPayloadLimitErrorData(error);
    this.postMessage({
      channel: 'rpc',
      content: {
        kind: 'response',
        messageId,
        success: false,
        errorMessage: error instanceof Error ? error.message : String(error),
        ...(errorData ? { error: errorData } : {})
      }
    });
  }

  #postLegacyFailure(id: string | number, error: unknown): void {
    const errorData = toWebviewPayloadLimitErrorData(error);
    this.postMessage({
      type: 'rpc-response',
      id,
      error: error instanceof Error ? error.message : String(error),
      ...(errorData ? { errorData } : {})
    });
  }
}
