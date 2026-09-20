import assert from 'node:assert/strict';
import { after, it } from 'node:test';

const savedAcquire = (globalThis as any).acquireVsCodeApi;
let messages: any[] = [];
(globalThis as any).acquireVsCodeApi = () => ({
    getState() {}, setState() {}, postMessage(message: unknown) { messages.push(message); }
});
after(() => {
    if (savedAcquire === undefined) delete (globalThis as any).acquireVsCodeApi;
    else (globalThis as any).acquireVsCodeApi = savedAcquire;
});

it('cancels large binary preparation before posting a cell mutation', async () => {
    const modulePath = '../../core/ui/modules/api.js';
    const api = await import(modulePath);
    const controller = new AbortController();
    messages = [];
    const pending = api.sendRpcRequest('updateCell', ['t', 1, 'payload', new Uint8Array(5 * 1024 * 1024)], {
        signal: controller.signal
    });
    controller.abort();
    // Settle the old, uncancellable implementation so its timeout cannot keep
    // the regression process alive after the assertion fails.
    const watcher = setInterval(() => {
        for (const message of messages.splice(0)) {
            api.handleRpcResponse({ kind: 'response', messageId: message.content.messageId, success: true, data: 1 });
        }
    }, 10);
    try { await assert.rejects(pending, { name: 'AbortError' }); }
    finally { clearInterval(watcher); }
});

it('encodes byte-exact large subviews without timer-throttled preparation', async () => {
    const transport = await import('../../core/ui/modules/transport.js');
    const buffer = new Uint8Array(5 * 1024 * 1024 + 7);
    for (let i = 0; i < buffer.length; i++) buffer[i] = (i * 19) & 255;
    const bytes = buffer.subarray(3, buffer.length - 2);
    const oldSetTimeout = globalThis.setTimeout;
    let timerCalls = 0;
    (globalThis as any).setTimeout = (...args: Parameters<typeof setTimeout>) => {
        timerCalls++;
        return oldSetTimeout(...args);
    };
    try {
        const encoded = await transport.serializeValueAsync(bytes, { surface: 'upload regression' });
        assert.ok(encoded && typeof encoded === 'object' && 'base64' in encoded);
        assert.equal(encoded.base64, Buffer.from(bytes).toString('base64'));
        assert.equal(timerCalls, 0, 'background timer clamping must not pace binary encoding');
    } finally { globalThis.setTimeout = oldSetTimeout; }
});

it('awaits the real result when a cancellation arrives after posting', async () => {
    const modulePath = '../../core/ui/modules/api.js';
    const api = await import(modulePath);
    const controller = new AbortController();
    let posted = false;
    messages = [];
    const pending = api.sendRpcRequest('updateCell', ['t', 1, 'payload', new Uint8Array([0, 255])], {
        signal: controller.signal,
        onDidPost() { posted = true; controller.abort(); }
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(posted, true);
    assert.equal(messages.length, 1);
    api.handleRpcResponse({ kind: 'response', messageId: messages[0].content.messageId, success: true, data: 1 });
    assert.equal(await pending, 1, 'a committed mutation must not be reported as cancelled');
});

it('web demo cancellation during metadata lookup cannot post the later mutation', async () => {
    const originalWindow = (globalThis as any).window;
    const posted: any[] = [];
    (globalThis as any).window = {
        parent: { postMessage(message: unknown) { posted.push(message); } },
        location: { ancestorOrigins: ['https://sqlite.example'] },
        addEventListener() {}
    };
    try {
        const modulePath = '../../core/ui/modules/web-api.js';
        const api = await import(modulePath);
        const controller = new AbortController();
        const pending = api.backendApi.updateCell('t', 1, 'payload', new Uint8Array([1]), undefined, { signal: controller.signal });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(posted.length, 1);
        assert.equal(posted[0].content.targetMethod, 'getCellMetadata');
        controller.abort();
        api.handleRpcResponse({ kind: 'response', messageId: posted[0].content.messageId, success: true,
            data: { storageClass: 'blob', byteLength: 1 } });
        await assert.rejects(pending, { name: 'AbortError' });
        assert.equal(posted.length, 1, 'the cancelled drop must not mutate the demo database');
    } finally {
        if (originalWindow === undefined) delete (globalThis as any).window;
        else (globalThis as any).window = originalWindow;
    }
});
