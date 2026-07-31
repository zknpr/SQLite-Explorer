import { state } from './state.js';

/** Apply the connection metadata shared by the extension and demo entry points. */
export function applyConnectionResult(result) {
    state.isDbConnected = true;
    // `readOnly` is the host bridge contract. Keep the older demo envelope key
    // compatible while its built-in client continues to send a writable result.
    state.isReadOnly = !!(result?.readOnly ?? result?.isReadOnly);

    const createViewButton = document.getElementById('btnOpenCreateView');
    if (createViewButton) createViewButton.disabled = state.isReadOnly;
}
