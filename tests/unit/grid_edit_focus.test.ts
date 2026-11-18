import './vscode_mock_setup';

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import esbuild from 'esbuild';
import { chromium, type BrowserContext, type Page } from 'playwright-core';

// Where keyboard focus goes when an inline edit ends, in the real viewer bundle:
// focus, :focus-visible and the virtualized windows need a real browser.

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
        __focusHarness: {
            state: {
                gridData: unknown[][];
                isGridReloading: boolean;
                isLoadingColumns: boolean;
                isSavingCell: boolean;
                contentRefreshPromise: unknown;
                pinnedColumns: Set<string>;
                pinnedRowIds: Set<number>;
                editingCellInfo: unknown;
                sortedColumn: string | null;
                sortAscending: boolean;
                columnFilters: Record<string, string>;
            };
            renderDataGrid(): void;
            loadTableData(showSpinner?: boolean): Promise<unknown>;
            getVirtualColumnBounds(): { start: number; end: number } | null;
            getVirtualWindowBounds(): { start: number; end: number } | null;
        };
        /** Every RPC the viewer sent, in order. */
        __rpcLog: { method: string; payload: unknown[] }[];
    }
}

type GridOptions = {
    columnCount: number;
    rowCount: number;
    /** Post the host's refreshContent echo before each updateCell reply, as VS Code does. */
    echo?: boolean;
};

