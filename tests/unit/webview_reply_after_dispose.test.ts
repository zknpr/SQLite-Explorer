import './vscode_mock_setup';

import assert from 'node:assert';
import { after, afterEach, before, beforeEach, it } from 'node:test';

import { mockVscode } from './mocks/vscode';
import { createDeferred, type Deferred } from './helpers/deferred';
import type { CustomDocumentOpenContext, Uri } from 'vscode';

const moduleCache = require('module')._cache as Record<string, NodeModule | undefined>;
const workerFactoryPath = require.resolve('../../src/workerFactory');
const databaseModelPath = require.resolve('../../src/databaseModel');
const editorControllerPath = require.resolve('../../src/editorController');
const originalWorkerFactory = moduleCache[workerFactoryPath];

// The request in flight: setPragma reaches the engine and waits for the test.
let pragmaCalls: Array<[string, unknown]> = [];
let pragmaResult: Deferred<void>;

moduleCache[workerFactoryPath] = {
    id: workerFactoryPath,
    filename: workerFactoryPath,
    loaded: true,
    exports: {
        createDatabaseConnection: async () => {
            const databaseOps = {
                engineKind: Promise.resolve('native'),
                executeQuery: async () => [],
                setPragma: async (pragma: string, value: unknown) => {
                    pragmaCalls.push([pragma, value]);
                    await pragmaResult.promise;
                }
            };
            return {
                establishConnection: async () => ({ databaseOps, isReadOnly: false }),
                workerMethods: { [Symbol.dispose]: () => {} }
            };
        }
    }
} as NodeModule;
delete moduleCache[databaseModelPath];
delete moduleCache[editorControllerPath];

const { DocumentRegistry } = require('../../src/documentRegistry') as typeof import('../../src/documentRegistry');
const { DatabaseEditorProvider } = require('../../src/editorController') as typeof import('../../src/editorController');

const noOpDisposable = { dispose() {} };
const openContext: CustomDocumentOpenContext = { backupId: undefined, untitledDocumentData: undefined };
const context = { extensionUri: mockVscode.Uri.file('/extension'), globalState: { get: () => undefined } } as any;

// node:test also fails the running test on an unhandled rejection; this list
// names the rejection in the assertion message.
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
let notifications: string[] = [];
const originalNotifications = {
    showErrorMessage: mockVscode.window.showErrorMessage,
    showWarningMessage: mockVscode.window.showWarningMessage,
    showInformationMessage: mockVscode.window.showInformationMessage
};

before(() => {
    (mockVscode.window as any).onDidChangeActiveColorTheme = () => noOpDisposable;
    (mockVscode.window as any).activeColorTheme = { kind: mockVscode.ColorThemeKind.Dark };
    (mockVscode.workspace as any).onDidChangeConfiguration = () => noOpDisposable;
    process.on('unhandledRejection', onUnhandled);
    for (const name of Object.keys(originalNotifications) as Array<keyof typeof originalNotifications>) {
        (mockVscode.window as any)[name] = async (message: string) => { notifications.push(String(message)); };
    }
});

beforeEach(() => {
    DocumentRegistry.clear();
    pragmaCalls = [];
    pragmaResult = createDeferred<void>();
    unhandled = [];
    notifications = [];
});

afterEach(() => DocumentRegistry.clear());

after(() => {
    process.off('unhandledRejection', onUnhandled);
    Object.assign(mockVscode.window, originalNotifications);
    if (originalWorkerFactory) moduleCache[workerFactoryPath] = originalWorkerFactory;
    else delete moduleCache[workerFactoryPath];
    delete moduleCache[databaseModelPath];
    delete moduleCache[editorControllerPath];
});

/**
 * A panel that behaves like VS Code's after it closes: its listeners have run
 * and reading `webview` throws "Webview is disposed".
 */
