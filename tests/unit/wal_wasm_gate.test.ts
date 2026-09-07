import './vscode_mock_setup';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import Module from 'node:module';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import esbuild from 'esbuild';
import { mockVscode } from './mocks/vscode';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import type { DatabaseInitConfig } from '../../src/core/types';

/**
 * WAL/WASM correctness lane.
 *
 * sql.js opens exactly one database image and never merges the sibling `-wal`
 * file, so committed-but-uncheckpointed WAL transactions are invisible to the
 * WASM backend. The first block pins that engine reality (it is WHY the gate
 * exists); the second block asserts the desktop workerFactory gate that forces
 * such databases read-only instead of letting a save destroy the WAL data.
 */

// ============================================================================
// Fixture: a WAL database whose committed rows exist only in the -wal file
// ============================================================================

interface WalFixture {
  /** Main database file; its pages predate the committed transactions. */
  dbPath: string;
  /** Sibling -wal file holding the committed CREATE TABLE + INSERT frames. */
  walPath: string;
  walSize: number;
}

const hasSqliteCli = spawnSync('sqlite3', ['--version']).status === 0;

/**
 * Build the fixture with the sqlite3 CLI.
 *
 * SQLite checkpoints the WAL when the last connection closes, so the files are
 * snapshotted while the writer connection is still open and the writer is then
 * SIGKILLed. Any later sqlite3 CLI read of the fixture would itself checkpoint
 * it — ground truth is therefore verified on sacrificial copies, and tests
 * must treat the fixture files as read-only inputs.
 */
async function createUncheckpointedWalFixture(dir: string): Promise<WalFixture> {
  const livePath = path.join(dir, 'live.db');
  const dbPath = path.join(dir, 'fixture.db');
  const walPath = `${dbPath}-wal`;

  const child = spawn('sqlite3', [livePath]);
  try {
    const ready = new Promise<void>((resolve, reject) => {
      let output = '';
      child.stdout.on('data', chunk => {
        output += String(chunk);
        if (output.includes('FIXTURE_READY')) resolve();
      });
      child.stderr.on('data', chunk => {
        reject(new Error(`sqlite3 fixture writer failed: ${String(chunk).trim()}`));
      });
      child.on('error', reject);
      child.on('exit', code => {
        reject(new Error(`sqlite3 fixture writer exited early (code ${code})`));
      });
    });
    child.stdin.write(
      'PRAGMA journal_mode=WAL;\n' +
      'CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT);\n' +
      "INSERT INTO t(name) VALUES ('alpha'),('beta'),('gamma');\n" +
      "SELECT 'FIXTURE_READY';\n"
    );
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error('timed out waiting for sqlite3 fixture writer')),
        15_000
      ).unref())
    ]);

    // Snapshot while the writer still holds the connection open.
    fs.copyFileSync(livePath, dbPath);
    fs.copyFileSync(`${livePath}-wal`, walPath);
  } finally {
    child.kill('SIGKILL');
  }

  // Ground truth on sacrificial copies: the committed rows really are on disk,
  // reachable by any WAL-aware reader (native backend, sqlite3 CLI).
  const verifyDb = path.join(dir, 'verify.db');
  fs.copyFileSync(dbPath, verifyDb);
  fs.copyFileSync(walPath, `${verifyDb}-wal`);
  const committedRows = execFileSync('sqlite3', [verifyDb, 'SELECT count(*) FROM t;'])
    .toString().trim();
  assert.strictEqual(committedRows, '3', 'fixture must hold 3 committed rows in db+wal');

  const walSize = fs.statSync(walPath).size;
  // 32-byte WAL header + at least one 24 + page_size frame.
  assert.ok(walSize > 32, `fixture -wal must contain frames, got ${walSize} bytes`);
  return { dbPath, walPath, walSize };
}

// ============================================================================
// Part 1: the engine reality the gate protects against
// ============================================================================

