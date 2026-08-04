/**
 * API Client Module
 * Handles outgoing RPC requests to the extension host.
 */

import { RPC_TIMEOUT_MS, getRpcTimeoutMs } from './rpc-constants.js';
import {
    WEBVIEW_TRANSPORT_SURFACES,
    assertWebviewTransportPayload,
    errorFromRpcResponse,
    rpcErrorFields
} from './transport.js';

export { RPC_TIMEOUT_MS, getRpcTimeoutMs };

const vscodeApi = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : null;

/**
 * Get saved state from VS Code's webview state persistence.
 * @returns {Object|undefined} Previously saved state, or undefined if none
 */
export function getVsCodeState() {
    return vscodeApi ? vscodeApi.getState() : undefined;
}

/**
 * Save state to VS Code's webview state persistence.
 * This survives tab switches when retainContextWhenHidden is false.
 * @param {Object} stateObj - State to save
 */
export function saveVsCodeState(stateObj) {
    if (vscodeApi) {
        vscodeApi.setState(stateObj);
    }
}

// Message ID tracking
let rpcMessageId = 0;
const pendingRpcCalls = new Map();

// ============================================================================
// Base64 Encoding Utilities
// ============================================================================

/**
 * Encode Uint8Array to Base64 string asynchronously.
 * Uses chunked processing with microtask yields to prevent UI blocking.
 *
 * For small arrays (< 64KB), uses synchronous encoding for speed.
 * For larger arrays, yields control between chunks to keep UI responsive.
 *
 * @param {Uint8Array} bytes - Binary data to encode
 * @returns {Promise<string>} Base64 encoded string
 */
async function uint8ArrayToBase64Async(bytes) {
    // For small arrays, synchronous encoding is fast enough and avoids async overhead
    const SYNC_THRESHOLD = 65536; // 64KB
    if (bytes.length <= SYNC_THRESHOLD) {
        return uint8ArrayToBase64Sync(bytes);
    }

    // For larger arrays, use chunked async encoding to prevent UI freeze
    // Process in chunks and yield to the event loop between chunks
    const CHUNK_SIZE = 32768; // 32KB per chunk
    const chunks = [];

    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
        chunks.push(String.fromCharCode.apply(null, chunk));

        // Yield to event loop every few chunks to allow UI updates
        // Using a microtask (Promise.resolve) for minimal delay while still allowing repaints
        if (i > 0 && (i / CHUNK_SIZE) % 4 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    return btoa(chunks.join(''));
}

/**
 * Synchronous Base64 encoding for small arrays.
 * Used when async overhead isn't worth it.
 *
 * @param {Uint8Array} bytes - Binary data to encode
 * @returns {string} Base64 encoded string
 */
function uint8ArrayToBase64Sync(bytes) {
    const CHUNK_SIZE = 32768;
    const chunks = [];
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
        chunks.push(String.fromCharCode.apply(null, chunk));
    }
    return btoa(chunks.join(''));
}

/**
 * Decode Base64 string to Uint8Array.
 *
 * @param {string} base64 - Base64 encoded string
 * @returns {Uint8Array} Decoded binary data
 */
function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

// ============================================================================
// RPC Serialization
// ============================================================================

/**
 * Serialize a value for RPC transmission (async version).
 * Converts Uint8Array to Base64 format for efficient transfer.
 * Uses async encoding to prevent UI blocking for large binary data.
 *
 * Performance: Base64 encoding is ~33% larger than binary but significantly faster
 * and more compact than array-of-numbers JSON serialization (which was ~300% larger).
 *
 * @param {*} value - Value to serialize
 * @returns {Promise<*>} Serialized value
 */
async function serializeValueAsync(value) {
    // Handle Uint8Array by converting to Base64 marker object
    if (value instanceof Uint8Array) {
        const base64 = await uint8ArrayToBase64Async(value);
        return { __type: 'Uint8Array', base64 };
    }
    // Handle other ArrayBuffer views (like DataView)
    if (ArrayBuffer.isView(value)) {
        const uint8 = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        const base64 = await uint8ArrayToBase64Async(uint8);
        return { __type: 'Uint8Array', base64 };
    }
    // Recursively serialize arrays
    if (Array.isArray(value)) {
        return Promise.all(value.map(serializeValueAsync));
    }
    // Recursively serialize plain object properties only
    // Using Object.prototype.toString for robust object detection (handles null prototype)
    if (value && typeof value === 'object' && Object.prototype.toString.call(value) === '[object Object]') {
        const result = {};
        for (const key of Object.keys(value)) {
            result[key] = await serializeValueAsync(value[key]);
        }
        return result;
    }
    return value;
}

