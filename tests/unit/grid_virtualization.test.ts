import './vscode_mock_setup';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';

// Variable specifiers keep tsc from demanding declarations for the plain-JS
// webview modules (the established pattern in grid_data_match_nav.test.ts).
const stateModulePath = '../../core/ui/modules/state.js';
const gridRenderModulePath = '../../core/ui/modules/grid-render.js';
const gridSelectionModulePath = '../../core/ui/modules/grid-selection.js';
const matchNavModulePath = '../../core/ui/modules/match-nav.js';
const editModulePath = '../../core/ui/modules/edit.js';

const ROW = 26;
const HEADER = 52;

/**
 * A tree-shaped DOM fake rich enough for the virtualization paths: parented
 * children (so insertBefore/removeChild/isConnected behave like the real
 * thing), class matching for the selector queries the grid modules issue, and
 * measurable scroll/viewport fields. Deliberately throws on removeChild of a
 * non-child, mirroring the real DOM, so window bookkeeping bugs surface.
 */
class FakeNode {
    readonly tagName: string;
    children: FakeNode[] = [];
    parent: FakeNode | null = null;
    readonly style: Record<string, string> = {};
    readonly dataset: Record<string, any> = {};
    readonly attributes: Record<string, string> = {};
    className = '';
    id = '';
    title = '';
    ariaLabel = '';
    hidden = false;
    value = '';
    spellcheck = false;
    colSpan = 0;
    scrollLeft = 0;
    scrollTop = 0;
    clientHeight: number | undefined = undefined;
    private ownText = '';
    private html = '';
    __root = false;

    constructor(tagName: string) {
        this.tagName = tagName.toUpperCase();
    }

    get isConnected(): boolean {
        let node: FakeNode = this;
        while (node.parent) node = node.parent;
        return node.__root;
    }

    get textContent(): string {
        return this.ownText + this.children.map(child => child.textContent).join('');
    }

    set textContent(value: string) {
        this.ownText = value ?? '';
        this.detachChildren();
    }

    setOwnText(value: string) {
        this.ownText = value;
    }

    private detachChildren() {
        for (const child of this.children) child.parent = null;
        this.children.length = 0;
    }

    set innerHTML(value: string) {
        this.html = value;
        if (value === '') this.detachChildren();
    }

    get innerHTML() {
        return this.html;
    }

    get classList() {
        const self = this;
        return {
            add(...names: string[]) {
                const classes = new Set(self.classNames());
                names.forEach(name => classes.add(name));
                self.className = [...classes].join(' ');
            },
            remove(...names: string[]) {
                self.className = self.classNames().filter(name => !names.includes(name)).join(' ');
            },
            contains(name: string) {
                return self.classNames().includes(name);
            },
            toggle(name: string, force?: boolean) {
                const has = self.classNames().includes(name);
                const enable = force ?? !has;
                if (enable && !has) this.add(name);
                if (!enable && has) this.remove(name);
                return enable;
            }
        };
    }

    classNames(): string[] {
        return this.className.split(/\s+/).filter(Boolean);
    }

    setAttribute(name: string, value: string) {
        this.attributes[name] = value;
    }

    focus() {}
    addEventListener() {}
    removeEventListener() {}

    appendChild(child: FakeNode): FakeNode {
        if (child.tagName === '#FRAGMENT') {
            for (const grandchild of [...child.children]) this.appendChild(grandchild);
            child.children.length = 0;
            return child;
        }
        if (child.parent) child.parent.removeChild(child);
        child.parent = this;
        this.children.push(child);
        return child;
    }

    insertBefore(child: FakeNode, reference: FakeNode | null): FakeNode {
        if (reference === null) return this.appendChild(child);
        if (child.parent) child.parent.removeChild(child);
        const index = this.children.indexOf(reference);
        if (index < 0) throw new Error('insertBefore: reference is not a child');
        child.parent = this;
        this.children.splice(index, 0, child);
        return child;
    }

    removeChild(child: FakeNode): FakeNode {
        const index = this.children.indexOf(child);
        if (index < 0) throw new Error('removeChild: node is not a child');
        this.children.splice(index, 1);
        child.parent = null;
        return child;
    }

