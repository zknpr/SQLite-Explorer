import './vscode_mock_setup';

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import esbuild from 'esbuild';
import { chromium, type BrowserContext, type Page } from 'playwright-core';

// An inline editor opened while a filter load is pending, on a page small
// enough to render in full (no row or column window). Focus and the rendered
// rows can only be checked in a real browser.

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
        __filterEditHarness: {
            state: {
                gridData: unknown[][];
                tableColumns: { name: string }[];
                isGridReloading: boolean;
                isLoadingColumns: boolean;
                editingCellInfo: unknown;
                filterTimer: unknown;
                filterApplyPending: boolean;
                filterPendingAction: unknown;
                filterQuery: string;
            };
            loadTableData(showSpinner?: boolean): Promise<unknown>;
            getVirtualColumnBounds(): { start: number; end: number } | null;
            getVirtualWindowBounds(): { start: number; end: number } | null;
            startCellEdit(rowIdx: number, colIdx: number, rowId: number): void;
        };
        /** Row ids the mocked table holds; tests replace it to change the next page. */
        __rowIds: number[];
        /** Every RPC the viewer sent, in order. */
        __rpcLog: { method: string; payload: unknown[] }[];
        /** While true, row and count replies wait for __releaseHeld(). */
        __holdLoads: boolean;
        __heldReplies: (() => void)[];
        __releaseHeld(): void;
    }
}

const COLUMNS = ['id', 'c1', 'c2', 'c3'];

