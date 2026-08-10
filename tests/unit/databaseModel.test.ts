import './vscode_mock_setup';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import Module from 'node:module';
import esbuild from 'esbuild';
import { mockVscode } from './mocks/vscode';
import { createDeferred } from './helpers/deferred';
import { ModificationTracker } from '../../src/core/undo-history';
import { createDatabaseEngine } from '../../src/core/sqlite-db';
import { NativeWorkerProcess } from '../../src/nativeWorker';
import type { DatabaseOperations, LabeledModification, ModificationEntry } from '../../src/core/types';
import { serializeOperations } from '../../src/core/operation-serializer';
import { encodePrimaryKeyRecordId } from '../../src/core/row-identity';

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

    const createDocBypassingFactory = (
        dbOps: any,
        uri: any = createFileUri('/test/db.sqlite'),
        establishConnection: (...args: any[]) => any = async () => {},
        options: {
            forceReadOnly?: boolean;
            autoCommitEnabled?: boolean;
            outputChannel?: { appendLine(message: string): void };
            initialReadOnly?: boolean;
            initialStorage?: 'memory' | 'paged';
        } = {}
    ) => {
        const mockViewerProvider = {
            reporter: {},
            isVerified: true,
            context: { extensionUri: createFileUri('/ext') },
            forceReadOnly: options.forceReadOnly ?? false,
            outputChannel: options.outputChannel,
            webviews: { get: () => [] }
        };

        // Production DatabaseOperations always includes ping. Supply the
        // no-op barrier for focused persistence doubles that omit it.
        dbOps.ping ??= async () => true;

        return new (DatabaseDocument as any)(
            mockViewerProvider,
            uri,
            null, // tracker
            options.autoCommitEnabled ?? false,
            {
                databaseOps: dbOps,
                isReadOnly: options.initialReadOnly ?? false,
                storage: options.initialStorage
            },
            { [Symbol.dispose]: () => {} }, // workerMethods
            establishConnection,
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

    it('save: refuses a paged non-file provider before stat, serialization, or write', async () => {
        const sourceUri = createUri('vscode-vfs', '/github/user/repo/paged.db');
        let writeToFileCalled = false;
        let serializeCalled = false;
        let statCalled = false;
        let workspaceWriteCalled = false;
        const doc = createDocBypassingFactory(
            {
                engineKind: Promise.resolve('wasm'),
                writeToFile: async () => { writeToFileCalled = true; },
                serializeDatabase: async () => {
                    serializeCalled = true;
                    return new Uint8Array();
                }
            },
            sourceUri,
            async () => {},
            { initialStorage: 'paged' }
        );

        const originalFs = mockVscode.workspace.fs;
        Object.defineProperty(mockVscode.workspace, 'fs', {
            value: {
                ...originalFs,
                stat: async () => {
                    statCalled = true;
                    return { size: 1 };
                },
                writeFile: async () => { workspaceWriteCalled = true; }
            } as any,
            writable: true,
            configurable: true
        });

        try {
            await assert.rejects(
                () => doc.save(),
                (error: Error) => {
                    assert.match(error.message, /non-file providers.*required streaming path/i);
                    assert.match(error.message, /save locally, then copy the file/i);
                    return true;
                }
            );
            assert.strictEqual(statCalled, false);
            assert.strictEqual(writeToFileCalled, false);
            assert.strictEqual(serializeCalled, false);
            assert.strictEqual(workspaceWriteCalled, false);
        } finally {
            Object.defineProperty(mockVscode.workspace, 'fs', {
                value: originalFs,
                writable: true,
                configurable: true
            });
        }
    });

    it('save: freezes mutations, writes the paged base, then reopens before completing', async () => {
        const events: string[] = [];
        const replacementOps = { engineKind: Promise.resolve('wasm') };
        let doc: any;
        const pagedOps = {
            engineKind: Promise.resolve('wasm'),
            writeToFile: async (filePath: string) => {
                events.push('write');
                assert.strictEqual(filePath, '/test/paged.db');
                assert.strictEqual(doc.connectionGeneration, 1);
                assert.strictEqual(doc.isReadOnlyMode, true, 'new mutations must be gated during replace');
                return { requiresReopen: true };
            },
            serializeDatabase: async () => {
                throw new Error('paged save must not fall back to a second merged export');
            }
        };
        doc = createDocBypassingFactory(
            pagedOps,
            createFileUri('/test/paged.db'),
            async () => {
                events.push('reopen');
                return { databaseOps: replacementOps, isReadOnly: false, storage: 'paged' };
            },
            { initialStorage: 'paged' }
        );

        await doc.save();

        assert.deepStrictEqual(events, ['write', 'reopen']);
        assert.strictEqual(doc.databaseOperations, replacementOps);
        assert.strictEqual(doc.isReadOnlyMode, false);
        assert.strictEqual(doc.connectionGeneration, 1);
    });

    it('save: drains a deferred atomic batch before advancing the connection generation', async () => {
        const mutationStarted = createDeferred<void>();
        const finishMutation = createDeferred<void>();
        const events: string[] = [];
        let liveValue = 'before';
        let savedValue = 'before';
        const rawOps = {
            engineKind: Promise.resolve('wasm' as const),
            updateCellBatch: async () => {
                events.push('mutation-start');
                mutationStarted.resolve();
                await finishMutation.promise;
                liveValue = 'after';
                events.push('mutation-finish');
                return [{
                    rowId: 1,
                    columnName: 'value',
                    priorValue: 'before',
                    newValue: 'after',
                    operation: 'set' as const
                }];
            },
            ping: async () => {
                events.push('drain');
                return true;
            },
            writeToFile: async () => {
                events.push('write');
                savedValue = liveValue;
                return { requiresReopen: true };
            }
        };
        const replacementOps = {
            engineKind: Promise.resolve('wasm' as const),
            ping: async () => true
        };
        const contentChanges: unknown[] = [];
        const doc = createDocBypassingFactory(
            serializeOperations(rawOps as any),
            createFileUri('/test/paged-deferred-edit.db'),
            async () => ({ databaseOps: replacementOps, isReadOnly: false, storage: 'paged' }),
            { initialStorage: 'paged' }
        );
        doc.onDidChangeContent((event: unknown) => contentChanges.push(event));

        const editPromise = doc.hostBridge.updateCellBatch(
            'keyed',
            [{ rowId: 1, column: 'value', value: 'after' }],
            'Deferred batch'
        );
        await mutationStarted.promise;
        const savePromise = doc.save();
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(
            doc.isReadOnlyMode,
            false,
            'the connection generation must remain valid while the tracked mutation drains'
        );
        await assert.rejects(
            doc.runTrackedMutation(async () => 'late mutation'),
            /temporarily read-only.*save is in progress/i
        );
        finishMutation.resolve();

        await editPromise;
        await savePromise;

        assert.strictEqual(savedValue, 'after');
        assert.deepStrictEqual(events, ['mutation-start', 'mutation-finish', 'drain', 'write']);
        assert.strictEqual(doc.databaseOperations, replacementOps);
        assert.strictEqual((await doc.getDesktopTestState()).dirty, false);
        assert.strictEqual(contentChanges.length, 1, 'the saved edit must remain represented in history');
    });

    it('save: rejects undo for the whole paged replacement window', async () => {
        const writeStarted = createDeferred<void>();
        const finishWrite = createDeferred<void>();
        let undoCalls = 0;
        const replacementOps = {
            engineKind: Promise.resolve('wasm' as const),
            ping: async () => true
        };
        const doc = createDocBypassingFactory(
            {
                engineKind: Promise.resolve('wasm' as const),
                ping: async () => true,
                writeToFile: async () => {
                    writeStarted.resolve();
                    await finishWrite.promise;
                    return { requiresReopen: true };
                },
                undoModification: async () => { undoCalls++; }
            },
            createFileUri('/test/paged-undo-gate.db'),
            async () => ({ databaseOps: replacementOps, isReadOnly: false, storage: 'paged' }),
            { initialStorage: 'paged' }
        );
        let undo: (() => Promise<void>) | undefined;
        doc.onDidChange((event: { undo(): Promise<void> }) => { undo = event.undo; });
        doc.recordModification({
            label: 'Update before save',
            description: 'Update keyed.value',
            modificationType: 'cell_update',
            targetTable: 'keyed',
            targetRowId: 1,
            targetColumn: 'value',
            priorValue: 'before',
            newValue: 'after'
        });

        const savePromise = doc.save();
        await writeStarted.promise;
        await assert.rejects(undo!(), /temporarily read-only.*save is in progress/i);
        assert.strictEqual(undoCalls, 0);

        finishWrite.resolve();
        await savePromise;
        assert.strictEqual((await doc.getDesktopTestState()).dirty, false);
    });

    it('save: a concurrent paged save cannot thaw the active save owner', async () => {
        const writeStarted = createDeferred<void>();
        const finishWrite = createDeferred<void>();
        let writeCalls = 0;
        const replacementOps = {
            engineKind: Promise.resolve('wasm' as const),
            ping: async () => true
        };
        const doc = createDocBypassingFactory(
            {
                engineKind: Promise.resolve('wasm' as const),
                ping: async () => true,
                writeToFile: async () => {
                    writeCalls++;
                    writeStarted.resolve();
                    await finishWrite.promise;
                    return { requiresReopen: true };
                }
            },
            createFileUri('/test/paged-concurrent-save.db'),
            async () => ({ databaseOps: replacementOps, isReadOnly: false, storage: 'paged' }),
            { initialStorage: 'paged' }
        );

        const firstSave = doc.save();
        await writeStarted.promise;
        await assert.rejects(doc.save(), /document is read-only|save is already in progress/i);
        assert.strictEqual(doc.isReadOnlyMode, true);
        assert.strictEqual(writeCalls, 1);

        finishWrite.resolve();
        await firstSave;
        assert.strictEqual(doc.isReadOnlyMode, false);
    });

    it('save: always reconnects after a successful same-path paged write', async () => {
        const events: string[] = [];
        let serializeCalled = false;
        const replacementOps = { engineKind: Promise.resolve('wasm') };
        const pagedOps = {
            engineKind: Promise.resolve('wasm'),
            writeToFile: async () => {
                events.push('write');
                // Same-path save owns the active base regardless of metadata.
                return { requiresReopen: false };
            },
            serializeDatabase: async () => {
                serializeCalled = true;
                return new Uint8Array();
            }
        };
        const doc = createDocBypassingFactory(
            pagedOps,
            createFileUri('/test/paged-no-reopen.db'),
            async () => {
                events.push('reopen');
                return { databaseOps: replacementOps, isReadOnly: false, storage: 'paged' };
            },
            { initialStorage: 'paged' }
        );

        await doc.save();

        assert.strictEqual(serializeCalled, false);
        assert.deepStrictEqual(events, ['write', 'reopen']);
        assert.strictEqual(doc.databaseOperations, replacementOps);
        assert.strictEqual(doc.isReadOnlyMode, false);
        assert.strictEqual(doc.connectionGeneration, 1);
    });

    it('save: surfaces a paged mid-transaction refusal without buffer fallback', async () => {
        const midEditError = new Error(
            'Cannot save while a database transaction is open; retry after the edit completes.'
        );
        let serializeCalled = false;
        let reconnectCalled = false;
        const doc = createDocBypassingFactory(
            {
                engineKind: Promise.resolve('wasm'),
                writeToFile: async () => { throw midEditError; },
                serializeDatabase: async () => {
                    serializeCalled = true;
                    return new Uint8Array();
                }
            },
            createFileUri('/test/paged-mid-edit.db'),
            async () => {
                reconnectCalled = true;
                throw new Error('must not reconnect when no rename occurred');
            },
            { initialStorage: 'paged' }
        );

        await assert.rejects(doc.save(), midEditError);

        assert.strictEqual(serializeCalled, false);
        assert.strictEqual(reconnectCalled, false);
        assert.strictEqual(doc.isReadOnlyMode, false, 'failed export must leave the overlay editable');
        assert.strictEqual(doc.connectionGeneration, 1, 'in-flight pre-save mutations remain invalidated');
    });

    it('save: preserves the dirty paged overlay after a base-generation TOCTOU failure', async () => {
        const baseChangedError = new Error(
            'The database base changed while the paged save was in progress.'
        );
        let serializeCalled = false;
        let reconnectCalled = false;
        const pagedOps = {
            engineKind: Promise.resolve('wasm'),
            writeToFile: async () => { throw baseChangedError; },
            serializeDatabase: async () => {
                serializeCalled = true;
                return new Uint8Array();
            }
        };
        const doc = createDocBypassingFactory(
            pagedOps,
            createFileUri('/test/paged-base-changed.db'),
            async () => {
                reconnectCalled = true;
                throw new Error('must not reconnect when the active base was not replaced');
            },
            { initialStorage: 'paged' }
        );
        doc.recordModification({
            label: 'Unsaved paged update',
            description: 'Update items.value',
            modificationType: 'cell_update',
            targetTable: 'items',
            targetRowId: 1,
            targetColumn: 'value',
            priorValue: 'before',
            newValue: 'after'
        });

        await assert.rejects(doc.save(), baseChangedError);

        const state = await doc.getDesktopTestState();
        assert.strictEqual(serializeCalled, false, 'TOCTOU refusal must not materialize a fallback image');
        assert.strictEqual(reconnectCalled, false, 'an unchanged target must not reconnect');
        assert.strictEqual(doc.databaseOperations, pagedOps, 'the original overlay engine must remain active');
        assert.strictEqual(state.storage, 'paged');
        assert.strictEqual(state.dirty, true, 'the rejected save must not checkpoint overlay edits');
        assert.strictEqual(state.readOnly, false, 'the original overlay must become editable again');
        assert.strictEqual(doc.connectionGeneration, 1, 'in-flight pre-save mutations remain invalidated');
    });

    for (const operation of ['save', 'saveAs'] as const) {
        it(`${operation}: cancellation aborts a paged write and releases the mutation barrier`, async () => {
            const writerStarted = createDeferred<void>();
            const releaseWriter = createDeferred<void>();
            let receivedSignal: AbortSignal | undefined;
            let reconnectCalls = 0;
            let cancellationListener: (() => void) | undefined;
            let cancelled = false;
            const token = {
                get isCancellationRequested() { return cancelled; },
                onCancellationRequested(listener: () => void) {
                    cancellationListener = listener;
                    return { dispose() { cancellationListener = undefined; } };
                }
            } as any;
            const pagedOps = {
                engineKind: Promise.resolve('wasm' as const),
                ping: async () => true,
                writeToFile: async (_filePath: string, signal?: AbortSignal) => {
                    receivedSignal = signal;
                    writerStarted.resolve();
                    await releaseWriter.promise;
                    signal?.throwIfAborted();
                    return { requiresReopen: operation === 'save' };
                },
                serializeDatabase: async () => {
                    throw new Error('cancelled paged save must not use a whole-image fallback');
                }
            };
            const doc = createDocBypassingFactory(
                pagedOps,
                createFileUri('/test/paged-cancel.db'),
                async () => {
                    reconnectCalls++;
                    return {
                        databaseOps: { engineKind: Promise.resolve('wasm' as const) },
                        isReadOnly: false,
                        storage: 'paged'
                    };
                },
                { initialStorage: 'paged' }
            );
            doc.recordModification({
                label: 'Unsaved paged update',
                description: 'Update items.value',
                modificationType: 'cell_update',
                targetTable: 'items',
                targetRowId: 1,
                targetColumn: 'value',
                priorValue: 'before',
                newValue: 'after'
            });

            const pending = operation === 'save'
                ? doc.save(token)
                : doc.saveAs(createFileUri('/test/paged-cancel-copy.db'), token);
            await writerStarted.promise;
            cancelled = true;
            cancellationListener?.();
            releaseWriter.resolve();

            await assert.rejects(
                pending,
                (error: Error) => error.name === 'Canceled'
            );
            assert.strictEqual(receivedSignal?.aborted, true);
            assert.strictEqual(reconnectCalls, 0);
            assert.strictEqual(doc.databaseOperations, pagedOps);
            const state = await doc.getDesktopTestState();
            assert.strictEqual(state.storage, 'paged');
            assert.strictEqual(state.dirty, true);
            assert.strictEqual(state.readOnly, false);
            assert.strictEqual(
                await doc.runTrackedMutation(async () => 'mutation admitted'),
                'mutation admitted'
            );
        });
    }

    for (const operation of ['save', 'saveAs'] as const) {
        it(`${operation}: Reload recovers a paged session after rename succeeds but reconnect fails`, async () => {
            const replacementOps = {
                engineKind: Promise.resolve('wasm' as const),
                ping: async () => true
            };
            let reconnectCalls = 0;
            const doc = createDocBypassingFactory(
                {
                    engineKind: Promise.resolve('wasm' as const),
                    ping: async () => true,
                    writeToFile: async () => ({ requiresReopen: true }),
                    serializeDatabase: async () => {
                        throw new Error('paged recovery must not materialize a fallback image');
                    }
                },
                createFileUri('/test/paged-recovery.db'),
                async () => {
                    reconnectCalls++;
                    if (reconnectCalls === 1) {
                        throw new Error('synthetic post-rename reconnect failure');
                    }
                    return { databaseOps: replacementOps, isReadOnly: false, storage: 'paged' };
                },
                { initialStorage: 'paged' }
            );

            const save = operation === 'save'
                ? () => doc.save()
                : () => doc.saveAs(createFileUri('/test/paged-recovery-alias.db'), undefined);
            await assert.rejects(save, /database was saved.*reload the document/i);
            await assert.rejects(
                doc.runTrackedMutation(async () => 'ordinary mutation'),
                /temporarily read-only.*save is in progress/i
            );

            const refreshed = await doc.hostBridge.refreshFile();
            assert.strictEqual(refreshed.connected, true);
            assert.strictEqual(doc.databaseOperations, replacementOps);
            assert.strictEqual(doc.isReadOnlyMode, false);
            assert.strictEqual(
                await doc.runTrackedMutation(async () => 'mutations restored'),
                'mutations restored'
            );
            assert.strictEqual(reconnectCalls, 2);
        });
    }

    it('saveAs: writes a paged merged image directly without reopening the base', async () => {
        let writtenPath: string | undefined;
        let serializeCalled = false;
        let reconnectCalled = false;
        const doc = createDocBypassingFactory(
            {
                engineKind: Promise.resolve('wasm'),
                writeToFile: async (filePath: string) => {
                    assert.strictEqual(doc.isReadOnlyMode, true);
                    assert.strictEqual(doc.connectionGeneration, 1);
                    writtenPath = filePath;
                    return { requiresReopen: false };
                },
                serializeDatabase: async () => {
                    serializeCalled = true;
                    throw new Error('paged Save As must not export twice');
                }
            },
            createFileUri('/test/paged.db'),
            async () => {
                reconnectCalled = true;
                throw new Error('Save As must not replace the active base');
            },
            { initialStorage: 'paged' }
        );

        await doc.saveAs(createFileUri('/test/paged-copy.db'), undefined);

        assert.strictEqual(writtenPath, '/test/paged-copy.db');
        assert.strictEqual(serializeCalled, false);
        assert.strictEqual(reconnectCalled, false);
        assert.strictEqual(doc.isReadOnlyMode, false);
        assert.strictEqual(doc.connectionGeneration, 1);
    });

    it('saveAs: reopens when the target resolves to the active paged base', async () => {
        const events: string[] = [];
        const replacementOps = { engineKind: Promise.resolve('wasm') };
        let doc: any;
        doc = createDocBypassingFactory(
            {
                engineKind: Promise.resolve('wasm'),
                writeToFile: async () => {
                    events.push('write');
                    assert.strictEqual(doc.isReadOnlyMode, true);
                    return { requiresReopen: true };
                },
                serializeDatabase: async () => {
                    throw new Error('paged Save As must not export twice');
                }
            },
            createFileUri('/test/paged.db'),
            async () => {
                events.push('reopen');
                return { databaseOps: replacementOps, isReadOnly: false, storage: 'paged' };
            },
            { initialStorage: 'paged' }
        );

        await doc.saveAs(createFileUri('/test/paged-alias.db'), undefined);

        assert.deepStrictEqual(events, ['write', 'reopen']);
        assert.strictEqual(doc.databaseOperations, replacementOps);
        assert.strictEqual(doc.isReadOnlyMode, false);
        assert.strictEqual(doc.connectionGeneration, 1);
    });

    it('saveAs: surfaces a paged mid-transaction refusal without buffer fallback', async () => {
        const midEditError = new Error(
            'Cannot save while a database transaction is open; retry after the edit completes.'
        );
        let serializeCalled = false;
        const doc = createDocBypassingFactory(
            {
                engineKind: Promise.resolve('wasm'),
                writeToFile: async () => { throw midEditError; },
                serializeDatabase: async () => {
                    serializeCalled = true;
                    return new Uint8Array();
                }
            },
            createFileUri('/test/paged.db'),
            async () => {},
            { initialStorage: 'paged' }
        );

        await assert.rejects(
            doc.saveAs(createFileUri('/test/paged-copy.db'), undefined),
            midEditError
        );
        assert.strictEqual(serializeCalled, false);
        assert.strictEqual(doc.isReadOnlyMode, false);
        assert.strictEqual(doc.connectionGeneration, 1);
    });

    it('saveAs: refuses a paged non-file target before stat, serialization, or write', async () => {
        const targetUri = createUri('vscode-vfs', '/github/user/repo/paged-copy.db');
        let writeToFileCalled = false;
        let serializeCalled = false;
        let statCalled = false;
        let workspaceWriteCalled = false;
        const doc = createDocBypassingFactory(
            {
                engineKind: Promise.resolve('wasm'),
                writeToFile: async () => { writeToFileCalled = true; },
                serializeDatabase: async () => {
                    serializeCalled = true;
                    return new Uint8Array();
                }
            },
            createFileUri('/test/paged.db'),
            async () => {},
            { initialStorage: 'paged' }
        );

        const originalFs = mockVscode.workspace.fs;
        Object.defineProperty(mockVscode.workspace, 'fs', {
            value: {
                ...originalFs,
                stat: async () => {
                    statCalled = true;
                    return { size: 1 };
                },
                writeFile: async () => { workspaceWriteCalled = true; }
            } as any,
            writable: true,
            configurable: true
        });

        try {
            await assert.rejects(
                () => doc.saveAs(targetUri, undefined),
                (error: Error) => {
                    assert.match(error.message, /non-file providers.*required streaming path/i);
                    assert.match(error.message, /save locally, then copy the file/i);
                    return true;
                }
            );
            assert.strictEqual(statCalled, false);
            assert.strictEqual(writeToFileCalled, false);
            assert.strictEqual(serializeCalled, false);
            assert.strictEqual(workspaceWriteCalled, false);
        } finally {
            Object.defineProperty(mockVscode.workspace, 'fs', {
                value: originalFs,
                writable: true,
                configurable: true
            });
        }
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
        doc.onDidChangeContent((event: any) => applied.push({
            modification: event.modification,
            direction: event.modificationDirection
        }));
        doc.onDidChange((event: any) => {
            undo = event.undo;
            redo = event.redo;
        });

        doc.recordExternalModification(modification);
        await undo!();
        await redo!();

        assert.deepStrictEqual(applied, [
            { modification, direction: 'forward' },
            { modification, direction: 'undo' },
            { modification, direction: 'forward' }
        ]);
    });

    it('surfaces the oversized-edit barrier while a later normal edit still undoes and redoes', async () => {
        const undoCalls: unknown[] = [];
        const redoCalls: unknown[] = [];
        const dbOps = {
            undoModification: async (entry: unknown) => { undoCalls.push(entry); },
            redoModification: async (entry: unknown) => { redoCalls.push(entry); }
        };
        const doc = createDocBypassingFactory(dbOps);
        const actions = new Map<string, { undo(): Promise<void>; redo(): Promise<void> }>();
        doc.onDidChange((event: any) => actions.set(event.label, event));

        const originalShowWarningMessage = mockVscode.window.showWarningMessage;
        const warnings: string[] = [];
        mockVscode.window.showWarningMessage = async (message?: string) => {
            warnings.push(String(message));
            return undefined;
        };
        try {
            doc.recordModification({
                label: 'Before Barrier',
                description: 'old edit',
                modificationType: 'cell_update'
            });
            doc.recordModification({
                label: 'Replace Oversized Cell',
                description: 'forward-only replacement',
                modificationType: 'cell_update',
                targetTable: 'items',
                targetRowId: 1,
                targetColumn: 'payload',
                newValue: 'bounded',
                undoPolicy: 'barrier'
            });
            const normal = {
                label: 'After Barrier',
                description: 'normal edit',
                modificationType: 'cell_update' as const,
                targetTable: 'items',
                targetRowId: 2,
                targetColumn: 'name',
                priorValue: 'a',
                newValue: 'b'
            };
            doc.recordModification(normal);

            await actions.get('After Barrier')!.undo();
            assert.deepStrictEqual(undoCalls, [normal]);

            await actions.get('Replace Oversized Cell')!.undo();
            assert.deepStrictEqual(undoCalls, [normal]);
            assert.strictEqual(warnings.length, 1);
            assert.match(warnings[0], /cannot be undone/i);
            assert.match(warnings[0], /oversized cell/i);

            await actions.get('After Barrier')!.redo();
            assert.deepStrictEqual(redoCalls, [normal]);
        } finally {
            mockVscode.window.showWarningMessage = originalShowWarningMessage;
        }
    });

    it('blocks backend edits at a saturated barrier segment, warns once, and resumes after Save', async () => {
        let backendCalls = 0;
        const dbOps = {
            engineKind: Promise.resolve('native' as const),
            executeQuery: async () => [],
            updateCellBatch: async () => {
                backendCalls++;
                return [{
                    rowId: 1,
                    columnName: 'value',
                    priorValue: 'before',
                    newValue: 'after',
                    operation: 'set' as const
                }];
            }
        };
        const doc = createDocBypassingFactory(dbOps);
        const warnings: string[] = [];
        const originalShowWarningMessage = mockVscode.window.showWarningMessage;
        mockVscode.window.showWarningMessage = async (message?: string) => {
            warnings.push(String(message));
            return undefined;
        };
        let backupContent: Uint8Array | undefined;
        const originalFs = mockVscode.workspace.fs;
        Object.defineProperty(mockVscode.workspace, 'fs', {
            value: {
                ...originalFs,
                writeFile: async (_uri: unknown, content: Uint8Array) => {
                    backupContent = content;
                }
            },
            writable: true,
            configurable: true
        });

        try {
            doc.recordModification({
                label: 'Barrier',
                description: 'forward-only replacement',
                modificationType: 'cell_update',
                undoPolicy: 'barrier'
            });
            for (let index = 0; index < 99; index++) {
                doc.recordModification({
                    label: `Later ${index}`,
                    description: `Later ${index}`,
                    modificationType: 'cell_update'
                });
            }

            await doc.backup(createUri('vscode-userdata', '/backups/saturated.db'), undefined);
            assert.ok(backupContent);
            const restored = ModificationTracker.deserialize<LabeledModification>(
                backupContent,
                100
            );
            assert.deepStrictEqual(
                restored.getUncommittedEntries().map(entry => entry.label),
                ['Barrier', ...Array.from({ length: 99 }, (_, index) => `Later ${index}`)]
            );

            await assert.rejects(
                doc.hostBridge.updateCellBatch(
                    'items',
                    [{ rowId: 1, column: 'value', value: 'after' }],
                    'Blocked edit'
                ),
                /undo history.*limit.*save.*before making more changes/i
            );
            assert.strictEqual(backendCalls, 0, 'the rejected edit must not reach SQLite');
            assert.strictEqual((await doc.getDesktopTestState()).dirty, true);
            assert.strictEqual(warnings.length, 1);
            assert.match(warnings[0], /undo history.*limit/i);
            assert.match(warnings[0], /save.*before making more changes/i);

            await doc.save();
            await doc.hostBridge.updateCellBatch(
                'items',
                [{ rowId: 1, column: 'value', value: 'after' }],
                'Allowed after Save'
            );
            assert.strictEqual(backendCalls, 1);
            assert.strictEqual(warnings.length, 1, 'one saturated segment emits one warning');
        } finally {
            mockVscode.window.showWarningMessage = originalShowWarningMessage;
            Object.defineProperty(mockVscode.workspace, 'fs', {
                value: originalFs,
                writable: true,
                configurable: true
            });
        }
    });

    it('admits only one concurrent backend edit when a barrier segment has one slot left', async () => {
        let backendCalls = 0;
        const dbOps = {
            engineKind: Promise.resolve('native' as const),
            executeQuery: async () => [],
            updateCellBatch: async (_table: string, updates: any[]) => {
                backendCalls++;
                return [{
                    rowId: updates[0].rowId,
                    columnName: updates[0].column,
                    priorValue: 'before',
                    newValue: updates[0].value,
                    operation: 'set' as const
                }];
            }
        };
        const doc = createDocBypassingFactory(dbOps);
        doc.recordModification({
            label: 'Barrier',
            description: 'forward-only replacement',
            modificationType: 'cell_update',
            undoPolicy: 'barrier'
        });
        for (let index = 0; index < 98; index++) {
            doc.recordModification({
                label: `Later ${index}`,
                description: `Later ${index}`,
                modificationType: 'cell_update'
            });
        }

        const outcomes = await Promise.allSettled([
            doc.hostBridge.updateCellBatch(
                'items',
                [{ rowId: 1, column: 'value', value: 'first' }],
                'First contender'
            ),
            doc.hostBridge.updateCellBatch(
                'items',
                [{ rowId: 2, column: 'value', value: 'second' }],
                'Second contender'
            )
        ]);

        assert.strictEqual(backendCalls, 1, 'the losing admission must stop before SQLite');
        assert.strictEqual(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
        const rejection = outcomes.find(outcome => outcome.status === 'rejected');
        assert.ok(rejection && rejection.status === 'rejected');
        assert.match(
            String(rejection.reason?.message ?? rejection.reason),
            /undo history.*limit.*save.*before making more changes/i
        );
    });

    it('refuses File Revert before an unsaved oversized-edit barrier can write a fake prior value', async () => {
        const discardCalls: unknown[][] = [];
        const doc = createDocBypassingFactory({
            discardModifications: async (entries: unknown[]) => { discardCalls.push(entries); }
        });
        doc.recordExternalModification({
            label: 'Replace Oversized Cell',
            description: 'forward-only replacement',
            modificationType: 'cell_update',
            targetTable: 'items',
            targetRowId: 1,
            targetColumn: 'payload',
            newValue: 'bounded',
            undoPolicy: 'barrier'
        });
        for (let index = 0; index < 10; index++) {
            doc.recordExternalModification({
                label: `Later edit ${index}`,
                description: `Later edit ${index}`,
                modificationType: 'cell_update',
                targetTable: 'items',
                targetRowId: index + 2,
                targetColumn: 'name',
                priorValue: 'before',
                newValue: 'after'
            });
        }

        const originalShowWarningMessage = mockVscode.window.showWarningMessage;
        const warnings: string[] = [];
        mockVscode.window.showWarningMessage = async (message?: string) => {
            warnings.push(String(message));
            return undefined;
        };
        try {
            await assert.rejects(
                doc.revert(undefined),
                /File Revert cannot cross an unsaved oversized-cell history barrier/
            );
            assert.deepStrictEqual(discardCalls, []);
            assert.strictEqual(warnings.length, 1);
            assert.match(warnings[0], /save the database first/i);
            assert.match(warnings[0], /prior value was not retained/i);
        } finally {
            mockVscode.window.showWarningMessage = originalShowWarningMessage;
        }
    });

    it('File Revert discards a persistent-PRAGMA barrier by reopening saved bytes', async () => {
        let discardCalls = 0;
        const originalOps = {
            engineKind: Promise.resolve('wasm' as const),
            discardModifications: async () => { discardCalls++; }
        };
        const replacementOps = { engineKind: Promise.resolve('wasm' as const) };
        const doc = createDocBypassingFactory(
            originalOps,
            createFileUri('/test/paged-pragma-revert.db'),
            async () => ({ databaseOps: replacementOps, isReadOnly: false, storage: 'paged' }),
            { initialStorage: 'paged' }
        );
        doc.recordModification({
            label: 'Change PRAGMA auto_vacuum',
            description: 'Set PRAGMA auto_vacuum',
            modificationType: 'pragma_update',
            targetPragma: 'auto_vacuum',
            priorValue: 0,
            newValue: 1,
            undoPolicy: 'barrier',
            undoBarrierKind: 'persistent_pragma'
        });
        assert.strictEqual((await doc.getDesktopTestState()).dirty, true);

        await doc.revert(undefined);

        assert.strictEqual(discardCalls, 0);
        assert.strictEqual(doc.databaseOperations, replacementOps);
        assert.strictEqual((await doc.getDesktopTestState()).dirty, false);
    });

    it('invalidates every open view document after File Revert', async () => {
        const doc = createDocBypassingFactory({});
        const contentChanges: unknown[] = [];
        doc.onDidChangeContent((event: unknown) => contentChanges.push(event));

        await doc.revert(undefined);

        assert.deepStrictEqual(contentChanges, [{ invalidateAllViewDocuments: true }]);
    });

    it('replaces connection capabilities and invalidates view documents after Reload', async () => {
        const originalOps = { engineKind: Promise.resolve('wasm') };
        const replacementOps = { engineKind: Promise.resolve('wasm') };
        const connectionCalls: unknown[][] = [];
        const doc = createDocBypassingFactory(
            originalOps,
            createFileUri('/test/db.sqlite'),
            async (...args: unknown[]) => {
                connectionCalls.push(args);
                return { databaseOps: replacementOps, isReadOnly: true };
            }
        );
        const contentChanges: unknown[] = [];
        doc.onDidChangeContent((event: unknown) => contentChanges.push(event));

        const reloaded = await doc.reloadFromDisk();

        assert.strictEqual(reloaded, replacementOps);
        assert.strictEqual(doc.databaseOperations, replacementOps);
        assert.strictEqual(doc.isReadOnlyMode, true);
        assert.strictEqual(connectionCalls.length, 1);
        assert.deepStrictEqual(contentChanges, [{ invalidateAllViewDocuments: true }]);
    });

    it('advances the connection generation as soon as Reload starts', async () => {
        const engineKind = createDeferred<'native'>();
        const doc = createDocBypassingFactory({ engineKind: engineKind.promise });

        assert.strictEqual(doc.connectionGeneration, 0);
        const pendingReload = doc.reloadFromDisk();
        assert.strictEqual(
            doc.connectionGeneration,
            1,
            'in-flight host mutations must observe Reload before its first await completes'
        );

        engineKind.resolve('native');
        await pendingReload;
    });

    it('preserves forced read-only, auto-commit, and SQL logging when reconnecting', async () => {
        const originalOps = { engineKind: Promise.resolve('wasm') };
        let freshQueryCalls = 0;
        const freshOps = {
            engineKind: Promise.resolve('wasm'),
            executeQuery: async () => {
                freshQueryCalls++;
                return [{ headers: ['value'], rows: [[1]] }];
            }
        };
        const connectionCalls: unknown[][] = [];
        const loggedLines: string[] = [];
        const doc = createDocBypassingFactory(
            originalOps,
            mockVscode.Uri.file('/test/reconnect.db'),
            async (...args: unknown[]) => {
                connectionCalls.push(args);
                return { databaseOps: freshOps, isReadOnly: true };
            },
            {
                forceReadOnly: true,
                autoCommitEnabled: true,
                outputChannel: { appendLine: message => loggedLines.push(message) }
            }
        );

        const reloaded = await doc.reloadFromDisk();
        const queryResult = await reloaded.executeQuery('SELECT 1');

        assert.deepStrictEqual(connectionCalls, [[
            doc.uri,
            'reconnect.db',
            true,
            true
        ]]);
        assert.strictEqual(doc.isReadOnlyMode, true);
        assert.deepStrictEqual(queryResult[0].rows, [[1]]);
        assert.strictEqual(freshQueryCalls, 1);
        assert.strictEqual(loggedLines.length, 1);
        assert.match(loggedLines[0], /\[reconnect\.db\] SELECT 1/);
    });

    it('force-reloads saved bytes and rolls history back after a revert RPC timeout', async () => {
        const { InvocationTimeoutError } = require('../../src/core/rpc');
        const replacementOps = { engineKind: Promise.resolve('wasm') };
        let discardCalls = 0;
        const timedOutOps = {
            engineKind: Promise.resolve('wasm'),
            discardModifications: async () => {
                discardCalls++;
                throw new InvocationTimeoutError('discardModifications');
            }
        };
        const doc = createDocBypassingFactory(
            timedOutOps,
            createFileUri('/test/db.sqlite'),
            async () => ({ databaseOps: replacementOps, isReadOnly: false })
        );
        doc.recordModification({
            label: 'Update Cell',
            description: 'Update items.value',
            modificationType: 'cell_update',
            targetTable: 'items',
            targetRowId: 1,
            targetColumn: 'value',
            priorValue: 'before',
            newValue: 'after'
        });
        const contentChanges: unknown[] = [];
        doc.onDidChangeContent((event: unknown) => contentChanges.push(event));
        let backupContent: Uint8Array | undefined;
        const originalFs = mockVscode.workspace.fs;
        Object.defineProperty(mockVscode.workspace, 'fs', {
            value: {
                ...originalFs,
                writeFile: async (_uri: unknown, content: Uint8Array) => {
                    backupContent = content;
                }
            },
            writable: true,
            configurable: true
        });

        try {
            await doc.revert(undefined);
            await doc.backup(createUri('vscode-userdata', '/backups/test.db'), undefined);

            assert.strictEqual(discardCalls, 1);
            assert.strictEqual(doc.databaseOperations, replacementOps);
            assert.deepStrictEqual(contentChanges, [{ invalidateAllViewDocuments: true }]);
            assert.ok(backupContent);
            const restoredTracker = ModificationTracker.deserialize(backupContent);
            assert.strictEqual(restoredTracker.hasUncommittedChanges(), false);
        } finally {
            Object.defineProperty(mockVscode.workspace, 'fs', {
                value: originalFs,
                writable: true,
                configurable: true
            });
        }
    });

    it('reconnects a native database before rolling history back after a revert RPC timeout', async () => {
        const reconnectStarted = createDeferred<void>();
        const reconnectMayFinish = createDeferred<void>();
        const freshNativeOps = { engineKind: Promise.resolve('native') };
        let reconnectCalls = 0;
        const timedOutWorker = new NativeWorkerProcess('/fake/bin', '/fake/script');
        (timedOutWorker as any).process = {
            stdin: { write: () => true },
            kill: () => {}
        };
        const timedOutNativeOps = {
            engineKind: Promise.resolve('native'),
            executeQuery: async () => [],
            discardModifications: () => timedOutWorker.call('discardModifications', [], 1)
        };
        const doc = createDocBypassingFactory(
            timedOutNativeOps,
            createFileUri('/test/native.db'),
            async () => {
                reconnectCalls++;
                reconnectStarted.resolve(undefined);
                await reconnectMayFinish.promise;
                return { databaseOps: freshNativeOps, isReadOnly: false };
            }
        );
        const savedModification = {
            label: 'Saved Update',
            description: 'Update saved row',
            modificationType: 'cell_update' as const,
            targetTable: 'items',
            targetRowId: 1,
            targetColumn: 'value',
            priorValue: 'before-save',
            newValue: 'saved'
        };
        const unsavedModification = {
            label: 'Unsaved Update',
            description: 'Update unsaved row',
            modificationType: 'cell_update' as const,
            targetTable: 'items',
            targetRowId: 2,
            targetColumn: 'value',
            priorValue: 'before-draft',
            newValue: 'draft'
        };
        doc.recordModification(savedModification);
        await doc.save();
        doc.recordModification(unsavedModification);

        let backupContent: Uint8Array | undefined;
        const originalFs = mockVscode.workspace.fs;
        Object.defineProperty(mockVscode.workspace, 'fs', {
            value: {
                ...originalFs,
                writeFile: async (_uri: unknown, content: Uint8Array) => {
                    backupContent = content;
                }
            },
            writable: true,
            configurable: true
        });

        try {
            const pendingRevert = doc.revert(undefined);
            await reconnectStarted.promise;

            assert.strictEqual(reconnectCalls, 1, 'native recovery must open a fresh connection');
            await doc.backup(createUri('vscode-userdata', '/backups/native-before-reconnect.db'), undefined);
            assert.ok(backupContent);
            assert.strictEqual(
                ModificationTracker.deserialize(backupContent).hasUncommittedChanges(),
                true,
                'history must stay dirty until the fresh native connection is ready'
            );

            reconnectMayFinish.resolve();
            await pendingRevert;
            assert.strictEqual(doc.databaseOperations, freshNativeOps);

            backupContent = undefined;
            await doc.backup(createUri('vscode-userdata', '/backups/native-after-reconnect.db'), undefined);
            assert.ok(backupContent);
            assert.strictEqual(
                ModificationTracker.deserialize(backupContent).hasUncommittedChanges(),
                false,
                'history may be rolled back only after native reconnection completes'
            );
        } finally {
            reconnectMayFinish.resolve();
            timedOutWorker.stop();
            Object.defineProperty(mockVscode.workspace, 'fs', {
                value: originalFs,
                writable: true,
                configurable: true
            });
        }
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
        await engine.executeQuery(
            "CREATE TABLE restored_items (id INTEGER PRIMARY KEY, name TEXT, counter INTEGER)"
        );
        const unsafePriorValue = BigInt('9007199254740993');
        const unsafeNewValue = BigInt('9007199254740995');

        const restoredEntries: LabeledModification[] = [
            {
                label: 'Insert Restored Item',
                description: 'Insert restored item',
                modificationType: 'row_insert',
                targetTable: 'restored_items',
                targetRowId: 1,
                rowData: { id: 1, name: 'Draft', counter: unsafePriorValue }
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
            },
            {
                label: 'Update unsafe INTEGER',
                description: 'Update restored unsafe INTEGER exactly',
                modificationType: 'cell_update',
                targetTable: 'restored_items',
                targetRowId: 1,
                targetColumn: 'counter',
                priorValue: unsafePriorValue,
                newValue: unsafeNewValue
            }
        ];
        const tracker = new ModificationTracker<LabeledModification>(100);
        for (const entry of restoredEntries) {
            tracker.record(entry);
        }

        const backupData = tracker.serialize();
        let applyWasCalled = false;
        let appliedModificationCount = 0;
        let appliedModifications: ModificationEntry[] = [];
        let rawBigIntBindObserved = false;
        const wasmInstance = (engine as unknown as {
            instance: {
                iterateStatements(sql: string): Iterable<{
                    bind(params?: unknown[]): boolean;
                }>;
            };
        }).instance;
        const originalIterateStatements = wasmInstance.iterateStatements.bind(wasmInstance);
        wasmInstance.iterateStatements = function* (sql: string) {
            for (const statement of originalIterateStatements(sql)) {
                const originalBind = statement.bind.bind(statement);
                statement.bind = (params?: unknown[]) => {
                    if (params?.some(value => typeof value === 'bigint')) {
                        rawBigIntBindObserved = true;
                        throw new Error('BigInt reached the sql.js binding boundary');
                    }
                    return originalBind(params);
                };
                yield statement;
            }
        };
        const originalApplyModifications = engine.applyModifications.bind(engine);
        engine.applyModifications = async (mods, signal) => {
            applyWasCalled = true;
            appliedModificationCount = mods.length;
            appliedModifications = mods;
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
                "SELECT id, name, CAST(counter AS TEXT) FROM restored_items ORDER BY id"
            );

            assert.strictEqual(
                rawBigIntBindObserved,
                false,
                'hot-exit replay must normalize BigInt before binding through sql.js'
            );
            assert.strictEqual(applyWasCalled, true);
            assert.strictEqual(appliedModificationCount, 3);
            assert.deepStrictEqual(restoredRows[0].rows, [[1, 'Recovered', '9007199254740995']]);

            await engine.undoModification(appliedModifications[2]);
            const undoneCounter = await engine.executeQuery(
                'SELECT CAST(counter AS TEXT) FROM restored_items WHERE id = 1'
            );
            assert.deepStrictEqual(undoneCounter[0].rows, [['9007199254740993']]);
            assert.strictEqual(
                rawBigIntBindObserved,
                false,
                'unsafe INTEGER priorValue must also be normalized before sql.js undo binding'
            );
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

    it('keeps a failed hot-exit restore read-only across a later reconnect', async () => {
        const tracker = new ModificationTracker<LabeledModification>(100);
        tracker.record({
            label: 'Restore draft',
            description: 'Restore draft value',
            modificationType: 'cell_update',
            targetTable: 'items',
            targetRowId: 1,
            targetColumn: 'value',
            priorValue: 'saved',
            newValue: 'draft'
        });
        const backupData = tracker.serialize();
        const restoreOps = {
            engineKind: Promise.resolve('wasm' as const),
            applyModifications: async () => { throw new Error('restore failed'); }
        };
        const reconnectedOps = { engineKind: Promise.resolve('wasm' as const) };
        const connectionCalls: unknown[][] = [];
        const originalFs = mockVscode.workspace.fs;
        const originalShowErrorMessage = mockVscode.window.showErrorMessage;
        const moduleCache = require('module')._cache;
        const workerFactoryPath = require.resolve('../../src/workerFactory');
        const originalWorkerFactoryCacheEntry = moduleCache[workerFactoryPath];
        const databaseModelModulePath = require.resolve('../../src/databaseModel');

        Object.defineProperty(mockVscode.workspace, 'fs', {
            value: { ...originalFs, readFile: async () => backupData },
            writable: true,
            configurable: true
        });
        mockVscode.window.showErrorMessage = async () => undefined;
        moduleCache[workerFactoryPath] = {
            id: workerFactoryPath,
            filename: workerFactoryPath,
            loaded: true,
            exports: {
                createDatabaseConnection: async () => ({
                    establishConnection: async (...args: unknown[]) => {
                        connectionCalls.push(args);
                        return connectionCalls.length === 1
                            ? { databaseOps: restoreOps, isReadOnly: false }
                            : { databaseOps: reconnectedOps, isReadOnly: true };
                    },
                    workerMethods: { [Symbol.dispose]: () => {} }
                })
            }
        };
        delete moduleCache[databaseModelModulePath];

        try {
            const { DatabaseDocument } = require('../../src/databaseModel');
            const doc = await DatabaseDocument.create(
                {
                    reporter: undefined,
                    isVerified: true,
                    context: { extensionUri: mockVscode.Uri.file('/ext') },
                    forceReadOnly: false,
                    outputChannel: undefined
                },
                mockVscode.Uri.file('/test/failed-restore.db'),
                { backupId: 'vscode-userdata:///backup/failed-restore.db' }
            );

            assert.strictEqual(doc.isReadOnlyMode, true);
            await doc.reloadFromDisk();
            assert.strictEqual(connectionCalls.length, 2);
            assert.strictEqual(
                connectionCalls[1][2],
                true,
                'the reconnect must retain the safety downgrade from failed restore'
            );
        } finally {
            Object.defineProperty(mockVscode.workspace, 'fs', {
                value: originalFs,
                writable: true,
                configurable: true
            });
            mockVscode.window.showErrorMessage = originalShowErrorMessage;
            if (originalWorkerFactoryCacheEntry) {
                moduleCache[workerFactoryPath] = originalWorkerFactoryCacheEntry;
            } else {
                delete moduleCache[workerFactoryPath];
            }
            delete moduleCache[databaseModelModulePath];
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
                    const databaseOps = {
                        engineKind: Promise.resolve('native' as const),
                        undoModification: () => Promise.resolve(),
                        redoModification: () => Promise.resolve(),
                        close: () => Promise.resolve(),
                        getSchema: () => Promise.resolve([]),
                        query: () => Promise.resolve([])
                    };
                    return Promise.resolve({
                        workerMethods: {
                            open: () => Promise.resolve({ isReadOnly: false, bufferInfo: {} }),
                            exec: () => Promise.resolve(),
                        },
                        establishConnection: () => Promise.resolve({
                            isReadOnly: false,
                            databaseOps
                        }),
                        databaseOps
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
        let undoAttempts = 0;
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
            dbOps.undoModification = () => {
                undoAttempts++;
                return Promise.reject(new Error("Test Undo Error"));
            };
        } else {
             // force override via any
             (doc as any).connectionState = {
                databaseOps: {
                    undoModification: () => {
                        undoAttempts++;
                        return Promise.reject(new Error("Test Undo Error"));
                    },
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
        await undoAction();

        assert.strictEqual(errorMessageShown, true, 'Error message should be shown for failed undo');
        assert.strictEqual(undoAttempts, 2, 'A failed undo must remain available for retry');
    });

    it('should show error message when redoModification fails', async () => {
        let errorMessageShown = false;
        let redoAttempts = 0;
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
             dbOps.redoModification = () => {
                 redoAttempts++;
                 return Promise.reject(new Error("Test Redo Error"));
             };
        } else {
            (doc as any).connectionState = {
                databaseOps: {
                    undoModification: () => Promise.resolve(),
                    redoModification: () => {
                        redoAttempts++;
                        return Promise.reject(new Error("Test Redo Error"));
                    }
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
        await redoAction();

        assert.strictEqual(errorMessageShown, true, 'Error message should be shown for failed redo');
        assert.strictEqual(redoAttempts, 2, 'A failed redo must remain available for retry');
    });
});
