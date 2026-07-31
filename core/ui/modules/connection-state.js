import { state } from './state.js';

/** Apply the connection metadata shared by the extension and demo entry points. */
export function applyConnectionResult(result) {
    const connected = result?.connected === true;
    state.isDbConnected = connected;
    // `readOnly` is the host bridge contract. Keep the older demo envelope key
    // compatible while its built-in client continues to send a writable result.
    // A missing or malformed capability flag must never grant write access.
    state.isReadOnly = typeof result?.readOnly === 'boolean'
        ? result.readOnly
        : typeof result?.isReadOnly === 'boolean'
            ? result.isReadOnly
            : true;

    const createViewButton = document.getElementById('btnOpenCreateView');
    if (createViewButton) createViewButton.disabled = state.isReadOnly;
    return connected;
}
