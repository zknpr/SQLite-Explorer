import './vscode_mock_setup';

import assert from 'node:assert';
import { it } from 'node:test';

interface PersistedGridState {
    columnWidths?: Record<string, number>;
}

interface ColumnResizeState {
    resizingColumn: string | null;
    columnWidths: Record<string, number>;
    gridData: unknown[][];
    tableColumns: Array<{ name: string; type: string }>;
}

interface StateModule {
    state: ColumnResizeState;
}

interface GridActionsModule {
    onColumnResizeKeydown(event: unknown, columnName: string): boolean;
    stopColumnResize(): void;
}

const stateModulePath = '../../core/ui/modules/state.js';
const gridActionsModulePath = '../../core/ui/modules/grid-actions.js';

let persisted: PersistedGridState | undefined;
(globalThis as any).acquireVsCodeApi = () => ({
    getState: () => undefined,
    setState(value: PersistedGridState) { persisted = value; },
    postMessage() {}
});

function getPersistedState(): PersistedGridState | undefined {
    return persisted;
}

it('persists the final grid column width when resizing stops', async () => {
    const container = {
        innerHTML: '', scrollLeft: 0, scrollTop: 0,
        appendChild() {}
    };
    (globalThis as any).document = {
        body: { style: { userSelect: 'none', cursor: 'col-resize' } },
        getElementById(id: string) { return id === 'gridContainer' ? container : null; },
        querySelector() { return null; },
        removeEventListener() {},
        createElement() {
            return { className: '', innerHTML: '', style: {}, appendChild() {} };
        }
    };
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    (globalThis as any).setTimeout = (callback: () => void) => {
        callback();
        return 1;
    };
    (globalThis as any).clearTimeout = () => {};
    const { state } = await import(stateModulePath) as StateModule;
    const { stopColumnResize } = await import(gridActionsModulePath) as GridActionsModule;
    state.resizingColumn = 'body';
    state.columnWidths = { body: 240 };
    state.gridData = [];
    state.tableColumns = [];
    persisted = undefined;

    try {
        stopColumnResize();
        assert.strictEqual(getPersistedState()?.columnWidths?.body, 240);
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
        delete (globalThis as any).document;
    }
});

it('invalidates cached cell-overflow measurements when a column width changes', async () => {
    const classes = new Set(['checked-overflow', 'has-overflow']);
    const dataCell = {
        style: {} as Record<string, string>,
        classList: {
            remove(...names: string[]) { names.forEach(name => classes.delete(name)); }
        }
    };
    const headerCell = {
        dataset: { column: 'body' },
        style: {} as Record<string, string>
    };
    (globalThis as any).document = {
        querySelectorAll(selector: string) {
            if (selector === 'th[data-column]') return [headerCell];
            if (selector === '.data-row td.data-cell[data-colidx="0"]') return [dataCell];
            return [];
        }
    };
    const { state } = await import(stateModulePath) as StateModule;
    const { onColumnResizeKeydown } = await import(gridActionsModulePath) as GridActionsModule;
    state.columnWidths = { body: 120 };
    state.tableColumns = [{ name: 'body', type: 'TEXT' }];
    let prevented = 0;

    try {
        assert.strictEqual(onColumnResizeKeydown({
            key: 'ArrowRight',
            shiftKey: false,
            preventDefault() { prevented++; },
            stopPropagation() {},
            target: { setAttribute() {} }
        }, 'body'), true);
        assert.strictEqual(prevented, 1);
        assert.strictEqual(classes.has('checked-overflow'), false);
        assert.strictEqual(classes.has('has-overflow'), false);
    } finally {
        state.tableColumns = [];
        state.columnWidths = {};
        delete (globalThis as any).document;
    }
});
