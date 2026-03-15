/**
 * Tests for src/platform/threadPool.ts
 *
 * Validates runtime detection and API selection for cross-platform
 * worker thread support (Node.js worker_threads vs Browser Web Workers).
 *
 * Strategy: Since threadPool.ts executes detection at module load time,
 * each test clears the require cache and re-requires the module with
 * different mock setups to exercise each code path.
 */
import './vscode_mock_setup';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import Module from 'node:module';

// Path to the module under test — resolved once for cache invalidation
const threadPoolPath = require.resolve('../../src/platform/threadPool.ts');

// Store original Module._load to intercept require() calls
// @ts-ignore — Module._load is internal but necessary for module-level mocking
const originalLoad = Module._load;

describe('ThreadPool', () => {
  afterEach(() => {
    // Restore original module loader after each test to prevent cross-contamination
    // @ts-ignore
    Module._load = originalLoad;
    // Evict the cached module so the next test gets a fresh evaluation
    delete require.cache[threadPoolPath];
  });

  it('should export worker_threads APIs in Node.js environment', () => {
    // Default environment (no mocking needed) — Node.js path executes naturally
    // because import.meta.env?.VSCODE_BROWSER_EXT is undefined in test runner
    const threadPool = require('../../src/platform/threadPool.ts');
    const wt = require('worker_threads');

    // Verify all exports match the real worker_threads module
    assert.strictEqual(threadPool.Worker, wt.Worker,
      'Worker should be worker_threads.Worker');
    assert.strictEqual(threadPool.MessageChannel, wt.MessageChannel,
      'MessageChannel should be worker_threads.MessageChannel');
    assert.strictEqual(threadPool.MessagePort, wt.MessagePort,
      'MessagePort should be worker_threads.MessagePort');
    assert.strictEqual(threadPool.BroadcastChannel, wt.BroadcastChannel,
      'BroadcastChannel should be worker_threads.BroadcastChannel');
    // parentPort is null in the main thread (test runner), which is correct
    assert.strictEqual(threadPool.parentPort, wt.parentPort,
      'parentPort should match worker_threads.parentPort');
  });

  it('should re-throw and log when worker_threads fails to load', () => {
    const mockError = new Error('worker_threads unavailable');

    // Intercept Module._load to make require('worker_threads') throw
    // @ts-ignore
    Module._load = function (request: string, parent: unknown, isMain: boolean) {
      if (request === 'worker_threads') throw mockError;
      return originalLoad(request, parent, isMain);
    };

    // Capture console.error output to verify logging
    const capturedErrors: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => { capturedErrors.push(args); };

    try {
      // The module should throw because it re-throws the worker_threads error
      assert.throws(
        () => require('../../src/platform/threadPool.ts'),
        (err: Error) => err === mockError,
        'Should re-throw the original worker_threads error'
      );

      // Verify the error was logged before re-throwing
      assert.ok(capturedErrors.length > 0, 'Should log error via console.error');
      assert.strictEqual(capturedErrors[0][0], '[ThreadPool] Failed to load worker_threads:',
        'Log message should identify the source');
      assert.strictEqual(capturedErrors[0][1], mockError,
        'Log should include the original error');
    } finally {
      // Always restore console.error, even if assertions fail
      console.error = originalConsoleError;
    }
  });

  it('should log warning when parentPort is null in a worker thread', () => {
    // Mock worker_threads to simulate being inside a worker thread
    // where parentPort is unexpectedly null (an anomalous state)
    const mockWorkerThreads = {
      Worker: class MockWorker {},
      parentPort: null,         // Null parentPort — the condition under test
      isMainThread: false,      // Signals we're in a worker thread
      MessageChannel: class MockMC {},
      MessagePort: class MockMP {},
      BroadcastChannel: class MockBC {},
    };

    // @ts-ignore
    Module._load = function (request: string, parent: unknown, isMain: boolean) {
      if (request === 'worker_threads') return mockWorkerThreads;
      return originalLoad(request, parent, isMain);
    };

    // Capture console.error to verify the warning
    const capturedErrors: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => { capturedErrors.push(args); };

    try {
      const threadPool = require('../../src/platform/threadPool.ts');

      // The module should still export the mock values (it doesn't throw for this case)
      assert.strictEqual(threadPool.parentPort, null,
        'parentPort should be null as mocked');
      assert.strictEqual(threadPool.Worker, mockWorkerThreads.Worker,
        'Worker should come from mocked worker_threads');

      // Verify the warning was logged about the unexpected null parentPort
      const warningMsg = capturedErrors.find(
        args => typeof args[0] === 'string' && args[0].includes('parentPort is null')
      );
      assert.ok(warningMsg,
        'Should log warning about null parentPort in worker thread');
    } finally {
      console.error = originalConsoleError;
    }
  });

  it('should not log warning when parentPort is null in main thread', () => {
    // Mock worker_threads to simulate being in the main thread
    // where parentPort being null is normal and expected
    const mockWorkerThreads = {
      Worker: class MockWorker {},
      parentPort: null,         // Null parentPort — normal in main thread
      isMainThread: true,       // Signals we're in the main thread
      MessageChannel: class MockMC {},
      MessagePort: class MockMP {},
      BroadcastChannel: class MockBC {},
    };

    // @ts-ignore
    Module._load = function (request: string, parent: unknown, isMain: boolean) {
      if (request === 'worker_threads') return mockWorkerThreads;
      return originalLoad(request, parent, isMain);
    };

    // Capture console.error — expect no output
    const capturedErrors: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => { capturedErrors.push(args); };

    try {
      require('../../src/platform/threadPool.ts');

      // No warning should be logged for null parentPort in main thread
      const warningMsg = capturedErrors.find(
        args => typeof args[0] === 'string' && args[0].includes('parentPort is null')
      );
      assert.strictEqual(warningMsg, undefined,
        'Should NOT log warning about null parentPort in main thread');
    } finally {
      console.error = originalConsoleError;
    }
  });
});
