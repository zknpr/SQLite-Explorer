import {
  DEFAULT_MAX_PAGE_RESPONSE_BYTES,
  DEFAULT_MAX_WEBVIEW_AGGREGATE_PAYLOAD_BYTES,
  WEBVIEW_BINARY_MARKER_OVERHEAD_BYTES
} from './cell-containment';
import {
  JSON_SAFE_NON_FINITE_NUMBER_MAX_WIRE_BYTES,
  jsonSafeNumberStringExpansionBytes
} from './json-safe-numbers';

/** Stable machine-readable identity used on both sides of every webview boundary. */
export const WEBVIEW_PAYLOAD_LIMIT_ERROR_CODE = 'ERR_WEBVIEW_PAYLOAD_LIMIT' as const;

/**
 * A single binary value may consume Stage A's complete 16 MiB page budget, but
 * never more. This also matches the configurable hard ceiling for inline cells.
 */
export const MAX_WEBVIEW_BINARY_VALUE_BYTES = DEFAULT_MAX_PAGE_RESPONSE_BYTES;

/**
 * Base64 expands a full 16 MiB page to about 21.4 MiB. A 32 MiB encoded-payload
 * ceiling leaves room for headers and sidecars while rejecting duplicated
 * rows/values matrices and multi-value amplification before encoding or cloning.
 */
export const MAX_WEBVIEW_AGGREGATE_PAYLOAD_BYTES =
  DEFAULT_MAX_WEBVIEW_AGGREGATE_PAYLOAD_BYTES;

export const WEBVIEW_TRANSPORT_SURFACES = {
  coreSerialization: 'core RPC serialization',
  webviewRequest: 'webview -> extension host request',
  hostResponse: 'extension host -> webview response',
  webviewResponse: 'webview -> extension host response',
  hostRequest: 'extension host -> webview request',
  demoIframeRequest: 'web demo iframe -> parent request',
  demoIframeResponse: 'web demo parent -> iframe response',
  demoIframeResult: 'web demo iframe -> parent response',
  demoWorkerRequest: 'web demo parent -> worker request',
  demoWorkerResponse: 'web demo worker -> parent response'
} as const;

export type WebviewPayloadLimitKind = 'binary-value' | 'aggregate-payload';

export interface WebviewTransportLimits {
  surface: string;
  maxBinaryBytes?: number;
  maxAggregateBytes?: number;
}

export interface WebviewPayloadLimitErrorData {
  name: 'WebviewPayloadLimitError';
  code: typeof WEBVIEW_PAYLOAD_LIMIT_ERROR_CODE;
  surface: string;
  kind: WebviewPayloadLimitKind;
  actualBytes: number;
  limitBytes: number;
  message: string;
}

interface WebviewPayloadLimitErrorOptions {
  surface: string;
  kind: WebviewPayloadLimitKind;
  actualBytes: number;
  limitBytes: number;
}

export class WebviewPayloadLimitError extends Error {
  readonly code = WEBVIEW_PAYLOAD_LIMIT_ERROR_CODE;
  readonly surface: string;
  readonly kind: WebviewPayloadLimitKind;
  readonly actualBytes: number;
  readonly limitBytes: number;

  constructor(options: WebviewPayloadLimitErrorOptions) {
    const noun = options.kind === 'binary-value' ? 'binary value' : 'estimated encoded payload';
    super(
      `Webview transport rejected ${options.surface}: ${noun} is ` +
      `${options.actualBytes} bytes and exceeds the ${options.limitBytes}-byte ` +
      `${options.kind} limit.`
    );
    this.name = 'WebviewPayloadLimitError';
    this.surface = options.surface;
    this.kind = options.kind;
    this.actualBytes = options.actualBytes;
    this.limitBytes = options.limitBytes;
  }
}

function checkedLimit(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return resolved;
}