describe('WASM engine WAL blindness (why the desktop gate exists)', () => {
  let fixtureDir: string;
  let fixture: WalFixture | null = null;

  before(async () => {
    if (!hasSqliteCli) return;
    const tmpRoot = path.join(process.cwd(), '.tmp');
    fs.mkdirSync(tmpRoot, { recursive: true });
    fixtureDir = fs.mkdtempSync(path.join(tmpRoot, 'wal-gate-'));
    fixture = await createUncheckpointedWalFixture(fixtureDir);
  });

  after(() => {
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  async function assertCommittedRowsInvisible(config: DatabaseInitConfig): Promise<void> {
    const result = await createDatabaseEngine(config);
    const engine = result.operations!;
    try {
      // The CREATE TABLE lives only in WAL frames: sql.js sees an empty schema
      // and reports the committed table as nonexistent — no error, no warning.
      const master = await engine.executeQuery(
        "SELECT name FROM sqlite_master WHERE type='table'"
      );
      const tables = master.flatMap(resultSet => resultSet.rows ?? []);
      assert.deepStrictEqual(tables, [], 'committed table must be invisible to sql.js');
      await assert.rejects(
        engine.executeQuery('SELECT count(*) FROM t'),
        /no such table/
      );
    } finally {
      (engine as WasmDatabaseEngine).shutdown();
    }
  }

  it('silently misses committed rows when given main-db-only bytes', async (t) => {
    if (!fixture) { t.skip('sqlite3 CLI unavailable'); return; }
    await assertCommittedRowsInvisible({
      content: fs.readFileSync(fixture.dbPath),
      maxSize: 0,
      readOnlyMode: false
    });
  });

  it('is equally blind on the filePath fast path despite the sibling -wal file', async (t) => {
    if (!fixture) { t.skip('sqlite3 CLI unavailable'); return; }
    assert.ok(fs.existsSync(fixture.walPath), '-wal must sit beside the database');
    await assertCommittedRowsInvisible({
      content: null,
      filePath: fixture.dbPath,
      maxSize: 0,
      readOnlyMode: false
    });
  });
});

// ============================================================================
// Part 2: the desktop workerFactory gate
// ============================================================================

const workerFactoryPath = path.resolve(__dirname, '../../src/workerFactory.ts');
const workerFactorySource = fs.readFileSync(workerFactoryPath, 'utf8');

class FakeTransfer<T> {
  constructor(
    public readonly value: T,
    public readonly transferables: Transferable[]
  ) {}
}

/**
 * Compile workerFactory for the desktop (non-browser) environment with the
 * worker RPC seam faked out, mirroring workerFactory_browser.test.ts.
 */
function loadDesktopWorkerFactory(options: {
  onInitializeDatabase: (
    filename: string,
    config: DatabaseInitConfig,
    transferables: Transferable[]
  ) => Promise<{ isReadOnly: boolean }>;
  outputChannel?: { appendLine(line: string): void };
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
      // Force the WASM fallback: behave like a platform without a native binary.
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
            const transferables = config instanceof FakeTransfer ? config.transferables : [];
            return options.onInitializeDatabase(filename, unwrapped, transferables);
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

interface DesktopConnectResult {
  config: DatabaseInitConfig | undefined;
  transferables: Transferable[];
  isReadOnly: boolean | undefined;
  toasts: string[];
  outputLines: string[];
  walStatCount: number;
}

/**
 * Drive the desktop WASM establishConnection with a mocked filesystem.
 *
 * @param walSize - Size vsc.workspace.fs.stat reports for the -wal file, or
 *   null to make the stat fail as if the file does not exist.
 */
async function connectDesktop(options: {
  /** -wal stat outcome: a size, null for FileNotFound, 'stat-error' for a non-not-found failure. */
  walSize: number | null | 'stat-error';
  scheme?: string;
  forceReadOnly?: boolean;
}): Promise<DesktopConnectResult> {
  const scheme = options.scheme ?? 'file';
  const result: DesktopConnectResult = {
    config: undefined,
    transferables: [],
    isReadOnly: undefined,
    toasts: [],
    outputLines: [],
    walStatCount: 0
  };

  Object.defineProperty(mockVscode.workspace, 'fs', {
    value: {
      stat: async (uri: { path?: string; fsPath?: string }) => {
        const pathValue = uri.path ?? uri.fsPath ?? '';
        if (pathValue.endsWith('-wal')) {
          result.walStatCount += 1;
          if (options.walSize === null) {
            // Real vsc.workspace.fs.stat failures carry FileSystemError codes.
            throw Object.assign(new Error('ENOENT: no -wal file'), { code: 'FileNotFound' });
          }
          if (options.walSize === 'stat-error') {
            throw Object.assign(new Error('EACCES: permission denied'), { code: 'NoPermissions' });
          }
          return { size: options.walSize };
        }
        return { size: 4096 };
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
      onInitializeDatabase: async (_filename, config, transferables) => {
        result.config = config;
        result.transferables = transferables;
        return { isReadOnly: config.readOnlyMode ?? false };
      },
      outputChannel: { appendLine: line => result.outputLines.push(line) }
    });

    const extensionUri = makeFileUri('file', '/ext');
    const fileUri = makeFileUri(scheme, scheme === 'untitled' ? 'test.db' : '/workspace/test.db');
    const bundle = await workerFactory.createDatabaseConnection(extensionUri, null as any);
    const connection = await bundle.establishConnection(
      fileUri,
      'test.db',
      options.forceReadOnly
    );
    result.isReadOnly = connection.isReadOnly ?? false;
  } finally {
    mockVscode.window.showWarningMessage = originalShowWarning;
  }

  return result;
}

describe('desktop WASM WAL gate in workerFactory', () => {
  it('forces read-only and surfaces the reason for a frame-bearing -wal beside a local file', async () => {
    // 12392 = 32-byte header + 3 frames of (24 + 4096): the fixture shape.
    const result = await connectDesktop({ walSize: 12392 });

    assert.strictEqual(result.config?.readOnlyMode, true, 'engine must open read-only');
    assert.strictEqual(result.isReadOnly, true, 'connection must report read-only');
    // The local fast path must keep handing the worker a path, not bytes.
    assert.strictEqual(result.config?.filePath, '/workspace/test.db');
    assert.strictEqual(result.config?.content, null);
    // Reason surfaces both as a toast and in the output channel.
    assert.ok(
      result.toasts.some(message => /WAL/.test(message)),
      `expected a WAL warning toast, got: ${JSON.stringify(result.toasts)}`
    );
    assert.ok(
      result.outputLines.some(line => /WAL/i.test(line) && /read-only/i.test(line)),
      `expected a WAL read-only line in the output channel, got: ${JSON.stringify(result.outputLines)}`
    );
  });

  it('no longer ships dead walContent bytes to the worker', async () => {
    const result = await connectDesktop({ walSize: 12392 });
    assert.ok(result.config, 'initializeDatabase must be called');
    assert.ok(
      !('walContent' in result.config!),
      'walContent must not be part of the init config'
    );
    // Only the WASM binary buffer is transferred on the filePath fast path.
    assert.strictEqual(result.transferables.length, 1);
  });

  it('stays writable when no -wal file exists', async () => {
    const result = await connectDesktop({ walSize: null });
    assert.strictEqual(result.config?.readOnlyMode, false);
    assert.strictEqual(result.isReadOnly, false);
    assert.deepStrictEqual(result.toasts, []);
  });

  it('ignores empty and header-only -wal files left by clean checkpoints', async () => {
    // 0 bytes: wal_checkpoint(TRUNCATE), and macOS system SQLite persists an
    // empty -wal after a clean close. 32 bytes: bare header, no frames.
    for (const walSize of [0, 32]) {
      const result = await connectDesktop({ walSize });
      assert.strictEqual(result.config?.readOnlyMode, false, `walSize ${walSize} must not gate`);
      assert.strictEqual(result.isReadOnly, false, `walSize ${walSize} must stay writable`);
      assert.deepStrictEqual(result.toasts, [], `walSize ${walSize} must not warn`);
    }
    // Boundary: the smallest size that can hold frame bytes beyond the header.
    const gated = await connectDesktop({ walSize: 33 });
    assert.strictEqual(gated.config?.readOnlyMode, true, 'walSize 33 must gate');
  });

  it('fails toward read-only when the -wal cannot be statted for a reason other than absence', async () => {
    // An EACCES/provider error means committed WAL frames may exist but be
    // invisible to sql.js — the gate must engage, not silently disarm.
    const result = await connectDesktop({ walSize: 'stat-error' });
    assert.strictEqual(result.config?.readOnlyMode, true, 'unknown WAL state must gate');
    assert.strictEqual(result.isReadOnly, true);
    assert.ok(
      result.toasts.some(message => /WAL/.test(message)),
      'the downgrade must surface to the user'
    );
    assert.ok(
      result.outputLines.some(line => /could not inspect/.test(line) && /read-only/.test(line)),
      `expected the stat failure to be logged, got: ${JSON.stringify(result.outputLines)}`
    );
  });

  it('fails toward read-only when a provider returns an invalid -wal size', async () => {
    for (const walSize of [Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const result = await connectDesktop({ walSize });
      assert.strictEqual(result.config?.readOnlyMode, true, `invalid WAL size ${walSize} must gate`);
      assert.strictEqual(result.isReadOnly, true);
      assert.ok(
        result.outputLines.some(line => /invalid size/.test(line) && /read-only/.test(line)),
        `invalid WAL size ${walSize} was not reported: ${JSON.stringify(result.outputLines)}`
      );
    }
  });

  it('keeps forceReadOnly working independently of WAL state', async () => {
    const result = await connectDesktop({ walSize: null, forceReadOnly: true });
    assert.strictEqual(result.config?.readOnlyMode, true);
    assert.strictEqual(result.isReadOnly, true);
    assert.deepStrictEqual(result.toasts, [], 'forced read-only is not a WAL downgrade');
  });

  it('gates the byte-loading branch for non-file schemes too', async () => {
    const result = await connectDesktop({ walSize: 12392, scheme: 'vscode-remote' });
    assert.strictEqual(result.config?.readOnlyMode, true);
    assert.strictEqual(result.isReadOnly, true);
    // Non-local files are shipped as bytes, not a path.
    assert.strictEqual(result.config?.filePath, undefined);
    assert.strictEqual(result.config?.content?.byteLength, 3);
  });

  it('skips WAL detection entirely for untitled documents', async () => {
    const result = await connectDesktop({ walSize: 12392, scheme: 'untitled' });
    assert.strictEqual(result.config?.readOnlyMode, false);
    assert.strictEqual(result.walStatCount, 0, 'untitled must never stat a -wal path');
  });
});
