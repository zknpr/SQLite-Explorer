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
    maxUndoMemory: 52428800,
    theme: 'system'
});

// Worker methods whose successful result must be recorded for undo. DDL and
// pragma changes cannot be replayed by the worker's history engine, so they
// insert barriers instead (undo stops there until the next save).
const UNDOABLE_METHODS = new Set([
    'updateCell', 'updateCellBatch', 'insertRow', 'deleteRows',
    'createView', 'editView', 'dropView'
]);
const BARRIER_METHODS = new Set([
    'addColumn', 'deleteColumns', 'createTable', 'setPragma', 'replaceOversizedCell',
    // No live webview call site invokes insertRowBatch today; barrier-by-default
    // keeps dirty-tracking honest until someone designs its undo/redo replay.
    'insertRowBatch'
]);

export function createDesktopHost({ bridge, createWorker }) {
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
                    description: `Edit ${column}`,
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
                const summaryLabel = label || `Edit ${updates.length} cells`;
                // Build affectedCells from the worker's authoritative
                // CellUpdateResult[] (result), not the caller's request array
                // (updates/args[1]). The worker re-reads priorValue from the row
                // at update time and computes newRowId only when a primary-key
                // member actually changed — the caller's originalValue can be
                // stale and args never carries a newRowId concept at all. The
                // rowid-table path never reports newRowId (CellUpdateResult in
                // src/core/types.ts: "Identity to use after the update when a PK
                // member changed"); default to the unchanged rowId there,
                // matching undoModification's own `cell.newRowId ?? cell.rowId`.
                return {
                    label: summaryLabel,
                    description: summaryLabel,
                    modificationType: 'cell_update',
                    targetTable: table,
                    affectedCells: result.map(r => ({
                        rowId: r.rowId,
                        newRowId: r.newRowId ?? r.rowId,
                        columnName: r.columnName,
                        priorValue: r.priorValue,
                        newValue: r.newValue,
                        operation: r.operation
                    }))
                };
            }
            case 'insertRow': {
                const [table, data] = args;
                return {
                    label: 'Insert row',
                    description: 'Insert row',
                    modificationType: 'row_insert',
                    targetTable: table,
                    targetRowId: result,
                    // redoModification's row_insert case reads `rowData` (not
                    // args) to reconstruct the insert; without it, redo silently
                    // inserts an empty row.
                    rowData: data
                };
            }
            case 'deleteRows': {
                const [table, rowIds] = args;
                return {
                    label: 'Delete rows',
                    description: 'Delete rows',
                    modificationType: 'row_delete',
                    targetTable: table,
                    deletedRows: result,
                    // Self-discovered while auditing insertRow's analogous gap
                    // above (not one of the review's 3 listed defects — flagged
                    // separately in the report): redoModification's row_delete
                    // case reads `affectedRowIds` (not deletedRows) to
                    // re-delete; without it, redo silently deletes nothing.
                    affectedRowIds: rowIds
                };
            }
            case 'createView': {
                const [view] = args;
                return {
                    label: `Create view ${view}`,
                    description: `Create view ${view}`,
                    modificationType: 'view_create',
                    targetTable: view,
                    // The worker's createView() return IS the post-create
                    // ViewDefinition (it fetches one internally via
                    // getViewDefinition) — required so the undo-path CAS guard
                    // (assertViewDefinitionStateCurrent) compares real stored
                    // sqlite_schema SQL, not the user's raw SELECT body string.
                    viewDefAfter: result
                };
            }
            // editView/dropView build their modification directly in
            // invokeMutation from the worker's own {before, after} / before
            // result (see below) — no separate pre-fetch needed.
            default:
                return null;
        }
    }

    async function invokeMutation(method, args) {
        const result = await callWorker(method, args);
        if (result && typeof result === 'object' && result.cancelled === true) return result;

        let modification = buildModification(method, args, result);
        if (method === 'editView') {
            // editView's own result already carries {before, after} as real
            // ViewDefinition objects (worker.js editView / types.ts
            // ViewEditResult) — using args[1] (the raw SELECT body string) here
            // would make the undo-path CAS guard
            // (assertViewDefinitionStateCurrent) compare a bare SELECT fragment
            // against sqlite_schema's stored CREATE VIEW text and always fail.
            modification = {
                label: `Edit view ${args[0]}`, description: `Edit view ${args[0]}`,
                modificationType: 'view_edit', targetTable: args[0],
                viewDefBefore: result.before, viewDefAfter: result.after
            };
        } else if (method === 'dropView') {
            // dropView's own result IS the pre-drop ViewDefinition.
            modification = {
                label: `Drop view ${args[0]}`, description: `Drop view ${args[0]}`,
                modificationType: 'view_drop', targetTable: args[0],
                viewDefBefore: result
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
            // Wire-shape parity with the VS Code host (hostBridge.ts
            // getExtensionSettings): the settings panel reads `autoCommit` and
            // `cellEditBehavior`; the persisted store keeps the config keys
            // `instantCommit` and `doubleClickBehavior`.
            return {
                autoCommit: settings.instantCommit === 'always',
                cellEditBehavior: settings.doubleClickBehavior,
                fileOperations: settings.fileOperations,
                theme: settings.theme
            };
        },
        async updateExtensionSetting(key, value) {
            // Same key translation the VS Code host performs, and the same push:
            // there, a doubleClickBehavior config change fans out
            // updateCellEditBehavior to every webview (editorController.ts).
            if (key === 'autoCommit') {
                settings = { ...settings, instantCommit: value ? 'always' : 'never' };
            } else {
                settings = { ...settings, [key]: value };
            }
            if (key === 'doubleClickBehavior') {
                await notifyWebview('updateCellEditBehavior', [value]);
            }
            // Persist only deviations from defaults to keep the file readable.
            const delta = {};
            for (const [k, v] of Object.entries(settings)) {
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
            // VS Code seeds the webview's initial cell-edit behavior through the
            // HTML template env (editorController.ts VSCODE_ENV); the desktop has
            // no template pass, so push it the way config changes arrive.
            await notifyWebview('updateCellEditBehavior', [settings.doubleClickBehavior]);
            bootWorkerObject();
            await initializeWorkerDatabase(currentName, {});
            updateTitle();
        },
        async invoke(method, args) {
            const local = localMethods[method];
            if (local) return local(...args);
            if (BARRIER_METHODS.has(method)) {
                const result = await callWorker(method, args);
                // No ModificationType union member fits a generic DDL/pragma
                // barrier (there's no "barrier"/"pragma" entry); the literal RPC
                // method name is used for modificationType/description instead.
                // This has no runtime effect: ModificationTracker.stepBack()
                // refuses to pop a barrier entry, so undoModification/
                // redoModification never destructure it.
                tracker.record({
                    label: method,
                    description: method,
                    modificationType: method,
                    undoPolicy: 'barrier'
                });
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
            if (settings.maxFileSize > 0 && picked.size > settings.maxFileSize * 1024 * 1024) {
                throw new Error(
                    `Cannot open "${picked.name}": file is ${picked.size} bytes, which exceeds ` +
                    `the ${settings.maxFileSize} MiB cap set by the maxFileSize setting.`
                );
            }
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
