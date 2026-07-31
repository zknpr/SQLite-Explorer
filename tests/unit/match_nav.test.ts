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

    it('uses the whitespace policy for highlighting terms', async () => {
        const utilsModulePath = '../../core/ui/modules/utils.js';
        const { buildHighlightMatcher } = await import(utilsModulePath);

        assert.strictEqual(buildHighlightMatcher(['   ', '\t']), null);
        const padded = buildHighlightMatcher([' needle ']);
        assert.ok(padded);
        assert.strictEqual(padded.test('x needle y'), true);
        padded.lastIndex = 0;
        assert.strictEqual(padded.test('needle'), false);
    });

    it('uses SQLite ASCII-only case folding for navigation and highlighting', async () => {
        const cells = new Map([
            ['cell-0-0', { classList: createClassList(), scrollIntoView() {} }],
            ['cell-0-1', { classList: createClassList(), scrollIntoView() {} }],
            ['cell-0-2', { classList: createClassList(), scrollIntoView() {} }],
            ['cell-0-3', { classList: createClassList(), scrollIntoView() {} }]
        ]);
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'filterMatchCounter') return { textContent: '' };
                return cells.get(id) ?? null;
            },
            querySelectorAll() { return []; },
            createTextNode(text: string) { return { textContent: text }; },
            createElement(tag: string) {
                return { tag, className: '', textContent: '' };
            }
        };

        const stateModulePath = '../../core/ui/modules/state.js';
        const matchNavModulePath = '../../core/ui/modules/match-nav.js';
        const utilsModulePath = '../../core/ui/modules/utils.js';
        const { state } = await import(stateModulePath);
        const { formatCellValueForActiveMatch, navigateMatches, resetMatchNav } = await import(matchNavModulePath);
        const { appendHighlightedText, buildHighlightMatcher } = await import(utilsModulePath);
        state.selectedTableType = 'view';
        state.tableColumns = [
            { name: 'lower_unicode', type: 'TEXT' },
            { name: 'upper_unicode', type: 'TEXT' },
            { name: 'lower_ascii', type: 'TEXT' },
            { name: 'upper_ascii', type: 'TEXT' }
        ];
        state.gridData = [['ä', 'Ä', 'a', 'A']];
        state.columnFilters = {};
        state.filterQuery = 'ä';
        resetMatchNav();

        navigateMatches('global');

        assert.deepStrictEqual(state.matchNav.matches, [{ rowIdx: 0, colIdx: 0 }]);

        state.filterQuery = 'A';
        resetMatchNav();
        navigateMatches('global');

        assert.deepStrictEqual(state.matchNav.matches, [
            { rowIdx: 0, colIdx: 2 },
            { rowIdx: 0, colIdx: 3 }
        ]);

        const highlightParent = {
            children: [] as any[],
            appendChild(child: any) { this.children.push(child); }
        };
        appendHighlightedText(highlightParent, 'Ä ä', buildHighlightMatcher(['ä']));
        assert.deepStrictEqual(
            highlightParent.children
                .filter(child => child.className === 'cell-highlight')
                .map(child => child.textContent),
            ['ä']
        );

        const longValue = `Ä${'x'.repeat(150)}ä`;
        const excerpt = formatCellValueForActiveMatch(longValue, state.tableColumns[0], 'ä');
        assert.strictEqual(excerpt.includes('ä'), true);
        assert.strictEqual(excerpt.includes('Ä'), false);
    });

    it('navigates to a term beyond the rendered text truncation point', async () => {
        const textSpan = {
            children: [] as any[],
            appendChild(child: any) { this.children.push(child); },
            replaceChildren(...children: any[]) { this.children = children; }
        };
        const cell = {
            classList: createClassList(),
            dataset: { rowidx: '0', colidx: '0' },
            scrollIntoViewCalls: 0,
            scrollIntoView() { this.scrollIntoViewCalls++; },
            querySelector(selector: string) {
                return selector === '.cell-text' ? textSpan : null;
            }
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
            },
            createTextNode(text: string) {
                return { textContent: text };
            },
            createElement(tag: string) {
                return { tag, className: '', textContent: '' };
            }
        };

        const stateModulePath = '../../core/ui/modules/state.js';
        const matchNavModulePath = '../../core/ui/modules/match-nav.js';
        const utilsModulePath = '../../core/ui/modules/utils.js';
        const { state } = await import(stateModulePath);
        const { navigateMatches, resetMatchNav } = await import(matchNavModulePath);
        const { formatCellValueAsText } = await import(utilsModulePath);
        const fullValue = `${'x'.repeat(140)}Needle${'y'.repeat(140)}`;
        textSpan.children = [{ textContent: formatCellValueAsText(fullValue) }];

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
        const renderedText = textSpan.children.map(child => child.textContent).join('');
        assert.strictEqual(renderedText.startsWith('...'), true);
        assert.strictEqual(renderedText.endsWith('...'), true);
        assert.strictEqual(renderedText.includes('Needle'), true);
        assert.ok(
            textSpan.children.some(child => child.className === 'cell-highlight' && child.textContent === 'Needle'),
            'the active match should be visibly highlighted inside the excerpt'
        );

        resetMatchNav();
        assert.strictEqual(
            textSpan.children.map(child => child.textContent).join(''),
            formatCellValueAsText(fullValue),
            'leaving the active match should restore the normal truncated rendering'
        );
    });

    it('ignores whitespace-only navigation terms while preserving padded nonblank terms', async () => {
        const cells = new Map([
            ['cell-0-0', { classList: createClassList(), scrollIntoView() {} }],
            ['cell-0-1', { classList: createClassList(), scrollIntoView() {} }]
        ]);
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'filterMatchCounter') return { textContent: '' };
                return cells.get(id) ?? null;
            },
            querySelectorAll() { return []; }
        };

        const stateModulePath = '../../core/ui/modules/state.js';
        const matchNavModulePath = '../../core/ui/modules/match-nav.js';
        const { state } = await import(stateModulePath);
        const { navigateMatches, resetMatchNav } = await import(matchNavModulePath);
        state.selectedTableType = 'view';
        state.tableColumns = [
            { name: 'compact', type: 'TEXT' },
            { name: 'padded', type: 'TEXT' }
        ];
        state.gridData = [['needle', 'x needle y']];
        state.columnFilters = {};
        state.filterQuery = ' needle ';
        resetMatchNav();

        navigateMatches('global');

        assert.deepStrictEqual(state.matchNav.matches, [{ rowIdx: 0, colIdx: 1 }]);

        state.tableColumns = [{ name: 'spaced', type: 'TEXT' }];
        state.gridData = [['left right']];
        state.filterQuery = ' ';
        resetMatchNav();

        navigateMatches('global');

        assert.deepStrictEqual(state.matchNav.matches, []);
        assert.strictEqual(state.matchNav.term, '');

        state.filterQuery = '';
        state.columnFilters = { spaced: '\t ' };
        resetMatchNav();

        navigateMatches('spaced');

        assert.deepStrictEqual(state.matchNav.matches, []);
        assert.strictEqual(state.matchNav.term, '');
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

    it('matches text that exists only in the formatted cell value', async () => {
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
        state.tableColumns = [{ name: 'optional_value', type: 'TEXT' }];
        state.gridData = [[null]];
        state.dateFormat = 'raw';
        state.filterQuery = 'null';
        state.columnFilters = {};
        resetMatchNav();

        navigateMatches('global');

        assert.deepStrictEqual(state.matchNav.matches, [{ rowIdx: 0, colIdx: 0 }]);
        assert.strictEqual(cell.classList.contains('active-match-cell'), true);
    });

    it('matches SQLite REAL text coercion for exponent and integer-valued numbers', async () => {
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
        state.selectedTableType = 'view';
        state.tableColumns = [{ name: 'measurement', type: 'REAL' }];
        state.columnFilters = {};

        const cases = [
            { value: 1e20, term: '1.0e+20' },
            { value: 1e-7, term: '1.0e-07' },
            { value: 1e-5, term: '1.0e-05' },
            { value: 1, term: '1.0' },
            // SQLite and JS choose opposite final digits for this halfway-adjacent
            // binary64 value; the SQL-side rendering must remain navigable.
            { value: -2.330004368663885e137, term: '-2.33000436866388e+137' }
        ];
        for (const testCase of cases) {
            state.gridData = [[testCase.value]];
            state.filterQuery = testCase.term;
            resetMatchNav();

            navigateMatches('global');

            assert.deepStrictEqual(
                state.matchNav.matches,
                [{ rowIdx: 0, colIdx: 0 }],
                `${testCase.value} should match SQLite text ${testCase.term}`
            );
        }
    });

    it('navigates matches in the same pinned-first order as the rendered grid', async () => {
        const focusedCells: string[] = [];
        const cells = new Map<string, any>();
        for (let rowIdx = 0; rowIdx < 2; rowIdx++) {
            for (let colIdx = 0; colIdx < 2; colIdx++) {
                const id = `cell-${rowIdx}-${colIdx}`;
                cells.set(id, {
                    classList: createClassList(),
                    scrollIntoView() { focusedCells.push(id); }
                });
            }
        }
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'filterMatchCounter') return { textContent: '' };
                return cells.get(id) ?? null;
            },
            querySelectorAll() { return []; }
        };

        const stateModulePath = '../../core/ui/modules/state.js';
        const matchNavModulePath = '../../core/ui/modules/match-nav.js';
        const { state } = await import(stateModulePath);
        const { navigateMatches, resetMatchNav } = await import(matchNavModulePath);
        state.selectedTableType = 'table';
        state.tableColumns = [
            { name: 'first', type: 'TEXT' },
            { name: 'second', type: 'TEXT' }
        ];
        state.gridData = [
            [1, 'hit row 1 first', 'hit row 1 second'],
            [2, 'hit row 2 first', 'hit row 2 second']
        ];
        state.pinnedColumns.add('second');
        state.pinnedRowIds.add(2);
        state.filterQuery = 'hit';
        state.columnFilters = {};
        resetMatchNav();

        try {
            navigateMatches('global');

            assert.deepStrictEqual(state.matchNav.matches, [
                { rowIdx: 1, colIdx: 1 },
                { rowIdx: 1, colIdx: 0 },
                { rowIdx: 0, colIdx: 1 },
                { rowIdx: 0, colIdx: 0 }
            ]);
            assert.deepStrictEqual(focusedCells, ['cell-1-1']);
        } finally {
            state.pinnedColumns.clear();
            state.pinnedRowIds.clear();
            resetMatchNav();
        }
    });
});
