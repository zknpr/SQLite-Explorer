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


describe('DatabaseDocument save', () => {
    let mockDatabaseOperations: any;
    let originalWarn: any;
    let originalWorkerFactoryExports: any;
    let workerFactoryPath: string;
    let moduleCache: any;

    beforeEach(() => {
        originalWarn = console.warn;
        moduleCache = require('module')._cache;
        workerFactoryPath = require.resolve('../../src/workerFactory');
        if (moduleCache[workerFactoryPath]) {
            originalWorkerFactoryExports = moduleCache[workerFactoryPath].exports;
        }
    });

    afterEach(() => {
        console.warn = originalWarn;
        if (moduleCache && workerFactoryPath) {
            if (originalWorkerFactoryExports) {
                moduleCache[workerFactoryPath].exports = originalWorkerFactoryExports;
            } else {
                delete moduleCache[workerFactoryPath];
            }
        }
    });

    it('should fallback to serializeDatabase if writeToFile throws', async () => {
        let warningLogged = false;
        console.warn = (msg: any, err?: any) => {
            if (typeof msg === 'string' && msg.includes('Direct write failed')) {
                warningLogged = true;
            }
        };

        const mockUri = {
            scheme: 'file',
            fsPath: '/path/to/test.db',
            path: '/path/to/test.db',
            with: () => mockUri,
            toString: () => 'file:///path/to/test.db'
        };

        mockDatabaseOperations = {
            writeToFile: async () => {
                throw new Error('Write failed');
            },
            serializeDatabase: async () => {
                return new Uint8Array([1, 2, 3]);
            },
            runCheckpoint: async () => {},
            engineKind: Promise.resolve('WASM')
        };

        let writeToFileCallCount = 0;
        let serializeDatabaseCallCount = 0;
        let fsWriteFileCallCount = 0;

        const origWriteToFile = mockDatabaseOperations.writeToFile;
        mockDatabaseOperations.writeToFile = async () => {
            writeToFileCallCount++;
            return origWriteToFile();
        };

        const origSerialize = mockDatabaseOperations.serializeDatabase;
        mockDatabaseOperations.serializeDatabase = async () => {
            serializeDatabaseCallCount++;
            return origSerialize();
        };

        mockVscode.workspace.fs.writeFile = async () => {
            fsWriteFileCallCount++;
        };
        mockVscode.workspace.fs.stat = async () => ({ permissions: 0 });

        const mockViewerProvider = {
            reporter: undefined,
            isVerified: true,
            context: {
                extensionUri: mockUri
            },
            forceReadOnly: false
        };

        if (!moduleCache[workerFactoryPath]) {
            moduleCache[workerFactoryPath] = { id: workerFactoryPath, filename: workerFactoryPath, loaded: true, exports: {} };
        }

        moduleCache[workerFactoryPath].exports = {
            createDatabaseConnection: () => Promise.resolve({
                establishConnection: async () => ({
                    databaseOps: mockDatabaseOperations,
                    isReadOnly: false
                }),
                workerMethods: {}
            })
        };

        const dbModelPath = require.resolve('../../src/databaseModel');
        delete moduleCache[dbModelPath];

        const { DatabaseDocument } = require('../../src/databaseModel');

        const model = await DatabaseDocument.create(
            mockViewerProvider as any,
            mockUri as any,
            {} as any
        );

        model.ensureWritable = async () => {};

        await model.save();

        assert.strictEqual(warningLogged, true);
        assert.strictEqual(writeToFileCallCount, 1);
        assert.strictEqual(serializeDatabaseCallCount, 1);
        assert.strictEqual(fsWriteFileCallCount, 1);
    });
});
