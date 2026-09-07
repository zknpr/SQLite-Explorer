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
        state.renderedTable = 'items';
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

        state.isGridReloading = true;
        updateToolbarButtons();
        assert.strictEqual(controls.btnDeleteRows.disabled, true);
        state.isGridReloading = false;
        updateToolbarButtons();
        assert.strictEqual(controls.btnDeleteRows.disabled, false);
    });

    it('does not submit a stale toolbar deletion during a grid reload', async () => {
        const originalDocument = globalThis.document;
        (globalThis as any).document = {
            getElementById() { return null; },
            querySelectorAll() { return []; }
        };
        const stateModulePath = '../../core/ui/modules/state.js';
        const apiModulePath = '../../core/ui/modules/api.js';
        const crudModulePath = '../../core/ui/modules/crud.js';
        const { state } = await import(stateModulePath);
        const { backendApi } = await import(apiModulePath);
        const { submitDelete } = await import(crudModulePath);
        const originalDeleteRows = backendApi.deleteRows;
        const originalSelectedTable = state.selectedTable;
        const originalSelectedTableType = state.selectedTableType;
        let deleteCalls = 0;
        backendApi.deleteRows = async () => { deleteCalls++; };
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.selectedRowIds = new Set([1]);
        state.selectedColumns = new Set();
        state.isGridReloading = true;

        try {
            await submitDelete();
            assert.strictEqual(deleteCalls, 0);
        } finally {
            backendApi.deleteRows = originalDeleteRows;
            (globalThis as any).document = originalDocument;
            state.selectedTable = originalSelectedTable;
            state.selectedTableType = originalSelectedTableType;
            state.selectedRowIds.clear();
            state.selectedColumns.clear();
            state.isGridReloading = false;
        }
    });

    it('a reload-required reason forces read-only and a disconnected page gates every mutation control', async () => {
        const createViewButton = { disabled: false };
        const pragmaControl = { disabled: false };
        (globalThis as any).document = {
            getElementById(id: string) {
                return id === 'btnOpenCreateView' ? createViewButton : null;
            },
            querySelectorAll(selector: string) {
                return selector === '.setting-pragma' ? [pragmaControl] : [];
            }
        };
        const stateModulePath = '../../core/ui/modules/state.js';
        const connectionStateModulePath = '../../core/ui/modules/connection-state.js';
        const { state } = await import(stateModulePath);
        const { applyConnectionResult } = await import(connectionStateModulePath);

        // The host retired the connection (its file was replaced underneath the
        // engine): still "connected" — the tab exists, Reload is the recovery —
        // but nothing may edit, whatever the capability flag says.
        const reason = 'The database file was replaced, moved, deleted, or became unavailable outside SQLite Explorer.';
        assert.strictEqual(
            applyConnectionResult({ connected: true, readOnly: false, reloadRequiredReason: reason }),
            true
        );
        assert.strictEqual(state.isDbConnected, true);
        assert.strictEqual(state.reloadRequiredReason, reason);
        assert.strictEqual(state.isReadOnly, true);
        assert.strictEqual(createViewButton.disabled, true);
        assert.strictEqual(pragmaControl.disabled, true);

        // A malformed reason is no reason.
        applyConnectionResult({ connected: true, readOnly: false, reloadRequiredReason: 42 });
        assert.strictEqual(state.reloadRequiredReason, null);
        assert.strictEqual(state.isReadOnly, false);
        assert.strictEqual(createViewButton.disabled, false);
        assert.strictEqual(pragmaControl.disabled, false);

        // Disconnected gates the controls even when the envelope claims writable.
        assert.strictEqual(applyConnectionResult({ connected: false, readOnly: false }), false);
        assert.strictEqual(state.isReadOnly, true);
        assert.strictEqual(createViewButton.disabled, true);
        assert.strictEqual(pragmaControl.disabled, true);

        // A clean reconnect clears the reason.
        applyConnectionResult({ connected: true, readOnly: false });
        assert.strictEqual(state.reloadRequiredReason, null);
        assert.strictEqual(createViewButton.disabled, false);
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
