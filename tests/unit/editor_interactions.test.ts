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
