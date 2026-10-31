import './vscode_mock_setup';

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import esbuild from 'esbuild';
import { chromium, type BrowserContext, type Page } from 'playwright-core';

// Column windowing in the real viewer bundle: layout (spacer colSpans under
// table-layout: fixed), focus, and editing can only be checked with layout.

const root = path.resolve(__dirname, '../..');
const browserPath = [
    process.env.SQLITE_EXPLORER_CHROMIUM_PATH,
    chromium.executablePath(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe')
].find(candidate => candidate && existsSync(candidate));

declare global {
    interface Window {
        __columnHarness: {
            state: {
                gridData: unknown[][];
                isGridReloading: boolean;
                isLoadingColumns: boolean;
                pinnedColumns: Set<string>;
                pinnedRowIds: Set<number>;
                editingCellInfo: unknown;
            };
            renderDataGrid(): void;
            updateVirtualGridWindow(): boolean;
            getVirtualColumnBounds(): { start: number; end: number } | null;
            getVirtualWindowBounds(): { start: number; end: number } | null;
            startCellEdit(rowIdx: number, colIdx: number, rowId: number): void;
        };
    }
}

type Layout = {
    bounds: { start: number; end: number } | null;
    columnCells: number;
    spacerSpans: number[];
    misaligned: string[];
    rowWidth: number;
    headerWidth: number;
};

describe('grid column window', {
    skip: browserPath ? false : 'Install Chromium or set SQLITE_EXPLORER_CHROMIUM_PATH for real DOM regressions'
}, () => {
    let context: BrowserContext;
    let profile: string;
    let html: string;
    const errors: Error[] = [];

    before(async () => {
        const bundle = await esbuild.build({
            stdin: {
                contents: `
                    import './core/ui/viewer.js';
                    import { state } from './core/ui/modules/state.js';
                    import { renderDataGrid, updateVirtualGridWindow, getVirtualColumnBounds, getVirtualWindowBounds } from './core/ui/modules/grid-render.js';
                    import { startCellEdit } from './core/ui/modules/edit.js';
                    window.__columnHarness = { state, renderDataGrid, updateVirtualGridWindow, getVirtualColumnBounds, getVirtualWindowBounds, startCellEdit };
                `,
                resolveDir: root
            },
            bundle: true,
            format: 'iife',
            platform: 'browser',
            write: false
        });
        html = readFileSync(path.join(root, 'core/ui/viewer.template.html'), 'utf8')
            .replace('<!--HEAD-->', '<meta id="vscode-env" data-sidebar-left="220" data-default-page-size="5000" data-cell-edit-behavior="inline">')
            .replace('<!--STYLES-->', () => readFileSync(path.join(root, 'core/ui/viewer.css'), 'utf8'))
            .replace('<!--SCRIPTS-->', () => bundle.outputFiles[0].text);
        // Under the ignored .tmp, so a crashed run leaves nothing untracked.
        mkdirSync(path.join(root, '.tmp'), { recursive: true });
        profile = mkdtempSync(path.join(root, '.tmp', 'ui-column-window-test-'));
        context = await chromium.launchPersistentContext(profile, {
            executablePath: browserPath,
            headless: true,
            viewport: { width: 1280, height: 720 },
            acceptDownloads: false
        });
        await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
    });

    after(async () => {
        await context?.close();
        if (profile) rmSync(profile, { recursive: true, force: true });
        assert.deepEqual(errors, [], 'the real viewer must run without browser errors');
    });

    async function openGrid(columnCount: number, rowCount = 200): Promise<Page> {
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error));
        const install = ({ columnCount, rowCount }: { columnCount: number; rowCount: number }) => {
            const columns = Array.from({ length: columnCount }, (_, index) => ({
                ordinal: index,
                identifier: index === 0 ? 'id' : `c${index}`,
                declaredType: index === 0 ? 'INTEGER' : 'TEXT',
                primaryKeyPosition: index === 0 ? 1 : 0,
                isRowidAlias: index === 0,
                isRequired: false,
                defaultExpression: null
            }));
            Object.assign(window, {
                acquireVsCodeApi: () => ({
                    getState: () => ({ selectedTable: 'wide', selectedTableType: 'table', rowsPerPage: 500 }),
                    setState() {},
                    postMessage(message: { channel?: string; content?: { kind: string; messageId: string; targetMethod: string; payload: unknown[] } }) {
                        if (message.channel !== 'rpc' || message.content?.kind !== 'invoke') return;
                        const { messageId, targetMethod, payload } = message.content;
                        const options = payload[1] as { offset: number; limit: number };
                        let data: unknown;
                        if (targetMethod === 'initialize') {
                            data = { connected: true, readOnly: false, connectionGeneration: 1, cellEditBehavior: 'inline' };
                        } else if (targetMethod === 'ping') data = true;
                        else if (targetMethod === 'fetchSchema') data = { tables: [{ identifier: 'wide' }], views: [], indexes: [] };
                        else if (targetMethod === 'getTableInfo') data = columns;
                        else if (targetMethod === 'fetchTableCount') data = { count: rowCount, isExact: true };
                        else if (targetMethod === 'fetchTableData') {
                            data = {
                                rows: Array.from({ length: Math.min(options.limit, rowCount - options.offset) }, (_, index) => {
                                    const id = options.offset + index + 1;
                                    return [id, id, ...columns.slice(1).map(column => `${column.identifier}-${id}`)];
                                })
                            };
                        } else if (targetMethod === 'saveSidebarState') data = undefined;
                        else throw new Error(`Unexpected viewer RPC: ${targetMethod}`);
                        queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', {
                            data: { channel: 'rpc', content: { kind: 'response', messageId, success: true, data } }
                        })));
                    }
                })
            });
        };
        await page.addInitScript({ content: `
            globalThis.__name = value => value;
            (${install.toString()})(${JSON.stringify({ columnCount, rowCount })});
        ` });
        await page.goto('https://sqlite-explorer.test/viewer');
        await page.waitForFunction(() => !!window.__columnHarness
            && window.__columnHarness.state.gridData.length > 0
            && !window.__columnHarness.state.isGridReloading
            && !window.__columnHarness.state.isLoadingColumns, undefined, { timeout: 10000 });
        return page;
    }

    /** Layout of the first unpinned data row against the header. */
    function readLayout(page: Page): Promise<Layout> {
        return page.evaluate(() => {
            const row = document.querySelector('#gridContainer tbody tr.data-row') as HTMLTableRowElement;
            const headerRow = document.querySelector('#gridContainer thead tr') as HTMLTableRowElement;
            const headers = new Map<string, DOMRect>();
            for (const th of headerRow.querySelectorAll<HTMLElement>('th[data-column]')) {
                headers.set(th.dataset.column!, th.getBoundingClientRect());
            }
            const columnNames = (window as any).__columnHarness.state.tableColumns.map((c: { name: string }) => c.name);
            const misaligned: string[] = [];
            const cells = row.querySelectorAll<HTMLElement>('td.data-cell:not(.row-number)');
            for (const td of cells) {
                const name = columnNames[Number(td.dataset.colidx)];
                const header = headers.get(name)!;
                const rect = td.getBoundingClientRect();
                if (Math.abs(rect.left - header.left) > 0.5 || Math.abs(rect.width - header.width) > 0.5) {
                    misaligned.push(`${name}: cell ${rect.left}+${rect.width}, header ${header.left}+${header.width}`);
                }
            }
            const spacerSpans = [...row.querySelectorAll<HTMLTableCellElement>('td.virtual-column-spacer')]
                .map(td => (td.style.display === 'none' ? 0 : td.colSpan));
            return {
                bounds: window.__columnHarness.getVirtualColumnBounds(),
                columnCells: cells.length,
                spacerSpans,
                misaligned,
                rowWidth: row.getBoundingClientRect().width,
                headerWidth: headerRow.getBoundingClientRect().width
            };
        });
    }

    /** Columns whose header shows in the viewport but whose cell is not rendered. */
    function uncoveredColumns(page: Page): Promise<string[]> {
        return page.evaluate(() => {
            const container = document.getElementById('gridContainer')!;
            const box = container.getBoundingClientRect();
            const row = document.querySelector('#gridContainer tbody tr.data-row')!;
            const missing: string[] = [];
            for (const th of document.querySelectorAll<HTMLElement>('#gridContainer thead th[data-column]')) {
                const rect = th.getBoundingClientRect();
                if (rect.right <= box.left || rect.left >= box.right) continue;
                const colIdx = (window as any).__columnHarness.state.tableColumns
                    .findIndex((c: { name: string }) => c.name === th.dataset.column);
                if (!row.querySelector(`[data-colidx="${colIdx}"]`)) missing.push(th.dataset.column!);
            }
            return missing;
        });
    }

    async function scrollTo(page: Page, left: number) {
        await page.evaluate(async scrollLeft => {
            const container = document.getElementById('gridContainer')!;
            container.scrollLeft = scrollLeft;
            container.dispatchEvent(new Event('scroll'));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }, left);
    }

    it('renders every column of a 99-column table', async () => {
        const page = await openGrid(99);
        try {
            const layout = await readLayout(page);
            assert.equal(layout.bounds, null);
            assert.equal(layout.columnCells, 99);
            assert.deepEqual(layout.spacerSpans, []);
        } finally { await page.close(); }
    });

    it('renders a window of a 300-column table whose cells line up with their headers', async () => {
        const page = await openGrid(300);
        try {
            const layout = await readLayout(page);
            assert.ok(layout.bounds, 'a 300-column table is windowed');
            assert.equal(layout.bounds!.start, 0);
            assert.ok(layout.columnCells > 10 && layout.columnCells < 40, `${layout.columnCells} cells`);
            assert.deepEqual(layout.spacerSpans, [0, 300 - layout.bounds!.end]);
            assert.equal(layout.columnCells + layout.spacerSpans[1], 300);
            assert.deepEqual(layout.misaligned, []);
            assert.equal(layout.rowWidth, layout.headerWidth, 'the spacers stand in for exactly the missing columns');
        } finally { await page.close(); }
    });

    it('moves the window with horizontal scrolling and keeps the table width', async () => {
        const page = await openGrid(300);
        try {
            const before = await readLayout(page);
            const scrollWidth = await page.evaluate(() => document.getElementById('gridContainer')!.scrollWidth);
            await scrollTo(page, 15000);
            const middle = await readLayout(page);
            assert.ok(middle.bounds!.start > 100 && middle.bounds!.end < 200, JSON.stringify(middle.bounds));
            assert.equal(middle.spacerSpans[0] + middle.columnCells + middle.spacerSpans[1], 300);
            assert.deepEqual(middle.misaligned, []);
            assert.equal(middle.rowWidth, before.headerWidth);
            assert.equal(await page.evaluate(() => document.getElementById('gridContainer')!.scrollWidth), scrollWidth);
            assert.deepEqual(await uncoveredColumns(page), []);
            await scrollTo(page, 0);
            assert.deepEqual((await readLayout(page)).bounds, before.bounds);
        } finally { await page.close(); }
    });

    it('moves keyboard focus across the window edge and keeps the focused cell in view', async () => {
        const page = await openGrid(300);
        try {
            await page.locator('#cell-0-1').click();
            for (let step = 0; step < 120; step++) await page.keyboard.press('ArrowRight');
            const focus = await page.evaluate(() => {
                const active = document.activeElement as HTMLElement;
                const box = document.getElementById('gridContainer')!.getBoundingClientRect();
                const rect = active.getBoundingClientRect();
                return { id: active.id, inView: rect.left >= box.left && rect.right <= box.right };
            });
            assert.deepEqual(focus, { id: 'cell-0-121', inView: true });
            assert.deepEqual((await readLayout(page)).misaligned, []);
        } finally { await page.close(); }
    });

    it('keeps the focused cell focused while the window moves around it', async () => {
        const page = await openGrid(300);
        try {
            await page.locator('#cell-0-1').click();
            for (let step = 0; step < 40; step++) await page.keyboard.press('ArrowRight');
            const before = await readLayout(page);
            // Scroll by a few columns: the focused cell stays inside the window
            // while the window itself moves.
            await page.evaluate(async () => {
                const container = document.getElementById('gridContainer')!;
                container.scrollLeft += 1200;
                container.dispatchEvent(new Event('scroll'));
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            });
            const after = await readLayout(page);
            assert.notDeepEqual(after.bounds, before.bounds, 'the window moved');
            assert.equal(await page.evaluate(() => document.activeElement?.id), 'cell-0-41');
        } finally { await page.close(); }
    });

    it('opens the inline editor on a cell reached past the window', async () => {
        const page = await openGrid(300);
        try {
            await page.locator('#cell-0-1').click();
            for (let step = 0; step < 150; step++) await page.keyboard.press('ArrowRight');
            await page.keyboard.press('Enter');
            const editor = page.locator('#cell-0-151 textarea.cell-input');
            await editor.waitFor({ timeout: 2000 });
            assert.equal(await editor.inputValue(), 'c151-1');
            // The editor freezes the window: scrolling must not rebuild its cell.
            await scrollTo(page, 0);
            assert.equal(await page.locator('#cell-0-151 textarea.cell-input').count(), 1);
            await page.keyboard.press('Escape');
        } finally { await page.close(); }
    });

    it('opens an editor programmatically on a column outside the window', async () => {
        const page = await openGrid(300);
        try {
            assert.ok((await readLayout(page)).bounds!.end < 200);
            await page.evaluate(() => window.__columnHarness.startCellEdit(0, 200, 1));
            const editor = page.locator('#cell-0-200 textarea.cell-input');
            await editor.waitFor({ timeout: 2000 });
            assert.equal(await editor.inputValue(), 'c200-1');
            await page.keyboard.press('Escape');
        } finally { await page.close(); }
    });

    it('reveals a match in a column outside the window', async () => {
        const page = await openGrid(300);
        try {
            assert.ok((await readLayout(page)).bounds!.end < 250);
            // The toolbar filter sits outside the grid, so nothing but match
            // navigation scrolls the grid to the match.
            const filter = page.locator('#filterInput');
            await filter.fill('c250-3');
            await filter.press('Enter');
            const match = page.locator('#cell-2-250.active-match-cell');
            await match.waitFor({ timeout: 5000 });
            const inView = await match.evaluate(cell => {
                const box = document.getElementById('gridContainer')!.getBoundingClientRect();
                const rect = cell.getBoundingClientRect();
                return rect.left >= box.left && rect.right <= box.right;
            });
            assert.equal(inView, true);
            assert.deepEqual((await readLayout(page)).misaligned, []);
        } finally { await page.close(); }
    });

    it('replans the window after a column is resized without a re-render', async () => {
        const page = await openGrid(300);
        try {
            // End widens c3 to the 10,000px maximum; every later column moves.
            await page.locator('.resize-handle[data-column="c3"]').focus();
            await page.keyboard.press('End');
            await scrollTo(page, 10400);
            assert.deepEqual(await uncoveredColumns(page), []);
            assert.deepEqual((await readLayout(page)).misaligned, []);
        } finally { await page.close(); }
    });

    it('windows the columns of a page too short for a row window', async () => {
        // A filter matching a few rows of a wide table: no row window, so the
        // column window alone must drive scrolling and cell lookups.
        const page = await openGrid(300, 10);
        try {
            const bounds = await page.evaluate(() => ({
                rows: window.__columnHarness.getVirtualWindowBounds(),
                columns: window.__columnHarness.getVirtualColumnBounds()
            }));
            assert.equal(bounds.rows, null);
            assert.ok(bounds.columns);
            await scrollTo(page, 15000);
            assert.deepEqual(await uncoveredColumns(page), []);
            assert.deepEqual((await readLayout(page)).misaligned, []);
            await scrollTo(page, 0);
            await page.evaluate(() => window.__columnHarness.startCellEdit(3, 200, 4));
            await page.locator('#cell-3-200 textarea.cell-input').waitFor({ timeout: 2000 });
            await page.keyboard.press('Escape');
        } finally { await page.close(); }
    });

    it('keeps pinned columns in every row with the window behind them', async () => {
        const page = await openGrid(300);
        try {
            // Row 5 pinned: readLayout reads the first data row, which is the
            // pinned row, so the pinned row's alignment is checked too.
            await page.evaluate(() => {
                const harness = window.__columnHarness;
                harness.state.pinnedColumns.add('c250');
                harness.state.pinnedRowIds.add(5);
                harness.renderDataGrid();
            });
            assert.equal(await page.evaluate(() => document.querySelector('#gridContainer tbody tr.data-row')?.id), 'row-4');
            await scrollTo(page, 9000);
            const layout = await readLayout(page);
            assert.deepEqual(layout.misaligned, []);
            assert.equal(layout.rowWidth, layout.headerWidth);
            assert.equal(await page.locator('#cell-0-250').count(), 1, 'the pinned column is rendered');
            assert.equal(layout.spacerSpans[0] + layout.columnCells - 1 + layout.spacerSpans[1], 299);
        } finally { await page.close(); }
    });

    async function scrollRowsTo(page: Page, top: number) {
        await page.evaluate(async scrollTop => {
            const container = document.getElementById('gridContainer')!;
            container.scrollTop = scrollTop;
            container.dispatchEvent(new Event('scroll'));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }, top);
    }

    function readFocus(page: Page) {
        return page.evaluate(() => ({
            active: document.activeElement?.id,
            tabstops: [...document.querySelectorAll('#gridContainer [data-grid-tabstop="true"]')].map(td => td.id)
        }));
    }

    it('keeps keyboard focus in the grid when scrolling takes the focused cell out of the window', async () => {
        const page = await openGrid(300);
        try {
            await page.locator('#cell-0-3').click();
            await page.keyboard.press('ArrowRight');
            await scrollTo(page, 8000);
            assert.equal(await page.locator('#cell-0-4').count(), 0, 'the focused cell left the window');
            assert.equal((await readFocus(page)).active, 'gridContainer');
            await page.keyboard.press('ArrowDown');
            assert.deepEqual(await readFocus(page), { active: 'cell-1-4', tabstops: ['cell-1-4'] });
            assert.deepEqual(await uncoveredColumns(page), []);
            const visible = await page.evaluate(() => {
                const box = document.getElementById('gridContainer')!.getBoundingClientRect();
                const cell = document.getElementById('cell-1-4')!.getBoundingClientRect();
                return cell.left >= box.left && cell.right <= box.right;
            });
            assert.ok(visible, 'the arrow key brings the new cell into view');
        } finally { await page.close(); }
    });

    it('gives focus back to the cell when scrolling builds it again', async () => {
        const page = await openGrid(300);
        try {
            await page.locator('#cell-0-3').click();
            await page.keyboard.press('ArrowRight');
            await scrollTo(page, 8000);
            await scrollTo(page, 0);
            assert.deepEqual(await readFocus(page), { active: 'cell-0-4', tabstops: ['cell-0-4'] });
        } finally { await page.close(); }
    });

    it('copies the selection while focus is parked on the grid', async () => {
        const page = await openGrid(300);
        try {
            await page.evaluate(() => {
                (window as any).__copied = [];
                Object.defineProperty(navigator, 'clipboard', {
                    configurable: true,
                    value: { writeText: async (text: string) => { (window as any).__copied.push(text); } }
                });
            });
            await page.locator('#cell-0-3').click();
            const text = await page.locator('#cell-0-3 .cell-text').textContent();
            await scrollTo(page, 8000);
            assert.equal((await readFocus(page)).active, 'gridContainer');
            await page.keyboard.press('Control+c');
            await page.waitForFunction(() => (window as any).__copied.length > 0, undefined, { timeout: 2000 });
            assert.deepEqual(await page.evaluate(() => (window as any).__copied), [text]);
        } finally { await page.close(); }
    });

    it('keeps the tab stop on the last focused cell after focus left the grid', async () => {
        const page = await openGrid(300);
        try {
            await page.locator('#cell-0-3').click();
            await page.keyboard.press('ArrowRight');
            await scrollTo(page, 8000);
            await page.locator('#filterInput').focus();
            await scrollTo(page, 0);
            assert.deepEqual(await readFocus(page), { active: 'filterInput', tabstops: ['cell-0-4'] });
        } finally { await page.close(); }
    });

    it('keeps keyboard focus in the grid when the row window drops the focused row', async () => {
        const page = await openGrid(300);
        try {
            await page.locator('#cell-2-1').click();
            await scrollRowsTo(page, 3000);
            assert.equal(await page.locator('#row-2').count(), 0, 'the focused row left the window');
            assert.equal((await readFocus(page)).active, 'gridContainer');
            await page.keyboard.press('ArrowDown');
            assert.deepEqual(await readFocus(page), { active: 'cell-3-1', tabstops: ['cell-3-1'] });
            await scrollRowsTo(page, 3000);
            await scrollRowsTo(page, 0);
            assert.deepEqual(await readFocus(page), { active: 'cell-3-1', tabstops: ['cell-3-1'] });
        } finally { await page.close(); }
    });

    /** ARIA positions of the grid; cells keyed by header aria-colindex. */
    function readAriaPositions(page: Page) {
        return page.evaluate(() => {
            const table = document.querySelector('#gridContainer table')!;
            const headerCells = [...document.querySelectorAll<HTMLElement>('#gridContainer thead tr > th')];
            const headerIndexByName = new Map(headerCells.map(th => [th.dataset.column, th.getAttribute('aria-colindex')]));
            const columnNames = (window as any).__columnHarness.state.tableColumns.map((c: { name: string }) => c.name);
            const wrongCells: string[] = [];
            const rows: { id: string; rowIndex: string | null }[] = [];
            let colIndexedCells = 0;
            for (const tr of document.querySelectorAll<HTMLElement>('#gridContainer tbody tr.data-row')) {
                rows.push({ id: tr.id, rowIndex: tr.getAttribute('aria-rowindex') });
                for (const td of tr.querySelectorAll<HTMLElement>('td.data-cell')) {
                    const actual = td.getAttribute('aria-colindex');
                    if (actual !== null) colIndexedCells++;
                    const expected = td.classList.contains('row-number')
                        ? '1'
                        : headerIndexByName.get(columnNames[Number(td.dataset.colidx)]);
                    if (actual !== expected) wrongCells.push(`${td.id}: ${actual} != ${expected}`);
                }
            }
            return {
                colCount: table.getAttribute('aria-colcount'),
                rowCount: table.getAttribute('aria-rowcount'),
                headerRowIndex: document.querySelector('#gridContainer thead tr')!.getAttribute('aria-rowindex'),
                headerIndices: headerCells.map(th => th.getAttribute('aria-colindex')),
                rows,
                colIndexedCells,
                wrongCells: wrongCells.slice(0, 5)
            };
        });
    }

    it('gives assistive technology the position of every cell in a windowed grid', async () => {
        const page = await openGrid(300);
        try {
            await page.evaluate(() => {
                const harness = window.__columnHarness;
                harness.state.pinnedColumns.add('c250');
                harness.state.pinnedRowIds.add(5);
                harness.renderDataGrid();
            });
            // Both windows move: cells built by the patch path and rows built
            // by the row window must carry positions too.
            await scrollTo(page, 9000);
            await page.evaluate(async () => {
                const container = document.getElementById('gridContainer')!;
                container.scrollTop = 2600;
                container.dispatchEvent(new Event('scroll'));
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            });
            assert.ok(await page.evaluate(() => window.__columnHarness.getVirtualWindowBounds()!.start > 0));
            const aria = await readAriaPositions(page);
            assert.equal(aria.colCount, '301');
            assert.equal(aria.rowCount, '201');
            assert.equal(aria.headerRowIndex, '1');
            assert.deepEqual(aria.headerIndices, Array.from({ length: 301 }, (_, index) => String(index + 1)));
            assert.ok(aria.colIndexedCells > 100, `${aria.colIndexedCells} cells`);
            assert.deepEqual(aria.wrongCells, []);
            // Row 5 (row-4) is pinned, so it is displayed first; every other
            // row follows in page order after it.
            assert.deepEqual(aria.rows[0], { id: 'row-4', rowIndex: '2' });
            for (const { id, rowIndex } of aria.rows.slice(1)) {
                const rowIdx = Number(id.slice('row-'.length));
                assert.equal(rowIndex, String((rowIdx < 4 ? rowIdx : rowIdx - 1) + 3), id);
            }
        } finally { await page.close(); }
    });

    it('leaves positions to the DOM on an axis that renders everything', async () => {
        const page = await openGrid(99, 10);
        try {
            const aria = await readAriaPositions(page);
            assert.deepEqual(
                [aria.colCount, aria.rowCount, aria.headerRowIndex, aria.colIndexedCells],
                [null, null, null, 0]
            );
            assert.ok(aria.rows.every(row => row.rowIndex === null));
        } finally { await page.close(); }
    });
});
