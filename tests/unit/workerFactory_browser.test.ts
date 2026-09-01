import './vscode_mock_setup';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import Module from 'node:module';
import esbuild from 'esbuild';
import { mockVscode } from './mocks/vscode';
import type { CellUpdate, CellValue, DatabaseInitConfig, ModificationEntry } from '../../src/core/types';

const workerFactoryPath = path.resolve(__dirname, '../../src/workerFactory.ts');
const workerFactorySource = fs.readFileSync(workerFactoryPath, 'utf8');

interface FakeEndpoint {
  initializeDatabase(filename: string, config: DatabaseInitConfig): Promise<{ isReadOnly: boolean }>;
  runQuery(sql: string, params?: CellValue[]): Promise<unknown[]>;
  exportDatabase(): Promise<Uint8Array>;
  applyModifications?(mods: ModificationEntry[], signal?: AbortSignal): Promise<void>;
  undoModification?(mod: ModificationEntry): Promise<void>;
  redoModification?(mod: ModificationEntry): Promise<void>;
  flushChanges?(signal?: AbortSignal): Promise<void>;
  discardModifications?(mods: ModificationEntry[], signal?: AbortSignal): Promise<void>;
  updateCell(table: string, rowId: string | number, column: string, value: CellValue, patch?: string): Promise<void>;
  insertRow(table: string, data: Record<string, CellValue>): Promise<string | number | undefined>;
  updateCellBatch(table: string, updates: CellUpdate[]): Promise<void>;
  ping(): Promise<boolean>;
  writeToFile?(path: string, signal?: AbortSignal): Promise<void>;
}

type EndpointLogger = (
  level: 'log' | 'warn' | 'error',
  ...args: unknown[]
) => void;

function loadBrowserWorkerFactory(endpoint: FakeEndpoint, options: {
  captureLogger?: (logger: EndpointLogger | undefined) => void;
  outputChannel?: { appendLine(line: string): void };
} = {}) {
  const jsCode = esbuild.transformSync(workerFactorySource, {
    loader: 'ts',
    format: 'cjs',
    define: {
      'import.meta.env.VSCODE_BROWSER_EXT': 'true'
    }
  }).code;

  const scriptModule = new Module(workerFactoryPath, module as unknown as Module);
  scriptModule.filename = workerFactoryPath;
  scriptModule.paths = (Module as unknown as { _nodeModulePaths(dirname: string): string[] })
    ._nodeModulePaths(path.dirname(workerFactoryPath));

  const originalRequire = Module.prototype.require;
  Module.prototype.require = function(request: string) {
    if (request === 'vscode') return mockVscode;
    if (request.endsWith('core/sqlite-db')) {
      return {
        createWorkerEndpoint: (logger?: EndpointLogger) => {
          options.captureLogger?.(logger);
          return endpoint;
        }
      };
    }
    if (request.endsWith('core/rpc')) {
      return {
        connectWorkerPort: () => {
          throw new Error('Browser mode must not create an RPC worker proxy');
        },
        Transfer: class Transfer<T> {
          constructor(public readonly value: T, public readonly transferables: Transferable[]) {}
        }
      };
    }
    if (request.endsWith('platform/threadPool')) {
      return {
        Worker: class Worker {
          constructor() {
            throw new Error('Browser mode must not construct a worker');
          }
        }
      };
    }
    if (request.endsWith('config')) {
      return {
        getMaximumFileSizeBytes: () => 0,
        getQueryTimeout: () => 5000
      };
    }
    if (request.endsWith('main')) {
      return { GlobalOutputChannel: options.outputChannel ?? null };
    }
    return originalRequire.call(this, request);
  };

  try {
    (scriptModule as unknown as { _compile(code: string, filename: string): void })
      ._compile(jsCode, workerFactoryPath);
  } finally {
    Module.prototype.require = originalRequire;
  }

  return scriptModule.exports as {
    createDatabaseConnection: typeof import('../../src/workerFactory').createDatabaseConnection;
  };
}

