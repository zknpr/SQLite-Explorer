import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const desktopDirectory = path.resolve(process.cwd(), 'desktop');
const manifest = JSON.parse(readFileSync(path.resolve('vendor/query-plan-manifest.json'), 'utf8')) as {
  outputs: Record<string, string>;
};
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

describe('desktop sql.js runtime copies', () => {
  // desktop/ is synced verbatim into the Tauri shell, and build.mjs copies both
  // runtime files from vendor/sql.js. Pin the committed copies to the verified
  // provenance so a vendor re-pin without a rebuild (or a hand-edited desktop/
  // copy) fails here rather than after the shell has synced it.
  it('ships the verified query-plan build of sql.js beside the viewer', () => {
    for (const [copy, source] of [
      ['sql-wasm.js', 'vendor/sql.js/sql-wasm.js'],
      ['sql-wasm.wasm', 'vendor/sql.js/sql-wasm.wasm']
    ]) {
      const file = path.join(desktopDirectory, copy);
      assert.ok(existsSync(file), `desktop/${copy} is missing; run node scripts/build.mjs`);
      assert.strictEqual(sha256(file), manifest.outputs[source], `desktop/${copy} is stale; run node scripts/build.mjs`);
    }
  });

  it('boots the desktop worker runtime with the patched preemption APIs', async () => {
    const initSqlJs = require(path.join(desktopDirectory, 'sql-wasm.js')) as (config: {
      wasmBinary: Uint8Array;
    }) => Promise<{ Database: new () => {
      progress_handler: unknown;
      interrupt: unknown;
      close(): void;
    } }>;
    const SQL = await initSqlJs({ wasmBinary: readFileSync(path.join(desktopDirectory, 'sql-wasm.wasm')) });
    const database = new SQL.Database();
    try {
      assert.strictEqual(typeof database.progress_handler, 'function');
      assert.strictEqual(typeof database.interrupt, 'function');
    } finally {
      database.close();
    }
  });
});
