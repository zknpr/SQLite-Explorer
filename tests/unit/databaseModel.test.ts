import './vscode_mock_setup';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mockVscode } from './mocks/vscode';

// Setup environment definitions that match VS Code ExtensionKind
(mockVscode as any).ExtensionKind = { Workspace: 2, UI: 1 };
mockVscode.env.remoteName = 'remote';
(mockVscode as any).extensions = {
    getExtension: () => ({ extensionKind: 2 })
};

describe('isAutoCommitEnabled', () => {
    let originalGetConfiguration: any;
    let configMap: Map<string, any>;
    let originalGetExtension: any;
    let originalRemoteName: any;

    before(async () => {
        originalGetConfiguration = mockVscode.workspace.getConfiguration;
        originalGetExtension = (mockVscode as any).extensions?.getExtension;
        originalRemoteName = mockVscode.env.remoteName;

        configMap = new Map();
        mockVscode.workspace.getConfiguration = () => ({
            get: (key: string, defaultVal: any) => configMap.has(key) ? configMap.get(key) : defaultVal,
            update: () => Promise.resolve()
        });

        // Mock workerFactory so it doesn't load threadPool and crash due to import.meta.env inside node test runner
        const moduleCache = require('module')._cache;
        const workerFactoryPath = require.resolve('../../src/workerFactory');
        moduleCache[workerFactoryPath] = {
            id: workerFactoryPath,
            filename: workerFactoryPath,
            loaded: true,
            exports: {
                createDatabaseConnection: () => {}
            }
        };
    });

    after(() => {
        mockVscode.workspace.getConfiguration = originalGetConfiguration;
        if ((mockVscode as any).extensions) {
            (mockVscode as any).extensions.getExtension = originalGetExtension;
        }
        mockVscode.env.remoteName = originalRemoteName;
    });

    beforeEach(() => {
        configMap.clear();
        mockVscode.workspace.getConfiguration = () => ({
            get: (key: string, defaultVal: any) => configMap.has(key) ? configMap.get(key) : defaultVal,
            update: () => Promise.resolve()
        });
    });

    const setupEnvironmentAndTest = async (
        configValue: string | undefined,
        remoteName: string | undefined,
        extensionKind: number | undefined,
        expected: boolean
    ) => {
        // Mock environment BEFORE loading module, so IsRemoteWorkspaceMode is calculated correctly
        mockVscode.env.remoteName = remoteName as string;

        // Ensure getExtension always returns what we specify
        (mockVscode as any).extensions = {
            getExtension: () => {
                // Return an object that has extensionKind property
                return extensionKind !== undefined ? { extensionKind } : undefined;
            }
        };

        if (configValue !== undefined) {
            configMap.set('instantCommit', configValue);
        }

        // Clear module cache for databaseModel.ts and any other src modules (excluding mocks)
        // to re-evaluate the IsRemoteWorkspaceMode constant
        Object.keys(require('module')._cache).forEach(key => {
            if (key.includes('src/') && !key.includes('workerFactory')) {
                delete require('module')._cache[key];
            }
        });

        // Force a re-require of databaseModel
        const { isAutoCommitEnabled } = require('../../src/databaseModel');
        assert.strictEqual(isAutoCommitEnabled(), expected);
    };

    it('should be true if instantCommit is always, regardless of environment', async () => {
        await setupEnvironmentAndTest('always', undefined, undefined, true);
        await setupEnvironmentAndTest('always', 'ssh-remote', 2 /* Workspace */, true);
    });

    it('should be false if instantCommit is never, regardless of environment', async () => {
        await setupEnvironmentAndTest('never', undefined, undefined, false);
        await setupEnvironmentAndTest('never', 'ssh-remote', 2 /* Workspace */, false);
    });

    it('should be true if instantCommit is remote-only and IsRemoteWorkspaceMode is true', async () => {
        // IsRemoteWorkspaceMode requires both remoteName and ExtensionKind.Workspace
        await setupEnvironmentAndTest('remote-only', 'ssh-remote', 2 /* Workspace */, true);
    });

    it('should be false if instantCommit is remote-only and IsRemoteWorkspaceMode is false', async () => {
        // Not remote (no remoteName)
        await setupEnvironmentAndTest('remote-only', undefined, 2 /* Workspace */, false);
        // Remote but extension is not Workspace kind (e.g., UI kind)
        await setupEnvironmentAndTest('remote-only', 'ssh-remote', 1 /* UI */, false);
    });

    it('should be false by default if instantCommit is not set (defaults to never)', async () => {
        // Set configMap to return undefined for 'instantCommit' (by omitting it from configMap)
        // IsRemoteWorkspaceMode is true, but config defaults to 'never'
        await setupEnvironmentAndTest(undefined, 'ssh-remote', 2 /* Workspace */, false);
    });
});


