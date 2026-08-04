import './vscode_mock_setup';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { createDeferred } from './helpers/deferred';

(globalThis as any).acquireVsCodeApi = () => ({
    getState: () => undefined,
    setState() {},
    postMessage() {}
});

const stateModulePath = '../../core/ui/modules/state.js';
const textEditorModulePath = '../../core/ui/modules/text-editor.js';
const editModulePath = '../../core/ui/modules/edit.js';
const gridEventsModulePath = '../../core/ui/modules/grid-events.js';
const globalShortcutsModulePath = '../../core/ui/modules/global-shortcuts.js';
const dndModulePath = '../../core/ui/modules/dnd.js';
const clipboardModulePath = '../../core/ui/modules/clipboard.js';

function createClassList(initial: string[] = []) {
    const classes = new Set(initial);
    return {
        add: (...names: string[]) => names.forEach(name => classes.add(name)),
        remove: (...names: string[]) => names.forEach(name => classes.delete(name)),
        contains: (name: string) => classes.has(name),
        toggle: (name: string, force?: boolean) => {
            const enabled = force ?? !classes.has(name);
            if (enabled) classes.add(name);
            else classes.delete(name);
            return enabled;
        }
    };
}

function createTextarea(value: string, selectionStart: number, selectionEnd = selectionStart) {
    return {
        value,
        selectionStart,
        selectionEnd,
        readOnly: false,
        disabled: false,
        dispatchEvent() {}
    };
}

