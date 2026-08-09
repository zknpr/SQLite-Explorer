import './vscode_mock_setup';

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { DEFAULT_INVOCATION_TIMEOUT_MS } from '../../src/core/rpc';

// 1. Mock module cache before importing the module under test
const moduleCache = require('module')._cache;

let connectionFailed = false;
let workerTerminated = false;
let exposedWorkerMethods: string[] = [];
let workerProxy: Record<string, (...args: any[]) => any> = {};
let workerTimeoutPolicy: ((methodName: string, parameters: readonly unknown[]) => number) | undefined;
let pagedHostSaveCalls: unknown[][] = [];
let nativeAvailable = false;
let nativeAvailabilityChecks = 0;
let nativeConnectionCalls = 0;
let outputLines: string[] = [];

const Module = require('module');

// Provide a polyfill for import.meta.env to prevent crashes during TSX evaluation.
// We intercept compilation of workerFactory to inject the polyfill at the top of the file.
const originalCompile = Module.prototype._compile;
Module.prototype._compile = function(content: string, filename: string) {
    if (filename.endsWith('workerFactory.ts')) {
        content = `const import_meta_env = { VSCODE_BROWSER_EXT: false };\n` + content.replace(/import\.meta\.env/g, 'import_meta_env');
    }
    return originalCompile.call(this, content, filename);
};

// We need to intercept required modules in the compiled code
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id: string) {
    if (id === 'vscode') return require('./mocks/vscode').mockVscode;
    if (id.endsWith('core/rpc')) {
        return {
          connectWorkerPort: (
            _port: unknown,
            methods: string[],
            _onLog?: unknown,
            timeoutPolicy?: (methodName: string, parameters: readonly unknown[]) => number
          ) => {
            exposedWorkerMethods = methods;
            workerTimeoutPolicy = timeoutPolicy;
            return workerProxy;
          },
          DEFAULT_INVOCATION_TIMEOUT_MS,
          Transfer: class Transfer<T> {
            value: T;
            transferables: Transferable[];

            constructor(value: T, transferables: Transferable[]) {
              this.transferables = transferables;
              // Model the point at which buildMethodProxy posts the payload:
              // transferred buffers detach in the caller and arrive intact in
              // the worker. Keeping this behavior in the mock catches facade
              // code that accidentally transfers a history-owned buffer.
              this.value = transferables.length > 0
                ? structuredClone(value, { transfer: transferables })
                : value;
            }
          }
        };
    }
    if (id.endsWith('platform/threadPool')) {
        return {
          Worker: class Worker {
            terminate() { workerTerminated = true; }
            postMessage() {}
            on() {}
            addEventListener() {}
          }
        };
    }
    if (id.endsWith('config')) {
        return {
          getMaximumFileSizeBytes: () => 0,
          getQueryTimeout: () => 5000
        };
    }
    if (id.endsWith('core/operation-serializer')) {
        // Exercise the desktop facade's own Promise contract directly. The
        // production serializer is async and would otherwise mask a synchronous
        // throw from the facade method it wraps.
        return { serializeOperations: (operations: unknown) => operations };
    }
    if (id.endsWith('pagedWritableSave')) {
        return {
          writePagedWritableOverlayToFile: async (...args: unknown[]) => {
            pagedHostSaveCalls.push(args);
            return { requiresReopen: true };
          }
        };
    }
    if (id.endsWith('main')) {
        return { GlobalOutputChannel: { appendLine: (line: string) => outputLines.push(line) } };
    }
    if (id.endsWith('nativeWorker')) {
        return {
          isNativeAvailable: async () => {
            nativeAvailabilityChecks++;
            return nativeAvailable;
          },
          createNativeDatabaseConnection: async () => {
            nativeConnectionCalls++;
            throw new Error('native connection must not be created without its binary');
          }
        };
    }
    return originalRequire.call(this, id);
};

// Import after interceptors are set up
const workerFactory = require('../../src/workerFactory');
Module.prototype._compile = originalCompile;

import { mockVscode } from './mocks/vscode';

