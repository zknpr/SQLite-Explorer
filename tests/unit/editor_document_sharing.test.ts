import './vscode_mock_setup';

import assert from 'node:assert';
import { after, before, beforeEach, it } from 'node:test';

import { mockVscode } from './mocks/vscode';
import type { DatabaseOperations, LabeledModification } from '../../src/core/types';
import type { CustomDocumentOpenContext, Uri } from 'vscode';

const moduleCache = require('module')._cache as Record<string, NodeModule | undefined>;
const workerFactoryPath = require.resolve('../../src/workerFactory');
const databaseModelPath = require.resolve('../../src/databaseModel');
const editorControllerPath = require.resolve('../../src/editorController');
const originalWorkerFactory = moduleCache[workerFactoryPath];

let connectionCount = 0;
let workerDisposalCount = 0;
let queryCount = 0;
let undoCount = 0;
let activeEngineKind: 'native' | 'wasm' = 'native';

const engines: DatabaseOperations[] = [];

function createEngine(): DatabaseOperations {
    const engine = {
        engineKind: Promise.resolve(activeEngineKind),
        executeQuery: async () => {
            queryCount++;
            return [{ headers: ['value'], rows: [[1]] }];
        },
        undoModification: async () => { undoCount++; },
        redoModification: async () => {},
        applyModifications: async () => {},
        discardModifications: async () => {}
    } as unknown as DatabaseOperations;
    engines.push(engine);
    return engine;
}

moduleCache[workerFactoryPath] = {
    id: workerFactoryPath,
    filename: workerFactoryPath,
    loaded: true,
    exports: {
        createDatabaseConnection: async () => {
            connectionCount++;
            const databaseOps = createEngine();
            return {
                establishConnection: async () => ({ databaseOps, isReadOnly: false }),
                workerMethods: {
                    [Symbol.dispose]: () => { workerDisposalCount++; }
                }
            };
        }
    }
} as NodeModule;
delete moduleCache[databaseModelPath];
delete moduleCache[editorControllerPath];

const { DocumentRegistry } = require('../../src/documentRegistry') as typeof import('../../src/documentRegistry');
const {
    DatabaseEditorProvider
} = require('../../src/editorController') as typeof import('../../src/editorController');

const noOpDisposable = { dispose() {} };
const fileUri = (value: string) => mockVscode.Uri.file(value) as unknown as Uri;
const openContext: CustomDocumentOpenContext = {
    backupId: undefined,
    untitledDocumentData: undefined
};
const context = {
    extensionUri: fileUri('/extension'),
    globalState: { get: () => undefined }
} as any;

before(() => {
    (mockVscode.window as any).onDidChangeActiveColorTheme = () => noOpDisposable;
    (mockVscode.window as any).activeColorTheme = { kind: mockVscode.ColorThemeKind.Dark };
    (mockVscode.workspace as any).onDidChangeConfiguration = () => noOpDisposable;
    (mockVscode.workspace as any)._config.set('instantCommit', 'never');
});

beforeEach(() => {
    DocumentRegistry.clear();
    connectionCount = 0;
    workerDisposalCount = 0;
    queryCount = 0;
    undoCount = 0;
    activeEngineKind = 'native';
    engines.length = 0;
});

after(() => {
    DocumentRegistry.clear();
    if (originalWorkerFactory) moduleCache[workerFactoryPath] = originalWorkerFactory;
    else delete moduleCache[workerFactoryPath];
    delete moduleCache[databaseModelPath];
    delete moduleCache[editorControllerPath];
});

function createProvider(viewType: string, outputChannel: any = null) {
    return new DatabaseEditorProvider(
        viewType,
        context,
        undefined,
        outputChannel,
        true
    );
}

function createPanel() {
    return {
        onDidDispose: () => noOpDisposable
    } as any;
}

