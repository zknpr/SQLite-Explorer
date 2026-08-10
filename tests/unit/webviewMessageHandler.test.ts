import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { WebviewMessageHandler } from '../../src/webviewMessageHandler';
import {
    MAX_WEBVIEW_AGGREGATE_PAYLOAD_BYTES,
    MAX_WEBVIEW_BINARY_VALUE_BYTES,
    WEBVIEW_PAYLOAD_LIMIT_ERROR_CODE
} from '../../src/core/webview-transport';
import type { PendingInvocation } from '../../src/core/rpc';
import {
    CellEditPolicyError,
    CELL_EDIT_VALUE_TOO_LARGE_CODE
} from '../../src/core/cell-edit-policy';

function nextPostedMessage() {
    let resolve!: (message: any) => void;
    const promise = new Promise<any>(value => { resolve = value; });
    return {
        promise,
        postMessage: async (message: unknown) => {
            resolve(message);
            return true;
        }
    };
}

function assertLimitError(
    message: any,
    expected: {
        surface: string;
        kind: 'binary-value' | 'aggregate-payload';
        actualBytes?: number;
        limitBytes: number;
    }
) {
    assert.strictEqual(message.content.success, false);
    assert.strictEqual(message.content.error.code, WEBVIEW_PAYLOAD_LIMIT_ERROR_CODE);
    assert.strictEqual(message.content.error.surface, expected.surface);
    assert.strictEqual(message.content.error.kind, expected.kind);
    assert.strictEqual(message.content.error.limitBytes, expected.limitBytes);
    if (expected.actualBytes !== undefined) {
        assert.strictEqual(message.content.error.actualBytes, expected.actualBytes);
    }
    assert.match(message.content.errorMessage, new RegExp(expected.surface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

describe('WebviewMessageHandler', () => {
    it('should handle RPC invocation', (context) => {
        const hostBridge = {
            echo: (val: unknown) => val
        };
        let sentMessage: any = null;
        const postMessage = async (msg: unknown) => {
            sentMessage = msg;
            return true;
        };

        const handler = new WebviewMessageHandler(postMessage, hostBridge as unknown as import('../../src/hostBridge').HostBridge);

        handler.handleMessage({
            channel: 'rpc',
            content: {
                kind: 'invoke',
                messageId: '123',
                targetMethod: 'echo',
                payload: ['hello']
            }
        });

        // Use promise to wait for resolution
        return new Promise<void>((resolve) => {
            // Give it a moment to process the promise chain inside handler
            setTimeout(() => {
                assert.deepStrictEqual(sentMessage, {
                    channel: 'rpc',
                    content: {
                        kind: 'response',
                        messageId: '123',
                        success: true,
                        data: 'hello'
                    }
                });
                resolve();
            }, 10);
        });
    });

    it('should handle unknown method', () => {
        const hostBridge = {};
        let sentMessage: any = null;
        const postMessage = async (msg: unknown) => {
            sentMessage = msg;
            return true;
        };

        const handler = new WebviewMessageHandler(postMessage, hostBridge as unknown as import('../../src/hostBridge').HostBridge);

        handler.handleMessage({
            channel: 'rpc',
            content: {
                kind: 'invoke',
                messageId: '123',
                targetMethod: 'unknown',
                payload: []
            }
        });

        assert.strictEqual(sentMessage.content.success, false);
        assert.match(sentMessage.content.errorMessage, /Method 'unknown' not found/);
    });

    it('surfaces oversized new-value refusal as a typed RPC error', async () => {
        const hostBridge = {
            insertRow: () => {
                throw new CellEditPolicyError('blob', 2049, 2048);
            }
        };
        const posted = nextPostedMessage();
        const handler = new WebviewMessageHandler(
            posted.postMessage,
            hostBridge as unknown as import('../../src/hostBridge').HostBridge
        );

        handler.handleMessage({
            channel: 'rpc',
            content: {
                kind: 'invoke',
                messageId: 'typed-cell-edit-refusal',
                targetMethod: 'insertRow',
                payload: ['cells', { payload: new Uint8Array(1) }]
            }
        });

        const message = await posted.promise;
        assert.strictEqual(message.content.success, false);
        assert.strictEqual(message.content.error.code, CELL_EDIT_VALUE_TOO_LARGE_CODE);
        assert.strictEqual(message.content.error.storageClass, 'blob');
        assert.strictEqual(message.content.error.actualBytes, 2049);
        assert.strictEqual(message.content.error.limitBytes, 2048);
    });

    it('should handle legacy RPC request', () => {
        const hostBridge = {
            echo: (val: unknown) => val
        };
        let sentMessage: any = null;
        const postMessage = async (msg: unknown) => {
            sentMessage = msg;
            return true;
        };

        const handler = new WebviewMessageHandler(postMessage, hostBridge as unknown as import('../../src/hostBridge').HostBridge);

        handler.handleMessage({
            type: 'rpc-request',
            method: 'echo',
            id: '123',
            args: ['legacy']
        });

        return new Promise<void>((resolve) => {
             setTimeout(() => {
                assert.deepStrictEqual(sentMessage, {
                    type: 'rpc-response',
                    id: '123',
                    result: 'legacy'
                });
                resolve();
             }, 10);
        });
    });

    it('rejects an oversized webview request before deserialization or host invocation', async () => {
        const hostBridge = { echo: mock.fn((value: unknown) => value) };
        const posted = nextPostedMessage();
        const handler = new WebviewMessageHandler(
            posted.postMessage,
            hostBridge as unknown as import('../../src/hostBridge').HostBridge
        );
        const bytes = new Uint8Array(MAX_WEBVIEW_BINARY_VALUE_BYTES + 1);

        assert.doesNotThrow(() => handler.handleMessage({
            channel: 'rpc',
            content: {
                kind: 'invoke',
                messageId: 'oversized-request',
                targetMethod: 'echo',
                payload: [bytes]
            }
        }));

        const message = await posted.promise;
        assertLimitError(message, {
            surface: 'webview -> extension host request',
            kind: 'binary-value',
            actualBytes: bytes.byteLength,
            limitBytes: MAX_WEBVIEW_BINARY_VALUE_BYTES
        });
        assert.strictEqual(hostBridge.echo.mock.callCount(), 0);
    });

    it('rejects aggregate webview request amplification before host invocation', async () => {
        const hostBridge = { echo: mock.fn((value: unknown) => value) };
        const posted = nextPostedMessage();
        const handler = new WebviewMessageHandler(
            posted.postMessage,
            hostBridge as unknown as import('../../src/hostBridge').HostBridge
        );
        const bytesPerValue = 13 * 1024 * 1024;

        handler.handleMessage({
            channel: 'rpc',
            content: {
                kind: 'invoke',
                messageId: 'aggregate-request',
                targetMethod: 'echo',
                payload: [new Uint8Array(bytesPerValue), new Uint8Array(bytesPerValue)]
            }
        });

        const message = await posted.promise;
        assertLimitError(message, {
            surface: 'webview -> extension host request',
            kind: 'aggregate-payload',
            limitBytes: MAX_WEBVIEW_AGGREGATE_PAYLOAD_BYTES
        });
        assert.strictEqual(hostBridge.echo.mock.callCount(), 0);
    });

    it('turns an oversized host response into a typed RPC rejection without throwing', async () => {
        const bytes = new Uint8Array(MAX_WEBVIEW_BINARY_VALUE_BYTES + 1);
        const hostBridge = { oversized: () => bytes };
        const posted = nextPostedMessage();
        const handler = new WebviewMessageHandler(
            posted.postMessage,
            hostBridge as unknown as import('../../src/hostBridge').HostBridge
        );

        assert.doesNotThrow(() => handler.handleMessage({
            channel: 'rpc',
            content: {
                kind: 'invoke',
                messageId: 'oversized-response',
                targetMethod: 'oversized',
                payload: []
            }
        }));

        const message = await posted.promise;
        assertLimitError(message, {
            surface: 'extension host -> webview response',
            kind: 'binary-value',
            actualBytes: bytes.byteLength,
            limitBytes: MAX_WEBVIEW_BINARY_VALUE_BYTES
        });
    });

    it('turns aggregate host response amplification into a typed RPC rejection', async () => {
        const bytesPerValue = 13 * 1024 * 1024;
        const hostBridge = {
            oversized: () => [
                new Uint8Array(bytesPerValue),
                new Uint8Array(bytesPerValue)
            ]
        };
        const posted = nextPostedMessage();
        const handler = new WebviewMessageHandler(
            posted.postMessage,
            hostBridge as unknown as import('../../src/hostBridge').HostBridge
        );

        handler.handleMessage({
            channel: 'rpc',
            content: {
                kind: 'invoke',
                messageId: 'aggregate-response',
                targetMethod: 'oversized',
                payload: []
            }
        });

        const message = await posted.promise;
        assertLimitError(message, {
            surface: 'extension host -> webview response',
            kind: 'aggregate-payload',
            limitBytes: MAX_WEBVIEW_AGGREGATE_PAYLOAD_BYTES
        });
    });

    it('faults a pending host call on an oversized webview response without routing it', () => {
        let fault: any;
        let completed = false;
        const pending = new Map<string, PendingInvocation>([[
            'host-call',
            {
                onComplete: () => { completed = true; },
                onFault: error => { fault = error; },
                expirationTimer: setTimeout(() => {}, 60_000)
            }
        ]]);
        const handler = new WebviewMessageHandler(
            async () => true,
            {} as import('../../src/hostBridge').HostBridge,
            pending
        );

        assert.doesNotThrow(() => handler.handleMessage({
            kind: 'result',
            correlationId: 'host-call',
            payload: new Uint8Array(MAX_WEBVIEW_BINARY_VALUE_BYTES + 1)
        }));

        assert.strictEqual(completed, false);
        assert.strictEqual(pending.size, 0);
        assert.strictEqual(fault.code, WEBVIEW_PAYLOAD_LIMIT_ERROR_CODE);
        assert.strictEqual(fault.surface, 'webview -> extension host response');
        assert.strictEqual(fault.kind, 'binary-value');
    });

    it('faults a pending host call on aggregate webview response amplification', () => {
        let fault: any;
        const pending = new Map<string, PendingInvocation>([[
            'host-call',
            {
                onComplete: () => assert.fail('oversized response completed'),
                onFault: error => { fault = error; },
                expirationTimer: setTimeout(() => {}, 60_000)
            }
        ]]);
        const handler = new WebviewMessageHandler(
            async () => true,
            {} as import('../../src/hostBridge').HostBridge,
            pending
        );
        const bytesPerValue = 13 * 1024 * 1024;

        handler.handleMessage({
            kind: 'result',
            correlationId: 'host-call',
            payload: [new Uint8Array(bytesPerValue), new Uint8Array(bytesPerValue)]
        });

        assert.strictEqual(pending.size, 0);
        assert.strictEqual(fault.surface, 'webview -> extension host response');
        assert.strictEqual(fault.kind, 'aggregate-payload');
        assert.strictEqual(fault.limitBytes, MAX_WEBVIEW_AGGREGATE_PAYLOAD_BYTES);
    });
});
