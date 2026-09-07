import './vscode_mock_setup'; // Must be first.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as vscode from 'vscode';

import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import type { DatabaseOperations } from '../../src/core/types';
import {
  createNativeDatabaseConnection,
  NativeWorkerProcess
} from '../../src/nativeWorker';

async function withScratchDirectory(
  run: (directory: string) => Promise<void>
): Promise<void> {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'sqlite-explorer-engine-write-')
  );
  try {
    await run(directory);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

async function withMemoryEngine(
  run: (engine: DatabaseOperations) => Promise<void>
): Promise<void> {
  const opened = await createDatabaseEngine({
    content: null,
    maxSize: 0,
    readOnlyMode: false
  });
  try {
    await run(opened.operations!);
  } finally {
    (opened.operations as WasmDatabaseEngine).shutdown();
  }
}

async function querySavedFile(
  filePath: string,
  sql: string
): Promise<unknown[][]> {
  const opened = await createDatabaseEngine({
    content: null,
    filePath,
    maxSize: 0,
    readOnlyMode: false
  });
  try {
    return (await opened.operations!.executeQuery(sql))[0].rows;
  } finally {
    (opened.operations as WasmDatabaseEngine).shutdown();
  }
}

async function seedSqliteFile(filePath: string, table: string): Promise<void> {
  await withMemoryEngine(async engine => {
    await engine.executeQuery(
      `CREATE TABLE "${table}" (value TEXT); `
      + `INSERT INTO "${table}" VALUES ('seed')`
    );
    await engine.writeToFile(filePath);
  });
}

async function assertRealSqliteFile(filePath: string): Promise<void> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
    assert.strictEqual(bytesRead, 16);
    assert.strictEqual(header.toString('binary'), 'SQLite format 3\0');
  } finally {
    await handle.close();
  }
}

async function assertNoAtomicArtifacts(directory: string): Promise<void> {
  const entries = await fs.promises.readdir(directory);
  assert.deepStrictEqual(
    entries.filter(entry => entry.includes('.sqlite-explorer-')),
    []
  );
}

function getBundledNativeBinary(repoRoot: string): string | undefined {
  let platformDirectory: string | undefined;
  if (process.platform === 'darwin') {
    platformDirectory = process.arch === 'arm64' ? 'aarch64-macos' : 'x86_64-macos';
  } else if (process.platform === 'linux') {
    platformDirectory = process.arch === 'arm64'
      ? 'aarch64-linux-gnu'
      : 'x86_64-linux-gnu';
  } else if (process.platform === 'win32' && process.arch === 'x64') {
    platformDirectory = 'x86_64-windows';
  }
  if (!platformDirectory) return undefined;
  const binary = path.join(
    repoRoot,
    'natives',
    platformDirectory,
    process.platform === 'win32' ? 'tjs.exe' : 'tjs'
  );
  return fs.existsSync(binary) ? binary : undefined;
}