    replaceChildren(...nodes: FakeNode[]) {
        this.detachChildren();
        for (const node of nodes) this.appendChild(node);
    }

    querySelector(selector: string): FakeNode | null {
        return queryAll(this, selector)[0] ?? null;
    }

    querySelectorAll(selector: string): FakeNode[] {
        return queryAll(this, selector);
    }
}

/** Compound class selector matching ('.a.b'); descendant selectors → []. */
function queryAll(root: FakeNode, selector: string): FakeNode[] {
    if (selector.includes(' ') || !selector.startsWith('.')) return [];
    const wanted = selector.split('.').filter(Boolean);
    const results: FakeNode[] = [];
    const walk = (node: FakeNode) => {
        for (const child of node.children) {
            if (wanted.every(name => child.classNames().includes(name))) results.push(child);
            walk(child);
        }
    };
    walk(root);
    return results;
}

function findById(root: FakeNode, id: string): FakeNode | null {
    for (const child of root.children) {
        if (child.id === id) return child;
        const found = findById(child, id);
        if (found) return found;
    }
    return null;
}

function installGridDom(clientHeight: number | undefined) {
    const container = new FakeNode('div');
    container.__root = true;
    container.clientHeight = clientHeight;
    let createdElements = 0;
    const elements: Record<string, any> = {
        gridContainer: container,
        pageIndicator: new FakeNode('span'),
        btnFirst: new FakeNode('button'),
        btnPrev: new FakeNode('button'),
        btnNext: new FakeNode('button'),
        btnLast: new FakeNode('button'),
        statusText: new FakeNode('span'),
        filterMatchCounter: new FakeNode('span')
    };
    (globalThis as any).document = {
        createElement(tagName: string) {
            createdElements++;
            return new FakeNode(tagName);
        },
        createDocumentFragment() {
            return new FakeNode('#fragment');
        },
        createTextNode(text: string) {
            const node = new FakeNode('#text');
            node.setOwnText(text);
            return node;
        },
        getElementById(id: string) {
            return elements[id] ?? findById(container, id);
        },
        querySelectorAll(selector: string) {
            return queryAll(container, selector);
        },
        querySelector(selector: string) {
            return queryAll(container, selector)[0] ?? null;
        }
    };
    return { container, elements, createdCount: () => createdElements };
}

async function primeState(rowCount: number, options: {
    pageIndex?: number;
    needleRowIdx?: number;
} = {}) {
    const { state } = await import(stateModulePath);
    state.selectedTable = 'items';
    state.selectedTableType = 'table';
    state.renderedTable = 'items';
    state.isReadOnly = false;
    state.tableColumns = [
        { name: 'value', type: 'TEXT', isPrimaryKey: false, notnull: 0 }
    ];
    state.gridData = Array.from({ length: rowCount }, (_, i) => [
        i + 1,
        i === options.needleRowIdx ? 'needle-target' : `v${i}`
    ]);
    state.gridExactIntegerTexts = {};
    state.gridOversizedCells = {};
    state.gridReadOnlyRowReasons = {};
    state.currentPageIndex = options.pageIndex ?? 0;
    state.rowsPerPage = Math.max(rowCount, 500);
    state.totalPageCount = 1;
    state.columnWidths = {};
    state.columnFilters = {};
    state.filterQuery = '';
    state.sortedColumn = null;
    state.selectedCells = [];
    state.selectedRowIds.clear();
    state.selectedColumns.clear();
    state.pinnedColumns.clear();
    state.pinnedRowIds.clear();
    state.editingCellInfo = null;
    state.activeCellInput = null;
    state.isGridReloading = false;
    state.isLoadingData = false;
    state.scrollPosition = { top: 0, left: 0 };
    state.matchNav = { scope: null, term: null, matches: [], currentIndex: -1 };
    return state;
}

function dataRows(container: FakeNode): FakeNode[] {
    return queryAll(container, '.data-row');
}

