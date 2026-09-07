import './vscode_mock_setup';

import assert from 'node:assert';
import { afterEach, it } from 'node:test';
import { prepareBatchUpdates } from '../../core/ui/modules/batch-update-logic.js';

interface PersistedSidebarState {
    sidebarFilter?: string;
}

interface SidebarState {
    selectedTable: string | null;
    sidebarFilter: string;
}

interface StateModule {
    state: SidebarState;
}

interface SidebarModule {
    initSidebar(): void;
    updateBatchSidebar(): void;
}

const stateModulePath = '../../core/ui/modules/state.js';
const sidebarModulePath = '../../core/ui/modules/sidebar.js';

let persistedState: PersistedSidebarState | undefined;
(globalThis as any).acquireVsCodeApi = () => ({
    getState: () => undefined,
    setState(value: PersistedSidebarState) { persistedState = value; },
    postMessage() {}
});

function getPersistedState(): PersistedSidebarState | undefined {
    return persistedState;
}

it('persists sidebar filtering even before a table is selected', async () => {
    const listeners = new Map<string, () => void>();
    const sidebarPanel = { addEventListener() {} };
    const filterInput = {
        value: 'audit',
        addEventListener(type: string, listener: () => void) {
            listeners.set(type, listener);
        }
    };
    (globalThis as any).document = {
        getElementById(id: string) {
            if (id === 'sidebarPanel') return sidebarPanel;
            if (id === 'sidebarFilterInput') return filterInput;
            if (id.endsWith('List')) return { replaceChildren() {}, appendChild() {} };
            if (id.endsWith('Count')) return { textContent: '' };
            return null;
        },
        createElement() {
            return {
                className: '', dataset: {}, style: {}, textContent: '',
                appendChild() {}, addEventListener() {}
            };
        }
    };
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    (globalThis as any).setTimeout = (callback: () => void) => {
        callback();
        return 1;
    };
    (globalThis as any).clearTimeout = () => {};
    persistedState = undefined;
    const { state } = await import(stateModulePath) as StateModule;
    const { initSidebar } = await import(sidebarModulePath) as SidebarModule;

    try {
        state.selectedTable = null;
        initSidebar();
        listeners.get('input')?.();
        assert.strictEqual(state.sidebarFilter, 'audit');
        assert.strictEqual(getPersistedState()?.sidebarFilter, 'audit');
    } finally {
        state.sidebarFilter = '';
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
    }
});

afterEach(() => {
    delete (globalThis as any).document;
});

it('typing after Batch NULL disarms NULL and applies the typed value', async () => {
    const listeners = new Map<string, (event: any) => void>();
    const sidebarPanel = {
        addEventListener(type: string, listener: (event: any) => void) {
            listeners.set(type, listener);
        }
    };
    (globalThis as any).document = {
        getElementById(id: string) {
            return id === 'sidebarPanel' ? sidebarPanel : null;
        }
    };
    const { initSidebar } = await import(sidebarModulePath) as SidebarModule;
    initSidebar();

    const input = {
        value: 'abc',
        placeholder: 'SET TO NULL',
        dataset: {
            colidx: '0',
            isnull: 'true',
            ispatch: 'false',
            valuePlaceholder: '(mixed values)'
        },
        style: { fontStyle: 'italic' },
        closest(selector: string) {
            return selector === '.batch-input' ? this : null;
        }
    };
    const onInput = listeners.get('input');
    assert.ok(onInput, 'dynamic Batch Update inputs need a delegated input handler');
    onInput({ target: input });

    assert.strictEqual(input.dataset.isnull, 'false');
    assert.strictEqual(input.placeholder, '(mixed values)');
    assert.strictEqual(input.style.fontStyle, 'normal');
    const [update] = prepareBatchUpdates(
        [{ rowId: 1, rowIdx: 0, colIdx: 0, value: null }],
        new Map([[0, input]]),
        [{ name: 'value', type: 'TEXT' }]
    );
    assert.strictEqual(update.value, 'abc');

    input.value = '';
    onInput({ target: input });
    const [emptyUpdate] = prepareBatchUpdates(
        [{ rowId: 1, rowIdx: 0, colIdx: 0, value: 'abc' }],
        new Map([[0, input]]),
        [{ name: 'value', type: 'TEXT' }]
    );
    assert.strictEqual(emptyUpdate.value, '');
});

