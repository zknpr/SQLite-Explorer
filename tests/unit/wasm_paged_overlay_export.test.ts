import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  WasmDatabaseEngine,
  type WasmDatabaseInstance,
  type WasmEnginePagedState
} from '../../src/core/engine/wasm/WasmDatabaseEngine';
import type {
  PagedFileIdentity,
  RawPagedWritableOverlay
} from '../../src/core/paged-writable-overlay';

const baseIdentity: PagedFileIdentity = {
  dev: 10n,
  ino: 20n,
  size: 30n,
  mtimeNs: 40n,
  mode: 0o640n
};

function fakeInstance(
  exportOverlay?: () => RawPagedWritableOverlay
): WasmDatabaseInstance {
  return {
    exec: () => [],
    prepare: () => { throw new Error('not used'); },
    iterateStatements: () => [],
    progress_handler: () => {},
    interrupt: () => {},
    export: () => new Uint8Array(),
    ...(exportOverlay ? { exportPagedWritableOverlay: exportOverlay } : {}),
    close: () => {}
  } as WasmDatabaseInstance;
}

function pagedState(overrides: Partial<WasmEnginePagedState> = {}): WasmEnginePagedState {
  return {
    writable: true,
    fileSizeBytes: 30,
    exactCountMaxFileBytes: 0,
    baseIdentity,
    ...overrides
  };
}

describe('WasmDatabaseEngine paged overlay export', () => {
  it('checks the frozen base immediately before and after extraction', () => {
    const events: string[] = [];
    const engine = new WasmDatabaseEngine(
      fakeInstance(() => {
        events.push('extract');
        return {
          chunkSize: 4,
          logicalSize: 8,
          baseLimit: 8,
          chunks: [{ index: 1, data: new Uint8Array([1, 2, 3, 4]) }]
        };
      }),
      5000,
      false,
      undefined,
      {},
      pagedState({ assertBaseUnchanged: () => { events.push('assert'); } })
    );

    const snapshot = engine.exportPagedWritableOverlay();

    assert.deepStrictEqual(events, ['assert', 'extract', 'assert']);
    assert.strictEqual(snapshot.baseIdentity, baseIdentity);
    assert.strictEqual(snapshot.dirtyBytes, 4);
    engine.shutdown();
  });

  it('is unavailable outside writable paged engines', () => {
    const raw = () => ({ chunkSize: 4, logicalSize: 0, baseLimit: 0, chunks: [] });
    const memory = new WasmDatabaseEngine(fakeInstance(raw));
    const readOnly = new WasmDatabaseEngine(
      fakeInstance(raw), 5000, false, undefined, {}, pagedState({ writable: false })
    );

    assert.throws(() => memory.exportPagedWritableOverlay(), /writable page-on-demand/i);
    assert.throws(() => readOnly.exportPagedWritableOverlay(), /writable page-on-demand/i);
    memory.shutdown();
    readOnly.shutdown();
  });

  it('rejects a stale writable fork without the overlay API', () => {
    const engine = new WasmDatabaseEngine(
      fakeInstance(), 5000, false, undefined, {}, pagedState()
    );
    assert.throws(
      () => engine.exportPagedWritableOverlay(),
      /does not expose exportPagedWritableOverlay/i
    );
    engine.shutdown();
  });

  it('normalizes the fork transaction gate and preserves its cause', () => {
    const forkError = new Error('cannot export a paged database while a transaction is open');
    const engine = new WasmDatabaseEngine(
      fakeInstance(() => { throw forkError; }),
      5000,
      false,
      undefined,
      {},
      pagedState()
    );

    assert.throws(
      () => engine.exportPagedWritableOverlay(),
      error => {
        assert.match((error as Error).message, /cannot save.*transaction.*retry after the edit completes/i);
        assert.strictEqual((error as Error).cause, forkError);
        return true;
      }
    );
    engine.shutdown();
  });

  it('warns once that a large logical database is fully rewritten on atomic save', () => {
    const oneGiB = 1024 * 1024 * 1024;
    const warnings: string[] = [];
    const largeIdentity = { ...baseIdentity, size: BigInt(oneGiB) };
    const engine = new WasmDatabaseEngine(
      fakeInstance(() => ({
        chunkSize: 4096,
        logicalSize: oneGiB,
        baseLimit: oneGiB,
        chunks: []
      })),
      5000,
      false,
      (level, ...args) => {
        if (level === 'warn') warnings.push(args.map(String).join(' '));
      },
      {},
      pagedState({ baseIdentity: largeIdentity, fileSizeBytes: oneGiB })
    );

    engine.exportPagedWritableOverlay();
    engine.exportPagedWritableOverlay();

    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /atomic save.*rewrites the full.*1073741824 bytes/i);
    engine.shutdown();
  });
});
