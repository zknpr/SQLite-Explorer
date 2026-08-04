import './vscode_mock_setup';

import assert from 'node:assert';
import { afterEach, describe, it, mock } from 'node:test';

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
    const inspector = Object.create(BlobInspector.prototype);
    Object.assign(inspector, {
        currentObjectUrl: null,
        currentData: null,
        currentType: null,
        currentRowId: null,
        currentColName: null,
        currentCellInfo: null,
        currentOversizedMetadata: null,
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
        renderHex(data: Uint8Array) { hexed.push(data); }
    });
    return { inspector, rendered, hexed };
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
                    value: inspector.currentData,
                    type: inspector.currentType,
                    webviewId: 'wv-large'
                }
            ]);
        } finally {
            backendApi.openCellEditor = originalOpenCellEditor;
        }
    });
});
