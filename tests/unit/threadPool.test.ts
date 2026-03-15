import './vscode_mock_setup';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import module from 'node:module';
import * as path from 'path';
import * as fs from 'fs';
import * as ts from 'typescript';

describe('ThreadPool', () => {
  const originalRequire = module.prototype.require;

  beforeEach(() => {
    delete require.cache[require.resolve('../../src/platform/threadPool.ts')];
  });

  afterEach(() => {
    module.prototype.require = originalRequire;
  });

  it('should use worker_threads in Node.js environment', () => {
    const threadPool = require('../../src/platform/threadPool.ts');
    const wt = require('worker_threads');

    assert.strictEqual(threadPool.Worker, wt.Worker);
    assert.strictEqual(threadPool.parentPort, wt.parentPort);
    assert.strictEqual(threadPool.MessageChannel, wt.MessageChannel);
  });

  it('should throw and log if worker_threads cannot be loaded', () => {
    const mockError = new Error('worker_threads mock error');

    // Intercept require
    module.prototype.require = function(id: string) {
      if (id === 'worker_threads') throw mockError;
      return originalRequire.apply(this, arguments as any);
    };

    let loggedError: any;
    const originalConsoleError = console.error;
    console.error = (...args) => { loggedError = args[1]; };

    try {
      assert.throws(() => require('../../src/platform/threadPool.ts'), mockError);
      assert.strictEqual(loggedError, mockError);
    } finally {
      console.error = originalConsoleError;
    }
  });

  it('should log an error if parentPort is null in a worker thread', () => {
    // Intercept require to mock worker_threads
    module.prototype.require = function(id: string) {
      if (id === 'worker_threads') {
        return {
          Worker: class {},
          parentPort: null,
          isMainThread: false // Not main thread!
        };
      }
      return originalRequire.apply(this, arguments as any);
    };

    let loggedError: string = '';
    const originalConsoleError = console.error;
    console.error = (...args) => { loggedError = args[0]; };

    try {
      require('../../src/platform/threadPool.ts');
      assert.strictEqual(loggedError, '[ThreadPool] worker_threads.parentPort is null in a worker thread!');
    } finally {
      console.error = originalConsoleError;
    }
  });

  it('should NOT log an error if parentPort is null in main thread', () => {
    module.prototype.require = function(id: string) {
      if (id === 'worker_threads') {
        return {
          Worker: class {},
          parentPort: null,
          isMainThread: true
        };
      }
      return originalRequire.apply(this, arguments as any);
    };

    let calledError = false;
    const originalConsoleError = console.error;
    console.error = () => { calledError = true; };

    try {
      require('../../src/platform/threadPool.ts');
      assert.strictEqual(calledError, false);
    } finally {
      console.error = originalConsoleError;
    }
  });

  it('should use globalThis in Browser environment', () => {
    // To cleanly test the browser branch without modifying files on disk or relying on
    // undocumented test runner behavior, we compile the source in-memory with the mock injected.
    const filePath = path.resolve(__dirname, '../../src/platform/threadPool.ts');
    const sourceCode = fs.readFileSync(filePath, 'utf-8');

    const mockSource = sourceCode.replace(
        'const isBrowserRuntime = import.meta.env?.VSCODE_BROWSER_EXT;',
        'const isBrowserRuntime = true;'
    );

    const result = ts.transpileModule(mockSource, {
        compilerOptions: { module: ts.ModuleKind.CommonJS }
    });

    const mockWorker = class MockWorker {};
    (globalThis as any).Worker = mockWorker;

    const exports = {};
    const moduleScope = { exports };
    const requireFn = (id: string) => {
        throw new Error(`Should not require ${id} in browser mode`);
    };

    const execute = new Function('module', 'exports', 'require', 'globalThis', result.outputText);
    execute(moduleScope, exports, requireFn, globalThis);

    const threadPool = moduleScope.exports as any;

    assert.strictEqual(threadPool.Worker, mockWorker);
    assert.strictEqual(threadPool.parentPort, globalThis);

    delete (globalThis as any).Worker;
  });
});
