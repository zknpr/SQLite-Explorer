import './vscode_mock_setup';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import Module from 'node:module';
import esbuild from 'esbuild';
import { mockVscode } from './mocks/vscode';
import type { DatabaseInitConfig, DatabaseInitResult } from '../../src/core/types';

/**
 * Desktop workerFactory routing for local files eligible for paging,
 * mirroring the wal_wasm_gate.test.ts harness: the
 * factory is compiled for the desktop environment with the worker RPC
 * seam faked, so the tests pin exactly what establishConnection sends to
 * the worker and how it surfaces the worker's answer.
 *
 *   over the gate, clean -wal   -> dispatch with allowPagedFallback, then
 *                                  toast + output line when the worker
 *                                  answers storage:'paged'
 *   over the gate, framed -wal  -> checkpoint rejection BEFORE dispatch
 *   over the gate, -wal unknown -> same checkpoint rejection
 *   over the gate, init fails   -> today's exact size-gate message
 *   under the gate              -> unchanged editable path, no toast
 *   non-local / untitled        -> no paged fallback offered
 */

const workerFactoryPath = path.resolve(__dirname, '../../src/workerFactory.ts');
const workerFactorySource = fs.readFileSync(workerFactoryPath, 'utf8');

class FakeTransfer<T> {
  constructor(
    public readonly value: T,
    public readonly transferables: Transferable[]
  ) {}
}

