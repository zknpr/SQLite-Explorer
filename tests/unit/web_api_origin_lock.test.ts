import './vscode_mock_setup';

import { after, it } from 'node:test';
import assert from 'node:assert';

const originalWindow = (globalThis as any).window;

after(() => {
    if (originalWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = originalWindow;
});

it('sends only a content-free ready ping to wildcard before locking to the verified parent origin', async () => {
    const posted: { message: any; targetOrigin: string }[] = [];
    let messageHandler: ((event: any) => void) | undefined;
    const parent = {
        postMessage(message: any, targetOrigin: string) {
            posted.push({ message, targetOrigin });
        }
    };
    (globalThis as any).window = {
        parent,
        location: { ancestorOrigins: undefined, origin: 'https://viewer.example' },
        addEventListener(type: string, handler: (event: any) => void) {
            if (type === 'message') messageHandler = handler;
        }
    };

    const webApi = await import(`../../core/ui/modules/web-api.js?origin-lock=${Date.now()}`);
    assert.deepStrictEqual(posted, [{
        message: { kind: 'sqlite-explorer-ready' },
        targetOrigin: '*'
    }]);
    assert.ok(messageHandler, 'the viewer must listen for the parent origin acknowledgement');

    assert.throws(
        () => webApi.sendRpcResult('before-lock', { secret: true }),
        /parent origin is not locked/i
    );
    const request = webApi.sendRpcRequest('ping', []);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.strictEqual(posted.length, 1, 'payload RPC must wait until the parent origin is locked');

    messageHandler!({
        source: parent,
        origin: 'https://embedding.example',
        data: { kind: 'sqlite-explorer-origin' }
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.strictEqual(posted.length, 2);
    assert.strictEqual(posted[1].targetOrigin, 'https://embedding.example');
    const requestMessage = (posted[1].message as any).content;
    webApi.handleRpcResponse({
        kind: 'response',
        messageId: requestMessage.messageId,
        success: true,
        data: { pong: true }
    });
    assert.deepStrictEqual(await request, { pong: true });

    webApi.sendRpcResult('after-lock', { secret: true });

    assert.strictEqual(posted.length, 3);
    assert.strictEqual(posted[2].targetOrigin, 'https://embedding.example');
    assert.deepStrictEqual(posted[2].message, {
        kind: 'result',
        correlationId: 'after-lock',
        payload: { secret: true }
    });
    assert.ok(
        posted.filter(entry => entry.targetOrigin === '*').every(entry => {
            const message = entry.message as any;
            return message.kind === 'sqlite-explorer-ready'
            && message.channel === undefined
            && message.content === undefined
            && message.payload === undefined;
        }),
        'no payload-bearing message may use a wildcard target origin'
    );
});