/**
 * Serialize arguments array for RPC transmission (async version).
 * @param {Array} args - Arguments to serialize
 * @returns {Promise<Array>} Serialized arguments
 */
async function serializeArgsAsync(args) {
    assertWebviewTransportPayload(args, {
        surface: WEBVIEW_TRANSPORT_SURFACES.webviewRequest
    });
    return Promise.all(args.map(serializeValueAsync));
}

/**
 * Deserialize a value from RPC response.
 * Converts serialized Uint8Array markers back to actual Uint8Array instances.
 * Supports both Base64 format (new) and array format (legacy) for backward compatibility.
 *
 * Security: Only deserializes objects that have exactly the expected marker keys
 * to prevent marker collision with user data.
 *
 * @param {*} value - Value to deserialize
 * @returns {*} Deserialized value
 */
function deserializeValue(value) {
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    // Check for Uint8Array serialization marker from extension host
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const keys = Object.keys(value);

        // Check for Base64 format (new, preferred): { __type: 'Uint8Array', base64: '...' }
        if (value.__type === 'Uint8Array' && typeof value.base64 === 'string') {
            if (keys.length === 2 && keys.includes('__type') && keys.includes('base64')) {
                return base64ToUint8Array(value.base64);
            }
        }

        // Check for array format (legacy): { __type: 'Uint8Array', data: [...] }
        if (value.__type === 'Uint8Array' && Array.isArray(value.data)) {
            if (keys.length === 2 && keys.includes('__type') && keys.includes('data')) {
                return new Uint8Array(value.data);
            }
        }

        // Recursively deserialize object properties
        const result = {};
        for (const key of Object.keys(value)) {
            result[key] = deserializeValue(value[key]);
        }
        return result;
    }
    if (Array.isArray(value)) {
        return value.map(deserializeValue);
    }
    return value;
}

/**
 * Send an RPC request to the extension host.
 * Uses async serialization to prevent UI blocking during large blob encoding.
 */
export async function sendRpcRequest(method, args) {
    const messageId = `rpc_${++rpcMessageId}_${Date.now()}`;

    // Measure the complete raw envelope before Base64 can allocate an expanded
    // copy of any binary argument.
    assertWebviewTransportPayload({
        channel: 'rpc',
        content: { kind: 'invoke', messageId, targetMethod: method, payload: args }
    }, {
        surface: WEBVIEW_TRANSPORT_SURFACES.webviewRequest
    });

    // Serialize args asynchronously to handle Uint8Array without blocking UI
    // This is done before setting up the timeout to ensure encoding time is included
    const serializedArgs = await serializeArgsAsync(args);
    const outboundMessage = {
        channel: 'rpc',
        content: {
            kind: 'invoke',
            messageId,
            targetMethod: method,
            payload: serializedArgs
        }
    };
    assertWebviewTransportPayload(outboundMessage, {
        surface: WEBVIEW_TRANSPORT_SURFACES.webviewRequest
    });

    return new Promise((resolve, reject) => {
        const timeoutMs = getRpcTimeoutMs(method);
        const timeoutId = timeoutMs === undefined ? undefined : setTimeout(() => {
            if (pendingRpcCalls.has(messageId)) {
                pendingRpcCalls.delete(messageId);
                reject(new Error(`RPC timeout: ${method}`));
            }
        }, timeoutMs);

        pendingRpcCalls.set(messageId, { resolve, reject, timeoutId });

        if (vscodeApi) {
            vscodeApi.postMessage(outboundMessage);
        } else {
            console.warn('VS Code API not available');
        }
    });
}

/**
 * Handle an RPC response from the extension host.
 * Called by the message listener in rpc.js.
 */
export function handleRpcResponse(message) {
    if (!message || message.kind !== 'response') return;

    const pending = pendingRpcCalls.get(message.messageId);
    if (pending) {
        if (pending.timeoutId !== undefined) clearTimeout(pending.timeoutId);
        pendingRpcCalls.delete(message.messageId);

        try {
            assertWebviewTransportPayload(message, {
                surface: WEBVIEW_TRANSPORT_SURFACES.hostResponse
            });
            if (message.success) {
                const deserializedData = deserializeValue(message.data);
                pending.resolve(deserializedData);
            } else {
                pending.reject(errorFromRpcResponse(message));
            }
        } catch (error) {
            pending.reject(error);
        }
    }
}

/**
 * Send an RPC result (response) back to the extension host.
 * Called when the host invokes a method on the webview.
 */
