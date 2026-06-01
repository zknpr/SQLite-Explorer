import './vscode_mock_setup';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import Module from 'node:module';
import esbuild from 'esbuild';
import { mockVscode } from './mocks/vscode';
import type { CellUpdate, CellValue, DatabaseInitConfig } from '../../src/core/types';

const workerFactoryPath = path.resolve(__dirname, '../../src/workerFactory.ts');
const workerFactorySource = fs.readFileSync(workerFactoryPath, 'utf8');

interface FakeEndpoint {
  initializeDatabase(filename: string, config: DatabaseInitConfig): Promise<{ isReadOnly: boolean }>;
  runQuery(sql: string, params?: CellValue[]): Promise<unknown[]>;
  exportDatabase(name: string): Promise<Uint8Array>;
  updateCell(table: string, rowId: string | number, column: string, value: CellValue): Promise<void>;
  insertRow(table: string, data: Record<string, CellValue>): Promise<string | number | undefined>;
  updateCellBatch(table: string, updates: CellUpdate[]): Promise<void>;
  ping(): Promise<boolean>;
}

function loadBrowserWorkerFactory(endpoint: FakeEndpoint) {
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
        createWorkerEndpoint: () => endpoint
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
      return { GlobalOutputChannel: null };
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
        stat: async () => ({ size: dbContent.byteLength }),
        readFile: async (uri: { path?: string; fsPath?: string }) => {
          const pathValue = uri.path ?? uri.fsPath ?? '';
          if (pathValue.endsWith('-wal')) {
            throw new Error('No WAL file');
          }
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
    let insertRowValue: CellValue | undefined;
    let updateBatchValue: CellValue | undefined;

    const endpoint: FakeEndpoint = {
      initializeDatabase: async (_filename, config) => {
        initConfig = config;
        return { isReadOnly: false };
      },
      runQuery: async () => [],
      exportDatabase: async () => new Uint8Array(),
      updateCell: async (_table, _rowId, _column, value) => {
        updateCellValue = value;
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
    assert.strictEqual(initConfig?.walContent, null);
    assert.strictEqual(initConfig?.wasmBinary?.byteLength, 3);
    assert.strictEqual(connection.isReadOnly, false);

    const blobValue = new Uint8Array([9, 8, 7]);
    await connection.databaseOps.updateCell('items', 1, 'blob', blobValue);
    await connection.databaseOps.insertRow('items', { blob: blobValue });
    await connection.databaseOps.updateCellBatch('items', [{ rowId: 1, column: 'blob', value: blobValue }]);

    assert.strictEqual(updateCellValue, blobValue);
    assert.strictEqual(insertRowValue, blobValue);
    assert.strictEqual(updateBatchValue, blobValue);
  });
});
