import './vscode_mock_setup';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';

/**
 * The grid's error state doubles as the recovery surface for a retired or
 * never-established connection: it names the reason and offers ONE button
 * (dev's shared UI, ported to the desktop target with the connection
 * retirement the desktop host now performs). Minimal DOM fake, as the other
 * webview-module tests use.
 */
describe('reload-required error state', () => {
    afterEach(() => {
        delete (globalThis as any).document;
    });

    function makeDocument() {
        const listeners: Record<string, Array<(event: unknown) => unknown>> = {};
        let html = '';
        const container = {
            set innerHTML(value: string) { html = value; },
            get innerHTML() { return html; }
        };
        const button = {
            disabled: false,
            addEventListener(type: string, handler: (event: unknown) => unknown) {
                (listeners[type] ??= []).push(handler);
            }
        };
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'gridContainer') return container;
                // The button exists only once the error state rendered it.
                if (id === 'btnReloadDatabase') return html.includes('id="btnReloadDatabase"') ? button : null;
                return null;
            },
            querySelectorAll() { return []; }
        };
        return { container, button, listeners };
    }

    it('names the reason and offers Reload Database (retired) or Retry Connection (never opened)', async () => {
        const { container, listeners } = makeDocument();
        const stateModulePath = '../../core/ui/modules/state.js';
        const uiModulePath = '../../core/ui/modules/ui.js';
        const { state } = await import(stateModulePath);
        const { showErrorState } = await import(uiModulePath);
        try {
            state.isDbConnected = true;
            state.reloadRequiredReason = 'The database file was replaced <outside> SQLite Explorer.';
            showErrorState('an unrelated message');
            assert.match(container.innerHTML, /Reload required/);
            // The reason wins over the caller's message, escaped.
            assert.match(container.innerHTML, /replaced &lt;outside&gt; SQLite Explorer/);
            assert.doesNotMatch(container.innerHTML, /an unrelated message/);
            assert.match(container.innerHTML, /<button id="btnReloadDatabase" class="btn-primary">Reload Database<\/button>/);
            assert.strictEqual(listeners.click?.length, 1, 'the button was wired');

            state.isDbConnected = false;
            showErrorState('ignored');
            assert.match(container.innerHTML, /Database not opened/);
            assert.match(container.innerHTML, /Retry Connection/);

            // No reason: the plain error state, no button.
            state.reloadRequiredReason = null;
            showErrorState('plain failure');
            assert.match(container.innerHTML, /empty-title">Error</);
            assert.match(container.innerHTML, /plain failure/);
            assert.doesNotMatch(container.innerHTML, /btnReloadDatabase/);
        } finally {
            state.isDbConnected = false;
            state.reloadRequiredReason = null;
        }
    });

    it('the button drives reloadFromDisk, whose failure while disconnected becomes the new reason', async () => {
        const { container, button, listeners } = makeDocument();
        const stateModulePath = '../../core/ui/modules/state.js';
        const uiModulePath = '../../core/ui/modules/ui.js';
        const apiModulePath = '../../core/ui/modules/api.js';
        const sidebarModulePath = '../../core/ui/modules/sidebar.js';
        const { state } = await import(stateModulePath);
        const { showErrorState } = await import(uiModulePath);
        const { backendApi } = await import(apiModulePath);
        const { reloadFromDisk } = await import(sidebarModulePath);
        const originalRefreshFile = backendApi.refreshFile;
        let calls = 0;
        backendApi.refreshFile = async () => {
            calls++;
            throw new Error('still refused');
        };
        try {
            // Disconnected WITHOUT a reason: nothing to reload, the gate holds.
            state.isDbConnected = false;
            state.reloadRequiredReason = null;
            await reloadFromDisk();
            assert.strictEqual(calls, 0);

            // Disconnected WITH a reason: Retry Connection reaches the host.
            state.reloadRequiredReason = 'first refusal';
            showErrorState('ignored');
            await listeners.click[0]({ currentTarget: button });
            assert.strictEqual(calls, 1);
            // The failed retry is the new reason, painted in place, and the
            // button is usable again for the next attempt.
            assert.strictEqual(state.reloadRequiredReason, 'still refused');
            assert.match(container.innerHTML, /still refused/);
            assert.match(container.innerHTML, /Retry Connection/);
            assert.strictEqual(button.disabled, false);
        } finally {
            backendApi.refreshFile = originalRefreshFile;
            state.isDbConnected = false;
            state.reloadRequiredReason = null;
        }
    });
});
