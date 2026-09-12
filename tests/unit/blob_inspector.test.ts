import './vscode_mock_setup';

import assert from 'node:assert';
import { afterEach, describe, it, mock } from 'node:test';
import { DEFAULT_MAX_CELL_EDIT_BYTES } from '../../src/core/cell-edit-policy';
import type { CellContentType, DbParams, RecordId } from '../../src/core/types';

(globalThis as any).acquireVsCodeApi = () => ({
    getState: () => undefined,
    setState() {},
    postMessage() {}
});

const inspectorModulePath = '../../core/ui/modules/blob-inspector.js';
const apiModulePath = '../../core/ui/modules/api.js';
const stateModulePath = '../../core/ui/modules/state.js';

interface MediaPreviewRequestOptions {
    type: CellContentType;
    webviewId: string;
    requestId: string;
    sourceByteLength: number;
}

interface MediaPreviewSuccess {
    success: true;
    previewId: string;
    uri: string;
    mime: string;
    byteLength: number;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

interface PreviewElement {
    tagName: string;
    style: Record<string, string>;
    children: PreviewElement[];
    listeners: Map<string, (event: any) => void>;
    attributes: Map<string, string>;
    disabled: boolean;
    value: string;
    textContent: string;
    appendChild(child: PreviewElement): void;
    addEventListener(name: string, listener: (event: any) => void): void;
    setAttribute(name: string, value: string): void;
    contains(node: unknown): boolean;
}

function previewElement(tag = 'div'): PreviewElement {
    let value = '';
    const children: ReturnType<typeof previewElement>[] = [];
    const listeners = new Map<string, (event: any) => void>();
    const attributes = new Map<string, string>();
    return {
        tagName: tag.toUpperCase(), style: {} as Record<string, string>, children, listeners,
        attributes, disabled: false, value: '',
        get textContent(): string { return value + children.map(child => child.textContent).join(''); },
        set textContent(text: string) { value = text; children.length = 0; },
        appendChild(child: ReturnType<typeof previewElement>) { children.push(child); },
        addEventListener(name: string, listener: (event: any) => void) { listeners.set(name, listener); },
        setAttribute(name: string, value: string) { attributes.set(name, value); },
        contains(node: unknown) { return node === this || children.some(child => child.contains(node)); }
    };
}

function previewDescendants(element: PreviewElement): PreviewElement[] {
    return [element, ...element.children.flatMap(previewDescendants)];
}

function previewText(element: PreviewElement): PreviewElement {
    const pre = previewDescendants(element).find(child => child.tagName === 'PRE');
    assert.ok(pre, 'The preview contains selectable text');
    return pre;
}

function completePreviewText(element: PreviewElement): string {
    const next = previewDescendants(element).find(child => child.tagName === 'BUTTON' && child.textContent === 'Next');
    let text = '';
    for (let page = 0; page < 10000; page++) {
        const current = previewText(element).textContent;
        assert.ok(current.length <= 65536);
        assert.ok(current.split(/\r\n|[\r\n\v\f\u0085\u2028\u2029]/).length <= 1025);
        assert.doesNotMatch(current, /^[\udc00-\udfff]|[\ud800-\udbff]$/);
        text += current;
        if (!next || next.disabled) return text;
        next.listeners.get('click')!({});
    }
    assert.fail('Preview navigation did not reach its final page');
}

function inspectorHarness(BlobInspector: any) {
    const rendered: Uint8Array[] = [];
    const hexed: Uint8Array[] = [];
    const statuses: string[] = [];
    const mediaUris: Array<{ uri: string; type: any; generation: number }> = [];
    const inspector = Object.create(BlobInspector.prototype);
    Object.assign(inspector, {
        currentObjectUrl: null,
        currentData: null,
        currentType: null,
        currentRowId: null,
        currentColName: null,
        currentCellInfo: null,
        currentOversizedMetadata: null,
        currentMediaPreview: null,
        previewGeneration: 0,
        modal: { classList: { remove() {}, add() {} } },
        previewContainer: { innerHTML: '', appendChild() {} },
        hexContainer: { value: '' },
        infoContainer: { textContent: '' },
        cleanup() {
            this.currentData = null;
            this.currentOversizedMetadata = null;
        },
        setUploadState() {},
        switchTab() {},
        renderPreview(data: Uint8Array) { rendered.push(data); },
        renderHex(data: Uint8Array) { hexed.push(data); },
        renderOversizedMediaStatus(message: string) { statuses.push(message); },
        renderMediaUri(uri: string, type: any, generation: number) {
            mediaUris.push({ uri, type, generation });
        }
    });
    return { inspector, rendered, hexed, statuses, mediaUris };
}

function streamedInspectorHarness(BlobInspector: any) {
    const previewContainer = {
        innerHTML: '',
        children: [] as any[],
        appendChild(child: any) { this.children.push(child); },
        replaceChildren(...children: any[]) { this.children = [...children]; }
    };
    const inspector = Object.create(BlobInspector.prototype);
    Object.assign(inspector, {
        currentObjectUrl: null,
        currentMediaPreview: null,
        previewGeneration: 0,
        currentData: null,
        currentType: null,
        currentRowId: null,
        currentColName: null,
        currentCellInfo: null,
        currentOversizedMetadata: null,
        oversizedLoadedBytes: 0,
        isLoadingOversized: false,
        isUploading: false,
        modal: { classList: { remove() {}, add() {} } },
        previewContainer,
        hexContainer: { value: '' },
        infoContainer: { textContent: '' },
        cleanup() {
            this.previewGeneration++;
            this.currentData = null;
            this.currentType = null;
            this.currentRowId = null;
            this.currentColName = null;
            this.currentCellInfo = null;
            this.currentOversizedMetadata = null;
            this.oversizedLoadedBytes = 0;
        },
        setUploadState() {},
        switchTab() {},
        renderHex() {}
    });
    return { inspector, previewContainer };
}

describe('BlobInspector oversized containment', () => {
    afterEach(async () => {
        delete (globalThis as any).document;
        const { state } = await import(stateModulePath);
        state.selectedTable = null;
        state.selectedTableType = 'table';
    });

    it('caps BLOB and TEXT previews without splitting a UTF-8 code point', async () => {
        const {
            MAX_OVERSIZED_INSPECTOR_PREVIEW_BYTES,
            capOversizedInspectorPreview
        } = await import(inspectorModulePath);
        const blob = new Uint8Array(MAX_OVERSIZED_INSPECTOR_PREVIEW_BYTES * 2).fill(0x41);
        const cappedBlob = capOversizedInspectorPreview(blob, 'blob');
        assert.strictEqual(cappedBlob.byteLength, MAX_OVERSIZED_INSPECTOR_PREVIEW_BYTES);

        const text = '😀'.repeat(MAX_OVERSIZED_INSPECTOR_PREVIEW_BYTES / 2);
        const cappedText = capOversizedInspectorPreview(text, 'text');
        assert.ok(cappedText.byteLength <= MAX_OVERSIZED_INSPECTOR_PREVIEW_BYTES);
        assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(cappedText));
        assert.doesNotMatch(new TextDecoder().decode(cappedText), /�/);
    });

    it('makes every admitted TEXT byte accessible through bounded pages after Load more', async () => {
        const { BlobInspector, MAX_OVERSIZED_INSPECTOR_PREVIEW_BYTES, OVERSIZED_INSPECTOR_LOAD_STEP_BYTES } =
            await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const originalApi = {
            openCellReadSession: backendApi.openCellReadSession,
            readCellChunk: backendApi.readCellChunk,
            closeCellReadSession: backendApi.closeCellReadSession
        };
        // The initial cap lands inside the first emoji. The leading BOM is
        // stored content and must survive both initial and streamed rendering.
        const admittedText = '\ufeff' + 'A'.repeat(MAX_OVERSIZED_INSPECTOR_PREVIEW_BYTES - 5);
        const fullText = admittedText + '😀東京'.repeat(150_000);
        const fullBytes = new TextEncoder().encode(fullText);
        let opened = 0;
        let closed = 0;
        backendApi.openCellReadSession = async () => {
            opened++;
            return {
                sessionId: `text-${opened}`,
                metadata: { storageClass: 'text', byteLength: fullBytes.byteLength, textEncoding: 'utf-8' },
                expiresAt: Date.now() + 30_000
            };
        };
        backendApi.readCellChunk = async (_sessionId: string, offset: number, maxBytes: number) => {
            const bytes = fullBytes.slice(offset, offset + maxBytes);
            return { byteOffset: offset, bytes, done: offset + bytes.byteLength >= fullBytes.byteLength };
        };
        backendApi.closeCellReadSession = async () => { closed++; };
        state.selectedTable = 'items';
        (globalThis as any).document = {
            createElement: previewElement
        };
        const { inspector, previewContainer } = streamedInspectorHarness(BlobInspector);

        try {
            await inspector.inspectOversized(
                fullText.slice(0, 100_000),
                { storageClass: 'text', byteLength: fullBytes.byteLength },
                1, 'body', 0, 0
            );
            const initialText = previewContainer.children.at(-1)?.textContent;
            assert.strictEqual(new TextEncoder().encode(initialText).byteLength,
                MAX_OVERSIZED_INSPECTOR_PREVIEW_BYTES - 2);
            assert.strictEqual(initialText, admittedText);
            assert.strictEqual(previewContainer.children.at(-1)?.style.whiteSpace, 'pre-wrap');
            assert.strictEqual(opened, 0);

            assert.strictEqual(await inspector.loadMoreOversizedContent(), true);
            const prefix = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
                fullBytes.subarray(0, OVERSIZED_INSPECTOR_LOAD_STEP_BYTES), { stream: true }
            );
            assert.strictEqual(completePreviewText(previewContainer.children.at(-1)), prefix);
            const expandedPreview = previewText(previewContainer.children.at(-1));
            assert.strictEqual(expandedPreview.style.whiteSpace, 'pre-wrap');
            assert.ok(expandedPreview.children.length > 1);
            assert.ok(expandedPreview.children.every((block: { textContent: string }) =>
                block.textContent.length <= 2048));
            assert.ok(prefix.length > initialText.length);
            assert.doesNotMatch(prefix, /�/);

            assert.strictEqual(await inspector.loadMoreOversizedContent(), true);
            assert.strictEqual(completePreviewText(previewContainer.children.at(-1)), fullText);
            assert.strictEqual(opened, 2);
            assert.strictEqual(closed, 2);
        } finally {
            Object.assign(backendApi, originalApi);
        }
    });

