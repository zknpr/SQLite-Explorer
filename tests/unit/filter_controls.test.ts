import './vscode_mock_setup';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { createDeferred } from './helpers/deferred';

const stateModulePath = '../../core/ui/modules/state.js';
const apiModulePath = '../../core/ui/modules/api.js';
const gridActionsModulePath = '../../core/ui/modules/grid-actions.js';
const gridDataModulePath = '../../core/ui/modules/grid-data.js';
const gridEventsModulePath = '../../core/ui/modules/grid-events.js';
const globalShortcutsModulePath = '../../core/ui/modules/global-shortcuts.js';
const matchNavModulePath = '../../core/ui/modules/match-nav.js';
let fakeTimerId = 1000;

function createClassList(initial: string[] = []) {
    const classes = new Set(initial);
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

function createInput(value: string, column?: string) {
    const clearButton = { hidden: value.length === 0 };
    const wrap = {
        querySelector(selector: string) {
            return selector === '.filter-clear-btn' ? clearButton : null;
        }
    };
    const input: any = {
        tagName: 'INPUT',
        value,
        dataset: column === undefined ? {} : { column },
        disabled: false,
        classList: createClassList(column === undefined ? ['filter-input'] : ['column-filter']),
        clearButton,
        focusCount: 0,
        focus() {
            input.focusCount++;
            (globalThis as any).document.activeElement = input;
        },
        setSelectionRange(start: number, end: number) {
            input.selectionStart = start;
            input.selectionEnd = end;
        },
        closest(selector: string) {
            return selector.includes('filter-input-wrap') || selector.includes('column-filter-wrap')
                ? wrap
                : null;
        }
    };
    return input;
}

function createButton() {
    const listeners = new Map<string, (event: any) => any>();
    return {
        disabled: false,
        hidden: false,
        addEventListener(type: string, listener: (event: any) => any) {
            listeners.set(type, listener);
        },
        dispatch(type: string, event: any = {}) {
            return listeners.get(type)?.(event);
        }
    };
}

function installTimerHarness({ virtualTime = false } = {}) {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalDateNow = Date.now;
    const timers = new Map<number, { delay: number; callback: () => any }>();
    let now = originalDateNow();

    if (virtualTime) Date.now = () => now;

    (globalThis as any).setTimeout = (callback: () => any, delay = 0) => {
        const id = fakeTimerId++;
        timers.set(id, { delay: Number(delay), callback });
        return id;
    };
    (globalThis as any).clearTimeout = (id: number) => {
        timers.delete(id);
    };

    function take(delay: number) {
        const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
        assert.ok(entry, `expected an active ${delay} ms timer`);
        timers.delete(entry[0]);
        return entry[1].callback;
    }

    return {
        delays() {
            return [...timers.values()].map(timer => timer.delay);
        },
        start(delay: number) {
            if (virtualTime) now += delay;
            return Promise.resolve(take(delay)());
        },
        async run(delay: number) {
            if (virtualTime) now += delay;
            await take(delay)();
        },
        restore() {
            globalThis.setTimeout = originalSetTimeout;
            globalThis.clearTimeout = originalClearTimeout;
            Date.now = originalDateNow;
        }
    };
}

function installFilterDocument(options: {
    globalValue?: string;
    columns?: Array<{ name: string; value: string }>;
    cells?: Map<string, any>;
} = {}) {
    const globalInput = createInput(options.globalValue ?? '');
    const columnInputs = (options.columns ?? []).map(({ name, value }) => createInput(value, name));
    const globalClearButton = createButton();
    globalClearButton.hidden = globalInput.value.length === 0;
    globalInput.clearButton = globalClearButton;
    const elements: Record<string, any> = {
        filterInput: globalInput,
        btnClearFilter: globalClearButton,
        btnApplyFilter: createButton(),
        pageIndicator: { textContent: '' },
        btnFirst: createButton(),
        btnPrev: createButton(),
        btnNext: createButton(),
        btnLast: createButton(),
        statusText: { textContent: '' },
        filterMatchCounter: { textContent: '' },
        pageSizeSelect: createButton(),
        dateFormatSelect: createButton()
    };
    const documentListeners = new Map<string, (event: any) => any>();
    const containerListeners = new Map<string, (event: any) => any>();
    const gridContainer = {
        scrollLeft: 0,
        scrollTop: 0,
        querySelector() { return null; },
        addEventListener(type: string, listener: (event: any) => any) {
            containerListeners.set(type, listener);
        }
    };
    elements.gridContainer = gridContainer;

    (globalThis as any).document = {
        activeElement: null,
        getElementById(id: string) {
            return options.cells?.get(id) ?? elements[id] ?? null;
        },
        querySelectorAll(selector: string) {
            if (selector === '.column-filter') return columnInputs;
            return [];
        },
        querySelector(selector: string) {
            if (selector === '.modal-overlay:not(.hidden)') return null;
            return null;
        },
        addEventListener(type: string, listener: (event: any) => any) {
            documentListeners.set(type, listener);
        }
    };

    return { globalInput, columnInputs, elements, documentListeners, containerListeners };
}

async function prepareState(columns: Array<{ name: string; type: string }>) {
    const { state } = await import(stateModulePath);
    state.selectedTable = 'items';
    state.selectedTableType = 'view';
    state.renderedTable = null;
    state.tableColumns = columns;
    state.gridData = [];
    state.currentPageIndex = 0;
    state.rowsPerPage = 500;
    state.totalPageCount = 1;
    state.columnFilters = {};
    state.filterQuery = '';
    state.isGridReloading = false;
    state.isLoadingData = false;
    state.editingCellInfo = { rowIdx: 0, colIdx: 0 };
    state.matchNav = { scope: null, term: null, matches: [], currentIndex: -1 };
    state.filterTimer = null;
    state.filterApplyPending = false;
    state.filterApplyTable = null;
    state.filterPendingAction = null;
    return state;
}

describe('filter controls', () => {
    afterEach(async () => {
        delete (globalThis as any).document;
        const { state } = await import(stateModulePath);
        if (state.filterTimer !== null) clearTimeout(state.filterTimer);
        state.filterTimer = null;
        state.filterApplyPending = false;
        state.filterApplyTable = null;
        state.filterPendingAction = null;
        state.selectedTable = null;
        state.gridData = [];
        state.tableColumns = [];
        state.columnFilters = {};
        state.filterQuery = '';
        state.editingCellInfo = null;
        state.isGridReloading = false;
        state.isLoadingData = false;
        state.selectedCells = [];
        state.selectedRowIds.clear();
        state.selectedColumns.clear();
        state.lastSelectedCell = null;
    });

    it('captures every filter draft immediately and auto-applies once after 300 ms', async () => {
        const timers = installTimerHarness();
        const { globalInput, columnInputs } = installFilterDocument({
            globalValue: '   ',
            columns: [
                { name: 'first', value: 'alpha' },
                { name: 'second', value: 'beta' }
            ]
        });
        const state = await prepareState([
            { name: 'first', type: 'TEXT' },
            { name: 'second', type: 'TEXT' }
        ]);
        const { backendApi } = await import(apiModulePath);
        const originalFetchCount = backendApi.fetchTableCount;
        const originalFetchData = backendApi.fetchTableData;
        const countOptions: any[] = [];
        const dataOptions: any[] = [];
        backendApi.fetchTableCount = async (_table: string, options: any) => {
            countOptions.push(options);
            return 1;
        };
        backendApi.fetchTableData = async (_table: string, options: any) => {
            dataOptions.push(options);
            return { rows: [['alpha', 'beta']] };
        };

        try {
            const { onFilterInput } = await import(gridActionsModulePath);
            onFilterInput({ target: columnInputs[0], isComposing: false });

            columnInputs[0].value = 'alpha latest';
            onFilterInput({ target: columnInputs[0], isComposing: false });

            assert.strictEqual(state.filterQuery, '   ');
            assert.deepStrictEqual(state.columnFilters, { first: 'alpha latest', second: 'beta' });
            assert.deepStrictEqual(timers.delays(), [300]);
            assert.strictEqual(countOptions.length, 0);

            await timers.run(300);

            assert.strictEqual(countOptions.length, 1);
            assert.strictEqual(dataOptions.length, 1);
            assert.strictEqual(countOptions[0].globalFilter, undefined);
            assert.deepStrictEqual(countOptions[0].filters, [
                { column: 'first', value: 'alpha latest' },
                { column: 'second', value: 'beta' }
            ]);
            assert.strictEqual(globalInput.clearButton.hidden, false);
        } finally {
            backendApi.fetchTableCount = originalFetchCount;
            backendApi.fetchTableData = originalFetchData;
            timers.restore();
        }
    });

    it('applies a successor immediately when the filter changes during a reload', async () => {
        const timers = installTimerHarness();
        const { globalInput, columnInputs } = installFilterDocument({
            columns: [{ name: 'value', value: 'first' }]
        });
        const state = await prepareState([{ name: 'value', type: 'TEXT' }]);
        const { backendApi } = await import(apiModulePath);
        const originalFetchCount = backendApi.fetchTableCount;
        const originalFetchData = backendApi.fetchTableData;
        const firstCount = createDeferred<number>();
        const firstCountStarted = createDeferred<void>();
        const seenFilters: string[] = [];
        const seenDataFilters: string[] = [];
        let countCall = 0;
        backendApi.fetchTableCount = async (_table: string, options: any) => {
            seenFilters.push(options.filters[0]?.value ?? '');
            countCall++;
            if (countCall === 1) firstCountStarted.resolve();
            return countCall === 1 ? firstCount.promise : 1;
        };
        backendApi.fetchTableData = async (_table: string, options: any) => {
            const filter = options.filters[0]?.value ?? '';
            seenDataFilters.push(filter);
            return { rows: [[filter]] };
        };

        try {
            const { onFilterInput } = await import(gridActionsModulePath);
            onFilterInput({ target: columnInputs[0], isComposing: false });
            const firstApply = timers.start(300);
            await firstCountStarted.promise;
            assert.strictEqual(state.isGridReloading, true);

            columnInputs[0].value = 'latest';
            onFilterInput({ target: columnInputs[0], isComposing: false });
            assert.strictEqual(state.columnFilters.value, 'latest');
            assert.strictEqual(columnInputs[0].disabled, false);

            firstCount.resolve(1);
            await firstApply;
            assert.strictEqual(
                columnInputs[0].focusCount >= 1,
                true,
                'the rebuilt input must regain focus before the successor reload'
            );

            assert.deepStrictEqual(seenFilters, ['first', 'latest']);
            assert.deepStrictEqual(seenDataFilters, ['first', 'latest']);
            assert.deepStrictEqual(state.gridData, [['latest']]);
            assert.strictEqual(state.filterTimer, null);
            assert.strictEqual(
                timers.delays().some(delay => delay === 300 || delay === 50),
                false,
                'the successor must not remain behind a debounce or reload-retry timer'
            );
            assert.strictEqual(state.isGridReloading, false);
            assert.strictEqual(globalInput.value, '');
        } finally {
            backendApi.fetchTableCount = originalFetchCount;
            backendApi.fetchTableData = originalFetchData;
            timers.restore();
        }
    });

    it('keeps a queued filter when a newer grid reload takes ownership after the legacy retry budget', async () => {
        const timers = installTimerHarness();
        const { globalInput, elements } = installFilterDocument({ globalValue: 'needle' });
        const state = await prepareState([{ name: 'value', type: 'TEXT' }]);
        const { backendApi } = await import(apiModulePath);
        const { loadTableData } = await import(gridDataModulePath);
        const originalFetchCount = backendApi.fetchTableCount;
        const originalFetchData = backendApi.fetchTableData;
        const firstCount = createDeferred<number>();
        const secondCount = createDeferred<number>();
        let countCalls = 0;
        backendApi.fetchTableCount = async () => {
            countCalls++;
            if (countCalls === 1) return firstCount.promise;
            if (countCalls === 2) return secondCount.promise;
            return 1;
        };
        backendApi.fetchTableData = async () => ({ rows: [['needle']] });
        let firstLoad: Promise<unknown> | undefined;
        let secondLoad: Promise<unknown> | undefined;

        try {
            firstLoad = loadTableData(false, false);
            assert.strictEqual(state.isGridReloading, true);

            const { onFilterInput } = await import(gridActionsModulePath);
            onFilterInput({ target: globalInput, isComposing: false });
            await timers.run(300);

            // Exhaust all but the last slot in the former shared 100-attempt
            // budget while the first load owns the guard.
            for (let attempt = 0; attempt < 99; attempt++) {
                await timers.run(50);
            }

            // A newer load owns a fresh wait window. The next retry must observe
            // that owner instead of exhausting budget inherited from the old one.
            secondLoad = loadTableData(false, false);
            await timers.run(50);

            assert.strictEqual(state.filterApplyPending, true);
            assert.ok(timers.delays().includes(50));
            assert.doesNotMatch(elements.statusText.textContent, /not applied|failed/i);

            secondCount.resolve(1);
            await secondLoad;
            await timers.run(50);

            assert.strictEqual(state.filterApplyPending, false);
            assert.strictEqual(state.filterApplyTable, null);
            assert.deepStrictEqual(state.gridData, [['needle']]);
        } finally {
            firstCount.resolve(1);
            secondCount.resolve(1);
            await firstLoad;
            await secondLoad;
            backendApi.fetchTableCount = originalFetchCount;
            backendApi.fetchTableData = originalFetchData;
            timers.restore();
        }
    });

    it('bounds a stuck reload wait while retaining the filter draft for the next reload', async () => {
        const timers = installTimerHarness({ virtualTime: true });
        const { globalInput, elements } = installFilterDocument({ globalValue: 'needle' });
        const state = await prepareState([{ name: 'value', type: 'TEXT' }]);
        state.isGridReloading = true;

        try {
            const { onFilterInput } = await import(gridActionsModulePath);
            onFilterInput({ target: globalInput, isComposing: false });
            await timers.run(300);

            let retryCount = 0;
            while (timers.delays().includes(50) && retryCount < 3000) {
                await timers.run(50);
                retryCount++;
            }

            assert.ok(retryCount < 3000, 'reload waiting must have a finite deadline');
            assert.deepStrictEqual(timers.delays(), []);
            assert.strictEqual(state.filterApplyPending, false);
            assert.strictEqual(state.filterApplyTable, null);
            assert.strictEqual(state.filterPendingAction, null);
            assert.strictEqual(state.filterQuery, 'needle');
            assert.strictEqual(globalInput.value, 'needle');
            assert.match(elements.statusText.textContent, /filter draft.*next grid reload/i);
        } finally {
            timers.restore();
        }
    });

    it('uses Shift+Enter for previous-match navigation from the filter and grid', async () => {
        const focused: string[] = [];
        const cells = new Map<string, any>([
            ['cell-0-0', { classList: createClassList(), scrollIntoView() { focused.push('cell-0-0'); } }],
            ['cell-1-0', { classList: createClassList(), scrollIntoView() { focused.push('cell-1-0'); } }]
        ]);
        const { globalInput, containerListeners } = installFilterDocument({
            globalValue: 'hit',
            cells
        });
        const state = await prepareState([{ name: 'value', type: 'TEXT' }]);
        state.filterQuery = 'hit';
        state.gridData = [['hit first'], ['hit second']];
        state.editingCellInfo = null;
        const { onFilterEnter } = await import(gridActionsModulePath);
        let filterPrevented = false;

        await onFilterEnter({
            key: 'Enter',
            shiftKey: true,
            isComposing: false,
            target: globalInput,
            preventDefault() { filterPrevented = true; }
        });

        assert.strictEqual(filterPrevented, true);
        assert.deepStrictEqual(focused, ['cell-1-0']);

        const { resetMatchNav } = await import(matchNavModulePath);
        resetMatchNav();
        const { initGridInteraction } = await import(gridEventsModulePath);
        initGridInteraction();
        const keydown = containerListeners.get('keydown');
        assert.ok(keydown, 'grid keydown listener was not registered');
        let gridPrevented = false;
        await keydown({
            key: 'Enter',
            shiftKey: true,
            isComposing: false,
            target: {
                classList: createClassList(),
                closest() { return null; }
            },
            preventDefault() { gridPrevented = true; }
        });

        assert.strictEqual(gridPrevented, true);
        assert.deepStrictEqual(focused, ['cell-1-0', 'cell-1-0']);

        let buttonPrevented = false;
        await keydown({
            key: 'Enter',
            shiftKey: false,
            isComposing: false,
            target: {
                tagName: 'BUTTON',
                classList: createClassList(),
                closest(selector: string) { return selector.includes('button') ? this : null; }
            },
            preventDefault() { buttonPrevented = true; }
        });
        assert.strictEqual(buttonPrevented, false, 'filter buttons must retain native keyboard activation');
    });

    it('clears a column filter immediately, applies it, and restores input focus', async () => {
        const timers = installTimerHarness();
        const { globalInput, columnInputs } = installFilterDocument({
            globalValue: 'global',
            columns: [{ name: 'value', value: 'needle' }]
        });
        const state = await prepareState([{ name: 'value', type: 'TEXT' }]);
        state.filterQuery = 'global';
        state.columnFilters = { value: 'needle' };
        const { backendApi } = await import(apiModulePath);
        const originalFetchCount = backendApi.fetchTableCount;
        const originalFetchData = backendApi.fetchTableData;
        const countOptions: any[] = [];
        backendApi.fetchTableCount = async (_table: string, options: any) => {
            countOptions.push(options);
            return 1;
        };
        backendApi.fetchTableData = async () => ({ rows: [['visible']] });

        try {
            const { clearColumnFilter } = await import(gridActionsModulePath);
            const pending = clearColumnFilter('value');

            assert.strictEqual(columnInputs[0].value, '');
            assert.deepStrictEqual(state.columnFilters, {});
            assert.strictEqual(columnInputs[0].focusCount >= 1, true);
            await pending;

            assert.strictEqual(countOptions.length, 1);
            assert.deepStrictEqual(countOptions[0].filters, []);
            assert.strictEqual(countOptions[0].globalFilter, 'global');
            assert.strictEqual(columnInputs[0].clearButton.hidden, true);
            assert.strictEqual(columnInputs[0].focusCount >= 2, true);

            const { clearGlobalFilter } = await import(gridActionsModulePath);
            await clearGlobalFilter();
            assert.strictEqual(globalInput.value, '');
            assert.strictEqual(state.filterQuery, '');
            assert.strictEqual(globalInput.clearButton.hidden, true);
            assert.strictEqual(globalInput.focusCount >= 2, true);
            assert.strictEqual(countOptions.length, 2);
            assert.strictEqual(countOptions[1].globalFilter, undefined);
        } finally {
            backendApi.fetchTableCount = originalFetchCount;
            backendApi.fetchTableData = originalFetchData;
            timers.restore();
        }
    });

    it('dismisses the active match on Escape only in grid/filter context without a modal', async () => {
        const activeCell = {
            dataset: {},
            classList: createClassList(['active-match-cell'])
        };
        const { documentListeners } = installFilterDocument();
        const documentObject: any = (globalThis as any).document;
        documentObject.querySelectorAll = (selector: string) =>
            selector === '.active-match-cell' ? [activeCell] : [];
        const state = await prepareState([{ name: 'value', type: 'TEXT' }]);
        state.matchNav = {
            scope: Symbol('active'),
            term: 'hit',
            matches: [{ rowIdx: 0, colIdx: 0 }],
            currentIndex: 0
        };
        state.editingCellInfo = null;
        state.lastSelectedCell = { rowIdx: 0, colIdx: 0 };
        const { setupGlobalShortcuts } = await import(globalShortcutsModulePath);
        setupGlobalShortcuts();
        const keydown = documentListeners.get('keydown');
        assert.ok(keydown, 'global keydown listener was not registered');

        await keydown({
            key: 'Escape',
            target: { tagName: 'BODY', closest() { return null; } }
        });
        assert.strictEqual(state.matchNav.currentIndex, -1);
        assert.strictEqual(activeCell.classList.contains('active-match-cell'), false);

        state.matchNav = {
            scope: Symbol('modal-active'),
            term: 'hit',
            matches: [{ rowIdx: 0, colIdx: 0 }],
            currentIndex: 0
        };
        documentObject.querySelector = (selector: string) =>
            selector.includes('.modal-overlay:not(.hidden)') ? {} : null;
        await keydown({
            key: 'Escape',
            target: { closest() { return {}; } }
        });
        assert.strictEqual(state.matchNav.currentIndex, 0);
    });

    it('navigates backward from the document shortcut after a non-focusable grid-cell click', async () => {
        const focused: string[] = [];
        const cells = new Map<string, any>([
            ['cell-0-0', { classList: createClassList(), scrollIntoView() { focused.push('cell-0-0'); } }],
            ['cell-1-0', { classList: createClassList(), scrollIntoView() { focused.push('cell-1-0'); } }]
        ]);
        const { documentListeners } = installFilterDocument({ globalValue: 'hit', cells });
        const state = await prepareState([{ name: 'value', type: 'TEXT' }]);
        state.editingCellInfo = null;
        state.filterQuery = 'hit';
        state.gridData = [['hit first'], ['hit second']];
        state.lastSelectedCell = { rowIdx: 0, colIdx: 0 };
        const { setupGlobalShortcuts } = await import(globalShortcutsModulePath);
        setupGlobalShortcuts();
        const keydown = documentListeners.get('keydown');
        assert.ok(keydown, 'global keydown listener was not registered');
        let prevented = false;

        await keydown({
            key: 'Enter',
            shiftKey: true,
            defaultPrevented: false,
            isComposing: false,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            target: { tagName: 'BODY', closest() { return null; } },
            preventDefault() { prevented = true; }
        });

        assert.strictEqual(prevented, true);
        assert.deepStrictEqual(focused, ['cell-1-0']);
    });
});
