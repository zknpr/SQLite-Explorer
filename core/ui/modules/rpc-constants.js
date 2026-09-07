// One deadline contract for both VS Code and standalone-web RPC transports.
export const RPC_TIMEOUT_MS = 60000;

const INTERACTIVE_RPC_METHODS = new Set([
    // Audited HostBridge waits: modal UI plus calls whose file/cell materialization
    // or database work has no safe client-side deadline.
    'deleteColumns',
    'editView',
    'dropView',
    'updateCell',
    'updateCellBatch',
    'confirmLargeChanges',
    'confirmLargeSelection',
    'openCellEditor',
    'prepareCellMediaPreview',
    'exportDb',
    'refreshFile',
    'saveFile',
    'selectFile',
    'exportTable',
    'showInformationToast',
    'showWarningToast',
    'showErrorToast',
    // Desktop CSV/JSON import (import-data.js; the VS Code host never sends
    // these). `pickImportSource` is a native dialog; `readImportSource` reads
    // up to 64 MiB from wherever the user's file lives; and `importRows` is a
    // mutation — a client deadline that rejected while the worker went on to
    // release the import's savepoint would leave the rows in place with no
    // history entry to undo them.
    'pickImportSource',
    'readImportSource',
    'importRows'
]);

/**
 * Interactive host calls are intentionally unbounded at the webview transport layer.
 * A fixed client deadline can expire while VS Code owns the confirmation UI;
 * executing after that rejection would make a reported failure mutate data.
 * Database/worker calls beneath the host retain their own operation deadlines.
 * @param {string} method
 * @returns {number|undefined}
 */
export function getRpcTimeoutMs(method) {
    return INTERACTIVE_RPC_METHODS.has(method) ? undefined : RPC_TIMEOUT_MS;
}