function loadDesktopWorkerFactory(options: {
  onInitializeDatabase: (
    filename: string,
    config: DatabaseInitConfig
  ) => Promise<DatabaseInitResult>;
  outputChannel?: { appendLine(line: string): void };
  maxFileSizeBytes: number;
}) {
  const jsCode = esbuild.transformSync(workerFactorySource, {
    loader: 'ts',
    format: 'cjs',
    define: {
      'import.meta.env.VSCODE_BROWSER_EXT': 'false'
    }
  }).code;

  const scriptModule = new Module(workerFactoryPath, module as unknown as Module);
  scriptModule.filename = workerFactoryPath;
  scriptModule.paths = (Module as unknown as { _nodeModulePaths(dirname: string): string[] })
    ._nodeModulePaths(path.dirname(workerFactoryPath));

  const originalRequire = Module.prototype.require;
  Module.prototype.require = function(request: string) {
    if (request === 'vscode') return mockVscode;
    if (request.endsWith('nativeWorker')) {
      return {
        isNativeAvailable: async () => false,
        createNativeDatabaseConnection: async () => {
          throw new Error('native backend must not be used in this test');
        }
      };
    }
    if (request.endsWith('core/sqlite-db')) {
      return {
        createWorkerEndpoint: () => {
          throw new Error('desktop path must not create the in-process endpoint');
        }
      };
    }
    if (request.endsWith('core/rpc')) {
      return {
        DEFAULT_INVOCATION_TIMEOUT_MS: 1000,
        connectWorkerPort: () => ({
          initializeDatabase: (
            filename: string,
            config: DatabaseInitConfig | FakeTransfer<DatabaseInitConfig>
          ) => {
            const unwrapped = config instanceof FakeTransfer ? config.value : config;
            return options.onInitializeDatabase(filename, unwrapped);
          }
        }),
        Transfer: FakeTransfer
      };
    }
    if (request.endsWith('platform/threadPool')) {
      return {
        Worker: class {
          postMessage() {}
          on() {}
          terminate() {}
        }
      };
    }
    if (request.endsWith('config')) {
      return {
        getMaximumFileSizeBytes: () => options.maxFileSizeBytes,
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
    setDesktopTestPagedOpenThresholdBytes: (
      thresholdBytes: number | undefined
    ) => void;
  };
}

function makeFileUri(scheme: string, filePath: string) {
  return {
    scheme,
    fsPath: filePath,
    path: filePath,
    with: ({ path: nextPath }: { path: string }) => ({
      scheme,
      fsPath: nextPath,
      path: nextPath
    })
  } as any;
}

interface RoutingResult {
  config: DatabaseInitConfig | undefined;
  isReadOnly: boolean | undefined;
  error: Error | undefined;
  toasts: string[];
  outputLines: string[];
  initCalls: number;
}

/** The size error the host surfaced for over-limit files before the fallback. */
function legacySizeMessage(fileSize: number, maxSize: number): string {
  return `File size (${(fileSize / (1024 * 1024)).toFixed(2)} MB) exceeds the maximum allowed size (${(maxSize / (1024 * 1024)).toFixed(2)} MB). Configure 'sqliteExplorer.maxFileSize' to increase the limit.`;
}

async function connectDesktop(options: {
  fileSize: number;
  maxFileSizeBytes: number;
  /** -wal stat outcome: a size, null for FileNotFound, 'stat-error' otherwise. */
  walSize: number | null | 'stat-error';
  scheme?: string;
  pagedOpenThresholdBytes?: number;
  initResult?: DatabaseInitResult;
  initError?: Error;
}): Promise<RoutingResult> {
  const scheme = options.scheme ?? 'file';
  const result: RoutingResult = {
    config: undefined,
    isReadOnly: undefined,
    error: undefined,
    toasts: [],
    outputLines: [],
    initCalls: 0
  };

  Object.defineProperty(mockVscode.workspace, 'fs', {
    value: {
      stat: async (uri: { path?: string; fsPath?: string }) => {
        const pathValue = uri.path ?? uri.fsPath ?? '';
        if (pathValue.endsWith('-wal')) {
          if (options.walSize === null) {
            throw Object.assign(new Error('ENOENT: no -wal file'), { code: 'FileNotFound' });
          }
          if (options.walSize === 'stat-error') {
            throw Object.assign(new Error('EACCES: permission denied'), { code: 'NoPermissions' });
          }
          return { size: options.walSize };
        }
        return { size: options.fileSize };
      },
      readFile: async (uri: { path?: string; fsPath?: string }) => {
        const pathValue = uri.path ?? uri.fsPath ?? '';
        if (pathValue.endsWith('sqlite3.wasm')) return new Uint8Array([4, 5, 6]);
        return new Uint8Array([1, 2, 3]);
      }
    },
    writable: true,
    configurable: true
  });

  const originalShowWarning = mockVscode.window.showWarningMessage;
  mockVscode.window.showWarningMessage = ((message: string) => {
    result.toasts.push(message);
    return Promise.resolve();
  }) as typeof mockVscode.window.showWarningMessage;

  try {
    const workerFactory = loadDesktopWorkerFactory({
      maxFileSizeBytes: options.maxFileSizeBytes,
      onInitializeDatabase: async (_filename, config) => {
        result.initCalls += 1;
        result.config = config;
        if (options.initError) throw options.initError;
        return options.initResult ?? { isReadOnly: config.readOnlyMode ?? false, storage: 'memory' };
      },
      outputChannel: { appendLine: line => result.outputLines.push(line) }
    });
    if (options.pagedOpenThresholdBytes !== undefined) {
      workerFactory.setDesktopTestPagedOpenThresholdBytes(
        options.pagedOpenThresholdBytes
      );
    }

    const extensionUri = makeFileUri('file', '/ext');
    const fileUri = makeFileUri(scheme, scheme === 'untitled' ? 'test.db' : '/workspace/big.db');
    const bundle = await workerFactory.createDatabaseConnection(extensionUri, null as any);
    try {
      const connection = await bundle.establishConnection(fileUri, 'big.db');
      result.isReadOnly = connection.isReadOnly ?? false;
    } catch (error) {
      result.error = error as Error;
    }
  } finally {
    mockVscode.window.showWarningMessage = originalShowWarning;
  }

  return result;
}

const MB = 1024 * 1024;

describe('desktop workerFactory paged routing', () => {
  it('forwards the non-production paging-threshold override and otherwise omits it', async () => {
    const thresholdBytes = 64 * 1024;
    const overridden = await connectDesktop({
      fileSize: 128 * 1024,
      maxFileSizeBytes: 200 * MB,
      walSize: null,
      pagedOpenThresholdBytes: thresholdBytes
    });
    const ordinary = await connectDesktop({
      fileSize: 128 * 1024,
      maxFileSizeBytes: 200 * MB,
      walSize: null
    });

    assert.strictEqual(overridden.error, undefined);
    assert.strictEqual(overridden.config?.pagedOpenThresholdBytes, thresholdBytes);
    assert.strictEqual(
      ordinary.config?.pagedOpenThresholdBytes,
      undefined,
      'normal extension opens must keep the worker-owned production default'
    );
  });

  it('propagates a writable paged result without a read-only downgrade warning', async () => {
    const result = await connectDesktop({
      fileSize: 300 * MB,
      maxFileSizeBytes: 200 * MB,
      walSize: null,
      initResult: { isReadOnly: false, storage: 'paged' }
    });

    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.config?.allowPagedFallback, true);
    assert.strictEqual(result.config?.readOnlyMode, false);
    assert.strictEqual(result.isReadOnly, false, 'the editor mutation UI must stay enabled');
    assert.deepStrictEqual(result.toasts, []);
    assert.ok(!result.outputLines.some(line => /opened page-on-demand as read-only/.test(line)));
  });

  it('offers the paged fallback for an over-limit local file and surfaces the downgrade', async () => {
    const result = await connectDesktop({
      fileSize: 300 * MB,
      maxFileSizeBytes: 200 * MB,
      walSize: null,
      initResult: { isReadOnly: true, storage: 'paged' }
    });

    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.initCalls, 1);
    // The worker gets the path (not bytes) plus the fallback permission,
    // and decides paged-vs-buffer itself against its own stat.
    assert.strictEqual(result.config?.filePath, '/workspace/big.db');
    assert.strictEqual(result.config?.content, null);
    assert.strictEqual(result.config?.allowPagedFallback, true);
    assert.strictEqual(result.config?.maxSize, 200 * MB);
    // The size gate itself no longer forces read-only up front; the
    // paged open reports it back like the WAL gate's flag does.
    assert.strictEqual(result.config?.readOnlyMode, false);
    assert.strictEqual(result.isReadOnly, true, 'paged result must propagate read-only');
    // Reason surfaces as a toast and an output line, mirroring the WAL gate.
    assert.ok(
      result.toasts.some(message => /page-on-demand/.test(message) && /read-only/.test(message)),
      `expected a paged read-only toast, got: ${JSON.stringify(result.toasts)}`
    );
    assert.ok(
      result.toasts.every(message => !/maxFileSize/.test(message)),
      'raising or disabling maxFileSize must not be suggested as a way to bypass paging'
    );
    assert.ok(
      result.outputLines.some(line => /page-on-demand/.test(line) && /read-only/.test(line)),
      `expected a paged read-only output line, got: ${JSON.stringify(result.outputLines)}`
    );
  });

  it('rejects over-limit files with a frame-bearing -wal before dispatching to the worker', async () => {
    const result = await connectDesktop({
      fileSize: 300 * MB,
      maxFileSizeBytes: 200 * MB,
      walSize: 12392
    });

    assert.strictEqual(result.initCalls, 0, 'must reject before initializeDatabase');
    assert.ok(result.error);
    assert.match(result.error.message, /uncheckpointed WAL data/);
    assert.match(result.error.message, /wal_checkpoint\(TRUNCATE\)/);
    // Not the bare size error: the checkpoint instruction is the surface.
    assert.doesNotMatch(result.error.message, /Configure 'sqliteExplorer.maxFileSize'/);
  });

  it('treats an unstattable -wal beside an over-limit file the same as frames', async () => {
    const result = await connectDesktop({
      fileSize: 300 * MB,
      maxFileSizeBytes: 200 * MB,
      walSize: 'stat-error'
    });
    assert.strictEqual(result.initCalls, 0);
    assert.ok(result.error);
    assert.match(result.error.message, /wal_checkpoint\(TRUNCATE\)/);
  });

  it('lets clean checkpoint leftovers (empty or header-only -wal) page', async () => {
    for (const walSize of [0, 32]) {
      const result = await connectDesktop({
        fileSize: 300 * MB,
        maxFileSizeBytes: 200 * MB,
        walSize,
        initResult: { isReadOnly: true, storage: 'paged' }
      });
      assert.strictEqual(result.error, undefined, `walSize ${walSize} must not reject`);
      assert.strictEqual(result.config?.allowPagedFallback, true);
      assert.strictEqual(result.isReadOnly, true);
    }
  });

  it('surfaces today\'s exact size error when the worker cannot open paged', async () => {
    const workerFailure = new Error(
      "Failed to open database file '/workspace/big.db': file size (314572800 bytes) exceeds the maximum allowed size (209715200 bytes)"
    );
    const result = await connectDesktop({
      fileSize: 300 * MB,
      maxFileSizeBytes: 200 * MB,
      walSize: null,
      initError: workerFailure
    });

    assert.ok(result.error);
    assert.strictEqual(
      result.error.message,
      legacySizeMessage(300 * MB, 200 * MB),
      'the pre-fallback size message must be preserved byte-for-byte'
    );
    assert.strictEqual(result.error.cause, workerFailure);
    assert.ok(
      result.outputLines.some(line => /reporting the configured maxFileSize refusal/.test(line)),
      `expected a size-refusal output line, got: ${JSON.stringify(result.outputLines)}`
    );
    assert.deepStrictEqual(result.toasts, [], 'a failed open must not toast a downgrade');
  });

  it('keeps under-limit files on the unchanged editable path with no toast', async () => {
    const result = await connectDesktop({
      fileSize: 50 * MB,
      maxFileSizeBytes: 200 * MB,
      walSize: null
    });

    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.config?.filePath, '/workspace/big.db');
    assert.strictEqual(result.config?.readOnlyMode, false);
    // The permission flag is independent of maxSize: the worker applies its
    // paging threshold, and a small memory result must never toast.
    assert.strictEqual(result.config?.allowPagedFallback, true);
    assert.strictEqual(result.isReadOnly, false);
    assert.deepStrictEqual(result.toasts, []);
  });

  it('propagates a worker failure unchanged for under-limit files', async () => {
    const workerFailure = new Error('worker exploded for unrelated reasons');
    const result = await connectDesktop({
      fileSize: 50 * MB,
      maxFileSizeBytes: 200 * MB,
      walSize: null,
      initError: workerFailure
    });
    assert.strictEqual(result.error, workerFailure, 'no substitution under the gate');
  });

  it('passes an unlimited refusal cap (0) without disabling paged permission', async () => {
    const result = await connectDesktop({
      fileSize: 4096 * MB,
      maxFileSizeBytes: 0,
      walSize: null
    });
    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.config?.allowPagedFallback, true);
    assert.strictEqual(result.config?.maxSize, 0);
    assert.strictEqual(result.isReadOnly, false);
    assert.deepStrictEqual(result.toasts, []);
  });

  it('never offers the paged fallback on the byte-loading branch', async () => {
    const result = await connectDesktop({
      fileSize: 50 * MB,
      maxFileSizeBytes: 200 * MB,
      walSize: null,
      scheme: 'vscode-remote'
    });
    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.config?.filePath, undefined);
    assert.strictEqual(result.config?.allowPagedFallback, false);
  });

  it('keeps the plain size rejection for over-limit non-local files', async () => {
    const result = await connectDesktop({
      fileSize: 300 * MB,
      maxFileSizeBytes: 200 * MB,
      walSize: null,
      scheme: 'vscode-remote'
    });
    assert.strictEqual(result.initCalls, 0);
    assert.ok(result.error);
    assert.strictEqual(result.error.message, legacySizeMessage(300 * MB, 200 * MB));
    assert.strictEqual(result.error.cause, undefined, 'no substitution wrapper on the byte path');
  });

  it('never offers the paged fallback for untitled documents', async () => {
    const result = await connectDesktop({
      fileSize: 0,
      maxFileSizeBytes: 200 * MB,
      walSize: null,
      scheme: 'untitled'
    });
    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.config?.allowPagedFallback, false);
  });
});
