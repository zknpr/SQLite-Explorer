import './vscode_mock_setup';

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import esbuild from 'esbuild';
import { chromium, type BrowserContext, type Page } from 'playwright-core';

const root = path.resolve(__dirname, '../..');
const browserPath = [
    process.env.SQLITE_EXPLORER_CHROMIUM_PATH,
    chromium.executablePath(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe')
].find(candidate => candidate && existsSync(candidate));

type SavedState = Record<string, unknown>;
type GridState = {
    isDbConnected: boolean;
    isReadOnly: boolean;
    currentPageIndex: number;
    connectionGeneration: number;
    isGridReloading: boolean;
    isLoadingColumns: boolean;
    selectedTable: string | null;
    gridData: unknown[][];
    selectedCells: { rowIdx: number; colIdx: number; rowId: number; value: unknown }[];
    pinnedColumns: Set<string>;
    pinnedRowIds: Set<number>;
};

declare global {
    interface Window {
        __uiStateHarness: {
            state: GridState;
            persistState(): void;
            updateVirtualGridWindow(): boolean;
            applyBatchUpdate(): Promise<void>;
        };
        __vsCodeState: SavedState | undefined;
        __sidebarWrites: number[];
        __openLimitMb: number;
        __refreshRequests: number;
        __schemaRequests: number;
        __textReadSizes: number[];
        __inspectorTextFixture: string | undefined;
    }
}

describe('webview focus and reconstructed view state', {
    skip: browserPath ? false : 'Install Chromium or set SQLITE_EXPLORER_CHROMIUM_PATH for real DOM regressions'
}, () => {
    let context: BrowserContext;
    let profile: string;
    let html: string;
    const errors: Error[] = [];

    before(async () => {
        // Bundle authored modules in memory. Tracked viewer artifacts stay untouched.
        const bundle = await esbuild.build({
            stdin: {
                contents: `
                    import './core/ui/viewer.js';
                    import { state, persistState } from './core/ui/modules/state.js';
                    import { updateVirtualGridWindow } from './core/ui/modules/grid-render.js';
                    import { applyBatchUpdate } from './core/ui/modules/sidebar.js';
                    window.__uiStateHarness = { state, persistState, updateVirtualGridWindow, applyBatchUpdate };
                `,
                resolveDir: root
            },
            bundle: true,
            format: 'iife',
            platform: 'browser',
            write: false
        });
        html = readFileSync(path.join(root, 'core/ui/viewer.template.html'), 'utf8')
            .replace('<!--HEAD-->', '<meta id="vscode-env" data-sidebar-left="220" data-default-page-size="5000" data-cell-edit-behavior="vscode">')
            .replace('<!--STYLES-->', () => readFileSync(path.join(root, 'core/ui/viewer.css'), 'utf8'))
            .replace('<!--SCRIPTS-->', () => bundle.outputFiles[0].text);
        profile = mkdtempSync(path.join(root, '.ui-state-test-'));
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
        assert.deepEqual(errors, [], 'the real viewer must initialize without browser errors');
    });

    async function openViewer(savedState?: SavedState, connectionGeneration = 3, readOnly = false, initialRefusal = false): Promise<Page> {
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error));
        const installVsCodeApi = ({ savedState, connectionGeneration, readOnly, initialRefusal }: {
            savedState?: SavedState; connectionGeneration: number; readOnly: boolean; initialRefusal: boolean;
        }) => {
            window.__vsCodeState = savedState;
            window.__sidebarWrites = [];
            window.__openLimitMb = initialRefusal ? 1 : 0;
            window.__refreshRequests = 0;
            window.__schemaRequests = 0;
            window.__textReadSizes = [];
            const refusal = "File size (1.15 MB) exceeds the maximum allowed size (1.00 MB). Configure 'sqliteExplorer.maxFileSize' to increase the limit.";
            const columns = Array.from({ length: 51 }, (_, index) => ({
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
                    getState: () => window.__vsCodeState,
                    setState: (value: SavedState) => {
                        window.__vsCodeState = JSON.parse(JSON.stringify(value));
                    },
                    postMessage: (message: {
                        channel?: string;
                        content?: { kind: string; messageId: string; targetMethod: string; payload: unknown[] };
                    }) => {
                        if (message.channel !== 'rpc' || message.content?.kind !== 'invoke') return;
                        const { messageId, targetMethod, payload } = message.content;
                        const options = payload[1] as { offset: number; limit: number };
                        let data: unknown;
                        let errorMessage: string | undefined;
                        if (targetMethod === 'initialize') {
                            data = { connected: !initialRefusal, readOnly, connectionGeneration, cellEditBehavior: 'inline',
                                ...(initialRefusal ? { reloadRequiredReason: refusal } : {}) };
                        } else if (targetMethod === 'refreshFile') {
                            window.__refreshRequests++;
                            if (window.__openLimitMb !== 0) errorMessage = refusal;
                            else data = { connected: true, readOnly, connectionGeneration: connectionGeneration + 1 };
                        } else if (targetMethod === 'ping') data = true;
                        else if (targetMethod === 'fetchSchema') {
                            window.__schemaRequests++;
                            data = { tables: [{ identifier: 'wide' }], views: [], indexes: [] };
                        } else if (targetMethod === 'getTableInfo') data = columns;
                        else if (targetMethod === 'fetchTableCount') data = { count: 10000, isExact: true };
                        else if (targetMethod === 'fetchTableData') {
                            data = {
                                rows: Array.from({ length: Math.min(options.limit, 10000 - options.offset) }, (_, index) => {
                                    const id = options.offset + index + 1;
                                    return [id, id, ...columns.slice(1).map(column => `${column.identifier}-${id}`)];
                                })
                            };
                        } else if (targetMethod === 'saveSidebarState') {
                            window.__sidebarWrites.push(payload[1] as number);
                        } else if (targetMethod === 'openCellReadSession') {
                            const textBytes = window.__inspectorTextFixture === undefined ? undefined
                                : new TextEncoder().encode(window.__inspectorTextFixture);
                            data = { sessionId: 'large-text', expiresAt: Date.now() + 30_000,
                                metadata: { storageClass: 'text', byteLength: textBytes?.length ?? 196608,
                                    textEncoding: textBytes ? 'utf-8' : 'utf-16le' } };
                        } else if (targetMethod === 'readCellChunk') {
                            const size = payload[2] as number;
                            const offset = payload[1] as number;
                            window.__textReadSizes.push(size);
                            const source = window.__inspectorTextFixture === undefined ? undefined
                                : new TextEncoder().encode(window.__inspectorTextFixture);
                            const bytes = source ? source.slice(offset, offset + size) : new Uint8Array(size);
                            if (!source) for (let index = 0; index < bytes.length; index += 2) bytes[index] = 65;
                            data = { byteOffset: offset, bytes, done: source ? offset + bytes.length >= source.length : false };
                        } else if (targetMethod === 'closeCellReadSession') {
                            data = undefined;
                        } else throw new Error(`Unexpected viewer RPC: ${targetMethod}`);
                        queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', {
                            data: { channel: 'rpc', content: { kind: 'response', messageId, success: !errorMessage, data, errorMessage } }
                        })));
                    }
                })
            });
        };
        // tsx preserves function names with this helper inside serialized callbacks.
        await page.addInitScript({ content: `
            globalThis.__name = value => value;
            (${installVsCodeApi.toString()})(${JSON.stringify({ savedState, connectionGeneration, readOnly, initialRefusal })});
        ` });
        await page.goto('https://sqlite-explorer.test/viewer');
        await page.waitForFunction(() => !!window.__uiStateHarness
            && !window.__uiStateHarness.state.isGridReloading
            && (document.getElementById('statusText')?.textContent !== 'Connecting to database...'
                || !!document.getElementById('btnReloadDatabase')), undefined, { timeout: 10000 });
        if (savedState?.selectedTable) await waitForGrid(page);
        return page;
    }

    it('uses the current preference after recreating a view from stale HTML', async () => {
        const page = await openViewer({ selectedTable: 'wide', selectedTableType: 'table', rowsPerPage: 100 });
        try {
            await page.locator('#cell-0-1').dblclick();
            await page.locator('#cell-0-1 textarea.cell-input').waitFor({ timeout: 2000 });
            assert.equal(await page.locator('#cell-0-1 textarea.cell-input').inputValue(), 'c1-1');
        } finally { await page.close(); }
    });

    it('exposes Hex as bounded accessible text and keeps selection inside the loaded page', async () => {
        const page = await openViewer({ selectedTable: 'wide', selectedTableType: 'table', rowsPerPage: 100 });
        try {
            const hex = page.locator('.hex-dump');
            // Fail on the element contract before rendering any data. The browser
            // check uses a small ordinary BLOB; full-page bounds are tested without DOM layout.
            assert.equal(await hex.evaluate(element => element.matches('input, textarea, [contenteditable="true"]')), false);
            await page.evaluate(() => {
                window.__uiStateHarness.state.gridData[0][2] = Uint8Array.from({ length: 1024 }, (_, index) => index % 256);
            });
            await page.locator('#cell-0-1').dblclick();
            await page.locator('#blob-inspector-modal .tab-btn[data-tab="hex"]').click();
            const displayed = await hex.textContent();
            assert.ok(displayed);
            assert.ok(displayed.startsWith('00000000  00 01 02 03 04 05 06 07'));
            assert.ok(displayed.includes('000003f0'));

            const cdp = await context.newCDPSession(page);
            try {
                const { nodes } = await cdp.send('Accessibility.getFullAXTree');
                const region = nodes.find(node => node.role?.value === 'region' && node.name?.value === 'BLOB hexadecimal data');
                assert.ok(region, 'Hex is a named reading region');
                assert.equal(region.value, undefined);
                const byId = new Map(nodes.map(node => [node.nodeId, node]));
                const pending = [...region.childIds ?? []];
                const pieces: string[] = [];
                while (pending.length) {
                    const node = byId.get(pending.shift()!)!;
                    if (node.role?.value === 'StaticText') {
                        const text = String(node.name?.value ?? '');
                        assert.ok(text.length <= 2048, 'Each accessible text node stays bounded');
                        pieces.push(text);
                    } else pending.unshift(...node.childIds ?? []);
                }
                assert.equal(pieces.join(''), displayed);
            } finally { await cdp.detach(); }

            await hex.focus();
            await page.keyboard.press('ControlOrMeta+A');
            const copied = await hex.evaluate(element => {
                const selection = document.getSelection()!;
                const clipboard = new DataTransfer();
                const event = new ClipboardEvent('copy', { clipboardData: clipboard, bubbles: true, cancelable: true });
                element.dispatchEvent(event);
                return { contained: element.contains(selection.anchorNode) && element.contains(selection.focusNode),
                    text: clipboard.getData('text/plain'), prevented: event.defaultPrevented };
            });
            assert.deepEqual(copied, { contained: true, text: displayed, prevented: true });
            await page.keyboard.press('Tab');
            assert.equal(await hex.evaluate(element => element === document.activeElement), false);
            assert.equal(await page.locator('#blob-inspector-modal').evaluate(modal => modal.contains(document.activeElement)), true);
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#blob-inspector-modal').isVisible(), false);
            assert.equal(await hex.textContent(), '');
        } finally { await page.close(); }
    });

    it('opens complete large TEXT in a bounded real-DOM inspector and restores focus on Escape', async () => {
        const page = await openViewer({ selectedTable: 'wide', selectedTableType: 'table', rowsPerPage: 100 });
        try {
            await page.evaluate(() => {
                window.__uiStateHarness.state.gridData[0][2] = 'A'.repeat(98304);
                // The guard makes a regression fail safely before editable text
                // layout. It is not a renderer-crash reproduction.
                const value = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;
                Object.defineProperty(HTMLTextAreaElement.prototype, 'value', {
                    ...value,
                    set(text: string) {
                        if (text.length > 65536) {
                            throw new Error('Unbounded editable TEXT assignment');
                        }
                        value.set!.call(this, text);
                    }
                });
            });
            await page.locator('#cell-0-1').dblclick();
            await page.waitForFunction(() => document.getElementById('blob-info')?.textContent?.includes('64 KB of 192 KB'));
            assert.equal(await page.locator('#blobInspectorModalTitle').innerText(), 'TEXT Inspector');
            assert.equal(await page.locator('#tab-preview pre').textContent(), 'A'.repeat(32768));
            assert.deepEqual(await page.evaluate(() => window.__textReadSizes), [65536]);
            assert.equal(await page.locator('textarea.cell-input').count(), 0);
            const closeButton = page.locator('#blob-inspector-modal .modal-close');
            const previewButton = page.locator('#blob-inspector-modal .tab-btn[data-tab="preview"]');
            const hexButton = page.locator('#blob-inspector-modal .tab-btn[data-tab="hex"]');
            assert.equal(await closeButton.evaluate(button => button === document.activeElement), true);
            await hexButton.click();
            assert.equal(await hexButton.evaluate(button => button.classList.contains('active')), true);
            assert.equal(await closeButton.evaluate(button => button === document.activeElement), true);
            await previewButton.focus();
            await page.keyboard.press('Enter');
            assert.equal(await previewButton.evaluate(button => button.classList.contains('active')), true);
            assert.equal(await previewButton.evaluate(button => button === document.activeElement), true);
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#blob-inspector-modal').isVisible(), false);
            assert.equal(await page.locator('#cell-0-1').evaluate(cell => cell === document.activeElement), true);
        } finally { await page.close(); }
    });

    it('keeps loaded Unicode TEXT selectable, copyable, and keyboard paged within a hard DOM bound', async () => {
        const page = await openViewer({ selectedTable: 'wide', selectedTableType: 'table', rowsPerPage: 100 });
        try {
            await page.evaluate(() => {
                const text = 'é😀\n'.repeat(400_000);
                window.__inspectorTextFixture = text;
                window.__uiStateHarness.state.gridData[0][2] = text;
                const append = Element.prototype.appendChild;
                Element.prototype.appendChild = function <T extends Node>(child: T): T {
                    if (this.id === 'tab-preview') {
                        const text = child.textContent ?? '';
                        // Fail before browser layout if the hard bound regresses.
                        // This is not an intentional renderer-OOM reproduction.
                        if (text.length > 65536 + 512 || text.split('\n').length > 1026) {
                            throw new Error('Unbounded selectable TEXT preview');
                        }
                    }
                    return append.call(this, child) as T;
                };
            });
            await page.locator('#cell-0-1').dblclick();
            await page.getByRole('spinbutton', { name: 'Text preview page' }).waitFor();
            for (let load = 0; load < 3; load++) {
                await page.locator('#blob-load-more-btn').click();
                await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#blob-load-more-btn')?.disabled
                    || document.querySelector<HTMLButtonElement>('#blob-load-more-btn')?.hidden);
            }
            assert.match(await page.locator('#blob-info').innerText(), /Full value 2\.67 MB/);
            assert.equal(await page.locator('#blob-load-more-btn').isVisible(), false);
            assert.match(await page.getByRole('navigation', { name: 'Loaded text pages' }).innerText(), /of 391/);
            const preview = page.locator('#tab-preview pre');
            assert.equal(await preview.textContent(), 'é😀\n'.repeat(1024));
            const copied = await preview.evaluate(pre => {
                const range = document.createRange();
                range.setStart(pre.children[0].firstChild!, 2040);
                range.setEnd(pre.children[1].firstChild!, 16);
                const selection = document.getSelection()!;
                selection.removeAllRanges(); selection.addRange(range);
                const clipboard = new DataTransfer();
                pre.dispatchEvent(new ClipboardEvent('copy', { clipboardData: clipboard, bubbles: true, cancelable: true }));
                return clipboard.getData('text/plain');
            });
            assert.equal(copied, 'é😀\n'.repeat(6), 'Copy across internal chunks preserves exactly the original newlines');
            const navigation = page.getByRole('navigation', { name: 'Loaded text pages' });
            await navigation.getByRole('button', { name: 'Next', exact: true }).focus();
            await page.keyboard.press('Enter');
            const input = page.getByRole('spinbutton', { name: 'Text preview page' });
            assert.equal(await input.inputValue(), '2');
            await navigation.getByRole('button', { name: 'Last', exact: true }).click();
            assert.equal(await input.inputValue(), '391');
            assert.equal(await preview.textContent(), 'é😀\n'.repeat(640));
            assert.equal(await navigation.getByRole('button', { name: 'Next', exact: true }).isDisabled(), true);
            await input.fill('392');
            await page.keyboard.press('Enter');
            assert.equal(await input.inputValue(), '391');
            assert.match(await page.locator('#tab-preview [role="status"]').innerText(), /Choose a text page/);
            await input.fill('1');
            await navigation.getByRole('button', { name: 'Go', exact: true }).click();
            assert.equal(await preview.textContent(), 'é😀\n'.repeat(1024));
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#blob-inspector-modal').isVisible(), false);
            assert.equal(await page.locator('#cell-0-1').evaluate(cell => cell === document.activeElement), true);
        } finally { await page.close(); }
    });

    it('shows a disconnected refusal and retries in the same webview only after settings admit the file', async () => {
        const page = await openViewer(undefined, 3, false, true);
        try {
            assert.equal(await page.locator('#btnOpenCreateTable').isDisabled(), true);
            assert.equal(await page.locator('#btnOpenCreateView').isDisabled(), true);
            assert.deepEqual(await page.evaluate(() => ({
                connected: window.__uiStateHarness.state.isDbConnected,
                readOnly: window.__uiStateHarness.state.isReadOnly,
                schemaRequests: window.__schemaRequests
            })), { connected: false, readOnly: true, schemaRequests: 0 });
            await page.locator('#btnReloadDatabase').click();
            await page.waitForFunction(() => window.__refreshRequests === 1, undefined, { timeout: 2000 });
            assert.equal(await page.locator('#btnOpenCreateTable').isDisabled(), true);
            await page.evaluate(() => { window.__openLimitMb = 0; });
            await page.locator('#btnReloadDatabase').click();
            await page.waitForFunction(() => window.__uiStateHarness.state.isDbConnected, undefined, { timeout: 5000 });
            await page.getByRole('button', { name: 'Open table wide', exact: true }).waitFor();
            assert.equal(await page.locator('#btnOpenCreateTable').isDisabled(), false);
            assert.equal(await page.locator('#btnReloadDatabase').count(), 0);
            assert.match(await page.locator('#gridContainer').textContent() ?? '', /Select a table/);
            await page.getByRole('button', { name: 'Open table wide', exact: true }).click();
            await waitForGrid(page);
        } finally { await page.close(); }
    });

    async function waitForGrid(page: Page) {
        await page.waitForFunction(() => window.__uiStateHarness.state.gridData.length > 0
            && !window.__uiStateHarness.state.isGridReloading
            && !window.__uiStateHarness.state.isLoadingColumns);
    }

    async function settleScroll(page: Page) {
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => {
            requestAnimationFrame(() => resolve());
        })));
    }

    it('keeps cell focus and Space selection across a virtual window shift', async () => {
        const page = await openViewer();
        try {
            await page.getByRole('button', { name: 'Open table wide', exact: true }).click();
            await waitForGrid(page);
            await page.locator('#cell-0-20').focus();
            for (let rowIdx = 1; rowIdx <= 85; rowIdx++) {
                await page.keyboard.press('ArrowDown');
                await settleScroll(page);
                assert.equal(await page.evaluate(() => document.activeElement?.id), `cell-${rowIdx}-20`);
                await page.keyboard.press('Space');
                assert.deepEqual(await page.evaluate(() => window.__uiStateHarness.state.selectedCells), [
                    { rowIdx, colIdx: 20, rowId: rowIdx + 1, value: `c20-${rowIdx + 1}` }
                ]);
            }
            for (let rowIdx = 84; rowIdx >= 10; rowIdx--) {
                await page.keyboard.press('ArrowUp');
                await settleScroll(page);
                assert.equal(await page.evaluate(() => document.activeElement?.id), `cell-${rowIdx}-20`);
                const bounds = await page.evaluate(() => ({
                    cell: document.activeElement!.getBoundingClientRect().top,
                    header: document.querySelector('.grid-header .header-cell')!.getBoundingClientRect().bottom
                }));
                assert.ok(bounds.cell >= bounds.header - 1,
                    `row ${rowIdx + 1} must remain below the sticky header: ${JSON.stringify(bounds)}`);
            }
        } finally {
            await page.close();
        }
    });

    it('restores page, pins and both scroll axes from settled saved state', async () => {
        const page = await openViewer({
            connectionGeneration: 3,
            selectedTable: 'wide',
            selectedTableType: 'table',
            currentPageIndex: 1,
            rowsPerPage: 500,
            filterQuery: 'c1-1',
            sortedColumn: 'c2',
            sortAscending: false,
            pinnedColumns: ['c2'],
            pinnedRowIds: [501],
            dateFormat: 'iso',
            scrollPosition: { top: 312, left: 1200 }
        });
        try {
            await settleScroll(page);
            assert.deepEqual(await page.evaluate(() => ({
                pageIndex: window.__uiStateHarness.state.currentPageIndex,
                pins: [...window.__uiStateHarness.state.pinnedColumns],
                rowPins: [...window.__uiStateHarness.state.pinnedRowIds],
                scroll: {
                    top: document.getElementById('gridContainer')!.scrollTop,
                    left: document.getElementById('gridContainer')!.scrollLeft
                }
            })), { pageIndex: 1, pins: ['c2'], rowPins: [501], scroll: { top: 312, left: 1200 } });
        } finally {
            await page.close();
        }
    });

    it('persists page and pins before the next event can destroy the webview', async () => {
        const page = await openViewer({ selectedTable: 'wide', rowsPerPage: 500 });
        try {
            await page.evaluate(() => {
                document.querySelector<HTMLElement>('.header-cell[data-column="c2"] .pin-icon')!.click();
                document.getElementById('btnNext')!.click();
            });
            const saved = await page.evaluate(() => window.__vsCodeState);
            assert.equal(saved?.currentPageIndex, 1);
            assert.deepEqual(saved?.pinnedColumns, ['c2']);
        } finally {
            await page.close();
        }
    });

    it('does not restore row or column pins from a replaced connection', async () => {
        const page = await openViewer({
            connectionGeneration: 2,
            selectedTable: 'wide',
            selectedTableType: 'table',
            rowsPerPage: 500,
            pinnedColumns: ['c2'],
            pinnedRowIds: [501]
        }, 3);
        try {
            assert.deepEqual(await page.evaluate(() => ({
                pins: [...window.__uiStateHarness.state.pinnedColumns],
                rowPins: [...window.__uiStateHarness.state.pinnedRowIds]
            })), { pins: [], rowPins: [] });
        } finally {
            await page.close();
        }
    });

    it('restores collapsed sidebar groups after reconstructing the same HTML', async () => {
        const first = await openViewer();
        let saved: SavedState | undefined;
        try {
            await first.locator('[data-section="tables"]').click();
            await first.locator('[data-section="views"]').click();
            // Wait for existing delayed persistence to exclude a timing-only failure.
            await first.waitForTimeout(600);
            saved = await first.evaluate(() => window.__vsCodeState);
        } finally {
            await first.close();
        }
        const restored = await openViewer(saved);
        try {
            assert.equal(await restored.locator('[data-section="tables"]').getAttribute('aria-expanded'), 'false');
            assert.equal(await restored.locator('[data-section="views"]').getAttribute('aria-expanded'), 'true');
            assert.equal(await restored.locator('#tablesList').isVisible(), false);
            assert.equal(await restored.locator('#viewsList').isVisible(), true);
        } finally {
            await restored.close();
        }
    });

    it('restores the committed sidebar width despite the stale HTML default', async () => {
        const first = await openViewer();
        let saved: SavedState | undefined;
        try {
            await first.locator('#resizeHandle').focus();
            await first.keyboard.press('End');
            await first.waitForFunction(() => window.__sidebarWrites.includes(400));
            await first.waitForTimeout(600);
            saved = await first.evaluate(() => window.__vsCodeState);
        } finally {
            await first.close();
        }
        const restored = await openViewer(saved);
        try {
            assert.equal(await restored.locator('#resizeHandle').getAttribute('aria-valuenow'), '400');
            assert.equal(await restored.locator('#sidebarPanel').evaluate(element => (element as HTMLElement).style.width), '400px');
        } finally {
            await restored.close();
        }
    });

    it('keeps batch editing disabled with the document read-only reason after cell selection', async () => {
        const page = await openViewer({ selectedTable: 'wide', rowsPerPage: 500 }, 3, true);
        try {
            await page.locator('#cell-0-1').focus();
            await page.keyboard.press('Space');
            assert.equal(await page.locator('#btnApplyBatchUpdate').isDisabled(), true);
            assert.equal(await page.locator('.batch-input').isDisabled(), true);
            for (const selector of ['.btn-batch-null', '.btn-batch-empty', '.btn-batch-patch']) {
                assert.equal(await page.locator(selector).isDisabled(), true);
            }
            for (const selector of ['#btnApplyBatchUpdate', '.btn-batch-null']) {
                const button = page.locator(selector);
                assert.deepEqual(await button.evaluate(element => ({
                    cursor: getComputedStyle(element).cursor,
                    opacity: getComputedStyle(element).opacity
                })), { cursor: 'not-allowed', opacity: '0.5' });
                const background = await button.evaluate(element => getComputedStyle(element).backgroundColor);
                const bounds = await button.boundingBox();
                assert.ok(bounds);
                await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
                assert.equal(await button.evaluate(element => getComputedStyle(element).backgroundColor), background);
            }
            assert.match(await page.locator('#batchUpdateFields').innerText(), /Document is read-only/);
            await page.evaluate(() => window.__uiStateHarness.applyBatchUpdate());
            assert.equal(await page.locator('#statusText').innerText(), 'Document is read-only');
        } finally {
            await page.close();
        }
    });

    it('shows keyboard focus on checkboxes and permits reverse focus escape from a cell textarea', async () => {
        const page = await openViewer({ selectedTable: 'wide', rowsPerPage: 500 });
        try {
            await page.locator('#btnOpenCreateTable').focus();
            await page.keyboard.press('Enter');
            await page.keyboard.press('Tab');
            const checkbox = page.locator('#newTableWithoutRowid');
            await checkbox.focus();
            assert.deepEqual(await checkbox.evaluate(element => ({
                focusVisible: element.matches(':focus-visible'),
                width: getComputedStyle(element).outlineWidth,
                style: getComputedStyle(element).outlineStyle
            })), { focusVisible: true, width: '2px', style: 'solid' });
            await page.keyboard.press('Space');
            assert.equal(await checkbox.isChecked(), true);
            await page.keyboard.press('Space');
            assert.equal(await checkbox.isChecked(), false);
            await page.keyboard.press('Escape');
            await page.locator('#cell-0-1').click();
            await page.locator('#cell-0-1 .expand-icon').click();
            const textarea = page.locator('#cellPreviewTextarea');
            await textarea.focus();
            const before = await textarea.inputValue();
            await page.keyboard.press('Escape');
            await page.keyboard.press('Shift+Tab');
            assert.equal(await textarea.evaluate(element => element === document.activeElement), false);
            assert.equal(await textarea.inputValue(), before);
            assert.equal(await page.locator('#cellPreviewModal').isVisible(), true);
        } finally { await page.close(); }
    });
});
