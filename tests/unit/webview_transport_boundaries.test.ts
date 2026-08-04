import assert from 'node:assert';
import { after, describe, it } from 'node:test';

import {
    MAX_WEBVIEW_BINARY_VALUE_BYTES,
    WEBVIEW_PAYLOAD_LIMIT_ERROR_CODE,
    WebviewPayloadLimitError,
    toWebviewPayloadLimitErrorData
} from '../../src/core/webview-transport';

const originalAcquireVsCodeApi = (globalThis as any).acquireVsCodeApi;
const originalWindow = (globalThis as any).window;
let activeVsCodeMessages: any[] = [];
let onVsCodePost: ((message: any) => void) | undefined;
const stableVsCodeApi = {
    getState: () => undefined,
    setState() {},
    postMessage(message: any) {
        activeVsCodeMessages.push(message);
        onVsCodePost?.(message);
    }
};
let activeDemoMessages: any[] = [];
let onDemoPost: ((message: any) => void) | undefined;
const stableDemoParent = {
    postMessage(message: any) {
        activeDemoMessages.push(message);
        onDemoPost?.(message);
    }
};

after(() => {
    if (originalAcquireVsCodeApi === undefined) delete (globalThis as any).acquireVsCodeApi;
    else (globalThis as any).acquireVsCodeApi = originalAcquireVsCodeApi;
    if (originalWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = originalWindow;
});

function assertTypedLimit(error: unknown, surface: string): boolean {
    assert.ok(error instanceof WebviewPayloadLimitError);
    assert.strictEqual(error.code, WEBVIEW_PAYLOAD_LIMIT_ERROR_CODE);
    assert.strictEqual(error.surface, surface);
    assert.strictEqual(error.kind, 'binary-value');
    assert.strictEqual(error.limitBytes, MAX_WEBVIEW_BINARY_VALUE_BYTES);
    return true;
}

function oversizedBase64Marker() {
    const encodedLength = 4 * Math.ceil((MAX_WEBVIEW_BINARY_VALUE_BYTES + 1) / 3);
    return { __type: 'Uint8Array', base64: 'A'.repeat(encodedLength) };
}

async function settleRejectedBeforePost(
    request: Promise<unknown>,
    posted: Promise<any>,
    settlePostedRequest: (message: any) => void
): Promise<unknown> {
    const outcome = await Promise.race([
        request.then(
            value => ({ kind: 'resolved' as const, value }),
            error => ({ kind: 'rejected' as const, error })
        ),
        posted.then(message => ({ kind: 'posted' as const, message }))
    ]);
    if (outcome.kind === 'posted') {
        settlePostedRequest(outcome.message);
        await request;
        assert.fail('oversized request reached postMessage');
    }
    assert.strictEqual(outcome.kind, 'rejected');
    return outcome.error;
}

describe('VS Code webview transport guards', () => {
    it('rejects an oversized request before base64 encoding and postMessage', async () => {
        let resolvePosted!: (message: any) => void;
        const posted = new Promise<any>(resolve => { resolvePosted = resolve; });
        const messages: any[] = [];
        activeVsCodeMessages = messages;
        onVsCodePost = resolvePosted;
        (globalThis as any).acquireVsCodeApi = () => stableVsCodeApi;
        const api = await import(`../../core/ui/modules/api.js?stage-c-request=${Date.now()}`);
        const request = api.sendRpcRequest('updateCell', [
            'cells',
            1,
            'payload',
            new Uint8Array(MAX_WEBVIEW_BINARY_VALUE_BYTES + 1),
            null
        ]);

        const error = await settleRejectedBeforePost(request, posted, message => {
            api.handleRpcResponse({
                kind: 'response',
                messageId: message.content.messageId,
                success: true,
                data: null
            });
        });
        assertTypedLimit(error, 'webview -> extension host request');
        assert.strictEqual(messages.length, 0);
    });

    it('rejects an oversized response marker and rejects the pending call with its typed shape', async () => {
        const messages: any[] = [];
        activeVsCodeMessages = messages;
        onVsCodePost = undefined;
        (globalThis as any).acquireVsCodeApi = () => stableVsCodeApi;
        const api = await import(`../../core/ui/modules/api.js?stage-c-response=${Date.now()}`);
        const request = api.sendRpcRequest('ping', []);
        await new Promise<void>(resolve => setImmediate(resolve));
        const messageId = messages[0].content.messageId;

        assert.doesNotThrow(() => api.handleRpcResponse({
            kind: 'response',
            messageId,
            success: true,
            data: oversizedBase64Marker()
        }));
        await assert.rejects(request, error => (
            assertTypedLimit(error, 'extension host -> webview response')
        ));
    });

    it('restores a typed rejection sent by the extension host', async () => {
        const messages: any[] = [];
        activeVsCodeMessages = messages;
        onVsCodePost = undefined;
        (globalThis as any).acquireVsCodeApi = () => stableVsCodeApi;
        const api = await import(`../../core/ui/modules/api.js?stage-c-error=${Date.now()}`);
        const request = api.sendRpcRequest('ping', []);
        await new Promise<void>(resolve => setImmediate(resolve));
        const typed = new WebviewPayloadLimitError({
            surface: 'extension host -> webview response',
            kind: 'binary-value',
            actualBytes: MAX_WEBVIEW_BINARY_VALUE_BYTES + 1,
            limitBytes: MAX_WEBVIEW_BINARY_VALUE_BYTES
        });
        api.handleRpcResponse({
            kind: 'response',
            messageId: messages[0].content.messageId,
            success: false,
            errorMessage: typed.message,
            error: toWebviewPayloadLimitErrorData(typed)
        });

        await assert.rejects(request, error => (
            assertTypedLimit(error, 'extension host -> webview response')
        ));
    });
});

describe('web demo iframe transport guards', () => {
    it('rejects oversized iframe requests before posting them to the parent', async () => {
        let resolvePosted!: (message: any) => void;
        const posted = new Promise<any>(resolve => { resolvePosted = resolve; });
        const messages: any[] = [];
        activeDemoMessages = messages;
        onDemoPost = resolvePosted;
        (globalThis as any).window = {
            parent: stableDemoParent,
            location: { ancestorOrigins: ['https://demo.example'] },
            addEventListener() {},
            confirm: () => false
        };
        const api = await import(`../../core/ui/modules/web-api.js?stage-c-request=${Date.now()}`);
        const request = api.sendRpcRequest('updateCell', [
            'cells',
            1,
            'payload',
            new Uint8Array(MAX_WEBVIEW_BINARY_VALUE_BYTES + 1),
            null
        ]);

        const error = await settleRejectedBeforePost(request, posted, message => {
            api.handleRpcResponse({
                kind: 'response',
                messageId: message.content.messageId,
                success: true,
                data: null
            });
        });
        assertTypedLimit(error, 'web demo iframe -> parent request');
        assert.strictEqual(messages.length, 0);
    });

    it('rejects oversized parent responses without enumerating typed-array keys', async () => {
        const messages: any[] = [];
        activeDemoMessages = messages;
        onDemoPost = undefined;
        (globalThis as any).window = {
            parent: stableDemoParent,
            location: { ancestorOrigins: ['https://demo.example'] },
            addEventListener() {},
            confirm: () => false
        };
        const api = await import(`../../core/ui/modules/web-api.js?stage-c-response=${Date.now()}`);
        const request = api.sendRpcRequest('ping', []);
        await new Promise<void>(resolve => setImmediate(resolve));

        assert.doesNotThrow(() => api.handleRpcResponse({
            kind: 'response',
            messageId: messages[0].content.messageId,
            success: true,
            data: new Uint8Array(MAX_WEBVIEW_BINARY_VALUE_BYTES + 1)
        }));
        await assert.rejects(request, error => (
            assertTypedLimit(error, 'web demo parent -> iframe response')
        ));
    });

    it('refuses oversized media explicitly and preserves the bounded preview option', async () => {
        activeDemoMessages = [];
        onDemoPost = undefined;
        (globalThis as any).window = {
            parent: stableDemoParent,
            location: { ancestorOrigins: ['https://demo.example'] },
            addEventListener() {},
            confirm: () => false
        };
        const api = await import(`../../core/ui/modules/web-api.js?stage-c-media=${Date.now()}`);

        const result = await api.backendApi.prepareCellMediaPreview(
            { table: 'large_cells' },
            1,
            'payload',
            {
                type: { type: 'image', mime: 'image/png', ext: 'png' },
                webviewId: 'demo',
                sourceByteLength: 256 * 1024 * 1024
            }
        );

        assert.strictEqual(result.success, false);
        assert.match(result.message, /268435456 bytes/);
        assert.match(result.message, /16777216-byte webview binary limit/);
        assert.match(result.message, /bounded Text\/Hex preview/);
        assert.match(result.message, /streaming is not implemented/);
        assert.strictEqual(activeDemoMessages.length, 0);
    });
});
