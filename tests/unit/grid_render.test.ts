import './vscode_mock_setup';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';

const stateModulePath = '../../core/ui/modules/state.js';
const gridRenderModulePath = '../../core/ui/modules/grid-render.js';
const gridActionsModulePath = '../../core/ui/modules/grid-actions.js';

class FakeNode {
    readonly tagName: string;
    readonly children: FakeNode[] = [];
    readonly style: Record<string, string> = {};
    readonly dataset: Record<string, any> = {};
    className = '';
    textContent = '';
    title = '';
    ariaLabel = '';
    hidden = false;
    value = '';
    scrollLeft = 0;
    scrollTop = 0;
    private html = '';

    constructor(tagName: string) {
        this.tagName = tagName.toUpperCase();
    }

    appendChild(child: FakeNode) {
        this.children.push(child);
        return child;
    }

    set innerHTML(value: string) {
        if (this.tagName === 'TH') {
            throw new Error('Grid headers must not be constructed with innerHTML');
        }
        this.html = value;
        if (value === '') this.children.length = 0;
    }

    get innerHTML() {
        return this.html;
    }
}

function findByClass(root: FakeNode, className: string): FakeNode | undefined {
    if (root.className.split(/\s+/).includes(className)) return root;
    for (const child of root.children) {
        const found = findByClass(child, className);
        if (found) return found;
    }
    return undefined;
}

function findAllByClass(root: FakeNode, className: string): FakeNode[] {
    const matches = root.className.split(/\s+/).includes(className) ? [root] : [];
    for (const child of root.children) {
        matches.push(...findAllByClass(child, className));
    }
    return matches;
}

function collectText(root: FakeNode): string {
    return root.textContent + root.children.map(collectText).join('');
}