    for (const encoding of ['utf-16le', 'utf-16be']) {
        it(`reads stored ${encoding} bytes before displaying the initial TEXT Hex`, async () => {
            const { BlobInspector, MAX_OVERSIZED_INSPECTOR_PREVIEW_BYTES } = await import(inspectorModulePath);
            const { backendApi } = await import(apiModulePath);
            const { state } = await import(stateModulePath);
            const originalApi = {
                openCellReadSession: backendApi.openCellReadSession,
                readCellChunk: backendApi.readCellChunk,
                closeCellReadSession: backendApi.closeCellReadSession
            };
            const text = '\ufeffAZ東京😀'.repeat(100_000);
            const bytes = Buffer.from(text, 'utf16le');
            if (encoding === 'utf-16be') bytes.swap16();
            let closed = 0;
            backendApi.openCellReadSession = async () => ({ sessionId: 'utf16',
                metadata: { storageClass: 'text', byteLength: bytes.byteLength, textEncoding: encoding }
            });
            backendApi.readCellChunk = async (_id: string, offset: number, count: number) => ({
                bytes: new Uint8Array(bytes.subarray(offset, offset + count)), byteOffset: offset,
                done: offset + count >= bytes.byteLength
            });
            backendApi.closeCellReadSession = async () => { closed++; };
            state.selectedTable = 'items';
            state.selectedTableType = 'table';
            (globalThis as any).document = {
                getElementById(id: string) {
                    return id === 'tab-preview' || id === 'tab-hex' ? { style: {} } : null;
                }
            };
            const { inspector, hexed } = inspectorHarness(BlobInspector);
            inspector.modal.querySelectorAll = () => [];
            try {
                await inspector.inspectOversized(text.slice(0, 1000),
                    { storageClass: 'text', byteLength: bytes.byteLength }, 1, 'body', 0, 0);
                assert.strictEqual(hexed.length, 0, 'A decoded string is not authoritative SQLite bytes');
                await BlobInspector.prototype.switchTab.call(inspector, 'hex');
                assert.deepStrictEqual(hexed.at(-1), new Uint8Array(bytes.subarray(0, MAX_OVERSIZED_INSPECTOR_PREVIEW_BYTES)));
                assert.strictEqual(closed, 1);
            } finally { Object.assign(backendApi, originalApi); }
        });
    }

