import { describe, it } from 'node:test';
import assert from 'node:assert';
import { WebviewMessageHandler } from '../../src/webviewMessageHandler';

describe('WebviewMessageHandler', () => {
    it('should handle RPC invocation', (context) => {
        const hostBridge = {
            echo: (val: any) => val
        };
        let sentMessage: any = null;
        const postMessage = async (msg: any) => {
            sentMessage = msg;
            return true;
        };

        const handler = new WebviewMessageHandler(postMessage, hostBridge);

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
        const postMessage = async (msg: any) => {
            sentMessage = msg;
            return true;
        };

        const handler = new WebviewMessageHandler(postMessage, hostBridge);

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

    it('should handle legacy RPC request', () => {
        const hostBridge = {
            echo: (val: any) => val
        };
        let sentMessage: any = null;
        const postMessage = async (msg: any) => {
            sentMessage = msg;
            return true;
        };

        const handler = new WebviewMessageHandler(postMessage, hostBridge);

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
});
