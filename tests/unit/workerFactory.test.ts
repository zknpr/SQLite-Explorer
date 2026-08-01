import './vscode_mock_setup';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { DEFAULT_INVOCATION_TIMEOUT_MS } from '../../src/core/rpc';

// 1. Mock module cache before importing the module under test
const moduleCache = require('module')._cache;

let connectionFailed = false;
let workerTerminated = false;
let exposedWorkerMethods: string[] = [];
let workerProxy: Record<string, (...args: any[]) => any> = {};
let workerTimeoutPolicy: ((methodName: string, parameters: readonly unknown[]) => number) | undefined;

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
          Transfer: class Transfer {}
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
    if (id.endsWith('main')) {
        return { GlobalOutputChannel: null };
    }
    if (id.endsWith('nativeWorker')) {
        return { isNativeAvailable: async () => false };
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
  });

  it('should terminate worker and re-throw error if establishConnection fails in WASM factory', async () => {
    connectionFailed = true;

    // NOTE: createDatabaseConnection handles Native + WASM
    // We can just test createDatabaseConnection without native support
    const extensionUri = { scheme: 'file', fsPath: '/test/extensionPath' } as any;

    // get WASM database bundle
    // We have to cast to access the returned WASM bundle for testing establishConnection directly
    const bundle = await workerFactory.createDatabaseConnection(extensionUri, null as any);

    const fileUri = { scheme: 'file', fsPath: '/test/db.sqlite', path: '/test/db.sqlite' } as any;

    try {
      await bundle.establishConnection(fileUri, 'test.sqlite');
      assert.fail('establishConnection should have thrown an error');
    } catch (err: any) {
      assert.strictEqual(err.message, 'Connection failed');
      assert.strictEqual(workerTerminated, true, 'terminateWorker should be called to prevent memory leaks');
    }
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
    const fileUri = {
      scheme: 'file',
      fsPath: '/test/db.sqlite',
      path: '/test/db.sqlite'
    } as any;
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
      'applyModifications',
      'undoModification',
      'redoModification',
      'flushChanges',
      'discardModifications'
    ]) {
      assert.ok(exposedWorkerMethods.includes(method), `${method} was not exposed over worker RPC`);
    }
  });

  it('rejects pre-aborted desktop worker operations instead of throwing synchronously', async () => {
    let applyCalls = 0;
    workerProxy = {
      initializeDatabase: async () => ({ isReadOnly: false }),
      applyModifications: async () => { applyCalls++; }
    };

    const extensionUri = { scheme: 'file', fsPath: '/test/extensionPath' } as any;
    const fileUri = {
      scheme: 'file',
      fsPath: '/test/db.sqlite',
      path: '/test/db.sqlite'
    } as any;
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
    const fileUri = {
      scheme: 'file',
      fsPath: '/test/db.sqlite',
      path: '/test/db.sqlite'
    } as any;
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

  it('caps modification-scaled worker deadlines so a hung history call cannot wait all session', async () => {
    workerProxy = {
      initializeDatabase: async () => ({ isReadOnly: false })
    };

    const extensionUri = { scheme: 'file', fsPath: '/test/extensionPath' } as any;
    const fileUri = {
      scheme: 'file',
      fsPath: '/test/db.sqlite',
      path: '/test/db.sqlite'
    } as any;
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
