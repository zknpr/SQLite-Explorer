/**
 * RPC Serialization Utilities
 *
 * Functions for serializing and deserializing data for RPC transmission,
 * specifically handling Uint8Array to Base64 conversion for efficient transfer.
 */

import {
  WEBVIEW_TRANSPORT_SURFACES,
  assertWebviewTransportPayload,
  type WebviewTransportLimits
} from './webview-transport';

const DEFAULT_SERIALIZATION_LIMITS: WebviewTransportLimits = {
  surface: WEBVIEW_TRANSPORT_SURFACES.coreSerialization
};

/**
 * Encode Uint8Array to Base64 string.
 * Uses Buffer for efficient encoding in Node.js environment.
 *
 * @param bytes - Binary data to encode
 * @returns Base64 encoded string
 */
export function uint8ArrayToBase64(
  bytes: Uint8Array,
  limits: WebviewTransportLimits = DEFAULT_SERIALIZATION_LIMITS
): string {
  assertWebviewTransportPayload(bytes, limits);
  return Buffer.from(bytes).toString('base64');
}

/**
 * Decode Base64 string to Uint8Array.
 *
 * @param base64 - Base64 encoded string
 * @returns Decoded binary data
 */
export function base64ToUint8Array(
  base64: string,
  limits: WebviewTransportLimits = DEFAULT_SERIALIZATION_LIMITS
): Uint8Array {
  assertWebviewTransportPayload({ __type: 'Uint8Array', base64 }, limits);
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/**
 * Serialize a value for RPC transmission.
 * Converts Uint8Array to Base64 format for efficient transfer.
 *
 * Performance: Base64 encoding is ~33% larger than binary but significantly faster
 * and more compact than array-of-numbers JSON serialization (which was ~300% larger).
 *
 * @param value - Value to serialize
 * @returns Serialized value safe for postMessage
 */
export function serializeValue(
  value: unknown,
  limits: WebviewTransportLimits = DEFAULT_SERIALIZATION_LIMITS
): unknown {
  assertWebviewTransportPayload(value, limits);
  return serializeValueUnchecked(value);
}

function serializeValueUnchecked(value: unknown): unknown {
  // Handle Uint8Array by converting to Base64 marker object
  if (value instanceof Uint8Array) {
    return { __type: 'Uint8Array', base64: Buffer.from(value).toString('base64') };
  }
  // Handle other ArrayBuffer views (like DataView)
  if (ArrayBuffer.isView(value)) {
    const uint8 = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { __type: 'Uint8Array', base64: Buffer.from(uint8).toString('base64') };
  }
  // Recursively serialize plain object properties only
  // Using Object.prototype.toString for robust object detection (handles null prototype)
  if (value && typeof value === 'object' && Object.prototype.toString.call(value) === '[object Object]') {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        result[key] = serializeValueUnchecked(obj[key]);
      }
    }
    return result;
  }
  // Recursively serialize arrays
  if (Array.isArray(value)) {
    return value.map(serializeValueUnchecked);
  }
  return value;
}

/**
 * Deserialize a value from RPC transmission.
 * Converts serialized Uint8Array markers back to actual Uint8Array instances.
 * Supports both Base64 format (new) and array format (legacy) for backward compatibility.
 *
 * Security: Only deserializes objects that have exactly the expected marker keys
 * to prevent marker collision with user data.
 *
 * @param value - Value to deserialize
 * @returns Deserialized value
 */
export function deserializeValue(
  value: unknown,
  limits: WebviewTransportLimits = DEFAULT_SERIALIZATION_LIMITS
): unknown {
  assertWebviewTransportPayload(value, limits);
  return deserializeValueUnchecked(value);
}

function deserializeValueUnchecked(value: unknown): unknown {
  // Check for our Uint8Array serialization marker
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;

    if ('__type' in obj && obj.__type === 'Uint8Array') {
      const keys = Object.keys(obj);
      // Check for Base64 format (new, preferred): { __type: 'Uint8Array', base64: '...' }
      if (typeof obj.base64 === 'string') {
        if (keys.length === 2 && keys.includes('__type') && keys.includes('base64')) {
          return new Uint8Array(Buffer.from(obj.base64, 'base64'));
        }
      }

      // Check for array format (legacy): { __type: 'Uint8Array', data: [...] }
      if (Array.isArray(obj.data)) {
        if (keys.length === 2 && keys.includes('__type') && keys.includes('data')) {
          return new Uint8Array(obj.data as number[]);
        }
      }
    }

    // Recursively deserialize object properties
    const result: Record<string, unknown> = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        result[key] = deserializeValueUnchecked(obj[key]);
      }
    }
    return result;
  }
  if (Array.isArray(value)) {
    return value.map(deserializeValueUnchecked);
  }
  return value;
}

/**
 * Deserialize an arguments array from RPC transmission.
 * @param args - Arguments to deserialize
 * @returns Deserialized arguments
 */
export function deserializeArgs(
  args: unknown[],
  limits: WebviewTransportLimits = DEFAULT_SERIALIZATION_LIMITS
): unknown[] {
  return deserializeValue(args, limits) as unknown[];
}
