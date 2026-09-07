import {
    MAX_WEBVIEW_BINARY_VALUE_BYTES,
    WEBVIEW_TRANSPORT_SURFACES,
    assertWebviewTransportPayload,
    fromWebviewPayloadLimitErrorData,
    toWebviewPayloadLimitErrorData
} from '../../../src/core/webview-transport.ts';
import {
    fromCellEditRpcErrorData,
    toCellEditRpcErrorData
} from '../../../src/core/cell-edit-policy.ts';
import {
    decodeJsonSafeNumberString,
    encodeJsonSafeNonFiniteNumber,
    escapeJsonSafeNumberString
} from '../../../src/core/json-safe-numbers.ts';
import { getErrorMessage } from './utils.js';
import { encodeBinaryBase64 } from './binary-encoding.js';

export {
    MAX_WEBVIEW_BINARY_VALUE_BYTES,
    WEBVIEW_TRANSPORT_SURFACES,
    assertWebviewTransportPayload,
    fromWebviewPayloadLimitErrorData,
    toWebviewPayloadLimitErrorData
};
export {
    decodeJsonSafeNumberString,
    encodeJsonSafeNonFiniteNumber,
    escapeJsonSafeNumberString
};

function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

async function serializeValueUnchecked(value) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
        return encodeJsonSafeNonFiniteNumber(value);
    }
    if (typeof value === 'string') return escapeJsonSafeNumberString(value);
    if (value instanceof Uint8Array) {
        return { __type: 'Uint8Array', base64: await encodeBinaryBase64(value) };
    }
    if (ArrayBuffer.isView(value)) {
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        return { __type: 'Uint8Array', base64: await encodeBinaryBase64(bytes) };
    }
    if (Array.isArray(value)) return Promise.all(value.map(serializeValueUnchecked));
    if (value && typeof value === 'object' && Object.prototype.toString.call(value) === '[object Object]') {
        const result = {};
        for (const key of Object.keys(value)) {
            Object.defineProperty(result, key, {
                value: await serializeValueUnchecked(value[key]),
                enumerable: true,
                configurable: true,
                writable: true
            });
        }
        return result;
    }
    return value;
}

/** Guard the complete graph before the first Base64 allocation. */
export async function serializeValueAsync(value, limits) {
    assertWebviewTransportPayload(value, limits);
    return serializeValueUnchecked(value);
}

export async function serializeArgsAsync(args, limits) {
    return serializeValueAsync(args, limits);
}

function deserializeValueUnchecked(value) {
    if (typeof value === 'string') return decodeJsonSafeNumberString(value);
    // Demo responses use structured clone rather than Base64. Preserve bounded
    // typed arrays directly instead of enumerating numeric keys.
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const keys = Object.keys(value);
        if (
            value.__type === 'Uint8Array'
            && typeof value.base64 === 'string'
            && keys.length === 2
            && keys.includes('__type')
            && keys.includes('base64')
        ) {
            return base64ToUint8Array(value.base64);
        }
        if (
            value.__type === 'Uint8Array'
            && Array.isArray(value.data)
            && keys.length === 2
            && keys.includes('__type')
            && keys.includes('data')
        ) {
            return new Uint8Array(value.data);
        }
        const result = {};
        for (const key of keys) {
            Object.defineProperty(result, key, {
                value: deserializeValueUnchecked(value[key]),
                enumerable: true,
                configurable: true,
                writable: true
            });
        }
        return result;
    }
    if (Array.isArray(value)) return value.map(deserializeValueUnchecked);
    return value;
}

/** Guard marker/raw binary sizes before atob or typed-array key enumeration. */
export function deserializeValue(value, limits) {
    assertWebviewTransportPayload(value, limits);
    return deserializeValueUnchecked(value);
}

export function errorFromRpcResponse(message) {
    return fromCellEditRpcErrorData(message?.error)
        ?? fromWebviewPayloadLimitErrorData(message?.error)
        ?? new Error(message?.errorMessage || 'RPC failed');
}

export function rpcErrorFields(error) {
    const errorMessage = getErrorMessage(error);
    const typed = toCellEditRpcErrorData(error)
        ?? toWebviewPayloadLimitErrorData(error);
    return {
        errorMessage,
        ...(typed ? { error: typed } : {})
    };
}
