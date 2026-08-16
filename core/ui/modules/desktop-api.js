/**
 * Desktop API Client Module
 *
 * Replacement for the VS Code api.js module that talks directly to the
 * Tauri desktop host instead of posting messages across a parentWindow/
 * iframe boundary. The webview page IS the host process (see
 * desktop-host.js's own header comment), so there is no cross-context
 * transport to serialize for: every backendApi call goes straight through
 * host.invoke(method, args), set once via initDesktopApi(host).
 */

import { RPC_TIMEOUT_MS, getRpcTimeoutMs } from './rpc-constants.js';
import { MAX_WEBVIEW_BINARY_VALUE_BYTES } from './transport.js';
import { DEFAULT_MAX_INLINE_CELL_BYTES } from '../../../src/core/cell-containment.ts';
import {
    formatOversizedCellReplacementWarning,
    isOversizedCellReplacementConflictError
} from '../../../src/core/cell-edit-policy.ts';

export { RPC_TIMEOUT_MS, getRpcTimeoutMs };

let host = null;
export function initDesktopApi(hostInstance) { host = hostInstance; }

export async function sendRpcRequest(method, args) {
    if (!host) throw new Error('Desktop host not initialized');
    const timeoutMs = getRpcTimeoutMs(method);
    const invocation = host.invoke(method, args);
    if (timeoutMs === undefined) return invocation;
    return Promise.race([
        invocation,
        new Promise((_, reject) => setTimeout(
            () => reject(new Error(`RPC timeout: ${method}`)), timeoutMs))
    ]);
}

// Import-parity no-ops: the desktop build has no message channel.
export function handleRpcResponse(_message) {}
export function sendRpcResult(_correlationId, _result) {}
export function sendRpcError(_correlationId, _error) {}

const VIEW_STATE_KEY = 'sqlite-explorer-view-state';
export function getVsCodeState() {
    try {
        const raw = globalThis.localStorage?.getItem(VIEW_STATE_KEY);
        return raw ? JSON.parse(raw) : undefined;
    } catch { return undefined; }
}
export function saveVsCodeState(stateObj) {
    try { globalThis.localStorage?.setItem(VIEW_STATE_KEY, JSON.stringify(stateObj)); } catch { /* non-fatal */ }
}

