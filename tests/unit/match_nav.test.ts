import './vscode_mock_setup';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';

function createClassList() {
    const classes = new Set<string>();
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

describe('filter match navigation', () => {
    afterEach(() => {
        delete (globalThis as any).document;
    });

    it('navigates to a term beyond the rendered text truncation point', async () => {
        const cell = {
            classList: createClassList(),
            scrollIntoViewCalls: 0,
            scrollIntoView() { this.scrollIntoViewCalls++; }
        };
        const counter = { textContent: '' };
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'cell-0-0') return cell;
                if (id === 'filterMatchCounter') return counter;
                return null;
            },
            querySelectorAll(selector: string) {
                if (selector === '.active-match-cell') {
                    return cell.classList.contains('active-match-cell') ? [cell] : [];
                }
                return [];
            }
        };

        const stateModulePath = '../../core/ui/modules/state.js';
        const matchNavModulePath = '../../core/ui/modules/match-nav.js';
        const utilsModulePath = '../../core/ui/modules/utils.js';
        const { state } = await import(stateModulePath);
        const { navigateMatches, resetMatchNav } = await import(matchNavModulePath);
        const { formatCellValueAsText } = await import(utilsModulePath);
        const fullValue = `${'x'.repeat(101)}Needle`;

        state.selectedTableType = 'view';
        state.tableColumns = [{ name: 'notes', type: 'TEXT' }];
        state.gridData = [[fullValue]];
        state.filterQuery = 'needle';
        state.columnFilters = {};
        resetMatchNav();

        navigateMatches('global');

        assert.deepStrictEqual(state.matchNav.matches, [{ rowIdx: 0, colIdx: 0 }]);
        assert.strictEqual(counter.textContent, '1/1');
        assert.strictEqual(cell.classList.contains('active-match-cell'), true);
        assert.strictEqual(cell.scrollIntoViewCalls, 1);
        assert.strictEqual(formatCellValueAsText(fullValue).endsWith('...'), true);
        assert.strictEqual(formatCellValueAsText(fullValue, null, 'raw', null, false), fullValue);
    });

    it('matches the stored date value when display formatting changes its text', async () => {
        const cell = {
            classList: createClassList(),
            scrollIntoView() {}
        };
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'cell-0-0') return cell;
                if (id === 'filterMatchCounter') return { textContent: '' };
                return null;
            },
            querySelectorAll() { return []; }
        };

        const stateModulePath = '../../core/ui/modules/state.js';
        const matchNavModulePath = '../../core/ui/modules/match-nav.js';
        const { state } = await import(stateModulePath);
        const { navigateMatches, resetMatchNav } = await import(matchNavModulePath);
        state.tableColumns = [{ name: 'created_at', type: 'DATETIME' }];
        state.gridData = [['2024-01-15 12:34:56']];
        state.dateFormat = 'relative';
        state.filterQuery = '2024-01-15';
        state.columnFilters = {};
        resetMatchNav();

        navigateMatches('global');

        assert.deepStrictEqual(state.matchNav.matches, [{ rowIdx: 0, colIdx: 0 }]);
        assert.strictEqual(cell.classList.contains('active-match-cell'), true);
    });
});
