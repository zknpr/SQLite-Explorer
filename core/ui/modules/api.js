/**
 * API Client Module
 * Handles outgoing RPC requests to the extension host.
 */

const vscodeApi = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : null;

// Default RPC timeout in milliseconds (60s to accommodate large blob operations)
const RPC_TIMEOUT_MS = 60000;

// Message ID tracking
let rpcMessageId = 0;
const pendingRpcCalls = new Map();

// ============================================================================
// Base64 Encoding Utilities
// ============================================================================

/**
 * Encode Uint8Array to Base64 string.
 * Uses native btoa with chunked processing to avoid call stack limits on large arrays.
 *
 * @param {Uint8Array} bytes - Binary data to encode
 * @returns {string} Base64 encoded string
 */
function uint8ArrayToBase64(bytes) {
    // Process in 32KB chunks to avoid call stack size limits with String.fromCharCode.apply
    const CHUNK_SIZE = 32768;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
        binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
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
 * Serialize a value for RPC transmission.
 * Converts Uint8Array to Base64 format for efficient transfer.
 *
 * Performance: Base64 encoding is ~33% larger than binary but significantly faster
 * and more compact than array-of-numbers JSON serialization (which was ~300% larger).
 *
 * @param {*} value - Value to serialize
 * @returns {*} Serialized value
 */
function serializeValue(value) {
    // Handle Uint8Array by converting to Base64 marker object
    if (value instanceof Uint8Array) {
        return { __type: 'Uint8Array', base64: uint8ArrayToBase64(value) };
    }
    // Handle other ArrayBuffer views (like DataView)
    if (ArrayBuffer.isView(value)) {
        const uint8 = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        return { __type: 'Uint8Array', base64: uint8ArrayToBase64(uint8) };
    }
    // Recursively serialize arrays
    if (Array.isArray(value)) {
        return value.map(serializeValue);
    }
    // Recursively serialize plain object properties only
    // Using Object.prototype.toString for robust object detection (handles null prototype)
    if (value && typeof value === 'object' && Object.prototype.toString.call(value) === '[object Object]') {
        const result = {};
        for (const key of Object.keys(value)) {
            result[key] = serializeValue(value[key]);
        }
        return result;
    }
    return value;
}

/**
 * Serialize arguments array for RPC transmission.
 * @param {Array} args - Arguments to serialize
 * @returns {Array} Serialized arguments
 */
function serializeArgs(args) {
    return args.map(serializeValue);
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
 */
export function sendRpcRequest(method, args) {
    return new Promise((resolve, reject) => {
        const messageId = `rpc_${++rpcMessageId}_${Date.now()}`;

        const timeoutId = setTimeout(() => {
            if (pendingRpcCalls.has(messageId)) {
                pendingRpcCalls.delete(messageId);
                reject(new Error(`RPC timeout: ${method}`));
            }
        }, RPC_TIMEOUT_MS);

        pendingRpcCalls.set(messageId, { resolve, reject, timeoutId });

        if (vscodeApi) {
            // Serialize args to handle Uint8Array and other non-JSON-safe types
            const serializedArgs = serializeArgs(args);
            vscodeApi.postMessage({
                channel: 'rpc',
                content: {
                    kind: 'invoke',
                    messageId,
                    targetMethod: method,
                    payload: serializedArgs
                }
            });
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
        clearTimeout(pending.timeoutId);
        pendingRpcCalls.delete(message.messageId);

        if (message.success) {
            // Deserialize the response data to restore Uint8Array instances
            const deserializedData = deserializeValue(message.data);
            pending.resolve(deserializedData);
        } else {
            pending.reject(new Error(message.errorMessage || 'RPC failed'));
        }
    }
}

/**
 * Send an RPC result (response) back to the extension host.
 * Called when the host invokes a method on the webview.
 */
export function sendRpcResult(correlationId, result) {
    if (vscodeApi) {
        vscodeApi.postMessage({
            kind: 'result',
            correlationId,
            payload: result
        });
    }
}

/**
 * Send an RPC error back to the extension host.
 */
export function sendRpcError(correlationId, errorText) {
    if (vscodeApi) {
        vscodeApi.postMessage({
            kind: 'result',
            correlationId,
            errorText
        });
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
    openCellEditor: (params, rowId, colName, colTypes, options) => sendRpcRequest('openCellEditor', [params, rowId, colName, colTypes, options]),
    readWorkspaceFileUri: (uri) => sendRpcRequest('readWorkspaceFileUri', [uri]),
    saveFile: (filename, data) => sendRpcRequest('saveFile', [filename, data]),
    selectFile: () => sendRpcRequest('selectFile', []),
    triggerUndo: () => sendRpcRequest('triggerUndo', []),
    triggerRedo: () => sendRpcRequest('triggerRedo', [])
};
