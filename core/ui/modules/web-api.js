/**
 * Web Demo API Client Module
 *
 * Replacement for the VS Code api.js module that communicates
 * with the parent window instead of VS Code API.
 * This allows the viewer to work standalone in a browser.
 */

import { RPC_TIMEOUT_MS, getRpcTimeoutMs } from './rpc-constants.js';
import {
    MAX_WEBVIEW_BINARY_VALUE_BYTES,
    WEBVIEW_TRANSPORT_SURFACES,
    assertWebviewTransportPayload,
    errorFromRpcResponse,
    rpcErrorFields
} from './transport.js';
import {
    DEFAULT_MAX_CELL_EDIT_BYTES,
    formatOversizedCellReplacementWarning,
    isOversizedCellReplacementConflictError
} from '../../../src/core/cell-edit-policy.ts';

export { RPC_TIMEOUT_MS, getRpcTimeoutMs };

// Use parent window for RPC instead of VS Code API
const parentWindow = window.parent;

const ancestorOrigin = window.location.ancestorOrigins?.[0];
let lockedParentOrigin = ancestorOrigin || null;
let resolveParentOrigin;
const parentOriginReady = lockedParentOrigin
    ? Promise.resolve(lockedParentOrigin)
    : new Promise(resolve => {
        resolveParentOrigin = resolve;
    });

/**
 * Accept messages only from the embedding window and lock Firefox-style
 * cross-origin embeds to the browser-verified origin of their first handshake.
 */
export function isTrustedParentMessage(event) {
    if (event.source !== parentWindow) return false;
    if (lockedParentOrigin !== null) return event.origin === lockedParentOrigin;
    if (event.data?.kind !== 'sqlite-explorer-origin' || !event.origin || event.origin === 'null') {
        return false;
    }
    lockedParentOrigin = event.origin;
    resolveParentOrigin?.(lockedParentOrigin);
    resolveParentOrigin = undefined;
    return true;
}

window.addEventListener?.('message', event => {
    isTrustedParentMessage(event);
});

// ancestorOrigins is unavailable on Firefox. The initial ping carries no RPC
// data; it only asks the parent to reply so subsequent messages can be locked
// to event.origin. No payload-bearing message is ever sent to "*".
if (lockedParentOrigin === null) {
    parentWindow.postMessage({ kind: 'sqlite-explorer-ready' }, '*');
}

/**
 * No-op in web demo: VS Code state persistence is not available.
 * @returns {undefined}
 */
export function getVsCodeState() {
    return undefined;
}

/**
 * No-op in web demo: VS Code state persistence is not available.
 * @param {Object} _stateObj - Ignored
 */
export function saveVsCodeState(_stateObj) {
    // No VS Code API available in web demo
}

// Message ID tracking
let rpcMessageId = 0;
const pendingRpcCalls = new Map();

function requireTargetOrigin() {
    if (lockedParentOrigin === null) {
        throw new Error('The parent origin is not locked yet');
    }
    return lockedParentOrigin;
}

// ============================================================================
// Base64 Encoding Utilities
// ============================================================================

/**
 * Encode Uint8Array to Base64 string asynchronously.
 * Uses chunked processing with microtask yields to prevent UI blocking.
 *
 * For small arrays (< 64KB), uses synchronous encoding for speed.
 * For larger arrays, yields control between chunks to keep UI responsive.
 *
 * @param {Uint8Array} bytes - Binary data to encode
 * @returns {Promise<string>} Base64 encoded string
 */