describe('grid filter load during an inline edit', {
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
                    import { loadTableData } from './core/ui/modules/grid-data.js';
                    import { getVirtualColumnBounds, getVirtualWindowBounds } from './core/ui/modules/grid-render.js';
                    import { startCellEdit } from './core/ui/modules/edit.js';
                    window.__filterEditHarness = { state, loadTableData, getVirtualColumnBounds, getVirtualWindowBounds, startCellEdit };
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
        profile = mkdtempSync(path.join(root, '.tmp', 'ui-filter-edit-test-'));
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

    async function openGrid(rowCount = 30): Promise<Page> {
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error));
        const install = ({ columnNames, rowCount }: { columnNames: string[]; rowCount: number }) => {
            const columns = columnNames.map((identifier, index) => ({
                ordinal: index,
                identifier,
                declaredType: index === 0 ? 'INTEGER' : 'TEXT',
                primaryKeyPosition: index === 0 ? 1 : 0,
                isRowidAlias: index === 0,
                isRequired: false,
                defaultExpression: null
            }));
            window.__rowIds = Array.from({ length: rowCount }, (_, index) => index + 1);
            window.__rpcLog = [];
            window.__holdLoads = false;
            window.__heldReplies = [];
            window.__releaseHeld = () => {
                window.__holdLoads = false;
                for (const reply of window.__heldReplies.splice(0)) reply();
            };
            const rowFor = (id: number) => [id, id, ...columns.slice(1).map(column => `${column.identifier}-${id}`)];
            // The engine's filters, closely enough: case-insensitive substring
            // over the displayed columns.
            type FilterOptions = { filters?: { column: string; value: string }[]; globalFilter?: string };
            const matchingRows = (options: FilterOptions) => {
                const contains = (value: unknown, term: string) => String(value).toLowerCase().includes(term.toLowerCase());
                return window.__rowIds.map(rowFor).filter(row => {
                    const named = new Map(columns.map((column, index) => [column.identifier, row[index + 1]]));
                    if (options.globalFilter && !columns.some(column => contains(named.get(column.identifier), options.globalFilter!))) {
                        return false;
                    }
                    return (options.filters ?? []).every(filter => contains(named.get(filter.column), filter.value));
                });
            };
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
                        else if (targetMethod === 'fetchSchema') data = { tables: [{ identifier: 'items' }], views: [], indexes: [] };
                        else if (targetMethod === 'getTableInfo') data = columns;
                        else if (targetMethod === 'fetchTableCount') {
                            data = { count: matchingRows(payload[1] as FilterOptions).length, isExact: true };
                        } else if (targetMethod === 'fetchTableData') {
                            const options = payload[1] as FilterOptions & { offset: number; limit: number };
                            data = { rows: matchingRows(options).slice(options.offset, options.offset + options.limit) };
                        } else if (targetMethod === 'updateCell') data = undefined;
                        else if (targetMethod === 'saveSidebarState') data = undefined;
                        else throw new Error(`Unexpected viewer RPC: ${targetMethod}`);
                        const reply = () => window.dispatchEvent(new MessageEvent('message', {
                            data: { channel: 'rpc', content: { kind: 'response', messageId, success: true, data } }
                        }));
                        if (window.__holdLoads && (targetMethod === 'fetchTableData' || targetMethod === 'fetchTableCount')) {
                            window.__heldReplies.push(reply);
                        } else {
                            queueMicrotask(reply);
                        }
                    }
                })
            });
        };
        await page.addInitScript({ content: `
            globalThis.__name = value => value;
            (${install.toString()})(${JSON.stringify({ columnNames: COLUMNS, rowCount })});
        ` });
        await page.goto('https://sqlite-explorer.test/viewer');
        await page.waitForFunction(() => !!window.__filterEditHarness
            && window.__filterEditHarness.state.gridData.length > 0
            && !window.__filterEditHarness.state.isGridReloading
            && !window.__filterEditHarness.state.isLoadingColumns, undefined, { timeout: 10000 });
        // The cases below are about pages that render in full: no row window,
        // no column window.
        assert.deepEqual(await page.evaluate(() => ({
            rows: window.__filterEditHarness.getVirtualWindowBounds(),
            columns: window.__filterEditHarness.getVirtualColumnBounds()
        })), { rows: null, columns: null });
        return page;
    }

    function nextFrames(page: Page) {
        return page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }

    /** The rendered data rows against the committed page. */
    function readRows(page: Page) {
        return page.evaluate(() => {
            const rows = [...document.querySelectorAll<HTMLElement>('#gridContainer tbody tr.data-row')];
            const data = window.__filterEditHarness.state.gridData;
            return {
                domCount: rows.length,
                dataCount: data.length,
                domFirst: rows[0]?.dataset.rowid ?? null,
                domLast: rows.at(-1)?.dataset.rowid ?? null,
                dataFirst: data.length ? String(data[0][0]) : null,
                dataLast: data.length ? String(data.at(-1)![0]) : null
            };
        });
    }

    function assertRowsMatchData(rows: Awaited<ReturnType<typeof readRows>>) {
        assert.deepEqual(
            { count: rows.domCount, first: rows.domFirst, last: rows.domLast },
            { count: rows.dataCount, first: rows.dataFirst, last: rows.dataLast },
            'the rendered rows must be the committed page'
        );
    }

    /** Count tables put into the grid container from now on (one per full render). */
    function countRenders(page: Page) {
        return page.evaluate(() => {
            (window as any).__renders = 0;
            new MutationObserver(records => {
                for (const record of records) {
                    for (const node of record.addedNodes) {
                        if ((node as Element).tagName === 'TABLE') (window as any).__renders++;
                    }
                }
            }).observe(document.getElementById('gridContainer')!, { childList: true });
        });
    }

    it('keeps the inline editor focused and unsaved when a pending filter load completes', async () => {
        const page = await openGrid();
        try {
            // Everything up to the open editor runs in one task, so the
            // editor provably opens inside the 300 ms filter debounce.
            const opened = await page.evaluate(() => {
                const { state } = window.__filterEditHarness;
                window.__holdLoads = true;
                const filter = document.getElementById('filterInput') as HTMLInputElement;
                filter.focus();
                filter.value = 'c1-2';
                filter.dispatchEvent(new Event('input', { bubbles: true }));
                const debouncePending = state.filterTimer !== null && state.filterApplyPending;
                document.getElementById('cell-5-2')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
                const editor = document.querySelector<HTMLTextAreaElement>('#cell-5-2 textarea.cell-input');
                (window as any).__editorBlurs = 0;
                editor?.addEventListener('blur', () => { (window as any).__editorBlurs++; });
                return {
                    debouncePending,
                    stillPending: state.filterTimer !== null,
                    editorFocused: !!editor && document.activeElement === editor,
                    value: editor?.value
                };
            });
            assert.deepEqual(opened, { debouncePending: true, stillPending: true, editorFocused: true, value: 'c2-6' });

            await page.keyboard.press('End');
            await page.keyboard.type('abc');
            // The debounce fires on its own; its load then waits for the test.
            await page.waitForFunction(() => window.__heldReplies.length > 0, undefined, { timeout: 5000 });
            assert.equal(await page.evaluate(() => window.__filterEditHarness.state.isGridReloading), true);
            await page.evaluate(() => window.__releaseHeld());
            await page.waitForFunction(() => {
                const { state } = window.__filterEditHarness;
                return !state.isGridReloading && !state.filterApplyPending && state.filterPendingAction === null;
            }, undefined, { timeout: 5000 });
            assert.equal(
                await page.evaluate(() => window.__filterEditHarness.state.gridData.length),
                11,
                'the filtered page committed'
            );

            await page.keyboard.type('def');
            // Well past the 100 ms deferred save a blur would schedule.
            await page.waitForTimeout(400);
            const after = await page.evaluate(() => {
                const active = document.activeElement as HTMLElement;
                const editor = document.querySelector<HTMLTextAreaElement>('#cell-5-2 textarea.cell-input');
                return {
                    active: active.id || `${active.tagName.toLowerCase()}.${active.className}`,
                    editorValue: editor?.value ?? null,
                    blurs: (window as any).__editorBlurs,
                    filterValue: (document.getElementById('filterInput') as HTMLInputElement).value,
                    filterQuery: window.__filterEditHarness.state.filterQuery,
                    editing: window.__filterEditHarness.state.editingCellInfo !== null,
                    updates: window.__rpcLog.filter(entry => entry.method === 'updateCell').map(entry => entry.payload)
                };
            });
            assert.deepEqual(after, {
                active: 'textarea.cell-input',
                editorValue: 'c2-6abcdef',
                blurs: 0,
                filterValue: 'c1-2',
                filterQuery: 'c1-2',
                editing: true,
                updates: []
            });

            // Ending the edit renders the page the filter committed meanwhile.
            await page.keyboard.press('Escape');
            await nextFrames(page);
            assertRowsMatchData(await readRows(page));
            assert.equal((await readRows(page)).domFirst, '2');
            assert.equal(await page.evaluate(() => window.__rpcLog.filter(entry => entry.method === 'updateCell').length), 0);
        } finally { await page.close(); }
    });

    it('renders a page committed under an inline editor once the edit ends, exactly once', async () => {
        const page = await openGrid();
        try {
            const during = await page.evaluate(async () => {
                const { state, loadTableData } = window.__filterEditHarness;
                document.getElementById('cell-5-2')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
                // A refresh lands while the editor is open (here: another
                // writer replaced the table's rows).
                window.__rowIds = Array.from({ length: 12 }, (_, index) => 101 + index);
                await loadTableData(false);
                return {
                    editorAlive: document.activeElement?.classList.contains('cell-input') ?? false,
                    dataCount: state.gridData.length
                };
            });
            assert.deepEqual(during, { editorAlive: true, dataCount: 12 });

            await countRenders(page);
            await page.keyboard.press('Escape');
            await nextFrames(page);
            const rows = await readRows(page);
            assertRowsMatchData(rows);
            assert.deepEqual([rows.domFirst, rows.domLast], ['101', '112']);
            // Further window revalidations (scroll, resize) find nothing to do.
            await page.evaluate(() => document.getElementById('gridContainer')!.dispatchEvent(new Event('scroll')));
            await nextFrames(page);
            assert.equal(await page.evaluate(() => (window as any).__renders), 1);

            await page.locator('#cell-0-1').dblclick();
            const editor = page.locator('#cell-0-1 textarea.cell-input');
            await editor.waitFor({ timeout: 2000 });
            assert.equal(await editor.inputValue(), 'c1-101');
            assert.equal(await page.locator('#row-0').getAttribute('data-rowid'), '101');
            await page.keyboard.press('Escape');
        } finally { await page.close(); }
    });

    it('opens the next editor on the committed page when it starts before a frame', async () => {
        const page = await openGrid();
        try {
            // Tab-to-next starts the next editor in the same task that ends
            // the first one, with a row id read from the committed page.
            const next = await page.evaluate(async () => {
                const { state, loadTableData, startCellEdit } = window.__filterEditHarness;
                document.getElementById('cell-5-2')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
                window.__rowIds = Array.from({ length: 12 }, (_, index) => 101 + index);
                await loadTableData(false);
                document.querySelector('#cell-5-2 textarea.cell-input')!
                    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                startCellEdit(0, 1, state.gridData[0][0] as number);
                const editor = document.querySelector<HTMLTextAreaElement>('textarea.cell-input');
                return {
                    editorRowId: (editor?.closest('tr') as HTMLElement | null)?.dataset.rowid ?? null,
                    editorValue: editor?.value ?? null,
                    domRows: document.querySelectorAll('#gridContainer tbody tr.data-row').length
                };
            });
            assert.deepEqual(next, { editorRowId: '101', editorValue: 'c1-101', domRows: 12 });
            await page.keyboard.press('Escape');
            await nextFrames(page);
            assertRowsMatchData(await readRows(page));
        } finally { await page.close(); }
    });

    it('refuses an editor for a row that is no longer at the clicked position', async () => {
        const page = await openGrid();
        try {
            const result = await page.evaluate(async () => {
                const { state, loadTableData } = window.__filterEditHarness;
                document.getElementById('cell-5-2')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
                window.__rowIds = Array.from({ length: 12 }, (_, index) => 101 + index);
                await loadTableData(false);
                // The open editor keeps the old rows on screen. A double-click
                // on one of them names row 3, but position 2 of the committed
                // page is row 103: an editor there would show row 103's value
                // and save it to row 3.
                window.__rpcLog.length = 0;
                document.getElementById('cell-2-1')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
                const editor = document.querySelector<HTMLTextAreaElement>('textarea.cell-input');
                return {
                    editingRowId: (state.editingCellInfo as { rowId?: unknown } | null)?.rowId ?? null,
                    editorValue: editor?.value ?? null,
                    status: document.getElementById('statusText')?.textContent ?? null
                };
            });
            assert.deepEqual(
                { editingRowId: result.editingRowId, editorValue: result.editorValue },
                { editingRowId: null, editorValue: null }
            );
            assert.match(String(result.status), /rows changed/i);
            // The committed page is on screen now, and the same double-click
            // opens the record that is really there.
            await nextFrames(page);
            assertRowsMatchData(await readRows(page));
            await page.locator('#cell-2-1').dblclick();
            const editor = page.locator('#cell-2-1 textarea.cell-input');
            await editor.waitFor({ timeout: 2000 });
            assert.equal(await editor.inputValue(), 'c1-103');
            assert.equal(await page.evaluate(() => (window.__filterEditHarness.state.editingCellInfo as { rowId?: unknown } | null)?.rowId), 103);
            await page.keyboard.press('Escape');
            assert.deepEqual(
                await page.evaluate(() => window.__rpcLog.filter(entry => entry.method === 'updateCell')),
                []
            );
        } finally { await page.close(); }
    });

    it('does not re-render when an edit ends without a commit under it', async () => {
        const page = await openGrid();
        try {
            await page.locator('#cell-3-1').dblclick();
            await page.locator('#cell-3-1 textarea.cell-input').waitFor({ timeout: 2000 });
            await countRenders(page);
            await page.keyboard.press('Escape');
            await nextFrames(page);
            await page.evaluate(() => document.getElementById('gridContainer')!.dispatchEvent(new Event('scroll')));
            await nextFrames(page);
            assert.equal(await page.evaluate(() => (window as any).__renders), 0);
            assertRowsMatchData(await readRows(page));
        } finally { await page.close(); }
    });
});
