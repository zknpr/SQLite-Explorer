/**
 * RPC Communication Layer
 */
import { state } from './state.js';
import { loadTableData, loadTableColumns } from './grid.js';
import { refreshSchema } from './sidebar.js';
import { handleRpcResponse, sendRpcResult, sendRpcError } from './api.js';

export { backendApi } from './api.js';

/**
 * Methods called by the extension host.
 */
const webviewMethods = {
    async refreshContent(filename) {
        if (state.isDbConnected) {
            // Refresh schema to reflect added/removed tables or views
            await refreshSchema();

            // Validate if selected table still exists
            const tableExists = state.schemaCache.tables.some(t => t.name === state.selectedTable) ||
                                state.schemaCache.views.some(v => v.name === state.selectedTable);

            if (!tableExists && state.selectedTable) {
                // Table was deleted (e.g. undo create table)
                state.selectedTable = null;
                state.selectedTableType = null;
                // Show empty state
                document.getElementById('tableNameLabel').textContent = 'No table selected';
                document.getElementById('gridContainer').innerHTML = `
                    <div class="empty-view">
                        <span class="empty-icon codicon codicon-database"></span>
                        <span class="empty-title">Select a table</span>
                        <span class="empty-desc">Choose a table from the sidebar to view data</span>
                    </div>
                `;
            } else if (state.selectedTable) {
                // Refresh columns to reflect added/removed columns
                await loadTableColumns();
                // Refresh data to reflect row changes
                await loadTableData(false);
            }
        }
        return { success: true };
    },

    async updateColorScheme(scheme) {
        document.documentElement.style.colorScheme = scheme;
        return { success: true };
    },

    async updateCellEditBehavior(value) {
        state.cellEditBehavior = value;
        return { success: true };
    },

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
