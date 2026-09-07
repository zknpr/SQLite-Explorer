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

it('persists the sidebar filter when the user types it', async () => {
    const stateModulePath = '../../core/ui/modules/state.js';
    const sidebarModulePath = '../../core/ui/modules/sidebar.js';
    const { state } = await import(stateModulePath);
    const { initSidebar } = await import(sidebarModulePath);
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let onInput: (() => void) | undefined;
    const filterInput = {
        value: 'audit_log',
        addEventListener(type: string, listener: () => void) {
            if (type === 'input') onInput = listener;
        }
    };
    const sidebarPanel = { addEventListener() {} };
    persistedState = undefined;
    (globalThis as any).setTimeout = (callback: () => void) => {
        callback();
        return 1;
    };
    (globalThis as any).clearTimeout = () => {};
    (globalThis as any).document = {
        getElementById(id: string) {
            if (id === 'sidebarPanel') return sidebarPanel;
            if (id === 'sidebarFilterInput') return filterInput;
            return null;
        }
    };

    try {
        state.sidebarFilter = '';
        initSidebar();
        assert.ok(onInput);
        onInput();
        assert.strictEqual((persistedState as any)?.sidebarFilter, 'audit_log');
    } finally {
        state.sidebarFilter = '';
        delete (globalThis as any).document;
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
    }
});