function spacers(container: FakeNode): FakeNode[] {
    return queryAll(container, '.virtual-spacer');
}

function tbodyOf(container: FakeNode): FakeNode {
    const table = container.children[0];
    return table.children[1];
}

describe('grid row virtualization', () => {
    afterEach(async () => {
        // Drop the module-level window metadata before removing the document:
        // a render with no gridContainer resets it and bails immediately.
        const { renderDataGrid } = await import(gridRenderModulePath);
        (globalThis as any).document = { getElementById: () => null };
        renderDataGrid();
        delete (globalThis as any).document;
        const { state } = await import(stateModulePath);
        state.selectedTable = null;
        state.gridData = [];
        state.tableColumns = [];
        state.columnWidths = {};
        state.selectedCells = [];
        state.selectedRowIds.clear();
        state.pinnedRowIds.clear();
        state.pinnedColumns.clear();
        state.columnFilters = {};
        state.editingCellInfo = null;
        state.activeCellInput = null;
        state.matchNav = { scope: null, term: null, matches: [], currentIndex: -1 };
    });

    describe('window math', () => {
        it('computes visible row ranges under sticky header and pinned-row occlusion', async () => {
            const { computeVisibleRowRange } = await import(gridRenderModulePath);
            // 520px viewport: 468px of usable band below the 52px header.
            assert.deepStrictEqual(
                computeVisibleRowRange(0, 520, 0, 2500), { first: 0, last: 17 }
            );
            assert.deepStrictEqual(
                computeVisibleRowRange(10 * ROW, 520, 0, 2500), { first: 10, last: 27 }
            );
            // Two pinned rows occlude two more row slots at the top of the band.
            assert.deepStrictEqual(
                computeVisibleRowRange(10 * ROW, 520, 2, 2500), { first: 10, last: 25 }
            );
            // Clamped to the page at both ends.
            assert.deepStrictEqual(
                computeVisibleRowRange(1e9, 520, 0, 2500), { first: 2499, last: 2499 }
            );
            // Degenerate viewport smaller than the header: still one row.
            assert.deepStrictEqual(
                computeVisibleRowRange(0, 40, 0, 2500), { first: 0, last: 0 }
            );
        });

        it('plans full renders for unknown viewports and small pages, windows otherwise', async () => {
            const {
                planVirtualRowWindow, VIRTUAL_ROW_OVERSCAN
            } = await import(gridRenderModulePath);
            assert.strictEqual(planVirtualRowWindow(0, null, 0, 2500), null);
            assert.strictEqual(planVirtualRowWindow(0, 0, 0, 2500), null);
            // 520px viewport → 20 gross viewport rows → threshold ceil(20*1.5)=30.
            assert.strictEqual(planVirtualRowWindow(0, 520, 0, 30), null);
            assert.deepStrictEqual(
                planVirtualRowWindow(0, 520, 0, 31),
                { start: 0, end: 31 }
            );
            assert.deepStrictEqual(
                planVirtualRowWindow(0, 520, 0, 2500),
                { start: 0, end: 18 + VIRTUAL_ROW_OVERSCAN }
            );
            // Mid-page: overscan applied on both sides of the visible range.
            assert.deepStrictEqual(
                planVirtualRowWindow(1250 * ROW, 520, 0, 2500),
                { start: 1250 - VIRTUAL_ROW_OVERSCAN, end: 1268 + VIRTUAL_ROW_OVERSCAN }
            );
            // Last page edge: end clamps to the page.
            assert.deepStrictEqual(
                planVirtualRowWindow(2499 * ROW, 520, 0, 2500),
                { start: 2499 - VIRTUAL_ROW_OVERSCAN, end: 2500 }
            );
        });

        it('re-renders only when the visible range drifts near a movable window edge', async () => {
            const { virtualWindowNeedsUpdate } = await import(gridRenderModulePath);
            // Freshly centered window: full overscan slack on both sides.
            assert.strictEqual(virtualWindowNeedsUpdate(1230, 1288, 1250, 1267, 2500), false);
            // Coverage broken (fast fling) always updates.
            assert.strictEqual(virtualWindowNeedsUpdate(1230, 1288, 1200, 1217, 2500), true);
            assert.strictEqual(virtualWindowNeedsUpdate(1230, 1288, 1280, 1297, 2500), true);
            // Drift within the trigger distance of an edge that has more rows.
            assert.strictEqual(virtualWindowNeedsUpdate(1230, 1288, 1235, 1252, 2500), true);
            assert.strictEqual(virtualWindowNeedsUpdate(1230, 1288, 1262, 1279, 2500), true);
            // At the page's physical edges there is nothing more to materialize.
            assert.strictEqual(virtualWindowNeedsUpdate(0, 58, 0, 17, 2500), false);
            assert.strictEqual(virtualWindowNeedsUpdate(2442, 2500, 2482, 2499, 2500), false);
        });
    });

    describe('windowed rendering', () => {
        it('materializes only the window plus spacers whose heights preserve scroll geometry', async () => {
            const { container } = installGridDom(520);
            await primeState(2500, { pageIndex: 2 });
            const { renderDataGrid, getVirtualWindowBounds } = await import(gridRenderModulePath);

            renderDataGrid(0, 0);

            const bounds = getVirtualWindowBounds();
            assert.deepStrictEqual(bounds, { start: 0, end: 38 });
            const rows = dataRows(container);
            assert.strictEqual(rows.length, 38);
            assert.strictEqual(rows[0].id, 'row-0');
            assert.strictEqual(rows[37].id, 'row-37');
            // Row numbers still derive from the page offset (page 2 × 2500 rows/page).
            assert.strictEqual(rows[0].children[0].textContent.startsWith('5001'), true);

            const [top, bottom] = spacers(container);
            assert.strictEqual(top.children[0].style.height, '0px');
            assert.strictEqual(bottom.children[0].style.height, `${(2500 - 38) * ROW}px`);
            // Spacers sandwich the window inside the tbody.
            const tbody = tbodyOf(container);
            assert.strictEqual(tbody.children[0], top);
            assert.strictEqual(tbody.children[tbody.children.length - 1], bottom);

            // Zebra stripes derive from the display ordinal, not DOM parity.
            assert.strictEqual(rows[0].classList.contains('stripe-even'), false);
            assert.strictEqual(rows[1].classList.contains('stripe-even'), true);

            // Unmaterialized rows are absent, not hidden.
            assert.strictEqual((globalThis as any).document.getElementById('row-2000'), null);
        });

        it('renders small pages fully with no spacers and an inert scroll hook', async () => {
            const { container } = installGridDom(520);
            await primeState(20);
            const {
                renderDataGrid, getVirtualWindowBounds, scheduleVirtualGridUpdate
            } = await import(gridRenderModulePath);

            renderDataGrid(0, 0);

            assert.strictEqual(getVirtualWindowBounds(), null);
            assert.strictEqual(spacers(container).length, 0);
            assert.strictEqual(dataRows(container).length, 20);
            // Scroll revalidation is a no-op without a window.
            container.scrollTop = 300;
            scheduleVirtualGridUpdate();
            assert.strictEqual(dataRows(container).length, 20);
            // Stripe classes match the old :nth-child(even) parity on full renders too.
            const rows = dataRows(container);
            assert.strictEqual(rows[1].classList.contains('stripe-even'), true);
            assert.strictEqual(rows[2].classList.contains('stripe-even'), false);
        });

        it('always materializes pinned rows ahead of the windowed slice', async () => {
            const { container } = installGridDom(520);
            const state = await primeState(2500);
            state.pinnedRowIds.add(1201); // rowid of data row 1200
            const { renderDataGrid, getVirtualWindowBounds } = await import(gridRenderModulePath);

            renderDataGrid(0, 0);

            const pinnedRow = (globalThis as any).document.getElementById('row-1200');
            assert.ok(pinnedRow, 'pinned row is materialized even far outside the window');
            assert.strictEqual(pinnedRow.classList.contains('pinned'), true);
            assert.strictEqual(pinnedRow.style.top, `${HEADER}px`);
            const tbody = tbodyOf(container);
            assert.strictEqual(tbody.children[0], pinnedRow);
            assert.strictEqual(tbody.children[1].classList.contains('virtual-spacer'), true);
            // One occluding pinned row shrinks the visible band by one row slot.
            assert.deepStrictEqual(getVirtualWindowBounds(), { start: 0, end: 37 });
            // Display ordinal 0 is the pinned row; the first unpinned row stripes.
            const firstUnpinned = (globalThis as any).document.getElementById('row-0');
            assert.strictEqual(firstUnpinned.classList.contains('stripe-even'), true);
        });
    });

    describe('scroll revalidation', () => {
        it('re-centers the window on large scrolls and reuses overlapping rows', async () => {
            const { container } = installGridDom(520);
            await primeState(2500);
            const {
                renderDataGrid, getVirtualWindowBounds, scheduleVirtualGridUpdate
            } = await import(gridRenderModulePath);

            renderDataGrid(0, 0);
            container.scrollTop = 1250 * ROW;
            scheduleVirtualGridUpdate(); // no requestAnimationFrame here → synchronous

            assert.deepStrictEqual(getVirtualWindowBounds(), { start: 1230, end: 1288 });
            const doc = (globalThis as any).document;
            assert.strictEqual(doc.getElementById('row-0'), null);
            assert.ok(doc.getElementById('row-1230'));
            assert.ok(doc.getElementById('row-1287'));
            const [top, bottom] = spacers(container);
            assert.strictEqual(top.children[0].style.height, `${1230 * ROW}px`);
            assert.strictEqual(bottom.children[0].style.height, `${(2500 - 1288) * ROW}px`);

            // A one-row drift stays inside the hysteresis band: no rebuild, and
            // the same elements stay mounted.
            const before = doc.getElementById('row-1250');
            container.scrollTop += ROW;
            scheduleVirtualGridUpdate();
            assert.deepStrictEqual(getVirtualWindowBounds(), { start: 1230, end: 1288 });
            assert.strictEqual(doc.getElementById('row-1250'), before);

            // Drifting near the bottom edge re-centers; overlapping rows are
            // reused by identity rather than rebuilt.
            const reused = doc.getElementById('row-1265');
            container.scrollTop = (1250 + 15) * ROW;
            scheduleVirtualGridUpdate();
            assert.deepStrictEqual(getVirtualWindowBounds(), { start: 1245, end: 1303 });
            assert.strictEqual(doc.getElementById('row-1265'), reused);
            assert.strictEqual(doc.getElementById('row-1235'), null);
            assert.ok(doc.getElementById('row-1300'));
        });

        it('applies identity-keyed selection to rows that materialize after the fact', async () => {
            const { container } = installGridDom(520);
            const state = await primeState(2500);
            const { renderDataGrid, scheduleVirtualGridUpdate } = await import(gridRenderModulePath);
            const { updateSelectionStates } = await import(gridSelectionModulePath);

            renderDataGrid(0, 0);

            // Select a row range and a cell that both extend past the window.
            for (let i = 10; i <= 50; i++) state.selectedRowIds.add(i + 1);
            state.selectedCells = [{ rowIdx: 45, colIdx: 0, rowId: 46, value: 'v45' }];
            updateSelectionStates();

            const doc = (globalThis as any).document;
            assert.strictEqual(doc.getElementById('row-10').classList.contains('selected'), true);
            assert.strictEqual(doc.getElementById('row-45'), null, 'row 45 starts unmaterialized');

            container.scrollTop = 40 * ROW;
            scheduleVirtualGridUpdate();

            const revealed = doc.getElementById('row-45');
            assert.ok(revealed, 'row 45 materialized after scrolling');
            assert.strictEqual(revealed.classList.contains('selected'), true);
            assert.strictEqual(
                doc.getElementById('cell-45-0').classList.contains('cell-selected'),
                true
            );
            assert.strictEqual(doc.getElementById('row-50').classList.contains('selected'), true);
            assert.strictEqual(doc.getElementById('row-51').classList.contains('selected'), false);
        });
    });

    describe('reveal and edit integration', () => {
        it('materializes and highlights a match navigation target outside the window', async () => {
            const { container } = installGridDom(520);
            const state = await primeState(2500, { needleRowIdx: 2000 });
            state.columnFilters = { value: 'needle-target' };
            const { renderDataGrid, getVirtualWindowBounds } = await import(gridRenderModulePath);
            const { navigateMatches } = await import(matchNavModulePath);

            renderDataGrid(0, 0);
            assert.strictEqual(
                (globalThis as any).document.getElementById('cell-2000-0'),
                null,
                'match target starts unmaterialized'
            );

            navigateMatches('value', 1);

            assert.deepStrictEqual(state.matchNav.matches, [{ rowIdx: 2000, colIdx: 0 }]);
            const bounds = getVirtualWindowBounds();
            assert.ok(bounds, 'window still active');
            assert.ok(
                bounds!.start <= 2000 && 2000 < bounds!.end,
                `window [${bounds!.start}, ${bounds!.end}) covers the match row`
            );
            const cell = (globalThis as any).document.getElementById('cell-2000-0');
            assert.ok(cell, 'match cell materialized by navigation');
            assert.strictEqual(cell.classList.contains('active-match-cell'), true);
            assert.ok(container.scrollTop > 0, 'the container scrolled toward the match');
            const counter = queryAll(container, '.column-filter-counter')
                .find(el => el.dataset.column === 'value');
            assert.strictEqual(counter?.textContent, '1/1');
        });

        it('freezes the window while an inline edit is active and catches up afterwards', async () => {
            const { container } = installGridDom(520);
            const state = await primeState(2500);
            const {
                renderDataGrid, getVirtualWindowBounds, scheduleVirtualGridUpdate
            } = await import(gridRenderModulePath);
            const { startCellEdit, cancelCellEdit } = await import(editModulePath);

            renderDataGrid(0, 0);
            startCellEdit(5, 0, 6);

            assert.ok(state.editingCellInfo, 'edit session started');
            const doc = (globalThis as any).document;
            const editor = doc.getElementById('cell-5-0').children[0];
            assert.strictEqual(editor.className, 'cell-input');

            // Scrolling far away must NOT dematerialize the editing row.
            container.scrollTop = 1250 * ROW;
            scheduleVirtualGridUpdate();
            assert.deepStrictEqual(getVirtualWindowBounds(), { start: 0, end: 38 });
            assert.strictEqual(doc.getElementById('cell-5-0').children[0], editor);
            assert.ok(state.editingCellInfo, 'edit session survived the scroll');

            // Ending the edit releases the freeze and the window catches up to
            // the live scroll position.
            cancelCellEdit();
            assert.strictEqual(state.editingCellInfo, null);
            assert.deepStrictEqual(getVirtualWindowBounds(), { start: 1230, end: 1288 });
            assert.strictEqual(doc.getElementById('row-5'), null);
        });

        it('does not let a leaked edit session with dead editor DOM freeze the window', async () => {
            const { container } = installGridDom(520);
            const state = await primeState(2500);
            const {
                renderDataGrid, getVirtualWindowBounds, scheduleVirtualGridUpdate
            } = await import(gridRenderModulePath);

            renderDataGrid(0, 0);
            // A failed deferred save after a table switch retains the edit
            // session while the old grid's editor DOM is already gone. The
            // freeze must not survive the editor: it would blank the NEW
            // grid beyond the materialized slice with no keyboard recovery.
            state.editingCellInfo = { rowIdx: 5, colIdx: 0 };
            state.activeCellInput = { isConnected: false, value: 'stale' };

            container.scrollTop = 1250 * ROW;
            scheduleVirtualGridUpdate();
            const bounds = getVirtualWindowBounds();
            assert.ok(bounds && bounds.start > 0, 'window must revalidate despite the leaked session');
            const doc = (globalThis as any).document;
            assert.ok(doc.getElementById('row-1250'), 'scrolled-to row materialized, grid not blanked');
        });

        it('materializes the target row before opening an editor on it', async () => {
            const { container } = installGridDom(520);
            const state = await primeState(2500);
            const { renderDataGrid, getVirtualWindowBounds } = await import(gridRenderModulePath);
            const { startCellEdit } = await import(editModulePath);

            renderDataGrid(1250 * ROW, 0);
            const doc = (globalThis as any).document;
            assert.strictEqual(doc.getElementById('cell-0-0'), null, 'row 0 starts unmaterialized');

            // Tab-wrap style target: open an editor on the page's first row
            // while scrolled to the middle of the page.
            startCellEdit(0, 0, 1);

            assert.ok(state.editingCellInfo, 'edit session opened');
            assert.strictEqual(state.editingCellInfo.rowIdx, 0);
            const bounds = getVirtualWindowBounds();
            assert.ok(bounds && bounds.start === 0, 'window moved to cover row 0');
            const cell = doc.getElementById('cell-0-0');
            assert.strictEqual(cell.children[0].className, 'cell-input');
            assert.ok(container.scrollTop < 1250 * ROW, 'container scrolled toward row 0');
        });

        it('heals a page committed under the editing render-skip once editing ends', async () => {
            const { container } = installGridDom(520);
            const state = await primeState(2500);
            const {
                renderDataGrid, getVirtualWindowBounds, scheduleVirtualGridUpdate, updateVirtualGridWindow
            } = await import(gridRenderModulePath);

            renderDataGrid(0, 0);
            const doc = (globalThis as any).document;
            assert.strictEqual(doc.getElementById('cell-0-0').textContent, 'v0');

            // Simulate loadTableData's editing render-skip: the commit replaces
            // gridData while the mounted DOM is left alone.
            state.editingCellInfo = { rowIdx: 0, colIdx: 0, rowId: 1, columnName: 'value' };
            state.gridData = Array.from({ length: 2500 }, (_, i) => [i + 1, `fresh${i}`]);
            container.scrollTop = 3 * ROW;
            scheduleVirtualGridUpdate();
            assert.strictEqual(
                doc.getElementById('cell-0-0').textContent,
                'v0',
                'window stays frozen while the edit is active'
            );

            state.editingCellInfo = null;
            updateVirtualGridWindow();

            assert.strictEqual(doc.getElementById('cell-0-0').textContent, 'fresh0');
            assert.deepStrictEqual(getVirtualWindowBounds(), { start: 0, end: 41 });
            assert.strictEqual(container.scrollTop, 3 * ROW, 'the heal preserved the viewport');
        });

        it('drops a window whose grid was replaced by a non-grid view', async () => {
            const { container } = installGridDom(520);
            await primeState(2500);
            const {
                renderDataGrid, getVirtualWindowBounds, updateVirtualGridWindow
            } = await import(gridRenderModulePath);

            renderDataGrid(0, 0);
            assert.ok(getVirtualWindowBounds());

            // showLoading()/showErrorState() wipe the container this way.
            container.innerHTML = '';
            container.scrollTop = 500;
            updateVirtualGridWindow();

            assert.strictEqual(getVirtualWindowBounds(), null);
            assert.strictEqual(container.children.length, 0, 'nothing was painted over the wipe');
        });
    });

    describe('render cost', () => {
        it('keeps the initial render of a large page proportional to the window', async () => {
            // Windowed pass.
            const windowed = installGridDom(520);
            await primeState(2500);
            const { renderDataGrid } = await import(gridRenderModulePath);
            renderDataGrid(0, 0);
            const windowedCreated = windowed.createdCount();
            assert.strictEqual(dataRows(windowed.container).length, 38);

            // Full pass: same page, no measurable viewport → full render.
            const full = installGridDom(undefined);
            await primeState(2500);
            renderDataGrid(0, 0);
            const fullCreated = full.createdCount();
            assert.strictEqual(dataRows(full.container).length, 2500);

            assert.ok(
                windowedCreated < fullCreated / 10,
                `windowed render created ${windowedCreated} nodes; ` +
                `full render created ${fullCreated} — expected >10x reduction`
            );
        });
    });
});