describe('grid keyboard focus after an inline edit', {
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
                    import { renderDataGrid, getVirtualColumnBounds, getVirtualWindowBounds } from './core/ui/modules/grid-render.js';
                    import { loadTableData } from './core/ui/modules/grid-data.js';
                    window.__focusHarness = { state, renderDataGrid, loadTableData, getVirtualColumnBounds, getVirtualWindowBounds };
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
        profile = mkdtempSync(path.join(root, '.tmp', 'ui-edit-focus-test-'));
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

    async function openGrid(options: GridOptions): Promise<Page> {
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error));
        const install = ({ columnCount, rowCount, echo }: GridOptions) => {
            const columns = Array.from({ length: columnCount }, (_, index) => ({
                ordinal: index,
                identifier: index === 0 ? 'id' : `c${index}`,
                declaredType: index === 0 ? 'INTEGER' : 'TEXT',
                primaryKeyPosition: index === 0 ? 1 : 0,
                isRowidAlias: index === 0,
                isRequired: false,
                defaultExpression: null
            }));
            // The table: rowid -> stored values, which updateCell writes.
            const table = new Map<number, unknown[]>();
            for (let id = 1; id <= rowCount; id++) {
                table.set(id, [id, ...columns.slice(1).map(column => `${column.identifier}-${id}`)]);
            }
            type QueryOptions = {
                offset: number;
                limit: number;
                orderBy?: string | null;
                orderDir?: string;
                filters?: { column: string; value: string }[];
            };
            const matchingRows = (options: QueryOptions) => {
                const indexOf = (name: string) => columns.findIndex(column => column.identifier === name);
                let rows = [...table.entries()]
                    .filter(([, values]) => (options.filters ?? []).every(filter => (
                        String(values[indexOf(filter.column)]).toLowerCase().includes(filter.value.toLowerCase())
                    )))
                    .map(([rowid, values]) => [rowid, ...values]);
                if (options.orderBy) {
                    const at = indexOf(options.orderBy) + 1;
                    const direction = options.orderDir === 'DESC' ? -1 : 1;
                    rows = rows.sort((a, b) => direction * String(a[at]).localeCompare(String(b[at])));
                }
                return rows;
            };
            window.__rpcLog = [];
            let correlation = 0;
            Object.assign(window, {
                acquireVsCodeApi: () => ({
                    getState: () => ({ selectedTable: 'items', selectedTableType: 'table', rowsPerPage: 500 }),
                    setState() {},
                    postMessage(message: { channel?: string; content?: { kind: string; messageId: string; targetMethod: string; payload: unknown[] } }) {
                        if (message.channel !== 'rpc' || message.content?.kind !== 'invoke') return;
                        const { messageId, targetMethod, payload } = message.content;
                        window.__rpcLog.push({ method: targetMethod, payload });
                        let data: unknown;
                        if (targetMethod === 'initialize') {
                            data = { connected: true, readOnly: false, connectionGeneration: 1, cellEditBehavior: 'inline' };
                        } else if (targetMethod === 'ping') data = true;
                        else if (targetMethod === 'fetchSchema') data = { tables: [{ identifier: 'items' }], views: [], indexes: [], hasTriggers: false };
                        else if (targetMethod === 'getTableInfo') data = columns;
                        else if (targetMethod === 'fetchTableCount') {
                            data = { count: matchingRows(payload[1] as QueryOptions).length, isExact: true };
                        } else if (targetMethod === 'fetchTableData') {
                            const query = payload[1] as QueryOptions;
                            data = { rows: matchingRows(query).slice(query.offset, query.offset + query.limit) };
                        } else if (targetMethod === 'updateCell') {
                            const [, rowId, column, value] = payload as [string, number, string, unknown];
                            const values = table.get(Number(rowId))!;
                            values[columns.findIndex(entry => entry.identifier === column)] = value;
                            data = undefined;
                            if (column === 'id') {
                                // The rowid alias changed: the record moves to its new
                                // rowid, which the reply names.
                                table.delete(Number(rowId));
                                table.set(Number(value), values);
                                data = Number(value);
                            }
                            if (echo) {
                                // VS Code posts the document change to every panel before
                                // the mutation reply.
                                queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', {
                                    data: {
                                        kind: 'invoke',
                                        correlationId: `host_${++correlation}`,
                                        methodName: 'refreshContent',
                                        parameters: ['items.db', undefined, { modificationType: 'cell_update' }]
                                    }
                                })));
                            }
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
            (${install.toString()})(${JSON.stringify(options)});
        ` });
        await page.goto('https://sqlite-explorer.test/viewer');
        await waitForIdle(page);
        return page;
    }

    /** No load, save or host refresh in flight, and two frames for the window catch-up. */
    async function waitForIdle(page: Page) {
        await page.waitForFunction(() => {
            const harness = window.__focusHarness;
            return !!harness
                && harness.state.gridData.length > 0
                && !harness.state.isGridReloading
                && !harness.state.isLoadingColumns
                && !harness.state.isSavingCell
                && !harness.state.contentRefreshPromise;
        }, undefined, { timeout: 10000 });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }

    function readFocus(page: Page) {
        return page.evaluate(() => ({
            active: document.activeElement?.id || document.activeElement?.tagName,
            tabstops: [...document.querySelectorAll('#gridContainer [data-grid-tabstop="true"]')].map(td => td.id)
        }));
    }

    /** The id of the cell showing `rowid`'s value of column colIdx, or null. */
    function cellOfRecord(page: Page, rowid: number, colIdx: number) {
        return page.evaluate(({ rowid, colIdx }) => (
            document.querySelector(`#gridContainer tr.data-row[data-rowid="${rowid}"] td[data-colidx="${colIdx}"]`)?.id ?? null
        ), { rowid, colIdx });
    }

    async function scrollGrid(page: Page, position: { top?: number; left?: number }) {
        await page.evaluate(async ({ top, left }) => {
            const container = document.getElementById('gridContainer')!;
            if (top !== undefined) container.scrollTop = top;
            if (left !== undefined) container.scrollLeft = left;
            container.dispatchEvent(new Event('scroll'));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }, position);
    }

    /**
     * Type at the end of the open editor. Not the End key: on macOS it scrolls
     * the page instead of moving the caret.
     */
    async function typeAtEnd(page: Page, text: string) {
        await page.evaluate(() => {
            const editor = document.activeElement as HTMLTextAreaElement;
            editor.setSelectionRange(editor.value.length, editor.value.length);
        });
        await page.keyboard.type(text);
    }

    async function openEditor(page: Page, cellId: string) {
        await page.locator(`#${cellId}`).dblclick();
        await page.locator(`#${cellId} textarea.cell-input`).waitFor({ timeout: 2000 });
    }

    type Layout = {
        name: string;
        options: GridOptions;
        /** The edited cell; its record id is rowIdx + 1 unless pinned rows say otherwise. */
        cell: { rowIdx: number; colIdx: number };
        /** The cell ArrowDown moves to from it. */
        below: string;
        pin?: { rowId?: number; column?: string };
        expectWindows: { rows: boolean; columns: boolean };
    };

    const layouts: Layout[] = [
        { name: 'a fully rendered grid', options: { columnCount: 4, rowCount: 10 }, cell: { rowIdx: 3, colIdx: 2 }, below: 'cell-4-2', expectWindows: { rows: false, columns: false } },
        { name: 'a row window', options: { columnCount: 4, rowCount: 200 }, cell: { rowIdx: 3, colIdx: 2 }, below: 'cell-4-2', expectWindows: { rows: true, columns: false } },
        { name: 'a column window', options: { columnCount: 300, rowCount: 10 }, cell: { rowIdx: 3, colIdx: 5 }, below: 'cell-4-5', expectWindows: { rows: false, columns: true } },
        // Row 5 (rowIdx 4) is pinned, so it is displayed first and the first
        // unpinned row (rowIdx 0) is below it.
        { name: 'a pinned row', options: { columnCount: 300, rowCount: 200 }, cell: { rowIdx: 4, colIdx: 3 }, below: 'cell-0-3', pin: { rowId: 5, column: 'c250' }, expectWindows: { rows: true, columns: true } },
        { name: 'a pinned column', options: { columnCount: 300, rowCount: 200 }, cell: { rowIdx: 6, colIdx: 250 }, below: 'cell-7-250', pin: { rowId: 5, column: 'c250' }, expectWindows: { rows: true, columns: true } }
    ];

    async function openLayout(layout: Layout, echo = false) {
        const page = await openGrid({ ...layout.options, echo });
        if (layout.pin) {
            await page.evaluate(pin => {
                const harness = window.__focusHarness;
                if (pin.rowId !== undefined) harness.state.pinnedRowIds.add(pin.rowId);
                if (pin.column !== undefined) harness.state.pinnedColumns.add(pin.column);
                harness.renderDataGrid();
            }, layout.pin);
        }
        assert.deepEqual(await page.evaluate(() => ({
            rows: !!window.__focusHarness.getVirtualWindowBounds(),
            columns: !!window.__focusHarness.getVirtualColumnBounds()
        })), layout.expectWindows, `${layout.name}: windows`);
        return page;
    }

    for (const layout of layouts) {
        const id = `cell-${layout.cell.rowIdx}-${layout.cell.colIdx}`;

        it(`gives focus back to the cell after Enter commits an edit in ${layout.name}`, async () => {
            const page = await openLayout(layout);
            try {
                await openEditor(page, id);
                await typeAtEnd(page, 'x');
                await page.keyboard.press('Enter');
                await waitForIdle(page);
                assert.equal(
                    await page.evaluate(() => window.__rpcLog.filter(entry => entry.method === 'updateCell').length),
                    1,
                    'the edit was saved'
                );
                assert.deepEqual(await readFocus(page), { active: id, tabstops: [id] });
                await page.keyboard.press('ArrowDown');
                assert.deepEqual(await readFocus(page), { active: layout.below, tabstops: [layout.below] });
            } finally { await page.close(); }
        });

        it(`gives focus back to the cell after Escape cancels an edit in ${layout.name}`, async () => {
            const page = await openLayout(layout);
            try {
                await openEditor(page, id);
                await page.keyboard.type('discarded');
                await page.keyboard.press('Escape');
                await waitForIdle(page);
                assert.deepEqual(await readFocus(page), { active: id, tabstops: [id] });
                await page.keyboard.press('ArrowDown');
                assert.deepEqual(await readFocus(page), { active: layout.below, tabstops: [layout.below] });
                assert.equal(
                    await page.evaluate(() => window.__rpcLog.filter(entry => entry.method === 'updateCell').length),
                    0
                );
            } finally { await page.close(); }
        });

        it(`gives focus back to the cell when VS Code reloads the page after a commit in ${layout.name}`, async () => {
            const page = await openLayout(layout, true);
            try {
                const rowid = Number(await page.locator(`#${id}`).evaluate(cell => cell.closest('tr')!.dataset.rowid));
                await openEditor(page, id);
                await typeAtEnd(page, 'x');
                await page.keyboard.press('Enter');
                await waitForIdle(page);
                assert.equal(
                    await page.evaluate(() => window.__rpcLog.filter(entry => entry.method === 'fetchSchema').length),
                    2,
                    'the echo reloaded the page'
                );
                const cell = await cellOfRecord(page, rowid, layout.cell.colIdx);
                assert.ok(cell, 'the edited record is on the page');
                assert.match(await page.locator(`#${cell}`).innerText(), /x$/, 'the reload shows the saved value');
                assert.deepEqual(await readFocus(page), { active: cell, tabstops: [cell] });
                // The echo unpins rows, so the cell below is read from the new page.
                const below = await page.evaluate(colIdx => {
                    let next = document.activeElement!.closest('tr')!.nextElementSibling as HTMLElement | null;
                    while (next && !next.classList.contains('data-row')) next = next.nextElementSibling as HTMLElement | null;
                    return `cell-${next!.dataset.rowidx}-${colIdx}`;
                }, layout.cell.colIdx);
                await page.keyboard.press('ArrowDown');
                assert.equal((await readFocus(page)).active, below);
            } finally { await page.close(); }
        });
    }

    it('starts from the keyboard and moves on with Tab, then gives focus to the cell Escape leaves', async () => {
        const page = await openGrid({ columnCount: 4, rowCount: 200 });
        try {
            await page.locator('#cell-3-1').click();
            await page.keyboard.press('Enter');
            await page.locator('#cell-3-1 textarea.cell-input').waitFor({ timeout: 2000 });
            await typeAtEnd(page, 'x');
            await page.keyboard.press('Tab');
            await page.locator('#cell-3-2 textarea.cell-input').waitFor({ timeout: 2000 });
            assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('cell-input')), true);
            await page.keyboard.press('Escape');
            await waitForIdle(page);
            assert.deepEqual(await readFocus(page), { active: 'cell-3-2', tabstops: ['cell-3-2'] });
            await page.keyboard.press('ArrowLeft');
            assert.deepEqual(await readFocus(page), { active: 'cell-3-1', tabstops: ['cell-3-1'] });
        } finally { await page.close(); }
    });

    it('moves on with Tab when VS Code reloads the page after the commit', async () => {
        const page = await openGrid({ columnCount: 4, rowCount: 10, echo: true });
        try {
            await openEditor(page, 'cell-3-1');
            await typeAtEnd(page, 'x');
            await page.keyboard.press('Tab');
            await page.locator('#cell-3-2 textarea.cell-input').waitFor({ timeout: 2000 });
            await waitForIdle(page);
            assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('cell-input')), true);
            await page.keyboard.press('Escape');
            await waitForIdle(page);
            assert.deepEqual(await readFocus(page), { active: 'cell-3-2', tabstops: ['cell-3-2'] });
        } finally { await page.close(); }
    });

    it('follows the edited record when the reload moves it', async () => {
        const page = await openGrid({ columnCount: 4, rowCount: 10, echo: true });
        try {
            await page.evaluate(async () => {
                const harness = window.__focusHarness;
                harness.state.sortedColumn = 'c1';
                harness.state.sortAscending = true;
                await harness.loadTableData(false);
            });
            const id = (await cellOfRecord(page, 4, 1))!;
            await openEditor(page, id);
            await page.locator(`#${id} textarea.cell-input`).fill('zzz');
            await page.keyboard.press('Enter');
            await waitForIdle(page);
            const moved = await cellOfRecord(page, 4, 1);
            assert.notEqual(moved, id, 'sorted by c1, the record moved to the end');
            assert.deepEqual(await readFocus(page), { active: moved, tabstops: [moved] });
        } finally { await page.close(); }
    });

    it('follows the edited record to its new rowid when the edit changes it', async () => {
        const page = await openGrid({ columnCount: 4, rowCount: 10, echo: true });
        try {
            await openEditor(page, 'cell-3-0');
            await page.locator('#cell-3-0 textarea.cell-input').fill('400');
            await page.keyboard.press('Enter');
            await waitForIdle(page);
            const moved = await cellOfRecord(page, 400, 0);
            assert.equal(moved, 'cell-9-0', 'the reload lists the record last');
            assert.deepEqual(await readFocus(page), { active: moved, tabstops: [moved] });
        } finally { await page.close(); }
    });

    it('gives the row its new rowid when an edit changes it and no reload follows', async () => {
        // The web demo has no refresh echo: the edited row stays on screen.
        const page = await openGrid({ columnCount: 4, rowCount: 10 });
        try {
            await openEditor(page, 'cell-3-0');
            await page.locator('#cell-3-0 textarea.cell-input').fill('400');
            await page.keyboard.press('Enter');
            await waitForIdle(page);
            assert.equal(await page.locator('#row-3').getAttribute('data-rowid'), '400');
            // Clicks read the record from the row: the next edit of that row
            // must open on record 400, and its pin must name record 400.
            await openEditor(page, 'cell-3-1');
            assert.equal(await page.evaluate(() => (window.__focusHarness.state.editingCellInfo as { rowId?: unknown } | null)?.rowId), 400);
            await page.keyboard.press('Escape');
            await page.locator('#row-3 td.row-number .pin-icon').dispatchEvent('click');
            assert.deepEqual(await page.evaluate(() => [...window.__focusHarness.state.pinnedRowIds]), [400]);
        } finally { await page.close(); }
    });

    it('keeps focus at the edited position when the reload drops the record from the page', async () => {
        const page = await openGrid({ columnCount: 4, rowCount: 10, echo: true });
        try {
            await page.evaluate(async () => {
                const harness = window.__focusHarness;
                harness.state.columnFilters = { c1: 'c1-' };
                await harness.loadTableData(false);
            });
            await openEditor(page, 'cell-2-1');
            await page.locator('#cell-2-1 textarea.cell-input').fill('gone');
            await page.keyboard.press('Enter');
            await waitForIdle(page);
            assert.equal(await cellOfRecord(page, 3, 1), null, 'the record no longer matches the filter');
            assert.deepEqual(await readFocus(page), { active: 'cell-2-1', tabstops: ['cell-2-1'] });
            assert.equal(await page.locator('#row-2').getAttribute('data-rowid'), '4');
        } finally { await page.close(); }
    });

    it('parks focus on the grid when the edited row is out of the window by the time Escape ends the edit', async () => {
        const page = await openGrid({ columnCount: 4, rowCount: 200 });
        try {
            await openEditor(page, 'cell-2-1');
            // The open editor freezes the window; scrolling away leaves its row
            // in the DOM until the edit ends.
            await scrollGrid(page, { top: 3000 });
            assert.equal(await page.locator('#row-2').count(), 1);
            await page.keyboard.press('Escape');
            await waitForIdle(page);
            assert.equal(await page.locator('#row-2').count(), 0, 'the catch-up dropped the edited row');
            assert.equal((await readFocus(page)).active, 'gridContainer');
            await page.keyboard.press('ArrowDown');
            assert.deepEqual(await readFocus(page), { active: 'cell-3-1', tabstops: ['cell-3-1'] });
        } finally { await page.close(); }
    });

    it('parks focus on the grid when the edited column is out of the window by the time Enter commits', async () => {
        const page = await openGrid({ columnCount: 300, rowCount: 10 });
        try {
            await openEditor(page, 'cell-1-3');
            // Typing scrolls the caret into view, so type before scrolling away.
            await typeAtEnd(page, 'x');
            await scrollGrid(page, { left: 8000 });
            await page.keyboard.press('Enter');
            await waitForIdle(page);
            assert.equal(await page.locator('#cell-1-3').count(), 0, 'the catch-up dropped the edited column');
            assert.equal((await readFocus(page)).active, 'gridContainer');
            // Scrolling back builds the cell, which takes focus back.
            await scrollGrid(page, { left: 0 });
            assert.deepEqual(await readFocus(page), { active: 'cell-1-3', tabstops: ['cell-1-3'] });
        } finally { await page.close(); }
    });

    it('parks focus on the grid when a VS Code reload finds the edited row out of the window', async () => {
        const page = await openGrid({ columnCount: 4, rowCount: 200, echo: true });
        try {
            await openEditor(page, 'cell-2-1');
            await typeAtEnd(page, 'x');
            await scrollGrid(page, { top: 3000 });
            await page.keyboard.press('Enter');
            await waitForIdle(page);
            assert.equal(await page.locator('#row-2').count(), 0);
            assert.equal((await readFocus(page)).active, 'gridContainer');
            await page.keyboard.press('ArrowDown');
            assert.deepEqual(await readFocus(page), { active: 'cell-3-1', tabstops: ['cell-3-1'] });
        } finally { await page.close(); }
    });

    for (const echo of [false, true]) {
        const reload = echo ? ' and VS Code reloads the page' : '';

        it(`keeps focus on the cell a click moved it to while the edit commits${reload}`, async () => {
            const page = await openGrid({ columnCount: 4, rowCount: 10, echo });
            try {
                await openEditor(page, 'cell-5-2');
                await typeAtEnd(page, 'x');
                await page.locator('#cell-1-1').click();
                // The blur commit runs 100 ms later.
                await page.waitForFunction(() => window.__rpcLog.some(entry => entry.method === 'updateCell'), undefined, { timeout: 2000 });
                await waitForIdle(page);
                assert.deepEqual(await readFocus(page), { active: 'cell-1-1', tabstops: ['cell-1-1'] });
            } finally { await page.close(); }
        });

        it(`keeps focus in the filter box a click moved it to while the edit commits${reload}`, async () => {
            const page = await openGrid({ columnCount: 4, rowCount: 10, echo });
            try {
                await openEditor(page, 'cell-5-2');
                await typeAtEnd(page, 'x');
                await page.locator('#filterInput').click();
                await page.waitForFunction(() => window.__rpcLog.some(entry => entry.method === 'updateCell'), undefined, { timeout: 2000 });
                await waitForIdle(page);
                assert.equal((await readFocus(page)).active, 'filterInput');
            } finally { await page.close(); }
        });

        it(`leaves focus off the grid after a click on a part of the page that takes no focus${reload}`, async () => {
            const page = await openGrid({ columnCount: 4, rowCount: 10, echo });
            try {
                await openEditor(page, 'cell-5-2');
                await typeAtEnd(page, 'x');
                await page.locator('#statusText').click();
                await page.waitForFunction(() => window.__rpcLog.some(entry => entry.method === 'updateCell'), undefined, { timeout: 2000 });
                await waitForIdle(page);
                assert.equal((await readFocus(page)).active, 'BODY');
            } finally { await page.close(); }
        });
    }

    // VS Code puts its theme colors on <html> and a theme class on <body>.
    const themes = [
        { bodyClass: 'vscode-light', focusBorder: 'rgb(0, 144, 241)' },
        { bodyClass: 'vscode-dark', focusBorder: 'rgb(0, 127, 212)' },
        { bodyClass: 'vscode-high-contrast', focusBorder: 'rgb(243, 133, 24)' }
    ];

    async function applyTheme(page: Page, theme: typeof themes[number]) {
        await page.evaluate(({ bodyClass, focusBorder }) => {
            document.body.classList.remove('vscode-light', 'vscode-dark', 'vscode-high-contrast');
            document.body.classList.add(bodyClass);
            document.documentElement.style.setProperty('--vscode-focusBorder', focusBorder);
        }, theme);
    }

    /**
     * The container's border, and every color painted along each of its four edges, both pixels deep
     * and from corner to corner. A ring drawn inside the container had a gap at every row line, and
     * cell text over its right and bottom edges, which a look at each edge's midpoint missed.
     */
    async function readContainerRing(page: Page) {
        const box = await page.evaluate(() => {
            const rect = document.getElementById('gridContainer')!.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        });
        const png = await page.screenshot({ clip: box });
        const edges = await page.evaluate(async ({ data, width, height }) => {
            const image = new Image();
            image.src = `data:image/png;base64,${data}`;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext('2d')!;
            context.drawImage(image, 0, 0);
            const scale = image.width / width;
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            const at = (x: number, y: number) => {
                const offset = (Math.floor(y * scale) * canvas.width + Math.floor(x * scale)) * 4;
                return `rgb(${pixels[offset]}, ${pixels[offset + 1]}, ${pixels[offset + 2]})`;
            };
            const along = (length: number, color: (position: number) => string): string[] => {
                const seen = new Set<string>();
                for (let position = 0; position < Math.floor(length); position++) seen.add(color(position));
                return [...seen].sort();
            };
            const colors = (...lines: string[][]): string[] => [...new Set(lines.flat())].sort();
            return {
                top: colors(along(width, x => at(x, 0)), along(width, x => at(x, 1))),
                bottom: colors(along(width, x => at(x, height - 1)), along(width, x => at(x, height - 2))),
                left: colors(along(height, y => at(0, y)), along(height, y => at(1, y))),
                right: colors(along(height, y => at(width - 1, y)), along(height, y => at(width - 2, y)))
            };
        }, { data: png.toString('base64'), width: box.width, height: box.height });
        const style = await page.evaluate(() => {
            const container = document.getElementById('gridContainer')!;
            const computed = getComputedStyle(container);
            return {
                focused: document.activeElement === container,
                focusVisible: container.matches(':focus-visible'),
                border: [computed.borderTopColor, computed.borderRightColor, computed.borderBottomColor, computed.borderLeftColor]
                    .map(color => `${computed.borderTopStyle} ${computed.borderTopWidth} ${color}`)
            };
        });
        return { ...style, edges };
    }

    for (const theme of themes) {
        it(`rings the grid in the ${theme.bodyClass} focus color while keyboard focus is parked on it`, async () => {
            const page = await openGrid({ columnCount: 300, rowCount: 200 });
            try {
                await applyTheme(page, theme);
                await page.evaluate(() => {
                    const harness = window.__focusHarness;
                    harness.state.pinnedRowIds.add(5);
                    harness.state.pinnedColumns.add('c250');
                    harness.renderDataGrid();
                });
                await page.locator('#cell-2-3').click();
                await page.keyboard.press('ArrowRight');
                assert.equal((await readFocus(page)).active, 'cell-2-4');
                await scrollGrid(page, { top: 3000, left: 8000 });
                const ring = await readContainerRing(page);
                assert.deepEqual(
                    { focused: ring.focused, focusVisible: ring.focusVisible, border: ring.border },
                    { focused: true, focusVisible: true, border: Array(4).fill(`solid 2px ${theme.focusBorder}`) }
                );
                // Nothing else is painted anywhere along it: not the sticky header, a pinned row or column,
                // a row line, cell text or a scrollbar.
                assert.deepEqual(ring.edges, {
                    top: [theme.focusBorder],
                    bottom: [theme.focusBorder],
                    left: [theme.focusBorder],
                    right: [theme.focusBorder]
                });
            } finally { await page.close(); }
        });
    }

    it('shows no ring on the grid when a mouse click focused the cell that was parked', async () => {
        const page = await openGrid({ columnCount: 300, rowCount: 200 });
        try {
            await applyTheme(page, themes[1]);
            await page.locator('#cell-2-3').click();
            await scrollGrid(page, { top: 3000, left: 8000 });
            const ring = await readContainerRing(page);
            assert.equal(ring.focused, true, 'focus is parked on the grid');
            assert.equal(ring.focusVisible, false);
            assert.ok(ring.border.every(border => border === 'solid 2px rgba(0, 0, 0, 0)'), JSON.stringify(ring.border));
            assert.ok(Object.values(ring.edges).every(colors => !colors.includes(themes[1].focusBorder)), JSON.stringify(ring.edges));
        } finally { await page.close(); }
    });

    it('shows no ring on the grid when a mouse click on empty grid area focuses it', async () => {
        const page = await openGrid({ columnCount: 300, rowCount: 5 });
        try {
            await applyTheme(page, themes[1]);
            // The container takes focus while it holds the tab stop, which it
            // does while the tab stop's cell is out of the window.
            await page.locator('#cell-0-3').click();
            await page.locator('#filterInput').focus();
            await scrollGrid(page, { left: 8000 });
            const box = (await page.locator('#gridContainer').boundingBox())!;
            await page.mouse.click(box.x + box.width / 2, box.y + box.height - 30);
            const ring = await readContainerRing(page);
            assert.equal(ring.focused, true, 'the click focused the grid');
            assert.equal(ring.focusVisible, false);
            assert.ok(ring.border.every(border => border === 'solid 2px rgba(0, 0, 0, 0)'), JSON.stringify(ring.border));
        } finally { await page.close(); }
    });
});
