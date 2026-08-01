import './vscode_mock_setup';

import { after, it } from 'node:test';
import assert from 'node:assert';

const extensionMessages: any[] = [];
const webMessages: any[] = [];

(globalThis as any).acquireVsCodeApi = () => ({
    getState: () => undefined,
    setState: () => undefined,
    postMessage: (message: any) => extensionMessages.push(message)
});
(globalThis as any).window = {
    parent: { postMessage: (message: any) => webMessages.push(message) },
    location: { ancestorOrigins: [] }
};

after(() => {
    delete (globalThis as any).acquireVsCodeApi;
    delete (globalThis as any).window;
});

it('keeps host-modal RPCs alive until their response in both transports', async () => {
    const extensionApiModulePath = '../../core/ui/modules/api.js';
    const webApiModulePath = '../../core/ui/modules/web-api.js';
    const sharedModulePath = '../../core/ui/modules/rpc-constants.js';
    const extensionApi = await import(extensionApiModulePath);
    const webApi = await import(webApiModulePath);
    const shared = await import(sharedModulePath);
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const scheduled: number[] = [];
    (globalThis as any).setTimeout = (_callback: () => void, delay: number) => {
        scheduled.push(delay);
        return 91;
    };
    (globalThis as any).clearTimeout = () => undefined;

    try {
        for (const method of [
            'deleteColumns',
            'editView',
            'dropView',
            'confirmLargeChanges',
            'confirmLargeSelection'
        ]) {
            assert.strictEqual(shared.getRpcTimeoutMs(method), undefined, method);
            assert.strictEqual(extensionApi.getRpcTimeoutMs(method), undefined, method);
            assert.strictEqual(webApi.getRpcTimeoutMs(method), undefined, method);
        }

        const extensionPromise = extensionApi.sendRpcRequest('dropView', ['slow_dialog']);
        await new Promise<void>(resolve => setImmediate(resolve));
        const extensionRequest = extensionMessages.at(-1).content;
        assert.strictEqual(scheduled.length, 0, 'interactive extension RPC must have no fixed timer');
        extensionApi.handleRpcResponse({
            kind: 'response',
            messageId: extensionRequest.messageId,
            success: true,
            data: { dropped: true }
        });
        assert.deepStrictEqual(await extensionPromise, { dropped: true });

        const webPromise = webApi.sendRpcRequest('dropView', ['slow_dialog']);
        await new Promise<void>(resolve => setImmediate(resolve));
        const webRequest = webMessages.at(-1).content;
        assert.strictEqual(scheduled.length, 0, 'interactive web RPC must have no fixed timer');
        webApi.handleRpcResponse({
            kind: 'response',
            messageId: webRequest.messageId,
            success: true,
            data: { dropped: true }
        });
        assert.deepStrictEqual(await webPromise, { dropped: true });

        const ordinaryPromise = extensionApi.sendRpcRequest('ping', []);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepStrictEqual(scheduled, [shared.RPC_TIMEOUT_MS]);
        const ordinaryRequest = extensionMessages.at(-1).content;
        extensionApi.handleRpcResponse({
            kind: 'response',
            messageId: ordinaryRequest.messageId,
            success: true,
            data: true
        });
        assert.strictEqual(await ordinaryPromise, true);
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
    }
});
