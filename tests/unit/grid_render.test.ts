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

describe('grid header rendering', () => {
    afterEach(async () => {
        delete (globalThis as any).document;
        const { state } = await import(stateModulePath);
        state.tableColumns = [];
        state.gridData = [];
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
});
