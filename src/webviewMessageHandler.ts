import { MessageCorrelationId, PendingInvocation, processProtocolMessage } from './core/rpc';
import { deserializeArgs, serializeValue } from './core/serialization';
import {
  WEBVIEW_TRANSPORT_SURFACES,
  assertWebviewTransportPayload,
  fromWebviewPayloadLimitErrorData,
  toWebviewPayloadLimitErrorData
} from './core/webview-transport';
import {
  fromCellEditRpcErrorData,
  toCellEditRpcErrorData
} from './core/cell-edit-policy';
import type { HostBridge } from './hostBridge';

interface WebviewRpcInvokeMessage {
  channel: 'rpc';
  content: {
    kind: 'invoke';
    messageId: unknown;
    targetMethod: unknown;
    payload?: unknown;
  };
}

interface WebviewLegacyRpcMessage {
  type: 'rpc-request';
  method: unknown;
  id: unknown;
  args?: unknown;
}

const MAX_WEBVIEW_RPC_IDENTIFIER_LENGTH = 256;
const MAX_WEBVIEW_RPC_ERROR_MESSAGE_LENGTH = 8192;

function isSafeRpcString(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_WEBVIEW_RPC_IDENTIFIER_LENGTH;
}

function isSafeLegacyRpcId(value: unknown): value is string | number {
  return isSafeRpcString(value) || (typeof value === 'number' && Number.isSafeInteger(value));
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
 * SECURITY: The webview is an untrusted RPC client. Keep its capability set
 * explicit so adding a public HostBridge helper cannot silently expose it to
 * database-controlled script execution or a compromised webview.
 */
const WEBVIEW_RPC_METHODS = new Set<string>([
  'initialize',
  'ping',
  'openCellReadSession',
  'readCellChunk',
  'closeCellReadSession',
  'updateCell',
  'insertRow',
  'deleteRows',
  'deleteColumns',
  'createTable',
  'getViewDefinition',
  'validateViewDefinition',
  'previewViewDefinition',
  'createView',
  'editView',
  'dropView',
  'updateCellBatch',
  'addColumn',
  'fetchTableData',
  'fetchTableCount',
  'fetchSchema',
  'getTableInfo',
  'getPragmas',
  'setPragma',
  'refreshFile',
  'saveSidebarState',
  'openCellEditor',
  'prepareCellMediaPreview',
  'cancelCellMediaPreview',
  'releaseCellMediaPreview',
  'openViewEditor',
  'confirmLargeSelection',
  'getExtensionSettings',
  'updateExtensionSetting',
  'exportTable',
  'readWorkspaceFileUri',
  'saveFile',
  'selectFile'
]);

function describeRpcFailure(error: unknown) {
  let message = 'Unknown error';
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    // Malformed rejection values must not prevent the terminal response.
  }
  if (message.length > MAX_WEBVIEW_RPC_ERROR_MESSAGE_LENGTH) {
    const originalLength = message.length;
    message = message.slice(0, MAX_WEBVIEW_RPC_ERROR_MESSAGE_LENGTH)
      + `... [truncated from ${originalLength} characters]`;
  }

  let data: ReturnType<typeof toCellEditRpcErrorData>
    | ReturnType<typeof toWebviewPayloadLimitErrorData>;
  try {
    data = toCellEditRpcErrorData(error)
      ?? toWebviewPayloadLimitErrorData(error);
  } catch {
    // Ignore typed metadata when hostile getters make it unsafe to inspect.
  }
  return { message, data };
}

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
    if (processProtocolMessage(
      message,
      undefined,
      undefined,
      undefined,
      this.pendingInvocations
    )) return;

    if (isWebviewRpcInvokeMessage(message)) {
      this.#handleRpcInvoke(message);
      // An object must have exactly one dispatch interpretation. Without this
      // return, a crafted envelope carrying both formats invokes two methods.
      return;
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

    // The ID is reflected in every response, so reject malformed identities
    // before invoking a capability or copying attacker-controlled structures.
    if (!isSafeRpcString(messageId)) return;
    if (!isSafeRpcString(targetMethod)) {
      this.#postRpcFailure(messageId, new Error('RPC method name must be a bounded string'));
      return;
    }
    if (payload !== undefined && !Array.isArray(payload)) {
      this.#postRpcFailure(messageId, new Error('RPC payload must be an array'));
      return;
    }

    // Deserialize payload to restore Uint8Array instances
    let deserializedPayload: unknown[];
    try {
      assertWebviewTransportPayload(message, {
        surface: WEBVIEW_TRANSPORT_SURFACES.webviewRequest
      });
      deserializedPayload = deserializeArgs(payload ?? [], {
        surface: WEBVIEW_TRANSPORT_SURFACES.webviewRequest
      });
    } catch (error) {
      this.#postRpcFailure(messageId, error);
      return;
    }

    if (WEBVIEW_RPC_METHODS.has(targetMethod)
        && targetMethod in hostBridge
        && typeof (hostBridge as unknown as Record<string, unknown>)[targetMethod] === 'function') {
      const fn = (hostBridge as unknown as Record<string, unknown>)[targetMethod] as Function;
      // Start the invocation inside the promise chain so synchronous typed
      // policy refusals take the same serialized error path as async rejects.
      Promise.resolve()
        .then(() => fn.apply(hostBridge, deserializedPayload))
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
    if (!isSafeLegacyRpcId(message.id)) return;
    const responseId = message.id;
    if (!isSafeRpcString(message.method)) {
      this.#postLegacyFailure(responseId, new Error('RPC method name must be a bounded string'));
      return;
    }
    if (message.args !== undefined && !Array.isArray(message.args)) {
      this.#postLegacyFailure(responseId, new Error('RPC arguments must be an array'));
      return;
    }
    const candidate = (hostBridge as unknown as Record<string, unknown>)[message.method];
    if (!WEBVIEW_RPC_METHODS.has(message.method) || typeof candidate !== 'function') {
      this.#postLegacyFailure(
        responseId,
        new Error(`Method '${message.method}' not found on hostBridge`)
      );
      return;
    }
    const fn = candidate as Function;
    let deserializedArgs: unknown[];
    try {
      assertWebviewTransportPayload(message, {
        surface: WEBVIEW_TRANSPORT_SURFACES.webviewRequest
      });
      deserializedArgs = deserializeArgs(message.args ?? [], {
        surface: WEBVIEW_TRANSPORT_SURFACES.webviewRequest
      });
    } catch (error) {
      this.#postLegacyFailure(message.id, error);
      return;
    }
    Promise.resolve()
      .then(() => fn.apply(hostBridge, deserializedArgs))
      .then(result => {
        assertWebviewTransportPayload({
          type: 'rpc-response',
          id: responseId,
          result
        }, {
          surface: WEBVIEW_TRANSPORT_SURFACES.hostResponse
        });
        const serializedResult = serializeValue(result, {
          surface: WEBVIEW_TRANSPORT_SURFACES.hostResponse
        });
        this.postMessage({
          type: 'rpc-response',
          id: responseId,
          result: serializedResult
        });
      })
      .catch(err => {
        this.#postLegacyFailure(responseId, err);
      });
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
      fault = fromCellEditRpcErrorData(response.error)
        ?? fromWebviewPayloadLimitErrorData(response.error);
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
    const failure = describeRpcFailure(error);
    this.postMessage({
      channel: 'rpc',
      content: {
        kind: 'response',
        messageId,
        success: false,
        errorMessage: failure.message,
        ...(failure.data ? { error: failure.data } : {})
      }
    });
  }

  #postLegacyFailure(id: string | number, error: unknown): void {
    const failure = describeRpcFailure(error);
    this.postMessage({
      type: 'rpc-response',
      id,
      error: failure.message,
      ...(failure.data ? { errorData: failure.data } : {})
    });
  }
}
