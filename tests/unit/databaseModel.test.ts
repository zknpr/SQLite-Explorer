import './vscode_mock_setup';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import Module from 'node:module';
import esbuild from 'esbuild';
import { mockVscode } from './mocks/vscode';
import { ModificationTracker } from '../../src/core/undo-history';
import { createDatabaseEngine } from '../../src/core/sqlite-db';
import type { DatabaseOperations, LabeledModification } from '../../src/core/types';

const databaseModelPath = path.resolve(__dirname, '../../src/databaseModel.ts');
const databaseModelSource = fs.readFileSync(databaseModelPath, 'utf8');

function loadBrowserDatabaseModel() {
    const jsCode = esbuild.transformSync(databaseModelSource, {
        loader: 'ts',
        format: 'cjs',
        define: {
            'import.meta.env.VSCODE_BROWSER_EXT': 'true'
        }
    }).code;

    const scriptModule = new Module(databaseModelPath, module as unknown as Module);
    scriptModule.filename = databaseModelPath;
    scriptModule.paths = (Module as unknown as { _nodeModulePaths(dirname: string): string[] })
        ._nodeModulePaths(path.dirname(databaseModelPath));

    const originalRequire = Module.prototype.require;
    Module.prototype.require = function(request: string) {
        if (request === 'vscode') return mockVscode;
        if (request.endsWith('workerFactory')) {
            return { createDatabaseConnection: async () => ({}) };
        }
        if (request.endsWith('main')) {
            return { GlobalOutputChannel: null };
        }
        return originalRequire.call(this, request);
    };

    try {
        (scriptModule as unknown as { _compile(code: string, filename: string): void })
            ._compile(jsCode, databaseModelPath);
    } finally {
        Module.prototype.require = originalRequire;
    }

    return scriptModule.exports as typeof import('../../src/databaseModel');
}

// Setup environment definitions that match VS Code ExtensionKind
(mockVscode as any).ExtensionKind = { Workspace: 2, UI: 1 };
mockVscode.env.remoteName = 'remote';
(mockVscode as any).extensions = {
    getExtension: () => ({ extensionKind: 2 })
};

