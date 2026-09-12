import './vscode_mock_setup';

import assert from 'node:assert';
import { afterEach, it, mock } from 'node:test';
import { DEFAULT_MAX_CELL_EDIT_BYTES } from '../../src/core/cell-edit-policy';
import { createDeferred } from './helpers/deferred';

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
    state.gridExactIntegerTexts = {};
    state.isReadOnly = false;
    state.isGridReloading = false;
    state.isRefreshingContent = false;
    state.isLoadingData = false;
});

it('rejects an aborted browser FileReader instead of leaving an upload pending', async () => {
    (globalThis as any).FileReader = class {
        result = null;
        error = null;
        onload?: () => void;
        onerror?: () => void;
        onabort?: () => void;
        readAsArrayBuffer() {
            this.onabort?.();
        }
    };
    const { readFileAsArrayBuffer } = await import(dndModulePath);

    await assert.rejects(
        readFileAsArrayBuffer({ name: 'cancelled.bin' }),
        /file read was aborted/i
    );
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

it('uses the first real URI-list entry and resets overflow state after upload', async () => {
    const containerListeners = new Map<string, (event: any) => unknown>();
    const status = { textContent: '' };
    const classes = new Set(['checked-overflow', 'has-overflow']);
    const cell: any = {
        id: 'cell-0-0',
        dataset: { rowidx: '0', colidx: '0' },
        children: [] as any[],
        textContent: '',
        classList: {
            add: (...names: string[]) => names.forEach(name => classes.add(name)),
            remove: (...names: string[]) => names.forEach(name => classes.delete(name)),
            contains: (name: string) => classes.has(name)
        },
        closest(selector: string) {
            return selector === '.data-cell' ? this : null;
        },
        appendChild(child: any) {
            this.children.push(child);
            return child;
        }
    };
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
            if (id === 'vscode-env') return {};
            if (id === 'cell-0-0') return cell;
            return null;
        },
        createElement() {
            return { className: '', textContent: '', title: '' };
        }
    };

    const { backendApi } = await import(apiModulePath);
    const { state } = await import(stateModulePath);
    const originalRead = backendApi.readWorkspaceFileUri;
    const originalUpdate = backendApi.updateCell;
    const readUris: string[] = [];
    const updates: unknown[][] = [];
    backendApi.readWorkspaceFileUri = async (uri: string) => {
        readUris.push(uri);
        return new Uint8Array([7, 8, 9]);
    };
    backendApi.updateCell = async (...args: unknown[]) => {
        updates.push(args);
        return 1;
    };
    state.selectedTable = 'drop_target';
    state.selectedTableType = 'table';
    state.tableColumns = [{ name: 'payload', type: 'BLOB' }];
    state.gridData = [[1, new Uint8Array([1])]];
    state.connectionGeneration = 3;
    state.contentGeneration = 5;

    try {
        const { initDragAndDrop } = await import(dndModulePath);
        initDragAndDrop();
        const drop = containerListeners.get('drop');
        assert.ok(drop);
        await drop({
            preventDefault() {},
            target: cell,
            dataTransfer: {
                files: [],
                getData: (type: string) => type === 'text/uri-list'
                    ? '# VS Code URI list\r\n\r\nfile:///tmp/My%20Blob.bin\r\nfile:///tmp/ignored.bin'
                    : ''
            }
        });

        assert.deepStrictEqual(readUris, ['file:///tmp/My%20Blob.bin']);
        assert.strictEqual(updates.length, 1);
        assert.strictEqual(status.textContent, 'Uploaded My Blob.bin');
        assert.strictEqual(classes.has('checked-overflow'), false);
        assert.strictEqual(classes.has('has-overflow'), false);
    } finally {
        backendApi.readWorkspaceFileUri = originalRead;
        backendApi.updateCell = originalUpdate;
    }
});

