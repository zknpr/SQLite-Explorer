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
        (globalThis as any).document = {
            createElement() {
                return {
                    style: {},
                    className: '',
                    textContent: '',
                    appendChild() {},
                    addEventListener() {}
                };
            }
        };
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

    it('keeps full-content access separate from bounded TEXT load-more', async () => {
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
            currentOversizedMetadata: { storageClass: 'text', byteLength: 4 * 1024 * 1024 },
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

    it('routes full oversized content to the desktop temp-file host flow', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const originalOpenCellEditor = backendApi.openCellEditor;
        const openCellEditor = mock.fn(async () => undefined);
        backendApi.openCellEditor = openCellEditor;
        state.selectedTable = 'large_cells';
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'vscode-env') return { dataset: { webviewId: 'wv-large' } };
                if (id === 'statusText') return { textContent: '' };
                return null;
            }
        };
        const inspector = Object.create(BlobInspector.prototype);
        Object.assign(inspector, {
            currentData: Uint8Array.from([1, 2, 3]),
            currentType: { type: 'binary', ext: 'bin' },
            currentRowId: 1,
            currentColName: 'payload',
            currentOversizedMetadata: { storageClass: 'blob', byteLength: 256 * 1024 * 1024 }
        });

        try {
            await inspector.openFullContent();
            assert.strictEqual(openCellEditor.mock.callCount(), 1);
            assert.deepStrictEqual(openCellEditor.mock.calls[0].arguments, [
                { table: 'large_cells', name: '' },
                1,
                'payload',
                {},
                {
                    type: inspector.currentType,
                    webviewId: 'wv-large',
                    sourceByteLength: 256 * 1024 * 1024
                }
            ]);
        } finally {
            backendApi.openCellEditor = originalOpenCellEditor;
        }
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
