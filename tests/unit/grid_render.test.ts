import './vscode_mock_setup';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';

const stateModulePath = '../../core/ui/modules/state.js';
const gridRenderModulePath = '../../core/ui/modules/grid-render.js';

class FakeNode {
    readonly tagName: string;
    readonly children: FakeNode[] = [];
    readonly style: Record<string, string> = {};
    readonly dataset: Record<string, any> = {};
    className = '';
    textContent = '';
    title = '';
    ariaLabel = '';
    tabIndex = -1;
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

    setAttribute(name: string, value: string) {
        (this as any)[name] = value;
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
        const applyButton = findByClass(container, 'filter-apply-btn');
        assert.ok(headerText);
        assert.ok(filterInput);
        assert.ok(clearButton);
        assert.ok(applyButton);
        assert.strictEqual(headerText.textContent, hostileColumn);
        assert.strictEqual(filterInput.value, hostileFilter);
        assert.strictEqual(clearButton.ariaLabel, `Clear filter for ${hostileColumn}`);
        assert.strictEqual(applyButton.ariaLabel, `Search column ${hostileColumn}`);
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

    it('renders bounded previews with exact metadata and a full-content affordance', async () => {
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
        assert.match(
            collectText(oversized[0]),
            /^ab… · TEXT · 12 bytes · full byte-exact value not shown in grid$/
        );
        assert.match(
            collectText(oversized[1]),
            /^de ad… · BLOB · 20 bytes · full byte-exact value not shown in grid$/
        );
        const expandIcons = findAllByClass(elements.get('gridContainer')!, 'expand-icon');
        assert.strictEqual(expandIcons.length, 2);
        assert.ok(expandIcons.every(icon => icon.title === 'View full content'));
        const readOnlyRow = findByClass(elements.get('gridContainer')!, 'read-only-row');
        assert.ok(readOnlyRow);
        assert.strictEqual(readOnlyRow.title, 'Primary-key identity was not transported.');
    });

    it('does not claim a one-byte contained TEXT value is too large', async () => {
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
        state.tableColumns = [{ name: 'unsafe_text', type: 'TEXT', isPrimaryKey: false }];
        state.gridData = [[1, '']];
        state.gridOversizedCells = {
            0: { 1: { storageClass: 'text', byteLength: 1 } }
        };
        state.totalPageCount = 1;
        state.currentPageIndex = 0;

        renderDataGrid();

        const cell = findByClass(elements.get('gridContainer')!, 'oversized-cell');
        assert.ok(cell);
        assert.strictEqual(
            cell.title,
            'Inline editing unavailable because the grid does not contain the full byte-exact value. ' +
            'Use View Full Content and the Hex view (TEXT, 1 byte).'
        );
        assert.doesNotMatch(cell.title, /too large/i);
        assert.strictEqual(
            collectText(cell),
            '… · TEXT · 1 byte · full byte-exact value not shown in grid'
        );
        const expand = findByClass(cell, 'expand-icon');
        assert.ok(expand);
        assert.strictEqual(expand.title, 'View full content');
        assert.strictEqual(expand.ariaLabel, 'View full content for unsafe_text, row 1');
    });

    it('renders semantic controls and one keyboard entry point for grid actions', async () => {
        const { state } = await import(stateModulePath);
        const { renderDataGrid } = await import(gridRenderModulePath);
        const container = new FakeNode('div');
        (globalThis as any).document = {
            createElement(tagName: string) { return new FakeNode(tagName); },
            createDocumentFragment() { return new FakeNode('#fragment'); },
            createTextNode(text: string) {
                const node = new FakeNode('#text');
                node.textContent = text;
                return node;
            },
            getElementById(id: string) { return id === 'gridContainer' ? container : null; },
            querySelectorAll() { return []; },
            querySelector() { return null; }
        };
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'body', type: 'TEXT', isPrimaryKey: false }];
        state.gridData = [[7, 'readable value']];
        state.totalPageCount = 1;
        state.currentPageIndex = 0;

        renderDataGrid();

        assert.strictEqual(findByClass(container, 'row-select-all-button')?.tagName, 'BUTTON');
        assert.strictEqual(findByClass(container, 'header-sort-button')?.tagName, 'BUTTON');
        assert.strictEqual(findByClass(container, 'select-column-icon')?.tagName, 'BUTTON');
        assert.strictEqual(findAllByClass(container, 'pin-icon').every(node => node.tagName === 'BUTTON'), true);
        assert.strictEqual(findByClass(container, 'row-select-button')?.tagName, 'BUTTON');
        assert.strictEqual(findByClass(container, 'expand-icon')?.tagName, 'BUTTON');

        const resize = findByClass(container, 'resize-handle');
        assert.ok(resize);
        assert.strictEqual((resize as any).role, 'separator');
        assert.strictEqual(resize.tabIndex, 0);

        const cells = findAllByClass(container, 'data-cell')
            .filter(cell => !cell.className.split(/\s+/).includes('row-number'));
        assert.deepStrictEqual(cells.map(cell => cell.tabIndex), [0]);
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
});
