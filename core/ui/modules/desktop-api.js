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
import { modLabel } from './platform.js';
import { confirmDestructiveAction } from './modals.js';
import {
    CellEditPolicyError,
    DEFAULT_MAX_CELL_EDIT_BYTES,
    formatOversizedCellReplacementWarning,
    isOversizedCellReplacementConflictError,
    isOversizedCellReplacementRequiredError,
    MAX_OVERSIZED_CELL_REPLACEMENT_ATTEMPTS,
    OVERSIZED_CELL_REPLACEMENT_RETRY_EXHAUSTED_MESSAGE
} from '../../../src/core/cell-edit-policy.ts';

export { RPC_TIMEOUT_MS, getRpcTimeoutMs };

let host = null;
export function initDesktopApi(hostInstance) { host = hostInstance; }

/**
 * Drop trailing `undefined`s from an RPC argument list.
 *
 * The native engine's transport is JSON (`desktop-host.js` →
 * `JSON.stringify(encodeFrameValue(message))`), and JSON has no `undefined`:
 * `JSON.stringify(['t', ['c'], undefined])` is `["t",["c"],null]`. A worker
 * method that early-outs on `param !== undefined` — or that declares a default
 * value, which `null` does NOT trigger — then receives an argument the caller
 * never wrote. That is exactly how `deleteColumns` broke: the worker's
 * `dropDependentIndexes` guard saw `null`, failed `Array.isArray`, and threw.
 *
 * Truncating is lossless rather than a papering-over: in JavaScript `f(a, b,
 * undefined)` and `f(a, b)` are indistinguishable to the callee — the worker's
 * dispatch is `handler(...(payload || []))` and nothing in it reads
 * `arguments.length` — so the shorter list means precisely what the caller
 * meant, "this argument is absent", which JSON *can* represent.
 *
 * Only the TAIL is safe to remove. An interior `undefined` still crosses as
 * `null`; the call sites below therefore never place one where the receiving
 * method would tell the two apart.
 */
function withoutTrailingUndefined(args) {
    if (!Array.isArray(args)) return args;
    let end = args.length;
    while (end > 0 && args[end - 1] === undefined) end -= 1;
    return end === args.length ? args : args.slice(0, end);
}

export async function sendRpcRequest(method, args) {
    if (!host) throw new Error('Desktop host not initialized');
    const timeoutMs = getRpcTimeoutMs(method);
    const invocation = host.invoke(method, withoutTrailingUndefined(args));
    if (timeoutMs === undefined) return invocation;
    // The Promise executor below runs synchronously on construction, so
    // timeoutId is already assigned before Promise.race is even evaluated —
    // `finally` can always find it, whichever side of the race wins.
    // Clearing it when `invocation` wins is the actual fix: without this,
    // the losing timer keeps ticking for the full timeoutMs (default
    // RPC_TIMEOUT_MS = 60s) on every single RPC call, into a promise
    // nothing is awaiting anymore.
    let timeoutId;
    try {
        return await Promise.race([
            invocation,
            new Promise((_, reject) => {
                timeoutId = setTimeout(
                    () => reject(new Error(`RPC timeout: ${method}`)), timeoutMs);
            })
        ]);
    } finally {
        clearTimeout(timeoutId);
    }
}

// Import-parity no-ops: the desktop build has no message channel.
export function handleRpcResponse(_message) {}
export function sendRpcResult(_correlationId, _result) {}
export function sendRpcError(_correlationId, _error) {}

/**
 * VS Code's `setState`/`getState` seam, deliberately INERT on the desktop.
 *
 * It used to write `persistState()`'s snapshot (selected table, page, sort,
 * filters, column widths, pins, scroll) into localStorage that nothing ever
 * read back — `getVsCodeState` has exactly one caller, core/ui/viewer.js, the
 * VS Code entry. That is why nothing survived a relaunch despite the write
 * happening on every interaction.
 *
 * Restoring it is not the fix. VS Code's state belongs to ONE webview editing
 * ONE file, so replaying it is unambiguous. The desktop keeps N databases open
 * behind one `state` object (see db-ui-state.js) and boots to an empty scratch
 * database — it does not reopen anything — so a single global blob would be
 * replayed onto whichever database happened to open first, pointing it at
 * another file's table with another file's filters. Per-database UI state IS
 * preserved, in memory, across switches; what genuinely belongs to the app
 * rather than to a file (theme, zoom, sidebar width, console history) persists
 * through the shell's settings store instead.
 */
