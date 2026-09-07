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
    // A hidden webview can be destroyed before any timer fires, so the
    // snapshot must be written synchronously: a timer here is a regression.
    let timersArmed = 0;
    (globalThis as any).setTimeout = () => {
        timersArmed++;
        return 1;
    };
    (globalThis as any).clearTimeout = () => {};

    try {
        state.cellEditBehavior = 'modal';
        state.collapsedSections = new Set(['indexes']);
        state.sidebarWidth = 260;
        persistState();
        // Widen: TS narrows the module-level binding to undefined after the
        // reset above and cannot see persistState() writing it.
        const saved = persistedState as Record<string, unknown> | undefined;
        assert.ok(saved);
        assert.strictEqual(timersArmed, 0);
        assert.strictEqual('cellEditBehavior' in saved, false);
        assert.deepStrictEqual(saved.collapsedSections, ['indexes']);
        assert.strictEqual(saved.sidebarWidth, 260);
    } finally {
        state.collapsedSections = new Set(['views', 'indexes']);
        state.sidebarWidth = null;
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
