import './vscode_mock_setup';

import { after, beforeEach, it } from 'node:test';
import assert from 'node:assert';
import { createDeferred } from './helpers/deferred';

const postedMessages: any[] = [];
const postedWaiters = new Map<number, ReturnType<typeof createDeferred<any>>>();
const confirmations: string[] = [];
let confirmResult = false;

function waitForPostedMessage(index: number): Promise<any> {
    const existing = postedMessages[index];
    if (existing) return Promise.resolve(existing);
    const deferred = createDeferred<any>();
    postedWaiters.set(index, deferred);
    return deferred.promise;
}

(globalThis as any).window = {
    parent: {
        postMessage(message: any) {
            const index = postedMessages.length;
            postedMessages.push(message);
            postedWaiters.get(index)?.resolve(message);
            postedWaiters.delete(index);
        }
    },
    location: { ancestorOrigins: [] },
    confirm(message: string) {
        confirmations.push(message);
        return confirmResult;
    }
};

beforeEach(() => {
    postedMessages.length = 0;
    postedWaiters.clear();
    confirmations.length = 0;
    confirmResult = false;
});

it('re-exports one shared RPC timeout from both UI transports', async () => {
    const sharedModulePath = '../../core/ui/modules/rpc-constants.js';
    const extensionApiModulePath = '../../core/ui/modules/api.js';
    const webApiModulePath = '../../core/ui/modules/web-api.js';
    const shared = await import(sharedModulePath).catch(() => null);
    assert.ok(shared, 'RPC transports must consume one shared timeout module');
    const extensionApi = await import(extensionApiModulePath);
    const webApi = await import(webApiModulePath);

    assert.strictEqual(extensionApi.RPC_TIMEOUT_MS, shared.RPC_TIMEOUT_MS);
    assert.strictEqual(webApi.RPC_TIMEOUT_MS, shared.RPC_TIMEOUT_MS);
});

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
    const request = await waitForPostedMessage(0);
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

it('confirms the named demo triggers before an edit can discard them', async () => {
    const webApiModulePath = '../../core/ui/modules/web-api.js';
    const { backendApi, handleRpcResponse } = await import(webApiModulePath);

    const cancelledEdit = backendApi.editView(
        'demo_view',
        'SELECT 2 AS value',
        false,
        'CREATE VIEW demo_view AS SELECT 1 AS value',
        [{ identifier: 'demo_insert', sql: 'CREATE TRIGGER demo_insert' }]
    );
    const cancelledLookup = await waitForPostedMessage(0);
    assert.strictEqual(cancelledLookup.content.targetMethod, 'getViewDefinition');
    handleRpcResponse({
        kind: 'response',
        messageId: cancelledLookup.content.messageId,
        success: true,
        data: {
            triggers: [
                { identifier: 'demo_insert' },
                { identifier: 'demo_update' }
            ]
        }
    });

    assert.deepStrictEqual(await cancelledEdit, { cancelled: true });
    assert.strictEqual(postedMessages.length, 1, 'cancelled edits must not reach editView');
    assert.match(confirmations[0], /demo_view/);
    assert.match(confirmations[0], /demo_insert/);
    assert.match(confirmations[0], /demo_update/);
    assert.match(confirmations[0], /INSTEAD OF triggers/i);
    assert.match(confirmations[0], /permanently/i);

    confirmResult = true;
    const acceptedEdit = backendApi.editView(
        'demo_view',
        'SELECT 2 AS value',
        false,
        'CREATE VIEW demo_view AS SELECT 1 AS value',
        [{ identifier: 'demo_insert', sql: 'CREATE TRIGGER demo_insert' }]
    );
    const acceptedLookup = await waitForPostedMessage(1);
    handleRpcResponse({
        kind: 'response',
        messageId: acceptedLookup.content.messageId,
        success: true,
        data: { triggers: [{ identifier: 'demo_insert' }] }
    });

    const editRequest = await waitForPostedMessage(2);
    assert.strictEqual(editRequest.content.targetMethod, 'editView');
    assert.deepStrictEqual(editRequest.content.payload, [
        'demo_view',
        'SELECT 2 AS value',
        false,
        'CREATE VIEW demo_view AS SELECT 1 AS value',
        [{ identifier: 'demo_insert', sql: 'CREATE TRIGGER demo_insert' }]
    ]);
    handleRpcResponse({
        kind: 'response',
        messageId: editRequest.content.messageId,
        success: true,
        data: { updated: true }
    });
    assert.deepStrictEqual(await acceptedEdit, { updated: true });
    assert.strictEqual(confirmations.length, 2);
});