describe('DatabaseDocument Undo/Redo Error Handling', () => {
    let originalGetConfiguration: any;
    let configMap: Map<string, any>;
    let originalGetExtension: any;
    let originalRemoteName: any;
    let originalL10n: any;
    let originalModuleCache: any;

    before(async () => {
        originalGetConfiguration = mockVscode.workspace.getConfiguration;
        originalGetExtension = (mockVscode as any).extensions?.getExtension;
        originalRemoteName = mockVscode.env.remoteName;
        originalL10n = (mockVscode as any).l10n;

        configMap = new Map();
        mockVscode.workspace.getConfiguration = () => ({
            get: (key: string, defaultVal: any) => configMap.has(key) ? configMap.get(key) : defaultVal,
            update: () => Promise.resolve()
        });

        // Mock l10n to actual string formatting so assertions match what happens in the code
        (mockVscode as any).l10n = {
            t: (key: string, ...args: any[]) => {
                let result = key;
                args.forEach((arg, i) => {
                    result = result.replace(`{${i}}`, String(arg));
                });
                return result;
            }
        };

        // Note: workerFactoryPath cache is already setup by the first describe block for this file!
        // We just need to mock createDatabaseConnection on it so that it returns what we want
        const moduleCache = require('module')._cache;
        const workerFactoryPath = require.resolve('../../src/workerFactory');

        // Save the old export
        originalModuleCache = moduleCache[workerFactoryPath].exports;

        moduleCache[workerFactoryPath].exports = {
            createDatabaseConnection: () => Promise.resolve({
                establishConnection: () => Promise.resolve({
                    databaseOps: {},
                    isReadOnly: false
                }),
                workerMethods: { [Symbol.dispose]: () => {} }
            })
        };

        // Force a re-require to pick up our mocked createDatabaseConnection if DatabaseDocument was already loaded
        Object.keys(moduleCache).forEach(key => {
            if (key.includes('src/databaseModel')) {
                delete moduleCache[key];
            }
        });
    });

    after(() => {
        mockVscode.workspace.getConfiguration = originalGetConfiguration;
        if ((mockVscode as any).extensions) {
            (mockVscode as any).extensions.getExtension = originalGetExtension;
        }
        mockVscode.env.remoteName = originalRemoteName;
        (mockVscode as any).l10n = originalL10n;

        const moduleCache = require('module')._cache;
        const workerFactoryPath = require.resolve('../../src/workerFactory');
        if (moduleCache[workerFactoryPath]) {
            moduleCache[workerFactoryPath].exports = originalModuleCache;
        }
    });

    it('should catch error during undo in onDidChange modification emitter', async () => {
        const { DatabaseDocument } = require('../../src/databaseModel');
        const originalConsoleError = console.error;
        let loggedError: any = null;
        console.error = (msg: string, e: any) => {
            if (msg === '[Undo] Failed:') {
                loggedError = e;
            }
        };

        let showErrorMessageCalled = false;
        let showErrorMessageArgs: any[] = [];
        const originalShowErrorMessage = mockVscode.window.showErrorMessage;
        mockVscode.window.showErrorMessage = (msg: string, ...args: any[]) => {
            showErrorMessageCalled = true;
            showErrorMessageArgs = [msg, ...args];
            return Promise.resolve();
        };

        try {
            const viewerProvider = {
                reporter: {},
                isVerified: true,
                context: { extensionUri: {} },
                outputChannel: undefined
            } as any;

            const doc = await DatabaseDocument.create(viewerProvider, mockVscode.Uri.parse('file:///test.db'), {} as any);

            let modificationEvent: any = null;
            doc.onDidChange((e: any) => {
                modificationEvent = e;
            });

            const mockError = new Error('Undo operation failed synthetically');
            // Monkey-patch databaseOps
            (doc as any).connectionState = {
                databaseOps: {
                    undoModification: async () => { throw mockError; }
                }
            };

            doc.recordModification({ label: 'test modification' } as any);

            assert.ok(modificationEvent, 'Modification event should have been emitted');
            assert.ok(modificationEvent.undo, 'Undo function should be provided');

            // Execute undo
            await modificationEvent.undo();

            assert.strictEqual(loggedError, mockError, 'Error should be logged to console.error');
            assert.ok(showErrorMessageCalled, 'vscode.window.showErrorMessage should be called');
            assert.strictEqual(showErrorMessageArgs[0], 'Undo failed: Undo operation failed synthetically');
        } finally {
            console.error = originalConsoleError;
            mockVscode.window.showErrorMessage = originalShowErrorMessage;
        }
    });

    it('should catch error during redo in onDidChange modification emitter', async () => {
        const { DatabaseDocument } = require('../../src/databaseModel');
        const originalConsoleError = console.error;
        let loggedError: any = null;
        console.error = (msg: string, e: any) => {
            if (msg === '[Redo] Failed:') {
                loggedError = e;
            }
        };

        let showErrorMessageCalled = false;
        let showErrorMessageArgs: any[] = [];
        const originalShowErrorMessage = mockVscode.window.showErrorMessage;
        mockVscode.window.showErrorMessage = (msg: string, ...args: any[]) => {
            showErrorMessageCalled = true;
            showErrorMessageArgs = [msg, ...args];
            return Promise.resolve();
        };

        try {
            const viewerProvider = {
                reporter: {},
                isVerified: true,
                context: { extensionUri: {} },
                outputChannel: undefined
            } as any;

            const doc = await DatabaseDocument.create(viewerProvider, mockVscode.Uri.parse('file:///test2.db'), {} as any);

            let modificationEvent: any = null;
            doc.onDidChange((e: any) => {
                modificationEvent = e;
            });

            const mockError = new Error('Redo operation failed synthetically');
            (doc as any).connectionState = {
                databaseOps: {
                    redoModification: async () => { throw mockError; },
                    undoModification: async () => {} // we need a successful undo first to be able to redo
                }
            };

            doc.recordModification({ label: 'test modification 2' } as any);

            assert.ok(modificationEvent, 'Modification event should have been emitted');

            // First undo so we can redo
            await modificationEvent.undo();

            // Now redo
            await modificationEvent.redo();

            assert.strictEqual(loggedError, mockError, 'Error should be logged to console.error');
            assert.ok(showErrorMessageCalled, 'vscode.window.showErrorMessage should be called');
            assert.strictEqual(showErrorMessageArgs[0], 'Redo failed: Redo operation failed synthetically');
        } finally {
            console.error = originalConsoleError;
            mockVscode.window.showErrorMessage = originalShowErrorMessage;
        }
    });
});