export function sendRpcResult(correlationId, result) {
    const message = {
        kind: 'result',
        correlationId,
        payload: result
    };
    assertWebviewTransportPayload(message, {
        surface: WEBVIEW_TRANSPORT_SURFACES.webviewResponse
    });
    if (vscodeApi) {
        vscodeApi.postMessage(message);
    }
}

/**
 * Send an RPC error back to the extension host.
 */
export function sendRpcError(correlationId, error) {
    const message = {
        kind: 'result',
        correlationId,
        errorText: error instanceof Error ? error.message : String(error),
        ...rpcErrorFields(error)
    };
    assertWebviewTransportPayload(message, {
        surface: WEBVIEW_TRANSPORT_SURFACES.webviewResponse
    });
    if (vscodeApi) {
        vscodeApi.postMessage(message);
    }
}

// Backend API proxy
export const backendApi = {
    initialize: () => sendRpcRequest('initialize', []),
    exportDb: (filename) => sendRpcRequest('exportDb', [filename]),
    refreshFile: () => sendRpcRequest('refreshFile', []),
    fireEditEvent: (edit) => sendRpcRequest('fireEditEvent', [edit]),
    exportTable: (dbParams, columns, dbOptions, tableStore, exportOptions, extras) => sendRpcRequest('exportTable', [dbParams, columns, dbOptions, tableStore, exportOptions, extras]),

    // New safe methods
    updateCell: (table, rowId, column, value, originalValue) => sendRpcRequest('updateCell', [table, rowId, column, value, originalValue]),
    insertRow: (table, data) => sendRpcRequest('insertRow', [table, data]),
    deleteRows: (table, rowIds) => sendRpcRequest('deleteRows', [table, rowIds]),
    deleteColumns: (table, columns) => sendRpcRequest('deleteColumns', [table, columns]),
    createTable: (table, columns) => sendRpcRequest('createTable', [table, columns]),
    getViewDefinition: (view) => sendRpcRequest('getViewDefinition', [view]),
    validateViewDefinition: (view, selectSql, intent) =>
        sendRpcRequest('validateViewDefinition', [view, selectSql, intent]),
    previewViewDefinition: (view, selectSql, limit, intent) =>
        sendRpcRequest('previewViewDefinition', [view, selectSql, limit, intent]),
    createView: (view, selectSql) => sendRpcRequest('createView', [view, selectSql]),
    editView: (view, selectSql, preserveTriggers, expectedSql, expectedTriggers) =>
        sendRpcRequest('editView', [
            view,
            selectSql,
            preserveTriggers,
            expectedSql,
            expectedTriggers
        ]),
    dropView: (view) => sendRpcRequest('dropView', [view]),
    updateCellBatch: (table, updates, label) => sendRpcRequest('updateCellBatch', [table, updates, label]),
    addColumn: (table, column, type, defaultValue) => sendRpcRequest('addColumn', [table, column, type, defaultValue]),
    fetchTableData: (table, options) => sendRpcRequest('fetchTableData', [table, options]),
    fetchTableCount: (table, options) => sendRpcRequest('fetchTableCount', [table, options]),
    fetchSchema: () => sendRpcRequest('fetchSchema', []),
    getTableInfo: (table) => sendRpcRequest('getTableInfo', [table]),
    getPragmas: () => sendRpcRequest('getPragmas', []),
    setPragma: (pragma, value) => sendRpcRequest('setPragma', [pragma, value]),
    getExtensionSettings: () => sendRpcRequest('getExtensionSettings', []),
    updateExtensionSetting: (key, value) => sendRpcRequest('updateExtensionSetting', [key, value]),
    ping: () => sendRpcRequest('ping', []),
    prepareCellMediaPreview: (params, rowId, colName, options) =>
        sendRpcRequest('prepareCellMediaPreview', [params, rowId, colName, options]),
    releaseCellMediaPreview: (webviewId, previewId) =>
        sendRpcRequest('releaseCellMediaPreview', [webviewId, previewId]),
    openCellEditor: (params, rowId, colName, colTypes, options) => sendRpcRequest('openCellEditor', [params, rowId, colName, colTypes, options]),
    openViewEditor: (view, webviewId) => sendRpcRequest('openViewEditor', [view, webviewId]),
    readWorkspaceFileUri: (uri) => sendRpcRequest('readWorkspaceFileUri', [uri]),
    saveFile: (filename, data) => sendRpcRequest('saveFile', [filename, data]),
    selectFile: () => sendRpcRequest('selectFile', []),
    triggerUndo: () => sendRpcRequest('triggerUndo', []),
    triggerRedo: () => sendRpcRequest('triggerRedo', [])
};
