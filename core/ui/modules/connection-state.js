import { state } from './state.js';

const MUTATION_CONTROL_IDS = [
    'btnOpenCreateTable',
    'btnOpenCreateView',
    'btnApplyBatchUpdate',
    'btnSubmitAddRow',
    'btnSubmitDelete',
    'btnAddColumnDef',
    'btnSubmitCreateTable',
    'btnSubmitAddColumn',
    'cellPreviewSaveBtn',
    'blob-replace-btn'
];

function updateMutationControlCapabilities() {
    for (const id of MUTATION_CONTROL_IDS) {
        const control = document.getElementById(id);
        if (control) control.disabled = state.isReadOnly;
    }
}

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

    updateMutationControlCapabilities();
    return connected;
}
