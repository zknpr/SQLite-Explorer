import './vscode_mock_setup';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

// The VS Code host posts its refreshContent broadcast before the reply to a
// webview's own mutation, and that refresh reloads the grid. These tests drive
// the real webview modules against a permissive DOM stub and count the page
// fetches a mutation causes.

function element(): any {
    return new Proxy({
        style: {}, dataset: {}, children: [], childNodes: [], value: '', textContent: '', innerHTML: '',
        className: '', disabled: false, isConnected: true, scrollTop: 0, scrollLeft: 0,
        clientHeight: 0, clientWidth: 0, scrollHeight: 0, offsetHeight: 0, offsetWidth: 0
    }, {
        get(target: any, property) {
            if (property in target) return target[property];
            if (property === 'classList') {
                return (target[property] = { add() {}, remove() {}, toggle() {}, contains: () => false });
            }
            if (property === 'getBoundingClientRect') {
                return () => ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 });
            }
            if (['querySelectorAll', 'getElementsByTagName', 'getElementsByClassName'].includes(String(property))) {
                return () => [];
            }
            if (property === 'querySelector' || property === 'closest') return () => null;
            if (['parentElement', 'parentNode', 'firstChild', 'lastChild', 'nextSibling', 'previousSibling']
                .includes(String(property))) return null;
            if (typeof property === 'string') return (target[property] = () => undefined);
            return undefined;
        },
        set(target: any, property, value) { target[property] = value; return true; }
    });
}

const elements = new Map<string, any>();
(globalThis as any).acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage() {} });
(globalThis as any).document = {
    getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => element(),
    createTextNode: () => element(),
    createDocumentFragment: () => element(),
    addEventListener() {},
    removeEventListener() {},
    body: element(),
    documentElement: element(),
    visibilityState: 'hidden',
    activeElement: null
};
(globalThis as any).getComputedStyle = () => ({ getPropertyValue: () => '' });

after(() => {
    delete (globalThis as any).acquireVsCodeApi;
    delete (globalThis as any).document;
    delete (globalThis as any).getComputedStyle;
});

describe('grid reload after a webview mutation', () => {
    let modules: Record<string, any>;
    let calls: string[];
    let echoes: Promise<unknown>[];
    let host: 'vscode' | 'demo';
    let failNextPageFetch: boolean;
    const rows = () => Array.from({ length: 20 }, (_, index) => [index + 1, `a${index}`, `b${index}`]);

    before(async () => {
        const load = (name: string) => import(`../../core/ui/modules/${name}.js`);
        modules = {
            api: await load('api'),
            rpc: await load('rpc'),
            state: await load('state'),
            edit: await load('edit'),
            crud: await load('crud'),
            clipboard: await load('clipboard')
        };
        const hostEcho = () => {
            if (host === 'vscode') echoes.push(modules.rpc.refreshContent('fixture.db'));
        };
        Object.assign(modules.api.backendApi, {
            fetchSchema: async () => {
                calls.push('fetchSchema');
                return { tables: [{ identifier: 'items', identity: { kind: 'rowid' } }], views: [], indexes: [] };
            },
            getTableInfo: async () => {
                calls.push('getTableInfo');
                return ['first', 'second'].map((identifier, ordinal) => ({
                    ordinal, identifier, declaredType: 'TEXT', isRequired: false,
                    defaultExpression: null, primaryKeyPosition: 0
                }));
            },
            fetchTableData: async () => {
                calls.push('fetchTableData');
                if (failNextPageFetch) {
                    failNextPageFetch = false;
                    throw new Error('page fetch failed');
                }
                return { headers: ['rowid', 'first', 'second'], rows: rows() };
            },
            fetchTableCount: async () => {
                calls.push('fetchTableCount');
                return { count: 20, isExact: true };
            },
            updateCell: async () => { calls.push('updateCell'); hostEcho(); return undefined; },
            insertRow: async () => { calls.push('insertRow'); hostEcho(); return undefined; },
            deleteRows: async () => { calls.push('deleteRows'); hostEcho(); return undefined; },
            updateCellBatch: async () => { calls.push('updateCellBatch'); hostEcho(); return []; }
        });
    });

    beforeEach(() => {
        calls = [];
        echoes = [];
        host = 'vscode';
        failNextPageFetch = false;
        const { state } = modules.state;
        Object.assign(state, {
            isDbConnected: true,
            isReadOnly: false,
            selectedTable: 'items',
            selectedTableType: 'table',
            renderedTable: 'items',
            tableColumns: [{ cid: 0, name: 'first', type: 'TEXT' }, { cid: 1, name: 'second', type: 'TEXT' }],
            gridData: rows(),
            schemaCache: { tables: [{ name: 'items' }], views: [], indexes: [] },
            editingCellInfo: null,
            activeCellInput: null,
            contentRefreshPromise: null,
            selectedCells: [],
            selectedRowIds: new Set()
        });
    });

    const pageFetches = () => calls.filter(call => call === 'fetchTableData').length;
    const settle = async () => { await Promise.allSettled(echoes); };

    const commitWithTab = async () => {
        const { state } = modules.state;
        state.editingCellInfo = {
            rowIdx: 0, colIdx: 0, rowId: 1, columnName: 'first', table: 'items', tableType: 'table',
            column: state.tableColumns[0], identityKind: null, originalValue: 'a0'
        };
        state.activeCellInput = { value: 'edited', removeEventListener() {}, isConnected: true };
        await modules.edit.onCellInputKeydown({ key: 'Tab', shiftKey: false, preventDefault() {} });
        await settle();
    };
    const insertRow = async () => {
        modules.crud.openAddRowModal();
        await modules.crud.submitAddRow();
        await settle();
    };
    const deleteRows = async () => {
        modules.state.state.selectedRowIds = new Set([3, 4]);
        modules.crud.openDeleteModal();
        await modules.crud.submitDelete();
        await settle();
    };
    const clearCells = async () => {
        modules.state.state.selectedCells = [{ rowIdx: 1, colIdx: 0, rowId: 2, value: 'a1' }];
        await modules.clipboard.clearSelectedCellValues();
        await settle();
    };
    const mutations: Array<[string, string, () => Promise<void>]> = [
        ['a Tab-committed edit', 'updateCell', commitWithTab],
        ['an inserted row', 'insertRow', insertRow],
        ['deleted rows', 'deleteRows', deleteRows],
        ['cleared cells', 'updateCellBatch', clearCells]
    ];

    for (const [label, mutation, run] of mutations) {
        it(`loads the page once after ${label} when the host echo reloads it`, async () => {
            await run();
            assert.equal(calls[0], mutation);
            assert.equal(echoes.length, 1);
            assert.equal(pageFetches(), 1, calls.join(', '));
        });

        it(`loads the page itself after ${label} without a host echo`, async () => {
            host = 'demo';
            await run();
            assert.deepEqual(calls.filter(call => call !== 'fetchTableCount'), [mutation, 'fetchTableData']);
        });

        it(`loads the page again after ${label} when the echo's reload failed`, async () => {
            failNextPageFetch = true;
            await run();
            assert.equal(echoes.length, 1);
            assert.equal(pageFetches(), 2, calls.join(', '));
            assert.equal(modules.state.state.gridData.length, 20);
        });
    }

    it('still opens the next cell editor after a Tab commit that skipped the second load', async () => {
        await commitWithTab();
        assert.equal(modules.state.state.editingCellInfo?.colIdx, 1);
        assert.equal(modules.state.state.editingCellInfo?.rowId, 1);
    });
});
