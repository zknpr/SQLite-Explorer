import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { readCellContentPage, openCellContentViewer, CELL_TEXT_PAGE_BYTES, CELL_HEX_PAGE_BYTES } from '../../src/cellContentViewer';
import type { MaterializedCell } from '../../src/cellMaterialization';
import { chromium, type Browser, type Page } from 'playwright-core';

let directory: string;
beforeEach(() => {
    fs.mkdirSync('.tmp', { recursive: true });
    directory = fs.mkdtempSync(path.resolve('.tmp/cell-content-viewer-'));
});
afterEach(() => { mock.restoreAll(); fs.rmSync(directory, { recursive: true, force: true }); });

function snapshot(bytes: Uint8Array, encoding?: 'utf-8' | 'utf-16le' | 'utf-16be'): MaterializedCell {
    const file = path.join(directory, 'snapshot.bin');
    fs.writeFileSync(file, bytes);
    return {
        uri: vscode.Uri.file(file), byteLength: bytes.length, contentEncoding: 'raw-database-bytes',
        checksumSha256: '0'.repeat(64), sourcePrefix: bytes.subarray(0, 32),
        metadata: { storageClass: encoding ? 'text' : 'blob', byteLength: bytes.length, ...(encoding ? { textEncoding: encoding } : {}) }
    };
}

it('reads bounded first and last Hex pages from a 5 MiB non-text snapshot', async () => {
    const value = snapshot(new Uint8Array(5 * 1024 * 1024).fill(0xa5));
    const first = await readCellContentPage(value, 0, 'hex');
    const last = await readCellContentPage(value, first.pages - 1, 'hex');
    assert.equal(first.byteStart, 0);
    assert.equal(first.byteEnd, CELL_HEX_PAGE_BYTES);
    assert.match(first.text, /^00000000  a5 a5/);
    assert.equal(last.byteEnd, value.byteLength);
    assert.ok(first.text.length < 100_000);
    assert.ok(last.text.length < 100_000);
});

for (const encoding of ['utf-8', 'utf-16le', 'utf-16be'] as const) {
    it(`paginates a multi-megabyte single line without losing split ${encoding} characters`, async () => {
        const text = 'a' + '😀é𝄞'.repeat(350_000);
        const bytes = Buffer.from(text, encoding === 'utf-8' ? 'utf8' : 'utf16le');
        if (encoding === 'utf-16be') bytes.swap16();
        const value = snapshot(bytes, encoding);
        let reconstructed = '';
        let previousEnd = 0;
        const pages = Math.ceil(bytes.length / CELL_TEXT_PAGE_BYTES);
        for (let page = 0; page < pages; page++) {
            const result = await readCellContentPage(value, page, 'text');
            assert.equal(result.byteStart, previousEnd);
            assert.ok(result.byteEnd - result.byteStart <= CELL_TEXT_PAGE_BYTES + 4);
            assert.ok(result.text.length <= CELL_TEXT_PAGE_BYTES + 4);
            assert.ok(!result.text.includes('\uFFFD'));
            previousEnd = result.byteEnd;
            reconstructed += result.text;
        }
        assert.equal(previousEnd, bytes.length);
        assert.equal(reconstructed, text);
    });
}

