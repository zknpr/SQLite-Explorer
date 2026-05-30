import './vscode_mock_setup';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
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




describe('DatabaseDocument save/saveAs fallback', () => {
    let DatabaseDocument: any;

    beforeEach(() => {
        // Clear module cache to ensure we get a fresh instance that uses our mocked workerFactory
        const moduleCache = require('module')._cache;
        Object.keys(moduleCache).forEach(key => {
            if (key.includes('src/') && !key.includes('workerFactory') && !key.includes('mocks')) {
                delete moduleCache[key];
            }
        });

        const workerFactoryPath = require.resolve('../../src/workerFactory');
        moduleCache[workerFactoryPath] = {
            id: workerFactoryPath,
            filename: workerFactoryPath,
            loaded: true,
            exports: {
                createDatabaseConnection: async () => ({
                    establishConnection: async () => ({
                        databaseOps: {
                            engineKind: Promise.resolve('wasm'),
                            writeToFile: async () => { throw new Error('Simulated write failure'); },
                            serializeDatabase: async () => new Uint8Array([1, 2, 3]),
                            applyModifications: async () => {}
                        },
                        isReadOnly: false
                    }),
                    workerMethods: {
                        [Symbol.dispose]: () => {}
                    }
                })
            }
        };

        const dbModel = require('../../src/databaseModel');
        DatabaseDocument = dbModel.DatabaseDocument;
    });

    const createFileUri = (path: string) => {
        return {
            scheme: 'file',
            authority: '',
            path: path,
            query: '',
            fragment: '',
            fsPath: path,
            with: () => ({}),
            toJSON: () => ({})
        };
    };

    const createDocBypassingFactory = (dbOps: any) => {
        const mockViewerProvider = {
            reporter: {},
            isVerified: true,
            context: { extensionUri: createFileUri('/ext') },
            forceReadOnly: false,
            outputChannel: undefined
        };
        const fileUri = createFileUri('/test/db.sqlite');

        return new (DatabaseDocument as any)(
            mockViewerProvider,
            fileUri,
            null, // tracker
            false, // autoCommitEnabled
            { databaseOps: dbOps, isReadOnly: false },
            { [Symbol.dispose]: () => {} }, // workerMethods
            async () => {}, // establishConnection
            {} // reporter
        );
    };

    it('saveAs: falls back to buffer transfer when writeToFile fails for file URI', async () => {
        let serialized = false;
        const dbOps = {
            engineKind: Promise.resolve('wasm'),
            writeToFile: async () => { throw new Error('Simulated write failure'); },
            serializeDatabase: async () => {
                serialized = true;
                return new Uint8Array([1, 2, 3]);
            }
        };

        const doc = createDocBypassingFactory(dbOps);

        const targetUri = createFileUri('/test/target.sqlite');

        let statCalled = false;
        let writeFileCalled = false;

        const originalFs = mockVscode.workspace.fs;
        mockVscode.workspace.fs = {
            ...originalFs,
            stat: async () => {
                statCalled = true;
                return { size: 100 }; // Less than getFileSizeLimit()
            },
            writeFile: async (uri: any, content: any) => {
                writeFileCalled = true;
                assert.deepStrictEqual(content, new Uint8Array([1, 2, 3]));
            },
            readFile: async () => new Uint8Array([])
        } as any;

        const originalConsoleWarn = console.warn;
        let consoleWarnCalled = false;
        console.warn = (msg: string, err: any) => {
            if (msg && msg.includes('Direct write failed')) {
                consoleWarnCalled = true;
            } else {
                originalConsoleWarn(msg, err);
            }
        };

        try {
            await doc.saveAs(targetUri, undefined);

            assert.strictEqual(consoleWarnCalled, true, 'console.warn should be called');
            assert.strictEqual(statCalled, true, 'fs.stat should be called');
            assert.strictEqual(serialized, true, 'serializeDatabase should be called');
            assert.strictEqual(writeFileCalled, true, 'fs.writeFile should be called');
        } finally {
            mockVscode.workspace.fs = originalFs;
            console.warn = originalConsoleWarn;
        }
    });

    it('save: falls back to buffer transfer when writeToFile fails for file URI', async () => {
        let serialized = false;
        const dbOps = {
            engineKind: Promise.resolve('wasm'),
            writeToFile: async () => { throw new Error('Simulated write failure'); },
            serializeDatabase: async () => {
                serialized = true;
                return new Uint8Array([1, 2, 3]);
            }
        };

        const doc = createDocBypassingFactory(dbOps);

        let writeFileCalled = false;

        const originalFs = mockVscode.workspace.fs;
        mockVscode.workspace.fs = {
            ...originalFs,
            stat: async () => {
                return { size: 100 };
            },
            writeFile: async (uri: any, content: any) => {
                writeFileCalled = true;
                assert.deepStrictEqual(content, new Uint8Array([1, 2, 3]));
            },
            readFile: async () => new Uint8Array([])
        } as any;

        const originalConsoleWarn = console.warn;
        let consoleWarnCalled = false;
        console.warn = (msg: string, err: any) => {
            if (msg && msg.includes('Direct write failed')) {
                consoleWarnCalled = true;
            } else {
                originalConsoleWarn(msg, err);
            }
        };

        try {
            await doc.save();

            assert.strictEqual(consoleWarnCalled, true, 'console.warn should be called');
            assert.strictEqual(serialized, true, 'serializeDatabase should be called');
            assert.strictEqual(writeFileCalled, true, 'fs.writeFile should be called');
        } finally {
            mockVscode.workspace.fs = originalFs;
            console.warn = originalConsoleWarn;
        }
    });
});