describe('atomic engine writeToFile integration', () => {
  it('creates and replaces a real SQLite file from a memory WASM database', async () => {
    await withScratchDirectory(async directory => {
      const targetPath = path.join(directory, 'wasm-save.sqlite');
      await withMemoryEngine(async engine => {
        await engine.executeQuery(
          "CREATE TABLE wasm_saved (id INTEGER PRIMARY KEY, value TEXT); "
          + "INSERT INTO wasm_saved VALUES (1, 'created')"
        );

        assert.deepStrictEqual(
          await engine.writeToFile(targetPath),
          { requiresReopen: false }
        );
        await assertRealSqliteFile(targetPath);
        assert.deepStrictEqual(
          await querySavedFile(targetPath, 'SELECT id, value FROM wasm_saved'),
          [[1, 'created']]
        );

        await engine.executeQuery(
          "UPDATE wasm_saved SET value = 'replaced' WHERE id = 1; "
          + "INSERT INTO wasm_saved VALUES (2, 'second')"
        );
        assert.deepStrictEqual(
          await engine.writeToFile(targetPath),
          { requiresReopen: false }
        );
        await assertRealSqliteFile(targetPath);
        assert.deepStrictEqual(
          await querySavedFile(
            targetPath,
            'SELECT id, value FROM wasm_saved ORDER BY id'
          ),
          [[1, 'replaced'], [2, 'second']]
        );
      });
      await assertNoAtomicArtifacts(directory);
    });
  });

  it('preserves an existing target when WASM export fails', async () => {
    await withScratchDirectory(async directory => {
      const targetPath = path.join(directory, 'export-failure.sqlite');
      await seedSqliteFile(targetPath, 'original_export_target');
      const originalBytes = await fs.promises.readFile(targetPath);

      await withMemoryEngine(async engine => {
        const instance = (engine as unknown as {
          instance: { export(): Uint8Array };
        }).instance;
        const originalExport = instance.export;
        const failure = new Error('synthetic WASM export failure');
        instance.export = () => { throw failure; };
        try {
          await assert.rejects(engine.writeToFile(targetPath), failure);
        } finally {
          instance.export = originalExport;
        }
      });

      assert.deepStrictEqual(await fs.promises.readFile(targetPath), originalBytes);
      assert.deepStrictEqual(
        await querySavedFile(
          targetPath,
          'SELECT value FROM original_export_target'
        ),
        [['seed']]
      );
      await assertNoAtomicArtifacts(directory);
    });
  });

  it('preserves an existing target and cleans up when the WASM temporary write fails', async () => {
    await withScratchDirectory(async directory => {
      const targetPath = path.join(directory, 'write-failure.sqlite');
      await seedSqliteFile(targetPath, 'original_write_target');
      const originalBytes = await fs.promises.readFile(targetPath);
      const originalWriteFile = fs.promises.writeFile;
      const failure = new Error('synthetic temporary write failure');

      await withMemoryEngine(async engine => {
        (fs.promises as unknown as { writeFile: typeof fs.promises.writeFile }).writeFile =
          (async (candidatePath: fs.PathLike, ...args: unknown[]) => {
            if (String(candidatePath).includes('.sqlite-explorer-')) throw failure;
            return (originalWriteFile as (...writeArgs: unknown[]) => Promise<void>)(
              candidatePath,
              ...args
            );
          }) as typeof fs.promises.writeFile;
        try {
          await assert.rejects(engine.writeToFile(targetPath), failure);
        } finally {
          (fs.promises as unknown as {
            writeFile: typeof fs.promises.writeFile;
          }).writeFile = originalWriteFile;
        }
      });

      assert.deepStrictEqual(await fs.promises.readFile(targetPath), originalBytes);
      assert.deepStrictEqual(
        await querySavedFile(targetPath, 'SELECT value FROM original_write_target'),
        [['seed']]
      );
      await assertNoAtomicArtifacts(directory);
    });
  });

  it('honors already-aborted and mid-export WASM signals without replacing the target', async () => {
    await withScratchDirectory(async directory => {
      const targetPath = path.join(directory, 'cancelled.sqlite');
      await seedSqliteFile(targetPath, 'original_cancel_target');
      const originalBytes = await fs.promises.readFile(targetPath);

      await withMemoryEngine(async engine => {
        const instance = (engine as unknown as {
          instance: { export(): Uint8Array };
        }).instance;
        const originalExport = instance.export;
        let exportCalls = 0;
        instance.export = () => {
          exportCalls++;
          return originalExport.call(instance);
        };
        try {
          const alreadyAborted = new AbortController();
          const earlyReason = new Error('already cancelled');
          alreadyAborted.abort(earlyReason);
          await assert.rejects(
            engine.writeToFile(targetPath, alreadyAborted.signal),
            earlyReason
          );
          assert.strictEqual(exportCalls, 0);

          const midFlight = new AbortController();
          const midFlightReason = new Error('cancelled after export');
          instance.export = () => {
            exportCalls++;
            const bytes = originalExport.call(instance);
            midFlight.abort(midFlightReason);
            return bytes;
          };
          await assert.rejects(
            engine.writeToFile(targetPath, midFlight.signal),
            midFlightReason
          );
          assert.strictEqual(exportCalls, 1);
        } finally {
          instance.export = originalExport;
        }
      });

      assert.deepStrictEqual(await fs.promises.readFile(targetPath), originalBytes);
      assert.deepStrictEqual(
        await querySavedFile(targetPath, 'SELECT value FROM original_cancel_target'),
        [['seed']]
      );
      await assertNoAtomicArtifacts(directory);
    });
  });

  it('atomically saves through the bundled native engine', async testContext => {
    const repoRoot = process.cwd();
    const nativeBinary = getBundledNativeBinary(repoRoot);
    const workerScript = path.join(repoRoot, 'natives', 'native-worker.js');
    if (!nativeBinary || !fs.existsSync(workerScript)) {
      testContext.skip(`no bundled txiki worker for ${process.platform}-${process.arch}`);
      return;
    }

    await withScratchDirectory(async directory => {
      const sourcePath = path.join(directory, 'native-source.sqlite');
      const targetPath = path.join(directory, 'native-target.sqlite');
      const sourceAliasPath = path.join(directory, 'native-source-alias.sqlite');
      await fs.promises.writeFile(sourcePath, new Uint8Array());
      await fs.promises.symlink(path.basename(sourcePath), sourceAliasPath);
      await seedSqliteFile(targetPath, 'old_native_target');

      let bundle: Awaited<ReturnType<typeof createNativeDatabaseConnection>> | undefined;
      try {
        bundle = await createNativeDatabaseConnection(vscode.Uri.file(repoRoot));
        const connection = await bundle.establishConnection(
          vscode.Uri.file(sourcePath),
          path.basename(sourcePath)
        );
        const engine = connection.databaseOps;
        await engine.executeQuery(
          "CREATE TABLE native_saved (id INTEGER PRIMARY KEY, value TEXT); "
          + "INSERT INTO native_saved VALUES (1, 'native')"
        );

        const saveAsResult = await engine.writeToFile(targetPath);
        assert.deepStrictEqual(saveAsResult, { requiresReopen: false });
        await assertRealSqliteFile(targetPath);
        assert.deepStrictEqual(
          await querySavedFile(targetPath, 'SELECT id, value FROM native_saved'),
          [[1, 'native']]
        );
        await assertNoAtomicArtifacts(directory);

        const beforeFailure = await fs.promises.readFile(sourcePath);
        await engine.executeQuery('BEGIN');
        try {
          await assert.rejects(
            engine.writeToFile(sourcePath),
            /cannot create a native database snapshot during an active transaction/i
          );
        } finally {
          await engine.executeQuery('ROLLBACK');
        }
        assert.deepStrictEqual(await fs.promises.readFile(sourcePath), beforeFailure);
        await assertNoAtomicArtifacts(directory);

        const midFlightCancellation = new AbortController();
        const midFlightCancellationReason = new Error('native save cancelled mid-flight');
        let reportVacuumStarted!: () => void;
        const vacuumStarted = new Promise<void>(resolve => {
          reportVacuumStarted = resolve;
        });
        const prototype = NativeWorkerProcess.prototype as unknown as {
          call: (...args: unknown[]) => Promise<unknown>;
        };
        const originalCall = prototype.call;
        prototype.call = function(this: NativeWorkerProcess, ...args: unknown[]) {
          const [method, methodArgs] = args;
          if (method === 'vacuumInto' && Array.isArray(methodArgs)) {
            reportVacuumStarted();
          }
          return originalCall.apply(this, args);
        };
        try {
          const pendingSave = engine.writeToFile(
            sourcePath,
            midFlightCancellation.signal
          );
          await vacuumStarted;
          midFlightCancellation.abort(midFlightCancellationReason);
          await assert.rejects(pendingSave, midFlightCancellationReason);
        } finally {
          prototype.call = originalCall;
        }
        assert.deepStrictEqual(await fs.promises.readFile(sourcePath), beforeFailure);
        await assertNoAtomicArtifacts(directory);

        const cancellation = new AbortController();
        const cancellationReason = new Error('native save cancelled');
        cancellation.abort(cancellationReason);
        await assert.rejects(
          engine.writeToFile(sourcePath, cancellation.signal),
          cancellationReason
        );
        assert.deepStrictEqual(await fs.promises.readFile(sourcePath), beforeFailure);
        await assertNoAtomicArtifacts(directory);

        const journalMode = await engine.executeQuery('PRAGMA journal_mode=WAL');
        assert.strictEqual(String(journalMode[0]?.rows[0]?.[0]).toLowerCase(), 'wal');
        await engine.executeQuery(
          "UPDATE native_saved SET value = 'native-wal' WHERE id = 1"
        );
        const sameSourceResult = await engine.writeToFile(sourcePath);
        assert.deepStrictEqual(sameSourceResult, { requiresReopen: true });
        assert.strictEqual((await fs.promises.lstat(sourceAliasPath)).isSymbolicLink(), true);
        await assertNoAtomicArtifacts(directory);

        const aliasResult = await engine.writeToFile(sourceAliasPath);
        assert.deepStrictEqual(aliasResult, { requiresReopen: true });
        assert.strictEqual((await fs.promises.lstat(sourceAliasPath)).isSymbolicLink(), true);
        assert.strictEqual(await fs.promises.readlink(sourceAliasPath), path.basename(sourcePath));
        assert.deepStrictEqual(
          await querySavedFile(sourcePath, 'SELECT id, value FROM native_saved'),
          [[1, 'native-wal']]
        );
        await assertNoAtomicArtifacts(directory);
      } finally {
        bundle?.workerMethods[Symbol.dispose]();
      }
    });
  });
});