describe('workerFactory browser WASM connection', () => {
  beforeEach(() => {
    const dbContent = new Uint8Array([1, 2, 3]);
    const wasmContent = new Uint8Array([4, 5, 6]);

    Object.defineProperty(mockVscode.workspace, 'fs', {
      value: {
        stat: async (uri: { path?: string; fsPath?: string }) => {
          const pathValue = uri.path ?? uri.fsPath ?? '';
          if (pathValue.endsWith('-wal')) {
            throw new Error('No WAL file');
          }
          return { size: dbContent.byteLength };
        },
        readFile: async (uri: { path?: string; fsPath?: string }) => {
          const pathValue = uri.path ?? uri.fsPath ?? '';
          if (pathValue.endsWith('sqlite3.wasm')) {
            return wasmContent;
          }
          return dbContent;
        }
      },
      writable: true,
      configurable: true
    });
  });

  it('uses an in-process endpoint and passes raw Uint8Array values directly', async () => {
    let initConfig: DatabaseInitConfig | undefined;
    let updateCellValue: CellValue | undefined;
    let updateCellPatch: string | undefined;
    let insertRowValue: CellValue | undefined;
    let updateBatchValue: CellValue | undefined;

    const endpoint: FakeEndpoint = {
      initializeDatabase: async (_filename, config) => {
        initConfig = config;
        return { isReadOnly: false };
      },
      runQuery: async () => [],
      exportDatabase: async () => new Uint8Array(),
      updateCell: async (_table, _rowId, _column, value, patch) => {
        updateCellValue = value;
        updateCellPatch = patch;
      },
      insertRow: async (_table, data) => {
        insertRowValue = data.blob;
        return 1;
      },
      updateCellBatch: async (_table, updates) => {
        updateBatchValue = updates[0].value;
      },
      ping: async () => true
    };

    const workerFactory = loadBrowserWorkerFactory(endpoint);
    const extensionUri = { scheme: 'vscode-vfs', fsPath: '/ext', path: '/ext' } as any;
    const fileUri = {
      scheme: 'vscode-vfs',
      fsPath: '/workspace/test.db',
      path: '/workspace/test.db',
      with: ({ path: nextPath }: { path: string }) => ({
        scheme: 'vscode-vfs',
        fsPath: nextPath,
        path: nextPath
      })
    } as any;

    const bundle = await workerFactory.createDatabaseConnection(extensionUri, null as any);
    const connection = await bundle.establishConnection(fileUri, 'test.db');

    assert.strictEqual(initConfig?.content?.byteLength, 3);
    assert.ok(initConfig && !('walContent' in initConfig), 'WAL bytes are never shipped to the engine');
    assert.strictEqual(initConfig?.wasmBinary?.byteLength, 3);
    assert.strictEqual(connection.isReadOnly, false);

    const blobValue = new Uint8Array([9, 8, 7]);
    // The browser facade calls the in-process endpoint directly, so the patch
    // argument must survive this delegation layer alongside the raw Uint8Array.
    await connection.databaseOps.updateCell('items', 1, 'blob', blobValue, '{"merged":true}');
    await connection.databaseOps.insertRow('items', { blob: blobValue });
    await connection.databaseOps.updateCellBatch('items', [{ rowId: 1, column: 'blob', value: blobValue }]);

    assert.strictEqual(updateCellValue, blobValue);
    assert.strictEqual(updateCellPatch, '{"merged":true}');
    assert.strictEqual(insertRowValue, blobValue);
    assert.strictEqual(updateBatchValue, blobValue);
  });

  it('opens browser WAL databases read-only instead of silently writing without WAL pages', async () => {
    const dbContent = new Uint8Array([1, 2, 3]);
    const walSize = 3;
    const wasmContent = new Uint8Array([4, 5, 6]);
    let initConfig: DatabaseInitConfig | undefined;

    Object.defineProperty(mockVscode.workspace, 'fs', {
      value: {
        stat: async (uri: { path?: string; fsPath?: string }) => {
          const pathValue = uri.path ?? uri.fsPath ?? '';
          if (pathValue.endsWith('-wal')) {
            return { size: walSize };
          }
          return { size: dbContent.byteLength };
        },
        readFile: async (uri: { path?: string; fsPath?: string }) => {
          const pathValue = uri.path ?? uri.fsPath ?? '';
          if (pathValue.endsWith('sqlite3.wasm')) {
            return wasmContent;
          }
          return dbContent;
        }
      },
      writable: true,
      configurable: true
    });

    const endpoint: FakeEndpoint = {
      initializeDatabase: async (_filename, config) => {
        initConfig = config;
        return { isReadOnly: config.readOnlyMode ?? false };
      },
      runQuery: async () => [],
      exportDatabase: async () => new Uint8Array(),
      updateCell: async () => {},
      insertRow: async () => 1,
      updateCellBatch: async () => {},
      ping: async () => true
    };

    const workerFactory = loadBrowserWorkerFactory(endpoint);
    const extensionUri = { scheme: 'vscode-vfs', fsPath: '/ext', path: '/ext' } as any;
    const fileUri = {
      scheme: 'vscode-vfs',
      fsPath: '/workspace/test.db',
      path: '/workspace/test.db',
      with: ({ path: nextPath }: { path: string }) => ({
        scheme: 'vscode-vfs',
        fsPath: nextPath,
        path: nextPath
      })
    } as any;

    const bundle = await workerFactory.createDatabaseConnection(extensionUri, null as any);
    const connection = await bundle.establishConnection(fileUri, 'test.db');

    assert.ok(initConfig && !('walContent' in initConfig), 'WAL bytes are never shipped to the engine');
    assert.strictEqual(initConfig?.readOnlyMode, true);
    assert.strictEqual(connection.isReadOnly, true);
  });

  it('delegates in-process modification operations through the endpoint', async () => {
    const calls: string[] = [];
    const mod = {
      label: 'Update',
      description: 'Update item',
      modificationType: 'cell_update' as const,
      targetTable: 'items',
      targetRowId: 1,
      targetColumn: 'name',
      priorValue: 'before',
      newValue: 'after'
    };
    const abortController = new AbortController();

    const endpoint: FakeEndpoint = {
      initializeDatabase: async () => ({ isReadOnly: false }),
      runQuery: async () => [],
      exportDatabase: async () => new Uint8Array(),
      applyModifications: async (mods, signal) => {
        assert.deepStrictEqual(mods, [mod]);
        assert.strictEqual(signal, abortController.signal);
        calls.push('apply');
      },
      undoModification: async (entry) => {
        assert.strictEqual(entry, mod);
        calls.push('undo');
      },
      redoModification: async (entry) => {
        assert.strictEqual(entry, mod);
        calls.push('redo');
      },
      flushChanges: async (signal) => {
        assert.strictEqual(signal, abortController.signal);
        calls.push('flush');
      },
      discardModifications: async (mods, signal) => {
        assert.deepStrictEqual(mods, [mod]);
        assert.strictEqual(signal, abortController.signal);
        calls.push('discard');
      },
      writeToFile: async (targetPath, signal) => {
        assert.strictEqual(targetPath, '/workspace/copy.db');
        assert.strictEqual(signal, abortController.signal);
        calls.push('write');
      },
      updateCell: async () => {},
      insertRow: async () => 1,
      updateCellBatch: async () => {},
      ping: async () => true
    };

    const workerFactory = loadBrowserWorkerFactory(endpoint);
    const extensionUri = { scheme: 'vscode-vfs', fsPath: '/ext', path: '/ext' } as any;
    const fileUri = {
      scheme: 'vscode-vfs',
      fsPath: '/workspace/test.db',
      path: '/workspace/test.db',
      with: ({ path: nextPath }: { path: string }) => ({
        scheme: 'vscode-vfs',
        fsPath: nextPath,
        path: nextPath
      })
    } as any;

    const bundle = await workerFactory.createDatabaseConnection(extensionUri, null as any);
    const connection = await bundle.establishConnection(fileUri, 'test.db');

    await connection.databaseOps.applyModifications([mod], abortController.signal);
    await connection.databaseOps.undoModification(mod);
    await connection.databaseOps.redoModification(mod);
    await connection.databaseOps.flushChanges(abortController.signal);
    await connection.databaseOps.discardModifications([mod], abortController.signal);
    await connection.databaseOps.writeToFile('/workspace/copy.db', abortController.signal);

    assert.deepStrictEqual(calls, ['apply', 'undo', 'redo', 'flush', 'discard', 'write']);
  });

  it('routes in-process engine diagnostics to the SQLite Explorer output channel', async () => {
    let logger: EndpointLogger | undefined;
    const lines: string[] = [];
    const endpoint: FakeEndpoint = {
      initializeDatabase: async () => ({ isReadOnly: false }),
      runQuery: async () => [],
      exportDatabase: async () => new Uint8Array(),
      updateCell: async () => {},
      insertRow: async () => 1,
      updateCellBatch: async () => {},
      ping: async () => true
    };

    const workerFactory = loadBrowserWorkerFactory(endpoint, {
      captureLogger: value => { logger = value; },
      outputChannel: { appendLine: line => lines.push(line) }
    });
    await workerFactory.createDatabaseConnection(
      { scheme: 'vscode-vfs', fsPath: '/ext', path: '/ext' } as any,
      null as any
    );

    assert.ok(logger, 'the in-process endpoint must receive a logger');
    logger('warn', 'Skipping view undo:', new Error('definition missing from history entry'));
    assert.strictEqual(
      lines.at(-1),
      '[Worker/warn] Skipping view undo: definition missing from history entry'
    );
  });
});
