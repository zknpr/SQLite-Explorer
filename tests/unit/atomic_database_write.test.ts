import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { writeDatabaseSnapshotAtomically } from '../../src/atomicDatabaseWrite';

async function withScratchDirectory(
  run: (directory: string) => Promise<void>
): Promise<void> {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'sqlite-explorer-atomic-write-')
  );
  try {
    await run(directory);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function assertNoAtomicTemporaryFiles(directory: string): Promise<void> {
  const entries = await fs.promises.readdir(directory);
  assert.deepStrictEqual(
    entries.filter((entry) => entry.includes('.sqlite-explorer-') && entry.endsWith('.tmp')),
    []
  );
}

describe('writeDatabaseSnapshotAtomically', () => {
  it('refuses to replace a clean WAL target while another connection retains it', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX pathname replacement is the corruption path under review');
      return;
    }

    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
      const peer = new DatabaseSync(targetPath);
      try {
        peer.exec(
          'PRAGMA journal_mode=WAL; '
          + 'CREATE TABLE original (value TEXT); '
          + "INSERT INTO original VALUES ('keep me')"
        );
        assert.deepStrictEqual(
          { ...peer.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() },
          { busy: 0, log: 0, checkpointed: 0 },
          'the peer must retain a clean WAL with no frames for the replacement gate to detect'
        );

        await assert.rejects(
          writeDatabaseSnapshotAtomically(
            fs,
            undefined,
            targetPath,
            async (temporaryPath) => {
              const replacement = new DatabaseSync(temporaryPath);
              try {
                replacement.exec('CREATE TABLE replacement (value TEXT)');
              } finally {
                replacement.close();
              }
            }
          ),
          /exclusive SQLite lock.*close other connections/i
        );

        assert.deepStrictEqual(
          peer.prepare('SELECT value FROM original').all().map(row => ({ ...row })),
          [{ value: 'keep me' }]
        );
      } finally {
        peer.close();
      }

      const reopened = new DatabaseSync(targetPath, { readOnly: true });
      try {
        assert.deepStrictEqual(
          reopened.prepare('SELECT value FROM original').all().map(row => ({ ...row })),
          [{ value: 'keep me' }]
        );
        assert.throws(
          () => reopened.prepare('SELECT * FROM replacement').all(),
          /no such table: replacement/i
        );
      } finally {
        reopened.close();
      }
      await assertNoAtomicTemporaryFiles(directory);
    });
  });

  it('preserves an existing target and removes the temporary file when the producer fails', async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      const originalBytes = Buffer.from('existing database bytes');
      let temporaryPath: string | undefined;
      await fs.promises.writeFile(targetPath, originalBytes);

      await assert.rejects(
        writeDatabaseSnapshotAtomically(
          fs,
          undefined,
          targetPath,
          async (candidatePath) => {
            temporaryPath = candidatePath;
            await fs.promises.writeFile(candidatePath, 'incomplete snapshot');
            throw new Error('producer failed');
          }
        ),
        /producer failed/
      );

      assert.deepStrictEqual(await fs.promises.readFile(targetPath), originalBytes);
      assert.ok(temporaryPath, 'the producer should receive a temporary path');
      assert.strictEqual(await pathExists(temporaryPath), false);
      await assertNoAtomicTemporaryFiles(directory);
    });
  });

  it('atomically replaces an existing target with the produced snapshot', async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      const replacementBytes = Buffer.from('replacement database bytes');
      let temporaryPath: string | undefined;
      await fs.promises.writeFile(targetPath, 'old database bytes');

      const result = await writeDatabaseSnapshotAtomically(
        fs,
        undefined,
        targetPath,
        async (candidatePath) => {
          temporaryPath = candidatePath;
          await fs.promises.writeFile(candidatePath, replacementBytes);
        }
      );

      assert.deepStrictEqual(result, { requiresReopen: false });
      assert.deepStrictEqual(await fs.promises.readFile(targetPath), replacementBytes);
      assert.ok(temporaryPath, 'the producer should receive a temporary path');
      assert.strictEqual(await pathExists(temporaryPath), false);
      await assertNoAtomicTemporaryFiles(directory);
    });
  });

  it('replaces the resolved target without replacing a symlink', async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      const linkPath = path.join(directory, 'database-link.db');
      const replacementBytes = Buffer.from('replacement through symlink');
      let temporaryPath: string | undefined;
      await fs.promises.writeFile(targetPath, 'old database bytes');
      await fs.promises.symlink(path.basename(targetPath), linkPath);

      const result = await writeDatabaseSnapshotAtomically(
        fs,
        undefined,
        linkPath,
        async (candidatePath) => {
          temporaryPath = candidatePath;
          await fs.promises.writeFile(candidatePath, replacementBytes);
        }
      );

      assert.deepStrictEqual(result, { requiresReopen: false });
      assert.strictEqual((await fs.promises.lstat(linkPath)).isSymbolicLink(), true);
      assert.strictEqual(await fs.promises.readlink(linkPath), path.basename(targetPath));
      assert.deepStrictEqual(await fs.promises.readFile(targetPath), replacementBytes);
      assert.deepStrictEqual(await fs.promises.readFile(linkPath), replacementBytes);
      assert.ok(temporaryPath, 'the producer should receive a temporary path');
      assert.strictEqual(
        path.dirname(temporaryPath),
        await fs.promises.realpath(directory)
      );
      assert.strictEqual(await pathExists(temporaryPath), false);
      await assertNoAtomicTemporaryFiles(directory);
    });
  });

  it('refuses a dangling symlink without invoking the producer', async () => {
    await withScratchDirectory(async (directory) => {
      const linkPath = path.join(directory, 'dangling.db');
      const missingTarget = 'missing.db';
      let producerCalled = false;
      await fs.promises.symlink(missingTarget, linkPath);

      await assert.rejects(
        writeDatabaseSnapshotAtomically(
          fs,
          undefined,
          linkPath,
          async () => {
            producerCalled = true;
          }
        ),
        /cannot save through dangling symlink/i
      );

      assert.strictEqual(producerCalled, false);
      assert.strictEqual((await fs.promises.lstat(linkPath)).isSymbolicLink(), true);
      assert.strictEqual(await fs.promises.readlink(linkPath), missingTarget);
      await assertNoAtomicTemporaryFiles(directory);
    });
  });

  it('refuses a target generation change without clobbering the newer bytes', async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      const newerBytes = Buffer.from('newer target generation with a different byte length');
      let temporaryPath: string | undefined;
      await fs.promises.writeFile(targetPath, 'old bytes');

      await assert.rejects(
        writeDatabaseSnapshotAtomically(
          fs,
          undefined,
          targetPath,
          async (candidatePath) => {
            temporaryPath = candidatePath;
            await fs.promises.writeFile(candidatePath, 'stale produced snapshot');
            await fs.promises.writeFile(targetPath, newerBytes);
          }
        ),
        /database save target changed during the save; retry/i
      );

      assert.deepStrictEqual(await fs.promises.readFile(targetPath), newerBytes);
      assert.ok(temporaryPath, 'the producer should receive a temporary path');
      assert.strictEqual(await pathExists(temporaryPath), false);
      await assertNoAtomicTemporaryFiles(directory);
    });
  });

  it('honors cancellation after validation and before the atomic rename', async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      const originalBytes = Buffer.from('old database bytes');
      const replacementBytes = Buffer.from('replacement database bytes');
      const cancellation = new AbortController();
      const reason = new Error('cancelled at the commit boundary');
      await fs.promises.writeFile(targetPath, originalBytes);

      const hookedFs = Object.create(fs) as typeof fs;
      Object.defineProperty(hookedFs, 'lstatSync', {
        value(candidatePath: fs.PathLike, options?: unknown) {
          const result = (fs.lstatSync as (...args: unknown[]) => fs.Stats)(
            candidatePath,
            options
          );
          if (String(candidatePath).includes('.sqlite-explorer-')) {
            cancellation.abort(reason);
          }
          return result;
        }
      });

      await assert.rejects(
        writeDatabaseSnapshotAtomically(
          hookedFs,
          undefined,
          targetPath,
          async (temporaryPath) => {
            await fs.promises.writeFile(temporaryPath, replacementBytes);
          },
          cancellation.signal
        ),
        reason
      );

      assert.deepStrictEqual(await fs.promises.readFile(targetPath), originalBytes);
      await assertNoAtomicTemporaryFiles(directory);
    });
  });

  it('reports requiresReopen when the active source resolves to the target', async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'database.db');
      const sourceLinkPath = path.join(directory, 'active-database.db');
      const replacementBytes = Buffer.from('replacement of active source');
      await fs.promises.writeFile(targetPath, 'old active database bytes');
      await fs.promises.symlink(path.basename(targetPath), sourceLinkPath);

      const result = await writeDatabaseSnapshotAtomically(
        fs,
        sourceLinkPath,
        targetPath,
        async (temporaryPath) => {
          await fs.promises.writeFile(temporaryPath, replacementBytes);
        }
      );

      assert.deepStrictEqual(result, { requiresReopen: true });
      assert.strictEqual((await fs.promises.lstat(sourceLinkPath)).isSymbolicLink(), true);
      assert.deepStrictEqual(await fs.promises.readFile(sourceLinkPath), replacementBytes);
      await assertNoAtomicTemporaryFiles(directory);
    });
  });

  it('creates a missing target from the produced snapshot', async () => {
    await withScratchDirectory(async (directory) => {
      const targetPath = path.join(directory, 'new-database.db');
      const snapshotBytes = Buffer.from('new database snapshot');
      let temporaryPath: string | undefined;

      const result = await writeDatabaseSnapshotAtomically(
        fs,
        undefined,
        targetPath,
        async (candidatePath) => {
          temporaryPath = candidatePath;
          await fs.promises.writeFile(candidatePath, snapshotBytes);
        }
      );

      assert.deepStrictEqual(result, { requiresReopen: false });
      assert.deepStrictEqual(await fs.promises.readFile(targetPath), snapshotBytes);
      assert.ok(temporaryPath, 'the producer should receive a temporary path');
      assert.strictEqual(await pathExists(temporaryPath), false);
      await assertNoAtomicTemporaryFiles(directory);
    });
  });
});
