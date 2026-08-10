import './vscode_mock_setup';

import assert from 'node:assert';
import { afterEach, it, mock } from 'node:test';
import { DEFAULT_MAX_CELL_EDIT_BYTES } from '../../src/core/cell-edit-policy';

(globalThis as any).acquireVsCodeApi = () => ({
    getState: () => undefined,
    setState() {},
    postMessage() {}
});

const dndModulePath = '../../core/ui/modules/dnd.js';
const apiModulePath = '../../core/ui/modules/api.js';
const stateModulePath = '../../core/ui/modules/state.js';

const originalFileReader = (globalThis as any).FileReader;

afterEach(async () => {
    (globalThis as any).FileReader = originalFileReader;
    delete (globalThis as any).document;
    const { state } = await import(stateModulePath);
    state.selectedTable = null;
    state.selectedTableType = null;
    state.tableColumns = [];
    state.gridData = [];
    state.gridOversizedCells = {};
    state.isReadOnly = false;
    state.isGridReloading = false;
});

it('rejects a dropped file above the edit ceiling before FileReader runs', async () => {
    const containerListeners = new Map<string, (event: any) => unknown>();
    const status = { textContent: '' };
    const container = {
        addEventListener(type: string, listener: (event: any) => unknown) {
            containerListeners.set(type, listener);
        }
    };
    (globalThis as any).document = {
        addEventListener() {},
        getElementById(id: string) {
            if (id === 'gridContainer') return container;
            if (id === 'statusText') return status;
            return null;
        }
    };

    let fileReads = 0;
    (globalThis as any).FileReader = class {
        result = new ArrayBuffer(0);
        error = null;
        onload?: () => void;
        onerror?: () => void;
        readAsArrayBuffer() {
            fileReads++;
            this.onload?.();
        }
    };

    const { backendApi } = await import(apiModulePath);
    const { state } = await import(stateModulePath);
    const originalUpdateCell = backendApi.updateCell;
    const updateCell = mock.fn(async () => 1);
    backendApi.updateCell = updateCell;
    state.selectedTable = 'drop_target';
    state.selectedTableType = 'table';
    state.tableColumns = [{ name: 'payload', type: 'BLOB' }];
    state.gridData = [[1, new Uint8Array([1])]];
    state.isReadOnly = false;
    state.isGridReloading = false;

    const classList = {
        contains: () => false,
        remove() {}
    };
    const cell = {
        dataset: { rowidx: '0', colidx: '0' },
        classList,
        closest: (selector: string) => selector === '.data-cell' ? cell : null
    };

    try {
        const { initDragAndDrop } = await import(dndModulePath);
        initDragAndDrop();
        const drop = containerListeners.get('drop');
        assert.ok(drop);
        await drop({
            preventDefault() {},
            target: cell,
            dataTransfer: {
                files: [{
                    name: 'too-large.bin',
                    size: DEFAULT_MAX_CELL_EDIT_BYTES + 1
                }],
                getData: () => ''
            }
        });

        assert.strictEqual(fileReads, 0);
        assert.strictEqual(updateCell.mock.callCount(), 0);
        assert.match(status.textContent, /File too large.*Maximum is 16MB/i);
    } finally {
        backendApi.updateCell = originalUpdateCell;
    }
});
