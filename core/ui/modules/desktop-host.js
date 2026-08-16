/**
 * Desktop host — owns the sql.js worker, undo/redo history, settings, and
 * file I/O for the Tauri desktop build. The webview page IS the host (no
 * iframe), so desktop-api.js calls invoke() directly; the only serialization
 * boundaries are worker postMessage (structured clone) and the shell bridge.
 */
import {
    WEBVIEW_TRANSPORT_SURFACES,
    assertWebviewTransportPayload
} from './transport.js';
import { ModificationTracker } from '../../../src/core/undo-history.ts';

const DEFAULT_SETTINGS = Object.freeze({
    maxFileSize: 200,
    defaultPageSize: 5000,
    instantCommit: 'never',
    doubleClickBehavior: 'inline',
    fileOperations: 'native',
    queryTimeout: 30000,
    maxInlineCellBytes: 1048576,
    maxUndoMemory: 52428800
});

// Worker methods whose successful result must be recorded for undo. DDL and
// pragma changes cannot be replayed by the worker's history engine, so they
// insert barriers instead (undo stops there until the next save).
const UNDOABLE_METHODS = new Set([
    'updateCell', 'updateCellBatch', 'insertRow', 'deleteRows',
    'createView', 'editView', 'dropView'
]);
const BARRIER_METHODS = new Set([
    'addColumn', 'deleteColumns', 'createTable', 'setPragma', 'replaceOversizedCell'
]);