function makeClassList(initial: string[] = []) {
    const classes = new Set(initial);
    return {
        add(...names: string[]) { names.forEach(name => classes.add(name)); },
        remove(...names: string[]) { names.forEach(name => classes.delete(name)); },
        contains(name: string) { return classes.has(name); }
    };
}

function makeBatchNode(tagName = 'div', isFragment = false): any {
    return {
        tagName,
        isFragment,
        children: [] as any[],
        className: '',
        classList: makeClassList(),
        dataset: {} as Record<string, string>,
        style: {} as Record<string, string>,
        textContent: '',
        title: '',
        id: '',
        htmlFor: '',
        ariaLabel: '',
        disabled: false,
        appendChild(child: any) {
            if (child?.isFragment) this.children.push(...child.children);
            else this.children.push(child);
            return child;
        },
        replaceChildren(...children: any[]) {
            this.children = [...children];
        },
        setAttribute(name: string, value: string) {
            this[name] = value;
        }
    };
}

function findBatchNode(root: any, predicate: (node: any) => boolean): any {
    if (predicate(root)) return root;
    for (const child of root.children ?? []) {
        const match = findBatchNode(child, predicate);
        if (match) return match;
    }
    return undefined;
}

it('associates each generated Batch Update input and names its value-mode buttons', async () => {
    const elements: Record<string, any> = {
        batchUpdateSectionTitle: makeBatchNode('button'),
        batchUpdateList: makeBatchNode('div'),
        batchUpdateCount: makeBatchNode('span'),
        batchUpdateFields: makeBatchNode('div'),
        btnApplyBatchUpdate: makeBatchNode('button')
    };
    (globalThis as any).document = {
        getElementById(id: string) {
            return elements[id] ?? null;
        },
        createElement(tagName: string) {
            return makeBatchNode(tagName);
        },
        createTextNode(text: string) {
            const node = makeBatchNode('#text');
            node.textContent = text;
            return node;
        },
        createDocumentFragment() {
            return makeBatchNode('#fragment', true);
        }
    };
    const { state } = await import(stateModulePath) as any;
    const { updateBatchSidebar } = await import(sidebarModulePath) as SidebarModule;

    state.isReadOnly = false;
    state.selectedTable = 'items';
    state.selectedTableType = 'table';
    state.tableColumns = [{ name: 'payload', type: 'TEXT', notnull: 0 }];
    state.gridData = [[7, 'before']];
    state.gridExactIntegerTexts = {};
    state.gridOversizedCells = {};
    state.gridReadOnlyRowReasons = {};
    state.selectedCells = [{ rowIdx: 0, colIdx: 0, rowId: 7, value: 'before' }];

    try {
        updateBatchSidebar();

        const input = findBatchNode(
            elements.batchUpdateFields,
            node => node.className === 'batch-input'
        );
        const label = findBatchNode(
            elements.batchUpdateFields,
            node => node.tagName === 'label'
        );
        assert.ok(input);
        assert.ok(label);
        assert.notStrictEqual(input.id, '');
        assert.strictEqual(label.htmlFor, input.id);

        const expectedNames = new Map([
            ['btn-secondary btn-batch-null', 'Set payload to NULL'],
            ['btn-secondary btn-batch-empty', 'Set payload to empty string'],
            ['btn-secondary btn-batch-patch', 'Apply JSON patch to payload']
        ]);
        for (const [className, accessibleName] of expectedNames) {
            const button = findBatchNode(
                elements.batchUpdateFields,
                node => node.className === className
            );
            assert.ok(button, `${className} must exist`);
            assert.strictEqual(button.ariaLabel, accessibleName);
        }
    } finally {
        state.selectedTable = null;
        state.tableColumns = [];
        state.gridData = [];
        state.gridExactIntegerTexts = {};
        state.gridOversizedCells = {};
        state.gridReadOnlyRowReasons = {};
        state.selectedCells = [];
    }
});