it('shares one document, engine, and edit history across both editor view types until the last close', async () => {
    const defaultProvider = createProvider('sqlite-explorer.view');
    const optionalProvider = createProvider('sqlite-explorer.option');
    const uri = fileUri('/workspace/shared.sqlite');
    const first = await defaultProvider.openCustomDocument(uri, openContext);
    const key = await first.documentKey;
    const second = await optionalProvider.openCustomDocument(uri, openContext);
    await second.documentKey;

    try {
        // This single assertion is deliberately diagnostic: before the fix it
        // reports two connections, two documents/engines, and registry clobber.
        assert.deepStrictEqual(
            {
                connectionCount,
                sharedDocument: first === second,
                sharedEngine: first.databaseOperations === second.databaseOperations,
                registryStillOwnsFirst: DocumentRegistry.get(key) === first
            },
            {
                connectionCount: 1,
                sharedDocument: true,
                sharedEngine: true,
                registryStillOwnsFirst: true
            }
        );

        let undo: (() => any) | undefined;
        optionalProvider.onDidChangeCustomDocument(event => { undo = event.undo; });
        const modification: LabeledModification = {
            label: 'Shared edit',
            description: 'Shared edit history entry',
            modificationType: 'cell_update',
            targetTable: 'items',
            targetRowId: 1,
            targetColumn: 'value',
            priorValue: 'before',
            newValue: 'after'
        };
        first.recordExternalModification(modification);
        assert.ok(undo, 'the second provider must observe the shared document history');
        await undo();
        assert.strictEqual(undoCount, 1);

        const panels = [createPanel(), createPanel(), createPanel()];
        const refreshCounts = [0, 0, 0];
        defaultProvider.webviews.add(uri, panels[0], 'default-one');
        defaultProvider.webviews.add(uri, panels[1], 'default-two');
        optionalProvider.webviews.add(uri, panels[2], 'optional-one');
        defaultProvider.webviewBridges.set(panels[0], {
            updateColorScheme: async () => {},
            updateCellEditBehavior: async () => {},
            refreshContent: async () => { refreshCounts[0]++; }
        });
        defaultProvider.webviewBridges.set(panels[1], {
            updateColorScheme: async () => {},
            updateCellEditBehavior: async () => {},
            refreshContent: async () => { refreshCounts[1]++; }
        });
        optionalProvider.webviewBridges.set(panels[2], {
            updateColorScheme: async () => {},
            updateCellEditBehavior: async () => {},
            refreshContent: async () => { refreshCounts[2]++; }
        });

        first.recordExternalModification({ ...modification, label: 'Broadcast edit' });
        await new Promise(resolve => setImmediate(resolve));
        assert.deepStrictEqual(
            refreshCounts,
            [1, 1, 1],
            'both same-view panels and the optional-view panel must refresh once'
        );

        await first.dispose();
        assert.strictEqual(workerDisposalCount, 0);
        assert.strictEqual(DocumentRegistry.get(key), second);
        await second.databaseOperations.executeQuery('SELECT 1');
        assert.strictEqual(queryCount, 1, 'the remaining editor must retain a live engine');

        await second.dispose();
        assert.strictEqual(workerDisposalCount, 1);
        assert.strictEqual(DocumentRegistry.has(key), false);
    } finally {
        // dispose() is idempotent after both provider references have closed.
        await first.dispose();
        await second.dispose();
        defaultProvider.dispose();
        optionalProvider.dispose();
    }
});

it('coalesces simultaneous opens for one URI before either engine is registered', async () => {
    const defaultProvider = createProvider('sqlite-explorer.view');
    const optionalProvider = createProvider('sqlite-explorer.option');
    const uri = fileUri('/workspace/simultaneous.sqlite');

    const [first, second] = await Promise.all([
        defaultProvider.openCustomDocument(uri, openContext),
        optionalProvider.openCustomDocument(uri, openContext)
    ]);

    try {
        assert.strictEqual(first, second);
        assert.strictEqual(connectionCount, 1);
    } finally {
        await first.dispose();
        await second.dispose();
        defaultProvider.dispose();
        optionalProvider.dispose();
    }
});

