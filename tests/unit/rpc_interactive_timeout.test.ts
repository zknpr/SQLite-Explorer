import './vscode_mock_setup';

import { after, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const extensionMessages: any[] = [];
const webMessages: any[] = [];
const webTargetOrigins: string[] = [];

(globalThis as any).acquireVsCodeApi = () => ({
    getState: () => undefined,
    setState: () => undefined,
    postMessage: (message: any) => extensionMessages.push(message)
});
(globalThis as any).window = {
    parent: {
        postMessage: (message: any, targetOrigin: string) => {
            webMessages.push(message);
            webTargetOrigins.push(targetOrigin);
        }
    },
    location: { ancestorOrigins: ['https://embedding.example'], origin: 'https://demo.sqlite-explorer.test' },
    addEventListener() {}
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
            'updateCell',
            'updateCellBatch',
            'confirmLargeChanges',
            'confirmLargeSelection',
            'openCellEditor',
            'prepareCellMediaPreview',
            'exportDb',
            'refreshFile',
            'saveFile',
            'selectFile',
            'exportTable',
            'showInformationToast',
            'showWarningToast',
            'showErrorToast'
        ]) {
            assert.strictEqual(shared.getRpcTimeoutMs(method), undefined, method);
            assert.strictEqual(extensionApi.getRpcTimeoutMs(method), undefined, method);
            assert.strictEqual(webApi.getRpcTimeoutMs(method), undefined, method);
        }

        const extensionPromise = extensionApi.sendRpcRequest('saveFile', [
            'slow-dialog.bin',
            new Uint8Array([1, 2, 3])
        ]);
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

it('keeps every HostBridge method that opens a modal unbounded', async () => {
    const sharedModulePath = '../../core/ui/modules/rpc-constants.js';
    const shared = await import(sharedModulePath);
    const hostBridgeSource = readFileSync(
        new URL('../../src/hostBridge.ts', import.meta.url),
        'utf8'
    );
    const sourceFile = ts.createSourceFile(
        'hostBridge.ts',
        hostBridgeSource,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    );
    const hostBridgeClass = sourceFile.statements.find(
        statement => ts.isClassDeclaration(statement) && statement.name?.text === 'HostBridge'
    );
    assert.ok(hostBridgeClass && ts.isClassDeclaration(hostBridgeClass));

    const modalMethods = hostBridgeClass.members
        .filter(ts.isMethodDeclaration)
        .filter(method => {
            let opensModal = false;
            const visit = (node: ts.Node) => {
                if (
                    ts.isPropertyAssignment(node)
                    && node.name.getText(sourceFile) === 'modal'
                    && node.initializer.kind === ts.SyntaxKind.TrueKeyword
                ) {
                    opensModal = true;
                    return;
                }
                ts.forEachChild(node, visit);
            };
            visit(method);
            return opensModal;
        })
        .map(method => method.name.getText(sourceFile));

    assert.ok(modalMethods.length > 0, 'HostBridge modal-method audit unexpectedly found no methods');
    for (const method of modalMethods) {
        assert.strictEqual(shared.getRpcTimeoutMs(method), undefined, method);
    }
});

it('targets the embedding origin without ever using a wildcard', async () => {
    const webApiModulePath = '../../core/ui/modules/web-api.js';
    const webApi = await import(webApiModulePath);
    webApi.sendRpcResult('ancestor', { ok: true });
    assert.strictEqual(webTargetOrigins.at(-1), 'https://embedding.example');
    assert.ok(!webTargetOrigins.includes('*'));
});
