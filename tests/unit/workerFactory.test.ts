import './vscode_mock_setup';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

// 1. Mock module cache before importing the module under test
const moduleCache = require('module')._cache;

let connectionFailed = false;
let workerTerminated = false;

// Hack for import.meta.env
// The workerFactory does not compile because it depends on `import.meta.env.VSCODE_BROWSER_EXT`.
// When TSX requires it, it's not defined.
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');
const Module = require('module');

const workerFactoryPath = path.resolve(__dirname, '../../src/workerFactory.ts');
const srcCode = fs.readFileSync(workerFactoryPath, 'utf8');

const jsCode = esbuild.transformSync(srcCode, {
  loader: 'ts',
  format: 'cjs',
  define: {
    'import.meta.env.VSCODE_BROWSER_EXT': 'false'
  }
}).code;

// Evaluate script
const scriptModule = new Module(workerFactoryPath, module as any);
scriptModule.filename = workerFactoryPath;
scriptModule.paths = (Module as any)._nodeModulePaths(path.dirname(workerFactoryPath));

// We need to intercept required modules in the compiled code
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id: string) {
    if (id === 'vscode') return require('./mocks/vscode').mockVscode;
    if (id.endsWith('core/rpc')) {
        return {
          connectWorkerPort: () => ({
            initializeDatabase: async () => {
              if (connectionFailed) throw new Error('Connection failed');
              return { isReadOnly: false };
            }
          }),
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
    if (id.endsWith('main')) {
        return { GlobalOutputChannel: null };
    }
    if (id.endsWith('nativeWorker')) {
        return { isNativeAvailable: async () => false };
    }
    return originalRequire.call(this, id);
};

(scriptModule as any)._compile(jsCode, workerFactoryPath);

const workerFactory = scriptModule.exports;
import { mockVscode } from './mocks/vscode';

describe('workerFactory error path tests', () => {
  beforeEach(() => {
    connectionFailed = false;
    workerTerminated = false;

    // Reset VSCode mock behaviors
    mockVscode.workspace.fs = {
      readFile: async () => new Uint8Array(),
      stat: async () => ({ size: 0 })
    } as any;
    (mockVscode.Uri as any).joinPath = () => ({ scheme: 'file', fsPath: '/test/path/assets/sqlite3.wasm' });
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
});
