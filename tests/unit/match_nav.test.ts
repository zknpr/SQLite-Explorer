import './vscode_mock_setup';

import { afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert';

let GLOBAL_MATCH_SCOPE: symbol;

before(async () => {
    const matchNavModulePath = '../../core/ui/modules/match-nav.js';
    ({ GLOBAL_MATCH_SCOPE } = await import(matchNavModulePath));
});

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

        navigateMatches(GLOBAL_MATCH_SCOPE);

        assert.deepStrictEqual(state.matchNav.matches, [{ rowIdx: 0, colIdx: 0 }]);

        state.filterQuery = 'A';
        resetMatchNav();
        navigateMatches(GLOBAL_MATCH_SCOPE);

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

    it('treats a column named global as a column-filter scope', async () => {
        const globalCounter = { textContent: '' };
        const columnCounters = [
            { dataset: { column: 'global' }, textContent: '' },
            { dataset: { column: 'other' }, textContent: '' }
        ];
        const cells = new Map([
            ['cell-0-0', { classList: createClassList(), scrollIntoView() {} }],
            ['cell-0-1', { classList: createClassList(), scrollIntoView() {} }]
        ]);
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'filterMatchCounter') return globalCounter;
                return cells.get(id) ?? null;
            },
            querySelectorAll(selector: string) {
                return selector === '.column-filter-counter' ? columnCounters : [];
            }
        };

        const stateModulePath = '../../core/ui/modules/state.js';
        const matchNavModulePath = '../../core/ui/modules/match-nav.js';
        const { state } = await import(stateModulePath);
        const { navigateMatches, resetMatchNav } = await import(matchNavModulePath);
        state.selectedTableType = 'view';
        state.tableColumns = [
            { name: 'global', type: 'TEXT' },
            { name: 'other', type: 'TEXT' }
        ];
        state.gridData = [['column needle', 'toolbar needle']];
        state.filterQuery = 'toolbar';
        state.columnFilters = { global: 'column' };
        resetMatchNav();

        navigateMatches('global');

        assert.deepStrictEqual(state.matchNav.matches, [{ rowIdx: 0, colIdx: 0 }]);
        assert.strictEqual(globalCounter.textContent, '');
        assert.strictEqual(columnCounters[0].textContent, '1/1');
        assert.strictEqual(columnCounters[1].textContent, '');
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

        navigateMatches(GLOBAL_MATCH_SCOPE);

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

        navigateMatches(GLOBAL_MATCH_SCOPE);

        assert.deepStrictEqual(state.matchNav.matches, [{ rowIdx: 0, colIdx: 1 }]);

        state.tableColumns = [{ name: 'spaced', type: 'TEXT' }];
        state.gridData = [['left right']];
        state.filterQuery = ' ';
        resetMatchNav();

        navigateMatches(GLOBAL_MATCH_SCOPE);

        assert.deepStrictEqual(state.matchNav.matches, []);
        assert.strictEqual(state.matchNav.term, '');

        state.filterQuery = '';
        state.columnFilters = { spaced: '\t ' };
        resetMatchNav();

        navigateMatches('spaced');

        assert.deepStrictEqual(state.matchNav.matches, []);
        assert.strictEqual(state.matchNav.term, '');
    });

    it('matches raw stored date text even when display formatting changes it', async () => {
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
        state.tableColumns = [{ name: 'created_at', type: 'DATETIME' }];
        state.gridData = [['2024-01-15 12:34:56']];
        state.dateFormat = 'relative';
        state.filterQuery = '2024-01-15';
        state.columnFilters = {};
        resetMatchNav();

        navigateMatches(GLOBAL_MATCH_SCOPE);

        assert.deepStrictEqual(state.matchNav.matches, [{ rowIdx: 0, colIdx: 0 }]);
        assert.strictEqual(cell.classList.contains('active-match-cell'), true);
    });

    it('does not match text introduced only by date display formatting', async () => {
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
        state.tableColumns = [{ name: 'created_at', type: 'DATETIME' }];
        state.gridData = [[1704067200]];
        state.dateFormat = 'iso';
        state.filterQuery = '2024';
        state.columnFilters = {};
        resetMatchNav();

        navigateMatches(GLOBAL_MATCH_SCOPE);

        assert.deepStrictEqual(state.matchNav.matches, []);
        assert.strictEqual(cell.classList.contains('active-match-cell'), false);
    });

    it('does not match the display-only NULL placeholder', async () => {
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

        navigateMatches(GLOBAL_MATCH_SCOPE);

        assert.deepStrictEqual(state.matchNav.matches, []);
        assert.strictEqual(cell.classList.contains('active-match-cell'), false);
    });

    it('does not match the display-only BLOB placeholder', async () => {
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
        state.tableColumns = [{ name: 'payload', type: 'BLOB' }];
        state.gridData = [[new Uint8Array([0x42, 0x4c, 0x4f, 0x42])]];
        state.dateFormat = 'raw';
        state.filterQuery = 'blob';
        state.columnFilters = {};
        resetMatchNav();

        navigateMatches(GLOBAL_MATCH_SCOPE);

        assert.deepStrictEqual(state.matchNav.matches, []);
        assert.strictEqual(cell.classList.contains('active-match-cell'), false);
    });

    it('does not navigate to text after SQLite\'s NUL terminator', async () => {
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
        state.tableColumns = [{ name: 'payload', type: 'TEXT' }];
        state.gridData = [['abc\0needle']];
        state.dateFormat = 'raw';
        state.filterQuery = 'needle';
        state.columnFilters = {};
        resetMatchNav();

        navigateMatches(GLOBAL_MATCH_SCOPE);

        assert.deepStrictEqual(state.matchNav.matches, []);
        assert.strictEqual(cell.classList.contains('active-match-cell'), false);
    });

    it('does not highlight text after SQLite\'s NUL terminator', async () => {
        const children: any[] = [];
        (globalThis as any).document = {
            createTextNode(text: string) { return { textContent: text }; },
            createElement() { return { className: '', textContent: '' }; }
        };
        const utilsModulePath = '../../core/ui/modules/utils.js';
        const { appendHighlightedText, buildHighlightMatcher } = await import(utilsModulePath);
        const parent = { appendChild(child: any) { children.push(child); } };

        appendHighlightedText(parent, 'abc\0needle', buildHighlightMatcher(['needle']));

        assert.strictEqual(
            children.some(child => child.className === 'cell-highlight'),
            false
        );
        assert.strictEqual(children.map(child => child.textContent).join(''), 'abc\0needle');
    });

    it('matches SQLite REAL text coercion from the authoritative sidecar', async () => {
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
            { value: 1e20, sqliteText: '1.0e+20', term: '1.0e+20' },
            { value: 1e-7, sqliteText: '1.0e-07', term: '1.0e-07' },
            { value: 1e-5, sqliteText: '1.0e-05', term: '1.0e-05' },
            { value: 1, sqliteText: '1.0', term: '1.0' },
            {
                value: 9.652937795298495e282,
                sqliteText: '9.6529377952985e+282',
                term: '85e'
            }
        ];
        for (const testCase of cases) {
            state.gridData = [[testCase.value]];
            state.gridExactIntegerTexts = { 0: { 0: testCase.sqliteText } };
            state.filterQuery = testCase.term;
            resetMatchNav();

            navigateMatches(GLOBAL_MATCH_SCOPE);

            assert.deepStrictEqual(
                state.matchNav.matches,
                [{ rowIdx: 0, colIdx: 0 }],
                `${testCase.value} should match SQLite text ${testCase.term}`
            );
        }
    });

    it('does not guess a divergent SQLite REAL representation without a sidecar', async () => {
        (globalThis as any).document = {
            getElementById(id: string) {
                return id === 'filterMatchCounter' ? { textContent: '' } : null;
            },
            querySelectorAll() { return []; }
        };

        const stateModulePath = '../../core/ui/modules/state.js';
        const matchNavModulePath = '../../core/ui/modules/match-nav.js';
        const { state } = await import(stateModulePath);
        const { navigateMatches, resetMatchNav } = await import(matchNavModulePath);
        state.selectedTableType = 'view';
        state.tableColumns = [{ name: 'measurement', type: 'REAL' }];
        state.gridData = [[1e20]];
        state.gridExactIntegerTexts = {};
        state.filterQuery = '1.0e+20';
        state.columnFilters = {};
        resetMatchNav();

        navigateMatches(GLOBAL_MATCH_SCOPE);

        assert.deepStrictEqual(state.matchNav.matches, []);
    });

    it('does not synthesize a REAL match candidate for INTEGER cells', async () => {
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
            { name: 'n', type: 'INTEGER' },
            { name: 'text', type: 'TEXT' }
        ];
        state.gridData = [[1, '.']];
        state.filterQuery = '.';
        state.columnFilters = {};
        resetMatchNav();

        navigateMatches(GLOBAL_MATCH_SCOPE);

        assert.deepStrictEqual(state.matchNav.matches, [{ rowIdx: 0, colIdx: 1 }]);
    });

    it('uses exact transported text for an unsafe INTEGER match and highlight', async () => {
        const textSpan = {
            children: [] as any[],
            replaceChildren(...children: any[]) { this.children = children; },
            appendChild(child: any) { this.children.push(child); }
        };
        const cell = {
            classList: createClassList(),
            dataset: { rowidx: '0', colidx: '0' },
            scrollIntoView() {},
            querySelector(selector: string) {
                return selector === '.cell-text' ? textSpan : null;
            }
        };
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'cell-0-0') return cell;
                if (id === 'filterMatchCounter') return { textContent: '' };
                return null;
            },
            querySelectorAll(selector: string) {
                return selector === '.active-match-cell'
                    && cell.classList.contains('active-match-cell') ? [cell] : [];
            },
            createTextNode(text: string) { return { textContent: text }; },
            createElement(tag: string) {
                return { tag, className: '', textContent: '' };
            }
        };

        const stateModulePath = '../../core/ui/modules/state.js';
        const matchNavModulePath = '../../core/ui/modules/match-nav.js';
        const { state } = await import(stateModulePath);
        const { navigateMatches, resetMatchNav } = await import(matchNavModulePath);
        const originalState = {
            selectedTableType: state.selectedTableType,
            tableColumns: state.tableColumns,
            gridData: state.gridData,
            gridExactIntegerTexts: state.gridExactIntegerTexts,
            filterQuery: state.filterQuery,
            columnFilters: state.columnFilters,
            matchNav: state.matchNav
        };

        try {
            state.selectedTableType = 'view';
            state.tableColumns = [{ name: 'value', type: 'INTEGER' }];
            // This is the rounded Number that the existing UI continues to render.
            state.gridData = [[9007199254740992]];
            state.gridExactIntegerTexts = { 0: { 0: '9007199254740993' } };
            state.filterQuery = '993';
            state.columnFilters = {};
            resetMatchNav();

            navigateMatches(GLOBAL_MATCH_SCOPE);

            assert.deepStrictEqual(state.matchNav.matches, [{ rowIdx: 0, colIdx: 0 }]);
            const renderedText = textSpan.children.map(child => child.textContent).join('');
            assert.strictEqual(renderedText, '9007199254740993');
            assert.ok(textSpan.children.some(child => (
                child.className === 'cell-highlight' && child.textContent === '993'
            )));
        } finally {
            Object.assign(state, originalState);
            resetMatchNav();
        }
    });

    it('does not navigate a match found only in the hidden table rowid', async () => {
        (globalThis as any).document = {
            getElementById(id: string) {
                return id === 'filterMatchCounter' ? { textContent: '' } : null;
            },
            querySelectorAll() { return []; }
        };

        const stateModulePath = '../../core/ui/modules/state.js';
        const matchNavModulePath = '../../core/ui/modules/match-nav.js';
        const { state } = await import(stateModulePath);
        const { navigateMatches, resetMatchNav } = await import(matchNavModulePath);
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'value', type: 'TEXT' }];
        state.gridData = [[12, 'visible text']];
        state.filterQuery = '12';
        state.columnFilters = {};
        resetMatchNav();

        navigateMatches(GLOBAL_MATCH_SCOPE);

        assert.deepStrictEqual(state.matchNav.matches, []);
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
            navigateMatches(GLOBAL_MATCH_SCOPE);

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

    it('restarts navigation in rendered column order after a pin toggle', async () => {
        const focusedCells: string[] = [];
        const cells = new Map<string, any>();
        for (let colIdx = 0; colIdx < 3; colIdx++) {
            const id = `cell-0-${colIdx}`;
            cells.set(id, {
                classList: createClassList(),
                scrollIntoView() { focusedCells.push(id); }
            });
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
        const gridActionsModulePath = '../../core/ui/modules/grid-actions.js';
        const { state } = await import(stateModulePath);
        const { navigateMatches, resetMatchNav } = await import(matchNavModulePath);
        const { toggleColumnPin } = await import(gridActionsModulePath);
        state.selectedTableType = 'view';
        state.tableColumns = [
            { name: 'first', type: 'TEXT' },
            { name: 'second', type: 'TEXT' },
            { name: 'third', type: 'TEXT' }
        ];
        state.gridData = [['hit first', 'hit second', 'hit third']];
        state.filterQuery = 'hit';
        state.columnFilters = {};
        state.pinnedColumns.clear();
        state.pinnedRowIds.clear();
        resetMatchNav();

        try {
            navigateMatches(GLOBAL_MATCH_SCOPE);
            toggleColumnPin({ stopPropagation() {} }, 'third');
            navigateMatches(GLOBAL_MATCH_SCOPE);

            assert.deepStrictEqual(focusedCells, ['cell-0-0', 'cell-0-2']);
        } finally {
            state.pinnedColumns.clear();
            resetMatchNav();
        }
    });

    it('restarts navigation in rendered row order after a pin toggle', async () => {
        const focusedCells: string[] = [];
        const cells = new Map<string, any>();
        for (let rowIdx = 0; rowIdx < 3; rowIdx++) {
            const id = `cell-${rowIdx}-0`;
            cells.set(id, {
                classList: createClassList(),
                scrollIntoView() { focusedCells.push(id); }
            });
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
        const gridActionsModulePath = '../../core/ui/modules/grid-actions.js';
        const { state } = await import(stateModulePath);
        const { navigateMatches, resetMatchNav } = await import(matchNavModulePath);
        const { toggleRowPin } = await import(gridActionsModulePath);
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'value', type: 'TEXT' }];
        state.gridData = [
            [1, 'hit first'],
            [2, 'hit second'],
            [3, 'hit third']
        ];
        state.filterQuery = 'hit';
        state.columnFilters = {};
        state.pinnedColumns.clear();
        state.pinnedRowIds.clear();
        resetMatchNav();

        try {
            navigateMatches(GLOBAL_MATCH_SCOPE);
            toggleRowPin({ stopPropagation() {} }, 3);
            navigateMatches(GLOBAL_MATCH_SCOPE);

            assert.deepStrictEqual(focusedCells, ['cell-0-0', 'cell-2-0']);
        } finally {
            state.pinnedRowIds.clear();
            resetMatchNav();
        }
    });
});
