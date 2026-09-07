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
const backendApiModulePath = '../../core/ui/modules/api.js';
const gridActionsModulePath = '../../core/ui/modules/grid-actions.js';
const connectionStateModulePath = '../../core/ui/modules/connection-state.js';

interface CellReadSessionResult {
    sessionId: string;
    metadata: {
        storageClass: string;
        byteLength: number;
        textEncoding?: string;
    };
}

interface CellChunkResult {
    byteOffset: number;
    bytes: Uint8Array;
    done: boolean;
}

interface EditorBackendApi {
    updateCell: (...args: unknown[]) => Promise<unknown>;
    openCellReadSession: (target: unknown) => Promise<CellReadSessionResult>;
    readCellChunk: (
        sessionId: string,
        byteOffset: number,
        maxBytes: number
    ) => Promise<CellChunkResult>;
    closeCellReadSession: (sessionId: string) => Promise<unknown>;
}

interface BackendApiModule {
    backendApi: EditorBackendApi;
}

interface GridActionsModule {
    onCellDoubleClick(
        event: unknown,
        rowIdx: number,
        colIdx: number,
        rowId: number | string
    ): unknown;
}

async function loadEditorBackendApi(): Promise<EditorBackendApi> {
    const module = await import(backendApiModulePath) as BackendApiModule;
    return module.backendApi;
}

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
        // The count cache is module state shared across this process; clear it
        // so the next test's count mock always gets its first fetch.
        const countCacheModulePath = '../../core/ui/modules/count-cache.js';
        const { invalidateAllCounts } = await import(countCacheModulePath);
        invalidateAllCounts();
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
        state.selectedTableIdentity = null;
        state.isReadOnly = false;
        state.cellEditBehavior = 'inline';
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

    it('keeps the preview open and reports the host reason when external editing is unavailable', async () => {
        const apiModulePath = '../../core/ui/modules/api.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { openCellInVsCode } = await import(editModulePath);
        const originalOpenCellEditor = backendApi.openCellEditor;
        const status = { textContent: '' };
        const modal = { classList: createClassList() };
        backendApi.openCellEditor = async () => ({
            success: false,
            message: 'External editing is unavailable in this environment'
        });
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'cellPreviewModal') return modal;
                if (id === 'statusText') return status;
                return null;
            }
        };
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'body', type: 'TEXT' }];
        state.gridData = [[1, 'value']];
        state.cellPreviewInfo = {
            rowIdx: 0,
            colIdx: 0,
            rowId: 1,
            columnName: 'body',
            originalValue: 'value',
            originalText: 'value'
        };

        try {
            await openCellInVsCode();
            assert.strictEqual(status.textContent, 'External editing is unavailable in this environment');
            assert.strictEqual(modal.classList.contains('hidden'), false);
            assert.ok(state.cellPreviewInfo, 'a failed external open must not discard the modal draft');
        } finally {
            backendApi.openCellEditor = originalOpenCellEditor;
        }
    });

    it('does not let an older external-editor completion close a newer cell preview', async () => {
        const { backendApi } = await import(backendApiModulePath);
        const { state } = await import(stateModulePath);
        const { openCellInVsCode } = await import(editModulePath);
        const originalOpenCellEditor = backendApi.openCellEditor;
        const opened = createDeferred<any>();
        const status = { textContent: '' };
        const modal = { classList: createClassList() };
        const firstSession = {
            rowIdx: 0,
            colIdx: 0,
            rowId: 1,
            columnName: 'body',
            table: 'items',
            column: { name: 'body', type: 'TEXT' },
            originalValue: 'first',
            originalText: 'first'
        };
        const secondSession = {
            ...firstSession,
            rowId: 2,
            originalValue: 'second',
            originalText: 'second'
        };
        backendApi.openCellEditor = async () => opened.promise;
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'cellPreviewModal') return modal;
                if (id === 'statusText') return status;
                if (id === 'vscode-env') return { dataset: { webviewId: 'test' } };
                return null;
            }
        };
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'body', type: 'TEXT' }];
        state.gridData = [[1, 'first'], [2, 'second']];
        state.cellPreviewInfo = firstSession;

        try {
            const pendingOpen = openCellInVsCode();
            state.cellPreviewInfo = secondSession;
            status.textContent = 'Editing second cell';
            opened.resolve({ success: true });
            await pendingOpen;

            assert.strictEqual(state.cellPreviewInfo, secondSession);
            assert.strictEqual(modal.classList.contains('hidden'), false);
            assert.strictEqual(status.textContent, 'Editing second cell');
        } finally {
            backendApi.openCellEditor = originalOpenCellEditor;
        }
    });

    it('persists programmatic JSON formatting instead of treating the preview as unchanged', async () => {
        const { backendApi } = await import(backendApiModulePath);
        const { state } = await import(stateModulePath);
        const {
            compactCellPreviewJson,
            formatCellPreviewJson,
            saveCellPreview
        } = await import(editModulePath);
        const originalUpdateCell = backendApi.updateCell;
        const textarea = { value: '' };
        const modal = { classList: createClassList() };
        const charCount = { textContent: '' };
        const calls: unknown[][] = [];
        backendApi.updateCell = async (...args: unknown[]) => {
            calls.push(args);
        };
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'cellPreviewTextarea') return textarea;
                if (id === 'cellPreviewModal') return modal;
                if (id === 'cellPreviewCharCount') return charCount;
                if (id === 'statusText') return { textContent: '' };
                return null;
            },
            querySelectorAll() { return []; },
            querySelector() { return null; }
        };
        state.isReadOnly = false;
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'body', type: 'TEXT', notnull: 0 }];
        state.gridData = [[1, '{"a":1}']];

        try {
            textarea.value = '{"a":1}';
            state.cellPreviewInfo = {
                rowIdx: 0,
                colIdx: 0,
                rowId: 1,
                columnName: 'body',
                table: 'items',
                tableType: 'table',
                column: { name: 'body', type: 'TEXT', notnull: 0 },
                originalValue: '{"a":1}',
                originalText: '{"a":1}',
                valueMode: 'value',
                dirty: false
            };
            formatCellPreviewJson();
            assert.strictEqual(state.cellPreviewInfo.dirty, true);
            await saveCellPreview();

            textarea.value = '{\n  "b": 2\n}';
            state.gridData = [[2, '{\n  "b": 2\n}']];
            state.cellPreviewInfo = {
                rowIdx: 0,
                colIdx: 0,
                rowId: 2,
                columnName: 'body',
                table: 'items',
                tableType: 'table',
                column: { name: 'body', type: 'TEXT', notnull: 0 },
                originalValue: '{\n  "b": 2\n}',
                originalText: '{\n  "b": 2\n}',
                valueMode: 'value',
                dirty: false
            };
            compactCellPreviewJson();
            assert.strictEqual(state.cellPreviewInfo.dirty, true);
            await saveCellPreview();

            assert.deepStrictEqual(calls, [
                ['items', 1, 'body', '{\n  "a": 1\n}', '{"a":1}'],
                ['items', 2, 'body', '{"b":2}', '{\n  "b": 2\n}']
            ]);
        } finally {
            backendApi.updateCell = originalUpdateCell;
        }
    });

    it('does not resurrect the VS Code editor action in the standalone web viewer', async () => {
        const { state } = await import(stateModulePath);
        const { openCellPreview } = await import(editModulePath);
        const element = () => ({
            value: '',
            textContent: '',
            title: '',
            readOnly: false,
            style: {} as Record<string, string>,
            classList: createClassList(),
            focus() {},
            addEventListener() {},
            removeEventListener() {}
        });
        const elements: Record<string, any> = {
            cellPreviewModal: element(),
            cellPreviewColumnName: element(),
            cellPreviewTypeBadge: element(),
            cellPreviewTextarea: element(),
            cellPreviewReadonlyBadge: element(),
            cellPreviewSaveBtn: element(),
            openInVsCodeBtn: element(),
            wrapTextBtn: element(),
            cellPreviewCharCount: element()
        };
        elements.openInVsCodeBtn.style.display = 'none';
        (globalThis as any).document = {
            getElementById(id: string) {
                return elements[id] ?? null;
            }
        };
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'body', type: 'TEXT' }];
        state.gridData = [[1, 'value']];

        openCellPreview(0, 0, 1);

        assert.strictEqual(elements.openInVsCodeBtn.style.display, 'none');
        assert.strictEqual(elements.cellPreviewModal.classList.contains('hidden'), false);
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

    it('saves a modal draft to its snapshotted table and column semantics after a table switch', async () => {
        const backendApi = await loadEditorBackendApi();
        const { state } = await import(stateModulePath);
        const { saveCellPreview } = await import(editModulePath);
        const originalUpdateCell = backendApi.updateCell;
        const calls: unknown[][] = [];
        const modal = { classList: createClassList() };
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'cellPreviewTextarea') return { value: '00123' };
                if (id === 'cellPreviewModal') return modal;
                if (id === 'statusText') return { textContent: '' };
                return null;
            },
            querySelectorAll() { return []; },
            querySelector() { return null; }
        };
        backendApi.updateCell = async (...args: unknown[]) => {
            calls.push(args);
        };
        state.isReadOnly = false;
        state.selectedTable = 'table_b';
        state.selectedTableType = 'table';
        state.selectedTableIdentity = { kind: 'rowid' } as any;
        state.tableColumns = [{ name: 'body', type: 'INTEGER', notnull: 0 }];
        state.gridData = [[1, 999]];
        state.cellPreviewInfo = {
            rowIdx: 0,
            colIdx: 0,
            rowId: 1,
            columnName: 'body',
            table: 'table_a',
            tableType: 'table',
            column: { name: 'body', type: 'TEXT', notnull: 0 },
            identityKind: 'rowid',
            documentReadOnly: false,
            valueMode: 'value',
            originalValue: 'value from A',
            originalText: 'value from A'
        };

        try {
            await saveCellPreview();
            assert.deepStrictEqual(calls, [[
                'table_a', 1, 'body', '00123', 'value from A'
            ]]);
            assert.deepStrictEqual(state.gridData, [[1, 999]]);
        } finally {
            backendApi.updateCell = originalUpdateCell;
        }
    });

    it('treats clearing nullable inline and modal TEXT as an empty string, not SQL NULL', async () => {
        const backendApi = await loadEditorBackendApi();
        const { state } = await import(stateModulePath);
        const { saveCellEdit, saveCellPreview } = await import(editModulePath);
        const originalUpdateCell = backendApi.updateCell;
        const calls: unknown[][] = [];
        const modal = { classList: createClassList() };
        const cell = {
            classList: createClassList(['editing']),
            textContent: '',
            children: [] as any[],
            appendChild(child: any) { this.children.push(child); }
        };
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'cellPreviewTextarea') return { value: '' };
                if (id === 'cellPreviewModal') return modal;
                if (id === 'cell-0-0') return cell;
                if (id === 'statusText') return { textContent: '' };
                return null;
            },
            querySelectorAll() { return []; },
            querySelector() { return null; },
            createElement() {
                return { className: '', textContent: '', title: '', scrollWidth: 0, clientWidth: 0 };
            }
        };
        backendApi.updateCell = async (...args: unknown[]) => {
            calls.push(args);
        };
        const column = { name: 'body', type: 'TEXT', notnull: 0 };
        state.isReadOnly = false;
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [column];
        state.gridData = [[1, 'before']];
        state.editingCellInfo = {
            rowIdx: 0, colIdx: 0, rowId: 1, columnName: 'body', table: 'items',
            tableType: 'table', column, identityKind: 'rowid',
            originalValue: 'before', originalText: 'before'
        };
        state.activeCellInput = { value: '', removeEventListener() {} };

        try {
            assert.strictEqual(await saveCellEdit(), true);
            state.gridData = [[1, 'before']];
            state.cellPreviewInfo = {
                rowIdx: 0, colIdx: 0, rowId: 1, columnName: 'body', table: 'items',
                tableType: 'table', column, identityKind: 'rowid', documentReadOnly: false,
                valueMode: 'value', originalValue: 'before', originalText: 'before'
            };
            await saveCellPreview();

            assert.deepStrictEqual(calls, [
                ['items', 1, 'body', '', 'before'],
                ['items', 1, 'body', '', 'before']
            ]);
        } finally {
            backendApi.updateCell = originalUpdateCell;
        }
    });

    it('keeps SQL NULL and empty string as explicit, distinct modal actions', async () => {
        const backendApi = await loadEditorBackendApi();
        const { state } = await import(stateModulePath);
        const { saveCellPreview, setCellPreviewEmpty, setCellPreviewNull } =
            await import(editModulePath);
        const originalUpdateCell = backendApi.updateCell;
        const calls: unknown[][] = [];
        const textarea = { value: '', focus() {} };
        const modal = { classList: createClassList() };
        const emptyButton = { classList: createClassList() };
        const nullButton = { classList: createClassList() };
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'cellPreviewTextarea') return textarea;
                if (id === 'cellPreviewModal') return modal;
                if (id === 'cellPreviewEmptyBtn') return emptyButton;
                if (id === 'cellPreviewNullBtn') return nullButton;
                if (id === 'cellPreviewCharCount') return { textContent: '' };
                if (id === 'statusText') return { textContent: '' };
                return null;
            },
            querySelectorAll() { return []; },
            querySelector() { return null; }
        };
        backendApi.updateCell = async (...args: unknown[]) => {
            calls.push(args);
        };
        const column = { name: 'body', type: 'TEXT', notnull: 0 };
        state.isReadOnly = false;
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [column];
        state.gridData = [[1, null]];
        const session = (originalValue: unknown) => ({
            rowIdx: 0, colIdx: 0, rowId: 1, columnName: 'body', table: 'items',
            tableType: 'table', column, identityKind: 'rowid', documentReadOnly: false,
            valueMode: 'value', dirty: false, originalValue,
            originalText: originalValue === null ? '' : String(originalValue)
        });

        try {
            state.cellPreviewInfo = session(null);
            setCellPreviewEmpty();
            await saveCellPreview();

            state.gridData = [[1, 'before']];
            state.cellPreviewInfo = session('before');
            textarea.value = 'before';
            setCellPreviewNull();
            await saveCellPreview();

            assert.deepStrictEqual(calls, [
                ['items', 1, 'body', '', null],
                ['items', 1, 'body', null, 'before']
            ]);
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

    it('aborts a BLOB drop when Reload replaces the same table and rowid', async () => {
        const listeners = new Map<string, (event: any) => Promise<void>>();
        const source = createDeferred<Uint8Array>();
        const cell = {
            dataset: { rowidx: '0', colidx: '0' },
            classList: createClassList(),
            closest(selector: string) {
                return selector === '.data-cell' ? this : null;
            }
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
            addEventListener() {}
        };

        const { backendApi } = await import(backendApiModulePath);
        const { state } = await import(stateModulePath);
        const { applyConnectionResult } = await import(connectionStateModulePath);
        const { initDragAndDrop } = await import(dndModulePath);
        const originalReadWorkspaceFileUri = (backendApi as any).readWorkspaceFileUri;
        const originalUpdateCell = backendApi.updateCell;
        const updateCalls: unknown[][] = [];
        (backendApi as any).readWorkspaceFileUri = async () => source.promise;
        backendApi.updateCell = async (...args: unknown[]) => {
            updateCalls.push(args);
        };
        state.connectionGeneration = 11;
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'payload', type: 'BLOB' }];
        state.gridData = [[1, new Uint8Array([1])]];
        initDragAndDrop();

        try {
            const pendingDrop = listeners.get('drop')!({
                preventDefault() {},
                target: cell,
                dataTransfer: {
                    files: [],
                    getData: (type: string) => (
                        type === 'text/uri-list' ? 'file:///tmp/payload.bin' : ''
                    )
                }
            });

            // The reopened database deliberately has the same visible target.
            applyConnectionResult({
                connected: true,
                readOnly: false,
                connectionGeneration: 12
            });
            state.selectedTable = 'items';
            state.selectedTableType = 'table';
            state.tableColumns = [{ name: 'payload', type: 'BLOB' }];
            state.gridData = [[1, new Uint8Array([2])]];
            source.resolve(new Uint8Array([9]));
            await pendingDrop;

            assert.deepStrictEqual(updateCalls, []);
            assert.deepStrictEqual(state.gridData, [[1, new Uint8Array([2])]]);
            assert.strictEqual(status.textContent, 'Upload cancelled because the database was reloaded');
        } finally {
            (backendApi as any).readWorkspaceFileUri = originalReadWorkspaceFileUri;
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
            table: 'items',
            tableType: 'table',
            column: state.tableColumns[0],
            identityKind: null,
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
            table: 'items',
            tableType: 'table',
            column: state.tableColumns[0],
            identityKind: null,
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
            table: 'source_items',
            tableType: 'table',
            column: state.tableColumns[0],
            identityKind: null,
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

    it('labels the inline editor with the column being edited', async () => {
        const container = {
            scrollLeft: 0,
            scrollTop: 0,
            getBoundingClientRect: () => ({
                left: 0, top: 0, right: 500, bottom: 300, width: 500, height: 300
            }),
            querySelector() { return null; },
            querySelectorAll() { return []; }
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
                    ariaLabel: '',
                    addEventListener() {},
                    removeEventListener() {},
                    focus() {}
                };
            }
        };
        const { state } = await import(stateModulePath);
        const { startCellEdit } = await import(editModulePath);
        state.selectedTable = 'orders';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'customer note', type: 'TEXT', notnull: 0, isPrimaryKey: false }];
        state.gridData = [[3, 'plain text']];

        startCellEdit(0, 0, 3);

        assert.strictEqual(cell.children[0]?.ariaLabel, 'Edit customer note');
    });

    it('snapshots the full save target into the edit session at edit start', async () => {
        const container = {
            scrollLeft: 0,
            scrollTop: 0,
            getBoundingClientRect: () => ({
                left: 0, top: 0, right: 500, bottom: 300, width: 500, height: 300
            }),
            querySelector() { return null; },
            querySelectorAll() { return []; }
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
                    focus() {}
                };
            }
        };
        const { state } = await import(stateModulePath);
        const { startCellEdit } = await import(editModulePath);
        state.selectedTable = 'orders';
        state.selectedTableType = 'table';
        state.selectedTableIdentity = { kind: 'primaryKey', columns: ['id'] };
        state.tableColumns = [{ name: 'amount', type: 'INTEGER', notnull: 1, isPrimaryKey: false }];
        state.gridData = [[3, 100]];

        startCellEdit(0, 0, 3);

        const session = state.editingCellInfo;
        assert.ok(session, 'edit session was not created');
        assert.strictEqual(session.table, 'orders');
        assert.strictEqual(session.tableType, 'table');
        assert.strictEqual(session.rowId, 3);
        assert.strictEqual(session.columnName, 'amount');
        assert.strictEqual(
            session.column,
            state.tableColumns[0],
            'the session must carry the column the edit was opened on'
        );
        assert.strictEqual(session.identityKind, 'primaryKey');
        assert.strictEqual(session.originalValue, 100);
    });

    it('commits a blur-deferred save to the snapshot table after a table switch', async () => {
        const apiModulePath = '../../core/ui/modules/api.js';
        const countCacheModulePath = '../../core/ui/modules/count-cache.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { onCellInputBlur } = await import(editModulePath);
        const { buildCountIdentity, prepareCountStore, getCachedCount } =
            await import(countCacheModulePath);
        const originalUpdateCell = backendApi.updateCell;
        const originalFetchData = backendApi.fetchTableData;
        const updateCalls: unknown[][] = [];
        let dataFetches = 0;
        const status = { textContent: '' };
        const paintedValues: string[] = [];
        const cell = {
            textContent: '',
            children: [] as any[],
            classList: createClassList(),
            appendChild(child: any) {
                this.children.push(child);
                if (child.className === 'cell-text') paintedValues.push(child.textContent);
            }
        };
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'cell-0-0') return cell;
                if (id === 'statusText') return status;
                return null;
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
        backendApi.updateCell = async (...args: unknown[]) => {
            updateCalls.push(args);
        };
        backendApi.fetchTableData = async () => {
            dataFetches++;
            return { rows: [] };
        };

        // Cached counts on both sides: the save must drop the snapshot table's
        // filtered identity and leave the displayed table's cache untouched.
        const ordersFiltered = buildCountIdentity(
            'orders', [{ column: 'amount', value: '10' }], undefined, ['amount']
        );
        const ordersUnfiltered = buildCountIdentity('orders', [], undefined, ['amount']);
        const customersFiltered = buildCountIdentity(
            'customers', [{ column: 'amount', value: '10' }], undefined, ['amount']
        );
        prepareCountStore(ordersFiltered)(11);
        prepareCountStore(ordersUnfiltered)(20);
        prepareCountStore(customersFiltered)(7);

        state.isReadOnly = false;
        state.selectedTable = 'orders';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'amount', type: 'INTEGER', notnull: 0 }];
        state.gridData = [[3, 100]];
        state.editingCellInfo = {
            rowIdx: 0,
            colIdx: 0,
            rowId: 3,
            columnName: 'amount',
            table: 'orders',
            tableType: 'table',
            column: state.tableColumns[0],
            identityKind: null,
            originalValue: 100,
            originalText: '100'
        };
        const input = { value: '250', isConnected: true, removeEventListener() {} };
        state.activeCellInput = input;

        try {
            // Clicking another sidebar table blurs the textarea (deferring its
            // commit ~100ms) and lands the switch synchronously first. The new
            // table exposes the same column name and rowid — the wrong-table
            // trap the snapshot must sidestep.
            onCellInputBlur();
            state.selectedTable = 'customers';
            state.selectedTableIdentity = null;
            state.tableColumns = [{ name: 'amount', type: 'INTEGER', notnull: 0 }];
            state.gridData = [[3, 555]];
            input.isConnected = false; // the switch re-rendered the grid; editor DOM is gone

            await new Promise(resolve => setTimeout(resolve, 200));
            await new Promise(resolve => setImmediate(resolve));

            assert.deepStrictEqual(updateCalls, [['orders', 3, 'amount', 250, 100]]);
            assert.strictEqual(state.editingCellInfo, null, 'the committed session must be cleaned up');
            assert.strictEqual(state.activeCellInput, null);
            assert.deepStrictEqual(
                state.gridData,
                [[3, 555]],
                'the displayed table must not absorb the write'
            );
            assert.deepStrictEqual(paintedValues, [], 'no cell of the displayed table may be repainted');
            assert.strictEqual(dataFetches, 0, 'the save must not reload any grid');
            assert.strictEqual(status.textContent, 'Saved to orders.amount');
            assert.strictEqual(
                getCachedCount(ordersFiltered),
                undefined,
                'the snapshot table\'s filtered count must be dropped'
            );
            assert.deepStrictEqual(
                getCachedCount(ordersUnfiltered),
                { count: 20, isExact: true },
                'the snapshot table\'s unfiltered count survives a cell edit'
            );
            assert.deepStrictEqual(
                getCachedCount(customersFiltered),
                { count: 7, isExact: true },
                'the displayed table\'s counts must be untouched'
            );
        } finally {
            backendApi.updateCell = originalUpdateCell;
            backendApi.fetchTableData = originalFetchData;
        }
    });

    it('clears a dead-editor session and names the snapshot target when its save fails', async () => {
        const apiModulePath = '../../core/ui/modules/api.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { saveCellEdit } = await import(editModulePath);
        const originalUpdateCell = backendApi.updateCell;
        const originalConsoleError = console.error;
        console.error = () => {};
        const status = { textContent: '' };
        (globalThis as any).document = {
            getElementById(id: string) { return id === 'statusText' ? status : null; },
            querySelectorAll() { return []; },
            querySelector() { return null; }
        };
        backendApi.updateCell = async () => {
            throw new Error('CHECK constraint failed: amount');
        };
        state.selectedTable = 'customers';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'amount', type: 'INTEGER', notnull: 0 }];
        state.gridData = [[3, 555]];
        state.editingCellInfo = {
            rowIdx: 0,
            colIdx: 0,
            rowId: 3,
            columnName: 'amount',
            table: 'orders',
            tableType: 'table',
            column: { name: 'amount', type: 'INTEGER', notnull: 0 },
            identityKind: null,
            originalValue: 100,
            originalText: '100'
        };
        state.activeCellInput = { value: '250', isConnected: false, removeEventListener() {} };

        try {
            assert.strictEqual(await saveCellEdit(), false);

            assert.strictEqual(
                state.editingCellInfo,
                null,
                'a failed save with a dead editor must not leak the session'
            );
            assert.strictEqual(state.activeCellInput, null);
            assert.strictEqual(
                status.textContent,
                'Save failed for orders.amount: CHECK constraint failed: amount'
            );
            assert.deepStrictEqual(state.gridData, [[3, 555]]);
        } finally {
            backendApi.updateCell = originalUpdateCell;
            console.error = originalConsoleError;
        }
    });

    it('retains the session and live editor when a same-table save fails', async () => {
        const apiModulePath = '../../core/ui/modules/api.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { saveCellEdit } = await import(editModulePath);
        const originalUpdateCell = backendApi.updateCell;
        const originalConsoleError = console.error;
        console.error = () => {};
        const status = { textContent: '' };
        (globalThis as any).document = {
            getElementById(id: string) { return id === 'statusText' ? status : null; },
            querySelectorAll() { return []; },
            querySelector() { return null; }
        };
        backendApi.updateCell = async () => {
            throw new Error('NOT NULL constraint failed: items.value');
        };
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'value', type: 'TEXT', notnull: 1 }];
        state.gridData = [[7, 'old']];
        const session = {
            rowIdx: 0,
            colIdx: 0,
            rowId: 7,
            columnName: 'value',
            table: 'items',
            tableType: 'table',
            column: state.tableColumns[0],
            identityKind: null,
            originalValue: 'old',
            originalText: 'old'
        };
        state.editingCellInfo = session;
        // No isConnected property: like editorHoldsWindow, non-DOM editors
        // count as live unless explicitly disconnected.
        const input = { value: 'new', removeEventListener() {} };
        state.activeCellInput = input;

        try {
            assert.strictEqual(await saveCellEdit(), false);

            assert.strictEqual(state.editingCellInfo, session, 'the session must be retained for correction');
            assert.strictEqual(state.activeCellInput, input, 'the editor must be kept');
            assert.strictEqual(status.textContent, 'Save failed: NOT NULL constraint failed: items.value');
            assert.deepStrictEqual(state.gridData, [[7, 'old']]);
        } finally {
            backendApi.updateCell = originalUpdateCell;
            console.error = originalConsoleError;
        }
    });

    it('commits an inline edit to the snapshot target on Enter', async () => {
        const apiModulePath = '../../core/ui/modules/api.js';
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { onCellInputKeydown } = await import(editModulePath);
        const originalUpdateCell = backendApi.updateCell;
        const updateCalls: unknown[][] = [];
        const status = { textContent: '' };
        const cell = {
            textContent: '',
            children: [] as any[],
            classList: createClassList(['editing']),
            appendChild(child: any) { this.children.push(child); }
        };
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'cell-0-0') return cell;
                if (id === 'statusText') return status;
                return null;
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
        backendApi.updateCell = async (...args: unknown[]) => {
            updateCalls.push(args);
        };
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'value', type: 'TEXT', notnull: 0 }];
        state.gridData = [[7, 'old']];
        state.editingCellInfo = {
            rowIdx: 0,
            colIdx: 0,
            rowId: 7,
            columnName: 'value',
            table: 'items',
            tableType: 'table',
            column: state.tableColumns[0],
            identityKind: null,
            originalValue: 'old',
            originalText: 'old'
        };
        state.activeCellInput = { value: 'new text', removeEventListener() {} };
        let prevented = false;

        try {
            await onCellInputKeydown({
                key: 'Enter',
                shiftKey: false,
                preventDefault() { prevented = true; }
            });
            await new Promise(resolve => setImmediate(resolve));

            assert.strictEqual(prevented, true);
            assert.deepStrictEqual(updateCalls, [['items', 7, 'value', 'new text', 'old']]);
            assert.strictEqual(state.editingCellInfo, null);
            assert.strictEqual(state.activeCellInput, null);
            assert.deepStrictEqual(state.gridData, [[7, 'new text']]);
            assert.strictEqual(status.textContent, 'Saved');
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

    it('refuses inline editing when the grid lacks the full byte-exact value', async () => {
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
            'Inline editing unavailable because the grid does not contain the full byte-exact value. ' +
            'Use View Full Content and the Hex view (TEXT, 268,435,456 bytes).'
        );
    });

    it('opens a bounded preview on default double-click instead of treating it as an edit', async () => {
        const modal = {
            classList: createClassList(['hidden']),
            querySelectorAll() { return []; }
        };
        const preview = {
            innerHTML: '',
            style: {},
            children: [] as any[],
            appendChild(child: any) { this.children.push(child); }
        };
        const hex = { value: '' };
        const info = { textContent: '' };
        const genericElement = () => ({
            addEventListener() {},
            classList: createClassList(),
            style: {},
            textContent: '',
            querySelectorAll() { return []; }
        });
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'blob-inspector-modal') return modal;
                if (id === 'tab-preview') return preview;
                if (id === 'blob-info') return info;
                return genericElement();
            },
            querySelector(selector: string) {
                return selector === '.hex-dump' ? hex : null;
            },
            createElement() {
                return {
                    style: {},
                    className: '',
                    textContent: '',
                    appendChild() {},
                    addEventListener() {}
                };
            }
        };
        const { state } = await import(stateModulePath);
        const backendApi = await loadEditorBackendApi();
        const { initEdit } = await import(editModulePath);
        const { onCellDoubleClick } = await import(gridActionsModulePath) as GridActionsModule;
        const originalReadApi = {
            openCellReadSession: backendApi.openCellReadSession,
            readCellChunk: backendApi.readCellChunk,
            closeCellReadSession: backendApi.closeCellReadSession
        };
        const fullValue = new TextEncoder().encode('x'.repeat(2_000));
        backendApi.openCellReadSession = async () => ({
            sessionId: 'bounded-preview',
            metadata: { storageClass: 'text', byteLength: fullValue.byteLength, textEncoding: 'utf-8' }
        });
        backendApi.readCellChunk = async (_sessionId: string, offset: number, maxBytes: number) => ({
            byteOffset: offset,
            bytes: fullValue.slice(offset, offset + maxBytes),
            done: offset + maxBytes >= fullValue.byteLength
        });
        backendApi.closeCellReadSession = async () => {};
        initEdit();
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.cellEditBehavior = 'inline';
        state.tableColumns = [{ name: 'value', type: 'TEXT' }];
        state.gridData = [[1, 'bounded preview']];
        state.gridOversizedCells = {
            0: { 1: { storageClass: 'text', byteLength: 2_000 } }
        };

        try {
            await onCellDoubleClick({}, 0, 0, 1);

            assert.strictEqual(state.editingCellInfo, null);
            assert.strictEqual(modal.classList.contains('hidden'), false);
            assert.match(info.textContent, /Full value 1.95 KB/);
        } finally {
            Object.assign(backendApi, originalReadApi);
        }
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
            assert.strictEqual(
                status.textContent,
                'Inline editing unavailable because the grid does not contain the full byte-exact value. ' +
                'Use View Full Content and the Hex view (BLOB, 4,096 bytes).'
            );

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

    it('coalesces duplicate Smart Delete clears and does not mutate a newly selected table', async () => {
        const { backendApi } = await import(backendApiModulePath);
        const { state } = await import(stateModulePath);
        const { clearSelectedCellValues } = await import(clipboardModulePath);
        const originalUpdateCellBatch = backendApi.updateCellBatch;
        const update = createDeferred<any[]>();
        const status = { textContent: '' };
        let calls = 0;
        backendApi.updateCellBatch = async () => {
            calls += 1;
            return update.promise;
        };
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'statusText') return status;
                return null;
            },
            querySelectorAll() { return []; },
            querySelector() { return null; }
        };
        state.isReadOnly = false;
        state.selectedTable = 'table_a';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'value', type: 'TEXT', notnull: 0 }];
        state.gridData = [[1, 'one'], [2, 'two'], [3, 'three']];
        state.selectedCells = [{ rowIdx: 2, colIdx: 0, rowId: 3, value: 'three' }];

        try {
            const first = clearSelectedCellValues();
            const duplicate = clearSelectedCellValues();
            assert.strictEqual(calls, 1);

            state.selectedTable = 'table_b';
            state.tableColumns = [{ name: 'other', type: 'TEXT', notnull: 0 }];
            state.gridData = [[99, 'table-b-value']];
            state.selectedCells = [{ rowIdx: 0, colIdx: 0, rowId: 99, value: 'table-b-value' }];
            state.selectedColumns = new Set(['other']);
            state.lastSelectedCell = { rowIdx: 0, colIdx: 0 };
            status.textContent = 'Table B ready';

            update.resolve([{ rowId: 3, columnName: 'value' }]);
            await Promise.all([first, duplicate]);

            assert.strictEqual(calls, 1);
            assert.deepStrictEqual(state.gridData, [[99, 'table-b-value']]);
            assert.deepStrictEqual(state.selectedCells, [
                { rowIdx: 0, colIdx: 0, rowId: 99, value: 'table-b-value' }
            ]);
            assert.deepStrictEqual([...state.selectedColumns], ['other']);
            assert.deepStrictEqual(state.lastSelectedCell, { rowIdx: 0, colIdx: 0 });
            assert.strictEqual(status.textContent, 'Table B ready');
        } finally {
            backendApi.updateCellBatch = originalUpdateCellBatch;
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
            table: 'items',
            tableType: 'table',
            column: state.tableColumns[0],
            identityKind: null,
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
            table: 'items',
            tableType: 'table',
            column: state.tableColumns[2],
            identityKind: null,
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
            table: 'items',
            tableType: 'table',
            column: state.tableColumns[1],
            identityKind: null,
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

    it('selects a focused grid cell with Space and moves its roving focus with ArrowRight', async () => {
        const containerListeners = new Map<string, (event: any) => any>();
        const row = { dataset: { rowid: '7' } };
        const cells = [0, 1].map(colIdx => {
            const cell: any = {
                id: `cell-0-${colIdx}`,
                tagName: 'TD',
                tabIndex: colIdx === 0 ? 0 : -1,
                dataset: { rowidx: '0', colidx: String(colIdx), gridTabstop: colIdx === 0 ? 'true' : 'false' },
                classList: createClassList(['data-cell']),
                focused: false,
                closest(selector: string) {
                    if (selector === '.data-cell') return cell;
                    if (selector === '.data-row') return row;
                    if (selector.includes('input')) return null;
                    return null;
                },
                focus() { cell.focused = true; }
            };
            return cell;
        });
        const container = {
            addEventListener(type: string, listener: (event: any) => any) {
                containerListeners.set(type, listener);
            },
            querySelector(selector: string) {
                return selector === '.data-cell[data-grid-tabstop="true"]' ? cells[0] : null;
            }
        };
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'gridContainer') return container;
                return cells.find(cell => cell.id === id) ?? null;
            },
            addEventListener() {},
            querySelectorAll() { return []; },
            querySelector() { return null; }
        };
        const { state } = await import(stateModulePath);
        const { initGridInteraction } = await import(gridEventsModulePath);
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [
            { name: 'first', type: 'TEXT' },
            { name: 'second', type: 'TEXT' }
        ];
        state.gridData = [[7, 'a', 'b']];
        initGridInteraction();
        const keydown = containerListeners.get('keydown');
        assert.ok(keydown);
        let prevented = 0;

        keydown({
            key: ' ',
            target: cells[0],
            shiftKey: false,
            ctrlKey: false,
            metaKey: false,
            altKey: false,
            preventDefault() { prevented++; },
            stopPropagation() {}
        });
        keydown({
            key: 'ArrowRight',
            target: cells[0],
            shiftKey: false,
            ctrlKey: false,
            metaKey: false,
            altKey: false,
            preventDefault() { prevented++; },
            stopPropagation() {}
        });

        assert.deepStrictEqual(state.selectedCells, [
            { rowIdx: 0, colIdx: 0, rowId: 7, value: 'a' }
        ]);
        assert.strictEqual(cells[0].tabIndex, -1);
        assert.strictEqual(cells[1].tabIndex, 0);
        assert.strictEqual(cells[1].focused, true);
        assert.strictEqual(prevented, 2);

        state.isGridReloading = true;
        state.selectedCells = [];
        keydown({
            key: ' ',
            target: cells[1],
            shiftKey: false,
            ctrlKey: false,
            metaKey: false,
            altKey: false,
            preventDefault() {},
            stopPropagation() {}
        });
        assert.deepStrictEqual(state.selectedCells, [], 'stale cells must stay inert during reload');
    });

    it('resizes a column from its keyboard-focusable separator', async () => {
        const containerListeners = new Map<string, (event: any) => any>();
        const header = { dataset: { column: 'body' } };
        const handle: any = {
            classList: createClassList(['resize-handle']),
            attributes: {} as Record<string, string>,
            closest(selector: string) {
                return selector === '.header-cell' ? header : null;
            },
            setAttribute(name: string, value: string) {
                this.attributes[name] = value;
            }
        };
        const headerCell = { style: {} as Record<string, string> };
        const dataCell = { style: {} as Record<string, string> };
        const container = {
            addEventListener(type: string, listener: (event: any) => any) {
                containerListeners.set(type, listener);
            }
        };
        (globalThis as any).document = {
            body: { style: {} },
            getElementById(id: string) { return id === 'gridContainer' ? container : null; },
            addEventListener() {},
            querySelector(selector: string) {
                if (selector === 'th[data-column="body"]') return headerCell;
                return null;
            },
            querySelectorAll(selector: string) {
                if (selector === 'th[data-column]') return [{ ...headerCell, dataset: { column: 'body' } }];
                return selector === '.data-row td.data-cell[data-colidx="0"]' ? [dataCell] : [];
            }
        };
        const { state } = await import(stateModulePath);
        const { initGridInteraction } = await import(gridEventsModulePath);
        state.tableColumns = [{ name: 'body', type: 'TEXT' }];
        state.columnWidths = { body: 120 };
        initGridInteraction();
        const keydown = containerListeners.get('keydown');
        assert.ok(keydown);
        let prevented = 0;

        keydown({
            key: 'ArrowRight',
            shiftKey: false,
            target: handle,
            preventDefault() { prevented++; },
            stopPropagation() {}
        });

        assert.strictEqual(state.columnWidths.body, 130);
        assert.strictEqual(headerCell.style.width, '130px');
        assert.strictEqual(dataCell.style.width, '130px');
        assert.strictEqual(handle.attributes['aria-valuenow'], '130');
        assert.strictEqual(prevented, 1);
    });

});