it('rejects malformed legacy byte objects instead of silently coercing fields', async () => {
    const containerListeners = new Map<string, (event: any) => unknown>();
    const status = { textContent: '' };
    const cell: any = {
        dataset: { rowidx: '0', colidx: '0' },
        classList: { contains: () => false, remove() {} },
        closest(selector: string) {
            return selector === '.data-cell' ? this : null;
        }
    };
    (globalThis as any).document = {
        addEventListener() {},
        getElementById(id: string) {
            if (id === 'gridContainer') {
                return {
                    addEventListener(type: string, listener: (event: any) => unknown) {
                        containerListeners.set(type, listener);
                    }
                };
            }
            if (id === 'statusText') return status;
            if (id === 'vscode-env') return {};
            return null;
        }
    };

    const { backendApi } = await import(apiModulePath);
    const { state } = await import(stateModulePath);
    const originalRead = backendApi.readWorkspaceFileUri;
    const originalUpdate = backendApi.updateCell;
    const originalConsoleError = console.error;
    const update = mock.fn(async () => 1);
    const secret = 'database-secret-must-not-reach-console';
    const malformedPayload = {
        0: 1,
        length: 1,
        unrelated: secret
    } as any;
    const diagnostics: unknown[][] = [];
    backendApi.readWorkspaceFileUri = async () => malformedPayload;
    backendApi.updateCell = update;
    console.error = (...args: unknown[]) => { diagnostics.push(args); };
    state.selectedTable = 'drop_target';
    state.selectedTableType = 'table';
    state.tableColumns = [{ name: 'payload', type: 'BLOB' }];
    state.gridData = [[1, new Uint8Array([1])]];

    try {
        const { initDragAndDrop } = await import(dndModulePath);
        initDragAndDrop();
        await containerListeners.get('drop')?.({
            preventDefault() {},
            target: cell,
            dataTransfer: {
                files: [],
                getData: (type: string) => type === 'text/uri-list'
                    ? 'file:///tmp/payload.bin'
                    : ''
            }
        });

        assert.strictEqual(update.mock.callCount(), 0);
        assert.match(status.textContent, /invalid data format/i);
        assert.strictEqual(
            diagnostics.flat().some(value => value === malformedPayload || String(value).includes(secret)),
            false,
            'malformed database bytes must not be copied into extension-host diagnostics'
        );
    } finally {
        backendApi.readWorkspaceFileUri = originalRead;
        backendApi.updateCell = originalUpdate;
        console.error = originalConsoleError;
    }
});

it('reserves the upload before asynchronous file retrieval', async () => {
    const containerListeners = new Map<string, (event: any) => Promise<void>>();
    const status = { textContent: '' };
    const firstRead = createDeferred<Uint8Array>();
    const cell: any = {
        dataset: { rowidx: '0', colidx: '0' },
        classList: { contains: () => false, remove() {} },
        closest(selector: string) {
            return selector === '.data-cell' ? this : null;
        }
    };
    (globalThis as any).document = {
        addEventListener() {},
        getElementById(id: string) {
            if (id === 'gridContainer') {
                return {
                    addEventListener(type: string, listener: (event: any) => Promise<void>) {
                        containerListeners.set(type, listener);
                    }
                };
            }
            if (id === 'statusText') return status;
            if (id === 'vscode-env') return {};
            return null;
        }
    };

    const { backendApi } = await import(apiModulePath);
    const { state } = await import(stateModulePath);
    const originalRead = backendApi.readWorkspaceFileUri;
    const originalUpdate = backendApi.updateCell;
    let reads = 0;
    const update = mock.fn(async () => 1);
    backendApi.readWorkspaceFileUri = async () => {
        reads++;
        return reads === 1 ? firstRead.promise : new Uint8Array([2]);
    };
    backendApi.updateCell = update;
    state.selectedTable = 'drop_target';
    state.selectedTableType = 'table';
    state.tableColumns = [{ name: 'payload', type: 'BLOB' }];
    state.gridData = [[1, new Uint8Array([0])]];

    const event = (uri: string) => ({
        preventDefault() {},
        target: cell,
        dataTransfer: {
            files: [],
            getData: (type: string) => type === 'text/uri-list' ? uri : ''
        }
    });

    try {
        const { initDragAndDrop } = await import(dndModulePath);
        initDragAndDrop();
        const drop = containerListeners.get('drop');
        assert.ok(drop);
        const first = drop(event('file:///tmp/first.bin'));
        const duplicate = drop(event('file:///tmp/second.bin'));
        await Promise.resolve();

        assert.strictEqual(reads, 1, 'the duplicate must not allocate/read another file');
        firstRead.resolve(new Uint8Array([1]));
        await Promise.all([first, duplicate]);
        assert.strictEqual(update.mock.callCount(), 1);
    } finally {
        firstRead.resolve(new Uint8Array([1]));
        backendApi.readWorkspaceFileUri = originalRead;
        backendApi.updateCell = originalUpdate;
    }
});

