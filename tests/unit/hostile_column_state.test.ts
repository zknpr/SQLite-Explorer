import './vscode_mock_setup';

import assert from 'node:assert';
import { it } from 'node:test';

const stateModulePath = '../../core/ui/modules/state.js';
const gridActionsModulePath = '../../core/ui/modules/grid-actions.js';

it('stores prototype-spelled column filters as ordinary own state', async () => {
    const { state } = await import(stateModulePath);
    const { syncFilterInputsToState } = await import(gridActionsModulePath);
    const inputs = ['__proto__', 'constructor', 'toString'].map((column, index) => ({
        dataset: { column },
        value: `needle-${index}`,
        closest() { return null; }
    }));
    (globalThis as any).document = {
        getElementById() { return null; },
        querySelectorAll(selector: string) { return selector === '.column-filter' ? inputs : []; }
    };

    try {
        assert.strictEqual(Object.getPrototypeOf(state.columnFilters), null);
        syncFilterInputsToState();
        assert.deepStrictEqual(
            Object.entries(state.columnFilters),
            [
                ['__proto__', 'needle-0'],
                ['constructor', 'needle-1'],
                ['toString', 'needle-2']
            ]
        );
        assert.strictEqual(Object.hasOwn(state.columnFilters, '__proto__'), true);
    } finally {
        state.columnFilters = Object.create(null);
        state.filterQuery = '';
        state.filterApplyPending = false;
        state.filterApplyTable = null;
        delete (globalThis as any).document;
    }
});

it('normalizes persisted column state without inherited keys', async () => {
    const { createSafeColumnState } = await import(stateModulePath);
    const persisted = Object.create({ inherited: 99 });
    Object.defineProperty(persisted, '__proto__', {
        value: 180,
        enumerable: true,
        configurable: true,
        writable: true
    });
    persisted.constructor = 220;

    const normalized = createSafeColumnState(persisted);
    assert.strictEqual(Object.getPrototypeOf(normalized), null);
    assert.deepStrictEqual(Object.entries(normalized), [
        ['__proto__', 180],
        ['constructor', 220]
    ]);
    assert.strictEqual(Object.hasOwn(normalized, 'inherited'), false);
});