async function uint8ArrayToBase64Async(bytes) {
    // For small arrays, synchronous encoding is fast enough and avoids async overhead
    const SYNC_THRESHOLD = 65536; // 64KB
    if (bytes.length <= SYNC_THRESHOLD) {
        return uint8ArrayToBase64Sync(bytes);
    }

    // For larger arrays, use chunked async encoding to prevent UI freeze
    // Process in chunks and yield to the event loop between chunks
    const CHUNK_SIZE = 32768; // 32KB per chunk
    const chunks = [];

    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
        chunks.push(String.fromCharCode.apply(null, chunk));

        // Yield to event loop every few chunks to allow UI updates
        // Using a microtask (Promise.resolve) for minimal delay while still allowing repaints
        if (i > 0 && (i / CHUNK_SIZE) % 4 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    return btoa(chunks.join(''));
}

/**
 * Synchronous Base64 encoding for small arrays.
 * Used when async overhead isn't worth it.
 *
 * @param {Uint8Array} bytes - Binary data to encode
 * @returns {string} Base64 encoded string
 */
function uint8ArrayToBase64Sync(bytes) {
    const CHUNK_SIZE = 32768;
    const chunks = [];
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
        chunks.push(String.fromCharCode.apply(null, chunk));
    }
    return btoa(chunks.join(''));
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
async function serializeValueAsync(value) {
    // Handle Uint8Array by converting to Base64 marker object
    if (value instanceof Uint8Array) {
        const base64 = await uint8ArrayToBase64Async(value);
        return { __type: 'Uint8Array', base64 };
    }
    // Handle other ArrayBuffer views (like DataView)
    if (ArrayBuffer.isView(value)) {
        const uint8 = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        const base64 = await uint8ArrayToBase64Async(uint8);
        return { __type: 'Uint8Array', base64 };
    }
    // Recursively serialize arrays
    if (Array.isArray(value)) {
        return Promise.all(value.map(serializeValueAsync));
    }
    // Recursively serialize plain object properties only
    // Using Object.prototype.toString for robust object detection (handles null prototype)
    if (value && typeof value === 'object' && Object.prototype.toString.call(value) === '[object Object]') {
        const result = {};
        for (const key of Object.keys(value)) {
            result[key] = await serializeValueAsync(value[key]);
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
async function serializeArgsAsync(args) {
    assertWebviewTransportPayload(args, {
        surface: WEBVIEW_TRANSPORT_SURFACES.demoIframeRequest
    });
    return Promise.all(args.map(serializeValueAsync));
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
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    // Check for Uint8Array serialization marker
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
 * Send an RPC request to the parent window.
 * Uses async serialization to prevent UI blocking during large blob encoding.
 * @param {string} method - Method name to call
 * @param {Array} args - Arguments for the method
 * @returns {Promise<*>} - Result from parent
 */
export async function sendRpcRequest(method, args) {
    const messageId = `rpc_${++rpcMessageId}_${Date.now()}`;

    assertWebviewTransportPayload({
        channel: 'rpc',
        content: { kind: 'invoke', messageId, targetMethod: method, payload: args }
    }, {
        surface: WEBVIEW_TRANSPORT_SURFACES.demoIframeRequest
    });

    // Serialize args asynchronously to handle Uint8Array without blocking UI
    // This is done before setting up the timeout to ensure encoding time is included
    const serializedArgs = await serializeArgsAsync(args);
    const targetOrigin = await parentOriginReady;
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
        surface: WEBVIEW_TRANSPORT_SURFACES.demoIframeRequest
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

        // Post message to parent window instead of VS Code API
        parentWindow.postMessage(outboundMessage, targetOrigin);
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
        if (pending.timeoutId !== undefined) clearTimeout(pending.timeoutId);
        pendingRpcCalls.delete(message.messageId);

        try {
            assertWebviewTransportPayload(message, {
                surface: WEBVIEW_TRANSPORT_SURFACES.demoIframeResponse
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
 * Send an RPC result back to the parent.
 * Called when parent invokes a method on the webview.
 * @param {string} correlationId - Message ID
 * @param {*} result - Result to send
 */
export function sendRpcResult(correlationId, result) {
    const message = {
        kind: 'result',
        correlationId,
        payload: result
    };
    assertWebviewTransportPayload(message, {
        surface: WEBVIEW_TRANSPORT_SURFACES.demoIframeResult
    });
    parentWindow.postMessage(message, requireTargetOrigin());
}

/**
 * Send an RPC error back to the parent.
 * @param {string} correlationId - Message ID
 * @param {string} errorText - Error message
 */
export function sendRpcError(correlationId, error) {
    const message = {
        kind: 'result',
        correlationId,
        errorText: error instanceof Error ? error.message : String(error),
        ...rpcErrorFields(error)
    };
    assertWebviewTransportPayload(message, {
        surface: WEBVIEW_TRANSPORT_SURFACES.demoIframeResult
    });
    parentWindow.postMessage(message, requireTargetOrigin());
}

// Backend API proxy
export const backendApi = {
    initialize: () => sendRpcRequest('initialize', []),
    exportDb: (filename) => sendRpcRequest('exportDb', [filename]),
    refreshFile: () => sendRpcRequest('refreshFile', []),
    // The standalone demo has no VS Code globalState; keep the shared resize
    // lifecycle callable without pretending the width persists outside it.
    saveSidebarState: async () => undefined,
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
                && metadata.byteLength > DEFAULT_MAX_CELL_EDIT_BYTES
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
                        DEFAULT_MAX_CELL_EDIT_BYTES
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
                DEFAULT_MAX_CELL_EDIT_BYTES
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
        [table, data, DEFAULT_MAX_CELL_EDIT_BYTES]
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
        [table, updates, label, DEFAULT_MAX_CELL_EDIT_BYTES]
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
