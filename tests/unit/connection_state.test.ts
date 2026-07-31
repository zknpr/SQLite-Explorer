import './vscode_mock_setup';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';

describe('viewer connection state', () => {
    afterEach(() => {
        delete (globalThis as any).document;
    });

    it('honors a read-only initialization response in either viewer entry point', async () => {
        const createViewButton = { disabled: false };
        (globalThis as any).document = {
            getElementById(id: string) {
                return id === 'btnOpenCreateView' ? createViewButton : null;
            }
        };
        const stateModulePath = '../../core/ui/modules/state.js';
        const connectionStateModulePath = '../../core/ui/modules/connection-state.js';
        const { state } = await import(stateModulePath);
        const { applyConnectionResult } = await import(connectionStateModulePath);
        state.isDbConnected = false;
        state.isReadOnly = false;

        applyConnectionResult({ connected: true, readOnly: true });

        assert.strictEqual(state.isDbConnected, true);
        assert.strictEqual(state.isReadOnly, true);
        assert.strictEqual(createViewButton.disabled, true);
    });
});