it('Ctrl/Cmd+Z cancels a pending file read without reaching the previous Undo entry', async () => {
    const listeners = new Map<string, (event: any) => unknown>();
    const status = { textContent: '' };
    const cell: any = {
        dataset: { rowidx: '0', colidx: '0' },
        classList: { contains: () => false, remove() {} },
        closest: () => cell
    };
    (globalThis as any).document = {
        addEventListener(type: string, listener: (event: any) => unknown) { listeners.set(type, listener); },
        getElementById(id: string) {
            if (id === 'gridContainer') return this;
            if (id === 'statusText') return status;
            return null;
        }
    };
    let aborted = 0;
    let reader: any;
    (globalThis as any).FileReader = class {
        result = new ArrayBuffer(1);
        onload?: () => void;
        onabort?: () => void;
        readAsArrayBuffer() { reader = this; }
        abort() { aborted++; this.onabort?.(); }
    };
    const { backendApi } = await import(apiModulePath);
    const { state } = await import(stateModulePath);
    const update = mock.method(backendApi, 'updateCell', async () => 1);
    state.selectedTable = 'drop_target';
    state.selectedTableType = 'table';
    state.tableColumns = [{ name: 'payload', type: 'TEXT' }];
    state.gridData = [[1, new Uint8Array([0])]];
    const { initDragAndDrop } = await import(dndModulePath);
    initDragAndDrop();
    const pending = listeners.get('drop')!({
        preventDefault() {}, target: cell,
        dataTransfer: { files: [{ name: 'pending.bin', size: 1 }] }
    });
    let prevented = false;
    let stopped = false;
    try {
        listeners.get('keydown')?.({ key: 'z', ctrlKey: true, metaKey: false, shiftKey: false,
            altKey: false, isComposing: false, target: cell,
            preventDefault() { prevented = true; },
            stopImmediatePropagation() { stopped = true; }
        });
        // Let the old implementation settle too, so the failing regression
        // cannot leave an upload in flight for subsequent tests.
        if (!aborted) reader.onload();
        await pending;
        assert.equal(prevented, true, 'Undo must not be forwarded to the host while this drop is pending');
        assert.equal(stopped, true);
        assert.equal(aborted, 1);
        assert.equal(update.mock.callCount(), 0);
        assert.match(status.textContent, /upload cancelled/i);
    } finally { update.mock.restore(); }
});