describe('DatabaseDocument undo/redo error handling', () => {
    let mockViewerProvider: any;
    let mockOpenContext: any;
    let originalShowErrorMessage: any;
    let originalL10n: any;

    beforeEach(() => {
        originalShowErrorMessage = mockVscode.window.showErrorMessage;
        originalL10n = mockVscode.l10n.t;

        mockVscode.l10n.t = (key: string, ...args: any[]) => {
            let res = key;
            args.forEach((arg, i) => {
                res = res.replace(`{${i}}`, String(arg));
            });
            return res;
        };

        mockViewerProvider = {
            reporter: undefined,
            isVerified: true,
            context: { extensionUri: mockVscode.Uri.parse('file:///ext') },
            forceReadOnly: false
        };

        mockOpenContext = {
            backupId: undefined
        };

        const moduleCache = require('module')._cache;
        const workerFactoryPath = require.resolve('../../src/workerFactory');
        moduleCache[workerFactoryPath] = {
            id: workerFactoryPath,
            filename: workerFactoryPath,
            loaded: true,
            exports: {
                createDatabaseConnection: () => {
                    return Promise.resolve({
                        workerMethods: {
                            open: () => Promise.resolve({ isReadOnly: false, bufferInfo: {} }),
                            exec: () => Promise.resolve(),
                        },
                        establishConnection: () => Promise.resolve({ isReadOnly: false }),
                        databaseOps: {
                            undoModification: () => Promise.resolve(),
                            redoModification: () => Promise.resolve(),
                            close: () => Promise.resolve(),
                            getSchema: () => Promise.resolve([]),
                            query: () => Promise.resolve([])
                        }
                    });
                }
            }
        };

    });

    afterEach(() => {
        mockVscode.window.showErrorMessage = originalShowErrorMessage;
        mockVscode.l10n.t = originalL10n;
    });

    it('should show error message when undoModification fails', async () => {
        let errorMessageShown = false;
        mockVscode.window.showErrorMessage = async (msg?: string) => {
            if (msg?.includes('Test Undo Error')) {
                errorMessageShown = true;
            }
        };

        // We clear module cache of databaseModel so it uses the mocked workerFactory
        delete require('module')._cache[require.resolve('../../src/databaseModel')];
        const { DatabaseDocument } = require('../../src/databaseModel');

        const uri = mockVscode.Uri.parse('file:///test.db');
        const doc = await DatabaseDocument.create(mockViewerProvider, uri, mockOpenContext);

        // Mock database operations to throw error on undo
        const dbOps = doc.databaseOperations;
        if(dbOps) {
            dbOps.undoModification = () => Promise.reject(new Error("Test Undo Error"));
        } else {
             // force override via any
             (doc as any).connectionState = {
                databaseOps: {
                    undoModification: () => Promise.reject(new Error("Test Undo Error")),
                    redoModification: () => Promise.resolve()
                }
             };
        }

        let undoAction: (() => Promise<void>) | undefined;
        doc.onDidChange((modification: any) => {
            undoAction = modification.undo;
        });

        doc.recordModification({
            label: 'Test Mod',
            action: 'Test Mod Action',
            sql: [],
            inverseSql: []
        });

        assert.ok(undoAction, 'Undo action should be emitted');

        await undoAction();

        assert.strictEqual(errorMessageShown, true, 'Error message should be shown for failed undo');
    });

    it('should show error message when redoModification fails', async () => {
        let errorMessageShown = false;
        mockVscode.window.showErrorMessage = async (msg?: string) => {
            if (msg?.includes('Test Redo Error')) {
                errorMessageShown = true;
            }
        };

        const { DatabaseDocument } = require('../../src/databaseModel');
        const uri = mockVscode.Uri.parse('file:///test.db');
        const doc = await DatabaseDocument.create(mockViewerProvider, uri, mockOpenContext);

        // Mock database operations to throw error on redo
        const dbOps = doc.databaseOperations;
        if(dbOps) {
             dbOps.redoModification = () => Promise.reject(new Error("Test Redo Error"));
        } else {
            (doc as any).connectionState = {
                databaseOps: {
                    undoModification: () => Promise.resolve(),
                    redoModification: () => Promise.reject(new Error("Test Redo Error"))
                }
             };
        }

        let redoAction: (() => Promise<void>) | undefined;
        let undoAction: (() => Promise<void>) | undefined;
        doc.onDidChange((modification: any) => {
            undoAction = modification.undo;
            redoAction = modification.redo;
        });

        doc.recordModification({
            label: 'Test Mod',
            action: 'Test Mod Action',
            sql: [],
            inverseSql: []
        });

        assert.ok(redoAction, 'Redo action should be emitted');

        await undoAction!();
        await redoAction();

        assert.strictEqual(errorMessageShown, true, 'Error message should be shown for failed redo');
    });
});
