import './vscode_mock_setup';

import { after, beforeEach, it } from 'node:test';
import assert from 'node:assert';
import { DEFAULT_MAX_INLINE_CELL_BYTES } from '../../src/core/cell-containment';
import {
    DEFAULT_MAX_CELL_EDIT_BYTES,
    OVERSIZED_CELL_REPLACEMENT_CONFLICT_MESSAGE
} from '../../src/core/cell-edit-policy';
import { VIEW_DEFINITION_CONFLICT_MESSAGE } from '../../src/core/view-utils';
import { MAX_WEBVIEW_BINARY_VALUE_BYTES } from '../../src/core/webview-transport';
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

async function requirePostedMessageAfterTurn(index: number): Promise<any> {
    await new Promise<void>(resolve => setImmediate(resolve));
    const message = postedMessages[index];
    assert.ok(message, `expected posted RPC message ${index}`);
    return message;
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
    location: { ancestorOrigins: ['https://embedding.example'] },
    addEventListener() {},
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

it('uses the transport edit ceiling instead of the inline preview ceiling', async () => {
    const webApiModulePath = '../../core/ui/modules/web-api.js';
    const { backendApi, handleRpcResponse } = await import(webApiModulePath);
    const replacement = new Uint8Array(DEFAULT_MAX_INLINE_CELL_BYTES + 1);

    const update = backendApi.updateCell('items', 1, 'payload', replacement, 'previous text');
    const metadataRequest = await waitForPostedMessage(0);
    assert.strictEqual(metadataRequest.content.targetMethod, 'getCellMetadata');
    handleRpcResponse({
        kind: 'response',
        messageId: metadataRequest.content.messageId,
        success: true,
        data: { storageClass: 'blob', byteLength: 1 }
    });

    const updateRequest = await waitForPostedMessage(1);
    assert.strictEqual(updateRequest.content.targetMethod, 'updateCell');
    assert.strictEqual(updateRequest.content.payload[3].__type, 'Uint8Array');
    assert.strictEqual(updateRequest.content.payload[4], undefined);
    assert.strictEqual(updateRequest.content.payload[5], MAX_WEBVIEW_BINARY_VALUE_BYTES);
    handleRpcResponse({
        kind: 'response',
        messageId: updateRequest.content.messageId,
        success: true,
        data: 1
    });

    assert.strictEqual(await update, 1);
});

it('bounds repeated oversized-cell replacement conflicts instead of retrying forever', async () => {
    const webApiModulePath = '../../core/ui/modules/web-api.js';
    const { backendApi, handleRpcResponse } = await import(webApiModulePath);
    const originalPostMessage = (globalThis as any).window.parent.postMessage;
    let replacementAttempts = 0;
    confirmResult = true;

    (globalThis as any).window.parent.postMessage = (message: any) => {
        originalPostMessage.call((globalThis as any).window.parent, message);
        queueMicrotask(() => {
            const method = message.content.targetMethod;
            if (method === 'getCellMetadata') {
                handleRpcResponse({
                    kind: 'response',
                    messageId: message.content.messageId,
                    success: true,
                    data: {
                        storageClass: 'blob',
                        byteLength: DEFAULT_MAX_CELL_EDIT_BYTES + replacementAttempts + 1
                    }
                });
                return;
            }
            if (method === 'replaceOversizedCell') {
                replacementAttempts++;
                handleRpcResponse({
                    kind: 'response',
                    messageId: message.content.messageId,
                    success: false,
                    errorMessage: replacementAttempts < 5
                        ? OVERSIZED_CELL_REPLACEMENT_CONFLICT_MESSAGE
                        : 'test safety stop for an unbounded retry loop'
                });
            }
        });
    };

    try {
        await assert.rejects(
            backendApi.updateCell('items', 1, 'payload', Uint8Array.of(1), null),
            /changed repeatedly/i
        );
        assert.ok(replacementAttempts > 0 && replacementAttempts < 5);
    } finally {
        (globalThis as any).window.parent.postMessage = originalPostMessage;
    }
});

it('rejects an oversized demo file selection before reading it', async () => {
    const webApiModulePath = '../../core/ui/modules/web-api.js';
    const { backendApi } = await import(webApiModulePath);
    let arrayBufferCalls = 0;
    let input: any;
    (globalThis as any).document = {
        createElement() {
            input = {
                type: '',
                style: {},
                onchange: undefined,
                click() {}
            };
            return input;
        },
        body: {
            appendChild() {},
            removeChild() {}
        }
    };

    try {
        const selected = backendApi.selectFile();
        await input.onchange({
            target: {
                files: [{
                    name: 'too-large.bin',
                    size: DEFAULT_MAX_CELL_EDIT_BYTES + 1,
                    async arrayBuffer() {
                        arrayBufferCalls += 1;
                        return new ArrayBuffer(0);
                    }
                }]
            }
        });
        await assert.rejects(selected, /exceeds the 16777216-byte edit limit/);
        assert.strictEqual(arrayBufferCalls, 0);
    } finally {
        delete (globalThis as any).document;
    }
});

it('settles a cancelled demo file selection without racing slow picker interaction', async () => {
    const webApiModulePath = '../../core/ui/modules/web-api.js';
    const { backendApi } = await import(webApiModulePath);
    let input: any;
    let appended = false;
    let removals = 0;
    (globalThis as any).document = {
        createElement() {
            input = {
                type: '',
                style: {},
                onchange: undefined,
                oncancel: undefined,
                click() {}
            };
            return input;
        },
        body: {
            appendChild() {
                appended = true;
            },
            removeChild() {
                removals += 1;
                appended = false;
            }
        }
    };

    try {
        const selected = backendApi.selectFile();
        assert.strictEqual(appended, true, 'the picker input must remain live while the dialog is open');
        assert.strictEqual(removals, 0);
        assert.strictEqual(typeof input.oncancel, 'function');

        input.oncancel();

        assert.strictEqual(await selected, undefined);
        assert.strictEqual(appended, false);
        assert.strictEqual(removals, 1);
    } finally {
        delete (globalThis as any).document;
    }
});

it('removes the demo file input when opening the picker throws', async () => {
    const webApiModulePath = '../../core/ui/modules/web-api.js';
    const { backendApi } = await import(webApiModulePath);
    let appended = false;
    let removals = 0;
    (globalThis as any).document = {
        createElement() {
            return {
                type: '',
                style: {},
                onchange: undefined,
                oncancel: undefined,
                click() {
                    throw new Error('file picker unavailable');
                }
            };
        },
        body: {
            appendChild() {
                appended = true;
            },
            removeChild() {
                removals += 1;
                appended = false;
            }
        }
    };

    try {
        await assert.rejects(backendApi.selectFile(), /file picker unavailable/);
        assert.strictEqual(appended, false);
        assert.strictEqual(removals, 1);
    } finally {
        delete (globalThis as any).document;
    }
});

it('cleans up a failed demo download without leaking its object URL', async () => {
    const webApiModulePath = '../../core/ui/modules/web-api.js';
    const { backendApi } = await import(webApiModulePath);
    const originalUrl = globalThis.URL;
    let appended = false;
    let removals = 0;
    const revoked: string[] = [];
    (globalThis as any).URL = {
        createObjectURL() {
            return 'blob:failed-download';
        },
        revokeObjectURL(url: string) {
            revoked.push(url);
        }
    };
    (globalThis as any).document = {
        createElement() {
            return {
                href: '',
                download: '',
                click() {
                    throw new Error('download blocked');
                }
            };
        },
        body: {
            appendChild() {
                appended = true;
            },
            removeChild() {
                removals += 1;
                appended = false;
            }
        }
    };

    try {
        await assert.rejects(
            () => backendApi.saveFile('payload.bin', Uint8Array.of(1)),
            /download blocked/
        );
        assert.strictEqual(appended, false);
        assert.strictEqual(removals, 1);
        assert.deepStrictEqual(revoked, ['blob:failed-download']);
    } finally {
        (globalThis as any).URL = originalUrl;
        delete (globalThis as any).document;
    }
});

it('names demo view triggers before a confirmed drop and forwards that snapshot', async () => {
    const webApiModulePath = '../../core/ui/modules/web-api.js';
    const { backendApi, handleRpcResponse } = await import(webApiModulePath);

    const definition = {
        sql: 'CREATE VIEW demo_view AS SELECT 1 AS value',
        triggers: [
            { identifier: 'demo_insert', sql: 'CREATE TRIGGER demo_insert' },
            { identifier: 'demo_update', sql: 'CREATE TRIGGER demo_update' }
        ]
    };
    const cancelledDrop = backendApi.dropView('demo_view');
    const cancelledLookup = await requirePostedMessageAfterTurn(0);
    assert.strictEqual(cancelledLookup.content.targetMethod, 'getViewDefinition');
    handleRpcResponse({
        kind: 'response',
        messageId: cancelledLookup.content.messageId,
        success: true,
        data: definition
    });

    const cancelled = await cancelledDrop;
    assert.deepStrictEqual(cancelled, { cancelled: true });
    assert.strictEqual(postedMessages.length, 1, 'cancelled drops must not reach dropView');
    assert.match(confirmations[0], /demo_view/);
    assert.match(confirmations[0], /permanently/i);
    assert.match(confirmations[0], /INSTEAD OF triggers/i);
    assert.match(confirmations[0], /demo_insert/);
    assert.match(confirmations[0], /demo_update/);

    confirmResult = true;
    const dropPromise = backendApi.dropView('demo_view');
    const acceptedLookup = await waitForPostedMessage(1);
    assert.strictEqual(acceptedLookup.content.targetMethod, 'getViewDefinition');
    handleRpcResponse({
        kind: 'response',
        messageId: acceptedLookup.content.messageId,
        success: true,
        data: definition
    });

    const request = await waitForPostedMessage(2);
    assert.strictEqual(request.content.targetMethod, 'dropView');
    assert.deepStrictEqual(request.content.payload, [
        'demo_view',
        definition.sql,
        definition.triggers
    ]);

    handleRpcResponse({
        kind: 'response',
        messageId: request.content.messageId,
        success: true,
        data: { dropped: true }
    });
    assert.deepStrictEqual(await dropPromise, { dropped: true });
    assert.strictEqual(confirmations.length, 2);
    assert.strictEqual(postedMessages.length, 3);
});

it('bounds repeated demo view-drop conflicts instead of confirming forever', async () => {
    const webApiModulePath = '../../core/ui/modules/web-api.js';
    const { backendApi, handleRpcResponse } = await import(webApiModulePath);
    const originalPostMessage = (globalThis as any).window.parent.postMessage;
    let dropAttempts = 0;
    confirmResult = true;

    (globalThis as any).window.parent.postMessage = (message: any) => {
        originalPostMessage.call((globalThis as any).window.parent, message);
        queueMicrotask(() => {
            const method = message.content.targetMethod;
            if (method === 'getViewDefinition') {
                handleRpcResponse({
                    kind: 'response',
                    messageId: message.content.messageId,
                    success: true,
                    data: {
                        sql: `CREATE VIEW changing_view AS SELECT ${dropAttempts}`,
                        triggers: []
                    }
                });
                return;
            }
            if (method === 'dropView') {
                dropAttempts++;
                handleRpcResponse({
                    kind: 'response',
                    messageId: message.content.messageId,
                    success: false,
                    errorMessage: dropAttempts < 5
                        ? VIEW_DEFINITION_CONFLICT_MESSAGE
                        : 'test safety stop for an unbounded retry loop'
                });
            }
        });
    };

    try {
        await assert.rejects(backendApi.dropView('changing_view'), /changed repeatedly/i);
        assert.ok(dropAttempts > 0 && dropAttempts < 5);
        assert.strictEqual(confirmations.length, dropAttempts);
    } finally {
        (globalThis as any).window.parent.postMessage = originalPostMessage;
    }
});

it('uses a plain confirmation when a demo view has no triggers', async () => {
    const webApiModulePath = '../../core/ui/modules/web-api.js';
    const { backendApi, handleRpcResponse } = await import(webApiModulePath);
    const definition = {
        sql: 'CREATE VIEW plain_demo_view AS SELECT 1 AS value',
        triggers: []
    };

    confirmResult = true;
    const dropPromise = backendApi.dropView('plain_demo_view');
    const lookup = await requirePostedMessageAfterTurn(0);
    assert.strictEqual(lookup.content.targetMethod, 'getViewDefinition');
    handleRpcResponse({
        kind: 'response',
        messageId: lookup.content.messageId,
        success: true,
        data: definition
    });

    const request = await waitForPostedMessage(1);
    assert.strictEqual(confirmations.length, 1);
    assert.match(confirmations[0], /plain_demo_view/);
    assert.doesNotMatch(confirmations[0], /trigger/i);
    assert.strictEqual(request.content.targetMethod, 'dropView');
    assert.deepStrictEqual(request.content.payload, [
        'plain_demo_view',
        definition.sql,
        definition.triggers
    ]);
    handleRpcResponse({
        kind: 'response',
        messageId: request.content.messageId,
        success: true,
        data: { dropped: true }
    });
    assert.deepStrictEqual(await dropPromise, { dropped: true });
});

it('confirms exact dependent-index definitions before a demo column deletion', async () => {
    const webApiModulePath = '../../core/ui/modules/web-api.js';
    const { backendApi, handleRpcResponse } = await import(webApiModulePath);
    const dependencies = [{
        identifier: 'demo_removed_idx',
        sql: 'CREATE INDEX demo_removed_idx ON demo_rows(removed)'
    }];

    const cancelledDelete = backendApi.deleteColumns('demo_rows', ['removed']);
    const cancelledLookup = await waitForPostedMessage(0);
    assert.strictEqual(cancelledLookup.content.targetMethod, 'findDependentIndexes');
    handleRpcResponse({
        kind: 'response',
        messageId: cancelledLookup.content.messageId,
        success: true,
        data: dependencies
    });

    assert.deepStrictEqual(await cancelledDelete, { cancelled: true });
    assert.strictEqual(postedMessages.length, 1);
    assert.match(confirmations[0], /demo_removed_idx/);
    assert.match(confirmations[0], /permanently/i);

    confirmResult = true;
    const acceptedDelete = backendApi.deleteColumns('demo_rows', ['removed']);
    const acceptedLookup = await waitForPostedMessage(1);
    assert.strictEqual(acceptedLookup.content.targetMethod, 'findDependentIndexes');
    handleRpcResponse({
        kind: 'response',
        messageId: acceptedLookup.content.messageId,
        success: true,
        data: dependencies
    });

    const deleteRequest = await waitForPostedMessage(2);
    assert.strictEqual(deleteRequest.content.targetMethod, 'deleteColumns');
    assert.deepStrictEqual(deleteRequest.content.payload, [
        'demo_rows',
        ['removed'],
        dependencies
    ]);
    handleRpcResponse({
        kind: 'response',
        messageId: deleteRequest.content.messageId,
        success: true
    });
    assert.strictEqual(await acceptedDelete, undefined);
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
        data: {
            triggers: [{
                identifier: 'demo_insert',
                sql: 'CREATE TRIGGER demo_insert'
            }]
        }
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

it('guards the exact current demo triggers named by the discard confirmation', async () => {
    const webApiModulePath = '../../core/ui/modules/web-api.js';
    const { backendApi, handleRpcResponse } = await import(webApiModulePath);
    const staleTriggers = [{
        identifier: 'demo_insert',
        sql: 'CREATE TRIGGER demo_insert AS SELECT 1'
    }];
    const currentTriggers = [
        ...staleTriggers,
        {
            identifier: 'demo_update',
            sql: 'CREATE TRIGGER demo_update AS SELECT 2'
        }
    ];
    confirmResult = true;

    const edit = backendApi.editView(
        'demo_view',
        'SELECT 2 AS value',
        false,
        'CREATE VIEW demo_view AS SELECT 1 AS value',
        staleTriggers
    );
    const lookup = await waitForPostedMessage(0);
    handleRpcResponse({
        kind: 'response',
        messageId: lookup.content.messageId,
        success: true,
        data: { triggers: currentTriggers }
    });

    const editRequest = await waitForPostedMessage(1);
    assert.deepStrictEqual(editRequest.content.payload[4], currentTriggers);
    handleRpcResponse({
        kind: 'response',
        messageId: editRequest.content.messageId,
        success: true,
        data: { updated: true }
    });
    assert.deepStrictEqual(await edit, { updated: true });
});
