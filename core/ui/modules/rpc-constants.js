// One deadline contract for both VS Code and standalone-web RPC transports.
export const RPC_TIMEOUT_MS = 60000;

const INTERACTIVE_RPC_METHODS = new Set([
    'deleteColumns',
    'editView',
    'dropView',
    'confirmLargeChanges',
    'confirmLargeSelection'
]);

/**
 * Modal host calls are intentionally unbounded at the webview transport layer.
 * A fixed client deadline can expire while VS Code owns the confirmation UI;
 * executing after that rejection would make a reported failure mutate data.
 * Database/worker calls beneath the host retain their own operation deadlines.
 * @param {string} method
 * @returns {number|undefined}
 */
export function getRpcTimeoutMs(method) {
    return INTERACTIVE_RPC_METHODS.has(method) ? undefined : RPC_TIMEOUT_MS;
}