function createPanel(postMessage: (message: unknown) => Promise<boolean>) {
    let receive: ((message: unknown) => void) | undefined;
    const disposeListeners: Array<() => void> = [];
    let disposed = false;
    let webviewReadsAfterDispose = 0;
    const webview = {
        cspSource: '',
        options: {},
        html: '',
        postMessage,
        onDidReceiveMessage: (listener: (message: unknown) => void) => { receive = listener; return noOpDisposable; },
        asWebviewUri: (value: unknown) => value
    };
    const panel = {
        get webview() {
            if (disposed) {
                webviewReadsAfterDispose++;
                throw new Error('Webview is disposed');
            }
            return webview;
        },
        active: true,
        visible: true,
        onDidChangeViewState: () => noOpDisposable,
        onDidDispose: (listener: () => void) => { disposeListeners.push(listener); return noOpDisposable; }
    };
    return {
        panel: panel as any,
        send: (message: unknown) => receive!(message),
        dispose: () => { disposed = true; for (const listener of disposeListeners) listener(); },
        get webviewReadsAfterDispose() { return webviewReadsAfterDispose; }
    };
}

async function openPanel(postMessage: (message: unknown) => Promise<boolean>) {
    const lines: string[] = [];
    const provider = new DatabaseEditorProvider(
        'sqlite-explorer.view', context, undefined, { appendLine: (line: string) => lines.push(line) } as any, true
    );
    const document = await provider.openCustomDocument(mockVscode.Uri.file('/workspace/reply.sqlite') as unknown as Uri, openContext);
    const fake = createPanel(postMessage);
    await provider.resolveCustomEditor(document, fake.panel, {} as any);
    return {
        ...fake,
        webviewLines: () => lines.filter(line => line.startsWith('[Webview]')),
        close: async () => { await document.dispose(); provider.dispose(); }
    };
}

function invokeSetPragma(send: (message: unknown) => void, messageId: string) {
    send({
        channel: 'rpc',
        content: { kind: 'invoke', messageId, targetMethod: 'setPragma', payload: ['cache_size', 4096] }
    });
}

/** Let the reply chain run and Node report any rejection left unhandled. */
async function settle() {
    for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve));
}

for (const outcome of ['result', 'error'] as const) {
    it(`drops the reply to a request that settles with ${outcome === 'result' ? 'a result' : 'an error'} after its panel closed`, async () => {
        const posted: unknown[] = [];
        const opened = await openPanel(async message => { posted.push(message); return true; });
        try {
            invokeSetPragma(opened.send, `in-flight-${outcome}`);
            await settle();
            assert.deepStrictEqual(pragmaCalls, [['cache_size', 4096]], 'the request reached the engine');

            opened.dispose();
            if (outcome === 'result') pragmaResult.resolve();
            else pragmaResult.reject(new Error('engine refused the PRAGMA'));
            await settle();

            assert.deepStrictEqual(unhandled.map(reason => String(reason)), []);
            assert.strictEqual(opened.webviewReadsAfterDispose, 0, 'nothing may be sent to the closed webview');
            assert.deepStrictEqual(posted, []);
            assert.deepStrictEqual(pragmaCalls, [['cache_size', 4096]], 'the request ran once and was not repeated');
            assert.strictEqual(opened.webviewLines().length, 1);
            assert.deepStrictEqual(notifications, []);
        } finally {
            await opened.close();
        }
    });
}

it('logs one line however many replies a closed panel drops', async () => {
    const opened = await openPanel(async () => true);
    try {
        invokeSetPragma(opened.send, 'first');
        invokeSetPragma(opened.send, 'second');
        await settle();
        opened.dispose();
        pragmaResult.resolve();
        await settle();
        assert.deepStrictEqual(unhandled, []);
        assert.strictEqual(pragmaCalls.length, 2);
        assert.strictEqual(opened.webviewLines().length, 1);
    } finally {
        await opened.close();
    }
});

it('still sends a live panel the failure when its reply cannot be posted', async () => {
    const posted: unknown[] = [];
    let posts = 0;
    const opened = await openPanel(async message => {
        if (++posts === 1) throw new Error('live post failed');
        posted.push(message);
        return true;
    });
    try {
        invokeSetPragma(opened.send, 'live');
        pragmaResult.resolve();
        await settle();
        assert.deepStrictEqual(posted, [{
            channel: 'rpc',
            content: { kind: 'response', messageId: 'live', success: false, errorMessage: 'live post failed' }
        }]);
        assert.deepStrictEqual(unhandled, []);
        assert.strictEqual(opened.webviewLines().length, 0);
    } finally {
        await opened.close();
    }
});