    it('keeps ordinary preview lines wrapped even when the whole value is large', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        (globalThis as any).document = { createElement: previewElement };
        const { inspector, previewContainer } = streamedInspectorHarness(BlobInspector);
        const text = ('é東京😀'.repeat(1000) + '\n').repeat(50);

        inspector.renderPreview(new TextEncoder().encode(text), { type: 'text' }, { text });

        assert.strictEqual(completePreviewText(previewContainer.children.at(-1)), text);
        const preview = previewText(previewContainer.children.at(-1));
        assert.strictEqual(preview.style.whiteSpace, 'pre-wrap');
        assert.strictEqual(preview.style.wordBreak, 'break-all');
    });

    it('bounds layout blocks for large Unicode text containing many short lines', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        (globalThis as any).document = { createElement: previewElement };
        const { inspector, previewContainer } = streamedInspectorHarness(BlobInspector);
        const text = 'é😀\n'.repeat(150_000);

        inspector.renderPreview(new TextEncoder().encode(text), { type: 'text' }, { text });

        const preview = previewText(previewContainer.children.at(-1));
        assert.ok(preview.children.length > 1);
        assert.ok(preview.children.length <= 33);
        assert.ok(preview.children.every((block: { textContent: string }) =>
            block.textContent.length <= 2048 && !/[\ud800-\udbff]$/.test(block.textContent)));
        assert.strictEqual(preview.style.whiteSpace, 'pre-wrap');
        assert.strictEqual(completePreviewText(previewContainer.children.at(-1)), text);
    });

    it('keeps only a bounded selectable page in the DOM after loading many Unicode lines', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        (globalThis as any).document = { createElement: previewElement };
        const { inspector, previewContainer } = streamedInspectorHarness(BlobInspector);
        const text = 'é😀\n'.repeat(20_000);

        inspector.renderPreview(new TextEncoder().encode(text), { type: 'text' }, { text });

        const preview = previewContainer.children.at(-1);
        // CSS offscreen skipping is not a memory boundary: selection makes
        // skipped text eligible for layout. Do not attach the whole value.
        assert.ok(preview.textContent.length <= 65536 + 512,
            `A selectable preview retained ${preview.textContent.length} code units`);
        assert.ok(preview.textContent.split('\n').length <= 1026,
            'A selectable page must also bound many-short-line layout');
    });

    for (const [name, text] of [
        ['Unicode line', 'A'.repeat(65535) + '😀é東京'.repeat(20_000)],
        ['LF-only lines below the byte cap', '\n'.repeat(4097)],
        ['CRLF lines', 'é😀\r\n'.repeat(3073)],
        ['CR-only lines', 'é😀\r'.repeat(3073)],
        ['Unicode separator lines', 'é😀\u2028\u2029'.repeat(3073)],
        ['control separator lines', 'é😀\v\f\u0085'.repeat(3073)]
    ]) {
        it(`navigates every bounded ${name} page without losing or duplicating text`, async () => {
            const { BlobInspector } = await import(inspectorModulePath);
            (globalThis as any).document = { createElement: previewElement };
            const { inspector, previewContainer } = streamedInspectorHarness(BlobInspector);
            inspector.renderPreview(new TextEncoder().encode(text), { type: 'text' }, { text });

            assert.strictEqual(completePreviewText(previewContainer.children.at(-1)), text);
        });
    }

    it('rejects invalid text page navigation and preserves the displayed page', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        (globalThis as any).document = { createElement: previewElement };
        const { inspector, previewContainer } = streamedInspectorHarness(BlobInspector);
        inspector.renderPreview(new TextEncoder().encode('A'.repeat(131073)), { type: 'text' });
        const preview = previewContainer.children.at(-1);
        const elements = previewDescendants(preview);
        const input = elements.find(element => element.tagName === 'INPUT');
        const go = elements.find(element => element.tagName === 'BUTTON' && element.textContent === 'Go');
        assert.ok(input && go, 'Large text must expose bounded page navigation');
        const first = previewText(preview).textContent;
        for (const invalid of ['0', '-1', '1.5', '4', 'NaN', 'Infinity', '']) {
            input.value = invalid;
            go.listeners.get('click')!({});
            assert.strictEqual(previewText(preview).textContent, first);
            assert.strictEqual(input.value, '1');
        }
        input.value = '3';
        input.listeners.get('keydown')!({ key: 'Enter', preventDefault() {} });
        assert.strictEqual(previewText(preview).textContent, 'A');
        const previous = elements.find(element => element.tagName === 'BUTTON' && element.textContent === 'Previous')!;
        previous.listeners.get('click')!({});
        assert.strictEqual(input.value, '2');
        assert.strictEqual(previewText(preview).textContent, 'A'.repeat(65536));
    });

    it('copies selected long-preview text without adding formatting-block newlines', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { inspector, previewContainer } = streamedInspectorHarness(BlobInspector);
        let selectedPreview: ReturnType<typeof previewElement>;
        (globalThis as any).document = {
            createElement: previewElement,
            getSelection: () => ({
                rangeCount: 1,
                anchorNode: selectedPreview.children[0],
                focusNode: selectedPreview.children[1],
                getRangeAt: () => ({ cloneContents: () => ({ textContent: 'é東京😀original\nline break' }) })
            })
        };
        const text = 'é東京😀'.repeat(20_000);
        inspector.renderPreview(new TextEncoder().encode(text), { type: 'text' }, { text });
        selectedPreview = previewText(previewContainer.children.at(-1));
        const copied = new Map<string, string>();
        let prevented = false;

        selectedPreview.listeners.get('copy')?.({
            clipboardData: { setData: (type: string, data: string) => copied.set(type, data) },
            preventDefault() { prevented = true; }
        });

        assert.strictEqual(selectedPreview.textContent, text.slice(0, 65536));
        assert.ok(selectedPreview.children.every(block => !/[\ud800-\udbff]$/.test(block.textContent)));
        assert.strictEqual(copied.get('text/plain'), 'é東京😀original\nline break');
        assert.strictEqual(prevented, true);
    });

    it('bounds the long-preview DOM at the complete eight MiB read limit', async () => {
        const { BlobInspector, MAX_OVERSIZED_INSPECTOR_LOAD_BYTES } = await import(inspectorModulePath);
        (globalThis as any).document = { createElement: previewElement };
        const { inspector, previewContainer } = streamedInspectorHarness(BlobInspector);
        const text = 'A'.repeat(MAX_OVERSIZED_INSPECTOR_LOAD_BYTES);

        inspector.renderPreview(new TextEncoder().encode(text), { type: 'text' }, { text });

        assert.strictEqual(completePreviewText(previewContainer.children.at(-1)), text);
        const preview = previewText(previewContainer.children.at(-1));
        assert.ok(preview.children.length <= 33);
        assert.ok(preview.children.every((block: PreviewElement) => block.textContent.length <= 2048));
    });

    it('decodes database-encoded TEXT prefixes without corrupting split characters', async () => {
        const { decodeCellTextPrefix } = await import(inspectorModulePath);

        assert.strictEqual(
            decodeCellTextPrefix(Uint8Array.from([0x41, 0x00, 0x3d, 0xd8]), 'utf-16le', false),
            'A'
        );
        assert.strictEqual(
            decodeCellTextPrefix(Uint8Array.from([0x00, 0x41, 0xd8, 0x3d]), 'utf-16be', false),
            'A'
        );
        assert.strictEqual(
            decodeCellTextPrefix(Uint8Array.from([0x61, 0xf0, 0x9f, 0x98]), 'utf-8', false),
            'a'
        );
        assert.throws(
            () => decodeCellTextPrefix(Uint8Array.from([0xff]), 'utf-8', true),
            /encoded as utf-8/i
        );
    });

    it('automatically replaces a page-truncated modest TEXT preview with the full snapshot value', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const originalApi = {
            openCellReadSession: backendApi.openCellReadSession,
            readCellChunk: backendApi.readCellChunk,
            closeCellReadSession: backendApi.closeCellReadSession
        };
        const fullText = 'A'.repeat(2_000);
        const fullBytes = new TextEncoder().encode(fullText);
        const calls: Array<{ method: string; args: any[] }> = [];
        backendApi.openCellReadSession = async (...args: any[]) => {
            calls.push({ method: 'open', args });
            return {
                sessionId: 'session-small',
                metadata: { storageClass: 'text', byteLength: fullBytes.byteLength, textEncoding: 'utf-8' },
                expiresAt: Date.now() + 30_000
            };
        };
        backendApi.readCellChunk = async (...args: any[]) => {
            calls.push({ method: 'read', args });
            return { byteOffset: 0, bytes: fullBytes, done: true };
        };
        backendApi.closeCellReadSession = async (...args: any[]) => {
            calls.push({ method: 'close', args });
        };
        state.selectedTable = 'items';
        (globalThis as any).document = { createElement: previewElement };
        const { inspector, previewContainer } = streamedInspectorHarness(BlobInspector);

        try {
            await inspector.inspectOversized(
                'A'.repeat(419),
                { storageClass: 'text', byteLength: fullBytes.byteLength },
                0,
                'body',
                0,
                0
            );

            assert.deepStrictEqual(calls.map(call => call.method), ['open', 'read', 'close']);
            assert.deepStrictEqual(calls[0].args, [{ table: 'items', rowId: 0, column: 'body' }]);
            assert.deepStrictEqual(calls[1].args, ['session-small', 0, fullBytes.byteLength]);
            assert.deepStrictEqual(calls[2].args, ['session-small']);
            assert.deepStrictEqual(inspector.currentData, fullBytes);
            assert.strictEqual(inspector.oversizedLoadedBytes, fullBytes.byteLength);
            assert.strictEqual(previewContainer.children.at(-1)?.textContent, fullText);
            assert.match(inspector.infoContainer.textContent, /Full value 1\.95 KB/);
        } finally {
            Object.assign(backendApi, originalApi);
        }
    });

    for (const storageClass of ['text', 'blob']) it(`keeps full-content access separate from bounded ${storageClass} load-more`, async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const listeners = new Map<string, () => void>();
        const loadButton = {
            hidden: true,
            disabled: false,
            textContent: '',
            title: '',
            addEventListener(type: string, listener: () => void) {
                listeners.set(type, listener);
            }
        };
        const inspector = Object.create(BlobInspector.prototype);
        let loads = 0;
        Object.assign(inspector, {
            modal: { querySelectorAll() { return []; } },
            currentOversizedMetadata: { storageClass, byteLength: 4 * 1024 * 1024 },
            oversizedLoadedBytes: 1024 * 1024,
            isLoadingOversized: false,
            isUploading: false,
            currentCellInfo: null,
            loadMoreOversizedContent() { loads++; }
        });
        (globalThis as any).document = {
            getElementById(id: string) {
                return id === 'blob-load-more-btn' ? loadButton : null;
            }
        };

        inspector.setupEventListeners();
        inspector.setUploadState(false);
        listeners.get('click')?.();

        assert.strictEqual(loadButton.hidden, false);
        assert.strictEqual(loadButton.disabled, false);
        assert.strictEqual(loadButton.textContent, 'Load more');
        assert.match(loadButton.title, /next 1 MB.*snapshot/i);
        assert.strictEqual(loads, 1);
    });

    it('preserves modal focus during pointer tab switches without blocking activation', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const listeners = new Map<string, (event: any) => void>();
        const tabButton = {
            dataset: { tab: 'hex' },
            addEventListener(type: string, listener: (event: any) => void) {
                listeners.set(type, listener);
            }
        };
        const inspector = Object.create(BlobInspector.prototype);
        const switched: string[] = [];
        Object.assign(inspector, {
            modal: {
                querySelectorAll(selector: string) {
                    return selector === '.tab-btn' ? [tabButton] : [];
                }
            },
            switchTab(tab: string) { switched.push(tab); }
        });
        (globalThis as any).document = { getElementById() { return null; } };

        inspector.setupEventListeners();

        let pointerDefaultPrevented = false;
        listeners.get('mousedown')?.({
            preventDefault() { pointerDefaultPrevented = true; }
        });
        let activationDefaultPrevented = false;
        listeners.get('click')?.({
            target: tabButton,
            preventDefault() { activationDefaultPrevented = true; }
        });

        assert.strictEqual(pointerDefaultPrevented, true);
        assert.strictEqual(activationDefaultPrevented, false);
        assert.deepStrictEqual(switched, ['hex']);
    });

    it('pages through loaded BLOB Hex with bounded text nodes and no form-control value', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const inspector = Object.create(BlobInspector.prototype);
        const hexContainer = previewElement('pre');
        Object.defineProperty(hexContainer, 'value', {
            set() { throw new Error('Hex data must not become one accessibility form-control value'); }
        });
        inspector.hexContainer = hexContainer;
        const data = new Uint8Array(1024 * 1024).fill(0xa5);
        data[16 * 1024] = 0x42;
        (globalThis as any).document = { getElementById() { return null; }, createElement: previewElement };
        inspector.renderHex(data, 1);
        assert.match(hexContainer.textContent, /^00004000  42 a5/);
        assert.ok(hexContainer.textContent.length < 100_000);
        assert.ok(hexContainer.children.length > 1 && hexContainer.children.length <= 40);
        assert.ok(hexContainer.children.every(block => block.textContent.length <= 2048));
        inspector.renderHex(data, 63);
        assert.match(hexContainer.textContent, /^000fc000  a5 a5/);
        assert.ok(hexContainer.textContent.includes('000ffff0'));
        assert.ok(hexContainer.children.every(block => block.textContent.length <= 2048));
        inspector.renderHex(new Uint8Array());
        assert.strictEqual(hexContainer.textContent, '');
        assert.strictEqual(hexContainer.children.length, 0);
    });

    it('hides load-more after the current snapshot has been read completely', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const originalApi = {
            openCellReadSession: backendApi.openCellReadSession,
            readCellChunk: backendApi.readCellChunk,
            closeCellReadSession: backendApi.closeCellReadSession
        };
        const bytes = new TextEncoder().encode('complete value');
        const loadButton = { hidden: false, disabled: false, textContent: '', title: '' };
        backendApi.openCellReadSession = async () => ({
            sessionId: 'complete',
            metadata: { storageClass: 'text', byteLength: bytes.byteLength, textEncoding: 'utf-8' },
            expiresAt: Date.now() + 30_000
        });
        backendApi.readCellChunk = async () => ({ byteOffset: 0, bytes, done: true });
        backendApi.closeCellReadSession = async () => {};
        (globalThis as any).document = {
            getElementById(id: string) {
                return id === 'blob-load-more-btn' ? loadButton : null;
            },
            createElement() {
                return { style: {}, appendChild() {}, addEventListener() {}, textContent: '' };
            }
        };
        const { inspector } = streamedInspectorHarness(BlobInspector);
        Object.assign(inspector, {
            currentTable: 'items',
            currentRowId: 1,
            currentColName: 'body',
            currentOversizedMetadata: { storageClass: 'text', byteLength: bytes.byteLength },
            currentCellInfo: null,
            renderPreview() {},
            setUploadState: BlobInspector.prototype.setUploadState
        });

        try {
            assert.strictEqual(await inspector.loadMoreOversizedContent(), true);
            assert.strictEqual(loadButton.hidden, true);
            assert.strictEqual(loadButton.disabled, true);
            assert.strictEqual(loadButton.title, '');
        } finally {
            Object.assign(backendApi, originalApi);
        }
    });

    it('rereads every expanded prefix from offset zero so snapshots cannot be mixed', async () => {
        const { BlobInspector, OVERSIZED_INSPECTOR_LOAD_STEP_BYTES } =
            await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const originalApi = {
            openCellReadSession: backendApi.openCellReadSession,
            readCellChunk: backendApi.readCellChunk,
            closeCellReadSession: backendApi.closeCellReadSession
        };
        const totalBytes = (3 * OVERSIZED_INSPECTOR_LOAD_STEP_BYTES) + 1;
        const snapshots = [
            new Uint8Array(totalBytes).fill(0x41),
            new Uint8Array(totalBytes).fill(0x42)
        ];
        let sessionIndex = -1;
        const reads: Array<{ sessionId: string; offset: number; maxBytes: number }> = [];
        backendApi.openCellReadSession = async () => {
            sessionIndex++;
            return {
                sessionId: `snapshot-${sessionIndex}`,
                metadata: { storageClass: 'text', byteLength: totalBytes, textEncoding: 'utf-8' },
                expiresAt: Date.now() + 30_000
            };
        };
        backendApi.readCellChunk = async (sessionId: string, offset: number, maxBytes: number) => {
            reads.push({ sessionId, offset, maxBytes });
            const index = Number(sessionId.split('-')[1]);
            const bytes = snapshots[index].slice(offset, offset + maxBytes);
            return { byteOffset: offset, bytes, done: offset + bytes.byteLength >= totalBytes };
        };
        backendApi.closeCellReadSession = async () => {};
        const { inspector } = streamedInspectorHarness(BlobInspector);
        Object.assign(inspector, {
            currentTable: 'items',
            currentRowId: 1,
            currentColName: 'body',
            currentOversizedMetadata: { storageClass: 'text', byteLength: totalBytes },
            renderPreview() {}
        });

        try {
            assert.strictEqual(await inspector.loadMoreOversizedContent(), true);
            assert.strictEqual(await inspector.loadMoreOversizedContent(), true);
            assert.deepStrictEqual(reads.map(read => [read.sessionId, read.offset]), [
                ['snapshot-0', 0],
                ['snapshot-1', 0],
                ['snapshot-1', OVERSIZED_INSPECTOR_LOAD_STEP_BYTES]
            ]);
            assert.strictEqual(inspector.currentData.byteLength, 2 * OVERSIZED_INSPECTOR_LOAD_STEP_BYTES);
            assert.ok(inspector.currentData.every((byte: number) => byte === 0x42));
        } finally {
            Object.assign(backendApi, originalApi);
        }
    });

    it('rejects malformed chunk protocol responses and always closes the snapshot', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const originalApi = {
            openCellReadSession: backendApi.openCellReadSession,
            readCellChunk: backendApi.readCellChunk,
            closeCellReadSession: backendApi.closeCellReadSession
        };
        const status = { textContent: '' };
        const consoleError = mock.method(console, 'error', () => {});
        const malformed = [
            {
                name: 'wrong offset',
                chunk: { byteOffset: 1, bytes: Uint8Array.of(1, 2, 3, 4), done: true },
                message: /offset 1 instead of 0/i
            },
            {
                name: 'oversized chunk',
                chunk: { byteOffset: 0, bytes: Uint8Array.of(1, 2, 3, 4, 5), done: true },
                message: /more bytes than requested/i
            },
            {
                name: 'premature empty chunk',
                chunk: { byteOffset: 0, bytes: new Uint8Array(), done: false },
                message: /ended before the advertised byte length/i
            },
            {
                name: 'inconsistent done flag',
                chunk: { byteOffset: 0, bytes: Uint8Array.of(1, 2, 3, 4), done: false },
                message: /inconsistent completion metadata/i
            }
        ];
        (globalThis as any).document = {
            getElementById(id: string) {
                return id === 'statusText' ? status : null;
            }
        };

        try {
            for (const scenario of malformed) {
                let closes = 0;
                backendApi.openCellReadSession = async () => ({
                    sessionId: scenario.name,
                    metadata: { storageClass: 'blob', byteLength: 4 }
                });
                backendApi.readCellChunk = async () => scenario.chunk;
                backendApi.closeCellReadSession = async () => { closes++; };
                const { inspector } = streamedInspectorHarness(BlobInspector);
                Object.assign(inspector, {
                    currentTable: 'items',
                    currentRowId: 1,
                    currentColName: 'payload',
                    currentOversizedMetadata: { storageClass: 'blob', byteLength: 4 },
                    currentData: Uint8Array.of(9),
                    renderPreview() {}
                });

                assert.strictEqual(
                    await inspector.loadMoreOversizedContent(4),
                    false,
                    scenario.name
                );
                assert.strictEqual(closes, 1, scenario.name);
                assert.deepStrictEqual(inspector.currentData, Uint8Array.of(9), scenario.name);
                assert.match(status.textContent, scenario.message, scenario.name);
            }
        } finally {
            Object.assign(backendApi, originalApi);
            consoleError.mock.restore();
        }
    });

    it('does not publish bytes when snapshot cleanup fails', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const originalApi = {
            openCellReadSession: backendApi.openCellReadSession,
            readCellChunk: backendApi.readCellChunk,
            closeCellReadSession: backendApi.closeCellReadSession
        };
        const status = { textContent: '' };
        const consoleError = mock.method(console, 'error', () => {});
        (globalThis as any).document = {
            getElementById(id: string) {
                return id === 'statusText' ? status : null;
            }
        };
        backendApi.openCellReadSession = async () => ({
            sessionId: 'cleanup-fails',
            metadata: { storageClass: 'blob', byteLength: 4 }
        });
        backendApi.readCellChunk = async () => ({
            byteOffset: 0,
            bytes: Uint8Array.of(1, 2, 3, 4),
            done: true
        });
        backendApi.closeCellReadSession = async () => {
            throw new Error('snapshot cleanup failed');
        };
        const { inspector } = streamedInspectorHarness(BlobInspector);
        Object.assign(inspector, {
            currentTable: 'items',
            currentRowId: 1,
            currentColName: 'payload',
            currentOversizedMetadata: { storageClass: 'blob', byteLength: 4 },
            currentData: Uint8Array.of(9),
            renderPreview() {}
        });

        try {
            assert.strictEqual(await inspector.loadMoreOversizedContent(4), false);
            assert.deepStrictEqual(inspector.currentData, Uint8Array.of(9));
            assert.match(status.textContent, /snapshot cleanup failed/i);
        } finally {
            Object.assign(backendApi, originalApi);
            consoleError.mock.restore();
        }
    });

    it('stops at the bounded inspector cap without opening another snapshot', async () => {
        const { BlobInspector, MAX_OVERSIZED_INSPECTOR_LOAD_BYTES } =
            await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const originalOpen = backendApi.openCellReadSession;
        const open = mock.fn(async () => {
            throw new Error('must not open');
        });
        backendApi.openCellReadSession = open;
        const { inspector } = streamedInspectorHarness(BlobInspector);
        Object.assign(inspector, {
            currentTable: 'items',
            currentRowId: 1,
            currentColName: 'body',
            currentOversizedMetadata: {
                storageClass: 'text',
                byteLength: MAX_OVERSIZED_INSPECTOR_LOAD_BYTES * 2
            },
            oversizedLoadedBytes: MAX_OVERSIZED_INSPECTOR_LOAD_BYTES
        });

        try {
            assert.strictEqual(await inspector.loadMoreOversizedContent(), false);
            assert.strictEqual(open.mock.callCount(), 0);
        } finally {
            backendApi.openCellReadSession = originalOpen;
        }
    });

    it('lets a reopened inspector load while the closed cell read finishes in the background', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const originalApi = {
            openCellReadSession: backendApi.openCellReadSession,
            readCellChunk: backendApi.readCellChunk,
            closeCellReadSession: backendApi.closeCellReadSession
        };
        const firstRead = deferred<any>();
        const secondRead = deferred<any>();
        let opens = 0;
        backendApi.openCellReadSession = async () => {
            opens++;
            return {
                sessionId: `session-${opens}`,
                metadata: { storageClass: 'text', byteLength: 1, textEncoding: 'utf-8' },
                expiresAt: Date.now() + 30_000
            };
        };
        backendApi.readCellChunk = async (sessionId: string) =>
            sessionId === 'session-1' ? firstRead.promise : secondRead.promise;
        backendApi.closeCellReadSession = async () => {};
        const { inspector } = streamedInspectorHarness(BlobInspector);
        Object.assign(inspector, {
            currentTable: 'items',
            currentRowId: 1,
            currentColName: 'body',
            currentOversizedMetadata: { storageClass: 'text', byteLength: 1 },
            renderPreview() {}
        });

        try {
            const staleLoad = inspector.loadMoreOversizedContent(1);
            await new Promise<void>(resolve => setImmediate(resolve));
            BlobInspector.prototype.cleanup.call(inspector);
            Object.assign(inspector, {
                currentTable: 'items',
                currentRowId: 2,
                currentColName: 'body',
                currentOversizedMetadata: { storageClass: 'text', byteLength: 1 }
            });
            const currentLoad = inspector.loadMoreOversizedContent(1);
            await new Promise<void>(resolve => setImmediate(resolve));

            assert.strictEqual(opens, 2);
            firstRead.resolve({ byteOffset: 0, bytes: Uint8Array.of(0x41), done: true });
            assert.strictEqual(await staleLoad, false);
            assert.strictEqual(inspector.isLoadingOversized, true);

            secondRead.resolve({ byteOffset: 0, bytes: Uint8Array.of(0x42), done: true });
            assert.strictEqual(await currentLoad, true);
            assert.deepStrictEqual(inspector.currentData, Uint8Array.of(0x42));
            assert.strictEqual(inspector.isLoadingOversized, false);
        } finally {
            Object.assign(backendApi, originalApi);
        }
    });

    it('renders only the capped sidecar preview while retaining the exact source size', async () => {
        const { BlobInspector, MAX_OVERSIZED_INSPECTOR_PREVIEW_BYTES } =
            await import(inspectorModulePath);
        const { inspector, rendered, hexed } = inspectorHarness(BlobInspector);
        const preview = new Uint8Array(MAX_OVERSIZED_INSPECTOR_PREVIEW_BYTES * 2).fill(0x41);

        inspector.inspectOversized(
            preview,
            { storageClass: 'blob', byteLength: 256 * 1024 * 1024 },
            1,
            'payload',
            0,
            0
        );

        assert.strictEqual(inspector.currentData.byteLength, MAX_OVERSIZED_INSPECTOR_PREVIEW_BYTES);
        assert.strictEqual(rendered[0].byteLength, MAX_OVERSIZED_INSPECTOR_PREVIEW_BYTES);
        assert.strictEqual(hexed[0].byteLength, MAX_OVERSIZED_INSPECTOR_PREVIEW_BYTES);
        assert.strictEqual(inspector.currentOversizedMetadata.byteLength, 256 * 1024 * 1024);
        assert.match(inspector.infoContainer.textContent, /Preview .* of 256 MB/i);
        assert.match(inspector.infoContainer.textContent, /desktop.*temporary file.*web.*preview-only/i);
    });

    it('keeps the small-cell inspector input byte-identical', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { inspector, rendered, hexed } = inspectorHarness(BlobInspector);
        const small = Uint8Array.from([0, 1, 2, 255]);

        inspector.inspect(small, 1, 'payload', 0, 0);

        assert.strictEqual(inspector.currentData, small);
        assert.strictEqual(rendered[0], small);
        assert.strictEqual(hexed[0], small);
        assert.strictEqual(inspector.currentOversizedMetadata, null);
    });

    it('binds a normal BLOB inspector replacement to the table it was opened from', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { state } = await import(stateModulePath);
        const { inspector } = inspectorHarness(BlobInspector);
        Object.assign(inspector, {
            activeReplacement: null,
            isUploading: false,
            setUploadState() {}
        });
        state.selectedTable = 'source_table';
        (globalThis as any).document = {
            getElementById() { return null; }
        };

        inspector.inspect(Uint8Array.of(0x01), 7, 'payload', 0, 0);
        state.selectedTable = 'different_table';
        const operation = inspector.beginReplacementOperation();

        assert.strictEqual(operation?.targetTable, 'source_table');
    });

    it('labels oversized TEXT as a TEXT inspector and restores the BLOB label for binary values', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { inspector } = inspectorHarness(BlobInspector);
        const title = { textContent: 'BLOB Inspector' };
        const closeButton = {
            ariaLabel: 'Close BLOB inspector',
            setAttribute(name: string, value: string) {
                if (name === 'aria-label') this.ariaLabel = value;
            }
        };
        const hexContainer = {
            value: '',
            ariaLabel: 'BLOB hexadecimal data',
            setAttribute(name: string, value: string) {
                if (name === 'aria-label') this.ariaLabel = value;
            }
        };
        inspector.hexContainer = hexContainer;
        inspector.modal.querySelector = (selector: string) => {
            if (selector === '#blobInspectorModalTitle') return title;
            if (selector === '.modal-close') return closeButton;
            return null;
        };
        (globalThis as any).document = {
            getElementById(id: string) {
                return id === 'blobInspectorModalTitle' ? title : null;
            }
        };

        inspector.inspectOversized(
            'bounded',
            { storageClass: 'text', byteLength: 2 * 1024 * 1024 },
            1,
            'body',
            0,
            0
        );
        assert.strictEqual(title.textContent, 'TEXT Inspector');
        assert.strictEqual(closeButton.ariaLabel, 'Close TEXT inspector');
        assert.strictEqual(hexContainer.ariaLabel, 'TEXT hexadecimal data');

        inspector.inspect(Uint8Array.of(0x00), 1, 'payload', 0, 1);
        assert.strictEqual(title.textContent, 'BLOB Inspector');
        assert.strictEqual(closeButton.ariaLabel, 'Close BLOB inspector');
        assert.strictEqual(hexContainer.ariaLabel, 'BLOB hexadecimal data');
    });

    it('renders retained malformed TEXT bytes without opening a table-only read session', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { state } = await import(stateModulePath);
        const { inspector, hexed } = inspectorHarness(BlobInspector);
        const loadMoreOversizedContent = mock.fn(async () => false);
        inspector.loadMoreOversizedContent = loadMoreOversizedContent;
        state.selectedTable = 'malformed_text_view';
        state.selectedTableType = 'view';
        (globalThis as any).document = { getElementById() { return null; } };

        await inspector.inspectOversized(
            Uint8Array.of(0x80),
            { storageClass: 'text', byteLength: 1 },
            0,
            'value',
            0,
            0
        );

        assert.deepStrictEqual(inspector.currentData, Uint8Array.of(0x80));
        assert.deepStrictEqual(hexed.at(-1), Uint8Array.of(0x80));
        assert.strictEqual(inspector.oversizedLoadedBytes, 1);
        assert.strictEqual(inspector.currentType.type, 'binary');
        assert.strictEqual(loadMoreOversizedContent.mock.callCount(), 0);
    });

    it('keeps retained malformed table TEXT connected to its bounded cell reader', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { state } = await import(stateModulePath);
        const { inspector } = inspectorHarness(BlobInspector);
        const loadMoreOversizedContent = mock.fn(async () => true);
        inspector.loadMoreOversizedContent = loadMoreOversizedContent;
        state.selectedTable = 'malformed_text_table';
        state.selectedTableType = 'table';
        (globalThis as any).document = { getElementById() { return null; } };

        await inspector.inspectOversized(
            Uint8Array.of(0x80),
            { storageClass: 'text', byteLength: 1 },
            7,
            'value',
            0,
            0
        );

        assert.strictEqual(loadMoreOversizedContent.mock.callCount(), 1);
        assert.deepStrictEqual(loadMoreOversizedContent.mock.calls[0].arguments, [1]);
    });

    it('rejects an over-edit-limit replacement before reading the file', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const originalUpdateCell = backendApi.updateCell;
        const updateCell = mock.fn(async () => 1);
        const arrayBuffer = mock.fn(async () => new ArrayBuffer(0));
        const consoleError = mock.method(console, 'error', () => {});
        backendApi.updateCell = updateCell;
        state.selectedTable = 'large_cells';
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'statusText') return { textContent: '' };
                return null;
            }
        };
        const inspector = Object.create(BlobInspector.prototype);
        Object.assign(inspector, {
            currentData: Uint8Array.from([1]),
            currentRowId: 1,
            currentColName: 'payload',
            currentCellInfo: { rowIdx: 0, colIdx: 0 },
            currentOversizedMetadata: null,
            isUploading: false,
            setUploadState() {}
        });

        try {
            await inspector.uploadFile({
                name: 'too-large.bin',
                size: DEFAULT_MAX_CELL_EDIT_BYTES + 1,
                arrayBuffer
            });
            assert.strictEqual(arrayBuffer.mock.callCount(), 0);
            assert.strictEqual(updateCell.mock.callCount(), 0);
        } finally {
            backendApi.updateCell = originalUpdateCell;
            consoleError.mock.restore();
        }
    });

    it('replaces a BLOB whose valid SQLite rowid is zero', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const originalUpdateCell = backendApi.updateCell;
        const originalState = {
            selectedTable: state.selectedTable,
            selectedTableType: state.selectedTableType,
            tableColumns: state.tableColumns,
            gridData: state.gridData,
            gridExactIntegerTexts: state.gridExactIntegerTexts,
            gridOversizedCells: state.gridOversizedCells
        };
        const updateCell = mock.fn(async () => 0);
        backendApi.updateCell = updateCell;
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'payload' }];
        state.gridData = [[0, Uint8Array.of(0x01)]];
        state.gridExactIntegerTexts = {};
        state.gridOversizedCells = {};
        (globalThis as any).document = {
            getElementById(id: string) {
                return id === 'statusText' ? { textContent: '' } : null;
            }
        };
        const inspector = Object.create(BlobInspector.prototype);
        const inspected: any[][] = [];
        Object.assign(inspector, {
            currentData: Uint8Array.of(0x01),
            currentRowId: 0,
            currentColName: 'payload',
            currentCellInfo: { rowIdx: 0, colIdx: 0 },
            currentOversizedMetadata: null,
            isUploading: false,
            setUploadState() {},
            inspect(...args: any[]) { inspected.push(args); }
        });

        try {
            await inspector.uploadFile({
                name: 'zero.bin',
                size: 2,
                arrayBuffer: async () => Uint8Array.of(0xaa, 0xbb).buffer
            });
            assert.strictEqual(updateCell.mock.callCount(), 1);
            assert.deepStrictEqual(updateCell.mock.calls[0].arguments.slice(0, 4), [
                'items',
                0,
                'payload',
                Uint8Array.of(0xaa, 0xbb)
            ]);
            assert.deepStrictEqual(state.gridData[0][1], Uint8Array.of(0xaa, 0xbb));
            assert.strictEqual(inspected.length, 1);
        } finally {
            backendApi.updateCell = originalUpdateCell;
            Object.assign(state, originalState);
        }
    });

    it('preserves the SQLite TEXT storage class when replacing oversized TEXT from a UTF-8 file', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const originalUpdateCell = backendApi.updateCell;
        const originalState = {
            isReadOnly: state.isReadOnly,
            selectedTable: state.selectedTable,
            selectedTableType: state.selectedTableType,
            tableColumns: state.tableColumns,
            gridData: state.gridData,
            gridExactIntegerTexts: state.gridExactIntegerTexts,
            gridOversizedCells: state.gridOversizedCells
        };
        const replacement = 'replacement é😀\n';
        const replacementBytes = new TextEncoder().encode(replacement);
        const updateCell = mock.fn(async () => 1);
        backendApi.updateCell = updateCell;
        state.isReadOnly = false;
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'body' }];
        state.gridData = [[1, 'old preview']];
        state.gridExactIntegerTexts = {};
        state.gridOversizedCells = {};
        (globalThis as any).document = {
            getElementById(id: string) {
                return id === 'statusText' ? { textContent: '' } : null;
            }
        };
        const inspector = Object.create(BlobInspector.prototype);
        const inspected: any[][] = [];
        Object.assign(inspector, {
            currentData: 'old preview',
            currentType: { mime: 'text/plain', type: 'text', ext: 'txt' },
            currentRowId: 1,
            currentColName: 'body',
            currentCellInfo: { rowIdx: 0, colIdx: 0 },
            currentOversizedMetadata: {
                storageClass: 'text',
                byteLength: 2 * 1024 * 1024,
                textEncoding: 'utf-8'
            },
            isUploading: false,
            setUploadState() {},
            inspect(...args: any[]) { inspected.push(args); }
        });

        try {
            await inspector.uploadFile({
                name: 'replacement.txt',
                size: replacementBytes.byteLength,
                arrayBuffer: async () => replacementBytes.buffer
            });

            assert.strictEqual(updateCell.mock.callCount(), 1);
            assert.strictEqual(
                (updateCell.mock.calls[0].arguments as unknown as unknown[])[3],
                replacement
            );
            assert.strictEqual(state.gridData[0][1], replacement);
            assert.strictEqual(inspected[0][0], replacement);
        } finally {
            backendApi.updateCell = originalUpdateCell;
            Object.assign(state, originalState);
        }
    });

    it('preserves the SQLite TEXT storage class when replacing a regular TEXT cell', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const originalUpdateCell = backendApi.updateCell;
        const originalState = {
            isReadOnly: state.isReadOnly,
            selectedTable: state.selectedTable,
            selectedTableType: state.selectedTableType,
            tableColumns: state.tableColumns,
            gridData: state.gridData,
            gridExactIntegerTexts: state.gridExactIntegerTexts,
            gridOversizedCells: state.gridOversizedCells
        };
        const replacement = 'regular replacement é😀';
        const replacementBytes = new TextEncoder().encode(replacement);
        const updateCell = mock.fn(async () => 1);
        backendApi.updateCell = updateCell;
        state.isReadOnly = false;
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'body' }];
        state.gridData = [[1, 'old body']];
        state.gridExactIntegerTexts = {};
        state.gridOversizedCells = {};
        (globalThis as any).document = {
            getElementById(id: string) {
                return id === 'statusText' ? { textContent: '' } : null;
            }
        };
        const inspector = Object.create(BlobInspector.prototype);
        Object.assign(inspector, {
            currentData: new TextEncoder().encode('old body'),
            currentType: { mime: 'text/plain', type: 'text', ext: 'txt' },
            currentRowId: 1,
            currentColName: 'body',
            currentCellInfo: { rowIdx: 0, colIdx: 0 },
            currentOversizedMetadata: null,
            activeReplacement: null,
            isUploading: false,
            setUploadState() {},
            inspect() {}
        });

        try {
            const operation = inspector.beginReplacementOperation();
            assert.ok(operation);
            await inspector.uploadFile({
                name: 'replacement.txt',
                size: replacementBytes.byteLength,
                arrayBuffer: async () => replacementBytes.buffer
            }, operation);

            assert.strictEqual(updateCell.mock.callCount(), 1);
            assert.strictEqual(
                (updateCell.mock.calls[0].arguments as unknown as unknown[])[3],
                replacement
            );
        } finally {
            backendApi.updateCell = originalUpdateCell;
            Object.assign(state, originalState);
        }
    });

    it('rejects invalid UTF-8 when replacing an oversized TEXT cell', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const originalUpdateCell = backendApi.updateCell;
        const originalState = {
            isReadOnly: state.isReadOnly,
            selectedTable: state.selectedTable,
            selectedTableType: state.selectedTableType,
            tableColumns: state.tableColumns,
            gridData: state.gridData
        };
        const status = { textContent: '' };
        const updateCell = mock.fn(async () => 1);
        const consoleError = mock.method(console, 'error', () => {});
        backendApi.updateCell = updateCell;
        state.isReadOnly = false;
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'body' }];
        state.gridData = [[1, 'old preview']];
        (globalThis as any).document = {
            getElementById(id: string) {
                return id === 'statusText' ? status : null;
            }
        };
        const inspector = Object.create(BlobInspector.prototype);
        Object.assign(inspector, {
            currentData: 'old preview',
            currentRowId: 1,
            currentColName: 'body',
            currentCellInfo: { rowIdx: 0, colIdx: 0 },
            currentOversizedMetadata: {
                storageClass: 'text',
                byteLength: 2 * 1024 * 1024,
                textEncoding: 'utf-8'
            },
            isUploading: false,
            setUploadState() {},
            inspect() {}
        });

        try {
            const invalidUtf8 = Uint8Array.of(0xc3, 0x28);
            await inspector.uploadFile({
                name: 'invalid.txt',
                size: invalidUtf8.byteLength,
                arrayBuffer: async () => invalidUtf8.buffer
            });

            assert.strictEqual(updateCell.mock.callCount(), 0);
            assert.strictEqual(state.gridData[0][1], 'old preview');
            assert.match(status.textContent, /valid UTF-8/i);
        } finally {
            backendApi.updateCell = originalUpdateCell;
            Object.assign(state, originalState);
            consoleError.mock.restore();
        }
    });

    it('does not retarget a pending file picker after the inspector is reopened', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const originalApi = {
            getExtensionSettings: backendApi.getExtensionSettings,
            selectFile: backendApi.selectFile,
            updateCell: backendApi.updateCell
        };
        const selectedFile = deferred<any>();
        const updateCell = mock.fn(async () => 2);
        backendApi.getExtensionSettings = async () => ({ fileOperations: 'native' });
        backendApi.selectFile = async () => selectedFile.promise;
        backendApi.updateCell = updateCell;
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'payload' }];
        state.gridData = [[1, Uint8Array.of(0x01)], [2, Uint8Array.of(0x02)]];
        (globalThis as any).document = {
            getElementById(id: string) {
                return id === 'statusText' ? { textContent: '' } : null;
            }
        };
        const { inspector } = streamedInspectorHarness(BlobInspector);
        Object.assign(inspector, {
            currentTable: 'items',
            currentData: Uint8Array.of(0x01),
            currentRowId: 1,
            currentColName: 'payload',
            currentCellInfo: { rowIdx: 0, colIdx: 0 },
            inspect() {}
        });

        try {
            const pending = inspector.handleReplace();
            await new Promise<void>(resolve => setImmediate(resolve));
            BlobInspector.prototype.cleanup.call(inspector);
            Object.assign(inspector, {
                currentTable: 'items',
                currentData: Uint8Array.of(0x02),
                currentRowId: 2,
                currentColName: 'payload',
                currentCellInfo: { rowIdx: 1, colIdx: 0 }
            });
            selectedFile.resolve({ name: 'picked.bin', data: Uint8Array.of(0xaa) });
            await pending;

            assert.strictEqual(updateCell.mock.callCount(), 0);
            assert.strictEqual(inspector.currentRowId, 2);
            assert.deepStrictEqual(inspector.currentData, Uint8Array.of(0x02));
        } finally {
            Object.assign(backendApi, originalApi);
        }
    });

    it('does not retarget a pending file picker after the database connection is reloaded', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const originalApi = {
            getExtensionSettings: backendApi.getExtensionSettings,
            selectFile: backendApi.selectFile,
            updateCell: backendApi.updateCell
        };
        const originalGeneration = {
            connection: state.connectionGeneration,
            content: state.contentGeneration
        };
        const selectedFile = deferred<any>();
        const updateCell = mock.fn(async () => 1);
        backendApi.getExtensionSettings = async () => ({ fileOperations: 'native' });
        backendApi.selectFile = async () => selectedFile.promise;
        backendApi.updateCell = updateCell;
        state.isReadOnly = false;
        state.connectionGeneration = 40;
        state.contentGeneration = 12;
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'payload' }];
        state.gridData = [[1, Uint8Array.of(0x01)]];
        (globalThis as any).document = {
            getElementById(id: string) {
                return id === 'statusText' ? { textContent: '' } : null;
            }
        };
        const { inspector } = streamedInspectorHarness(BlobInspector);
        Object.assign(inspector, {
            currentTable: 'items',
            currentData: Uint8Array.of(0x01),
            currentRowId: 1,
            currentColName: 'payload',
            currentCellInfo: { rowIdx: 0, colIdx: 0 },
            inspect() {}
        });

        try {
            const pending = inspector.handleReplace();
            await new Promise<void>(resolve => setImmediate(resolve));

            // Reload from disk can preserve the visible table and row identity
            // while replacing the database that those identifiers address.
            state.connectionGeneration++;
            selectedFile.resolve({ name: 'picked.bin', data: Uint8Array.of(0xaa) });
            await pending;

            assert.strictEqual(updateCell.mock.callCount(), 0);
        } finally {
            Object.assign(backendApi, originalApi);
            state.connectionGeneration = originalGeneration.connection;
            state.contentGeneration = originalGeneration.content;
        }
    });

    it('rejects malformed native file bytes instead of coercing unrelated fields', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const originalApi = {
            getExtensionSettings: backendApi.getExtensionSettings,
            selectFile: backendApi.selectFile,
            updateCell: backendApi.updateCell
        };
        const originalConsoleError = console.error;
        const status = { textContent: '' };
        const updateCell = mock.fn(async () => 1);
        backendApi.getExtensionSettings = async () => ({ fileOperations: 'native' });
        backendApi.selectFile = async () => ({
            name: 'malformed.bin',
            data: { 0: 7, length: 1, unrelated: 'must not become a byte' }
        } as any);
        backendApi.updateCell = updateCell;
        console.error = () => {};
        state.isReadOnly = false;
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'payload' }];
        state.gridData = [[1, Uint8Array.of(1)]];
        (globalThis as any).document = {
            getElementById(id: string) {
                return id === 'statusText' ? status : null;
            }
        };
        const { inspector } = streamedInspectorHarness(BlobInspector);
        Object.assign(inspector, {
            currentTable: 'items',
            currentData: Uint8Array.of(1),
            currentRowId: 1,
            currentColName: 'payload',
            currentCellInfo: { rowIdx: 0, colIdx: 0 },
            inspect() {}
        });

        try {
            await inspector.handleReplace();
            assert.strictEqual(updateCell.mock.callCount(), 0);
            assert.match(status.textContent, /invalid binary data/i);
        } finally {
            Object.assign(backendApi, originalApi);
            console.error = originalConsoleError;
        }
    });

    it('does not reopen an obsolete inspector after its committed replacement completes', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const originalUpdateCell = backendApi.updateCell;
        const updateStarted = deferred<void>();
        const updateFinished = deferred<number>();
        backendApi.updateCell = async () => {
            updateStarted.resolve();
            return updateFinished.promise;
        };
        state.selectedTable = 'items';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'payload' }];
        state.gridData = [[1, Uint8Array.of(0x01)], [2, Uint8Array.of(0x02)]];
        const status = { textContent: '' };
        (globalThis as any).document = {
            getElementById(id: string) {
                return id === 'statusText' ? status : null;
            }
        };
        const { inspector } = streamedInspectorHarness(BlobInspector);
        const inspectedRows: number[] = [];
        Object.assign(inspector, {
            currentTable: 'items',
            currentData: Uint8Array.of(0x01),
            currentRowId: 1,
            currentColName: 'payload',
            currentCellInfo: { rowIdx: 0, colIdx: 0 },
            inspect(_data: Uint8Array, rowId: number) {
                inspectedRows.push(rowId);
                this.currentRowId = rowId;
            }
        });

        try {
            const pending = inspector.uploadFile({
                name: 'replacement.bin',
                size: 1,
                arrayBuffer: async () => Uint8Array.of(0xaa).buffer
            });
            await updateStarted.promise;
            BlobInspector.prototype.cleanup.call(inspector);
            Object.assign(inspector, {
                currentTable: 'items',
                currentData: Uint8Array.of(0x02),
                currentRowId: 2,
                currentColName: 'payload',
                currentCellInfo: { rowIdx: 1, colIdx: 0 }
            });
            status.textContent = 'Viewing row 2';
            updateFinished.resolve(1);
            await pending;

            assert.deepStrictEqual(inspectedRows, []);
            assert.strictEqual(inspector.currentRowId, 2);
            assert.deepStrictEqual(inspector.currentData, Uint8Array.of(0x02));
            assert.strictEqual(status.textContent, 'Viewing row 2');
            assert.deepStrictEqual(state.gridData[0][1], Uint8Array.of(0xaa));
        } finally {
            backendApi.updateCell = originalUpdateCell;
        }
    });

    it('replaces a BLOB on rowid zero', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const originalUpdateCell = backendApi.updateCell;
        const updateCell = mock.fn(async () => 0);
        backendApi.updateCell = updateCell;
        state.selectedTable = 'zero_rows';
        state.selectedTableType = 'table';
        state.tableColumns = [{ name: 'payload', type: 'BLOB' }];
        state.gridData = [[0, Uint8Array.from([1])]];
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'statusText') return { textContent: '' };
                return null;
            }
        };
        const inspector = Object.create(BlobInspector.prototype);
        Object.assign(inspector, {
            currentData: state.gridData[0][1],
            currentRowId: 0,
            currentColName: 'payload',
            currentCellInfo: { rowIdx: 0, colIdx: 0 },
            currentOversizedMetadata: null,
            isUploading: false,
            setUploadState() {},
            inspect(data: Uint8Array) { this.currentData = data; }
        });

        try {
            await inspector.uploadFile({
                name: 'replacement.bin',
                size: 2,
                arrayBuffer: async () => Uint8Array.from([9, 8]).buffer
            });

            assert.deepStrictEqual(Array.from(state.gridData[0][1]), [9, 8]);
            assert.strictEqual(updateCell.mock.callCount(), 1);
        } finally {
            backendApi.updateCell = originalUpdateCell;
            state.tableColumns = [];
            state.gridData = [];
        }
    });

    it('does not mutate tab UI when the active tab is selected again', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        let styleWrites = 0;
        let classWrites = 0;
        let uploadStateCalls = 0;
        const style = (initial: Record<string, string>) => new Proxy(initial, {
            set(target, property, value) {
                styleWrites++;
                return Reflect.set(target, property, value);
            }
        });
        const buttons = ['preview', 'hex'].map(tab => ({
            dataset: { tab },
            classList: {
                add() { classWrites++; },
                remove() { classWrites++; }
            },
            style: style(tab === 'preview'
                ? { borderBottom: '2px solid var(--accent-color)', color: 'var(--text-primary)' }
                : { borderBottom: 'none', color: 'var(--text-secondary)' })
        }));
        const preview = { style: style({ display: 'flex' }) };
        const hex = { style: style({ display: 'none' }) };
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'tab-preview') return preview;
                if (id === 'tab-hex') return hex;
                return null;
            }
        };
        const inspector = Object.create(BlobInspector.prototype);
        Object.assign(inspector, {
            currentTab: 'preview',
            currentHexNeedsSnapshot: false,
            currentTableType: 'table',
            isUploading: false,
            modal: { querySelectorAll: () => buttons },
            setUploadState() { uploadStateCalls++; }
        });

        inspector.switchTab('preview');

        assert.strictEqual(styleWrites, 0);
        assert.strictEqual(classWrites, 0);
        assert.strictEqual(uploadStateCalls, 0);
    });

    it('opens the selected full Hex view even when the content type is PDF', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const originalOpenCellEditor = backendApi.openCellEditor;
        const openCellEditor = mock.fn(async () => undefined);
        backendApi.openCellEditor = openCellEditor;
        state.selectedTable = 'large_cells';
        const downloadButton = { textContent: '', title: '', disabled: false };
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'vscode-env') return { dataset: { webviewId: 'wv-large' } };
                if (id === 'statusText') return { textContent: '' };
                if (id === 'blob-download-btn') return downloadButton;
                if (id === 'tab-preview' || id === 'tab-hex') return { style: {} };
                return null;
            }
        };
        const inspector = Object.create(BlobInspector.prototype);
        Object.assign(inspector, {
            currentData: Uint8Array.from([1, 2, 3]),
            currentType: { type: 'pdf', ext: 'pdf' },
            modal: { querySelectorAll: () => [] },
            currentRowId: 1,
            currentColName: 'payload',
            currentOversizedMetadata: { storageClass: 'blob', byteLength: 256 * 1024 * 1024 }
        });

        try {
            inspector.switchTab('hex');
            assert.strictEqual(downloadButton.textContent, 'Open Full Hex');
            await inspector.download();
            assert.strictEqual(openCellEditor.mock.callCount(), 1);
            assert.deepStrictEqual(openCellEditor.mock.calls[0].arguments, [
                { table: 'large_cells', name: '' },
                1,
                'payload',
                {},
                {
                    type: inspector.currentType,
                    view: 'hex',
                    webviewId: 'wv-large',
                    sourceByteLength: 256 * 1024 * 1024
                }
            ]);
            inspector.switchTab('preview');
            assert.strictEqual(downloadButton.textContent, 'Open Full Content');
            await inspector.download();
            assert.deepStrictEqual(openCellEditor.mock.calls[1].arguments, [
                { table: 'large_cells', name: '' },
                1,
                'payload',
                {},
                {
                    type: inspector.currentType,
                    webviewId: 'wv-large',
                    sourceByteLength: 256 * 1024 * 1024,
                    download: true
                }
            ]);
        } finally {
            backendApi.openCellEditor = originalOpenCellEditor;
        }
    });

    for (const fixture of [
        { name: 'PDF', data: new TextEncoder().encode('%PDF-1.7\n%%EOF'), type: { type: 'pdf', ext: 'pdf' } },
        { name: 'empty BLOB', data: new Uint8Array(), type: { type: 'binary', ext: 'bin' } }
    ]) it(`opens an inline ${fixture.name} as full Hex and still downloads raw bytes from Preview`, async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const originalApi = {
            openCellEditor: backendApi.openCellEditor,
            getExtensionSettings: backendApi.getExtensionSettings,
            saveFile: backendApi.saveFile
        };
        const opened: unknown[][] = [];
        const saved: Uint8Array[] = [];
        backendApi.openCellEditor = async (...args: unknown[]) => {
            opened.push(args);
            return { success: true, mode: 'temporary-read-only' };
        };
        backendApi.getExtensionSettings = async () => ({ fileOperations: 'native' });
        backendApi.saveFile = async (_name: string, data: Uint8Array) => {
            saved.push(data);
            return { success: true };
        };
        const downloadButton = { textContent: '', title: '', disabled: false };
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'vscode-env') return { dataset: { webviewId: 'wv-inline', browserExt: 'false' } };
                if (id === 'statusText') return { textContent: '' };
                if (id === 'blob-download-btn') return downloadButton;
                if (id === 'tab-preview' || id === 'tab-hex') return { style: {} };
                return null;
            }
        };
        const inspector = Object.create(BlobInspector.prototype);
        Object.assign(inspector, {
            currentTable: 'small_cells', currentTableType: 'table', currentStorageClass: 'blob',
            currentData: fixture.data, currentType: fixture.type,
            currentRowId: 0, currentColName: '', currentOversizedMetadata: null,
            previewGeneration: 1, modal: { querySelectorAll: () => [] }
        });
        try {
            inspector.switchTab('hex');
            assert.strictEqual(downloadButton.textContent, 'Open Full Hex');
            await inspector.download();
            assert.deepStrictEqual(opened, [[
                { table: 'small_cells', name: '' }, 0, '', {},
                { type: fixture.type, webviewId: 'wv-inline', sourceByteLength: fixture.data.byteLength, view: 'hex' }
            ]]);
            assert.deepStrictEqual(saved, []);
            inspector.switchTab('preview');
            assert.strictEqual(downloadButton.textContent, 'Download');
            await inspector.download();
            assert.deepStrictEqual(saved, [fixture.data]);
            assert.strictEqual(opened.length, 1);
        } finally {
            Object.assign(backendApi, originalApi);
        }
    });

    for (const fixture of [
        { name: 'web demo', env: null, tableType: 'table', storageClass: 'blob' },
        { name: 'browser extension', env: { dataset: { browserExt: 'true' } }, tableType: 'table', storageClass: 'blob' },
        { name: 'view result', env: { dataset: { browserExt: 'false' } }, tableType: 'view', storageClass: 'blob' },
        { name: 'decoded TEXT without a stored-byte snapshot', env: { dataset: { browserExt: 'false' } }, tableType: 'table', storageClass: 'text' }
    ]) it(`keeps the ordinary inline download for a ${fixture.name}`, async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const button = { textContent: '', title: '', disabled: false };
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'vscode-env') return fixture.env;
                if (id === 'blob-download-btn') return button;
                if (id === 'tab-preview' || id === 'tab-hex') return { style: {} };
                return null;
            }
        };
        const inspector = Object.create(BlobInspector.prototype);
        Object.assign(inspector, {
            currentTable: 'items', currentTableType: fixture.tableType, currentStorageClass: fixture.storageClass,
            currentData: Uint8Array.of(1), currentOversizedMetadata: null,
            currentRowId: 1, currentColName: 'payload', modal: { querySelectorAll: () => [] }
        });
        inspector.switchTab('hex');
        assert.strictEqual(button.textContent, 'Download');
    });

    it('coalesces duplicate full-content opens and suppresses stale completion status', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const originalOpenCellEditor = backendApi.openCellEditor;
        const opened = deferred<any>();
        const openCellEditor = mock.fn(async () => opened.promise);
        backendApi.openCellEditor = openCellEditor;
        state.selectedTable = 'large_cells';
        const status = { textContent: '' };
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'vscode-env') return { dataset: { webviewId: 'wv-large' } };
                if (id === 'statusText') return status;
                return null;
            }
        };
        const inspector = Object.create(BlobInspector.prototype);
        Object.assign(inspector, {
            currentTable: 'large_cells',
            currentData: Uint8Array.of(0x01),
            currentType: { type: 'binary', ext: 'bin' },
            currentRowId: 1,
            currentColName: 'payload',
            currentOversizedMetadata: { storageClass: 'blob', byteLength: 256 * 1024 * 1024 },
            previewGeneration: 4,
            activeFullContent: null,
            isUploading: false,
            setUploadState() {}
        });

        try {
            const first = inspector.download();
            const duplicate = inspector.download();
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.strictEqual(openCellEditor.mock.callCount(), 1);

            inspector.previewGeneration++;
            inspector.activeFullContent = null;
            inspector.currentRowId = 2;
            status.textContent = 'Viewing row 2';
            opened.resolve({ success: true, mode: 'temporary-read-only' });
            await Promise.all([first, duplicate]);

            assert.strictEqual(status.textContent, 'Viewing row 2');
        } finally {
            backendApi.openCellEditor = originalOpenCellEditor;
        }
    });

    it('does not report a native BLOB save as successful when the dialog is cancelled', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const originalApi = {
            getExtensionSettings: backendApi.getExtensionSettings,
            saveFile: backendApi.saveFile
        };
        backendApi.getExtensionSettings = async () => ({ fileOperations: 'native' });
        backendApi.saveFile = async () => ({ success: false, cancelled: true });
        const status = { textContent: '' };
        (globalThis as any).document = {
            getElementById(id: string) {
                return id === 'statusText' ? status : null;
            }
        };
        const inspector = Object.create(BlobInspector.prototype);
        Object.assign(inspector, {
            currentData: Uint8Array.of(0x01),
            currentType: { type: 'binary', ext: 'bin' },
            currentRowId: 1,
            currentOversizedMetadata: null
        });

        try {
            await inspector.download();
            assert.strictEqual(status.textContent, 'Save cancelled');
        } finally {
            Object.assign(backendApi, originalApi);
        }
    });

    it('downloads an inspected TEXT value as its UTF-8 bytes', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const originalApi = {
            getExtensionSettings: backendApi.getExtensionSettings,
            saveFile: backendApi.saveFile
        };
        const saved: unknown[] = [];
        backendApi.getExtensionSettings = async () => ({ fileOperations: 'native' });
        backendApi.saveFile = async (_filename: string, data: unknown) => {
            saved.push(data);
            return { success: true };
        };
        state.selectedTable = 'items';
        (globalThis as any).document = {
            getElementById(id: string) {
                return id === 'statusText' ? { textContent: '' } : null;
            }
        };
        const { inspector } = inspectorHarness(BlobInspector);
        const text = 'plain text é😀';

        try {
            inspector.inspect(text, 1, 'body', 0, 0);
            await inspector.download();

            assert.strictEqual(saved.length, 1);
            assert.ok(saved[0] instanceof Uint8Array);
            assert.deepStrictEqual(saved[0], new TextEncoder().encode(text));
        } finally {
            Object.assign(backendApi, originalApi);
        }
    });

    it('downloads an empty inspected TEXT value as an empty file', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const originalApi = {
            getExtensionSettings: backendApi.getExtensionSettings,
            saveFile: backendApi.saveFile
        };
        const saved: unknown[] = [];
        backendApi.getExtensionSettings = async () => ({ fileOperations: 'native' });
        backendApi.saveFile = async (_filename: string, data: unknown) => {
            saved.push(data);
            return { success: true };
        };
        state.selectedTable = 'items';
        (globalThis as any).document = {
            getElementById(id: string) {
                return id === 'statusText' ? { textContent: '' } : null;
            }
        };
        const { inspector } = inspectorHarness(BlobInspector);

        try {
            inspector.inspect('', 1, 'body', 0, 0);
            await inspector.download();

            assert.strictEqual(saved.length, 1);
            assert.deepStrictEqual(saved[0], new Uint8Array());
        } finally {
            Object.assign(backendApi, originalApi);
        }
    });

    it('cleans a failed web BLOB download without leaking its object URL', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const originalUrl = globalThis.URL;
        let appended = false;
        let removals = 0;
        const revoked: string[] = [];
        (globalThis as any).URL = {
            createObjectURL() { return 'blob:failed-inspector-download'; },
            revokeObjectURL(url: string) { revoked.push(url); }
        };
        (globalThis as any).document = {
            createElement() {
                return {
                    href: '',
                    download: '',
                    click() { throw new Error('download blocked'); }
                };
            },
            body: {
                appendChild() { appended = true; },
                removeChild() {
                    removals++;
                    appended = false;
                }
            }
        };
        const inspector = Object.create(BlobInspector.prototype);

        try {
            assert.throws(
                () => inspector.downloadBlob(Uint8Array.of(1), 'payload.bin'),
                /download blocked/
            );
            assert.strictEqual(appended, false);
            assert.strictEqual(removals, 1);
            assert.deepStrictEqual(revoked, ['blob:failed-inspector-download']);
        } finally {
            (globalThis as any).URL = originalUrl;
        }
    });

    it('keeps the web replacement picker attached and cleans it on cancellation', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        let input: any;
        let appended = false;
        let removals = 0;
        const operation = { generation: 1 };
        const finishReplacementOperation = mock.fn();
        (globalThis as any).document = {
            createElement() {
                input = {
                    type: '',
                    onchange: undefined,
                    oncancel: undefined,
                    click() {}
                };
                return input;
            },
            body: {
                appendChild() { appended = true; },
                removeChild() {
                    removals++;
                    appended = false;
                }
            }
        };
        const inspector = Object.create(BlobInspector.prototype);
        Object.assign(inspector, {
            isReplacementOperationCurrent: () => true,
            finishReplacementOperation
        });

        inspector.showFileInput(operation);
        assert.strictEqual(appended, true);
        assert.strictEqual(typeof input.oncancel, 'function');

        input.oncancel();

        assert.strictEqual(appended, false);
        assert.strictEqual(removals, 1);
        assert.strictEqual(finishReplacementOperation.mock.callCount(), 1);
        assert.strictEqual(finishReplacementOperation.mock.calls[0].arguments[0], operation);
    });

    it('coalesces normal downloads and does not export a newly inspected BLOB from an older action', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const originalApi = {
            getExtensionSettings: backendApi.getExtensionSettings,
            saveFile: backendApi.saveFile
        };
        const settings = deferred<any>();
        const saved: Array<{ filename: string; data: Uint8Array }> = [];
        let settingCalls = 0;
        backendApi.getExtensionSettings = async () => {
            settingCalls += 1;
            return settings.promise;
        };
        backendApi.saveFile = async (filename: string, data: Uint8Array) => {
            saved.push({ filename, data: data.slice() });
            return { success: true };
        };
        const status = { textContent: '' };
        (globalThis as any).document = {
            getElementById(id: string) {
                return id === 'statusText' ? status : null;
            }
        };
        const inspector = Object.create(BlobInspector.prototype);
        Object.assign(inspector, {
            currentData: Uint8Array.of(0x01),
            currentType: { type: 'binary', ext: 'bin' },
            currentRowId: 1,
            currentOversizedMetadata: null,
            previewGeneration: 5,
            activeDownload: null
        });

        try {
            const first = inspector.download();
            const duplicate = inspector.download();
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.strictEqual(settingCalls, 1);

            inspector.previewGeneration += 1;
            inspector.activeDownload = null;
            inspector.currentData = Uint8Array.of(0x02);
            inspector.currentRowId = 2;
            status.textContent = 'Viewing row 2';
            settings.resolve({ fileOperations: 'native' });
            await Promise.all([first, duplicate]);

            assert.deepStrictEqual(saved, []);
            assert.strictEqual(status.textContent, 'Viewing row 2');
        } finally {
            Object.assign(backendApi, originalApi);
        }
    });

    it('opens oversized content from an empty quoted column identifier', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const originalOpenCellEditor = backendApi.openCellEditor;
        const openCellEditor = mock.fn(async () => undefined);
        backendApi.openCellEditor = openCellEditor;
        state.selectedTable = 'empty_column_name';
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'vscode-env') return { dataset: { webviewId: 'wv-empty-column' } };
                if (id === 'statusText') return { textContent: '' };
                return null;
            }
        };
        const inspector = Object.create(BlobInspector.prototype);
        Object.assign(inspector, {
            currentData: Uint8Array.from([1]),
            currentType: { type: 'binary', ext: 'bin' },
            currentRowId: 0,
            currentColName: '',
            currentOversizedMetadata: { storageClass: 'blob', byteLength: 256 * 1024 * 1024 }
        });

        try {
            await inspector.openFullContent();
            assert.strictEqual(openCellEditor.mock.callCount(), 1);
            assert.strictEqual(
                (openCellEditor.mock.calls[0].arguments as unknown as unknown[])[2],
                ''
            );
        } finally {
            backendApi.openCellEditor = originalOpenCellEditor;
        }
    });

    it('requests a URI rather than rendering oversized media preview bytes', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const originalPrepare = backendApi.prepareCellMediaPreview;
        const prepare = mock.fn(async (
            _params: DbParams,
            _rowId: RecordId,
            _colName: string,
            _options: MediaPreviewRequestOptions
        ): Promise<MediaPreviewSuccess> => ({
            success: true,
            previewId: 'preview-1',
            uri: 'https://wv-resource.test/run/image.png',
            mime: 'image/png',
            byteLength: 32 * 1024 * 1024
        }));
        backendApi.prepareCellMediaPreview = prepare;
        state.selectedTable = 'large_cells';
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'vscode-env') return { dataset: { webviewId: 'wv-media' } };
                return null;
            }
        };
        const { inspector, rendered, hexed, mediaUris } = inspectorHarness(BlobInspector);
        const pngPreview = new Uint8Array(128);
        pngPreview.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

        try {
            inspector.inspectOversized(
                pngPreview,
                { storageClass: 'blob', byteLength: 32 * 1024 * 1024 },
                1,
                'payload',
                0,
                0
            );
            await new Promise<void>(resolve => setImmediate(resolve));

            assert.strictEqual(rendered.length, 0);
            assert.strictEqual(hexed.length, 1);
            assert.strictEqual(prepare.mock.callCount(), 1);
            const prepareArgs = prepare.mock.calls[0].arguments;
            assert.deepStrictEqual(prepareArgs.slice(0, 3), [
                { table: 'large_cells', name: '' },
                1,
                'payload'
            ]);
            assert.deepStrictEqual(prepareArgs[3], {
                type: { mime: 'image/png', type: 'image', ext: 'png' },
                webviewId: 'wv-media',
                requestId: prepareArgs[3].requestId,
                sourceByteLength: 32 * 1024 * 1024
            });
            assert.strictEqual(typeof prepareArgs[3].requestId, 'string');
            assert.ok(prepareArgs[3].requestId.length > 0);
            assert.deepStrictEqual(mediaUris, [{
                uri: 'https://wv-resource.test/run/image.png',
                type: { mime: 'image/png', type: 'image', ext: 'png' },
                generation: inspector.previewGeneration
            }]);
            assert.strictEqual(inspector.currentMediaPreview.previewId, 'preview-1');
        } finally {
            backendApi.prepareCellMediaPreview = originalPrepare;
        }
    });

    it('offers the PDF download preview without preparing an unsupported inline PDF resource', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const original = backendApi.prepareCellMediaPreview;
        const prepare = mock.fn(async () => ({ success: false }));
        backendApi.prepareCellMediaPreview = prepare;
        state.selectedTable = 'large_cells';
        (globalThis as any).document = { getElementById: () => null };
        const { inspector, rendered, hexed } = inspectorHarness(BlobInspector);
        try {
            await inspector.inspectOversized(new TextEncoder().encode('%PDF-1.4\n'),
                { storageClass: 'blob', byteLength: 32 * 1024 * 1024 }, 1, 'payload', 0, 0);
            assert.strictEqual(prepare.mock.callCount(), 0);
            assert.strictEqual(rendered.length, 1);
            assert.strictEqual(hexed.length, 1);
            assert.strictEqual(inspector.currentType.type, 'pdf');
        } finally { backendApi.prepareCellMediaPreview = original; }
    });

    it('cancels pending media materialization on close and releases a stale success fallback', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const originalApi = {
            prepareCellMediaPreview: backendApi.prepareCellMediaPreview,
            cancelCellMediaPreview: backendApi.cancelCellMediaPreview,
            releaseCellMediaPreview: backendApi.releaseCellMediaPreview
        };
        const prepared = deferred<MediaPreviewSuccess>();
        const prepare = mock.fn(async (
            _params: DbParams,
            _rowId: RecordId,
            _colName: string,
            _options: MediaPreviewRequestOptions
        ) => prepared.promise);
        const cancel = mock.fn(async (_webviewId: string, _requestId: string) => {});
        const release = mock.fn(async (_webviewId: string, _previewId: string) => {});
        backendApi.prepareCellMediaPreview = prepare;
        backendApi.cancelCellMediaPreview = cancel;
        backendApi.releaseCellMediaPreview = release;
        state.selectedTable = 'large_cells';
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'vscode-env') return { dataset: { webviewId: 'wv-media' } };
                if (id === 'statusText') return { textContent: '' };
                return null;
            }
        };
        const { inspector, mediaUris } = inspectorHarness(BlobInspector);
        Object.assign(inspector, {
            currentTable: 'large_cells',
            currentRowId: 1,
            currentColName: 'payload',
            currentCellInfo: { rowIdx: 0, colIdx: 0 },
            currentOversizedMetadata: { storageClass: 'blob', byteLength: 32 * 1024 * 1024 },
            activeReplacement: null,
            activeFullContent: null,
            oversizedLoadedBytes: 0,
            isLoadingOversized: false,
            oversizedLoadOperation: null,
            isUploading: false
        });
        const type = { mime: 'image/png', type: 'image', ext: 'png' };

        try {
            const pending = inspector.loadOversizedMediaPreview(
                type,
                inspector.currentOversizedMetadata,
                inspector.previewGeneration
            );
            await new Promise<void>(resolve => setImmediate(resolve));
            const requestId = prepare.mock.calls[0].arguments[3].requestId;
            assert.strictEqual(typeof requestId, 'string');
            assert.ok(requestId.length > 0);

            BlobInspector.prototype.cleanup.call(inspector);
            assert.deepStrictEqual(cancel.mock.calls[0].arguments, ['wv-media', requestId]);

            prepared.resolve({
                success: true,
                previewId: 'stale-preview',
                uri: 'https://wv-resource.test/run/stale.png',
                mime: 'image/png',
                byteLength: 32 * 1024 * 1024
            });
            await pending;
            assert.deepStrictEqual(release.mock.calls[0].arguments, ['wv-media', 'stale-preview']);
            assert.deepStrictEqual(mediaUris, []);
        } finally {
            Object.assign(backendApi, originalApi);
        }
    });

    for (const type of ['image', 'audio', 'video']) it(`releases an undecodable normal ${type} preview and preserves a newer inspector`, async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const revoked: string[] = [];
        let nextId = 0;
        mock.method(URL, 'createObjectURL', () => `blob:preview-${++nextId}`);
        mock.method(URL, 'revokeObjectURL', (uri: string) => { revoked.push(uri); });
        const elements: Array<PreviewElement & { tagName: string }> = [];
        (globalThis as any).document = { createElement(tagName: string) {
            const element = { ...previewElement(), tagName }; elements.push(element); return element;
        } };
        const statuses: string[] = [];
        const inspector = Object.create(BlobInspector.prototype);
        Object.assign(inspector, { previewGeneration: 1, currentObjectUrl: null,
            previewContainer: previewElement(), renderOversizedMediaStatus: (message: string) => statuses.push(message) });
        inspector.renderPreview(Uint8Array.of(1), { type, mime: `${type}/test`, ext: 'test' });
        const media = elements.find(element => element.tagName === (type === 'image' ? 'img' : type))!;
        assert.ok(media.listeners.has('error'));
        media.listeners.get('error')!({});
        assert.deepStrictEqual(revoked, ['blob:preview-1']);
        assert.strictEqual(inspector.currentObjectUrl, null);
        assert.match(statuses[0], /could not be decoded.*Download/i);
        inspector.previewGeneration++;
        inspector.currentObjectUrl = 'blob:newer-preview';
        media.listeners.get('error')!({});
        assert.strictEqual(statuses.length, 1);
        assert.strictEqual(inspector.currentObjectUrl, 'blob:newer-preview');
    });

    it('releases a failed media decode before degrading to the bounded Hex path', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const originalRelease = backendApi.releaseCellMediaPreview;
        const release = mock.fn(async () => {});
        backendApi.releaseCellMediaPreview = release;
        const statuses: string[] = [];
        let errorListener: (() => unknown) | undefined;
        const mediaElement = {
            style: {},
            addEventListener(type: string, listener: () => void) {
                if (type === 'error') errorListener = listener;
            }
        };
        (globalThis as any).document = {
            createElement: () => mediaElement
        };
        const inspector = Object.create(BlobInspector.prototype);
        Object.assign(inspector, {
            previewGeneration: 7,
            currentMediaPreview: {
                webviewId: 'wv-media',
                requestId: 'request-1',
                previewId: 'preview-1'
            },
            previewContainer: { innerHTML: '', appendChild() {} },
            renderOversizedMediaStatus(message: string) { statuses.push(message); }
        });

        try {
            inspector.renderMediaUri(
                'https://wv-resource.test/run/image.png',
                { mime: 'image/png', type: 'image', ext: 'png' },
                7
            );
            assert.ok(errorListener);
            await errorListener!();
            assert.deepStrictEqual(release.mock.calls[0].arguments, ['wv-media', 'preview-1']);
            assert.strictEqual(inspector.currentMediaPreview, null);
            assert.match(statuses[0], /media preview failed to load.*released.*Hex preview/i);
        } finally {
            backendApi.releaseCellMediaPreview = originalRelease;
        }
    });
});
