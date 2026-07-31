import './vscode_mock_setup';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';

describe('viewer connection state', () => {
    afterEach(() => {
        delete (globalThis as any).document;
    });

    it('honors a read-only initialization response in either viewer entry point', async () => {
        const mutationControlIds = [
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
        const controls = Object.fromEntries(
            [...mutationControlIds, 'btnAddRow', 'btnAddColumn', 'btnDeleteRows', 'btnExport']
                .map(id => [id, { disabled: false }])
        );
        (globalThis as any).document = {
            getElementById(id: string) {
                return controls[id] ?? null;
            }
        };
        const stateModulePath = '../../core/ui/modules/state.js';
        const connectionStateModulePath = '../../core/ui/modules/connection-state.js';
        const uiModulePath = '../../core/ui/modules/ui.js';
        const { state } = await import(stateModulePath);
        const { applyConnectionResult } = await import(connectionStateModulePath);
        const { updateToolbarButtons } = await import(uiModulePath);
        state.isDbConnected = false;
        state.isReadOnly = false;
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.selectedRowIds = new Set([1]);

        applyConnectionResult({ connected: true, readOnly: true });
        updateToolbarButtons();

        assert.strictEqual(state.isDbConnected, true);
        assert.strictEqual(state.isReadOnly, true);
        for (const id of mutationControlIds) {
            assert.strictEqual(controls[id].disabled, true, id);
        }
        assert.strictEqual(controls.btnAddRow.disabled, true);
        assert.strictEqual(controls.btnAddColumn.disabled, true);
        assert.strictEqual(controls.btnDeleteRows.disabled, true);
        assert.strictEqual(controls.btnExport.disabled, false);

        applyConnectionResult({ connected: true, readOnly: false });
        updateToolbarButtons();
        for (const id of mutationControlIds) {
            assert.strictEqual(controls[id].disabled, false, id);
        }
        assert.strictEqual(controls.btnAddRow.disabled, false);
        assert.strictEqual(controls.btnAddColumn.disabled, false);
        assert.strictEqual(controls.btnDeleteRows.disabled, false);
    });

    it('fails closed for disconnected or incomplete initialization envelopes', async () => {
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

        state.isDbConnected = true;
        state.isReadOnly = false;
        assert.strictEqual(applyConnectionResult(null), false);
        assert.strictEqual(state.isDbConnected, false);
        assert.strictEqual(state.isReadOnly, true);
        assert.strictEqual(createViewButton.disabled, true);

        assert.strictEqual(applyConnectionResult({ connected: true }), true);
        assert.strictEqual(state.isDbConnected, true);
        assert.strictEqual(state.isReadOnly, true);
        assert.strictEqual(createViewButton.disabled, true);

        assert.strictEqual(
            applyConnectionResult({ connected: true, isReadOnly: false }),
            true
        );
        assert.strictEqual(state.isReadOnly, false);
        assert.strictEqual(createViewButton.disabled, false);
    });
});
