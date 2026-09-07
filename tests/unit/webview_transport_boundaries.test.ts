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

const OWN_PROTO_JSON =
    '{"safe":1,"__proto__":{"inherited":"top"},"nested":[{"safe":2,"__proto__":{"inherited":"nested"}}]}';

function ownProtoFixture(): any {
    return JSON.parse(OWN_PROTO_JSON);
}

function assertOwnProtoPreserved(value: unknown): void {
    const root = value as Record<string, any>;
    const nested = root.nested[0] as Record<string, any>;
    for (const [record, expected] of [[root, 'top'], [nested, 'nested']] as const) {
        assert.strictEqual(Object.prototype.hasOwnProperty.call(record, '__proto__'), true);
        assert.deepStrictEqual(record['__proto__'], { inherited: expected });
        assert.strictEqual(record.inherited, undefined);
    }
    assert.deepStrictEqual(JSON.parse(JSON.stringify(value)), ownProtoFixture());
    assert.strictEqual(({} as Record<string, unknown>).inherited, undefined);
}

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
    it('clears pending state when VS Code postMessage throws', async () => {
        activeVsCodeMessages = [];
        (globalThis as any).acquireVsCodeApi = () => stableVsCodeApi;
        onVsCodePost = () => { throw new Error('VS Code transport unavailable'); };
        const originalClearTimeout = globalThis.clearTimeout;
        let clearedTimers = 0;
        (globalThis as any).clearTimeout = (timer: ReturnType<typeof setTimeout>) => {
            clearedTimers++;
            return originalClearTimeout(timer);
        };

        try {
            const api = await import(`../../core/ui/modules/api.js?post-failure=${Date.now()}`);
            await assert.rejects(api.sendRpcRequest('ping', []), /transport unavailable/);
            assert.strictEqual(clearedTimers, 1);
        } finally {
            onVsCodePost = undefined;
            (globalThis as any).clearTimeout = originalClearTimeout;
        }
    });

    it('preserves own __proto__ keys in api.js outbound requests', async () => {
        activeVsCodeMessages = [];
        onVsCodePost = undefined;
        (globalThis as any).acquireVsCodeApi = () => stableVsCodeApi;
        const api = await import(`../../core/ui/modules/api.js?own-proto-out=${Date.now()}`);
        const request = api.sendRpcRequest('probe', [ownProtoFixture()]);
        await new Promise<void>(resolve => setImmediate(resolve));
        const message = activeVsCodeMessages[0];
        assertOwnProtoPreserved(message.content.payload[0]);
        api.handleRpcResponse({
            kind: 'response',
            messageId: message.content.messageId,
            success: true,
            data: null
        });
        await request;
    });

    it('preserves own __proto__ keys in api.js inbound responses', async () => {
        activeVsCodeMessages = [];
        onVsCodePost = undefined;
        (globalThis as any).acquireVsCodeApi = () => stableVsCodeApi;
        const api = await import(`../../core/ui/modules/api.js?own-proto-in=${Date.now()}`);
        const request = api.sendRpcRequest('probe', []);
        await new Promise<void>(resolve => setImmediate(resolve));
        api.handleRpcResponse({
            kind: 'response',
            messageId: activeVsCodeMessages[0].content.messageId,
            success: true,
            data: structuredClone(ownProtoFixture())
        });
        assertOwnProtoPreserved(await request);
    });

    it('exposes bounded cell reads and restores chunk bytes from the host', async () => {
        activeVsCodeMessages = [];
        onVsCodePost = undefined;
        (globalThis as any).acquireVsCodeApi = () => stableVsCodeApi;
        const api = await import(`../../core/ui/modules/api.js?cell-read=${Date.now()}`);

        const open = api.backendApi.openCellReadSession({
            table: 'items',
            rowId: 0,
            column: 'body'
        });
        await new Promise<void>(resolve => setImmediate(resolve));
        const openMessage = activeVsCodeMessages.shift();
        assert.strictEqual(openMessage.content.targetMethod, 'openCellReadSession');
        api.handleRpcResponse({
            kind: 'response',
            messageId: openMessage.content.messageId,
            success: true,
            data: {
                sessionId: 'session-1',
                metadata: { storageClass: 'text', byteLength: 2, textEncoding: 'utf-8' },
                expiresAt: Date.now() + 30_000
            }
        });
        const session = await open;

        const read = api.backendApi.readCellChunk(session.sessionId, 0, 2);
        await new Promise<void>(resolve => setImmediate(resolve));
        const readMessage = activeVsCodeMessages.shift();
        assert.strictEqual(readMessage.content.targetMethod, 'readCellChunk');
        api.handleRpcResponse({
            kind: 'response',
            messageId: readMessage.content.messageId,
            success: true,
            data: {
                byteOffset: 0,
                bytes: { __type: 'Uint8Array', base64: 'YWI=' },
                done: true
            }
        });
        assert.deepStrictEqual((await read).bytes, Uint8Array.from([0x61, 0x62]));

        const close = api.backendApi.closeCellReadSession(session.sessionId);
        await new Promise<void>(resolve => setImmediate(resolve));
        const closeMessage = activeVsCodeMessages.shift();
        assert.strictEqual(closeMessage.content.targetMethod, 'closeCellReadSession');
        api.handleRpcResponse({
            kind: 'response',
            messageId: closeMessage.content.messageId,
            success: true,
            data: null
        });
        await close;
    });

    it('preserves signed infinities across the JSON-only transport encoding', async () => {
        const transport = await import(`../../core/ui/modules/transport.js?nonfinite=${Date.now()}`);
        const encoded = await transport.serializeValueAsync(
            [Infinity, -Infinity, Number.NaN],
            { surface: 'non-finite transport test' }
        );
        const jsonValue = JSON.parse(JSON.stringify(encoded));
        const restored = transport.deserializeValue(jsonValue, { surface: 'non-finite transport test' });

        assert.strictEqual(restored[0], Infinity);
        assert.strictEqual(restored[1], -Infinity);
        assert.ok(Number.isNaN(restored[2]));
    });

    it('preserves own __proto__ keys while serializing through the shared web transport', async () => {
        const transport = await import(`../../core/ui/modules/transport.js?own-proto-out=${Date.now()}`);
        assertOwnProtoPreserved(await transport.serializeValueAsync(
            ownProtoFixture(),
            { surface: 'own __proto__ outbound test' }
        ));
    });

    it('preserves own __proto__ keys while deserializing through the shared web transport', async () => {
        const transport = await import(`../../core/ui/modules/transport.js?own-proto-in=${Date.now()}`);
        assertOwnProtoPreserved(transport.deserializeValue(
            structuredClone(ownProtoFixture()),
            { surface: 'own __proto__ inbound test' }
        ));
    });

    it('round-trips marker-shaped user objects without decoding them as numbers', async () => {
        const transport = await import(`../../core/ui/modules/transport.js?marker-collision=${Date.now()}`);
        const original = {
            row: { __type: 'NonFiniteNumber', value: 'Infinity' },
            number: -Infinity
        };
        const encoded = await transport.serializeValueAsync(
            original,
            { surface: 'non-finite marker collision test' }
        );
        const jsonValue = JSON.parse(JSON.stringify(encoded));

        assert.deepStrictEqual(
            transport.deserializeValue(jsonValue, { surface: 'non-finite marker collision test' }),
            original
        );
    });

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
    it('fails closed when a Firefox-style parent-origin handshake never arrives', async () => {
        activeDemoMessages = [];
        onDemoPost = undefined;
        (globalThis as any).window = {
            parent: stableDemoParent,
            location: { ancestorOrigins: ['https://demo.example'] },
            addEventListener() {},
            confirm: () => false
        };
        const api = await import(`../../core/ui/modules/web-api.js?origin-timeout=${Date.now()}`);

        await assert.rejects(api.waitForParentOrigin({
            originPromise: new Promise(() => undefined),
            lockedOrigin: null,
            timeoutMs: 1
        }), /parent origin handshake timed out/i);
    });

    it('clears pending state when parent postMessage throws', async () => {
        activeDemoMessages = [];
        onDemoPost = () => { throw new Error('parent transport unavailable'); };
        (globalThis as any).window = {
            parent: stableDemoParent,
            location: { ancestorOrigins: ['https://demo.example'] },
            addEventListener() {},
            confirm: () => false
        };
        const originalClearTimeout = globalThis.clearTimeout;
        let clearedTimers = 0;
        (globalThis as any).clearTimeout = (timer: ReturnType<typeof setTimeout>) => {
            clearedTimers++;
            return originalClearTimeout(timer);
        };

        try {
            const api = await import(`../../core/ui/modules/web-api.js?post-failure=${Date.now()}`);
            await assert.rejects(api.sendRpcRequest('ping', []), /transport unavailable/);
            assert.strictEqual(clearedTimers, 1);
        } finally {
            onDemoPost = undefined;
            (globalThis as any).clearTimeout = originalClearTimeout;
        }
    });

    it('preserves own __proto__ keys in web-api.js outbound requests', async () => {
        activeDemoMessages = [];
        onDemoPost = undefined;
        (globalThis as any).window = {
            parent: stableDemoParent,
            location: { ancestorOrigins: ['https://demo.example'] },
            addEventListener() {},
            confirm: () => false
        };
        const api = await import(`../../core/ui/modules/web-api.js?own-proto-out=${Date.now()}`);
        const request = api.sendRpcRequest('probe', [ownProtoFixture()]);
        await new Promise<void>(resolve => setImmediate(resolve));
        const message = activeDemoMessages[0];
        assertOwnProtoPreserved(message.content.payload[0]);
        api.handleRpcResponse({
            kind: 'response',
            messageId: message.content.messageId,
            success: true,
            data: null
        });
        await request;
    });

    it('preserves own __proto__ keys in web-api.js inbound responses', async () => {
        activeDemoMessages = [];
        onDemoPost = undefined;
        (globalThis as any).window = {
            parent: stableDemoParent,
            location: { ancestorOrigins: ['https://demo.example'] },
            addEventListener() {},
            confirm: () => false
        };
        const api = await import(`../../core/ui/modules/web-api.js?own-proto-in=${Date.now()}`);
        const request = api.sendRpcRequest('probe', []);
        await new Promise<void>(resolve => setImmediate(resolve));
        api.handleRpcResponse({
            kind: 'response',
            messageId: activeDemoMessages[0].content.messageId,
            success: true,
            data: structuredClone(ownProtoFixture())
        });
        assertOwnProtoPreserved(await request);
    });

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
