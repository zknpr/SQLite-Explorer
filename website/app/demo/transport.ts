import {
  WEBVIEW_TRANSPORT_SURFACES,
  assertWebviewTransportPayload,
  fromWebviewPayloadLimitErrorData,
  toWebviewPayloadLimitErrorData
} from '../../../src/core/webview-transport';
import { BUFFER_OPEN_CEILING_BYTES } from '../../../src/core/paged-open';
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

/**
 * The full-database download is the one worker response intentionally allowed
 * above the ordinary 16 MiB RPC budget. Validate its envelope and sidecars at
 * the normal limit, then widen only the transferred Uint8Array to the same hard
 * ceiling enforced before the worker materializes a merged paged image.
 */
export function guardDemoDatabaseExportResponse(
  value: unknown,
  maxBytes = BUFFER_OPEN_CEILING_BYTES
): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Demo database export limit must be a positive safe integer');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Database export response must be an RPC envelope');
  }
  const envelope = value as Record<string, unknown>;
  const contentValue = envelope.content;
  if (!contentValue || typeof contentValue !== 'object' || Array.isArray(contentValue)) {
    throw new TypeError('Database export response must contain RPC content');
  }
  const content = contentValue as Record<string, unknown>;
  if (!(content.data instanceof Uint8Array)) {
    throw new TypeError('Database export response data must be a Uint8Array');
  }

  const { data, ...contentWithoutData } = content;
  guardDemoWorkerResponse({ ...envelope, content: contentWithoutData });
  assertWebviewTransportPayload(data, {
    surface: WEBVIEW_TRANSPORT_SURFACES.demoWorkerResponse,
    maxBinaryBytes: maxBytes,
    // The generic estimator models binary as Base64 even though this boundary
    // uses a zero-copy transferable. Give that estimate enough headroom while
    // retaining the exact raw-binary ceiling above.
    maxAggregateBytes: 4 * Math.ceil(maxBytes / 3) + 1024
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
