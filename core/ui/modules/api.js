/**
 * API Client Module
 * Handles outgoing RPC requests to the extension host.
 */

const vscodeApi = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : null;

// Message ID tracking
let rpcMessageId = 0;
const pendingRpcCalls = new Map();

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
        }, 30000);

        pendingRpcCalls.set(messageId, { resolve, reject, timeoutId });

        if (vscodeApi) {
            vscodeApi.postMessage({
                channel: 'rpc',
                content: {
                    kind: 'invoke',
                    messageId,
                    targetMethod: method,
                    payload: args
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
            pending.resolve(message.data);
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
    readWorkspaceFileUri: (uri) => sendRpcRequest('readWorkspaceFileUri', [uri])
};
