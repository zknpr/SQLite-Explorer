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
    it('preserves own __proto__ keys on webview-to-host arguments', async () => {
        let captured: unknown;
        const posted = nextPostedMessage();
        const handler = new WebviewMessageHandler(posted.postMessage, {
            updateExtensionSetting(_key: string, value: unknown) {
                captured = value;
                return null;
            }
        } as unknown as import('../../src/hostBridge').HostBridge);

        handler.handleMessage({
            channel: 'rpc',
            content: {
                kind: 'invoke',
                messageId: 'own-proto-ingress',
                targetMethod: 'updateExtensionSetting',
                payload: ['test', structuredClone(ownProtoFixture())]
            }
        });
        await posted.promise;
        assertOwnProtoPreserved(captured);
    });

    it('preserves own __proto__ keys on host-to-webview results', async () => {
        const posted = nextPostedMessage();
        const handler = new WebviewMessageHandler(posted.postMessage, {
            fetchSchema: () => ownProtoFixture()
        } as unknown as import('../../src/hostBridge').HostBridge);

        handler.handleMessage({
            channel: 'rpc',
            content: {
                kind: 'invoke',
                messageId: 'own-proto-egress',
                targetMethod: 'fetchSchema',
                payload: []
            }
        });
        const message = await posted.promise;
        assertOwnProtoPreserved(message.content.data);
    });

    it('should handle RPC invocation', (context) => {
        const hostBridge = {
            ping: (val: unknown) => val
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
                targetMethod: 'ping',
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

    it('rejects a non-array modern RPC payload before invoking the host', async () => {
        const ping = mock.fn();
        const posted = nextPostedMessage();
        const handler = new WebviewMessageHandler(
            posted.postMessage,
            { ping } as unknown as import('../../src/hostBridge').HostBridge
        );

        handler.handleMessage({
            channel: 'rpc',
            content: {
                kind: 'invoke',
                messageId: 'malformed-payload',
                targetMethod: 'ping',
                payload: 'spread-me-as-characters'
            }
        });

        const message = await posted.promise;
        assert.strictEqual(message.content.success, false);
        assert.match(message.content.errorMessage, /payload must be an array/i);
        assert.strictEqual(ping.mock.callCount(), 0);
    });

    it('drops an unsafe modern RPC message ID before invoking or reflecting it', async () => {
        const ping = mock.fn();
        const postedMessages: unknown[] = [];
        const handler = new WebviewMessageHandler(
            async message => {
                postedMessages.push(message);
                return true;
            },
            { ping } as unknown as import('../../src/hostBridge').HostBridge
        );
        const hostileId = { secret: 'must-not-be-reflected' };

        handler.handleMessage({
            channel: 'rpc',
            content: {
                kind: 'invoke',
                messageId: hostileId,
                targetMethod: 'ping',
                payload: ['hello']
            }
        });
        await new Promise(resolve => setImmediate(resolve));

        assert.strictEqual(ping.mock.callCount(), 0);
        assert.deepStrictEqual(postedMessages, []);
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

    it('returns a terminal failure when a host method rejects an unstringifiable value', async () => {
        const hostile = {
            [Symbol.toPrimitive]() {
                throw new Error('coercion trap');
            }
        };
        const posted = nextPostedMessage();
        const handler = new WebviewMessageHandler(
            posted.postMessage,
            { ping: () => { throw hostile; } } as unknown as import('../../src/hostBridge').HostBridge
        );

        handler.handleMessage({
            channel: 'rpc',
            content: {
                kind: 'invoke',
                messageId: 'hostile-host-rejection',
                targetMethod: 'ping',
                payload: []
            }
        });

        const message = await posted.promise;
        assert.deepStrictEqual(message, {
            channel: 'rpc',
            content: {
                kind: 'response',
                messageId: 'hostile-host-rejection',
                success: false,
                errorMessage: 'Unknown error'
            }
        });
    });

    it('invokes a legacy RPC method exactly once', () => {
        const hostBridge = {
            ping: mock.fn((val: unknown) => val)
        };
        let sentMessage: any = null;
        const postMessage = async (msg: unknown) => {
            sentMessage = msg;
            return true;
        };

        const handler = new WebviewMessageHandler(postMessage, hostBridge as unknown as import('../../src/hostBridge').HostBridge);

        handler.handleMessage({
            type: 'rpc-request',
            method: 'ping',
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
                assert.strictEqual(hostBridge.ping.mock.callCount(), 1);
                resolve();
             }, 10);
        });
    });

    it('does not dispatch history-forging fireEditEvent requests', async () => {
        const fireEditEvent = mock.fn();
        const posted = nextPostedMessage();
        const handler = new WebviewMessageHandler(
            posted.postMessage,
            { fireEditEvent } as unknown as import('../../src/hostBridge').HostBridge
        );

        handler.handleMessage({
            channel: 'rpc',
            content: {
                kind: 'invoke',
                messageId: 'forged-history',
                targetMethod: 'fireEditEvent',
                payload: [{
                    modificationType: 'row_insert',
                    targetTable: 'items',
                    targetRowId: 1
                }]
            }
        });

        const message = await posted.promise;
        assert.strictEqual(message.content.success, false);
        assert.match(message.content.errorMessage, /not found|not available/i);
        assert.strictEqual(fireEditEvent.mock.callCount(), 0);
    });

    it('default-denies HostBridge helpers that are not webview capabilities', async () => {
        const acquireOutputChannel = mock.fn();
        const posted = nextPostedMessage();
        const handler = new WebviewMessageHandler(
            posted.postMessage,
            { acquireOutputChannel } as unknown as import('../../src/hostBridge').HostBridge
        );

        handler.handleMessage({
            channel: 'rpc',
            content: {
                kind: 'invoke',
                messageId: 'private-helper',
                targetMethod: 'acquireOutputChannel',
                payload: []
            }
        });

        const message = await posted.promise;
        assert.strictEqual(message.content.success, false);
        assert.strictEqual(acquireOutputChannel.mock.callCount(), 0);
    });

    it('does not dispatch a hybrid modern-and-legacy envelope twice', async () => {
        const ping = mock.fn((value: unknown) => value);
        const messages: unknown[] = [];
        const handler = new WebviewMessageHandler(
            async message => {
                messages.push(message);
                return true;
            },
            { ping } as unknown as import('../../src/hostBridge').HostBridge
        );

        handler.handleMessage({
            channel: 'rpc',
            content: {
                kind: 'invoke',
                messageId: 'hybrid',
                targetMethod: 'ping',
                payload: ['modern']
            },
            type: 'rpc-request',
            method: 'ping',
            id: 'hybrid-legacy',
            args: ['legacy']
        });
        await new Promise(resolve => setTimeout(resolve, 10));

        assert.strictEqual(ping.mock.callCount(), 1);
        assert.strictEqual(messages.length, 1);
        assert.strictEqual(ping.mock.calls[0].arguments[0], 'modern');
    });

    it('does not dispatch a legacy request attached to a core RPC response', async () => {
        const ping = mock.fn();
        const onComplete = mock.fn();
        const onFault = mock.fn();
        const expirationTimer = setTimeout(() => undefined, 60_000);
        const pendingInvocations = new Map<string, PendingInvocation>([[
            'host-call',
            { onComplete, onFault, expirationTimer }
        ]]);
        const postedMessages: unknown[] = [];
        const handler = new WebviewMessageHandler(
            async message => {
                postedMessages.push(message);
                return true;
            },
            { ping } as unknown as import('../../src/hostBridge').HostBridge,
            pendingInvocations
        );

        handler.handleMessage({
            kind: 'result',
            correlationId: 'host-call',
            payload: 'response-value',
            type: 'rpc-request',
            method: 'ping',
            id: 'smuggled-request',
            args: []
        });
        await new Promise(resolve => setTimeout(resolve, 0));

        assert.strictEqual(onComplete.mock.callCount(), 1);
        assert.strictEqual(onComplete.mock.calls[0].arguments[0], 'response-value');
        assert.strictEqual(onFault.mock.callCount(), 0);
        assert.strictEqual(ping.mock.callCount(), 0);
        assert.deepStrictEqual(postedMessages, []);
    });

    it('also denies fireEditEvent through the legacy envelope', async () => {
        const fireEditEvent = mock.fn();
        const postedMessages: unknown[] = [];
        const handler = new WebviewMessageHandler(
            async message => {
                postedMessages.push(message);
                return true;
            },
            { fireEditEvent } as unknown as import('../../src/hostBridge').HostBridge
        );

        handler.handleMessage({
            type: 'rpc-request',
            method: 'fireEditEvent',
            id: 'legacy-forged-history',
            args: [{}]
        });
        await new Promise(resolve => setTimeout(resolve, 0));

        assert.strictEqual(fireEditEvent.mock.callCount(), 0);
        assert.deepStrictEqual(postedMessages, [{
            type: 'rpc-response',
            id: 'legacy-forged-history',
            error: "Method 'fireEditEvent' not found on hostBridge"
        }]);
    });

    it('rejects an oversized webview request before deserialization or host invocation', async () => {
        const hostBridge = { ping: mock.fn((value: unknown) => value) };
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
                targetMethod: 'ping',
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
        assert.strictEqual(hostBridge.ping.mock.callCount(), 0);
    });

    it('rejects aggregate webview request amplification before host invocation', async () => {
        const hostBridge = { ping: mock.fn((value: unknown) => value) };
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
                targetMethod: 'ping',
                payload: [new Uint8Array(bytesPerValue), new Uint8Array(bytesPerValue)]
            }
        });

        const message = await posted.promise;
        assertLimitError(message, {
            surface: 'webview -> extension host request',
            kind: 'aggregate-payload',
            limitBytes: MAX_WEBVIEW_AGGREGATE_PAYLOAD_BYTES
        });
        assert.strictEqual(hostBridge.ping.mock.callCount(), 0);
    });

    it('turns an oversized host response into a typed RPC rejection without throwing', async () => {
        const bytes = new Uint8Array(MAX_WEBVIEW_BINARY_VALUE_BYTES + 1);
        const hostBridge = { fetchSchema: () => bytes };
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
                targetMethod: 'fetchSchema',
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
            fetchSchema: () => [
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
                targetMethod: 'fetchSchema',
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
