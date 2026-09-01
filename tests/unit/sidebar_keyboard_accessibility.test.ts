import './vscode_mock_setup';

import assert from 'node:assert';
import { afterEach, it } from 'node:test';

(globalThis as any).acquireVsCodeApi = () => ({
    getState: () => undefined,
    setState() {},
    postMessage() {}
});

const stateModulePath = '../../core/ui/modules/state.js';
const sidebarModulePath = '../../core/ui/modules/sidebar.js';

class FakeNode {
    readonly tagName: string;
    children: FakeNode[] = [];
    readonly dataset: Record<string, string> = {};
    readonly style: Record<string, string> = {};
    readonly attributes: Record<string, string> = {};
    className = '';
    textContent = '';
    title = '';
    type = '';
    disabled = false;
    isFragment = false;

    constructor(tagName: string) {
        this.tagName = tagName.toUpperCase();
    }

    get classList() {
        const node = this;
        return {
            add(...names: string[]) {
                const classes = new Set(node.className.split(/\s+/).filter(Boolean));
                names.forEach(name => classes.add(name));
                node.className = [...classes].join(' ');
            }
        };
    }

    appendChild(child: FakeNode) {
        if (child.isFragment) this.children.push(...child.children);
        else this.children.push(child);
        return child;
    }

    replaceChildren(...children: FakeNode[]) {
        this.children = children;
    }

    setAttribute(name: string, value: string) {
        this.attributes[name] = value;
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

it('renders table and view selection as native keyboard controls', async () => {
    const elements = new Map<string, FakeNode>([
        ['tablesBadge', new FakeNode('span')],
        ['viewsBadge', new FakeNode('span')],
        ['indexesBadge', new FakeNode('span')],
        ['tablesList', new FakeNode('ul')],
        ['viewsList', new FakeNode('ul')],
        ['indexesList', new FakeNode('ul')]
    ]);
    (globalThis as any).document = {
        getElementById(id: string) { return elements.get(id) ?? null; },
        createElement(tagName: string) { return new FakeNode(tagName); },
        createTextNode(text: string) {
            const node = new FakeNode('#text');
            node.textContent = text;
            return node;
        },
        createDocumentFragment() {
            const fragment = new FakeNode('#fragment');
            fragment.isFragment = true;
            return fragment;
        }
    };
    const { state } = await import(stateModulePath);
    const { renderSidebar } = await import(sidebarModulePath);
    state.sidebarFilter = '';
    state.selectedTable = 'users';
    state.selectedTableType = 'table';
    state.schemaCache.tables = [{ name: 'users' }];
    state.schemaCache.views = [{ name: 'active_users' }];
    state.schemaCache.indexes = [{ name: 'idx_users_name', table: 'users' }];

    renderSidebar();

    const tableButton = findByClass(elements.get('tablesList')!, 'list-item-select');
    const viewButton = findByClass(elements.get('viewsList')!, 'list-item-select');
    assert.strictEqual(tableButton?.tagName, 'BUTTON');
    assert.strictEqual(tableButton?.type, 'button');
    assert.strictEqual(tableButton?.attributes['aria-current'], 'true');
    assert.strictEqual(viewButton?.tagName, 'BUTTON');
    assert.match(viewButton?.attributes['aria-label'] ?? '', /open view active_users/i);
    assert.strictEqual(
        findByClass(elements.get('indexesList')!, 'list-item-select'),
        undefined,
        'non-actionable index descriptions must not masquerade as controls'
    );
});

afterEach(async () => {
    delete (globalThis as any).document;
    const { state } = await import(stateModulePath);
    state.sidebarFilter = '';
    state.selectedTable = null;
    state.selectedTableType = null;
    state.schemaCache.tables = [];
    state.schemaCache.views = [];
    state.schemaCache.indexes = [];
});
