/**
 * RPC Communication Layer
 */
import { state, persistState } from './state.js';
import { clearSelection, loadTableData, loadTableColumns } from './grid.js';
import { refreshSchema } from './sidebar.js';
import { handleRpcResponse, sendRpcResult, sendRpcError } from './api.js';
import { applyConnectionResult, updateMutationControlCapabilities } from './connection-state.js';
import { invalidateAllCounts } from './count-cache.js';
import { showErrorState, showLoading, updateStatus, updateToolbarButtons } from './ui.js';
import { closeDatabaseTargetModals } from './modals.js';
import { getErrorMessage } from './utils.js';

export { backendApi } from './api.js';

/**
 * Methods called by the extension host.
 */
export async function refreshContent(filename, connectionResult) {
    // This broadcast means the document changed in a way this webview didn't
    // perform itself (undo/redo, another panel's edit, a VS Code cell-editor
    // write, revert — the host also echoes one after this webview's own
    // edits). None of the cached counts can be trusted across it.
    invalidateAllCounts();
    const contentGeneration = ++state.contentGeneration;
    state.isRefreshingContent = true;
    updateMutationControlCapabilities();
    const priorConnectionGeneration = state.connectionGeneration;
    if (connectionResult) {
        applyConnectionResult(connectionResult);
    }
    const connectionReplaced = connectionResult
        && state.connectionGeneration !== priorConnectionGeneration;
    closeDatabaseTargetModals({ connectionReplaced });
    // A row ID can be deleted and reused by another panel without replacing
    // the connection. Clear every positional/targeted intent synchronously,
    // before the first schema await exposes the stale grid again.
    clearSelection();
    state.pinnedRowIds.clear();
    state.editingCellInfo = null;
    state.activeCellInput = null;
    updateToolbarButtons();
    try {
      if (state.isDbConnected) {
        if (connectionReplaced) {
            clearSelection();
            state.pinnedRowIds.clear();
            state.pinnedColumns.clear();
            state.tableColumns = [];
            state.gridData = [];
            state.gridExactIntegerTexts = {};
            state.gridOversizedCells = {};
            state.gridReadOnlyRowReasons = {};
            state.keysetAnchors = null;
            state.renderedTable = null;
            state.editingCellInfo = null;
            state.activeCellInput = null;
            showLoading();
            updateToolbarButtons();
            persistState();
        }
        // A broadcast view refresh may replace its projection and row order.
        // Clear positional state before any async reload so another webview's
        // edit cannot leave this panel's controls targeting unrelated cells.
        if (state.selectedTable && state.selectedTableType === 'view') persistState();

        // Refresh schema to reflect added/removed tables or views
        if (!await refreshSchema()) return { success: false, superseded: true };

        // Validate if selected table still exists
        const tableExists = state.schemaCache.tables.some(t => t.name === state.selectedTable) ||
                            state.schemaCache.views.some(v => v.name === state.selectedTable);

        if (!tableExists && state.selectedTable) {
            // Table was deleted (e.g. undo create table)
            clearSelection();
            state.selectedTable = null;
            state.selectedTableType = null;
            state.selectedTableIdentity = null;
            // Show empty state
            document.getElementById('tableNameLabel').textContent = 'No table selected';
            document.getElementById('gridContainer').innerHTML = `
                <div class="empty-view">
                    <span class="empty-icon codicon codicon-database"></span>
                    <span class="empty-title">Select a table</span>
                    <span class="empty-desc">Choose a table from the sidebar to view data</span>
                </div>
            `;
            persistState();
            updateToolbarButtons();
        } else if (state.selectedTable) {
            // Refresh columns to reflect added/removed columns
            if (await loadTableColumns()) {
                // Refresh data to reflect row changes
                await loadTableData(false);
            } else if (connectionReplaced) {
                showErrorState('Could not load table columns after reloading the database.');
            }
        }
      }
      return { success: true };
    } catch (error) {
      const message = getErrorMessage(error);
      showErrorState(`Refresh failed: ${message}`);
      updateStatus(`Refresh failed: ${message}`);
      throw error;
    } finally {
      if (state.contentGeneration === contentGeneration) {
        state.isRefreshingContent = false;
        updateMutationControlCapabilities();
        updateToolbarButtons();
      }
    }
}

const webviewMethods = {
    refreshContent,

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
                        sendRpcError(correlationId, err);
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
