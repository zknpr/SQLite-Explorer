import { processProtocolMessage } from './core/rpc';
import { deserializeArgs, serializeValue } from './core/serialization';

/**
 * Handles messages received from the webview.
 * Decouples message processing logic from VS Code API.
 */
export class WebviewMessageHandler {
  constructor(
    private readonly postMessage: (message: any) => PromiseLike<boolean>,
    private readonly hostBridge: Record<string, any>
  ) {}

  /**
   * Process an incoming message from the webview.
   * @param message - The message object received from the webview
   */
  handleMessage(message: any) {
    // Handle RPC responses (for calls we make to the webview)
    processProtocolMessage(message);

    this.#handleRpcInvoke(message);
    this.#handleLegacyRpcRequest(message);
  }

  /**
   * Handle standard RPC invocation request.
   * Format: { channel: 'rpc', content: { kind: 'invoke', messageId, targetMethod, payload } }
   */
  #handleRpcInvoke(message: any) {
    if (message?.channel === 'rpc' && message?.content?.kind === 'invoke') {
      const { messageId, targetMethod, payload } = message.content;
      const hostBridge = this.hostBridge;

      // Deserialize payload to restore Uint8Array instances
      const deserializedPayload = deserializeArgs(payload || []);

      // Check if method exists on hostBridge
      if (typeof hostBridge[targetMethod] === 'function') {
        const fn = hostBridge[targetMethod];
        Promise.resolve(fn.apply(hostBridge, deserializedPayload))
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
  }

  /**
   * Handle legacy RPC request format.
   * Format: { type: 'rpc-request', method, id, args }
   */
  #handleLegacyRpcRequest(message: any) {
    if (message?.type === 'rpc-request') {
      const hostBridge = this.hostBridge;
      const fn = hostBridge[message.method];
      if (typeof fn === 'function') {
        Promise.resolve(fn.apply(hostBridge, deserializeArgs(message.args || [])))
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
}
