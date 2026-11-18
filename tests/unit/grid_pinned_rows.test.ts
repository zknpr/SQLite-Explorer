import './vscode_mock_setup';

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import esbuild from 'esbuild';
import { chromium, type BrowserContext, type Page } from 'playwright-core';

// Pinned rows across the host's refreshContent echo, in the real viewer bundle.
// The mocked host keeps a table and a history and posts the echo the way
// editorController does: before the mutation reply, naming the records the
// change removed or moved to another rowid.

const root = path.resolve(__dirname, '../..');
const browserPath = [
    process.env.SQLITE_EXPLORER_CHROMIUM_PATH,
    chromium.executablePath(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe')
].find(candidate => candidate && existsSync(candidate));

type RowIdentityChange = { table: string; removedRowIds: number[]; movedRowIds: [number, number][] };

declare global {
    interface Window {
        __pinHarness: {
            state: {
                gridData: unknown[][];
                isGridReloading: boolean;
                isLoadingColumns: boolean;
                isSavingCell: boolean;
                contentRefreshPromise: unknown;
                pinnedRowIds: Set<number>;
                selectedTable: string;
                sortedColumn: string | null;
                sortAscending: boolean;
                columnFilters: Record<string, string>;
                currentPageIndex: number;
            };
            loadTableData(showSpinner?: boolean): Promise<unknown>;
            goToPage(pageIndex: number, navIntent: string): void;
            selectTableItem(name: string, type: string): Promise<void>;
        };
        /** The mocked host: its own edits, and VS Code's undo and redo of the last ones. */
        __host: {
            insert(id: number): void;
            remove(ids: number[]): void;
            undo(): void;
            redo(): void;
            /** Post an echo as given, for the cases the history does not describe. */
            echo(connection: unknown, change: unknown): void;
        };
    }
}

describe('pinned rows across host refreshes', {
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
                    import { goToPage } from './core/ui/modules/grid-actions.js';
                    import { selectTableItem } from './core/ui/modules/sidebar.js';
                    window.__pinHarness = { state, loadTableData, goToPage, selectTableItem };
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
        profile = mkdtempSync(path.join(root, '.tmp', 'ui-pinned-rows-test-'));
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

    async function openGrid({ rowCount = 10, rowsPerPage = 500 } = {}): Promise<Page> {
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error));
        const install = ({ rowCount, rowsPerPage }: { rowCount: number; rowsPerPage: number }) => {
            const columns = ['id', 'name'].map((identifier, index) => ({
                ordinal: index,
                identifier,
                declaredType: index === 0 ? 'INTEGER' : 'TEXT',
                primaryKeyPosition: index === 0 ? 1 : 0,
                isRowidAlias: index === 0,
                isRequired: false,
                defaultExpression: null
            }));
            // rowid -> name, per table; 'items' is edited, 'other' is switched to.
            const tables = new Map<string, Map<number, string>>([
                ['items', new Map(Array.from({ length: rowCount }, (_, index) => [index + 1, `name-${index + 1}`]))],
                ['other', new Map([[1, 'other-1'], [2, 'other-2']])]
            ]);
            type Change = { type: 'cell_update' | 'row_insert' | 'row_delete'; apply(): RowIdentityChange; revert(): RowIdentityChange };
            const done: Change[] = [];
            const undone: Change[] = [];
            const identity = (removedRowIds: number[] = [], movedRowIds: [number, number][] = []) => ({
                table: 'items', removedRowIds, movedRowIds
            });
            let correlation = 0;
            const echo = (connection: unknown, change: unknown) => {
                window.dispatchEvent(new MessageEvent('message', {
                    data: {
                        kind: 'invoke',
                        correlationId: `host_${++correlation}`,
                        methodName: 'refreshContent',
                        parameters: ['items.db', connection, change]
                    }
                }));
            };
            const record = (change: Change) => {
                const rowIdentity = change.apply();
                done.push(change);
                undone.length = 0;
                echo(undefined, { modificationType: change.type, rowIdentity });
            };
            const items = tables.get('items')!;
            const cellUpdate = (rowId: number, column: string, value: unknown): Change => {
                const prior = items.get(rowId)!;
                const newId = column === 'id' ? Number(value) : rowId;
                const move = (from: number, to: number, name: string) => {
                    items.delete(from);
                    items.set(to, name);
                    return identity([], from === to ? [] : [[from, to]]);
                };
                return {
                    type: 'cell_update',
                    apply: () => move(rowId, newId, column === 'name' ? String(value) : prior),
                    revert: () => move(newId, rowId, prior)
                };
            };
            window.__host = {
                insert(id) {
                    record({
                        type: 'row_insert',
                        apply: () => { items.set(id, `name-${id}`); return identity(); },
                        revert: () => { items.delete(id); return identity([id]); }
                    });
                },
                remove(ids) {
                    const names = ids.map(id => items.get(id)!);
                    record({
                        type: 'row_delete',
                        apply: () => { ids.forEach(id => items.delete(id)); return identity(ids); },
                        revert: () => { ids.forEach((id, index) => items.set(id, names[index])); return identity(); }
                    });
                },
                undo() {
                    const change = done.pop()!;
                    undone.push(change);
                    echo(undefined, { modificationType: change.type, rowIdentity: change.revert() });
                },
                redo() {
                    const change = undone.pop()!;
                    done.push(change);
                    echo(undefined, { modificationType: change.type, rowIdentity: change.apply() });
                },
                echo
            };
            type QueryOptions = {
                offset: number;
                limit: number;
                orderBy?: string | null;
                orderDir?: string;
                filters?: { column: string; value: string }[];
            };
            const matchingRows = (table: string, options: QueryOptions) => {
                let rows = [...tables.get(table)!.entries()]
                    .map(([rowid, name]) => [rowid, rowid, name])
                    .filter(row => (options.filters ?? []).every(filter => (
                        String(row[filter.column === 'id' ? 1 : 2]).toLowerCase().includes(filter.value.toLowerCase())
                    )))
                    .sort((a, b) => Number(a[0]) - Number(b[0]));
                if (options.orderBy) {
                    const at = options.orderBy === 'id' ? 1 : 2;
                    const direction = options.orderDir === 'DESC' ? -1 : 1;
                    rows = rows.sort((a, b) => direction * String(a[at]).localeCompare(String(b[at])));
                }
                return rows;
            };
            Object.assign(window, {
                acquireVsCodeApi: () => ({
                    getState: () => ({ selectedTable: 'items', selectedTableType: 'table', rowsPerPage }),
                    setState() {},
                    postMessage(message: { channel?: string; content?: { kind: string; messageId: string; targetMethod: string; payload: unknown[] } }) {
                        if (message.channel !== 'rpc' || message.content?.kind !== 'invoke') return;
                        const { messageId, targetMethod, payload } = message.content;
                        let data: unknown;
                        if (targetMethod === 'initialize') {
                            data = { connected: true, readOnly: false, connectionGeneration: 1, cellEditBehavior: 'inline' };
                        } else if (targetMethod === 'ping') data = true;
                        else if (targetMethod === 'fetchSchema') {
                            data = { tables: [{ identifier: 'items' }, { identifier: 'other' }], views: [], indexes: [], hasTriggers: false };
                        } else if (targetMethod === 'getTableInfo') data = columns;
                        else if (targetMethod === 'fetchTableCount') {
                            data = { count: matchingRows(payload[0] as string, payload[1] as QueryOptions).length, isExact: true };
                        } else if (targetMethod === 'fetchTableData') {
                            const query = payload[1] as QueryOptions;
                            data = { rows: matchingRows(payload[0] as string, query).slice(query.offset, query.offset + query.limit) };
                        } else if (targetMethod === 'updateCell') {
                            const [, rowId, column, value] = payload as [string, number, string, unknown];
                            // VS Code posts the document change to every panel
                            // before the mutation reply.
                            record(cellUpdate(rowId, column, value));
                            data = column === 'id' ? Number(value) : rowId;
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
            (${install.toString()})(${JSON.stringify({ rowCount, rowsPerPage })});
        ` });
        await page.goto('https://sqlite-explorer.test/viewer');
        await waitForIdle(page);
        return page;
    }

    async function waitForIdle(page: Page) {
        await page.waitForFunction(() => {
            const harness = window.__pinHarness;
            return !!harness
                && harness.state.gridData.length > 0
                && !harness.state.isGridReloading
                && !harness.state.isLoadingColumns
                && !harness.state.isSavingCell
                && !harness.state.contentRefreshPromise;
        }, undefined, { timeout: 10000 });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }

    /** The pinned record ids in state, and the rows the grid shows pinned, in display order. */
    function readPins(page: Page) {
        return page.evaluate(() => ({
            state: [...window.__pinHarness.state.pinnedRowIds].sort((a, b) => a - b),
            shown: [...document.querySelectorAll<HTMLElement>('#gridContainer tr.data-row.pinned')]
                .map(tr => Number(tr.dataset.rowid))
        }));
    }

    async function pin(page: Page, rowid: number) {
        // The pin button has no size until its icon font loads, which this page
        // does not serve; dispatch the click its handler listens for.
        await page.locator(`#gridContainer tr.data-row[data-rowid="${rowid}"] td.row-number .pin-icon`).dispatchEvent('click');
        await waitForIdle(page);
    }

    /** Edit a cell of a record through the inline editor; the mocked host echoes before replying. */
    async function editCell(page: Page, rowid: number, colIdx: number, value: string) {
        const cell = page.locator(`#gridContainer tr.data-row[data-rowid="${rowid}"] td[data-colidx="${colIdx}"]`);
        await cell.dblclick();
        const editor = page.locator('#gridContainer textarea.cell-input');
        await editor.waitFor({ timeout: 2000 });
        await editor.fill(value);
        await page.keyboard.press('Enter');
        await waitForIdle(page);
    }

    async function host(page: Page, action: (host: Window['__host']) => void) {
        await page.evaluate(`(${action.toString()})(window.__host)`);
        await waitForIdle(page);
    }

    it('keeps pins on their records across the echo of edits, undo, redo, inserts and deletes', async () => {
        const page = await openGrid();
        try {
            await pin(page, 3);
            await pin(page, 5);
            assert.deepEqual(await readPins(page), { state: [3, 5], shown: [3, 5] });

            await editCell(page, 5, 1, 'renamed');
            assert.deepEqual(await readPins(page), { state: [3, 5], shown: [3, 5] }, 'after a cell edit');
            await host(page, h => h.undo());
            assert.deepEqual(await readPins(page), { state: [3, 5], shown: [3, 5] }, 'after its undo');
            await host(page, h => h.redo());
            assert.deepEqual(await readPins(page), { state: [3, 5], shown: [3, 5] }, 'after its redo');

            await host(page, h => h.insert(11));
            assert.deepEqual(await readPins(page), { state: [3, 5], shown: [3, 5] }, 'after another row was inserted');
            await host(page, h => h.remove([7]));
            assert.deepEqual(await readPins(page), { state: [3, 5], shown: [3, 5] }, 'after another row was deleted');
            await host(page, h => h.undo());
            assert.deepEqual(await readPins(page), { state: [3, 5], shown: [3, 5] }, 'after that delete was undone');
            await host(page, h => h.undo());
            assert.deepEqual(await readPins(page), { state: [3, 5], shown: [3, 5] }, 'after that insert was undone');
        } finally { await page.close(); }
    });

    it('moves a pin with its record when an edit, its undo or its redo changes the rowid', async () => {
        const page = await openGrid();
        try {
            await pin(page, 3);
            await pin(page, 5);
            await editCell(page, 5, 0, '500');
            assert.deepEqual(await readPins(page), { state: [3, 500], shown: [3, 500] }, 'after the edit');
            assert.equal(await page.locator('#gridContainer tr.data-row[data-rowid="500"] td[data-colidx="1"]').innerText(), 'name-5');
            await host(page, h => h.undo());
            assert.deepEqual(await readPins(page), { state: [3, 5], shown: [3, 5] }, 'after its undo');
            await host(page, h => h.redo());
            assert.deepEqual(await readPins(page), { state: [3, 500], shown: [3, 500] }, 'after its redo');
        } finally { await page.close(); }
    });

    it('drops a pin when its record is deleted, and does not give it to a record that reuses the rowid', async () => {
        const page = await openGrid();
        try {
            await pin(page, 3);
            await pin(page, 5);
            await host(page, h => h.remove([3]));
            assert.deepEqual(await readPins(page), { state: [5], shown: [5] }, 'after the pinned record was deleted');
            await host(page, h => h.insert(3));
            assert.deepEqual(await readPins(page), { state: [5], shown: [5] }, 'a new record with rowid 3 is not pinned');

            // A record inserted and pinned, then removed by undoing its insert.
            await host(page, h => h.insert(20));
            await pin(page, 20);
            assert.deepEqual(await readPins(page), { state: [5, 20], shown: [5, 20] });
            await host(page, h => h.undo());
            assert.deepEqual(await readPins(page), { state: [5], shown: [5] }, 'after the insert was undone');
        } finally { await page.close(); }
    });

    // What did not change: pins are kept by record id across filter, sort and
    // page loads (shown only while their record is on the page), and cleared by
    // a table switch, a reload of the database, and a refresh that names no
    // records.
    it('keeps pins across a filter and a sort, showing them while their record is on the page', async () => {
        const page = await openGrid();
        try {
            await pin(page, 3);
            await pin(page, 5);
            await page.evaluate(async () => {
                window.__pinHarness.state.columnFilters = { name: 'name-3' };
                await window.__pinHarness.loadTableData(false);
            });
            await waitForIdle(page);
            assert.deepEqual(await readPins(page), { state: [3, 5], shown: [3] }, 'record 5 is filtered out');
            await page.evaluate(async () => {
                window.__pinHarness.state.columnFilters = {};
                await window.__pinHarness.loadTableData(false);
            });
            await waitForIdle(page);
            assert.deepEqual(await readPins(page), { state: [3, 5], shown: [3, 5] });

            await page.locator('#gridContainer .header-cell[data-column="name"] .header-sort-button').click();
            await waitForIdle(page);
            await page.locator('#gridContainer .header-cell[data-column="name"] .header-sort-button').click();
            await waitForIdle(page);
            assert.equal(await page.evaluate(() => window.__pinHarness.state.sortAscending), false);
            assert.deepEqual(await readPins(page), { state: [3, 5], shown: [5, 3] }, 'pinned rows follow the sort');
        } finally { await page.close(); }
    });

    it('keeps pins across a page turn, showing them on their own page', async () => {
        const page = await openGrid({ rowCount: 250, rowsPerPage: 100 });
        try {
            await pin(page, 3);
            await pin(page, 5);
            await page.evaluate(() => window.__pinHarness.goToPage(1, 'next'));
            await waitForIdle(page);
            assert.equal(await page.evaluate(() => window.__pinHarness.state.currentPageIndex), 1);
            assert.deepEqual(await readPins(page), { state: [3, 5], shown: [] }, 'neither record is on page 2');
            await page.evaluate(() => window.__pinHarness.goToPage(0, 'prev'));
            await waitForIdle(page);
            assert.deepEqual(await readPins(page), { state: [3, 5], shown: [3, 5] });
        } finally { await page.close(); }
    });

    it('clears pins on a table switch', async () => {
        const page = await openGrid();
        try {
            await pin(page, 3);
            await page.evaluate(() => window.__pinHarness.selectTableItem('other', 'table'));
            await waitForIdle(page);
            assert.deepEqual(await readPins(page), { state: [], shown: [] });
            await page.evaluate(() => window.__pinHarness.selectTableItem('items', 'table'));
            await waitForIdle(page);
            assert.deepEqual(await readPins(page), { state: [], shown: [] });
        } finally { await page.close(); }
    });

    it('clears pins on a database reload and on a refresh that names no records', async () => {
        const page = await openGrid();
        try {
            await pin(page, 3);
            await host(page, h => h.echo({ connected: true, readOnly: false, connectionGeneration: 2 }, undefined));
            assert.deepEqual(await readPins(page), { state: [], shown: [] }, 'after a reload of the database');
            await pin(page, 3);
            await host(page, h => h.echo(undefined, { modificationType: 'cell_update' }));
            assert.deepEqual(await readPins(page), { state: [], shown: [] }, 'after a refresh without record ids');
        } finally { await page.close(); }
    });
});