describe('grid header rendering', () => {
    afterEach(async () => {
        delete (globalThis as any).document;
        const { state } = await import(stateModulePath);
        state.tableColumns = [];
        state.gridData = [];
        state.gridExactIntegerTexts = {};
        state.gridOversizedCells = {};
        state.gridReadOnlyRowReasons = {};
        state.columnWidths = {};
        state.columnFilters = {};
        state.filterQuery = '';
        state.sortedColumn = null;
        state.selectedCells = [];
        state.selectedRowIds.clear();
        state.selectedColumns.clear();
        state.pinnedColumns.clear();
        state.pinnedRowIds.clear();
        state.matchNav = {
            scope: null,
            term: null,
            matches: [],
            currentIndex: -1
        };
    });

    it('constructs hostile column headers with text and value properties only', async () => {
        const { state } = await import(stateModulePath);
        const { renderDataGrid } = await import(gridRenderModulePath);
        const hostileColumn = '<img src=x onerror=alert(1)>';
        const hostileFilter = '" autofocus onfocus=alert(2) x="';
        const container = new FakeNode('div');
        (globalThis as any).document = {
            createElement(tagName: string) {
                return new FakeNode(tagName);
            },
            createDocumentFragment() {
                return new FakeNode('#fragment');
            },
            createTextNode(text: string) {
                const node = new FakeNode('#text');
                node.textContent = text;
                return node;
            },
            getElementById(id: string) {
                return id === 'gridContainer' ? container : null;
            },
            querySelectorAll() {
                return [];
            },
            querySelector() {
                return null;
            }
        };
        state.tableColumns = [{
            name: hostileColumn,
            type: 'TEXT',
            isPrimaryKey: false
        }];
        state.gridData = [];
        state.columnFilters = { [hostileColumn]: hostileFilter };

        assert.doesNotThrow(() => renderDataGrid());
        const headerText = findByClass(container, 'header-text');
        const filterInput = findByClass(container, 'column-filter');
        const clearButton = findByClass(container, 'filter-clear-btn');
        assert.ok(headerText);
        assert.ok(filterInput);
        assert.ok(clearButton);
        assert.strictEqual(headerText.textContent, hostileColumn);
        assert.strictEqual(filterInput.value, hostileFilter);
        assert.strictEqual(clearButton.ariaLabel, `Clear filter for ${hostileColumn}`);
        assert.strictEqual(clearButton.hidden, false);
    });

    it('renders authoritative numeric sidecar text instead of a rounded Number', async () => {
        const { state } = await import(stateModulePath);
        const { renderDataGrid } = await import(gridRenderModulePath);
        const elements = new Map<string, FakeNode>([
            ['gridContainer', new FakeNode('div')],
            ['pageIndicator', new FakeNode('span')],
            ['btnFirst', new FakeNode('button')],
            ['btnPrev', new FakeNode('button')],
            ['btnNext', new FakeNode('button')],
            ['btnLast', new FakeNode('button')]
        ]);
        (globalThis as any).document = {
            createElement(tagName: string) {
                return new FakeNode(tagName);
            },
            createDocumentFragment() {
                return new FakeNode('#fragment');
            },
            createTextNode(text: string) {
                const node = new FakeNode('#text');
                node.textContent = text;
                return node;
            },
            getElementById(id: string) {
                return elements.get(id) ?? null;
            },
            querySelectorAll() {
                return [];
            },
            querySelector() {
                return null;
            }
        };
        state.selectedTableType = 'view';
        state.tableColumns = [{ name: 'value', type: 'INTEGER', isPrimaryKey: false }];
        state.gridData = [[9007199254740992]];
        state.gridExactIntegerTexts = { 0: { 0: '9007199254740993' } };
        state.totalPageCount = 1;
        state.currentPageIndex = 0;

        renderDataGrid();

        const text = findByClass(elements.get('gridContainer')!, 'cell-text');
        assert.ok(text);
        assert.strictEqual(text.children.map(child => child.textContent).join(''), '9007199254740993');
    });

    it('renders bounded oversized previews with exact storage and byte metadata', async () => {
        const { state } = await import(stateModulePath);
        const { renderDataGrid } = await import(gridRenderModulePath);
        const elements = new Map<string, FakeNode>([
            ['gridContainer', new FakeNode('div')],
            ['pageIndicator', new FakeNode('span')],
            ['btnFirst', new FakeNode('button')],
            ['btnPrev', new FakeNode('button')],
            ['btnNext', new FakeNode('button')],
            ['btnLast', new FakeNode('button')]
        ]);
        (globalThis as any).document = {
            createElement(tagName: string) { return new FakeNode(tagName); },
            createDocumentFragment() { return new FakeNode('#fragment'); },
            createTextNode(text: string) {
                const node = new FakeNode('#text');
                node.textContent = text;
                return node;
            },
            getElementById(id: string) { return elements.get(id) ?? null; },
            querySelectorAll() { return []; },
            querySelector() { return null; }
        };
        state.selectedTableType = 'table';
        state.tableColumns = [
            { name: 'body', type: 'TEXT', isPrimaryKey: false },
            { name: 'payload', type: 'BLOB', isPrimaryKey: false }
        ];
        state.gridData = [[1, 'ab', new Uint8Array([0xde, 0xad])]];
        state.gridOversizedCells = {
            0: {
                1: { storageClass: 'text', byteLength: 12 },
                2: { storageClass: 'blob', byteLength: 20 }
            }
        };
        state.gridReadOnlyRowReasons = { 0: 'Primary-key identity was not transported.' };
        state.totalPageCount = 1;
        state.currentPageIndex = 0;

        renderDataGrid();

        const oversized = findAllByClass(elements.get('gridContainer')!, 'oversized-cell');
        assert.strictEqual(oversized.length, 2);
        assert.match(collectText(oversized[0]), /^ab… · TEXT · 12 bytes · too large to edit inline$/);
        assert.match(collectText(oversized[1]), /^de ad… · BLOB · 20 bytes · too large to edit inline$/);
        assert.strictEqual(findAllByClass(elements.get('gridContainer')!, 'expand-icon').length, 0);
        const readOnlyRow = findByClass(elements.get('gridContainer')!, 'read-only-row');
        assert.ok(readOnlyRow);
        assert.strictEqual(readOnlyRow.title, 'Primary-key identity was not transported.');
    });

    it('highlights only cells whose SQLite-comparable value matches the global filter', async () => {
        const { state } = await import(stateModulePath);
        const { renderDataGrid } = await import(gridRenderModulePath);
        const elements = new Map<string, FakeNode>([
            ['gridContainer', new FakeNode('div')],
            ['pageIndicator', new FakeNode('span')],
            ['btnFirst', new FakeNode('button')],
            ['btnPrev', new FakeNode('button')],
            ['btnNext', new FakeNode('button')],
            ['btnLast', new FakeNode('button')]
        ]);
        (globalThis as any).document = {
            createElement(tagName: string) { return new FakeNode(tagName); },
            createDocumentFragment() { return new FakeNode('#fragment'); },
            createTextNode(text: string) {
                const node = new FakeNode('#text');
                node.textContent = text;
                return node;
            },
            getElementById(id: string) { return elements.get(id) ?? null; },
            querySelectorAll() { return []; },
            querySelector() { return null; }
        };
        state.selectedTableType = 'view';
        state.tableColumns = [
            { name: 'placeholder', type: 'TEXT', isPrimaryKey: false },
            { name: 'matching_text', type: 'TEXT', isPrimaryKey: false }
        ];
        state.gridData = [
            [null, 'NULL'],
            [new Uint8Array([1, 2]), '[BLOB]']
        ];
        state.totalPageCount = 1;
        state.currentPageIndex = 0;
        state.filterQuery = 'NULL';

        renderDataGrid();

        let highlights = findAllByClass(elements.get('gridContainer')!, 'cell-highlight');
        assert.deepStrictEqual(highlights.map(node => node.textContent), ['NULL']);

        state.filterQuery = 'BLOB';
        renderDataGrid();

        highlights = findAllByClass(elements.get('gridContainer')!, 'cell-highlight');
        assert.deepStrictEqual(highlights.map(node => node.textContent), ['BLOB']);
    });
    it('resizes the column under the cursor even when a column is pinned', async () => {
        // G-2. `onColumnResize` used to select the body cells it widens with
        // `td:nth-child(colIdx + 2)` — an ORIGINAL column index used as a DOM
        // POSITION. `getOrderedColumnIndices()` renders pinned columns FIRST,
        // so with anything pinned the drag preview widened the wrong column's
        // cells; `stopColumnResize`'s re-render corrected it on mouseup, which
        // is why it never looked like a bug worth chasing.
        //
        // Two halves, and the test needs both to be honest: the RENDERER must
        // actually reorder (otherwise the fix is guarding nothing), and the
        // RESIZER must address cells by the identity the renderer stamps.
        const { state } = await import(stateModulePath);
        const { renderDataGrid } = await import(gridRenderModulePath);
        const { startColumnResize, onColumnResize } = await import(gridActionsModulePath);

        const elements = new Map<string, FakeNode>([
            ['gridContainer', new FakeNode('div')],
            ['pageIndicator', new FakeNode('span')],
            ['btnFirst', new FakeNode('button')],
            ['btnPrev', new FakeNode('button')],
            ['btnNext', new FakeNode('button')],
            ['btnLast', new FakeNode('button')]
        ]);
        const selectorsAsked: string[] = [];
        let queryAll: (selector: string) => FakeNode[] = () => [];
        (globalThis as any).document = {
            body: new FakeNode('body'),
            createElement(tagName: string) { return new FakeNode(tagName); },
            createDocumentFragment() { return new FakeNode('#fragment'); },
            createTextNode(text: string) {
                const node = new FakeNode('#text');
                node.textContent = text;
                return node;
            },
            getElementById(id: string) { return elements.get(id) ?? null; },
            querySelectorAll(selector: string) {
                selectorsAsked.push(selector);
                return queryAll(selector);
            },
            querySelector(selector: string) {
                selectorsAsked.push(selector);
                return queryAll(selector)[0] ?? null;
            },
            addEventListener() {},
            removeEventListener() {}
        };

        state.selectedTableType = 'table';
        state.tableColumns = [
            { name: 'a', type: 'TEXT', isPrimaryKey: false },
            { name: 'b', type: 'TEXT', isPrimaryKey: false },
            { name: 'c', type: 'TEXT', isPrimaryKey: false }
        ];
        state.gridData = [['a0', 'b0', 'c0'], ['a1', 'b1', 'c1']];
        state.totalPageCount = 1;
        state.currentPageIndex = 0;
        state.pinnedColumns.add('c');

        renderDataGrid();

        // HALF ONE: the renderer really does put the pinned column first, so a
        // position-derived selector really is wrong here. `c` is original
        // index 2 and is rendered at display position 0.
        const dataRows = findAllByClass(elements.get('gridContainer')!, 'data-row');
        assert.ok(dataRows.length >= 1);
        const bodyCells = dataRows[0].children.filter(child => child.tagName === 'TD');
        assert.deepStrictEqual(
            bodyCells.map(cell => cell.dataset.colidx),
            [undefined, 2, 0, 1],
            'row-number cell, then the pinned column, then the rest'
        );

        // HALF TWO: resizing `b` (original index 1, display position 2) must
        // address the cells carrying colidx 1 — never `nth-child(3)`, which is
        // where `b` happens to sit, nor `nth-child(1 + 2)` computed from the
        // original index, which is where `a` sits.
        const targets = bodyCells.filter(cell => cell.dataset.colidx === 1);
        queryAll = (selector: string) => (
            selector.includes('data-colidx="1"') ? targets : []
        );
        selectorsAsked.length = 0;

        const handle = new FakeNode('div');
        (handle as any).classList = { add() {}, remove() {} };
        // The renderer has already measured `b`; a drag moves from THAT width.
        const startWidth = state.columnWidths.b ?? 120;
        startColumnResize(
            { stopPropagation() {}, clientX: 100, target: handle } as never,
            'b'
        );
        onColumnResize({ clientX: 160 } as never);

        assert.strictEqual(state.columnWidths.b, startWidth + 60);
        assert.ok(
            selectorsAsked.some(selector => selector === '.data-row td[data-colidx="1"]'),
            `body cells were addressed by position, not identity: ${JSON.stringify(selectorsAsked)}`
        );
        assert.ok(
            !selectorsAsked.some(selector => selector.includes('nth-child')),
            `a positional selector survived: ${JSON.stringify(selectorsAsked)}`
        );
        for (const cell of targets) {
            assert.strictEqual(cell.style.width, `${startWidth + 60}px`);
            assert.strictEqual(cell.style.minWidth, `${startWidth + 60}px`);
            assert.strictEqual(cell.style.maxWidth, `${startWidth + 60}px`);
        }

        // The clamp is the only other rule this handler has.
        onColumnResize({ clientX: -1000 } as never);
        assert.strictEqual(state.columnWidths.b, 30);

        state.resizingColumn = null;
    });
});
