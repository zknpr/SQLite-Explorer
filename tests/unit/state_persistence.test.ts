import './vscode_mock_setup';

import { it } from 'node:test';
import assert from 'node:assert';

let persistedState: Record<string, unknown> | undefined;
(globalThis as any).acquireVsCodeApi = () => ({
    getState: () => undefined,
    setState(value: Record<string, unknown>) {
        persistedState = value;
    },
    postMessage() {}
});

it('does not persist extension-owned cellEditBehavior in webview state', async () => {
    const stateModulePath = '../../core/ui/modules/state.js';
    const { state, persistState } = await import(stateModulePath);
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalBehavior = state.cellEditBehavior;
    persistedState = undefined;
    (globalThis as any).setTimeout = (callback: () => void) => {
        callback();
        return 1;
    };
    (globalThis as any).clearTimeout = () => {};

    try {
        state.cellEditBehavior = 'modal';
        persistState();
        assert.ok(persistedState);
        assert.strictEqual('cellEditBehavior' in persistedState, false);
    } finally {
        state.cellEditBehavior = originalBehavior;
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
    }
});
