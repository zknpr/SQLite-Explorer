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


describe('DatabaseDocument.saveAs', () => {
    let originalConsoleWarn: typeof console.warn;
    let warnedMessage: string | undefined;
    let DatabaseDocument: any;
    let originalFsStat: any;
    let originalFsWriteFile: any;

    before(() => {
        originalConsoleWarn = console.warn;
        const { DatabaseDocument: Model } = require('../../src/databaseModel');
        DatabaseDocument = Model;

        originalFsStat = mockVscode.workspace.fs.stat;
        originalFsWriteFile = mockVscode.workspace.fs.writeFile;
    });

    after(() => {
        console.warn = originalConsoleWarn;
        mockVscode.workspace.fs.stat = originalFsStat;
        mockVscode.workspace.fs.writeFile = originalFsWriteFile;
    });

    beforeEach(() => {
        warnedMessage = undefined;
        console.warn = (...args: any[]) => {
            warnedMessage = args[0];
        };
    });

    it('should catch writeToFile error and fall back to serializeDatabase', async () => {
        let serializeCalled = false;
        let ensureWritableCalled = false;

        // Mock database document instance properties
        const mockDatabaseOps = {
            writeToFile: async (fsPath: string) => {
                throw new Error('Simulated write failure');
            },
            serializeDatabase: async (filename: string) => {
                serializeCalled = true;
                return new Uint8Array([1, 2, 3]);
            }
        };

        const doc = Object.create(DatabaseDocument.prototype);
        Object.assign(doc, {
            ensureWritable: async () => { ensureWritableCalled = true; },
            getFileSizeLimit: () => 1024 * 1024,
            uri: mockVscode.Uri.parse('sqlite://test.sqlite')
        });

        Object.defineProperty(doc, 'databaseOperations', {
            get: () => mockDatabaseOps
        });

        Object.defineProperty(doc, 'fileParts', {
            get: () => ({ filename: 'test.sqlite' })
        });

        // Mock workspace fs stat & writeFile
        let fileStatCalled = false;
        let writeFileCalled = false;
        let targetUriWritten: any = null;
        let writtenContent: any = null;

        mockVscode.workspace.fs.stat = async (uri: any) => {
            fileStatCalled = true;
            return { size: 100 }; // Less than limit
        };

        mockVscode.workspace.fs.writeFile = async (uri: any, content: any) => {
            writeFileCalled = true;
            targetUriWritten = uri;
            writtenContent = content;
        };

        const targetUri = mockVscode.Uri.file('/tmp/test.sqlite');
        const cancellation = {} as any;

        await doc.saveAs(targetUri, cancellation);

        assert.strictEqual(ensureWritableCalled, true, 'ensureWritable should be called');
        assert.strictEqual(warnedMessage, 'Direct write failed, falling back to buffer transfer', 'Should warn about write failure');
        assert.strictEqual(fileStatCalled, true, 'fs.stat should be called as part of fallback');
        assert.strictEqual(serializeCalled, true, 'serializeDatabase should be called as part of fallback');
        assert.strictEqual(writeFileCalled, true, 'fs.writeFile should be called with serialized data');
        assert.deepStrictEqual(writtenContent, new Uint8Array([1, 2, 3]), 'Should write the serialized binary content');
    });
});