export function getVsCodeState() { return undefined; }
export function saveVsCodeState(_stateObj) {}

// Backend API proxy
export const backendApi = {
    initialize: () => sendRpcRequest('initialize', []),
    // (side, position) — ui.js calls it that way and api.js forwards both, but
    // this lane declared ONE parameter, so the width was dropped on the floor
    // before it ever reached the host.
    saveSidebarState: (side, position) => sendRpcRequest('saveSidebarState', [side, position]),
    exportDb: (filename) => sendRpcRequest('exportDb', [filename]),
    refreshFile: () => sendRpcRequest('refreshFile', []),
    exportTable: (dbParams, columns, dbOptions, tableStore, exportOptions, extras) =>
        sendRpcRequest('exportTable', [dbParams, columns, dbOptions, tableStore, exportOptions, extras]),

    // Database operations
    updateCell: async (table, rowId, column, value, originalValue) => {
        // Bounded like web-api.js: a prior that keeps changing under the
        // confirmation is reported, not chased forever.
        for (let attempt = 1; attempt <= MAX_OVERSIZED_CELL_REPLACEMENT_ATTEMPTS; attempt++) {
            const metadata = await sendRpcRequest('getCellMetadata', [{
                table,
                rowId,
                column
            }]);
            if (
                (metadata.storageClass === 'text' || metadata.storageClass === 'blob')
                && metadata.byteLength > DEFAULT_MAX_CELL_EDIT_BYTES
            ) {
                const approved = await confirmDestructiveAction({
                    title: 'Replace oversized value',
                    message: formatOversizedCellReplacementWarning(table, column, metadata),
                    confirmLabel: 'Replace'
                });
                if (!approved) {
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
                    if (isOversizedCellReplacementConflictError(error)) {
                        if (attempt < MAX_OVERSIZED_CELL_REPLACEMENT_ATTEMPTS) continue;
                        throw new Error(OVERSIZED_CELL_REPLACEMENT_RETRY_EXHAUSTED_MESSAGE, {
                            cause: error
                        });
                    }
                    throw error;
                }
            }
            try {
                return await sendRpcRequest('updateCell', [
                    table,
                    rowId,
                    column,
                    value,
                    originalValue,
                    DEFAULT_MAX_CELL_EDIT_BYTES
                ]);
            } catch (error) {
                // The prior grew past the limit between the metadata read and
                // the write (a console script, another window): back through
                // the confirmation rather than failing the edit — the same
                // re-entry hostBridge.ts performs for VS Code.
                if (isOversizedCellReplacementRequiredError(error)) {
                    if (attempt < MAX_OVERSIZED_CELL_REPLACEMENT_ATTEMPTS) continue;
                    throw new Error(OVERSIZED_CELL_REPLACEMENT_RETRY_EXHAUSTED_MESSAGE, {
                        cause: error
                    });
                }
                throw error;
            }
        }
        throw new Error(OVERSIZED_CELL_REPLACEMENT_RETRY_EXHAUSTED_MESSAGE);
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
    /**
     * Drop columns, after telling the user what it costs.
     *
     * TWO facts the desktop used to withhold, both discovered only afterwards:
     *
     * 1. SQLite REFUSES a DROP COLUMN while any index references the column, and
     *    nothing on this lane ever passed `dropDependentIndexes`, so dropping an
     *    indexed column simply always failed ("error in index ... no such
     *    column"). The list is now obtained from the engine and named in the
     *    prompt — the same shape the VS Code host has always used
     *    (hostBridge.ts's showWarningMessage), which is why crud.js already
     *    understands `{cancelled: true}`.
     * 2. A column drop is a HISTORY BARRIER on the desktop (see
     *    BARRIER_METHODS in desktop-host.js): the worker's replay engine has no
     *    column-drop undo, so ⌘Z will not bring the column back. Saying so
     *    before the drop is the difference between a decision and a surprise.
     *
     * The list comes from the worker's `findDependentIndexes` (SQLite itself
     * is the parser), and the exact definitions go back with the drop: the
     * worker re-derives the list inside the drop's savepoint and refuses if
     * an index changed while this prompt was open. Views and triggers that
     * reference the column are SQLite's own refusal; the worker names them
     * in that error (describeColumnDropFailure), which matters on the native
     * engine, whose message alone is "SQL logic error".
     */
    deleteColumns: async (table, columns) => {
        const dependentIndexes = await sendRpcRequest('findDependentIndexes', [table, columns]);
        if (!Array.isArray(dependentIndexes)) {
            throw new Error('Invalid dependent-index response from the worker');
        }
        const indexNames = dependentIndexes.map(index => {
            if (
                !index
                || typeof index !== 'object'
                || typeof index.identifier !== 'string'
                || typeof index.sql !== 'string'
            ) {
                throw new Error('Invalid dependent-index definition from the worker');
            }
            return index.identifier;
        });
        const columnList = columns.join(', ');
        const lines = [`Drop ${columns.length === 1 ? 'column' : 'columns'} ${columnList} from "${table}"?`, ''];
        if (indexNames.length > 0) {
            lines.push(
                `These indexes depend on ${columns.length === 1 ? 'it' : 'them'} and will be dropped `
                + `first: ${indexNames.join(', ')}.`
            );
        }
        lines.push('This cannot be undone with ' + modLabel('Z') + ' — it ends the undo history for this database.');
        const approved = await confirmDestructiveAction({
            title: columns.length === 1 ? 'Drop column' : 'Drop columns',
            message: lines.join('\n'),
            confirmLabel: columns.length === 1 ? 'Drop column' : 'Drop columns'
        });
        if (!approved) return { cancelled: true };
        // OMIT the third argument when there is nothing to confirm rather than
        // pass `undefined`: on the native lane the argument list is serialised
        // as JSON, which has no `undefined`, so a trailing hole would arrive
        // at the worker as an explicit `null` — which its confirmation
        // validator rightly refuses as "not an array". `sendRpcRequest` also
        // truncates trailing holes, but building the list correctly is what
        // makes the intent legible here.
        return sendRpcRequest(
            'deleteColumns',
            dependentIndexes.length > 0 ? [table, columns, dependentIndexes] : [table, columns]
        );
    },
    // Omit absent options rather than send `undefined`: the native lane's
    // argument list is JSON (see withoutTrailingUndefined).
    createTable: (table, columns, options) => sendRpcRequest('createTable',
        options === undefined ? [table, columns] : [table, columns, options]),
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
                const approved = await confirmDestructiveAction({
                    title: 'Drop INSTEAD OF triggers',
                    message:
                        `Editing view "${view}" without preserving triggers will permanently drop `
                        + `these INSTEAD OF triggers: ${triggerNames}. Continue?`,
                    confirmLabel: 'Edit view'
                });
                if (!approved) {
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
        const approved = await confirmDestructiveAction({
            title: 'Drop view',
            message,
            confirmLabel: 'Drop view'
        });
        if (!approved) {
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
    // Desktop-only (the SQL console). The host special-cases this method for
    // the undo barrier before forwarding it to the worker; the default
    // `{}` keeps the worker's own maxRows clamp in charge of the row cap.
    runConsole: (sql, options) => sendRpcRequest('runConsole', [sql, options ?? {}]),
    getTableInfo: (table) => sendRpcRequest('getTableInfo', [table]),
    getImportTarget: (table) => sendRpcRequest('getImportTarget', [table]),
    // Desktop-only CSV/JSON import (modules/import-data.js). The pick and the
    // read are shell dialog/file I/O answered by the host's global methods;
    // `importRows` is the worker mutation — one call for the whole batch,
    // carrying the same per-value edit cap the single-row insert does. The host
    // adds the undo and transport budgets itself (policy the page cannot lift).
    pickImportSource: () => sendRpcRequest('pickImportSource', []),
    readImportSource: (path) => sendRpcRequest('readImportSource', [path]),
    importRows: (table, rows, options = {}) => sendRpcRequest(
        'importRows',
        [table, rows, {
            ...(options.expectedSchemaVersion === undefined ? {} : { expectedSchemaVersion: options.expectedSchemaVersion }),
            maxEditValueBytes: DEFAULT_MAX_CELL_EDIT_BYTES
        }]
    ),
    getPragmas: () => sendRpcRequest('getPragmas', []),
    setPragma: (pragma, value) => sendRpcRequest('setPragma', [pragma, value]),
    getExtensionSettings: () => sendRpcRequest('getExtensionSettings', []),
    updateExtensionSetting: (key, value) => sendRpcRequest('updateExtensionSetting', [key, value]),
    ping: () => sendRpcRequest('ping', []),

    // VS Code-only surfaces. Both refuse here, and the wording is the DESKTOP's:
    // this bundle is the desktop app, and the copy inherited from web-api.js
    // told the user about "the web demo" — a product they are not running, with
    // no route to the one the desktop does have (the blob inspector's chunked
    // Load More, which reads any cell through openCellReadSession/readCellChunk).
    prepareCellMediaPreview: (_params, _rowId, _colName, options = {}) => {
        const sourceBytes = Number.isSafeInteger(options.sourceByteLength)
            ? `${options.sourceByteLength} bytes`
            : 'this value';
        return Promise.resolve({
            success: false,
            message:
                `Inline media preview is unavailable for ${sourceBytes}: it exceeds the ` +
                `${MAX_WEBVIEW_BINARY_VALUE_BYTES}-byte webview binary limit, and the desktop ` +
                'shell exposes no host-owned temporary file to render from. ' +
                'Use Load More in the cell inspector to read the value in chunks.'
        });
    },
    cancelCellMediaPreview: () => Promise.resolve(),
    releaseCellMediaPreview: () => Promise.resolve(),
    /**
     * The grid asks before materialising a very large selection. In-page like
     * every other desktop confirmation: `window.confirm` does not present in
     * this webview (see modals.js confirmDestructiveAction).
     */
    confirmLargeSelection: (itemCount, unit) => confirmDestructiveAction({
        title: 'Large selection',
        message:
            `Selecting ${Number(itemCount).toLocaleString()} ${unit} may slow or freeze this window. `
            + 'Use Export for large data operations.',
        confirmLabel: 'Continue'
    }),
    /**
     * The batch-edit, clear-cells and delete-rows paths ask before changing
     * more than LARGE_CHANGE_WARNING_THRESHOLD cells/rows (large-change-guard.js);
     * the caller re-checks the table/connection/content generation after the
     * answer. Same in-page dialog as every other desktop confirmation.
     */
    confirmLargeChanges: (itemCount, unit) => confirmDestructiveAction({
        title: 'Large change',
        message:
            `This operation changes ${Number(itemCount).toLocaleString()} ${unit}. `
            + 'Do you want to continue?',
        confirmLabel: 'Continue'
    }),
    openCellEditor: (params, rowId, colName, colTypes, options = {}) =>
        options.download === true
            ? sendRpcRequest('openCellEditor', [params, rowId, colName, colTypes, options])
            : Promise.resolve({ success: false, message: 'Use Load More in the cell inspector to view this value, or Save Full to download its stored bytes.' }),
    openViewEditor: () => Promise.resolve({ success: false, message: 'Not available in web mode' }),
    readWorkspaceFileUri: () => Promise.resolve(null),
    triggerUndo: () => sendRpcRequest('triggerUndo', []),
    triggerRedo: () => sendRpcRequest('triggerRedo', []),

    // Web-compatible implementations for Blob Inspector
    saveFile: (filename, data) => sendRpcRequest('saveFile', [filename, data]),
    selectFile: () => {
        return new Promise((resolve, reject) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.style.display = 'none';
            const parent = document.body;
            let removed = false;
            const cleanup = () => {
                if (removed) return;
                removed = true;
                parent.removeChild(input);
            };
            input.onchange = async (e) => {
                try {
                    if (e.target.files.length > 0) {
                        const file = e.target.files[0];
                        if (!Number.isSafeInteger(file.size) || file.size < 0) {
                            throw new Error('Unable to determine the selected file size safely.');
                        }
                        if (file.size > DEFAULT_MAX_CELL_EDIT_BYTES) {
                            throw new CellEditPolicyError(
                                'blob',
                                file.size,
                                DEFAULT_MAX_CELL_EDIT_BYTES
                            );
                        }
                        const buffer = await file.arrayBuffer();
                        const data = new Uint8Array(buffer);
                        if (data.byteLength > DEFAULT_MAX_CELL_EDIT_BYTES) {
                            throw new CellEditPolicyError(
                                'blob',
                                data.byteLength,
                                DEFAULT_MAX_CELL_EDIT_BYTES
                            );
                        }
                        resolve({ name: file.name, data });
                    } else {
                        resolve(undefined);
                    }
                } catch (error) {
                    reject(error);
                } finally {
                    cleanup();
                }
            };
            parent.appendChild(input);
            input.click();
            setTimeout(cleanup, 1000);
        });
    }
};