describe('SupportsWriteMode', () => {
    it('allows the browser extension host even when remoteName is set and the extension is UI-kind', () => {
        const originalRemoteName = mockVscode.env.remoteName;
        const originalExtensionKind = (mockVscode as any).ExtensionKind;
        const originalExtensions = (mockVscode as any).extensions;

        Object.defineProperty(mockVscode, 'ExtensionKind', {
            value: { Workspace: 2, UI: 1 },
            writable: true,
            configurable: true
        });
        Object.defineProperty(mockVscode.env, 'remoteName', {
            value: 'github',
            writable: true,
            configurable: true
        });
        Object.defineProperty(mockVscode, 'extensions', {
            value: { getExtension: () => ({ extensionKind: 1 }) },
            writable: true,
            configurable: true
        });

        try {
            const { SupportsWriteMode } = loadBrowserDatabaseModel();
            assert.strictEqual(SupportsWriteMode, true);
        } finally {
            Object.defineProperty(mockVscode, 'ExtensionKind', {
                value: originalExtensionKind,
                writable: true,
                configurable: true
            });
            Object.defineProperty(mockVscode.env, 'remoteName', {
                value: originalRemoteName,
                writable: true,
                configurable: true
            });
            Object.defineProperty(mockVscode, 'extensions', {
                value: originalExtensions,
                writable: true,
                configurable: true
            });
        }
    });
});

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

    const createUri = (scheme: string, path: string) => {
        const uri = {
            scheme,
            authority: '',
            path: path,
            query: '',
            fragment: '',
            fsPath: scheme === 'file' ? path : '',
            with: (changes: { path?: string }) => createUri(scheme, changes.path ?? path),
            toString: () => `${scheme}://${path}`,
            toJSON: () => ({})
        };
        return uri;
    };

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

    const createDocBypassingFactory = (dbOps: any, uri: any = createFileUri('/test/db.sqlite')) => {
        const mockViewerProvider = {
            reporter: {},
            isVerified: true,
            context: { extensionUri: createFileUri('/ext') },
            forceReadOnly: false,
            outputChannel: undefined
        };

        return new (DatabaseDocument as any)(
            mockViewerProvider,
            uri,
            null, // tracker
            false, // autoCommitEnabled
            { databaseOps: dbOps, isReadOnly: false },
            { [Symbol.dispose]: () => {} }, // workerMethods
            async () => {}, // establishConnection
            {} // reporter
        );
    };

    it('save: throws CancellationError and writes nothing when the token is already cancelled', async () => {
        let serializeCalled = false;
        let writeToFileCalled = false;
        const dbOps = {
            engineKind: Promise.resolve('wasm'),
            writeToFile: async () => { writeToFileCalled = true; },
            serializeDatabase: async () => {
                serializeCalled = true;
                return new Uint8Array([1, 2, 3]);
            }
        };

        const doc = createDocBypassingFactory(dbOps);

        // A pre-cancelled token must abort save before any serialize/write work.
        const cancelledToken = {
            isCancellationRequested: true,
            onCancellationRequested: () => ({ dispose() {} })
        } as any;

        await assert.rejects(
            () => doc.save(cancelledToken),
            (err: any) => err instanceof Error && err.name === 'Canceled'
        );
        assert.strictEqual(serializeCalled, false, 'serializeDatabase must not run when cancelled');
        assert.strictEqual(writeToFileCalled, false, 'writeToFile must not run when cancelled');
    });

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
        Object.defineProperty(mockVscode.workspace, 'fs', {
            value: {
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
            } as any,
            writable: true,
            configurable: true
        });

        let consoleWarnCalled = false;
        doc.viewerProvider.outputChannel = {
            appendLine: (msg: string) => {
                if (msg && msg.includes('Direct write failed')) {
                    consoleWarnCalled = true;
                }
            }
        } as any;

        try {
            await doc.saveAs(targetUri, undefined);

            assert.strictEqual(consoleWarnCalled, true, 'console.warn should be called');
            assert.strictEqual(statCalled, true, 'fs.stat should be called');
            assert.strictEqual(serialized, true, 'serializeDatabase should be called');
            assert.strictEqual(writeFileCalled, true, 'fs.writeFile should be called');
        } finally {
            Object.defineProperty(mockVscode.workspace, 'fs', {
                value: originalFs,
                writable: true,
                configurable: true
            });

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
        Object.defineProperty(mockVscode.workspace, 'fs', {
            value: {
                ...originalFs,
                stat: async () => {
                    return { size: 100 };
                },
                writeFile: async (uri: any, content: any) => {
                    writeFileCalled = true;
                    assert.deepStrictEqual(content, new Uint8Array([1, 2, 3]));
                },
                readFile: async () => new Uint8Array([])
            } as any,
            writable: true,
            configurable: true
        });

        let consoleWarnCalled = false;
        doc.viewerProvider.outputChannel = {
            appendLine: (msg: string) => {
                if (msg && msg.includes('Direct write failed')) {
                    consoleWarnCalled = true;
                }
            }
        } as any;

        try {
            await doc.save();

            assert.strictEqual(consoleWarnCalled, true, 'console.warn should be called');
            assert.strictEqual(serialized, true, 'serializeDatabase should be called');
            assert.strictEqual(writeFileCalled, true, 'fs.writeFile should be called');
        } finally {
            Object.defineProperty(mockVscode.workspace, 'fs', {
                value: originalFs,
                writable: true,
                configurable: true
            });

        }
    });

    it('save: serializes and writes WASM database content for non-file URI', async () => {
        const sourceUri = createUri('vscode-vfs', '/github/user/repo/test.db');
        let serializeCallCount = 0;
        let serializeArgCount = -1;
        let writeFileCalled = false;

        const dbOps = {
            engineKind: Promise.resolve('wasm'),
            writeToFile: async () => { throw new Error('writeToFile should not be called for non-file URIs'); },
            // Capture call count + arity so the test fails if save() regresses to passing a
            // filename argument (the previous version asserted a value it set itself — tautological).
            serializeDatabase: async (...args: unknown[]) => {
                serializeCallCount++;
                serializeArgCount = args.length;
                return new Uint8Array([4, 5, 6]);
            }
        };

        const doc = createDocBypassingFactory(dbOps, sourceUri);

        const originalFs = mockVscode.workspace.fs;
        Object.defineProperty(mockVscode.workspace, 'fs', {
            value: {
                ...originalFs,
                writeFile: async (uri: any, content: any) => {
                    writeFileCalled = true;
                    assert.strictEqual(uri, sourceUri);
                    assert.deepStrictEqual(content, new Uint8Array([4, 5, 6]));
                },
                readFile: async () => new Uint8Array([])
            } as any,
            writable: true,
            configurable: true
        });

        try {
            await doc.save();

            assert.strictEqual(serializeCallCount, 1, 'serializeDatabase should be called exactly once');
            assert.strictEqual(serializeArgCount, 0, 'serializeDatabase should be called with no arguments');
            assert.strictEqual(writeFileCalled, true, 'fs.writeFile should be called');
        } finally {
            Object.defineProperty(mockVscode.workspace, 'fs', {
                value: originalFs,
                writable: true,
                configurable: true
            });
        }
    });

    it('save: keeps failed non-file WASM writes uncommitted for backup and retry', async () => {
        const sourceUri = createUri('vscode-vfs', '/github/user/repo/test.db');
        let backupContent: Uint8Array | undefined;

        const dbOps = {
            engineKind: Promise.resolve('wasm'),
            serializeDatabase: async () => new Uint8Array([7, 8, 9])
        };

        const doc = createDocBypassingFactory(dbOps, sourceUri);
        doc.recordModification({
            label: 'Update Cell',
            description: 'Update items.name',
            modificationType: 'cell_update',
            targetTable: 'items',
            targetRowId: 1,
            targetColumn: 'name',
            newValue: 'after',
            priorValue: 'before'
        });

        const originalFs = mockVscode.workspace.fs;
        Object.defineProperty(mockVscode.workspace, 'fs', {
            value: {
                ...originalFs,
                writeFile: async (uri: any, content: any) => {
                    if (uri.toString() === sourceUri.toString()) {
                        throw new Error('NoPermissions: read-only filesystem');
                    }
                    backupContent = content;
                },
                readFile: async () => new Uint8Array([])
            } as any,
            writable: true,
            configurable: true
        });

        try {
            await assert.rejects(
                () => doc.save(),
                /NoPermissions: read-only filesystem/
            );

            await doc.backup(createUri('vscode-userdata', '/backups/test.db'), undefined);

            assert.ok(backupContent, 'backup should be written after failed save');
            const restored = ModificationTracker.deserialize(backupContent);
            const uncommitted = restored.getUncommittedEntries();
            assert.strictEqual(uncommitted.length, 1);
            assert.strictEqual(uncommitted[0].label, 'Update Cell');
        } finally {
            Object.defineProperty(mockVscode.workspace, 'fs', {
                value: originalFs,
                writable: true,
                configurable: true
            });
        }
    });

    it('save: does not checkpoint edits recorded while writeFile is still pending', async () => {
        const sourceUri = createUri('vscode-vfs', '/github/user/repo/test.db');
        let resolveWrite: () => void = () => {};
        let markWriteStarted: () => void = () => {};
        const writeMayFinish = new Promise<void>(resolve => {
            resolveWrite = resolve;
        });
        const writeStarted = new Promise<void>(resolve => {
            markWriteStarted = resolve;
        });

        const firstModification = {
            label: 'First Update',
            description: 'Update first item',
            modificationType: 'cell_update' as const,
            targetTable: 'items',
            targetRowId: 1,
            targetColumn: 'name',
            priorValue: 'before',
            newValue: 'after'
        };
        const concurrentModification = {
            label: 'Concurrent Update',
            description: 'Update concurrent item',
            modificationType: 'cell_update' as const,
            targetTable: 'items',
            targetRowId: 2,
            targetColumn: 'name',
            priorValue: 'old',
            newValue: 'new'
        };
        let discardedModifications: unknown[] | undefined;

        const dbOps = {
            engineKind: Promise.resolve('wasm'),
            serializeDatabase: async () => new Uint8Array([7, 8, 9]),
            discardModifications: async (mods: unknown[]) => {
                discardedModifications = mods;
            }
        };

        const doc = createDocBypassingFactory(dbOps, sourceUri);
        doc.recordModification(firstModification);

        const originalFs = mockVscode.workspace.fs;
        Object.defineProperty(mockVscode.workspace, 'fs', {
            value: {
                ...originalFs,
                writeFile: async (uri: any, content: any) => {
                    assert.strictEqual(uri, sourceUri);
                    assert.deepStrictEqual(content, new Uint8Array([7, 8, 9]));
                    markWriteStarted();
                    await writeMayFinish;
                },
                readFile: async () => new Uint8Array([])
            } as any,
            writable: true,
            configurable: true
        });

        try {
            const savePromise = doc.save();
            await writeStarted;

            doc.recordModification(concurrentModification);
            resolveWrite();
            await savePromise;

            await doc.revert(undefined);

            assert.deepStrictEqual(discardedModifications, [concurrentModification]);
        } finally {
            Object.defineProperty(mockVscode.workspace, 'fs', {
                value: originalFs,
                writable: true,
                configurable: true
            });
        }
    });

    it('save: stays dirty when undo shrinks the timeline while writeFile is still pending', async () => {
        const sourceUri = createUri('vscode-vfs', '/github/user/repo/test.db');
        let resolveWrite: () => void = () => {};
        let markWriteStarted: () => void = () => {};
        const writeMayFinish = new Promise<void>(resolve => {
            resolveWrite = resolve;
        });
        const writeStarted = new Promise<void>(resolve => {
            markWriteStarted = resolve;
        });

        const firstModification = {
            label: 'First Update',
            description: 'Update first item',
            modificationType: 'cell_update' as const,
            targetTable: 'items',
            targetRowId: 1,
            targetColumn: 'name',
            priorValue: 'before-a',
            newValue: 'after-a'
        };
        const undoneModification = {
            label: 'Second Update',
            description: 'Update second item',
            modificationType: 'cell_update' as const,
            targetTable: 'items',
            targetRowId: 2,
            targetColumn: 'name',
            priorValue: 'before-b',
            newValue: 'after-b'
        };
        let undoSecondUpdate: (() => Promise<void>) | undefined;
        let discardedModifications: unknown[] | undefined;

        const dbOps = {
            engineKind: Promise.resolve('wasm'),
            serializeDatabase: async () => new Uint8Array([10, 11, 12]),
            undoModification: async (modification: unknown) => {
                assert.strictEqual(modification, undoneModification);
            },
            discardModifications: async (mods: unknown[]) => {
                discardedModifications = mods;
            }
        };

        const doc = createDocBypassingFactory(dbOps, sourceUri);
        doc.recordModification(firstModification);
        doc.onDidChange((modification: any) => {
            if (modification.label === 'Second Update') {
                undoSecondUpdate = modification.undo;
            }
        });
        doc.recordModification(undoneModification);
        assert.ok(undoSecondUpdate, 'second update undo action should be emitted');

        const originalFs = mockVscode.workspace.fs;
        Object.defineProperty(mockVscode.workspace, 'fs', {
            value: {
                ...originalFs,
                writeFile: async (uri: any, content: any) => {
                    assert.strictEqual(uri, sourceUri);
                    assert.deepStrictEqual(content, new Uint8Array([10, 11, 12]));
                    markWriteStarted();
                    await writeMayFinish;
                },
                readFile: async () => new Uint8Array([])
            } as any,
            writable: true,
            configurable: true
        });

        try {
            const savePromise = doc.save();
            await writeStarted;

            await undoSecondUpdate!();
            resolveWrite();
            await savePromise;

            await doc.revert(undefined);

            assert.deepStrictEqual(discardedModifications, [firstModification]);
        } finally {
            Object.defineProperty(mockVscode.workspace, 'fs', {
                value: originalFs,
                writable: true,
                configurable: true
            });
        }
    });

    it('save: stays dirty when undo shrinks the timeline while file writeToFile is still pending', async () => {
        const sourceUri = createFileUri('/test/db.sqlite');
        let resolveWrite: () => void = () => {};
        let markWriteStarted: () => void = () => {};
        const writeMayFinish = new Promise<void>(resolve => {
            resolveWrite = resolve;
        });
        const writeStarted = new Promise<void>(resolve => {
            markWriteStarted = resolve;
        });

        const firstModification = {
            label: 'First File Update',
            description: 'Update first file item',
            modificationType: 'cell_update' as const,
            targetTable: 'items',
            targetRowId: 1,
            targetColumn: 'name',
            priorValue: 'before-a',
            newValue: 'after-a'
        };
        const undoneModification = {
            label: 'Second File Update',
            description: 'Update second file item',
            modificationType: 'cell_update' as const,
            targetTable: 'items',
            targetRowId: 2,
            targetColumn: 'name',
            priorValue: 'before-b',
            newValue: 'after-b'
        };
        let undoSecondUpdate: (() => Promise<void>) | undefined;
        let discardedModifications: unknown[] | undefined;

        const dbOps = {
            engineKind: Promise.resolve('wasm'),
            writeToFile: async (filePath: string) => {
                assert.strictEqual(filePath, '/test/db.sqlite');
                markWriteStarted();
                await writeMayFinish;
            },
            serializeDatabase: async () => {
                throw new Error('serializeDatabase should not be called when file writeToFile succeeds');
            },
            undoModification: async (modification: unknown) => {
                assert.strictEqual(modification, undoneModification);
            },
            discardModifications: async (mods: unknown[]) => {
                discardedModifications = mods;
            }
        };

        const doc = createDocBypassingFactory(dbOps, sourceUri);
        doc.recordModification(firstModification);
        doc.onDidChange((modification: any) => {
            if (modification.label === 'Second File Update') {
                undoSecondUpdate = modification.undo;
            }
        });
        doc.recordModification(undoneModification);
        assert.ok(undoSecondUpdate, 'second update undo action should be emitted');

        const savePromise = doc.save();
        await writeStarted;

        await undoSecondUpdate!();
        resolveWrite();
        await savePromise;

        await doc.revert(undefined);

        assert.deepStrictEqual(discardedModifications, [firstModification]);
    });

    it('identifies view mutations on content changes from edits, undo, and redo', async () => {
        const applied: unknown[] = [];
        const modification = {
            label: 'Edit View',
            description: 'Edit report view',
            modificationType: 'view_edit' as const,
            targetTable: 'report_view'
        };
        const dbOps = {
            undoModification: async (entry: unknown) => assert.strictEqual(entry, modification),
            redoModification: async (entry: unknown) => assert.strictEqual(entry, modification)
        };
        const doc = createDocBypassingFactory(dbOps);
        let undo: (() => Promise<void>) | undefined;
        let redo: (() => Promise<void>) | undefined;
        doc.onDidChangeContent((event: any) => applied.push(event.modification));
        doc.onDidChange((event: any) => {
            undo = event.undo;
            redo = event.redo;
        });

        doc.recordExternalModification(modification);
        await undo!();
        await redo!();

        assert.deepStrictEqual(applied, [modification, modification, modification]);
    });

    it('invalidates every open view document after File Revert', async () => {
        const doc = createDocBypassingFactory({});
        const contentChanges: unknown[] = [];
        doc.onDidChangeContent((event: unknown) => contentChanges.push(event));

        await doc.revert(undefined);

        assert.deepStrictEqual(contentChanges, [{ invalidateAllViewDocuments: true }]);
    });

    it('notifies document-disposal subscribers before emitter teardown', async () => {
        const doc = createDocBypassingFactory({});
        let disposalNotifications = 0;
        doc.onDidDispose(() => { disposalNotifications++; });

        await doc.dispose();

        assert.strictEqual(disposalNotifications, 1);
    });
});

