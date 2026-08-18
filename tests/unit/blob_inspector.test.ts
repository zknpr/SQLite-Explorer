import './vscode_mock_setup';

import assert from 'node:assert';
import { afterEach, describe, it, mock } from 'node:test';
import { DEFAULT_MAX_CELL_EDIT_BYTES } from '../../src/core/cell-edit-policy';

(globalThis as any).acquireVsCodeApi = () => ({
    getState: () => undefined,
    setState() {},
    postMessage() {}
});

const inspectorModulePath = '../../core/ui/modules/blob-inspector.js';
const apiModulePath = '../../core/ui/modules/api.js';
const stateModulePath = '../../core/ui/modules/state.js';

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

    // -----------------------------------------------------------------------
    // Wave 2 (capstone G2): the chunked read API had ZERO UI call sites, so an
    // oversized cell topped out at the 64 KiB bounded preview and there was no
    // way to read a large TEXT/BLOB in full on the desktop at all.
    // -----------------------------------------------------------------------

    function chunkedHarness(BlobInspector: any, options: {
        total: number;
        loaded?: number;
        chunkCap?: number;
    }) {
        const calls: Array<[number, number]> = [];
        const closed: string[] = [];
        const source = new Uint8Array(options.total);
        for (let i = 0; i < source.length; i++) source[i] = i & 0xff;
        const base = inspectorHarness(BlobInspector);
        Object.assign(base.inspector, {
            currentData: source.subarray(0, options.loaded ?? 0),
            currentType: { type: 'binary', ext: 'bin' },
            currentRowId: 7,
            currentColName: 'payload',
            currentOversizedMetadata: { storageClass: 'blob', byteLength: options.total },
            oversizedLoadedBytes: options.loaded ?? 0,
            isLoadingOversized: false,
            isUploading: false,
            detectType: () => ({ type: 'binary', ext: 'bin' }),
            formatSize: (n: number) => `${n}B`,
            isOversizedFullyLoaded: BlobInspector.prototype.isOversizedFullyLoaded,
            oversizedDownloadAction: BlobInspector.prototype.oversizedDownloadAction
        });
        const api = {
            openCellReadSession: mock.fn(async (_target: unknown) => ({
                sessionId: 'session-1',
                metadata: { storageClass: 'blob', byteLength: options.total }
            })),
            readCellChunk: mock.fn(async (_id: string, offset: number, maxBytes: number) => {
                calls.push([offset, maxBytes]);
                const end = Math.min(offset + Math.min(maxBytes, options.chunkCap ?? maxBytes), source.length);
                return { byteOffset: offset, bytes: source.slice(offset, end), done: end >= source.length };
            }),
            closeCellReadSession: mock.fn(async (id: string) => { closed.push(id); })
        };
        return { ...base, api, calls, closed, source };
    }

    function installStatusDocument() {
        (globalThis as any).document = {
            getElementById: (id: string) => (id === 'statusText' ? { textContent: '' } : null)
        };
    }

    it('streams an oversized cell in through openCellReadSession/readCellChunk', async () => {
        const inspectorModule = await import(inspectorModulePath);
        const { BlobInspector, MAX_OVERSIZED_INSPECTOR_LOAD_BYTES } = inspectorModule;
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const total = 3 * 1024 * 1024;
        const { inspector, api, calls, closed, hexed, source } =
            chunkedHarness(BlobInspector, { total, chunkCap: 512 * 1024 });
        const originals = {
            open: backendApi.openCellReadSession,
            read: backendApi.readCellChunk,
            close: backendApi.closeCellReadSession
        };
        Object.assign(backendApi, api);
        state.selectedTable = 'large_cells';
        state.isDesktop = true;
        installStatusDocument();

        try {
            await inspector.loadMoreOversizedContent();

            // One session, opened and CLOSED — the worker refuses every other
            // database operation while one is open, so leaking it would wedge
            // the app.
            assert.strictEqual(api.openCellReadSession.mock.callCount(), 1);
            assert.deepStrictEqual(api.openCellReadSession.mock.calls[0].arguments, [
                { table: 'large_cells', rowId: 7, column: 'payload' }
            ]);
            assert.deepStrictEqual(closed, ['session-1']);

            // One click reads one step's worth, in bounded windows, from 0.
            assert.strictEqual(inspector.oversizedLoadedBytes, 1024 * 1024);
            assert.deepStrictEqual(calls, [[0, 1048576], [524288, 524288]]);
            assert.deepStrictEqual(
                Array.from(inspector.currentData.subarray(0, 4)),
                Array.from(source.subarray(0, 4))
            );
            assert.strictEqual(hexed.at(-1)!.byteLength, 1024 * 1024);
            assert.ok(inspector.oversizedLoadedBytes < MAX_OVERSIZED_INSPECTOR_LOAD_BYTES);

            // The next click continues where the last one stopped, and the
            // button only becomes a real Download once the WHOLE value is in.
            assert.strictEqual(inspector.oversizedDownloadAction().kind, 'loadMore');
            await inspector.loadMoreOversizedContent();
            assert.strictEqual(inspector.oversizedLoadedBytes, 2 * 1024 * 1024);
            await inspector.loadMoreOversizedContent();
            assert.strictEqual(inspector.oversizedLoadedBytes, total);
            assert.strictEqual(inspector.isOversizedFullyLoaded(), true);
            assert.strictEqual(inspector.oversizedDownloadAction().kind, 'save');
            assert.deepStrictEqual(Array.from(inspector.currentData), Array.from(source));
        } finally {
            backendApi.openCellReadSession = originals.open;
            backendApi.readCellChunk = originals.read;
            backendApi.closeCellReadSession = originals.close;
            state.isDesktop = false;
        }
    });

    it('closes the session even when a chunk read fails, and reports the failure', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const { inspector, api, closed } = chunkedHarness(BlobInspector, { total: 1024 });
        api.readCellChunk = mock.fn(async () => { throw new Error('snapshot expired'); });
        const originals = {
            open: backendApi.openCellReadSession,
            read: backendApi.readCellChunk,
            close: backendApi.closeCellReadSession
        };
        Object.assign(backendApi, api);
        state.selectedTable = 'large_cells';
        state.isDesktop = true;
        const statusElement = { textContent: '' };
        (globalThis as any).document = {
            getElementById: (id: string) => (id === 'statusText' ? statusElement : null)
        };

        try {
            await inspector.loadMoreOversizedContent();
            assert.deepStrictEqual(closed, ['session-1']);
            assert.match(statusElement.textContent, /snapshot expired/);
            assert.strictEqual(inspector.oversizedLoadedBytes, 0);
            assert.strictEqual(inspector.isLoadingOversized, false);
        } finally {
            backendApi.openCellReadSession = originals.open;
            backendApi.readCellChunk = originals.read;
            backendApi.closeCellReadSession = originals.close;
            state.isDesktop = false;
        }
    });

    it('stops at the in-page ceiling instead of pulling a whole 300 MB value into the DOM', async () => {
        const { BlobInspector, MAX_OVERSIZED_INSPECTOR_LOAD_BYTES } = await import(inspectorModulePath);
        const { state } = await import(stateModulePath);
        const { inspector } = chunkedHarness(BlobInspector, {
            total: 300 * 1024 * 1024,
            loaded: MAX_OVERSIZED_INSPECTOR_LOAD_BYTES
        });
        state.isDesktop = true;
        try {
            const action = inspector.oversizedDownloadAction();
            assert.strictEqual(action.kind, 'exhausted');
            assert.match(action.title, /cannot be shown/);
            // …and it is HONEST about it rather than silently doing nothing.
            assert.strictEqual(inspector.isOversizedFullyLoaded(), false);
        } finally {
            state.isDesktop = false;
        }
    });

    it('keeps the VS Code lane on the external-editor route', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { state } = await import(stateModulePath);
        const { inspector } = chunkedHarness(BlobInspector, { total: 1024 * 1024 });
        state.isDesktop = false;
        const action = inspector.oversizedDownloadAction();
        assert.strictEqual(action.kind, 'openEditor');
        assert.strictEqual(action.label, 'Open Full Content');
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

    it('requests a URI rather than rendering oversized media preview bytes', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const { backendApi } = await import(apiModulePath);
        const { state } = await import(stateModulePath);
        const originalPrepare = backendApi.prepareCellMediaPreview;
        const prepare = mock.fn(async () => ({
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
            assert.deepStrictEqual(prepare.mock.calls[0].arguments, [
                { table: 'large_cells', name: '' },
                1,
                'payload',
                {
                    type: { mime: 'image/png', type: 'image', ext: 'png' },
                    webviewId: 'wv-media',
                    sourceByteLength: 32 * 1024 * 1024
                }
            ]);
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

    it('degrades a disposed temp-file preview to the bounded Hex path without throwing', async () => {
        const { BlobInspector } = await import(inspectorModulePath);
        const statuses: string[] = [];
        let errorListener: (() => void) | undefined;
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
            previewContainer: { innerHTML: '', appendChild() {} },
            renderOversizedMediaStatus(message: string) { statuses.push(message); }
        });

        inspector.renderMediaUri(
            'https://wv-resource.test/run/image.png',
            { mime: 'image/png', type: 'image', ext: 'png' },
            7
        );
        assert.ok(errorListener);
        assert.doesNotThrow(() => errorListener!());
        assert.match(statuses[0], /temporary preview file.*cleaned up.*Hex preview/i);
    });
});