describe('workerFactory error path tests', () => {
  beforeEach(() => {
    connectionFailed = false;
    workerTerminated = false;
    exposedWorkerMethods = [];
    workerTimeoutPolicy = undefined;
    pagedHostSaveCalls = [];
    nativeAvailable = false;
    nativeAvailabilityChecks = 0;
    nativeConnectionCalls = 0;
    outputLines = [];
    workerProxy = {
      initializeDatabase: async () => {
        if (connectionFailed) throw new Error('Connection failed');
        return { isReadOnly: false };
      }
    };

    // Reset VSCode mock behaviors
    Object.defineProperty(mockVscode.workspace, 'fs', {
      value: {
        readFile: async () => new Uint8Array(),
        stat: async () => ({ size: 0 })
      },
      writable: true,
      configurable: true
    });
    Object.defineProperty(mockVscode.Uri, 'joinPath', {
      value: () => ({ scheme: 'file', fsPath: '/test/path/assets/sqlite3.wasm' }),
      writable: true,
      configurable: true
    });
  });

  afterEach(() => {
    // Restore the original require implementation to avoid leaking to other tests
    Module.prototype.require = originalRequire;
    mock.restoreAll();
  });

  // The factory derives the sibling -wal URI via uri.with() (WAL read-only
  // gate), so database-file mocks must implement it like real vsc.Uri does.
  const testDbUri = () => ({
    scheme: 'file',
    fsPath: '/test/db.sqlite',
    path: '/test/db.sqlite',
    with({ path: nextPath }: { path: string }) {
      return { ...this, path: nextPath, fsPath: nextPath };
    }
  } as any);

  it('opens with WASM without an error notification when the install has no native binary', async () => {
    const showErrorMessage = mock.method(mockVscode.window, 'showErrorMessage');
    const extensionUri = { scheme: 'file', fsPath: '/test/natives-less-extension' } as any;

    const bundle = await workerFactory.createDatabaseConnection(extensionUri, null as any);
    const connection = await bundle.establishConnection(testDbUri(), 'test.sqlite');

    assert.strictEqual(nativeAvailabilityChecks, 1);
    assert.strictEqual(nativeConnectionCalls, 0);
    assert.strictEqual(await connection.databaseOps.engineKind, 'wasm');
    assert.strictEqual(showErrorMessage.mock.callCount(), 0);
    assert.deepStrictEqual(outputLines, ['[SQLite Explorer] Using WebAssembly SQLite backend']);
  });

  it('should terminate worker and re-throw error if establishConnection fails in WASM factory', async () => {
    connectionFailed = true;

    // NOTE: createDatabaseConnection handles Native + WASM
    // We can just test createDatabaseConnection without native support
    const extensionUri = { scheme: 'file', fsPath: '/test/extensionPath' } as any;

    // get WASM database bundle
    // We have to cast to access the returned WASM bundle for testing establishConnection directly
    const bundle = await workerFactory.createDatabaseConnection(extensionUri, null as any);

    const fileUri = testDbUri();

    try {
      await bundle.establishConnection(fileUri, 'test.sqlite');
      assert.fail('establishConnection should have thrown an error');
    } catch (err: any) {
      assert.strictEqual(err.message, 'Connection failed');
      assert.strictEqual(workerTerminated, true, 'terminateWorker should be called to prevent memory leaks');
    }
  });

  it('routes writable paged saves through the host streamer without a worker full-image path', async () => {
    let directWorkerWriteCalls = 0;
    let fullExportCalls = 0;
    const runData = new Uint8Array([9, 8, 7, 6]).buffer;
    const snapshot = {
      chunkSize: 4,
      logicalSize: 4,
      baseLimit: 4,
      dirtyBytes: 4,
      baseIdentity: { dev: 1n, ino: 2n, size: 4n, mtimeNs: 3n, mode: 0o600n },
      runs: [{ startChunkIndex: 0, data: runData }]
    };
    workerProxy = {
      initializeDatabase: async () => ({ isReadOnly: false, storage: 'paged' }),
      exportPagedWritableOverlay: async () => snapshot,
      writeToFile: async () => {
        directWorkerWriteCalls++;
        return { requiresReopen: false };
      },
      exportDatabase: async () => {
        fullExportCalls++;
        return new Uint8Array([1, 2, 3, 4]);
      }
    };

    const extensionUri = { scheme: 'file', fsPath: '/test/extensionPath' } as any;
    const fileUri = testDbUri();
    const bundle = await workerFactory.createDatabaseConnection(extensionUri, null as any);
    const { databaseOps } = await bundle.establishConnection(fileUri, 'test.sqlite');

    const result = await databaseOps.writeToFile('/test/save-as.sqlite');

    assert.deepStrictEqual(result, { requiresReopen: true });
    assert.strictEqual(directWorkerWriteCalls, 0);
    assert.strictEqual(fullExportCalls, 0);
    assert.strictEqual(pagedHostSaveCalls.length, 1);
    assert.strictEqual(pagedHostSaveCalls[0][1], '/test/db.sqlite');
    assert.strictEqual(pagedHostSaveCalls[0][2], '/test/save-as.sqlite');
    assert.strictEqual(pagedHostSaveCalls[0][3], snapshot, 'transferred buffers must be consumed directly');
  });

  it('keeps memory-backed saves on the worker writeToFile path', async () => {
    let directWorkerWriteCalls = 0;
    workerProxy = {
      initializeDatabase: async () => ({ isReadOnly: false, storage: 'memory' }),
      writeToFile: async (targetPath: string) => {
        directWorkerWriteCalls++;
        assert.strictEqual(targetPath, '/test/memory-save.sqlite');
        return { requiresReopen: false };
      },
      exportPagedWritableOverlay: async () => {
        throw new Error('memory save must not request a paged overlay');
      }
    };

    const bundle = await workerFactory.createDatabaseConnection(
      { scheme: 'file', fsPath: '/test/extensionPath' } as any,
      null as any
    );
    const { databaseOps } = await bundle.establishConnection(testDbUri(), 'test.sqlite');

    assert.deepStrictEqual(
      await databaseOps.writeToFile('/test/memory-save.sqlite'),
      { requiresReopen: false }
    );
    assert.strictEqual(directWorkerWriteCalls, 1);
    assert.deepStrictEqual(pagedHostSaveCalls, []);
  });

  it('routes view history through the desktop worker-backed WASM facade', async () => {
    const views = new Map<string, any>();
    const applyRpcArgumentCounts: number[] = [];
    const discardRpcArgumentCounts: number[] = [];
    const flushRpcArgumentCounts: number[] = [];
    const definition = (name: string, selectSql: string) => ({
      identifier: name,
      sql: `CREATE VIEW "${name}" AS ${selectSql}`,
      selectSql,
      triggers: []
    });
    workerProxy = {
      initializeDatabase: async () => ({ isReadOnly: false }),
      createView: async (name: string, selectSql: string) => {
        const created = definition(name, selectSql);
        views.set(name, created);
        return created;
      },
      getViewDefinition: async (name: string) => {
        const current = views.get(name);
        if (!current) throw new Error(`View not found: ${name}`);
        return current;
      },
      editView: async (name: string, selectSql: string) => {
        const before = views.get(name);
        const after = definition(name, selectSql);
        views.set(name, after);
        return { before, after };
      },
      dropView: async (name: string) => {
        const before = views.get(name);
        views.delete(name);
        return before;
      },
      undoModification: async (mod: any) => {
        if (mod.modificationType === 'view_create') views.delete(mod.targetTable);
        else if (mod.viewDefBefore) views.set(mod.targetTable, mod.viewDefBefore);
      },
      redoModification: async (mod: any) => {
        if (mod.modificationType === 'view_drop') views.delete(mod.targetTable);
        else if (mod.viewDefAfter) views.set(mod.targetTable, mod.viewDefAfter);
      },
      applyModifications: async (...args: any[]) => {
        applyRpcArgumentCounts.push(args.length);
        const [mods, transmittedSignal] = args;
        // Model worker_threads structured cloning: AbortSignal loses its
        // prototype and reaches the worker as a plain object.
        const clonedSignal = transmittedSignal === undefined
          ? undefined
          : structuredClone(transmittedSignal);
        (clonedSignal as any)?.throwIfAborted();
        for (const mod of mods) await workerProxy.redoModification(mod);
      },
      discardModifications: async (...args: any[]) => {
        discardRpcArgumentCounts.push(args.length);
        const [mods, transmittedSignal] = args;
        const clonedSignal = transmittedSignal === undefined
          ? undefined
          : structuredClone(transmittedSignal);
        (clonedSignal as any)?.throwIfAborted();
        for (let index = mods.length - 1; index >= 0; index--) {
          await workerProxy.undoModification(mods[index]);
        }
      },
      flushChanges: async (...args: any[]) => {
        flushRpcArgumentCounts.push(args.length);
        const [transmittedSignal] = args;
        const clonedSignal = transmittedSignal === undefined
          ? undefined
          : structuredClone(transmittedSignal);
        (clonedSignal as any)?.throwIfAborted();
      }
    };

    const extensionUri = { scheme: 'file', fsPath: '/test/extensionPath' } as any;
    const fileUri = testDbUri();
    const bundle = await workerFactory.createDatabaseConnection(extensionUri, null as any);
    const { databaseOps } = await bundle.establishConnection(fileUri, 'test.sqlite');

    const created = await databaseOps.createView('history_view', 'SELECT 1 AS value');
    const createMod = {
      label: 'Create history_view',
      description: 'Create history_view',
      modificationType: 'view_create' as const,
      targetTable: 'history_view',
      viewDefAfter: created
    };
    await databaseOps.undoModification(createMod);
    await assert.rejects(databaseOps.getViewDefinition('history_view'), /View not found/);
    await databaseOps.redoModification(createMod);
    assert.strictEqual((await databaseOps.getViewDefinition('history_view')).selectSql, 'SELECT 1 AS value');

    const edited = await databaseOps.editView('history_view', 'SELECT 2 AS value', true);
    const editMod = {
      description: 'Edit history_view',
      modificationType: 'view_edit' as const,
      targetTable: 'history_view',
      viewDefBefore: edited.before,
      viewDefAfter: edited.after
    };
    await databaseOps.undoModification(editMod);
    assert.strictEqual((await databaseOps.getViewDefinition('history_view')).selectSql, 'SELECT 1 AS value');
    await databaseOps.redoModification(editMod);
    assert.strictEqual((await databaseOps.getViewDefinition('history_view')).selectSql, 'SELECT 2 AS value');

    const dropped = await databaseOps.dropView('history_view');
    const dropMod = {
      description: 'Drop history_view',
      modificationType: 'view_drop' as const,
      targetTable: 'history_view',
      viewDefBefore: dropped
    };
    await databaseOps.undoModification(dropMod);
    assert.strictEqual((await databaseOps.getViewDefinition('history_view')).selectSql, 'SELECT 2 AS value');
    await databaseOps.redoModification(dropMod);
    await assert.rejects(databaseOps.getViewDefinition('history_view'), /View not found/);

    await databaseOps.applyModifications([createMod]);
    assert.strictEqual((await databaseOps.getViewDefinition('history_view')).selectSql, 'SELECT 1 AS value');
    await databaseOps.discardModifications([createMod]);
    await assert.rejects(databaseOps.getViewDefinition('history_view'), /View not found/);
    await databaseOps.flushChanges();

    // Hot-exit restoration supplies a real AbortSignal. The desktop facade
    // must check it host-side without serializing it into worker RPC.
    const { ModificationTracker } = require('../../src/core/undo-history');
    const { reconcileRestoredDatabase } = require('../../src/core/restore-reconciler');
    const restoredTracker = new ModificationTracker(10);
    restoredTracker.record(createMod);
    await reconcileRestoredDatabase(
      databaseOps,
      restoredTracker,
      'wasm',
      new AbortController().signal
    );
    assert.strictEqual(
      (await databaseOps.getViewDefinition('history_view')).selectSql,
      'SELECT 1 AS value'
    );
    assert.strictEqual(
      applyRpcArgumentCounts.at(-1),
      1,
      'AbortSignal must not cross the worker_threads RPC boundary'
    );
    const rpcSignal = new AbortController().signal;
    await databaseOps.discardModifications([], rpcSignal);
    await databaseOps.flushChanges(rpcSignal);
    assert.strictEqual(discardRpcArgumentCounts.at(-1), 1);
    assert.strictEqual(flushRpcArgumentCounts.at(-1), 0);

    for (const method of [
      'exportPagedWritableOverlay',
      'applyModifications',
      'undoModification',
      'redoModification',
      'flushChanges',
      'discardModifications'
    ]) {
      assert.ok(exposedWorkerMethods.includes(method), `${method} was not exposed over worker RPC`);
    }
  });

  it('routes bounded cell sessions through the desktop WASM worker facade', async () => {
    const target = { table: 'items', rowId: 7, column: 'payload' };
    const metadata = { storageClass: 'blob', byteLength: 3 };
    workerProxy = {
      initializeDatabase: async () => ({ isReadOnly: false }),
      getCellMetadata: async (received: unknown) => {
        assert.deepStrictEqual(received, target);
        return metadata;
      },
      openCellReadSession: async (received: unknown) => {
        assert.deepStrictEqual(received, target);
        return { sessionId: 'session-1', metadata, expiresAt: 1234 };
      },
      readCellChunk: async (sessionId: string, byteOffset: number, maxBytes: number) => {
        assert.deepStrictEqual([sessionId, byteOffset, maxBytes], ['session-1', 0, 3]);
        return { byteOffset: 0, bytes: new Uint8Array([1, 2, 3]), done: true };
      },
      closeCellReadSession: async (sessionId: string) => {
        assert.strictEqual(sessionId, 'session-1');
      }
    };

    const bundle = await workerFactory.createDatabaseConnection(
      { scheme: 'file', fsPath: '/test/extensionPath' } as any,
      null as any
    );
    const connection = await bundle.establishConnection(
      testDbUri(),
      'test.sqlite'
    );

    assert.ok(exposedWorkerMethods.includes('getCellMetadata'));
    assert.ok(exposedWorkerMethods.includes('openCellReadSession'));
    assert.ok(exposedWorkerMethods.includes('readCellChunk'));
    assert.ok(exposedWorkerMethods.includes('closeCellReadSession'));
    assert.deepStrictEqual(await connection.databaseOps.getCellMetadata(target), metadata);
    const session = await connection.databaseOps.openCellReadSession(target);
    assert.strictEqual(session.sessionId, 'session-1');
    assert.deepStrictEqual(
      await connection.databaseOps.readCellChunk(session.sessionId, 0, 3),
      { byteOffset: 0, bytes: new Uint8Array([1, 2, 3]), done: true }
    );
    await connection.databaseOps.closeCellReadSession(session.sessionId);
  });

  it('rejects pre-aborted desktop worker operations instead of throwing synchronously', async () => {
    let applyCalls = 0;
    workerProxy = {
      initializeDatabase: async () => ({ isReadOnly: false }),
      applyModifications: async () => { applyCalls++; }
    };

    const extensionUri = { scheme: 'file', fsPath: '/test/extensionPath' } as any;
    const fileUri = testDbUri();
    const bundle = await workerFactory.createDatabaseConnection(extensionUri, null as any);
    const { databaseOps } = await bundle.establishConnection(fileUri, 'test.sqlite');
    const controller = new AbortController();
    const cancellation = new Error('cancelled before worker dispatch');
    controller.abort(cancellation);

    let pending: Promise<void> | undefined;
    assert.doesNotThrow(() => {
      pending = databaseOps.applyModifications([], controller.signal);
    });

    let caught: unknown;
    await pending!.catch(error => { caught = error; });
    assert.strictEqual(caught, cancellation);
    assert.strictEqual(applyCalls, 0);
  });

  it('preempts desktop WASM queries through a host-owned shared flag', async () => {
    let cancellationFlag: Int32Array | undefined;
    let releaseWorker: (() => void) | undefined;
    workerProxy = {
      initializeDatabase: async () => ({ isReadOnly: false }),
      runQuery: async (
        _sql: string,
        _params?: unknown[],
        receivedFlag?: Int32Array
      ) => {
        cancellationFlag = receivedFlag;
        await new Promise<void>(resolve => { releaseWorker = resolve; });
        return [];
      }
    };

    const extensionUri = { scheme: 'file', fsPath: '/test/extensionPath' } as any;
    const fileUri = testDbUri();
    const bundle = await workerFactory.createDatabaseConnection(extensionUri, null as any);
    const { databaseOps } = await bundle.establishConnection(fileUri, 'test.sqlite');
    const controller = new AbortController();
    const cancellation = new Error('cancelled while worker query was running');
    const pending = databaseOps.executeQuery(
      'SELECT long_running_query()',
      [],
      controller.signal
    );
    await Promise.resolve();

    try {
      assert.ok(cancellationFlag, 'desktop facade did not pass a cancellation flag');
      assert.ok(cancellationFlag.buffer instanceof SharedArrayBuffer);
      assert.strictEqual(Atomics.load(cancellationFlag, 0), 0);
      controller.abort(cancellation);
      assert.strictEqual(Atomics.load(cancellationFlag, 0), 1);
    } finally {
      releaseWorker?.();
    }

    let caught: unknown;
    await pending.catch((error: unknown) => { caught = error; });
    assert.strictEqual(caught, cancellation);
  });

  it('keeps BLOB history bytes owned by the host while transferring mutation payloads', async () => {
    let storedValue = new Uint8Array();
    let insertedValue = new Uint8Array();
    let batchValue = new Uint8Array();
    let redoValue = new Uint8Array();
    workerProxy = {
      initializeDatabase: async () => ({ isReadOnly: false }),
      updateCell: async (_table: string, _rowId: number, _column: string, transferred: any) => {
        storedValue = transferred.value;
      },
      insertRow: async (_table: string, data: any) => {
        insertedValue = data.payload.value;
        return 2;
      },
      updateCellBatch: async (_table: string, updates: any[]) => {
        batchValue = updates[0].value.value;
      },
      redoModification: async (modification: any) => {
        redoValue = modification.newValue;
      }
    };

    const extensionUri = { scheme: 'file', fsPath: '/test/extensionPath' } as any;
    const fileUri = testDbUri();
    const bundle = await workerFactory.createDatabaseConnection(extensionUri, null as any);
    const { databaseOps } = await bundle.establishConnection(fileUri, 'test.sqlite');
    const blob = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

    await databaseOps.updateCell('items', 1, 'payload', blob);
    assert.deepStrictEqual(storedValue, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    assert.deepStrictEqual(
      blob,
      new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      'worker transfer must not detach the value retained for undo/redo history'
    );

    const insertedBlob = new Uint8Array([3, 4, 5]);
    const insertedRow = { payload: insertedBlob };
    await databaseOps.insertRow('items', insertedRow);
    assert.deepStrictEqual(insertedValue, new Uint8Array([3, 4, 5]));
    assert.deepStrictEqual(insertedRow.payload, new Uint8Array([3, 4, 5]));

    const batchedBlob = new Uint8Array([6, 7, 8]);
    const batch = [{ rowId: 2, column: 'payload', value: batchedBlob }];
    await databaseOps.updateCellBatch('items', batch);
    assert.deepStrictEqual(batchValue, new Uint8Array([6, 7, 8]));
    assert.deepStrictEqual(batch[0].value, new Uint8Array([6, 7, 8]));

    const modification = {
      label: 'Update payload',
      description: 'Update items.payload',
      modificationType: 'cell_update' as const,
      targetTable: 'items',
      targetRowId: 1,
      targetColumn: 'payload',
      priorValue: new Uint8Array([1, 2]),
      newValue: blob
    };
    const { ModificationTracker } = require('../../src/core/undo-history');
    const tracker = new ModificationTracker(10);
    tracker.record(modification);

    await databaseOps.redoModification(modification);
    assert.deepStrictEqual(redoValue, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));

    const restored = ModificationTracker.deserialize(tracker.serialize());
    const restoredModification = restored.getUncommittedEntries()[0];
    assert.deepStrictEqual(
      restoredModification.newValue,
      new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      'hot-exit serialization must retain the transferred BLOB bytes'
    );
  });

  it('waits for a delayed batch revert under a modification-scaled worker deadline', async () => {
    let releaseDiscard: (() => void) | undefined;
    let discarded: unknown[] | undefined;
    workerProxy = {
      initializeDatabase: async () => ({ isReadOnly: false }),
      discardModifications: async (mods: unknown[]) => {
        discarded = mods;
        await new Promise<void>(resolve => { releaseDiscard = resolve; });
      }
    };

    const extensionUri = { scheme: 'file', fsPath: '/test/extensionPath' } as any;
    const fileUri = testDbUri();
    const bundle = await workerFactory.createDatabaseConnection(extensionUri, null as any);
    const { databaseOps } = await bundle.establishConnection(fileUri, 'test.sqlite');
    const { ModificationTracker } = require('../../src/core/undo-history');
    const { revertDatabaseToSaved } = require('../../src/core/restore-reconciler');
    const tracker = new ModificationTracker(10);
    const modifications = [1, 2, 3].map(index => ({
      description: `Update ${index}`,
      modificationType: 'cell_update',
      targetTable: 'items',
      targetRowId: index,
      targetColumn: 'value',
      priorValue: index,
      newValue: index + 1
    }));
    for (const modification of modifications) tracker.record(modification);

    const pendingRevert = revertDatabaseToSaved(databaseOps, tracker);
    await Promise.resolve();

    assert.deepStrictEqual(discarded, modifications);
    assert.strictEqual(tracker.hasUncommittedChanges(), true);
    assert.ok(workerTimeoutPolicy, 'desktop worker should install a timeout policy');
    assert.strictEqual(
      workerTimeoutPolicy!('discardModifications', [modifications]),
      DEFAULT_INVOCATION_TIMEOUT_MS * modifications.length
    );

    releaseDiscard!();
    await pendingRevert;
    assert.strictEqual(tracker.hasUncommittedChanges(), false);
    assert.deepStrictEqual(tracker.getUncommittedEntries(), []);
  });

  async function establishTimeoutPolicy() {
    workerProxy = {
      initializeDatabase: async () => ({ isReadOnly: false })
    };

    const extensionUri = { scheme: 'file', fsPath: '/test/extensionPath' } as any;
    const fileUri = testDbUri();
    const bundle = await workerFactory.createDatabaseConnection(extensionUri, null as any);
    await bundle.establishConnection(fileUri, 'test.sqlite');
    assert.ok(workerTimeoutPolicy, 'desktop worker should install a timeout policy');
    return workerTimeoutPolicy!;
  }

  async function assertSingleEntryDeadline(modification: unknown, expected: number) {
    const timeoutPolicy = await establishTimeoutPolicy();
    assert.strictEqual(timeoutPolicy('undoModification', [modification]), expected);
    assert.strictEqual(timeoutPolicy('redoModification', [modification]), expected);
  }

  const createViewDefinition = (triggerCount: number) => ({
    identifier: 'history_view',
    sql: 'CREATE VIEW history_view AS SELECT 1 AS value',
    selectSql: 'SELECT 1 AS value',
    triggers: Array.from({ length: triggerCount }, (_, index) => ({
      identifier: `history_trigger_${index}`,
      sql: `CREATE TRIGGER history_trigger_${index} INSTEAD OF INSERT ON history_view BEGIN SELECT 1; END`
    }))
  });

  it('scales single-entry deadlines by affectedCells', async () => {
    await assertSingleEntryDeadline({
      affectedCells: Array.from({ length: 3 }, (_, index) => ({
        rowId: index,
        columnName: 'value',
        priorValue: index,
        newValue: index + 1
      }))
    }, 3 * DEFAULT_INVOCATION_TIMEOUT_MS);
  });

  it('scales single-entry deadlines by deletedRows', async () => {
    await assertSingleEntryDeadline({
      deletedRows: [
        { rowId: 1, row: { value: 'one' } },
        { rowId: 2, row: { value: 'two' } }
      ]
    }, 2 * DEFAULT_INVOCATION_TIMEOUT_MS);
  });

  it('scales single-entry deadlines by affectedRowIds', async () => {
    await assertSingleEntryDeadline({ affectedRowIds: [1, 2, 3, 4] }, 4 * DEFAULT_INVOCATION_TIMEOUT_MS);
  });

  it('scales single-entry deadlines by deletedColumns', async () => {
    await assertSingleEntryDeadline({
      deletedColumns: [
        { name: 'first', type: 'TEXT', data: [] },
        { name: 'second', type: 'INTEGER', data: [] }
      ]
    }, 2 * DEFAULT_INVOCATION_TIMEOUT_MS);
  });

  it('scales single-entry deadlines by droppedIndexes', async () => {
    await assertSingleEntryDeadline({
      droppedIndexes: ['idx_first', 'idx_second', 'idx_third']
    }, 3 * DEFAULT_INVOCATION_TIMEOUT_MS);
  });

  it('scales single-entry deadlines by viewDefBefore triggers', async () => {
    await assertSingleEntryDeadline({
      viewDefBefore: createViewDefinition(2)
    }, 2 * DEFAULT_INVOCATION_TIMEOUT_MS);
  });

  it('scales single-entry deadlines by viewDefAfter triggers', async () => {
    await assertSingleEntryDeadline({
      viewDefAfter: createViewDefinition(3)
    }, 3 * DEFAULT_INVOCATION_TIMEOUT_MS);
  });

  it('uses one work unit for absent or empty single-entry payloads', async () => {
    await assertSingleEntryDeadline(undefined, DEFAULT_INVOCATION_TIMEOUT_MS);
    await assertSingleEntryDeadline({
      affectedCells: [],
      deletedRows: [],
      affectedRowIds: [],
      deletedColumns: [],
      droppedIndexes: [],
      viewDefBefore: createViewDefinition(0),
      viewDefAfter: createViewDefinition(0)
    }, DEFAULT_INVOCATION_TIMEOUT_MS);
  });

  it('sums mixed single-entry payload work', async () => {
    await assertSingleEntryDeadline({
      affectedCells: [{ rowId: 1, columnName: 'value' }, { rowId: 2, columnName: 'value' }],
      deletedRows: [{ rowId: 1, row: {} }],
      affectedRowIds: [1, 2],
      deletedColumns: [{ name: 'old', type: 'TEXT', data: [] }],
      droppedIndexes: ['idx_old'],
      viewDefBefore: createViewDefinition(1),
      viewDefAfter: createViewDefinition(1)
    }, 9 * DEFAULT_INVOCATION_TIMEOUT_MS);
  });

  it('caps payload-scaled single-entry deadlines', async () => {
    await assertSingleEntryDeadline({
      affectedRowIds: Array.from({ length: 11 }, (_, index) => index)
    }, 10 * DEFAULT_INVOCATION_TIMEOUT_MS);
  });

  it('caps modification-scaled worker deadlines so a hung history call cannot wait all session', async () => {
    workerProxy = {
      initializeDatabase: async () => ({ isReadOnly: false })
    };

    const extensionUri = { scheme: 'file', fsPath: '/test/extensionPath' } as any;
    const fileUri = testDbUri();
    const bundle = await workerFactory.createDatabaseConnection(extensionUri, null as any);
    await bundle.establishConnection(fileUri, 'test.sqlite');
    const veryLargeHistory = Array.from({ length: 10_000 }, (_, index) => ({ index }));

    assert.ok(workerTimeoutPolicy, 'desktop worker should install a timeout policy');
    assert.strictEqual(
      workerTimeoutPolicy!('discardModifications', [veryLargeHistory]),
      10 * DEFAULT_INVOCATION_TIMEOUT_MS
    );
    assert.strictEqual(
      workerTimeoutPolicy!('applyModifications', [veryLargeHistory]),
      10 * DEFAULT_INVOCATION_TIMEOUT_MS
    );
    assert.strictEqual(
      workerTimeoutPolicy!('runQuery', ['SELECT 1']),
      DEFAULT_INVOCATION_TIMEOUT_MS
    );
  });
});
