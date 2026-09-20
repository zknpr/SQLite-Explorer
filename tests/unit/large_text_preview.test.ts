import './vscode_mock_setup';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createDeferred } from './helpers/deferred';

(globalThis as any).acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage() {} });
const editPath = '../../core/ui/modules/edit.js';
const inspectorPath = '../../core/ui/modules/blob-inspector.js';
const apiPath = '../../core/ui/modules/api.js';
const statePath = '../../core/ui/modules/state.js';
const modalsPath = '../../core/ui/modules/modals.js';

// Fail at the unsafe assignment, without ever asking a browser to lay out an
// unbounded editable value. The real editor and inspector code run unchanged.
class Element {
    style: Record<string, string> = {};
    dataset: Record<string, string> = {};
    children: Element[] = [];
    listeners = new Map<string, (event: unknown) => void>();
    disabled = false;
    hidden = false;
    title = '';
    classes = new Set(['hidden']);
    classList = {
        add: (...names: string[]) => names.forEach(name => this.classes.add(name)),
        remove: (...names: string[]) => names.forEach(name => this.classes.delete(name)),
        contains: (name: string) => this.classes.has(name)
    };
    private text = '';
    private input = '';
    constructor(private editable = false, readonly tagName = 'div') {}
    get value() { return this.input; }
    set value(value: string) {
        if (this.editable && value.length > 65_536) throw new Error('Unbounded editable TEXT assignment');
        this.input = value;
    }
    get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
    set textContent(value: string) { this.text = value; this.children = []; }
    get innerHTML() { return ''; }
    set innerHTML(_value: string) { this.text = ''; this.children = []; }
    appendChild(child: Element) { this.children.push(child); }
    replaceChildren(...children: Element[]) { this.text = ''; this.children = children; }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    setAttribute() {}
    addEventListener(name: string, listener: (event: unknown) => void) { this.listeners.set(name, listener); }
    removeEventListener() {}
    focus() {}
}

