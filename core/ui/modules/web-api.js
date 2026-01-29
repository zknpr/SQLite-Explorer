/**
 * Web Demo API Client Module
 *
 * Replacement for the VS Code api.js module that communicates
 * with the parent window instead of VS Code API.
 * This allows the viewer to work standalone in a browser.
 */

// Use parent window for RPC instead of VS Code API
const parentWindow = window.parent;

// Message ID tracking
let rpcMessageId = 0;
const pendingRpcCalls = new Map();

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
        }, 30000);

        pendingRpcCalls.set(messageId, { resolve, reject, timeoutId });

        // Post message to parent window instead of VS Code API
        parentWindow.postMessage({
            channel: 'rpc',
            content: {
                kind: 'invoke',
                messageId,
                targetMethod: method,
                payload: args
            }
        }, '*');
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
            pending.resolve(message.data);
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
    }, '*');
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
    }, '*');
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
    triggerRedo: () => Promise.resolve()
};
