/**
 * RPC Communication Layer
 */
import { state } from './state.js';
import { loadTableData } from './grid.js'; // We'll create this later

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
        }
    });
}

// Backend API proxy
export const backendApi = {
    initialize: () => sendRpcRequest('initialize', []),
    exportDb: (filename) => sendRpcRequest('exportDb', [filename]),
    refreshFile: () => sendRpcRequest('refreshFile', []),
    fireEditEvent: (edit) => sendRpcRequest('fireEditEvent', [edit]),
    exportTable: (dbParams, columns) => sendRpcRequest('exportTable', [dbParams, columns]),

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
    ping: () => sendRpcRequest('ping', [])
};

/**
 * Methods called by the extension host.
 */
const webviewMethods = {
    async refreshContent(filename) {
        if (state.isDbConnected && state.selectedTable) {
            await loadTableData(false);
        }
        return { success: true };
    },

    async updateColorScheme(scheme) {
        document.documentElement.style.colorScheme = scheme;
        return { success: true };
    },

    async updateAutoCommit(value) {
        return { success: true };
    },

    async updateCellEditBehavior(value) {
        return { success: true };
    },

    async updateViewState(state) {
        return { success: true };
    },

    async updateCopilotActive(active) {
        return { success: true };
    }
};

/**
 * Initialize RPC listener.
 */
export function initRpc() {
    window.addEventListener('message', event => {
        const envelope = event.data;

        // Handle RPC invocation from extension
        if (envelope && envelope.kind === 'invoke') {
            const { correlationId, methodName, parameters } = envelope;
            const method = webviewMethods[methodName];

            if (typeof method === 'function') {
                Promise.resolve(method.apply(webviewMethods, parameters || []))
                    .then(result => {
                        if (vscodeApi) {
                            vscodeApi.postMessage({
                                kind: 'result',
                                correlationId,
                                payload: result
                            });
                        }
                    })
                    .catch(err => {
                        if (vscodeApi) {
                            vscodeApi.postMessage({
                                kind: 'result',
                                correlationId,
                                errorText: err instanceof Error ? err.message : String(err)
                            });
                        }
                    });
            } else {
                if (vscodeApi) {
                    vscodeApi.postMessage({
                        kind: 'result',
                        correlationId,
                        errorText: `Unknown method: ${methodName}`
                    });
                }
            }
            return;
        }

        // Handle RPC responses from extension
        if (!envelope || envelope.channel !== 'rpc') return;

        const message = envelope.content;
        if (message && message.kind === 'response') {
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
    });
}
