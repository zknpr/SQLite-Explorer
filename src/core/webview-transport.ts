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

/** Keep recursive guards/serializers well below ordinary JS stack limits. */
export const MAX_WEBVIEW_PAYLOAD_NESTING_DEPTH = 128;

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

/**
 * UTF-8 bytes of JSON.stringify(value), counted without building that string:
 * quotes, two-byte escapes for " \\ \b \t \n \f \r, \u00XX for other
 * control characters and \uXXXX for unpaired surrogates.
 */
function escapedJsonStringByteLength(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      if (code >= 0x20) bytes += code === 0x22 || code === 0x5c ? 2 : 1;
      else bytes += code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xD800 && code <= 0xDBFF) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next >= 0xDC00 && next <= 0xDFFF) {
        bytes += 4;
        index++;
      } else {
        bytes += 6;
      }
    } else {
      bytes += code >= 0xDC00 && code <= 0xDFFF ? 6 : 3;
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

// Read once at load. Pages without cross-origin isolation do not define this
// global, and a lookup that misses goes through the window's named-property
// check each time; done per visited value, that took about 13 of the 17 ms
// spent measuring a 5,000-row, 51-column page in Chrome.
const SharedArrayBufferConstructor = typeof SharedArrayBuffer === 'function'
  ? SharedArrayBuffer
  : undefined;

/**
 * Estimate the serialized/base64 wire footprint without allocating encoded
 * strings. Shared aliases are deliberately visited for every property because
 * the recursive serializer emits each path independently.
 */
export function assertWebviewTransportPayload(
  value: unknown,
  options: WebviewTransportLimits
): number {
  return measureWebviewTransportPayload(value, options).bytes;
}

/**
 * assertWebviewTransportPayload, also saying whether the host's serializeValue
 * or the webview's deserializeValue could rewrite anything in `value`. When
 * neither would, the receiver can use the value itself instead of walking it
 * again to copy it unchanged.
 */
export function measureWebviewTransportPayload(
  value: unknown,
  options: WebviewTransportLimits
): { bytes: number; needsRewrite: boolean } {
  const limits = resolveLimits(options);
  const ancestors = new WeakSet<object>();
  let aggregateBytes = 0;
  // Set at every value either side rewrites: binary values and markers,
  // non-finite numbers, '~' strings, and objects this walk does not enter.
  let needsRewrite = false;

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

  const visit = (candidate: unknown, depth = 0): void => {
    if (depth > MAX_WEBVIEW_PAYLOAD_NESTING_DEPTH) {
      throw new TypeError(
        `Webview payload nesting depth exceeds ${MAX_WEBVIEW_PAYLOAD_NESTING_DEPTH} ` +
        `at ${limits.surface}`
      );
    }
    if (candidate instanceof Uint8Array) {
      needsRewrite = true;
      addBinary(candidate.byteLength, encodedBase64Bytes(candidate.byteLength));
      return;
    }
    if (ArrayBuffer.isView(candidate)) {
      needsRewrite = true;
      addBinary(candidate.byteLength, encodedBase64Bytes(candidate.byteLength));
      return;
    }
    if (candidate instanceof ArrayBuffer) {
      needsRewrite = true;
      addBinary(candidate.byteLength, candidate.byteLength);
      return;
    }
    if (
      SharedArrayBufferConstructor !== undefined
      && candidate instanceof SharedArrayBufferConstructor
    ) {
      needsRewrite = true;
      addBinary(candidate.byteLength, candidate.byteLength);
      return;
    }
    if (typeof candidate === 'string') {
      const expansion = jsonSafeNumberStringExpansionBytes(candidate);
      if (expansion) needsRewrite = true;
      add(escapedJsonStringByteLength(candidate) + expansion);
      return;
    }
    if (typeof candidate === 'number') {
      if (Number.isFinite(candidate)) {
        add(8);
      } else {
        needsRewrite = true;
        add(JSON_SAFE_NON_FINITE_NUMBER_MAX_WIRE_BYTES);
      }
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
        for (const item of candidate) visit(item, depth + 1);
        return;
      }
      if (!isPlainObject(candidate)) {
        needsRewrite = true;
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
        needsRewrite = true;
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
        needsRewrite = true;
        if (candidate.data.length > limits.maxBinaryBytes) rejectBinary(candidate.data.length);
      }

      add(2 + Math.max(0, keys.length - 1));
      for (const key of keys) {
        add(escapedJsonStringByteLength(key) + 1);
        visit(candidate[key], depth + 1);
      }
    } finally {
      ancestors.delete(candidate);
    }
  };

  visit(value);
  return { bytes: aggregateBytes, needsRewrite };
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
