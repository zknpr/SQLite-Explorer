import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { canPersistLocalDatabase } from '../../src/fileWritability';

it('requires write permission to the database and its parent, and propagates I/O failures', async () => {
  const filename = path.resolve('.tmp/permission-fixture/database.sqlite');
  const directory = path.dirname(filename);
  for (const blockedPath of [filename, directory]) {
    for (const code of ['EACCES', 'EPERM', 'EROFS', 'EIO']) {
      const error = Object.assign(new Error(`${blockedPath}: ${code}`), { code });
      const access = mock.method(fs.promises, 'access', async (candidate: fs.PathLike, mode?: number) => {
        assert.equal(mode, fs.constants.W_OK);
        if (candidate === blockedPath) throw error;
      });
      try {
        if (code === 'EIO') await assert.rejects(canPersistLocalDatabase(filename), value => value === error);
        else assert.equal(await canPersistLocalDatabase(filename), false);
      } finally { access.mock.restore(); }
    }
  }
  const visited: unknown[] = [];
  const access = mock.method(fs.promises, 'access', async (candidate: fs.PathLike) => {
    visited.push(candidate);
    if (candidate === filename) throw Object.assign(new Error('new database'), { code: 'ENOENT' });
  });
  try {
    assert.equal(await canPersistLocalDatabase(filename), true);
    assert.deepEqual(visited, [filename, directory]);
  } finally { access.mock.restore(); }
});