describe('large complete TEXT preview containment', () => {
    let elements: Map<string, Element>;
    let backendApi: any;
    let state: any;
    let originalApi: Record<string, unknown>;
    const sourceText = 'A'.repeat(98_304);
    const sourceBytes = new Uint8Array(Buffer.from(sourceText, 'utf16le'));
    let reads: number[];
    let closed: string[];

    beforeEach(async () => {
        ({ backendApi } = await import(apiPath));
        ({ state } = await import(statePath));
        originalApi = {
            openCellReadSession: backendApi.openCellReadSession,
            readCellChunk: backendApi.readCellChunk,
            closeCellReadSession: backendApi.closeCellReadSession,
            openCellEditor: backendApi.openCellEditor
        };
        reads = [];
        closed = [];
        elements = new Map();
        (globalThis as any).document = {
            getElementById(id: string) {
                if (id === 'gridContainer') return null;
                if (!elements.has(id)) elements.set(id, new Element(id === 'cellPreviewTextarea'));
                return elements.get(id);
            },
            querySelector() { return new Element(); },
            createElement(tag: string) { return new Element(tag === 'textarea', tag); }
        };
        Object.assign(state, {
            selectedTable: 'items', selectedTableType: 'table', isReadOnly: false,
            selectedTableIdentity: null, gridOversizedCells: {}, gridReadOnlyRowReasons: {},
            tableColumns: [{ name: 'body', type: 'TEXT' }], gridData: [[1, sourceText]],
            editingCellInfo: null, activeCellInput: null, cellPreviewInfo: null
        });
        backendApi.openCellReadSession = async (target: unknown) => {
            assert.deepEqual(target, { table: 'items', rowId: 1, column: 'body' });
            return {
                sessionId: 'text-snapshot', expiresAt: Date.now() + 30_000,
                metadata: { storageClass: 'text', byteLength: 196_608, textEncoding: 'utf-16le' }
            };
        };
        backendApi.readCellChunk = async (sessionId: string, offset: number, maxBytes: number) => {
            assert.equal(sessionId, 'text-snapshot');
            assert.equal(offset, 0);
            reads.push(maxBytes);
            const bytes = sourceBytes.slice(0, maxBytes);
            return { byteOffset: 0, bytes, done: bytes.byteLength === sourceBytes.byteLength };
        };
        backendApi.closeCellReadSession = async (sessionId: string) => { closed.push(sessionId); };
    });

    afterEach(async () => {
        const { closeModal } = await import(modalsPath);
        closeModal('blob-inspector-modal');
        Object.assign(backendApi, originalApi);
        Object.assign(state, { selectedTable: null, selectedTableType: 'table', tableColumns: [],
            gridData: [], editingCellInfo: null, activeCellInput: null, cellPreviewInfo: null });
        delete (globalThis as any).document;
    });

    for (const entry of ['startCellEdit', 'openCellPreview'] as const) {
        it(`${entry} sends a complete large TEXT value through bounded stored-byte inspection`, async () => {
            const edit = await import(editPath);
            edit.initEdit();

            await edit[entry](0, 0, 1);

            assert.equal(state.editingCellInfo, null);
            assert.equal(state.cellPreviewInfo, null);
            assert.equal(elements.get('blob-inspector-modal')?.classes.has('hidden'), false);
            assert.deepEqual(reads, [65_536]);
            assert.deepEqual(closed, ['text-snapshot']);
            assert.equal(elements.get('tab-preview')?.textContent, 'A'.repeat(32_768));
            assert.match(elements.get('blob-info')?.textContent ?? '', /64 KB of 192 KB source bytes/);
        });
    }

    it('shows large view TEXT as displayed UTF-8 without claiming stored-byte identity or enabling Replace', async () => {
        state.selectedTableType = 'view';
        state.gridData = [[sourceText]];
        const { initEdit, openCellPreview } = await import(editPath);
        initEdit();

        await openCellPreview(0, 0, null);

        assert.deepEqual(reads, []);
        const descendants = (element: Element): Element[] => [element, ...element.children.flatMap(descendants)];
        const nodes = descendants(elements.get('tab-preview')!);
        const pre = nodes.find(node => node.tagName === 'pre')!;
        assert.equal(pre.textContent, 'A'.repeat(65536));
        const next = nodes.find(node => node.tagName === 'button' && node.textContent === 'Next')!;
        next.listeners.get('click')!({});
        assert.equal(pre.textContent, sourceText.slice(65536));
        assert.equal(next.disabled, true);
        assert.match(elements.get('blob-info')?.textContent ?? '', /displayed UTF-8/i);
        assert.equal(elements.get('blob-replace-btn')?.disabled, true);
        assert.equal(state.cellPreviewInfo, null);
    });

    it('keeps pending snapshot actions disabled and discards a late read after Close', async () => {
        const { BlobInspector } = await import(inspectorPath);
        const inspector = new BlobInspector();
        const pending = createDeferred<any>();
        backendApi.openCellReadSession = () => pending.promise;

        const loading = inspector.inspectStoredText(1, 'body', 0, 0);
        assert.equal(elements.get('blob-download-btn')?.disabled, true);
        assert.equal(elements.get('blob-replace-btn')?.disabled, true);
        inspector.close();
        pending.resolve({ sessionId: 'text-snapshot', metadata: {
            storageClass: 'text', byteLength: 196_608, textEncoding: 'utf-16le'
        } });

        assert.equal(await loading, false);
        assert.deepEqual(closed, ['text-snapshot']);
        assert.equal(inspector.currentData, null);
        assert.equal(elements.get('tab-preview')?.textContent, '');
        assert.equal(elements.get('blob-inspector-modal')?.classes.has('hidden'), true);
    });

    it('keeps a failed initial read retryable without publishing unverified bytes', async () => {
        const { BlobInspector } = await import(inspectorPath);
        const inspector = new BlobInspector();
        const readChunk = backendApi.readCellChunk;
        backendApi.readCellChunk = async () => { throw new Error('Snapshot read failed'); };

        assert.equal(await inspector.inspectStoredText(1, 'body', 0, 0), false);
        assert.equal(inspector.currentData, null);
        assert.equal(elements.get('blob-load-more-btn')?.hidden, false);
        assert.equal(elements.get('blob-load-more-btn')?.disabled, false);
        assert.equal(elements.get('blob-download-btn')?.disabled, true);
        assert.match(elements.get('statusText')?.textContent ?? '', /Snapshot read failed/);

        backendApi.readCellChunk = readChunk;
        assert.equal(await inspector.loadMoreOversizedContent(), true);
        assert.deepEqual(reads, [65_536]);
        assert.deepEqual(closed, ['text-snapshot', 'text-snapshot']);
        assert.equal(elements.get('blob-download-btn')?.disabled, false);
        assert.equal(elements.get('tab-preview')?.textContent, 'A'.repeat(32_768));
    });

    it('requests a read-only full snapshot even when the stored TEXT is below the engine inline limit', async () => {
        const { BlobInspector } = await import(inspectorPath);
        const inspector = new BlobInspector();
        let options: unknown;
        backendApi.openCellEditor = async (_params: unknown, _rowId: unknown, _col: unknown, _types: unknown, requested: unknown) => {
            options = requested;
            return { success: true, mode: 'paged-read-only' };
        };
        await inspector.inspectStoredText(1, 'body', 0, 0);
        assert.equal(await inspector.openFullContent(), true);
        assert.equal((options as { view: string }).view, 'snapshot');
        assert.match(elements.get('statusText')?.textContent ?? '', /paged read-only viewer/);
    });
});