function resolveLimits(options: WebviewTransportLimits) {
  if (typeof options.surface !== 'string' || options.surface.trim() === '') {
    throw new Error('Webview transport surface must be a non-empty string');
  }
  return {
    surface: options.surface,
    maxBinaryBytes: checkedLimit(
      options.maxBinaryBytes,
      MAX_WEBVIEW_BINARY_VALUE_BYTES,
      'Webview binary-value limit'
    ),
    maxAggregateBytes: checkedLimit(
      options.maxAggregateBytes,
      MAX_WEBVIEW_AGGREGATE_PAYLOAD_BYTES,
      'Webview aggregate-payload limit'
    )
  };
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xD800 && code <= 0xDBFF && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        bytes += 4;
        index++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function decodedBase64Bytes(base64: string): number {
  if (base64.length === 0) return 0;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
}

function encodedBase64Bytes(byteLength: number): number {
  return 4 * Math.ceil(byteLength / 3);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value
    && typeof value === 'object'
    && Object.prototype.toString.call(value) === '[object Object]';
}

/**
 * Estimate the serialized/base64 wire footprint without allocating encoded
 * strings. Shared aliases are deliberately visited for every property because
 * the recursive serializer emits each path independently.
 */
export function assertWebviewTransportPayload(
  value: unknown,
  options: WebviewTransportLimits
): number {
  const limits = resolveLimits(options);
  const ancestors = new WeakSet<object>();
  let aggregateBytes = 0;

  const rejectBinary = (actualBytes: number): never => {
    throw new WebviewPayloadLimitError({
      surface: limits.surface,
      kind: 'binary-value',
      actualBytes,
      limitBytes: limits.maxBinaryBytes
    });
  };
  const add = (bytes: number): void => {
    aggregateBytes += bytes;
    if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > limits.maxAggregateBytes) {
      throw new WebviewPayloadLimitError({
        surface: limits.surface,
        kind: 'aggregate-payload',
        actualBytes: aggregateBytes,
        limitBytes: limits.maxAggregateBytes
      });
    }
  };
  const addBinary = (byteLength: number, encodedLength: number): void => {
    if (byteLength > limits.maxBinaryBytes) rejectBinary(byteLength);
    // Include the marker keys and punctuation in addition to the Base64 body.
    add(encodedLength + WEBVIEW_BINARY_MARKER_OVERHEAD_BYTES);
  };

  const visit = (candidate: unknown): void => {
    if (candidate instanceof Uint8Array) {
      addBinary(candidate.byteLength, encodedBase64Bytes(candidate.byteLength));
      return;
    }
    if (ArrayBuffer.isView(candidate)) {
      addBinary(candidate.byteLength, encodedBase64Bytes(candidate.byteLength));
      return;
    }
    if (candidate instanceof ArrayBuffer) {
      addBinary(candidate.byteLength, candidate.byteLength);
      return;
    }
    if (typeof SharedArrayBuffer === 'function' && candidate instanceof SharedArrayBuffer) {
      addBinary(candidate.byteLength, candidate.byteLength);
      return;
    }
    if (typeof candidate === 'string') {
      add(
        utf8ByteLength(candidate) + 2
        + jsonSafeNumberStringExpansionBytes(candidate)
      );
      return;
    }
    if (typeof candidate === 'number') {
      add(Number.isFinite(candidate) ? 8 : JSON_SAFE_NON_FINITE_NUMBER_MAX_WIRE_BYTES);
      return;
    }
    if (
      candidate === null
      || candidate === undefined
      || typeof candidate === 'boolean'
      || typeof candidate === 'bigint'
    ) {
      add(8);
      return;
    }
    if (typeof candidate !== 'object') {
      add(8);
      return;
    }

    if (ancestors.has(candidate)) {
      throw new TypeError(`Cannot measure circular payload at ${limits.surface}`);
    }
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        add(2 + Math.max(0, candidate.length - 1));
        for (const item of candidate) visit(item);
        return;
      }
      if (!isPlainObject(candidate)) {
        add(16);
        return;
      }

      const keys = Object.keys(candidate);
      if (
        candidate.__type === 'Uint8Array'
        && keys.length === 2
        && keys.includes('__type')
        && keys.includes('base64')
        && typeof candidate.base64 === 'string'
      ) {
        addBinary(decodedBase64Bytes(candidate.base64), candidate.base64.length);
        return;
      }
      if (
        candidate.__type === 'Uint8Array'
        && keys.length === 2
        && keys.includes('__type')
        && keys.includes('data')
        && Array.isArray(candidate.data)
      ) {
        if (candidate.data.length > limits.maxBinaryBytes) rejectBinary(candidate.data.length);
      }

      add(2 + Math.max(0, keys.length - 1));
      for (const key of keys) {
        add(utf8ByteLength(key) + 3);
        visit(candidate[key]);
      }
    } finally {
      ancestors.delete(candidate);
    }
  };

  visit(value);
  return aggregateBytes;
}

export function isWebviewPayloadLimitError(error: unknown): error is WebviewPayloadLimitError {
  return error instanceof WebviewPayloadLimitError
    || (
      !!error
      && typeof error === 'object'
      && (error as { code?: unknown }).code === WEBVIEW_PAYLOAD_LIMIT_ERROR_CODE
      && (error as { name?: unknown }).name === 'WebviewPayloadLimitError'
    );
}

export function toWebviewPayloadLimitErrorData(
  error: unknown
): WebviewPayloadLimitErrorData | undefined {
  if (!isWebviewPayloadLimitError(error)) return undefined;
  const candidate = error as WebviewPayloadLimitError;
  return {
    name: 'WebviewPayloadLimitError',
    code: WEBVIEW_PAYLOAD_LIMIT_ERROR_CODE,
    surface: candidate.surface,
    kind: candidate.kind,
    actualBytes: candidate.actualBytes,
    limitBytes: candidate.limitBytes,
    message: candidate.message
  };
}

export function fromWebviewPayloadLimitErrorData(
  value: unknown
): WebviewPayloadLimitError | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<WebviewPayloadLimitErrorData>;
  if (
    candidate.name !== 'WebviewPayloadLimitError'
    || candidate.code !== WEBVIEW_PAYLOAD_LIMIT_ERROR_CODE
    || typeof candidate.surface !== 'string'
    || (candidate.kind !== 'binary-value' && candidate.kind !== 'aggregate-payload')
    || !Number.isSafeInteger(candidate.actualBytes)
    || (candidate.actualBytes ?? -1) < 0
    || !Number.isSafeInteger(candidate.limitBytes)
    || (candidate.limitBytes ?? 0) < 1
  ) {
    return undefined;
  }
  return new WebviewPayloadLimitError({
    surface: candidate.surface,
    kind: candidate.kind,
    actualBytes: candidate.actualBytes!,
    limitBytes: candidate.limitBytes!
  });
}
