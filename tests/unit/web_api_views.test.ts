import './vscode_mock_setup';

import { after, it } from 'node:test';
import assert from 'node:assert';
import { createDeferred } from './helpers/deferred';

const postedMessages: any[] = [];
const posted = createDeferred<any>();
const confirmations: string[] = [];
let confirmResult = false;

(globalThis as any).window = {
    parent: {
        postMessage(message: any) {
            postedMessages.push(message);
            posted.resolve(message);
        }
    },
    location: { ancestorOrigins: [] },
    confirm(message: string) {
        confirmations.push(message);
        return confirmResult;
    }
};

after(() => {
    delete (globalThis as any).window;
});

it('confirms demo view drops with a trigger-loss warning before forwarding once', async () => {
    const webApiModulePath = '../../core/ui/modules/web-api.js';
    const { backendApi, handleRpcResponse } = await import(webApiModulePath);
    const cancelled = await backendApi.dropView('demo_view');
    assert.deepStrictEqual(cancelled, { cancelled: true });
    assert.strictEqual(postedMessages.length, 0);
    assert.match(confirmations[0], /demo_view/);
    assert.match(confirmations[0], /permanently/i);
    assert.match(confirmations[0], /INSTEAD OF triggers/i);

    confirmResult = true;
    const dropPromise = backendApi.dropView('demo_view');
    const request = await posted.promise;
    assert.strictEqual(request.content.targetMethod, 'dropView');
    assert.deepStrictEqual(request.content.payload, ['demo_view']);

    handleRpcResponse({
        kind: 'response',
        messageId: request.content.messageId,
        success: true,
        data: { dropped: true }
    });
    assert.deepStrictEqual(await dropPromise, { dropped: true });
    assert.strictEqual(confirmations.length, 2);
    assert.strictEqual(postedMessages.length, 1);
});
