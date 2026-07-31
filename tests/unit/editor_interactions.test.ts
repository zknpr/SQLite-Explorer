import './vscode_mock_setup';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';

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
        state.pinnedColumns.clear();
        state.pinnedRowIds.clear();
        state.selectedTable = null;
        state.selectedTableType = 'table';
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
            getElementById(id: string) { return cells[id] ?? controls[id] ?? null; },
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
