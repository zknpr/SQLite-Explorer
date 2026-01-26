/**
 * RPC Communication Layer
 */
import { state } from './state.js';
import { loadTableData } from './grid.js';
import { handleRpcResponse, sendRpcResult, sendRpcError } from './api.js';

export { backendApi } from './api.js';

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
        state.cellEditBehavior = value;
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
                        sendRpcResult(correlationId, result);
                    })
                    .catch(err => {
                        sendRpcError(correlationId, err instanceof Error ? err.message : String(err));
                    });
            } else {
                sendRpcError(correlationId, `Unknown method: ${methodName}`);
            }
            return;
        }

        // Handle RPC responses from extension
        if (!envelope || envelope.channel !== 'rpc') return;

        const message = envelope.content;
        if (message && message.kind === 'response') {
            handleRpcResponse(message);
        }
    });
}