it('refuses invalid page requests and does not label invalid TEXT as decoded text', async () => {
    const value = snapshot(Uint8Array.of(0xff, 0xfe, 0x61), 'utf-8');
    for (const page of [-1, 1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
        await assert.rejects(readCellContentPage(value, page, 'hex'), /page/i);
    }
    await assert.rejects(readCellContentPage(value, 0, 'text'), /not valid utf-8/i);
    assert.match((await readCellContentPage(value, 0, 'hex')).text, /ff fe 61/);
});

it('keeps the snapshot host-owned, uses nonce CSP, and releases on panel or database disposal', async () => {
    const value = snapshot(Uint8Array.of(1, 2, 3));
    let receive!: (message: unknown) => Promise<void>;
    let closed!: () => void;
    let ownerClosed!: () => void;
    const messages: unknown[] = [];
    const panel = {
        webview: { html: '', postMessage: async (message: unknown) => { messages.push(message); return true; },
            onDidReceiveMessage: (listener: typeof receive) => { receive = listener; return { dispose() {} }; } },
        onDidDispose: (listener: () => void) => { closed = listener; return { dispose() {} }; },
        dispose: () => closed()
    };
    const createPanel = mock.method(vscode.window, 'createWebviewPanel', () => panel);
    const release = mock.fn();
    const download = mock.fn(async () => true);
    openCellContentViewer(value, {
        title: '<img src=x onerror=alert(1)>', release, download,
        owner: { onDidDispose(listener) { ownerClosed = listener; return { dispose() {} }; } }
    });
    assert.match(panel.webview.html, /default-src 'none'/);
    assert.match(panel.webview.html, /script-src 'nonce-/);
    assert.ok(!panel.webview.html.includes('<img'));
    assert.deepEqual((createPanel.mock.calls[0].arguments[3] as { localResourceRoots: unknown[] }).localResourceRoots, []);
    await receive({ type: 'page', page: 0, mode: 'hex', path: '/etc/passwd' });
    assert.match((messages.at(-1) as { text: string }).text, /01 02 03/);
    await receive({ type: 'download' });
    assert.equal(download.mock.callCount(), 1);
    ownerClosed();
    assert.equal(release.mock.callCount(), 1);
    await receive({ type: 'download' });
    assert.equal(download.mock.callCount(), 1);
    closed();
    assert.equal(release.mock.callCount(), 1);
});

const browserPath = [
    process.env.SQLITE_EXPLORER_CHROMIUM_PATH,
    chromium.executablePath(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe')
].find(candidate => candidate && fs.existsSync(candidate));

describe('bounded cell viewer in Chromium', {
    skip: browserPath ? false : 'Install Chromium or set SQLITE_EXPLORER_CHROMIUM_PATH for renderer regressions'
}, () => {
    let browser: Browser;
    before(async () => { browser = await chromium.launch({ executablePath: browserPath, headless: true }); });
    after(async () => { await browser?.close(); });

    async function showSnapshot(value: MaterializedCell): Promise<Page> {
        const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
        let receive!: (message: unknown) => Promise<void>;
        const panel = {
            webview: {
                html: '',
                onDidReceiveMessage(listener: typeof receive) { receive = listener; return { dispose() {} }; },
                async postMessage(message: unknown) {
                    await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
                    return true;
                }
            },
            onDidDispose() { return { dispose() {} }; }, dispose() {}
        };
        mock.method(vscode.window, 'createWebviewPanel', () => panel);
        openCellContentViewer(value, {
            title: 'Stored cell', release() {}, download: async () => true,
            owner: { onDidDispose() { return { dispose() {} }; } }
        });
        await page.exposeFunction('__cellContentHostRequest', receive);
        await page.addInitScript({ content: `
            window.acquireVsCodeApi = () => ({
                getState: () => undefined, setState() {},
                postMessage: message => window.__cellContentHostRequest(message)
            });
        ` });
        await page.route('https://sqlite-explorer.test/cell', route => route.fulfill({ contentType: 'text/html', body: panel.webview.html }));
        await page.goto('https://sqlite-explorer.test/cell');
        await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Bytes '));
        return page;
    }

    it('navigates large binary content with a bounded DOM and recovers from invalid page input', async () => {
        const page = await showSnapshot(snapshot(new Uint8Array(5 * 1024 * 1024).fill(0xa5)));
        try {
            assert.match(await page.locator('#content').textContent() ?? '', /^00000000  a5 a5/);
            assert.equal(await page.locator('#pages').textContent(), 'of 320');
            await page.locator('#next').click();
            await page.waitForFunction(() => (document.getElementById('page') as HTMLInputElement)?.value === '2');
            await page.locator('#page').fill('9999');
            await page.locator('#go').click();
            await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#hex')?.disabled);
            assert.match(await page.locator('#status').textContent() ?? '', /page/i);
            assert.equal(await page.locator('#page').inputValue(), '2');
            assert.equal(await page.locator('#next').isDisabled(), false);
            await page.locator('#last').click();
            await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes('5,242,880'));
            assert.equal(await page.locator('#page').inputValue(), '320');
            assert.equal(await page.locator('#next').isDisabled(), true);
            assert.ok((await page.locator('#content').textContent())!.length < 100_000);
            assert.ok(await page.locator('#content').evaluate(element => element.childNodes.length) < 50);
            await page.locator('#download').click();
            await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Complete snapshot downloaded.');
        } finally { await page.close(); }
    });

    it('renders a multi-megabyte Unicode line as text, keeps markup literal, and stays keyboard navigable', async () => {
        const text = '<img src=x onerror=alert(1)>' + '😀é𝄞'.repeat(350_000);
        const page = await showSnapshot(snapshot(Buffer.from(text), 'utf-8'));
        try {
            assert.equal(await page.locator('#content img').count(), 0);
            assert.ok((await page.locator('#content').textContent())!.startsWith('<img src=x onerror=alert(1)>'));
            assert.ok((await page.locator('#content').textContent())!.length <= CELL_TEXT_PAGE_BYTES + 4);
            assert.equal(await page.locator('#content').evaluate(element => [...element.childNodes].every(node => {
                const end = node.textContent?.charCodeAt((node.textContent?.length ?? 0) - 1) ?? 0;
                return end < 0xd800 || end > 0xdbff;
            })), true);
            await page.locator('#next').focus();
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => (document.getElementById('page') as HTMLInputElement)?.value === '2');
            assert.ok(!(await page.locator('#content').textContent())!.includes('\uFFFD'));
            await page.locator('#last').click();
            await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('#last')?.disabled);
            assert.ok((await page.locator('#content').textContent())!.endsWith('😀é𝄞'));
            await page.locator('#previous').click();
            await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#last')?.disabled);
        } finally { await page.close(); }
    });
});
