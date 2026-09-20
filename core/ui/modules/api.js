/**
 * API Client Module
 * Handles outgoing RPC requests to the extension host.
 */

import { RPC_TIMEOUT_MS, getRpcTimeoutMs } from './rpc-constants.js';
import {
    WEBVIEW_TRANSPORT_SURFACES,
    assertWebviewTransportPayload,
    decodeJsonSafeNumberString,
    encodeJsonSafeNonFiniteNumber,
    errorFromRpcResponse,
    escapeJsonSafeNumberString,
    rpcErrorFields
} from './transport.js';
import { getErrorMessage } from './utils.js';
import { encodeBinaryBase64 } from './binary-encoding.js';

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
async function serializeValueAsync(value, signal) {
    signal?.throwIfAborted();
    if (typeof value === 'number' && !Number.isFinite(value)) {
        return encodeJsonSafeNonFiniteNumber(value);
    }
    if (typeof value === 'string') return escapeJsonSafeNumberString(value);
    // Handle Uint8Array by converting to Base64 marker object
    if (value instanceof Uint8Array) {
        const base64 = await encodeBinaryBase64(value, signal);
        return { __type: 'Uint8Array', base64 };
    }
    // Handle other ArrayBuffer views (like DataView)
    if (ArrayBuffer.isView(value)) {
        const uint8 = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        const base64 = await encodeBinaryBase64(uint8, signal);
        return { __type: 'Uint8Array', base64 };
    }
    // Recursively serialize arrays
    if (Array.isArray(value)) {
        return Promise.all(value.map(item => serializeValueAsync(item, signal)));
    }
    // Recursively serialize plain object properties only
    // Using Object.prototype.toString for robust object detection (handles null prototype)
    if (value && typeof value === 'object' && Object.prototype.toString.call(value) === '[object Object]') {
        const result = {};
        for (const key of Object.keys(value)) {
            Object.defineProperty(result, key, {
                value: await serializeValueAsync(value[key], signal),
                enumerable: true,
                configurable: true,
                writable: true
            });
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
async function serializeArgsAsync(args, signal) {
    assertWebviewTransportPayload(args, {
        surface: WEBVIEW_TRANSPORT_SURFACES.webviewRequest
    });
    return Promise.all(args.map(value => serializeValueAsync(value, signal)));
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
    if (typeof value === 'string') return decodeJsonSafeNumberString(value);
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
            Object.defineProperty(result, key, {
                value: deserializeValue(value[key]),
                enumerable: true,
                configurable: true,
                writable: true
            });
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
export async function sendRpcRequest(method, args, options = {}) {
    options.signal?.throwIfAborted();
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
    // Cancellation is safe until posting; after posting, await the actual result.
    const serializedArgs = await serializeArgsAsync(args, options.signal);
    options.signal?.throwIfAborted();
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

        try {
            if (!vscodeApi) throw new Error('VS Code API not available');
            vscodeApi.postMessage(outboundMessage);
            options.onDidPost?.();
        } catch (error) {
            if (pendingRpcCalls.delete(messageId)) {
                if (timeoutId !== undefined) clearTimeout(timeoutId);
                reject(error);
            }
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
        errorText: getErrorMessage(error),
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
    refreshFile: () => sendRpcRequest('refreshFile', []),
    saveSidebarState: (side, position) => sendRpcRequest('saveSidebarState', [side, position]),
    exportTable: (dbParams, columns, dbOptions, tableStore, exportOptions, extras) => sendRpcRequest('exportTable', [dbParams, columns, dbOptions, tableStore, exportOptions, extras]),

    // New safe methods
    updateCell: (table, rowId, column, value, originalValue, options) =>
        sendRpcRequest('updateCell', [table, rowId, column, value, originalValue], options),
    insertRow: (table, data) => sendRpcRequest('insertRow', [table, data]),
    deleteRows: (table, rowIds) => sendRpcRequest('deleteRows', [table, rowIds]),
    deleteColumns: (table, columns) => sendRpcRequest('deleteColumns', [table, columns]),
    // An absent array argument becomes null in VS Code's JSON transport.
    createTable: (table, columns, options) => sendRpcRequest('createTable',
        options === undefined ? [table, columns] : [table, columns, options]),
    getViewDefinition: (view) => sendRpcRequest('getViewDefinition', [view]),
    validateViewDefinition: (view, selectSql, intent) =>
        sendRpcRequest('validateViewDefinition', [view, selectSql, intent]),
    openQueryEditor: () => sendRpcRequest('openQueryEditor', []),
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
    confirmLargeSelection: (itemCount, unit) =>
        sendRpcRequest('confirmLargeSelection', [itemCount, unit]),
    confirmLargeChanges: (itemCount, unit) => sendRpcRequest('confirmLargeChanges', [itemCount, unit]),
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
    cancelCellMediaPreview: (webviewId, requestId) =>
        sendRpcRequest('cancelCellMediaPreview', [webviewId, requestId]),
    releaseCellMediaPreview: (webviewId, previewId) =>
        sendRpcRequest('releaseCellMediaPreview', [webviewId, previewId]),
    openCellReadSession: (target) => sendRpcRequest('openCellReadSession', [target]),
    readCellChunk: (sessionId, byteOffset, maxBytes) =>
        sendRpcRequest('readCellChunk', [sessionId, byteOffset, maxBytes]),
    closeCellReadSession: (sessionId) =>
        sendRpcRequest('closeCellReadSession', [sessionId]),
    openCellEditor: (params, rowId, colName, colTypes, options) => sendRpcRequest('openCellEditor', [params, rowId, colName, colTypes, options]),
    openViewEditor: (view, webviewId) => sendRpcRequest('openViewEditor', [view, webviewId]),
    readWorkspaceFileUri: (uri, options) => sendRpcRequest('readWorkspaceFileUri', [uri], options),
    saveFile: (filename, data) => sendRpcRequest('saveFile', [filename, data]),
    selectFile: () => sendRpcRequest('selectFile', [])
};
