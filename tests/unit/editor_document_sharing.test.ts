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
let activeEngineKind: 'native' | 'wasm' = 'native';
const undoneLabels: string[] = [];
const redoneLabels: string[] = [];

const engines: DatabaseOperations[] = [];

function createEngine(): DatabaseOperations {
    const engine = {
        engineKind: Promise.resolve(activeEngineKind),
        executeQuery: async () => {
            queryCount++;
            return [{ headers: ['value'], rows: [[1]] }];
        },
        undoModification: async (modification: LabeledModification) => {
            undoneLabels.push(modification.label);
        },
        redoModification: async (modification: LabeledModification) => {
            redoneLabels.push(modification.label);
        },
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
    undoneLabels.length = 0;
    redoneLabels.length = 0;
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

it('releases per-document theme and configuration listeners when the document closes', async () => {
    const originalThemeListener = (mockVscode.window as any).onDidChangeActiveColorTheme;
    const originalConfigurationListener = (mockVscode.workspace as any).onDidChangeConfiguration;
    let disposedListeners = 0;
    const countedDisposable = () => ({
        dispose() { disposedListeners++; }
    });
    (mockVscode.window as any).onDidChangeActiveColorTheme = countedDisposable;
    (mockVscode.workspace as any).onDidChangeConfiguration = countedDisposable;

    const provider = createProvider('sqlite-explorer.view');
    const document = await provider.openCustomDocument(
        fileUri('/workspace/listener-lifetime.sqlite'),
        openContext
    );
    try {
        await document.dispose();
        assert.strictEqual(
            disposedListeners,
            2,
            'global listeners must follow the document lifetime, not the extension-provider lifetime'
        );
    } finally {
        provider.dispose();
        (mockVscode.window as any).onDidChangeActiveColorTheme = originalThemeListener;
        (mockVscode.workspace as any).onDidChangeConfiguration = originalConfigurationListener;
    }
});

it('keeps duplicate view-type undo entries synchronized with one shared history', async () => {
    const defaultProvider = createProvider('sqlite-explorer.view');
    const optionalProvider = createProvider('sqlite-explorer.option');
    const uri = fileUri('/workspace/shared-undo.sqlite');
    const document = await defaultProvider.openCustomDocument(uri, openContext);
    const optionalDocument = await optionalProvider.openCustomDocument(uri, openContext);
    const hostStack: Array<{
        provider: 'default' | 'optional';
        label: string | undefined;
        undo: () => any;
        redo: () => any;
    }> = [];

    defaultProvider.onDidChangeCustomDocument(event => {
        hostStack.push({
            provider: 'default',
            label: event.label,
            undo: event.undo,
            redo: event.redo
        });
    });
    optionalProvider.onDidChangeCustomDocument(event => {
        hostStack.push({
            provider: 'optional',
            label: event.label,
            undo: event.undo,
            redo: event.redo
        });
    });

    const firstModification: LabeledModification = {
        label: 'First edit',
        description: 'First shared edit history entry',
        modificationType: 'cell_update',
        targetTable: 'items',
        targetRowId: 1,
        targetColumn: 'value',
        priorValue: 'original',
        newValue: 'first-edit'
    };
    const secondModification: LabeledModification = {
        ...firstModification,
        label: 'Second edit',
        description: 'Second shared edit history entry',
        priorValue: 'first-edit',
        newValue: 'second-edit'
    };

    try {
        assert.strictEqual(document, optionalDocument);
        document.recordExternalModification(firstModification);
        document.recordExternalModification(secondModification);

        // VS Code 1.110 creates one custom-document model per viewType, but
        // keys both models' undo elements by this same resource URI.
        assert.deepStrictEqual(
            hostStack.map(event => [event.provider, event.label]),
            [
                ['default', 'First edit'],
                ['optional', 'First edit'],
                ['default', 'Second edit'],
                ['optional', 'Second edit']
            ]
        );

        await hostStack[3].undo();
        assert.deepStrictEqual(undoneLabels, ['Second edit']);

        // The next global host entry names the same logical edit through the
        // other viewType. It must not advance the shared tracker to First edit.
        await hostStack[2].undo();
        assert.deepStrictEqual(undoneLabels, ['Second edit']);

        await hostStack[1].undo();
        assert.deepStrictEqual(undoneLabels, ['Second edit', 'First edit']);

        // Drain the other model's duplicate First edit so both VS Code model
        // cursors agree that the shared document is back at its initial state.
        await hostStack[0].undo();
        assert.deepStrictEqual(undoneLabels, ['Second edit', 'First edit']);

        await hostStack[0].redo();
        await hostStack[1].redo();
        await hostStack[2].redo();
        await hostStack[3].redo();
        assert.deepStrictEqual(redoneLabels, ['First edit', 'Second edit']);
    } finally {
        await document.dispose();
        await optionalDocument.dispose();
        defaultProvider.dispose();
        optionalProvider.dispose();
    }
});

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

it('tracks active panels on the shared document across view types and disposal', async () => {
    activeEngineKind = 'wasm';
    (mockVscode.workspace as any)._config.set('instantCommit', 'always');
    const defaultProvider = createProvider('sqlite-explorer.view');
    const optionalProvider = createProvider('sqlite-explorer.option');
    const uri = fileUri('/workspace/shared-active.sqlite');
    const document = await defaultProvider.openCustomDocument(uri, openContext);
    const optionalDocument = await optionalProvider.openCustomDocument(uri, openContext);
    const originalExecuteCommand = mockVscode.commands.executeCommand;
    let saveCount = 0;
    mockVscode.commands.executeCommand = async (command: string) => {
        if (command === 'workbench.action.files.save') saveCount++;
    };

    function createTrackedPanel(initiallyActive: boolean) {
        const viewStateListeners: Array<(event: any) => void> = [];
        const disposeListeners: Array<() => void> = [];
        const webview = {
            cspSource: '',
            options: {},
            html: '',
            postMessage: async () => true,
            onDidReceiveMessage: () => noOpDisposable,
            asWebviewUri: (value: unknown) => value
        };
        const panel: any = {
            active: initiallyActive,
            visible: true,
            webview,
            onDidChangeViewState(listener: (event: any) => void) {
                viewStateListeners.push(listener);
                return noOpDisposable;
            },
            onDidDispose(listener: () => void) {
                disposeListeners.push(listener);
                return noOpDisposable;
            }
        };
        return {
            panel,
            setActive(active: boolean) {
                panel.active = active;
                for (const listener of viewStateListeners) listener({ webviewPanel: panel });
            },
            dispose() {
                for (const listener of disposeListeners) listener();
            }
        };
    }

    const activePanel = createTrackedPanel(true);
    const inactivePanel = createTrackedPanel(false);
    const modification: LabeledModification = {
        label: 'Active panel edit',
        description: 'Exercise shared active-panel auto-save state',
        modificationType: 'cell_update',
        targetTable: 'items',
        targetRowId: 1,
        targetColumn: 'value',
        priorValue: 'before',
        newValue: 'after'
    };
    const recordAndFlush = async (label: string) => {
        document.recordExternalModification({ ...modification, label });
        await new Promise(resolve => setImmediate(resolve));
    };

    try {
        assert.strictEqual(document, optionalDocument);
        await defaultProvider.resolveCustomEditor(document, activePanel.panel, {} as any);
        await optionalProvider.resolveCustomEditor(document, inactivePanel.panel, {} as any);
        const bridge = {
            updateColorScheme: async () => {},
            updateCellEditBehavior: async () => {},
            refreshContent: async () => {}
        };
        defaultProvider.webviewBridges.set(activePanel.panel, bridge);
        optionalProvider.webviewBridges.set(inactivePanel.panel, bridge);

        await recordAndFlush('active despite inactive sibling');
        assert.strictEqual(saveCount, 1);

        inactivePanel.setActive(true);
        activePanel.setActive(false);
        await recordAndFlush('second view remains active');
        assert.strictEqual(saveCount, 2);

        activePanel.dispose();
        await recordAndFlush('disposing inactive sibling preserves active view');
        assert.strictEqual(saveCount, 3);

        inactivePanel.dispose();
        await recordAndFlush('no active panels');
        assert.strictEqual(saveCount, 3);
        assert.strictEqual(document.hasPendingSave, true);
    } finally {
        mockVscode.commands.executeCommand = originalExecuteCommand;
        (mockVscode.workspace as any)._config.set('instantCommit', 'never');
        await document.dispose();
        await optionalDocument.dispose();
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

it('keeps non-file documents with the same path but different queries distinct', async () => {
    const provider = createProvider('sqlite-explorer.view');
    const makeUri = (revision: string) => ({
        ...fileUri('/workspace/revisioned.sqlite'),
        scheme: 'memfs',
        authority: 'host',
        // A shared trailing query path defeats the old key's accidental use of
        // the URI string's final filename segment, exposing the hash collision.
        query: `rev=${revision}/snapshot`,
        fragment: '',
        toString: () => `memfs://host/workspace/revisioned.sqlite?rev=${revision}/snapshot`
    }) as Uri;
    const first = await provider.openCustomDocument(makeUri('a'), openContext);
    const second = await provider.openCustomDocument(makeUri('b'), openContext);

    try {
        const [firstKey, secondKey] = await Promise.all([
            first.documentKey,
            second.documentKey
        ]);
        assert.notStrictEqual(first, second);
        assert.notStrictEqual(first.databaseOperations, second.databaseOperations);
        assert.notStrictEqual(firstKey, secondKey);
        assert.strictEqual(connectionCount, 2);
    } finally {
        await first.dispose();
        await second.dispose();
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
                readOnly: false,
                connectionGeneration: 0
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
