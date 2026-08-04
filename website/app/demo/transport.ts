import {
  WEBVIEW_TRANSPORT_SURFACES,
  assertWebviewTransportPayload,
  fromWebviewPayloadLimitErrorData,
  toWebviewPayloadLimitErrorData
} from '../../../src/core/webview-transport';
import { deserializeValue } from '../../../core/ui/modules/transport.js';
import {
  fromCellEditRpcErrorData,
  toCellEditRpcErrorData
} from '../../../src/core/cell-edit-policy';

export function guardDemoIframeRequest(value: unknown): void {
  assertWebviewTransportPayload(value, {
    surface: WEBVIEW_TRANSPORT_SURFACES.demoIframeRequest
  });
}

export function guardDemoIframeResponse(value: unknown): void {
  assertWebviewTransportPayload(value, {
    surface: WEBVIEW_TRANSPORT_SURFACES.demoIframeResponse
  });
}

export function guardDemoWorkerRequest(value: unknown): void {
  assertWebviewTransportPayload(value, {
    surface: WEBVIEW_TRANSPORT_SURFACES.demoWorkerRequest
  });
}

export function guardDemoWorkerResponse(value: unknown): void {
  assertWebviewTransportPayload(value, {
    surface: WEBVIEW_TRANSPORT_SURFACES.demoWorkerResponse
  });
}

export function deserializeDemoIframeRequest(value: unknown): unknown {
  return deserializeValue(value, {
    surface: WEBVIEW_TRANSPORT_SURFACES.demoIframeRequest
  });
}

export function demoRpcErrorFields(error: unknown) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const typed = toCellEditRpcErrorData(error)
    ?? toWebviewPayloadLimitErrorData(error);
  return {
    errorMessage,
    ...(typed ? { error: typed } : {})
  };
}

export function demoRpcErrorFromResponse(content: {
  error?: unknown;
  errorMessage?: string;
}): Error {
  return fromCellEditRpcErrorData(content.error)
    ?? fromWebviewPayloadLimitErrorData(content.error)
    ?? new Error(content.errorMessage || 'RPC failed');
}