export function createDesktopHost({ bridge, createWorker, confirmFn = (msg) => globalThis.confirm(msg) }) {
    let worker = null;
    let messageCounter = 0;
    const pendingCalls = new Map();

    let settings = { ...DEFAULT_SETTINGS };
    let tracker = new ModificationTracker(100, settings.maxUndoMemory);

    let currentPath = null;      // absolute path on disk (null for the empty startup DB)
    let currentName = 'untitled.db';
    let connectionInfo = { isReadOnly: false };
    let webviewMethods = {};

    // ---- worker RPC ---------------------------------------------------------

    function bootWorkerObject() {
        worker = createWorker();
        worker.onmessage = (event) => {
            const envelope = event.data;
            if (envelope?.channel !== 'rpc' || envelope.content?.kind !== 'response') return;
            const { messageId, success, data, errorMessage } = envelope.content;
            const pending = pendingCalls.get(messageId);
            if (!pending) return;
            pendingCalls.delete(messageId);
            if (success) pending.resolve(data);
            else pending.reject(new Error(errorMessage || `Worker call failed: ${pending.method}`));
        };
        worker.onerror = (error) => {
            const failure = new Error(`Worker crashed: ${error?.message ?? error}`);
            for (const pending of pendingCalls.values()) pending.reject(failure);
            pendingCalls.clear();
        };
    }

    function callWorker(method, args, { maxBinaryBytes, transfer } = {}) {
        const messageId = `rpc_${++messageCounter}_${Date.now()}`;
        const message = {
            channel: 'rpc',
            content: { kind: 'invoke', messageId, targetMethod: method, payload: args }
        };
        assertWebviewTransportPayload(message, {
            surface: WEBVIEW_TRANSPORT_SURFACES.demoWorkerRequest,
            ...(maxBinaryBytes ? { maxBinaryBytes } : {})
        });
        return new Promise((resolve, reject) => {
            pendingCalls.set(messageId, { method, resolve, reject });
            if (transfer?.length) worker.postMessage(message, transfer);
            else worker.postMessage(message);
        });
    }

    async function initializeWorkerDatabase(name, config) {
        const fullConfig = { queryTimeout: settings.queryTimeout, ...config };
        // Database bytes may legitimately exceed the standard 16 MiB inline cap;
        // bound them by the user's maxFileSize setting instead (0 = unlimited).
        const capBytes = settings.maxFileSize > 0 ? settings.maxFileSize * 1024 * 1024 : Number.MAX_SAFE_INTEGER;
        const transfer = fullConfig.content ? [fullConfig.content.buffer] : undefined;
        const result = await callWorker('initializeDatabase', [name, fullConfig], {
            maxBinaryBytes: capBytes,
            transfer
        });
        connectionInfo = { isReadOnly: result?.isReadOnly === true, readOnlyReason: result?.readOnlyReason };
        tracker = new ModificationTracker(100, settings.maxUndoMemory);
        return result;
    }

    // ---- modification recording --------------------------------------------

    function buildModification(method, args, result) {
        switch (method) {
            case 'updateCell': {
                const [table, rowId, column, value, originalValue] = args;
                return {
                    label: `Edit ${column}`,
                    modificationType: 'cell_update',
                    targetTable: table,
                    targetRowId: rowId,
                    newTargetRowId: result ?? rowId,
                    targetColumn: column,
                    priorValue: originalValue,
                    newValue: value
                };
            }
            case 'updateCellBatch': {
                const [table, updates, label] = args;
                return {
                    label: label || `Edit ${updates.length} cells`,
                    modificationType: 'cell_update',
                    targetTable: table,
                    affectedCells: updates.map(u => ({
                        rowId: u.rowId,
                        newRowId: u.rowId,
                        columnName: u.column,
                        priorValue: u.originalValue,
                        newValue: u.value
                    }))
                };
            }
            case 'insertRow': {
                const [table] = args;
                return {
                    label: 'Insert row',
                    modificationType: 'row_insert',
                    targetTable: table,
                    targetRowId: result
                };
            }
            case 'deleteRows': {
                const [table] = args;
                return {
                    label: 'Delete rows',
                    modificationType: 'row_delete',
                    targetTable: table,
                    deletedRows: result
                };
            }
            case 'createView': {
                const [view, selectSql] = args;
                return {
                    label: `Create view ${view}`,
                    modificationType: 'view_create',
                    targetTable: view,
                    viewDefAfter: selectSql
                };
            }
            // editView/dropView need the prior definition; the wrapper fetches
            // it before the mutation and threads it through `context`.
            default:
                return null;
        }
    }

    async function invokeMutation(method, args) {
        // Views: capture the prior definition for undo before mutating.
        let priorViewDef = null;
        if (method === 'editView' || method === 'dropView') {
            priorViewDef = await callWorker('getViewDefinition', [args[0]]);
        }
        const result = await callWorker(method, args);
        if (result && typeof result === 'object' && result.cancelled === true) return result;

        let modification = buildModification(method, args, result);
        if (method === 'editView') {
            modification = {
                label: `Edit view ${args[0]}`, modificationType: 'view_edit', targetTable: args[0],
                viewDefBefore: priorViewDef, viewDefAfter: args[1]
            };
        } else if (method === 'dropView') {
            modification = {
                label: `Drop view ${args[0]}`, modificationType: 'view_drop', targetTable: args[0],
                viewDefBefore: priorViewDef
            };
        }
        if (modification) tracker.record(modification);

        if (settings.instantCommit === 'always' && currentPath) {
            await saveToDisk();
        }
        updateTitle();
        return result;
    }

    // ---- host-answered methods ---------------------------------------------

    async function notifyWebview(methodName, parameters) {
        const method = webviewMethods[methodName];
        if (typeof method === 'function') return method(...parameters);
        return undefined;
    }

    async function refreshUi() {
        await notifyWebview('refreshContent', [currentName, { connected: true, ...connectionInfo }]);
    }

    function updateTitle() {
        const dirty = tracker.hasUncommittedChanges() ? ' — Edited' : '';
        void bridge.setTitle(`${currentName}${dirty} — SQLite Explorer`);
    }

    async function saveToDisk() {
        if (!currentPath) return false;
        const bytes = await callWorker('exportDatabase', [currentName]);
        await bridge.saveDatabase(currentPath, bytes);
        await tracker.createCheckpoint();
        updateTitle();
        return true;
    }

    async function openFromBytes(path, name, bytes) {
        await initializeWorkerDatabase(name, { content: bytes });
        currentPath = path;
        currentName = name;
        updateTitle();
        await refreshUi();
        return true;
    }

    const localMethods = {
        async initialize() {
            return { connected: true, isReadOnly: connectionInfo.isReadOnly === true, filename: currentName };
        },
        async getExtensionSettings() {
            return { ...settings };
        },
        async updateExtensionSetting(key, value) {
            settings = { ...settings, [key]: value };
            const { ...persisted } = settings;
            // Persist only deviations from defaults to keep the file readable.
            const delta = {};
            for (const [k, v] of Object.entries(persisted)) {
                if (DEFAULT_SETTINGS[k] !== v) delta[k] = v;
            }
            await bridge.saveSettings(delta);
            return { success: true };
        },
        async exportDb(filename) {
            const bytes = await callWorker('exportDatabase', [currentName]);
            const target = await bridge.saveFileAs(filename || currentName, bytes);
            return { success: target !== null };
        },
        async exportTable(...args) {
            const result = await callWorker('exportTable', args);
            const text = result.contentChunks.join('');
            const target = await bridge.saveFileAs(result.filename, new TextEncoder().encode(text));
            return { success: target !== null };
        },
        async refreshFile() {
            if (!currentPath) return { success: true };
            const bytes = await bridge.readDatabaseBytes(currentPath);
            await initializeWorkerDatabase(currentName, { content: bytes });
            updateTitle();
            return { success: true };
        },
        async saveFile(filename, data) {
            const target = await bridge.saveFileAs(filename, data);
            return { success: target !== null };
        },
        async triggerUndo() {
            const entry = tracker.stepBack();
            if (!entry) return { performed: false };
            await callWorker('undoModification', [entry]);
            updateTitle();
            await refreshUi();
            return { performed: true };
        },
        async triggerRedo() {
            const entry = tracker.stepForward();
            if (!entry) return { performed: false };
            await callWorker('redoModification', [entry]);
            updateTitle();
            await refreshUi();
            return { performed: true };
        },
        async fireEditEvent() { return { success: true }; },
        async saveSidebarState() { return undefined; }
    };

    // ---- public host API ----------------------------------------------------

    const host = {
        async start() {
            settings = { ...DEFAULT_SETTINGS, ...(await bridge.loadSettings()) };
            tracker = new ModificationTracker(100, settings.maxUndoMemory);
            bootWorkerObject();
            await initializeWorkerDatabase(currentName, {});
            updateTitle();
        },
        async invoke(method, args) {
            const local = localMethods[method];
            if (local) return local(...args);
            if (BARRIER_METHODS.has(method)) {
                const result = await callWorker(method, args);
                tracker.record({ label: method, undoPolicy: 'barrier' });
                if (settings.instantCommit === 'always' && currentPath) await saveToDisk();
                updateTitle();
                return result;
            }
            if (UNDOABLE_METHODS.has(method)) return invokeMutation(method, args);
            return callWorker(method, args);
        },
        setWebviewMethods(methods) { webviewMethods = methods; },
        async openDatabaseViaDialog() {
            const picked = await bridge.pickDatabase();
            if (!picked) return false;
            const bytes = await bridge.readDatabaseBytes(picked.path);
            return openFromBytes(picked.path, picked.name, bytes);
        },
        async openDatabaseFromFile(file) {
            // Drag-and-dropped File objects keep the demo's paged-open path for
            // very large databases (the worker reads the handle on demand).
            await initializeWorkerDatabase(file.name, { file });
            currentPath = null; // no on-disk write-back target for DnD opens
            currentName = file.name;
            updateTitle();
            await refreshUi();
            return true;
        },
        saveToDisk,
        async refreshFromDisk() { await localMethods.refreshFile(); await refreshUi(); },
        hasUnsavedChanges: () => tracker.hasUncommittedChanges(),
        currentFilename: () => currentName
    };
    return host;
}
