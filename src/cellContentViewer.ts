import * as vsc from 'vscode';
import { crypto as webCrypto } from './platform/cryptoShim';
import type { CellMaterializationOwner, MaterializedCell } from './cellMaterialization';

export const CELL_TEXT_PAGE_BYTES = 64 * 1024;
export const CELL_HEX_PAGE_BYTES = 16 * 1024;
type ContentMode = 'text' | 'hex';

/** Read only the requested page of a verified, host-owned snapshot. */
export async function readCellContentPage(cell: MaterializedCell, page: number, mode: ContentMode) {
    if (import.meta.env?.VSCODE_BROWSER_EXT) {
        throw new Error('The complete-cell snapshot viewer is available only in VS Code Desktop');
    }
    if (mode !== 'text' && mode !== 'hex') throw new Error('Invalid cell content mode');
    const pageBytes = mode === 'text' ? CELL_TEXT_PAGE_BYTES : CELL_HEX_PAGE_BYTES;
    const pages = Math.max(1, Math.ceil(cell.byteLength / pageBytes));
    if (!Number.isSafeInteger(page) || page < 0 || page >= pages) throw new Error('Invalid cell content page');
    const offset = page * pageBytes;
    const fs = require('node:fs') as typeof import('node:fs');
    const handle = await fs.promises.open(cell.uri.fsPath, 'r');
    let bytes: Uint8Array;
    try {
        if ((await handle.stat()).size !== cell.byteLength) throw new Error('The cell snapshot changed or expired');
        // Four bytes suffice to finish a UTF-8 character or a UTF-16 surrogate
        // pair at the page boundary. No full file enters a webview message.
        bytes = new Uint8Array(Math.min(pageBytes + (mode === 'text' ? 4 : 0), cell.byteLength - offset));
        let read = 0;
        while (read < bytes.length) {
            const next = await handle.read(bytes, read, bytes.length - read, offset + read);
            if (next.bytesRead === 0) throw new Error('The cell snapshot ended before the requested page');
            read += next.bytesRead;
        }
    } finally { await handle.close(); }

    let start = 0;
    let end = Math.min(pageBytes, bytes.length);
    let text: string;
    if (mode === 'hex') {
        const lines: string[] = [];
        for (let position = 0; position < end; position += 16) {
            const row = bytes.subarray(position, Math.min(position + 16, end));
            const hex = Array.from(row, byte => byte.toString(16).padStart(2, '0')).join(' ').padEnd(47);
            const ascii = Array.from(row, byte => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.').join('');
            lines.push(`${(offset + position).toString(16).padStart(8, '0')}  ${hex}  |${ascii}|`);
        }
        text = lines.join('\n');
    } else {
        const encoding = cell.contentEncoding === 'utf-8' ? 'utf-8' : cell.metadata.textEncoding;
        if (!encoding || cell.metadata.storageClass !== 'text') throw new Error('This value contains binary data. Choose Hex.');
        if (encoding === 'utf-8') {
            const continuation = (index: number) => (bytes[index] & 0xc0) === 0x80;
            if (page > 0) while (start < Math.min(3, bytes.length) && continuation(start)) start++;
            while (end < bytes.length && continuation(end)) end++;
        } else {
            const unit = (index: number) => encoding === 'utf-16le'
                ? bytes[index] | (bytes[index + 1] << 8)
                : (bytes[index] << 8) | bytes[index + 1];
            if (page > 0 && bytes.length >= 2 && unit(0) >= 0xdc00 && unit(0) <= 0xdfff) start = 2;
            if (end >= 2 && end + 1 < bytes.length && unit(end - 2) >= 0xd800 && unit(end - 2) <= 0xdbff
                && unit(end) >= 0xdc00 && unit(end) <= 0xdfff) end += 2;
        }
        try {
            text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(start, end));
        } catch (error) {
            throw new Error(`This page is not valid ${encoding} text. Choose Hex to inspect the exact stored bytes.`, { cause: error });
        }
    }
    return { type: 'page' as const, page, pages, mode, byteStart: offset + start, byteEnd: offset + end, byteLength: cell.byteLength, text };
}

interface CellContentViewerOptions {
    title: string;
    owner: CellMaterializationOwner;
    release: () => void;
    download: () => Promise<boolean>;
}