describe('editor keyboard and grid selection interactions', () => {
    afterEach(async () => {
        delete (globalThis as any).document;
        const { state } = await import(stateModulePath);
        state.editingCellInfo = null;
        state.activeCellInput = null;
        state.isSavingCell = false;
        state.isTransitioningEdit = false;
        state.selectedCells = [];
        state.selectedRowIds.clear();
        state.selectedColumns.clear();
        state.lastSelectedCell = null;
        state.tableColumns = [];
        state.gridData = [];
        state.gridExactIntegerTexts = {};
        state.gridOversizedCells = {};
        state.gridReadOnlyRowReasons = {};
        state.pinnedColumns.clear();
        state.pinnedRowIds.clear();
        state.selectedTable = null;
        state.selectedTableType = 'table';
        state.isReadOnly = false;
        state.cellPreviewInfo = null;
        state.isLoadingData = false;
        state.matchNav = { scope: null, term: null, matches: [], currentIndex: -1 };
    });

    it('keeps unsafe rowids exact when resolving grid DOM identities', async () => {
        const { resolveRowIdType } = await import(gridEventsModulePath);
        assert.strictEqual(resolveRowIdType('42'), 42);
        assert.strictEqual(resolveRowIdType('9007199254740993'), '9007199254740993');
        assert.strictEqual(resolveRowIdType('-9007199254740993'), '-9007199254740993');
    });

    it('inserts indentation and outdents selected lines in multiline editors', async () => {
        const { handleTextareaTab } = await import(textEditorModulePath);
        const insertion = createTextarea('SELECT\nvalue', 7);
        let prevented = 0;

        assert.strictEqual(handleTextareaTab({
            key: 'Tab',
            shiftKey: false,
            target: insertion,
            preventDefault() { prevented++; }
        }), true);
        assert.strictEqual(insertion.value, 'SELECT\n    value');
        assert.strictEqual(insertion.selectionStart, 11);
        assert.strictEqual(insertion.selectionEnd, 11);

        const outdent = createTextarea('    one\n\ttwo\n  three', 0, 22);
        assert.strictEqual(handleTextareaTab({
            key: 'Tab',
            shiftKey: true,
            target: outdent,
            preventDefault() { prevented++; }
        }), true);
        assert.strictEqual(outdent.value, 'one\ntwo\nthree');
        assert.strictEqual(outdent.selectionStart, 0);
        assert.strictEqual(outdent.selectionEnd, outdent.value.length);
        assert.strictEqual(prevented, 2);
    });

    it('lets Escape arm the next Tab to leave a multiline editor', async () => {
        const { handleTextareaTab } = await import(textEditorModulePath);
        const textarea = createTextarea('SELECT 1', 8);
        let prevented = 0;
        let stopped = 0;

        assert.strictEqual(handleTextareaTab({
            key: 'Escape',
            shiftKey: false,
            target: textarea,
            preventDefault() { prevented++; },
            stopPropagation() { stopped++; }
        }), true);
        assert.strictEqual(prevented, 1);
        assert.strictEqual(stopped, 1);

        assert.strictEqual(handleTextareaTab({
            key: 'Tab',
            shiftKey: false,
            target: textarea,
            preventDefault() { prevented++; }
        }), false);
        assert.strictEqual(prevented, 1);
        assert.strictEqual(textarea.value, 'SELECT 1');

        assert.strictEqual(handleTextareaTab({
            key: 'Tab',
            shiftKey: false,
            target: textarea,
            preventDefault() { prevented++; }
        }), true);
        assert.strictEqual(prevented, 2);
        assert.strictEqual(textarea.value, 'SELECT 1    ');
    });

    it('wires Tab indentation into the modal cell editor', async () => {
        const listeners = new Map<string, (event: any) => any>();
        const element = (id: string) => ({
            id,
            value: '',
            addEventListener(type: string, listener: (event: any) => any) {
                listeners.set(`${id}:${type}`, listener);
            },
            querySelectorAll() { return []; }
        });
        const elements: Record<string, any> = {
            'blob-inspector-modal': element('blob-inspector-modal'),
            cellPreviewTextarea: element('cellPreviewTextarea')
        };
        (globalThis as any).document = {
            getElementById(id: string) {
                if (!elements[id]) elements[id] = element(id);
                return elements[id];
            },
            querySelector() { return null; }
        };
        const { initEdit } = await import(editModulePath);
        initEdit();

        const textarea = Object.assign(elements.cellPreviewTextarea, createTextarea('a\nb', 2));
        let prevented = false;
        const listener = listeners.get('cellPreviewTextarea:keydown');
        assert.ok(listener, 'modal cell editor keydown listener was not registered');
        listener({
            key: 'Tab',
            shiftKey: false,
            target: textarea,
            preventDefault() { prevented = true; }
        });

        assert.strictEqual(prevented, true);
        assert.strictEqual(textarea.value, 'a\n    b');

        listener({
            key: 'Escape',
            shiftKey: false,
            target: textarea,
            preventDefault() {},
            stopPropagation() {}
        });
        const blur = listeners.get('cellPreviewTextarea:blur');
        assert.ok(blur, 'modal cell editor blur listener was not registered');
        blur({ target: textarea });
        textarea.value = 'value';
        textarea.selectionStart = textarea.value.length;
        textarea.selectionEnd = textarea.value.length;
        listener({
            key: 'Tab',
            shiftKey: false,
            target: textarea,
            preventDefault() {}
        });
        assert.strictEqual(textarea.value, 'value    ');
    });

    it('blocks Ctrl+Enter cell-preview saves for read-only table documents', async () => {
        const apiModulePath = '../../core/ui/modules/api.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { onCellPreviewKeydown } = await import(editModulePath);
        const originalUpdateCell = backendApi.updateCell;
        let updateCalls = 0;
        let textareaLookups = 0;
        let prevented = false;
        backendApi.updateCell = async () => {
            updateCalls++;
            return new Promise(() => {});
        };
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'cellPreviewTextarea') {
                    textareaLookups++;
                    return { value: 'changed' };
                }
                if (id === 'statusText') return { textContent: '' };
                return null;
            }
        };
        state.isReadOnly = true;
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'value', type: 'TEXT' }];
        state.gridData = [[7, 'original']];
        state.cellPreviewInfo = {
            rowIdx: 0,
            colIdx: 0,
            rowId: 7,
            columnName: 'value',
            originalValue: 'original'
        };

        try {
            onCellPreviewKeydown({
                key: 'Enter',
                ctrlKey: true,
                metaKey: false,
                preventDefault() { prevented = true; }
            });

            assert.strictEqual(prevented, true);
            assert.strictEqual(textareaLookups, 0, 'the read-only guard must run before reading the draft');
            assert.strictEqual(updateCalls, 0);
        } finally {
            backendApi.updateCell = originalUpdateCell;
        }
    });

    it('applies a delayed cell-preview save by row and column identity after a refresh reorders the grid', async () => {
        const apiModulePath = '../../core/ui/modules/api.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { saveCellPreview } = await import(editModulePath);
        const originalUpdateCell = backendApi.updateCell;
        const update = createDeferred<void>();
        const paintedCells: string[] = [];
        const modal = { classList: createClassList() };
        const textarea = { value: 'replacement' };
        const cells = new Map<string, any>();
        for (const id of ['cell-0-0', 'cell-0-1', 'cell-1-0', 'cell-1-1']) {
            cells.set(id, {
                classList: createClassList(),
                textContent: '',
                children: [] as any[],
                appendChild(child: any) {
                    this.children.push(child);
                    if (child.className === 'cell-text') paintedCells.push(id);
                }
            });
        }
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'cellPreviewTextarea') return textarea;
                if (id === 'cellPreviewModal') return modal;
                if (id === 'statusText') return { textContent: '' };
                return cells.get(id) ?? null;
            },
            querySelectorAll() { return []; },
            querySelector() { return null; },
            createElement() {
                return {
                    className: '',
                    textContent: '',
                    title: '',
                    scrollWidth: 0,
                    clientWidth: 0
                };
            }
        };
        backendApi.updateCell = async () => update.promise;
        state.isReadOnly = false;
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [
            { name: 'value', type: 'INTEGER', notnull: 0 },
            { name: 'note', type: 'TEXT', notnull: 0 }
        ];
        state.gridData = [
            [1, 9007199254740992, 'first note'],
            [2, 9007199254740994, 'second note']
        ];
        state.gridExactIntegerTexts = {
            0: { 1: '9007199254740993' },
            1: { 1: '9007199254740995' }
        };
        state.cellPreviewInfo = {
            rowIdx: 0,
            colIdx: 0,
            rowId: 1,
            columnName: 'value',
            originalValue: 9007199254740992
        };

        try {
            const pendingSave = saveCellPreview();

            // Mirror a broadcast refresh landing while the update RPC is pending:
            // both row and column positions now identify different cells.
            state.tableColumns = [
                { name: 'note', type: 'TEXT', notnull: 0 },
                { name: 'value', type: 'INTEGER', notnull: 0 }
            ];
            state.gridData = [
                [2, 'second note', 9007199254740994],
                [1, 'first note', 9007199254740992]
            ];
            state.gridExactIntegerTexts = {
                0: { 2: '9007199254740995' },
                1: { 2: '9007199254740993' }
            };

            update.resolve();
            await pendingSave;

            assert.deepStrictEqual(state.gridData, [
                [2, 'second note', 9007199254740994],
                [1, 'first note', 'replacement']
            ]);
            assert.deepStrictEqual(state.gridExactIntegerTexts, {
                0: { 2: '9007199254740995' }
            });
            assert.deepStrictEqual(paintedCells, ['cell-1-1']);
        } finally {
            backendApi.updateCell = originalUpdateCell;
        }
    });

    it('aborts a BLOB drop when the selected table changes during the file read', async () => {
        const listeners = new Map<string, (event: any) => Promise<void>>();
        const source = createDeferred<Uint8Array>();
        const cell = {
            dataset: { rowidx: '0', colidx: '0' },
            classList: createClassList(),
            children: [] as any[],
            closest(selector: string) {
                return selector === '.data-cell' ? this : null;
            },
            appendChild(child: any) { this.children.push(child); }
        };
        const container = {
            addEventListener(type: string, listener: (event: any) => Promise<void>) {
                listeners.set(type, listener);
            }
        };
        const status = { textContent: '' };
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'gridContainer') return container;
                if (id === 'statusText') return status;
                return null;
            },
            addEventListener() {},
            createElement() {
                return { className: '', textContent: '', title: '' };
            }
        };

        const apiModulePath = '../../core/ui/modules/api.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { initDragAndDrop } = await import(dndModulePath);
        const originalReadWorkspaceFileUri = backendApi.readWorkspaceFileUri;
        const originalUpdateCell = backendApi.updateCell;
        const updateCalls: unknown[][] = [];
        backendApi.readWorkspaceFileUri = async () => source.promise;
        backendApi.updateCell = async (...args: unknown[]) => {
            updateCalls.push(args);
        };
        state.selectedTable = 'first_table';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'payload', type: 'BLOB' }];
        state.gridData = [[11, new Uint8Array([1])]];
        state.isReadOnly = false;
        state.isGridReloading = false;
        initDragAndDrop();
        const drop = listeners.get('drop');
        assert.ok(drop, 'grid drop listener was not registered');

        try {
            const pendingDrop = drop({
                preventDefault() {},
                target: cell,
                dataTransfer: {
                    files: [],
                    getData(type: string) {
                        return type === 'text/uri-list' ? 'file:///tmp/payload.bin' : '';
                    }
                }
            });

            state.selectedTable = 'second_table';
            state.tableColumns = [{ name: 'different_payload', type: 'BLOB' }];
            state.gridData = [[22, new Uint8Array([2])]];
            source.resolve(new Uint8Array([9, 8, 7]));
            await pendingDrop;

            assert.deepStrictEqual(updateCalls, []);
            assert.deepStrictEqual(state.gridData, [[22, new Uint8Array([2])]]);
        } finally {
            backendApi.readWorkspaceFileUri = originalReadWorkspaceFileUri;
            backendApi.updateCell = originalUpdateCell;
        }
    });

    it('undoes a slow BLOB upload to the value written concurrently during the read', async () => {
        const listeners = new Map<string, (event: any) => Promise<void>>();
        const source = createDeferred<Uint8Array>();
        const cell = {
            dataset: { rowidx: '0', colidx: '0' },
            classList: createClassList(),
            children: [] as any[],
            closest(selector: string) {
                return selector === '.data-cell' ? this : null;
            },
            appendChild(child: any) { this.children.push(child); }
        };
        const container = {
            addEventListener(type: string, listener: (event: any) => Promise<void>) {
                listeners.set(type, listener);
            }
        };
        const status = { textContent: '' };
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'gridContainer') return container;
                if (id === 'statusText') return status;
                if (id === 'cell-0-0') return cell;
                return null;
            },
            addEventListener() {},
            createElement() {
                return { className: '', textContent: '', title: '' };
            }
        };

        const apiModulePath = '../../core/ui/modules/api.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { initDragAndDrop } = await import(dndModulePath);
        const { HostBridge } = await import('../../src/hostBridge');
        const { createDatabaseEngine } = await import('../../src/core/sqlite-db');
        const database = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const engine = database.operations!;
        const originalReadWorkspaceFileUri = backendApi.readWorkspaceFileUri;
        const originalUpdateCell = backendApi.updateCell;
        // The grid's number contract rounded the stored int64 and retained its
        // exact digits in the sparse sidecar before the user dropped a BLOB.
        const initialValue = 9007199254740992;
        const concurrentValue = new Uint8Array([4, 5]);
        const uploadedValue = new Uint8Array([9, 8, 7]);
        let recordedModification: any;

        await engine.executeQuery(
            'CREATE TABLE uploads (payload); ' +
            'INSERT INTO uploads (payload) VALUES (9007199254740993)'
        );
        const bridge = new HostBridge({
            webviews: new Map(),
            context: {},
            isReadOnly: false
        } as any, {
            databaseOperations: engine,
            isReadOnlyMode: false,
            recordExternalModification(modification: any) {
                recordedModification = modification;
            }
        } as any);

        backendApi.readWorkspaceFileUri = async () => source.promise;
        backendApi.updateCell = (...args: any[]) => (bridge.updateCell as any)(...args);
        state.selectedTable = 'uploads';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'payload', type: '' }];
        state.gridData = [[1, initialValue]];
        state.gridExactIntegerTexts = { 0: { 1: '9007199254740993' } };
        state.isReadOnly = false;
        state.isGridReloading = false;
        initDragAndDrop();
        const drop = listeners.get('drop');
        assert.ok(drop, 'grid drop listener was not registered');

        try {
            const pendingDrop = drop({
                preventDefault() {},
                target: cell,
                dataTransfer: {
                    files: [],
                    getData(type: string) {
                        return type === 'text/uri-list' ? 'file:///tmp/payload.bin' : '';
                    }
                }
            });

            // Simulate another panel writing while the URI read is still pending.
            await engine.updateCell('uploads', 1, 'payload', concurrentValue);
            source.resolve(uploadedValue);
            await pendingDrop;

            assert.ok(recordedModification, 'the upload modification was not recorded');
            assert.deepStrictEqual(
                state.gridExactIntegerTexts,
                {},
                'the BLOB must not retain the replaced INTEGER text sidecar'
            );
            await engine.undoModification(recordedModification);
            const result = await engine.executeQuery(
                'SELECT payload FROM uploads WHERE rowid = ?',
                [1]
            );
            const restoredValue = result[0]?.rows[0]?.[0];
            assert.ok(restoredValue instanceof Uint8Array);
            assert.deepStrictEqual(
                Array.from(restoredValue),
                Array.from(concurrentValue),
                'undo must preserve the value written while the upload was reading'
            );
        } finally {
            backendApi.readWorkspaceFileUri = originalReadWorkspaceFileUri;
            backendApi.updateCell = originalUpdateCell;
            (engine as any).shutdown();
        }
    });

    it('commits an inline edit on Tab and advances to the next cell', async () => {
        const listeners = new Map<string, (event: any) => any>();
        const makeCell = (id: string) => ({
            id,
            innerHTML: '',
            textContent: '',
            classList: createClassList(),
            children: [] as any[],
            appendChild(child: any) { this.children.push(child); },
            querySelector() { return null; }
        });
        const cells: Record<string, any> = {
            'cell-0-0': makeCell('cell-0-0'),
            'cell-0-1': makeCell('cell-0-1')
        };
        const createdTextareas: any[] = [];
        (globalThis as any).document = {
            getElementById(id: string) { return cells[id] ?? null; },
            querySelectorAll() { return []; },
            querySelector() { return null; },
            createElement(tag: string) {
                const created: any = {
                    className: '',
                    textContent: '',
                    value: '',
                    classList: createClassList(),
                    style: {},
                    scrollWidth: 0,
                    clientWidth: 0,
                    addEventListener(type: string, listener: (event: any) => any) {
                        listeners.set(`${tag}:${type}`, listener);
                    },
                    removeEventListener() {},
                    focus() { this.focused = true; }
                };
                if (tag === 'textarea') createdTextareas.push(created);
                return created;
            }
        };
        const { state } = await import(stateModulePath);
        const { onCellInputKeydown } = await import(editModulePath);
        const currentInput = {
            value: 'alpha',
            removeEventListener() {}
        };
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'first', type: 'TEXT' }, { name: 'second', type: 'TEXT' }];
        state.gridData = [[7, 'alpha', 'beta']];
        state.editingCellInfo = {
            rowIdx: 0,
            colIdx: 0,
            rowId: 7,
            columnName: 'first',
            originalValue: 'alpha'
        };
        state.activeCellInput = currentInput;
        let prevented = false;

        await onCellInputKeydown({
            key: 'Tab',
            shiftKey: false,
            preventDefault() { prevented = true; }
        });

        assert.strictEqual(prevented, true);
        assert.strictEqual(state.editingCellInfo?.rowIdx, 0);
        assert.strictEqual(state.editingCellInfo?.colIdx, 1);
        assert.strictEqual(state.editingCellInfo?.rowId, 7);
        assert.strictEqual(createdTextareas.length, 1);
        assert.strictEqual(createdTextareas[0].value, 'beta');
        assert.strictEqual(createdTextareas[0].focused, true);

        await onCellInputKeydown({
            key: 'Tab',
            shiftKey: true,
            preventDefault() { prevented = true; }
        });
        assert.strictEqual(state.editingCellInfo?.colIdx, 0);
        assert.strictEqual(createdTextareas.length, 2);
        assert.strictEqual(createdTextareas[1].value, 'alpha');
        assert.strictEqual(createdTextareas[1].focused, true);
    });

    it('invalidates cached match navigation after a local inline edit', async () => {
        const apiModulePath = '../../core/ui/modules/api.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { saveCellEdit } = await import(editModulePath);
        const originalUpdateCell = backendApi.updateCell;
        const updateCalls: unknown[][] = [];
        const matchCounter = { textContent: '1/1' };
        const cell = {
            dataset: { rowidx: '0', colidx: '0' },
            textContent: '',
            children: [] as any[],
            classList: createClassList(['editing', 'active-match-cell']),
            appendChild(child: any) { this.children.push(child); },
            querySelector() { return null; }
        };
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'cell-0-0') return cell;
                if (id === 'filterMatchCounter') return matchCounter;
                if (id === 'statusText') return { textContent: '' };
                return null;
            },
            querySelectorAll(selector: string) {
                if (selector === '.active-match-cell') return [cell];
                return [];
            },
            querySelector() { return null; },
            createElement() {
                return {
                    className: '',
                    textContent: '',
                    title: '',
                    scrollWidth: 0,
                    clientWidth: 0
                };
            }
        };
        backendApi.updateCell = async (...args: unknown[]) => {
            updateCalls.push(args);
        };
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'value', type: 'TEXT', notnull: 0 }];
        state.gridData = [[7, 'old match']];
        state.editingCellInfo = {
            rowIdx: 0,
            colIdx: 0,
            rowId: 7,
            columnName: 'value',
            originalValue: 'old match'
        };
        state.activeCellInput = {
            value: 'replacement',
            removeEventListener() {}
        };
        state.matchNav = {
            scope: 'value',
            term: 'old',
            matches: [{ rowIdx: 0, colIdx: 0 }],
            currentIndex: 0
        };

        try {
            assert.strictEqual(await saveCellEdit(), true);

            assert.deepStrictEqual(updateCalls, [[
                'items', 7, 'value', 'replacement', 'old match'
            ]]);
            assert.deepStrictEqual(state.gridData, [[7, 'replacement']]);
            assert.deepStrictEqual(state.matchNav, {
                scope: null,
                term: null,
                matches: [],
                currentIndex: -1
            });
            assert.strictEqual(cell.classList.contains('active-match-cell'), false);
            assert.strictEqual(matchCounter.textContent, '');
        } finally {
            backendApi.updateCell = originalUpdateCell;
        }
    });

    it('does not repaint matching row and column identities in a table selected during an inline save', async () => {
        const apiModulePath = '../../core/ui/modules/api.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { saveCellEdit } = await import(editModulePath);
        const originalUpdateCell = backendApi.updateCell;
        const update = createDeferred<void>();
        const updateCalls: unknown[][] = [];
        const paintedValues: string[] = [];
        const cell = {
            textContent: '',
            children: [] as any[],
            classList: createClassList(['active-match-cell']),
            appendChild(child: any) {
                this.children.push(child);
                if (child.className === 'cell-text') paintedValues.push(child.textContent);
            }
        };
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'cell-0-0') return cell;
                if (id === 'statusText' || id === 'filterMatchCounter') return { textContent: '' };
                return null;
            },
            querySelectorAll(selector: string) {
                return selector === '.active-match-cell' ? [cell] : [];
            },
            querySelector() { return null; },
            createElement() {
                return {
                    className: '',
                    textContent: '',
                    title: '',
                    scrollWidth: 0,
                    clientWidth: 0
                };
            }
        };
        backendApi.updateCell = async (...args: unknown[]) => {
            updateCalls.push(args);
            return update.promise;
        };
        state.selectedTable = 'source_items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'value', type: 'TEXT', notnull: 0 }];
        state.gridData = [[7, 'source value']];
        state.gridExactIntegerTexts = {};
        state.editingCellInfo = {
            rowIdx: 0,
            colIdx: 0,
            rowId: 7,
            columnName: 'value',
            originalValue: 'source value'
        };
        state.activeCellInput = {
            value: 'saved source value',
            removeEventListener() {}
        };

        try {
            const pendingSave = saveCellEdit();

            // The newly selected table happens to expose the same rowid and
            // column name, but it is not the update target.
            state.selectedTable = 'target_items';
            state.tableColumns = [{ name: 'value', type: 'INTEGER', notnull: 0 }];
            state.gridData = [[7, 9007199254740992]];
            state.gridExactIntegerTexts = { 0: { 1: '9007199254740993' } };
            state.selectedCells = [{ rowIdx: 0, colIdx: 0, value: 9007199254740992 }];
            state.matchNav = {
                scope: 'value',
                term: '993',
                matches: [{ rowIdx: 0, colIdx: 0 }],
                currentIndex: 0
            };

            update.resolve();
            assert.strictEqual(await pendingSave, true);

            assert.deepStrictEqual(updateCalls, [[
                'source_items', 7, 'value', 'saved source value', 'source value'
            ]]);
            assert.deepStrictEqual(state.gridData, [[7, 9007199254740992]]);
            assert.deepStrictEqual(state.gridExactIntegerTexts, {
                0: { 1: '9007199254740993' }
            });
            assert.deepStrictEqual(state.selectedCells, [
                { rowIdx: 0, colIdx: 0, value: 9007199254740992 }
            ]);
            assert.deepStrictEqual(state.matchNav, {
                scope: 'value',
                term: '993',
                matches: [{ rowIdx: 0, colIdx: 0 }],
                currentIndex: 0
            });
            assert.deepStrictEqual(paintedValues, []);
        } finally {
            backendApi.updateCell = originalUpdateCell;
        }
    });

    it('reveals an inline editor clear of sticky columns before focusing it', async () => {
        const stickyColumn = {
            getBoundingClientRect: () => ({
                left: 0, top: 0, right: 150, bottom: 300, width: 150, height: 300
            })
        };
        const container = {
            scrollLeft: 100,
            scrollTop: 0,
            getBoundingClientRect: () => ({
                left: 0, top: 0, right: 500, bottom: 300, width: 500, height: 300
            }),
            querySelector(selector: string) {
                return selector.includes('row-number') ? stickyColumn : null;
            },
            querySelectorAll(selector: string) {
                return selector.includes('row-number') ? [stickyColumn] : [];
            }
        };
        const cell = {
            innerHTML: '',
            classList: createClassList(),
            children: [] as any[],
            closest: () => null,
            getBoundingClientRect: () => ({
                left: 80, top: 160, right: 180, bottom: 190, width: 100, height: 30
            }),
            appendChild(child: any) { this.children.push(child); }
        };
        let scrollLeftWhenFocused: number | undefined;
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'gridContainer') return container;
                if (id === 'cell-0-0') return cell;
                return null;
            },
            createElement() {
                return {
                    className: '',
                    value: '',
                    spellcheck: false,
                    addEventListener() {},
                    removeEventListener() {},
                    focus() { scrollLeftWhenFocused = container.scrollLeft; }
                };
            }
        };
        const { state } = await import(stateModulePath);
        const { startCellEdit } = await import(editModulePath);
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'value', type: 'TEXT' }];
        state.gridData = [[1, 'draft']];

        startCellEdit(0, 0, 1);

        assert.strictEqual(container.scrollLeft, 30);
        assert.strictEqual(scrollLeftWhenFocused, 30);
    });

    it('refuses inline editing of a bounded oversized preview with the exact byte count', async () => {
        const status = { textContent: '' };
        const cell = {
            innerHTML: '',
            classList: createClassList(),
            children: [] as any[],
            appendChild(child: any) { this.children.push(child); }
        };
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'statusText') return status;
                if (id === 'cell-0-0') return cell;
                return null;
            }
        };
        const { state } = await import(stateModulePath);
        const { startCellEdit } = await import(editModulePath);
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'value', type: 'TEXT' }];
        state.gridData = [[1, 'bounded preview']];
        state.gridOversizedCells = {
            0: { 1: { storageClass: 'text', byteLength: 268435456 } }
        };

        startCellEdit(0, 0, 1);

        assert.strictEqual(state.editingCellInfo, null);
        assert.strictEqual(cell.children.length, 0);
        assert.strictEqual(
            status.textContent,
            'Too large to edit inline — 268,435,456 bytes (TEXT)'
        );
    });

    it('keeps batch clear blocked but permits confirmed single-cell replacement affordances', async () => {
        const listeners = new Map<string, (event: any) => any>();
        const status = { textContent: '' };
        const cell = {
            dataset: { rowidx: '0', colidx: '0' },
            classList: createClassList(),
            closest(selector: string) {
                return selector === '.data-cell' ? this : null;
            }
        };
        const container = {
            addEventListener(type: string, listener: (event: any) => any) {
                listeners.set(type, listener);
            }
        };
        (globalThis as any).document = {
            addEventListener() {},
            createElement() {
                return { className: '', textContent: '', title: '' };
            },
            getElementById(id: string) {
                if (id === 'gridContainer') return container;
                if (id === 'statusText') return status;
                return null;
            }
        };
        const apiModulePath = '../../core/ui/modules/api.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { clearSelectedCellValues } = await import(clipboardModulePath);
        const { initDragAndDrop } = await import(dndModulePath);
        const originalUpdateCellBatch = backendApi.updateCellBatch;
        const originalUpdateCell = backendApi.updateCell;
        const originalReadWorkspaceFileUri = backendApi.readWorkspaceFileUri;
        let batchUpdateCalls = 0;
        let singleUpdateCalls = 0;
        backendApi.updateCellBatch = async () => {
            batchUpdateCalls++;
            throw new Error('unexpected backend update');
        };
        backendApi.readWorkspaceFileUri = async () => new Uint8Array([1, 2, 3]);
        backendApi.updateCell = async () => {
            singleUpdateCalls++;
            return 1;
        };
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'payload', type: 'BLOB' }];
        state.gridData = [[1, new Uint8Array([0xde, 0xad])]];
        state.gridOversizedCells = {
            0: { 1: { storageClass: 'blob', byteLength: 4096 } }
        };
        state.selectedCells = [{
            rowIdx: 0,
            colIdx: 0,
            rowId: 1,
            value: state.gridData[0][1]
        }];

        try {
            await clearSelectedCellValues();
            assert.strictEqual(batchUpdateCalls, 0);
            assert.strictEqual(status.textContent, 'Too large to edit inline — 4,096 bytes (BLOB)');

            status.textContent = '';
            initDragAndDrop();
            await listeners.get('drop')?.({
                preventDefault() {},
                target: cell,
                dataTransfer: {
                    files: [],
                    getData: (type: string) => type === 'text/uri-list' ? 'file:///tmp/new.bin' : ''
                }
            });
            assert.strictEqual(singleUpdateCalls, 1);
            assert.strictEqual(status.textContent, 'Uploaded new.bin');
            assert.strictEqual(state.gridOversizedCells[0], undefined);
        } finally {
            backendApi.updateCellBatch = originalUpdateCellBatch;
            backendApi.updateCell = originalUpdateCell;
            backendApi.readWorkspaceFileUri = originalReadWorkspaceFileUri;
        }
    });

    it('keeps Tab advancement bound to the intended row when the edit changes sort order', async () => {
        const makeCell = (id: string) => ({
            id,
            innerHTML: '',
            textContent: '',
            classList: createClassList(),
            children: [] as any[],
            appendChild(child: any) { this.children.push(child); },
            querySelector() { return null; }
        });
        const makeCells = () => Object.fromEntries(
            [0, 1].flatMap(rowIdx => [0, 1].map(colIdx => {
                const id = `cell-${rowIdx}-${colIdx}`;
                return [id, makeCell(id)];
            }))
        );
        let cells: Record<string, any> = makeCells();
        const paintedCells: string[] = [];
        const controls: Record<string, any> = {
            pageIndicator: { textContent: '' },
            btnFirst: { disabled: false },
            btnPrev: { disabled: false },
            btnNext: { disabled: false },
            btnLast: { disabled: false },
            statusText: { textContent: '' },
            filterMatchCounter: { textContent: '' }
        };
        const createdTextareas: any[] = [];
        (globalThis as any).document = {
            getElementById(id: string) {
                const cell = cells[id];
                if (cell && !cell.paintTracked) {
                    const appendChild = cell.appendChild.bind(cell);
                    cell.appendChild = (child: any) => {
                        if (child.className === 'cell-text' && child.textContent === 'z') {
                            paintedCells.push(id);
                        }
                        appendChild(child);
                    };
                    cell.paintTracked = true;
                }
                return cell ?? controls[id] ?? null;
            },
            querySelectorAll() { return []; },
            querySelector() { return null; },
            createElement(tag: string) {
                const created: any = {
                    className: '',
                    textContent: '',
                    value: '',
                    classList: createClassList(),
                    style: {},
                    scrollWidth: 0,
                    clientWidth: 0,
                    addEventListener() {},
                    removeEventListener() {},
                    focus() { this.focused = true; }
                };
                if (tag === 'textarea') createdTextareas.push(created);
                return created;
            }
        };

        const apiModulePath = '../../core/ui/modules/api.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { onCellInputKeydown } = await import(editModulePath);
        const originalUpdateCell = backendApi.updateCell;
        const originalFetchCount = backendApi.fetchTableCount;
        const originalFetchData = backendApi.fetchTableData;
        const updateCalls: Array<{ rowId: number; column: string; value: unknown }> = [];
        const databaseRows: any[][] = [
            [1, 'a', 'first row note'],
            [2, 'b', 'second row note']
        ];
        const sortedRows = () => databaseRows
            .map(row => [...row])
            .sort((left, right) => String(left[1]).localeCompare(String(right[1])));

        backendApi.updateCell = async (
            _table: string,
            rowId: number,
            column: string,
            value: unknown
        ) => {
            updateCalls.push({ rowId, column, value });
            const row = databaseRows.find(candidate => candidate[0] === rowId);
            assert.ok(row);
            row[column === 'rank' ? 1 : 2] = value;
            // Mirror the external refresh landing while the inline textarea keeps
            // the pre-refresh DOM mounted.
            state.gridData = sortedRows();
        };
        backendApi.fetchTableCount = async () => databaseRows.length;
        backendApi.fetchTableData = async () => {
            // A completed refresh rebuilds row-indexed cell ids for the new order.
            cells = makeCells();
            return { rows: sortedRows() };
        };
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.renderedTable = 'items';
        state.tableColumns = [
            { name: 'rank', type: 'TEXT' },
            { name: 'note', type: 'TEXT' }
        ];
        state.gridData = sortedRows();
        state.sortedColumn = 'rank';
        state.sortAscending = true;
        state.currentPageIndex = 0;
        state.totalPageCount = 1;
        state.rowsPerPage = 500;
        state.columnFilters = {};
        state.filterQuery = '';
        state.editingCellInfo = {
            rowIdx: 0,
            colIdx: 0,
            rowId: 1,
            columnName: 'rank',
            originalValue: 'a'
        };
        state.activeCellInput = { value: 'z', removeEventListener() {} };

        try {
            await onCellInputKeydown({
                key: 'Tab',
                shiftKey: false,
                preventDefault() {}
            });

            assert.strictEqual(state.editingCellInfo?.rowId, 1);
            assert.strictEqual(state.editingCellInfo?.rowIdx, 1);
            assert.strictEqual(state.editingCellInfo?.colIdx, 1);
            assert.strictEqual(createdTextareas.at(-1)?.value, 'first row note');
            assert.deepStrictEqual(
                paintedCells,
                ['cell-1-0'],
                'the immediate paint must follow the edited row identity after reordering'
            );

            createdTextareas.at(-1).value = 'edited intended row';
            await onCellInputKeydown({
                key: 'Tab',
                shiftKey: false,
                preventDefault() {}
            });

            assert.deepStrictEqual(updateCalls.slice(0, 2), [
                { rowId: 1, column: 'rank', value: 'z' },
                { rowId: 1, column: 'note', value: 'edited intended row' }
            ]);
        } finally {
            backendApi.updateCell = originalUpdateCell;
            backendApi.fetchTableCount = originalFetchCount;
            backendApi.fetchTableData = originalFetchData;
            state.sortedColumn = null;
            state.sortAscending = true;
            state.renderedTable = null;
        }
    });

    it('advances inline edits in the rendered pinned row and column order', async () => {
        const makeCell = (id: string) => ({
            id,
            innerHTML: '',
            textContent: '',
            classList: createClassList(),
            children: [] as any[],
            appendChild(child: any) { this.children.push(child); },
            querySelector() { return null; }
        });
        const cells: Record<string, any> = {};
        for (let rowIdx = 0; rowIdx < 2; rowIdx++) {
            for (let colIdx = 0; colIdx < 3; colIdx++) {
                const id = `cell-${rowIdx}-${colIdx}`;
                cells[id] = makeCell(id);
            }
        }
        const createdTextareas: any[] = [];
        (globalThis as any).document = {
            getElementById(id: string) { return cells[id] ?? null; },
            querySelectorAll() { return []; },
            querySelector() { return null; },
            createElement(tag: string) {
                const created: any = {
                    className: '',
                    textContent: '',
                    value: '',
                    classList: createClassList(),
                    style: {},
                    scrollWidth: 0,
                    clientWidth: 0,
                    addEventListener() {},
                    removeEventListener() {},
                    focus() { this.focused = true; }
                };
                if (tag === 'textarea') createdTextareas.push(created);
                return created;
            }
        };
        const { state } = await import(stateModulePath);
        const { onCellInputKeydown } = await import(editModulePath);
        state.selectedTable = 'items';
        state.tableColumns = [
            { name: 'first', type: 'TEXT' },
            { name: 'second', type: 'TEXT' },
            { name: 'third', type: 'TEXT' }
        ];
        state.gridData = [
            [7, 'alpha', 'beta', 'gamma'],
            [8, 'delta', 'epsilon', 'zeta']
        ];
        state.pinnedColumns.add('third');
        state.pinnedRowIds.add(8);

        state.editingCellInfo = {
            rowIdx: 0,
            colIdx: 2,
            rowId: 7,
            columnName: 'third',
            originalValue: 'gamma'
        };
        state.activeCellInput = { value: 'gamma', removeEventListener() {} };
        await onCellInputKeydown({
            key: 'Tab',
            shiftKey: false,
            preventDefault() {}
        });

        assert.strictEqual(state.editingCellInfo?.rowIdx, 0);
        assert.strictEqual(state.editingCellInfo?.colIdx, 0);
        assert.strictEqual(createdTextareas.at(-1)?.value, 'alpha');

        await onCellInputKeydown({
            key: 'Tab',
            shiftKey: true,
            preventDefault() {}
        });
        assert.strictEqual(state.editingCellInfo?.rowIdx, 0);
        assert.strictEqual(state.editingCellInfo?.colIdx, 2);
        assert.strictEqual(createdTextareas.at(-1)?.value, 'gamma');

        // Row 0 is rendered after pinned row 1. Its final rendered column is
        // therefore followed by pinned row 1's first rendered column on wrap.
        state.editingCellInfo = {
            rowIdx: 0,
            colIdx: 1,
            rowId: 7,
            columnName: 'second',
            originalValue: 'beta'
        };
        state.activeCellInput = { value: 'beta', removeEventListener() {} };
        await onCellInputKeydown({
            key: 'Tab',
            shiftKey: false,
            preventDefault() {}
        });

        assert.strictEqual(state.editingCellInfo?.rowIdx, 1);
        assert.strictEqual(state.editingCellInfo?.colIdx, 2);
        assert.strictEqual(state.editingCellInfo?.rowId, 8);
        assert.strictEqual(createdTextareas.at(-1)?.value, 'zeta');
    });

    it('leaves copy and select-all shortcuts with an active textarea', async () => {
        let keydown: ((event: any) => Promise<void>) | undefined;
        (globalThis as any).document = {
            activeElement: { tagName: 'TEXTAREA' },
            addEventListener(type: string, listener: (event: any) => Promise<void>) {
                if (type === 'keydown') keydown = listener;
            },
            getElementById() { return null; },
            querySelector() { return null; },
            querySelectorAll() { return []; }
        };
        const shortcuts = await import(globalShortcutsModulePath).catch(() => null);
        assert.ok(shortcuts?.setupGlobalShortcuts, 'shared global shortcut handler is unavailable');
        shortcuts.setupGlobalShortcuts();
        assert.ok(keydown, 'global keydown listener was not registered');

        const { state } = await import(stateModulePath);
        state.selectedTable = 'items';
        state.gridData = [[7, 'alpha']];
        state.selectedCells = [{ rowIdx: 0, colIdx: 0, rowId: 7, value: 'alpha' }];
        let copyPrevented = false;
        await keydown({
            key: 'c',
            metaKey: true,
            ctrlKey: false,
            preventDefault() { copyPrevented = true; }
        });
        let selectAllPrevented = false;
        await keydown({
            key: 'a',
            metaKey: true,
            ctrlKey: false,
            preventDefault() { selectAllPrevented = true; },
            stopPropagation() {}
        });

        assert.strictEqual(copyPrevented, false);
        assert.strictEqual(selectAllPrevented, false);
        assert.deepStrictEqual([...state.selectedRowIds], []);
        assert.strictEqual(state.selectedCells.length, 1);
    });

    it('does not route copy, select-all, or destructive grid shortcuts behind a cell-preview modal', async () => {
        let keydown: ((event: any) => Promise<void>) | undefined;
        const clipboardWrites: string[] = [];
        const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: { clipboard: { writeText: async (text: string) => clipboardWrites.push(text) } }
        });
        (globalThis as any).document = {
            activeElement: { tagName: 'BUTTON' },
            addEventListener(type: string, listener: (event: any) => Promise<void>) {
                if (type === 'keydown') keydown = listener;
            },
            getElementById() { return null; },
            querySelector(selector: string) {
                return selector.includes('.cell-preview-modal:not(.hidden)') ? {} : null;
            },
            querySelectorAll() { return []; }
        };

        const apiModulePath = '../../core/ui/modules/api.js';
        const { backendApi } = await import(apiModulePath);
        const originalDeleteRows = backendApi.deleteRows;
        let deleteCalls = 0;
        backendApi.deleteRows = async () => {
            deleteCalls++;
            throw new Error('shortcut should have been blocked');
        };
        const originalConsoleError = console.error;
        console.error = () => {};

        try {
            const { setupGlobalShortcuts } = await import(globalShortcutsModulePath);
            const { state } = await import(stateModulePath);
            setupGlobalShortcuts();
            assert.ok(keydown, 'global keydown listener was not registered');

            state.selectedTable = 'items';
            state.selectedTableType = 'table';
            state.gridData = [[7, 'alpha']];
            state.tableColumns = [{ name: 'value', type: 'TEXT' }];
            state.selectedCells = [{ rowIdx: 0, colIdx: 0, rowId: 7, value: 'alpha' }];
            state.selectedRowIds.add(7);

            const events = ['c', 'a', 'Delete', 'Backspace'].map(key => ({
                key,
                metaKey: false,
                ctrlKey: true,
                target: { tagName: 'BUTTON' },
                prevented: false,
                preventDefault() { this.prevented = true; },
                stopPropagation() {}
            }));
            for (const event of events) {
                state.selectedCells = [{ rowIdx: 0, colIdx: 0, rowId: 7, value: 'alpha' }];
                state.selectedRowIds.clear();
                state.selectedRowIds.add(7);
                await keydown(event);
            }

            assert.deepStrictEqual(events.map(event => event.prevented), [false, false, false, false]);
            assert.deepStrictEqual(clipboardWrites, []);
            assert.strictEqual(deleteCalls, 0);
            assert.deepStrictEqual([...state.selectedRowIds], [7]);
            assert.strictEqual(state.selectedCells.length, 1);
        } finally {
            backendApi.deleteRows = originalDeleteRows;
            console.error = originalConsoleError;
            if (navigatorDescriptor) {
                Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
            } else {
                delete (globalThis as any).navigator;
            }
        }
    });

    it('handles uppercase copy and select-all shortcut keys with Caps Lock on', async () => {
        let keydown: ((event: any) => Promise<void>) | undefined;
        const clipboardWrites: string[] = [];
        const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: { clipboard: { writeText: async (text: string) => clipboardWrites.push(text) } }
        });
        (globalThis as any).document = {
            activeElement: { tagName: 'DIV' },
            addEventListener(type: string, listener: (event: any) => Promise<void>) {
                if (type === 'keydown') keydown = listener;
            },
            getElementById() { return null; },
            querySelector() { return null; },
            querySelectorAll() { return []; }
        };

        try {
            const { setupGlobalShortcuts } = await import(globalShortcutsModulePath);
            const { state } = await import(stateModulePath);
            setupGlobalShortcuts();
            assert.ok(keydown, 'global keydown listener was not registered');

            state.selectedTable = 'items';
            state.selectedTableType = 'table';
            state.gridData = [[7, 'alpha']];
            state.selectedCells = [{ rowIdx: 0, colIdx: 0, rowId: 7, value: 'alpha' }];
            let copyPrevented = false;
            await keydown({
                key: 'C',
                metaKey: false,
                ctrlKey: true,
                preventDefault() { copyPrevented = true; }
            });

            state.selectedCells = [];
            let selectAllPrevented = false;
            await keydown({
                key: 'A',
                metaKey: true,
                ctrlKey: false,
                preventDefault() { selectAllPrevented = true; },
                stopPropagation() {}
            });

            assert.strictEqual(copyPrevented, true);
            assert.deepStrictEqual(clipboardWrites, ['alpha']);
            assert.strictEqual(selectAllPrevented, true);
            assert.deepStrictEqual([...state.selectedRowIds], [7]);
        } finally {
            if (navigatorDescriptor) {
                Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
            } else {
                delete (globalThis as any).navigator;
            }
        }
    });

    it('clears selection on click-away but preserves selection-dependent controls', async () => {
        const containerListeners = new Map<string, (event: any) => any>();
        const documentListeners = new Map<string, (event: any) => any>();
        const container = {
            addEventListener(type: string, listener: (event: any) => any) {
                containerListeners.set(type, listener);
            }
        };
        (globalThis as any).document = {
            getElementById(id: string) { return id === 'gridContainer' ? container : null; },
            addEventListener(type: string, listener: (event: any) => any) {
                documentListeners.set(type, listener);
            },
            querySelectorAll() { return []; },
            querySelector() { return null; }
        };
        const { state } = await import(stateModulePath);
        const { initGridInteraction } = await import(gridEventsModulePath);
        initGridInteraction();
        const click = documentListeners.get('click');
        assert.ok(click, 'document click listener was not registered');

        state.selectedCells = [{ rowIdx: 0, colIdx: 0, rowId: 1, value: 'x' }];
        state.lastSelectedCell = { rowIdx: 0, colIdx: 0 };
        click({ target: { closest() { return null; } } });
        assert.deepStrictEqual(state.selectedCells, []);
        assert.strictEqual(state.lastSelectedCell, null);

        state.selectedCells = [{ rowIdx: 0, colIdx: 0, rowId: 1, value: 'x' }];
        state.lastSelectedCell = { rowIdx: 0, colIdx: 0 };
        click({
            target: {
                closest(selector: string) {
                    return selector.includes('[data-preserve-grid-selection]') ? {} : null;
                }
            }
        });
        assert.strictEqual(state.selectedCells.length, 1);
        assert.deepStrictEqual(state.lastSelectedCell, { rowIdx: 0, colIdx: 0 });
    });

    it('prevents native selection on Shift-mousedown in grid cells but not editors', async () => {
        const containerListeners = new Map<string, (event: any) => any>();
        const container = {
            addEventListener(type: string, listener: (event: any) => any) {
                containerListeners.set(type, listener);
            }
        };
        (globalThis as any).document = {
            getElementById(id: string) { return id === 'gridContainer' ? container : null; },
            addEventListener() {},
            querySelectorAll() { return []; },
            querySelector() { return null; }
        };
        const { initGridInteraction } = await import(gridEventsModulePath);
        initGridInteraction();
        const mousedown = containerListeners.get('mousedown');
        assert.ok(mousedown, 'grid mousedown listener was not registered');
        let prevented = 0;

        mousedown({
            shiftKey: true,
            target: {
                classList: createClassList(),
                closest(selector: string) {
                    if (selector.includes('.cell-input')) return null;
                    if (selector.includes('.data-cell')) return {};
                    return null;
                }
            },
            preventDefault() { prevented++; }
        });
        mousedown({
            shiftKey: true,
            target: {
                classList: createClassList(),
                closest(selector: string) {
                    if (selector.includes('.cell-input')) return {};
                    if (selector.includes('.data-cell')) return {};
                    return null;
                }
            },
            preventDefault() { prevented++; }
        });

        assert.strictEqual(prevented, 1);
    });
});
