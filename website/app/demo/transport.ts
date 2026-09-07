import {
  WEBVIEW_TRANSPORT_SURFACES,
  assertWebviewTransportPayload,
  fromWebviewPayloadLimitErrorData,
  toWebviewPayloadLimitErrorData
} from '../../../src/core/webview-transport';
import { BUFFER_OPEN_CEILING_BYTES } from '../../../src/core/paged-open';
import { deserializeValue } from '../../../core/ui/modules/transport.js';
import {
  encodeJsonSafeNonFiniteNumber,
  escapeJsonSafeNumberString
} from '../../../src/core/json-safe-numbers';
import {
  fromCellEditRpcErrorData,
  toCellEditRpcErrorData
} from '../../../src/core/cell-edit-policy';

const MAX_DEMO_RPC_IDENTIFIER_LENGTH = 256;
const MAX_DEMO_RPC_ERROR_MESSAGE_LENGTH = 8192;

export function isSafeDemoRpcIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_DEMO_RPC_IDENTIFIER_LENGTH;
}

function assertDemoRpcEnvelope(value: unknown, kind: 'invoke' | 'response'): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Demo RPC value must be an envelope object');
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.channel !== 'rpc') throw new TypeError('Demo RPC channel must be "rpc"');
  if (!envelope.content || typeof envelope.content !== 'object' || Array.isArray(envelope.content)) {
    throw new TypeError('Demo RPC content must be an object');
  }
  const content = envelope.content as Record<string, unknown>;
  if (content.kind !== kind) throw new TypeError(`Demo RPC kind must be "${kind}"`);
  if (!isSafeDemoRpcIdentifier(content.messageId)) {
    throw new TypeError('Demo RPC messageId must be a bounded string');
  }

  if (kind === 'invoke') {
    if (!isSafeDemoRpcIdentifier(content.targetMethod)) {
      throw new TypeError('Demo RPC method must be a bounded string');
    }
    if (!Array.isArray(content.payload)) {
      throw new TypeError('Demo RPC payload must be an array');
    }
    return;
  }

  if (typeof content.success !== 'boolean') {
    throw new TypeError('Demo RPC response success must be a boolean');
  }
  if (content.success === false && typeof content.errorMessage !== 'string') {
    throw new TypeError('Failed demo RPC responses must contain an error message');
  }
}

export function guardDemoIframeRequest(value: unknown): void {
  assertWebviewTransportPayload(value, {
    surface: WEBVIEW_TRANSPORT_SURFACES.demoIframeRequest
  });
  assertDemoRpcEnvelope(value, 'invoke');
}

export function guardDemoIframeResponse(value: unknown): void {
  assertWebviewTransportPayload(value, {
    surface: WEBVIEW_TRANSPORT_SURFACES.demoIframeResponse
  });
  assertDemoRpcEnvelope(value, 'response');
}

export function guardDemoWorkerRequest(value: unknown): void {
  assertWebviewTransportPayload(value, {
    surface: WEBVIEW_TRANSPORT_SURFACES.demoWorkerRequest
  });
  assertDemoRpcEnvelope(value, 'invoke');
}

export function guardDemoWorkerResponse(value: unknown): void {
  assertWebviewTransportPayload(value, {
    surface: WEBVIEW_TRANSPORT_SURFACES.demoWorkerResponse
  });
  assertDemoRpcEnvelope(value, 'response');
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

/**
 * The worker boundary uses structured clone, but the iframe consumer applies
 * the JSON-safe scalar decoder used by VS Code. Encode only those scalars
 * before forwarding so reserved-prefix TEXT is escaped and Infinity survives
 * either transport without converting typed arrays to Base64.
 */
export function serializeDemoIframeResponse(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return encodeJsonSafeNonFiniteNumber(value);
  }
  if (typeof value === 'string') return escapeJsonSafeNumberString(value);
  if (Array.isArray(value)) return value.map(serializeDemoIframeResponse);
  if (
    value
    && typeof value === 'object'
    && Object.prototype.toString.call(value) === '[object Object]'
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serializeDemoIframeResponse(item)])
    );
  }
  return value;
}

export function demoRpcErrorFields(error: unknown) {
  let errorMessage = 'Unknown error';
  try {
    errorMessage = error instanceof Error ? error.message : String(error);
  } catch {
    // A malformed rejection still needs a terminal scalar response.
  }
  if (errorMessage.length > MAX_DEMO_RPC_ERROR_MESSAGE_LENGTH) {
    const originalLength = errorMessage.length;
    errorMessage = errorMessage.slice(0, MAX_DEMO_RPC_ERROR_MESSAGE_LENGTH)
      + `... [truncated from ${originalLength} characters]`;
  }
  let typed;
  try {
    typed = toCellEditRpcErrorData(error)
      ?? toWebviewPayloadLimitErrorData(error);
  } catch {
    // Hostile getters/proxies are not allowed to break response delivery.
  }
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