export function openCellContentViewer(cell: MaterializedCell, options: CellContentViewerOptions): vsc.WebviewPanel {
    const panel = vsc.window.createWebviewPanel('sqlite-explorer.cell-content', options.title, vsc.ViewColumn.Two, {
        enableScripts: true, localResourceRoots: []
    });
    let disposed = false;
    let busy = false;
    const ownerSubscription = options.owner.onDidDispose(() => panel.dispose());
    panel.onDidDispose(() => {
        if (disposed) return;
        disposed = true;
        ownerSubscription.dispose();
        options.release();
    });
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
        if (disposed || busy || !message || typeof message !== 'object') return;
        const request = message as { type?: unknown; page?: unknown; mode?: unknown };
        if (request.type !== 'page' && request.type !== 'download') return;
        busy = true;
        try {
            if (request.type === 'download') {
                const saved = await options.download();
                if (!disposed) await panel.webview.postMessage({ type: 'status', text: saved ? 'Complete snapshot downloaded.' : 'Download cancelled.' });
            } else {
                const mode = request.mode ?? (cell.metadata.storageClass === 'text' ? 'text' : 'hex');
                const result = await readCellContentPage(cell, request.page as number, mode as ContentMode);
                if (!disposed) await panel.webview.postMessage(result);
            }
        } catch (error) {
            if (!disposed) await panel.webview.postMessage({ type: 'error', text: error instanceof Error ? error.message : String(error) });
        } finally { busy = false; }
    });
    panel.webview.html = contentViewerHtml(webCrypto.randomUUID().replaceAll('-', ''));
    return panel;
}

function contentViewerHtml(nonce: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Cell content</title>
<style nonce="${nonce}">
body { color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); margin: 16px; }
nav { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
button, input { font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid var(--vscode-contrastBorder, transparent); padding: 5px 9px; }
button:disabled { opacity: .5; } :focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
input { width: 80px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); line-height: 1.5; }
#status { min-height: 1.5em; } .note { color: var(--vscode-descriptionForeground); }
</style></head><body>
<nav aria-label="Cell content pages"><button id="text">Text</button><button id="hex">Hex</button>
<button id="previous">Previous</button><label>Page <input id="page" type="number" min="1" value="1"></label>
<span id="pages"></span><button id="go">Go</button><button id="next">Next</button><button id="last">Last</button>
<button id="download">Download complete snapshot</button></nav>
<p class="note">Read-only snapshot. Text pages are limited to 64 KiB; Hex pages to 16 KiB. Downloads preserve the complete stored bytes.</p>
<p id="status" role="status" aria-live="polite">Loading…</p><pre id="content" tabindex="0" aria-label="Read-only cell content"></pre>
<script nonce="${nonce}">
const api = acquireVsCodeApi();
const get = id => document.getElementById(id);
let state = api.getState() || { page: 0 };
let pages = 1;
const request = (page, mode = state.mode) => {
    for (const button of document.querySelectorAll('button')) button.disabled = true;
    get('status').textContent = 'Loading…'; api.postMessage({ type: 'page', page, mode });
};
get('text').onclick = () => request(0, 'text'); get('hex').onclick = () => request(0, 'hex');
get('previous').onclick = () => request(state.page - 1); get('next').onclick = () => request(state.page + 1);
get('last').onclick = () => request(pages - 1); get('go').onclick = () => request(Number(get('page').value) - 1);
get('page').onkeydown = event => { if (event.key === 'Enter') get('go').click(); };
get('download').onclick = () => { for (const button of document.querySelectorAll('button')) button.disabled = true; api.postMessage({ type: 'download' }); };
window.addEventListener('message', event => {
    const message = event.data;
    for (const button of document.querySelectorAll('button')) button.disabled = false;
    if (message.type === 'page') {
        state = { page: message.page, mode: message.mode }; pages = message.pages; api.setState(state);
        get('page').value = state.page + 1; get('page').max = pages; get('pages').textContent = 'of ' + pages;
        const content = get('content'); content.replaceChildren();
        // Small text nodes keep accessibility and layout work bounded even for
        // a page containing no line breaks. Cell data never becomes markup.
        for (let start = 0; start < message.text.length;) {
            let end = Math.min(start + 2048, message.text.length);
            const last = message.text.charCodeAt(end - 1);
            if (end < message.text.length && last >= 0xd800 && last <= 0xdbff) end++;
            content.append(document.createTextNode(message.text.slice(start, end)));
            start = end;
        }
        get('status').textContent = 'Bytes ' + message.byteStart.toLocaleString() + '–' + message.byteEnd.toLocaleString() + ' of ' + message.byteLength.toLocaleString();
    } else {
        get('status').textContent = message.text;
        // A refused page must not replace the last successfully rendered state.
        get('page').value = state.page + 1;
    }
    get('previous').disabled = state.page <= 0; get('next').disabled = state.page >= pages - 1; get('last').disabled = state.page >= pages - 1;
});
request(state.page, state.mode);
</script></body></html>`;
}