it('keeps documents with the same path but different URI schemes distinct', async () => {
    const provider = createProvider('sqlite-explorer.view');
    const localUri = fileUri('/workspace/collision.sqlite');
    const remoteUri = {
        ...fileUri('/workspace/collision.sqlite'),
        scheme: 'vscode-remote',
        authority: 'ssh-remote+dev',
        toString: () => 'vscode-remote://ssh-remote+dev/workspace/collision.sqlite'
    } as Uri;
    const local = await provider.openCustomDocument(localUri, openContext);
    const remote = await provider.openCustomDocument(remoteUri, openContext);

    try {
        const [localKey, remoteKey] = await Promise.all([
            local.documentKey,
            remote.documentKey
        ]);
        assert.notStrictEqual(local, remote);
        assert.notStrictEqual(local.databaseOperations, remote.databaseOperations);
        assert.notStrictEqual(localKey, remoteKey);
        assert.strictEqual(connectionCount, 2);
        assert.strictEqual(DocumentRegistry.get(localKey), local);
        assert.strictEqual(DocumentRegistry.get(remoteKey), remote);
    } finally {
        await local.dispose();
        await remote.dispose();
        provider.dispose();
    }
});

it('binds optional-view RPC to the provider that owns its webview panel', async () => {
    const defaultProvider = createProvider('sqlite-explorer.view');
    const optionalProvider = createProvider('sqlite-explorer.option');
    const uri = fileUri('/workspace/provider-bridge.sqlite');
    const first = await defaultProvider.openCustomDocument(uri, openContext);
    const second = await optionalProvider.openCustomDocument(uri, openContext);
    let receiveMessage: ((message: unknown) => void) | undefined;
    const posted: any[] = [];
    const webview = {
        cspSource: '',
        options: {},
        html: '',
        postMessage: async (message: unknown) => { posted.push(message); },
        onDidReceiveMessage: (listener: (message: unknown) => void) => {
            receiveMessage = listener;
            return noOpDisposable;
        },
        asWebviewUri: (value: unknown) => value
    };
    const panel = {
        webview,
        active: true,
        visible: true,
        onDidChangeViewState: () => noOpDisposable,
        onDidDispose: () => noOpDisposable
    } as any;

    try {
        assert.strictEqual(first, second);
        await optionalProvider.resolveCustomEditor(second, panel, {} as any);
        assert.ok(receiveMessage);
        receiveMessage({
            channel: 'rpc',
            content: {
                kind: 'invoke',
                messageId: 'initialize-optional',
                targetMethod: 'initialize',
                payload: []
            }
        });
        await new Promise(resolve => setImmediate(resolve));

        const response = posted.find(message => (
            message?.channel === 'rpc' &&
            message?.content?.messageId === 'initialize-optional'
        ));
        assert.deepStrictEqual(response?.content, {
            kind: 'response',
            messageId: 'initialize-optional',
            success: true,
            data: {
                connected: true,
                filename: 'provider-bridge.sqlite',
                readOnly: false
            }
        });
    } finally {
        await first.dispose();
        await second.dispose();
        defaultProvider.dispose();
        optionalProvider.dispose();
    }
});

it('reports native write-through once when instantCommit resolves to manual save', async () => {
    const messages: string[] = [];
    const outputChannel = { appendLine: (message: string) => { messages.push(message); } };
    const provider = createProvider('sqlite-explorer.view', outputChannel);

    try {
        for (const setting of ['never', 'remote-only']) {
            (mockVscode.workspace as any)._config.set('instantCommit', setting);
            const document = await provider.openCustomDocument(
                fileUri(`/workspace/native-${setting}.sqlite`),
                openContext
            );
            await document.dispose();
        }

        assert.strictEqual(messages.length, 2);
        for (const message of messages) {
            assert.match(message, /native backend.*written.*immediately.*WASM backend/i);
        }

        (mockVscode.workspace as any)._config.set('instantCommit', 'always');
        const automatic = await provider.openCustomDocument(
            fileUri('/workspace/native-always.sqlite'),
            openContext
        );
        await automatic.dispose();
        assert.strictEqual(messages.length, 2, 'native always mode does not need a warning note');

        activeEngineKind = 'wasm';
        (mockVscode.workspace as any)._config.set('instantCommit', 'never');
        const wasm = await provider.openCustomDocument(
            fileUri('/workspace/wasm-never.sqlite'),
            openContext
        );
        await wasm.dispose();
        assert.strictEqual(messages.length, 2, 'WASM manual-save semantics stay unchanged and silent');
    } finally {
        (mockVscode.workspace as any)._config.set('instantCommit', 'never');
        provider.dispose();
    }
});
