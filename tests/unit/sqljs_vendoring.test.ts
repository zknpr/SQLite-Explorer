import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';

const require = createRequire(import.meta.url);
const vendoredDirectory = path.resolve(process.cwd(), 'vendor/sql.js');
const vendoredGlue = path.join(vendoredDirectory, 'sql-wasm.js');
const vendoredWasm = path.join(vendoredDirectory, 'sql-wasm.wasm');
const PATCHED_WASM_SHA256 = '2615bf8bc5ee14bc719b728fc41d5f1feb65485045539e06994894d492b730ca';

describe('vendored sql.js', () => {
  it('provides the patched preemption APIs', async () => {
    assert.ok(existsSync(vendoredGlue), 'vendored sql-wasm.js is missing');
    assert.ok(existsSync(vendoredWasm), 'vendored sql-wasm.wasm is missing');

    const initSqlJs = require(vendoredGlue) as (config: {
      wasmBinary: Uint8Array;
    }) => Promise<{ Database: new () => {
      progress_handler: unknown;
      interrupt: unknown;
      close(): void;
    } }>;
    const SQL = await initSqlJs({ wasmBinary: readFileSync(vendoredWasm) });
    const database = new SQL.Database();

    try {
      assert.strictEqual(typeof database.progress_handler, 'function');
      assert.strictEqual(typeof database.interrupt, 'function');
    } finally {
      database.close();
    }
  });

  it('copies the pinned fork WASM into the extension assets', () => {
    const extensionWasm = path.resolve(process.cwd(), 'assets/sqlite3.wasm');
    assert.ok(existsSync(extensionWasm), 'extension WASM asset is missing');
    assert.strictEqual(
      createHash('sha256').update(readFileSync(extensionWasm)).digest('hex'),
      PATCHED_WASM_SHA256
    );
  });

  it('publishes an executable patched bundle for the web demo', async () => {
    const publicDirectory = path.resolve(
      process.cwd(),
      'website/public/sqlite-viewer'
    );
    const publicGlue = path.join(publicDirectory, 'sql-wasm.js');
    const publicWasm = path.join(publicDirectory, 'sql-wasm.wasm');
    assert.ok(existsSync(publicGlue), 'self-hosted demo sql-wasm.js is missing');
    assert.ok(existsSync(publicWasm), 'self-hosted demo sql-wasm.wasm is missing');

    const initSqlJs = require(publicGlue) as (config: {
      wasmBinary: Uint8Array;
    }) => Promise<{ Database: new () => {
      progress_handler: unknown;
      interrupt: unknown;
      close(): void;
    } }>;
    const SQL = await initSqlJs({ wasmBinary: readFileSync(publicWasm) });
    const database = new SQL.Database();
    try {
      assert.strictEqual(typeof database.progress_handler, 'function');
      assert.strictEqual(typeof database.interrupt, 'function');
    } finally {
      database.close();
    }
  });

  it('is the build consumed by the WASM engine factory', async () => {
    const result = await createDatabaseEngine({
      content: null,
      maxSize: 0,
      readOnlyMode: false
    });
    const engine = result.operations as WasmDatabaseEngine;
    const database = (engine as unknown as {
      instance: { progress_handler?: unknown; interrupt?: unknown };
    }).instance;

    try {
      assert.strictEqual(typeof database.progress_handler, 'function');
      assert.strictEqual(typeof database.interrupt, 'function');
    } finally {
      engine.shutdown();
    }
  });

  it('clears the progress handler after a normal query', async () => {
    const result = await createDatabaseEngine({
      content: null,
      maxSize: 0,
      readOnlyMode: false,
      queryTimeout: 1000
    });
    const engine = result.operations as WasmDatabaseEngine;
    const database = (engine as unknown as {
      instance: {
        progress_handler(nOps?: number | null, callback?: (() => unknown) | null): void;
      };
    }).instance;
    const originalProgressHandler = database.progress_handler.bind(database);
    const registrations: Array<number | null | undefined> = [];
    database.progress_handler = (nOps, callback) => {
      registrations.push(nOps);
      originalProgressHandler(nOps, callback);
    };

    try {
      const query = await engine.executeQuery('SELECT 42 AS value');
      assert.deepStrictEqual(query[0].rows, [[42]]);
      assert.strictEqual(registrations.length, 2);
      assert.ok(
        Number.isInteger(registrations[0]) && Number(registrations[0]) > 0,
        'normal query did not register a positive progress interval'
      );
      assert.strictEqual(registrations[1], null);
    } finally {
      engine.shutdown();
    }
  });
});