describe('DatabaseDocument hot-exit restore', () => {
    it('replays backup modifications into the restored WASM database', async () => {
        const result = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        const engine = result.operations as DatabaseOperations & { shutdown?: () => void };
        await engine.executeQuery("CREATE TABLE restored_items (id INTEGER PRIMARY KEY, name TEXT)");

        const restoredEntries: LabeledModification[] = [
            {
                label: 'Insert Restored Item',
                description: 'Insert restored item',
                modificationType: 'row_insert',
                targetTable: 'restored_items',
                targetRowId: 1,
                rowData: { id: 1, name: 'Draft' }
            },
            {
                label: 'Update Restored Item',
                description: 'Update restored item',
                modificationType: 'cell_update',
                targetTable: 'restored_items',
                targetRowId: 1,
                targetColumn: 'name',
                priorValue: 'Draft',
                newValue: 'Recovered'
            }
        ];
        const tracker = new ModificationTracker<LabeledModification>(100);
        for (const entry of restoredEntries) {
            tracker.record(entry);
        }

        const backupData = tracker.serialize();
        let applyWasCalled = false;
        let appliedModificationCount = 0;
        const originalApplyModifications = engine.applyModifications.bind(engine);
        engine.applyModifications = async (mods, signal) => {
            applyWasCalled = true;
            appliedModificationCount = mods.length;
            return originalApplyModifications(mods, signal);
        };

        const originalFs = mockVscode.workspace.fs;
        const moduleCache = require('module')._cache;
        const workerFactoryPath = require.resolve('../../src/workerFactory');
        const originalWorkerFactoryCacheEntry = moduleCache[workerFactoryPath];
        const databaseModelModulePath = require.resolve('../../src/databaseModel');

        Object.defineProperty(mockVscode.workspace, 'fs', {
            value: {
                ...originalFs,
                readFile: async () => backupData
            } as any,
            writable: true,
            configurable: true
        });

        moduleCache[workerFactoryPath] = {
            id: workerFactoryPath,
            filename: workerFactoryPath,
            loaded: true,
            exports: {
                createDatabaseConnection: async () => ({
                    establishConnection: async () => ({
                        databaseOps: engine,
                        isReadOnly: false
                    }),
                    workerMethods: {
                        [Symbol.dispose]: () => engine.shutdown?.()
                    }
                })
            }
        };
        delete moduleCache[databaseModelModulePath];

        try {
            const { DatabaseDocument } = require('../../src/databaseModel');
            await DatabaseDocument.create(
                {
                    reporter: undefined,
                    isVerified: true,
                    context: { extensionUri: mockVscode.Uri.file('/ext') },
                    forceReadOnly: false,
                    outputChannel: undefined
                },
                mockVscode.Uri.file('/test/restored.db'),
                { backupId: 'vscode-userdata:///backup/restored.db' }
            );

            const restoredRows = await engine.executeQuery(
                "SELECT id, name FROM restored_items ORDER BY id"
            );

            assert.strictEqual(applyWasCalled, true);
            assert.strictEqual(appliedModificationCount, 2);
            assert.deepStrictEqual(restoredRows[0].rows, [[1, 'Recovered']]);
        } finally {
            Object.defineProperty(mockVscode.workspace, 'fs', {
                value: originalFs,
                writable: true,
                configurable: true
            });
            if (originalWorkerFactoryCacheEntry) {
                moduleCache[workerFactoryPath] = originalWorkerFactoryCacheEntry;
            } else {
                delete moduleCache[workerFactoryPath];
            }
            delete moduleCache[databaseModelModulePath];
            engine.shutdown?.();
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