it('blocks the previous Undo entry while the posted cell mutation is finishing', async () => {
    const listeners = new Map<string, (event: any) => unknown>();
    const status = { textContent: '' };
    const cell: any = {
        dataset: { rowidx: '0', colidx: '0' },
        classList: { contains: () => false, remove() {} }, closest: () => cell
    };
    (globalThis as any).document = {
        addEventListener(type: string, listener: (event: any) => unknown) { listeners.set(type, listener); },
        getElementById(id: string) {
            if (id === 'gridContainer') return this;
            if (id === 'statusText') return status;
            if (id === 'vscode-env') return {};
            return null;
        }
    };
    const { backendApi } = await import(apiModulePath);
    const { state } = await import(stateModulePath);
    state.selectedTable = 'drop_target';
    state.selectedTableType = 'table';
    state.tableColumns = [{ name: 'payload', type: 'TEXT' }];
    state.gridData = [[1, new Uint8Array([0])]];
    const committed = createDeferred<number>();
    const posted = createDeferred<void>();
    let signal: AbortSignal | undefined;
    const read = mock.method(backendApi, 'readWorkspaceFileUri', async () => new Uint8Array([1]));
    const update = mock.method(backendApi, 'updateCell', async (...args: any[]) => {
        const options = args[5];
        signal = options.signal;
        options.onDidPost();
        posted.resolve();
        return committed.promise;
    });
    const { initDragAndDrop } = await import(dndModulePath);
    initDragAndDrop();
    const pending = listeners.get('drop')!({
        preventDefault() {}, target: cell,
        dataTransfer: { files: [], getData: () => 'file:///private/committing.bin' }
    });
    try {
        await posted.promise;
        let prevented = 0;
        const undo = { key: 'z', metaKey: true, target: cell,
            preventDefault() { prevented++; }, stopImmediatePropagation() {} };
        listeners.get('keydown')!(undo);
        assert.equal(prevented, 1);
        assert.equal(signal?.aborted, false);
        assert.match(status.textContent, /finishing.*Undo after it completes/i);
        committed.resolve(1); await pending;
        listeners.get('keydown')!(undo);
        assert.equal(prevented, 1, 'normal Undo is available again once the mutation finishes');
    } finally {
        committed.resolve(1);
        await pending;
        read.mock.restore(); update.mock.restore();
    }
});

it('cancels an Explorer upload while workspace file retrieval is pending', async () => {
    const listeners = new Map<string, (event: any) => unknown>();
    const status = { textContent: '' };
    const cell: any = {
        dataset: { rowidx: '0', colidx: '0' },
        classList: { contains: () => false, remove() {} }, closest: () => cell
    };
    (globalThis as any).document = {
        addEventListener(type: string, listener: (event: any) => unknown) { listeners.set(type, listener); },
        getElementById(id: string) {
            if (id === 'gridContainer') return this;
            if (id === 'statusText') return status;
            if (id === 'vscode-env') return {};
            return null;
        }
    };
    const { backendApi } = await import(apiModulePath);
    const { state } = await import(stateModulePath);
    state.selectedTable = 'drop_target';
    state.selectedTableType = 'table';
    state.tableColumns = [{ name: 'payload', type: 'TEXT' }];
    state.gridData = [[1, new Uint8Array([0])]];
    const retrieved = createDeferred<Uint8Array>();
    const read = mock.method(backendApi, 'readWorkspaceFileUri', async () => retrieved.promise);
    const update = mock.method(backendApi, 'updateCell', async () => 1);
    const { initDragAndDrop } = await import(dndModulePath);
    initDragAndDrop();
    const event = { preventDefault() {}, target: cell,
        dataTransfer: { files: [], getData: () => 'file:///private/pending-workspace.bin' } };
    const pending = listeners.get('drop')!(event);
    try {
        assert.equal(read.mock.callCount(), 1);
        let prevented = false;
        listeners.get('keydown')!({ key: 'z', ctrlKey: true, target: cell,
            preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
        assert.equal(prevented, true, 'pending Explorer reads must protect the preceding Undo entry');
        retrieved.resolve(new Uint8Array([1, 2]));
        await pending;
        assert.equal(update.mock.callCount(), 0, 'a late file read must not write after cancellation');
        assert.match(status.textContent, /Upload cancelled/);
        await listeners.get('drop')!(event);
        assert.equal(update.mock.callCount(), 1, 'the cancelled upload releases its reservation after I/O settles');
    } finally {
        retrieved.resolve(new Uint8Array([1, 2])); await pending;
        read.mock.restore(); update.mock.restore();
    }
});