// Backend API proxy
export const backendApi = {
    initialize: () => sendRpcRequest('initialize', []),
    saveSidebarState: (state) => sendRpcRequest('saveSidebarState', [state]),
    exportDb: (filename) => sendRpcRequest('exportDb', [filename]),
    refreshFile: () => sendRpcRequest('refreshFile', []),
    fireEditEvent: (edit) => sendRpcRequest('fireEditEvent', [edit]),
    exportTable: (dbParams, columns, dbOptions, tableStore, exportOptions, extras) =>
        sendRpcRequest('exportTable', [dbParams, columns, dbOptions, tableStore, exportOptions, extras]),

    // Database operations
    updateCell: async (table, rowId, column, value, originalValue) => {
        while (true) {
            const metadata = await sendRpcRequest('getCellMetadata', [{
                table,
                rowId,
                column
            }]);
            if (
                (metadata.storageClass === 'text' || metadata.storageClass === 'blob')
                && metadata.byteLength > DEFAULT_MAX_INLINE_CELL_BYTES
            ) {
                if (!window.confirm(formatOversizedCellReplacementWarning(
                    table,
                    column,
                    metadata
                ))) {
                    throw new Error('Oversized cell replacement cancelled');
                }
                try {
                    return await sendRpcRequest('replaceOversizedCell', [
                        table,
                        rowId,
                        column,
                        value,
                        {
                            storageClass: metadata.storageClass,
                            byteLength: metadata.byteLength
                        },
                        DEFAULT_MAX_INLINE_CELL_BYTES
                    ]);
                } catch (error) {
                    if (isOversizedCellReplacementConflictError(error)) continue;
                    throw error;
                }
            }
            return sendRpcRequest('updateCell', [
                table,
                rowId,
                column,
                value,
                originalValue,
                DEFAULT_MAX_INLINE_CELL_BYTES
            ]);
        }
    },
    getCellMetadata: (target) => sendRpcRequest('getCellMetadata', [target]),
    openCellReadSession: (target) => sendRpcRequest('openCellReadSession', [target]),
    readCellChunk: (sessionId, byteOffset, maxBytes) =>
        sendRpcRequest('readCellChunk', [sessionId, byteOffset, maxBytes]),
    closeCellReadSession: (sessionId) =>
        sendRpcRequest('closeCellReadSession', [sessionId]),
    insertRow: (table, data) => sendRpcRequest(
        'insertRow',
        [table, data, DEFAULT_MAX_INLINE_CELL_BYTES]
    ),
    deleteRows: (table, rowIds) => sendRpcRequest('deleteRows', [table, rowIds]),
    deleteColumns: (table, columns) => sendRpcRequest('deleteColumns', [table, columns]),
    createTable: (table, columns) => sendRpcRequest('createTable', [table, columns]),
    getViewDefinition: (view) => sendRpcRequest('getViewDefinition', [view]),
    validateViewDefinition: (view, selectSql, intent) =>
        sendRpcRequest('validateViewDefinition', [view, selectSql, intent]),
    previewViewDefinition: (view, selectSql, limit, intent) =>
        sendRpcRequest('previewViewDefinition', [view, selectSql, limit, intent]),
    createView: (view, selectSql) => sendRpcRequest('createView', [view, selectSql]),
    editView: async (view, selectSql, preserveTriggers, expectedSql, expectedTriggers) => {
        let triggerSnapshot = expectedTriggers;
        if (!preserveTriggers) {
            const current = await sendRpcRequest('getViewDefinition', [view]);
            // Bind the mutation to the exact trigger set shown in this dialog;
            // the worker rechecks it atomically inside the edit savepoint.
            triggerSnapshot ??= current.triggers ?? [];
            if (current.triggers?.length > 0) {
                const triggerNames = current.triggers.map(trigger => trigger.identifier).join(', ');
                if (!window.confirm(
                    `Editing view "${view}" without preserving triggers will permanently drop ` +
                    `these INSTEAD OF triggers: ${triggerNames}. Continue?`
                )) {
                    return { cancelled: true };
                }
            }
        }
        return sendRpcRequest('editView', [
            view,
            selectSql,
            preserveTriggers,
            expectedSql,
            triggerSnapshot
        ]);
    },
    dropView: async (view) => {
        const current = await sendRpcRequest('getViewDefinition', [view]);
        const triggerSnapshot = current.triggers ?? [];
        const triggerNames = triggerSnapshot.map(trigger => trigger.identifier).join(', ');
        const message = triggerNames
            ? `Drop view "${view}"? This will permanently drop its INSTEAD OF triggers: ${triggerNames}.`
            : `Drop view "${view}"?`;
        if (!window.confirm(message)) {
            return { cancelled: true };
        }
        return sendRpcRequest('dropView', [view, current.sql, triggerSnapshot]);
    },
    updateCellBatch: (table, updates, label) => sendRpcRequest(
        'updateCellBatch',
        [table, updates, label, DEFAULT_MAX_INLINE_CELL_BYTES]
    ),
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
    prepareCellMediaPreview: (_params, _rowId, _colName, options = {}) => {
        const sourceBytes = Number.isSafeInteger(options.sourceByteLength)
            ? options.sourceByteLength
            : 'unknown';
        return Promise.resolve({
            success: false,
            message:
                `Oversized media preview refused in the web demo: ${sourceBytes} bytes ` +
                `exceeds the ${MAX_WEBVIEW_BINARY_VALUE_BYTES}-byte webview binary limit. ` +
                'Only the bounded Text/Hex preview is available; transferable streaming is not implemented.'
        });
    },
    releaseCellMediaPreview: () => Promise.resolve(),
    openCellEditor: (_params, _rowId, _colName, _colTypes, options = {}) => Promise.resolve({
        success: false,
        message:
            `Full oversized content (${options.sourceByteLength ?? 'unknown'} bytes) is unavailable ` +
            'in the web demo; use the bounded Text/Hex preview.'
    }),
    openViewEditor: () => Promise.resolve({ success: false, message: 'Not available in web mode' }),
    readWorkspaceFileUri: () => Promise.resolve(null),
    triggerUndo: () => sendRpcRequest('triggerUndo', []),
    triggerRedo: () => sendRpcRequest('triggerRedo', []),

    // Web-compatible implementations for Blob Inspector
    saveFile: (filename, data) => sendRpcRequest('saveFile', [filename, data]),
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
