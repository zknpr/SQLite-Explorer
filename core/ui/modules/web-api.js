/**
 * Web Demo API Client Module
 *
 * Replacement for the VS Code api.js module that communicates
 * with the parent window instead of VS Code API.
 * This allows the viewer to work standalone in a browser.
 */

// Use parent window for RPC instead of VS Code API
const parentWindow = window.parent;

// Default RPC timeout in milliseconds
const RPC_TIMEOUT_MS = 30000;

// Message ID tracking
let rpcMessageId = 0;
const pendingRpcCalls = new Map();

// Helper to determine target origin
function getTargetOrigin() {
    return window.location.ancestorOrigins?.[0] || '*';
}

/**
 * Serialize a value for RPC transmission.
 * Converts Uint8Array to a serializable format since JSON.stringify produces {} for typed arrays.
 * @param {*} value - Value to serialize
 * @returns {*} Serialized value
 */
function serializeValue(value) {
    if (value instanceof Uint8Array) {
        // Convert to object with type marker and array data
        return { __type: 'Uint8Array', data: Array.from(value) };
    }
    if (Array.isArray(value)) {
        return value.map(serializeValue);
    }
    if (value && typeof value === 'object' && value.constructor === Object) {
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
 * @param {*} value - Value to deserialize
 * @returns {*} Deserialized value
 */
function deserializeValue(value) {
    // Check for Uint8Array serialization marker
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (value.__type === 'Uint8Array' && Array.isArray(value.data)) {
            return new Uint8Array(value.data);
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
 * Send an RPC request to the parent window.
 * @param {string} method - Method name to call
 * @param {Array} args - Arguments for the method
 * @returns {Promise<*>} - Result from parent
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

        // Serialize args to handle Uint8Array and other non-JSON-safe types
        const serializedArgs = serializeArgs(args);

        // Post message to parent window instead of VS Code API
        parentWindow.postMessage({
            channel: 'rpc',
            content: {
                kind: 'invoke',
                messageId,
                targetMethod: method,
                payload: serializedArgs
            }
        }, getTargetOrigin());
    });
}

/**
 * Handle an RPC response from the parent window.
 * @param {Object} message - Response message
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
 * Send an RPC result back to the parent.
 * Called when parent invokes a method on the webview.
 * @param {string} correlationId - Message ID
 * @param {*} result - Result to send
 */
export function sendRpcResult(correlationId, result) {
    parentWindow.postMessage({
        kind: 'result',
        correlationId,
        payload: result
    }, getTargetOrigin());
}

/**
 * Send an RPC error back to the parent.
 * @param {string} correlationId - Message ID
 * @param {string} errorText - Error message
 */
export function sendRpcError(correlationId, errorText) {
    parentWindow.postMessage({
        kind: 'result',
        correlationId,
        errorText
    }, getTargetOrigin());
}

// Backend API proxy
export const backendApi = {
    initialize: () => sendRpcRequest('initialize', []),
    exportDb: (filename) => sendRpcRequest('exportDb', [filename]),
    refreshFile: () => sendRpcRequest('refreshFile', []),
    fireEditEvent: (edit) => sendRpcRequest('fireEditEvent', [edit]),
    exportTable: (dbParams, columns, dbOptions, tableStore, exportOptions, extras) =>
        sendRpcRequest('exportTable', [dbParams, columns, dbOptions, tableStore, exportOptions, extras]),

    // Database operations
    updateCell: (table, rowId, column, value, originalValue) =>
        sendRpcRequest('updateCell', [table, rowId, column, value, originalValue]),
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

    // VS Code specific - disabled in web mode
    openCellEditor: () => Promise.resolve({ success: false, message: 'Not available in web mode' }),
    readWorkspaceFileUri: () => Promise.resolve(null),
    triggerUndo: () => Promise.resolve(),
    triggerRedo: () => Promise.resolve(),

    // Web-compatible implementations for Blob Inspector
    saveFile: (filename, data) => {
        const blob = new Blob([data]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 100);
        return Promise.resolve();
    },
    selectFile: () => {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.style.display = 'none';
            input.onchange = async (e) => {
                if (e.target.files.length > 0) {
                    const file = e.target.files[0];
                    const buffer = await file.arrayBuffer();
                    resolve({
                        name: file.name,
                        data: new Uint8Array(buffer)
                    });
                } else {
                    resolve(undefined);
                }
            };
            document.body.appendChild(input);
            input.click();
            setTimeout(() => document.body.removeChild(input), 1000);
        });
    }
};
