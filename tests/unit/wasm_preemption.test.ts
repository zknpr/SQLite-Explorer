import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { connectWorkerPort, type WorkerPort } from '../../src/core/rpc';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import * as cancellationUtils from '../../src/core/cancellation-utils';
import type { DatabaseInitConfig, DatabaseInitResult, QueryResultSet } from '../../src/core/types';

const LONG_RUNNING_QUERY =
  'WITH RECURSIVE counter(value) AS (' +
  'VALUES(1) UNION ALL SELECT value + 1 FROM counter WHERE value < 100000000' +
  ') SELECT sum(value) FROM counter';

interface SharedCancellationHandle {
  flag: Int32Array;
  dispose(): void;
}

interface BuiltWorkerMethods {
  initializeDatabase(
    filename: string,
    config: DatabaseInitConfig
  ): Promise<DatabaseInitResult>;
  runQuery(
    sql: string,
    params?: unknown[],
    cancellationFlag?: Int32Array
  ): Promise<QueryResultSet[]>;
}

function getSharedCancellationFactory(): (
  signal?: AbortSignal
) => SharedCancellationHandle | undefined {
  const factory = (cancellationUtils as Record<string, unknown>)
    .createSharedCancellationFlag;
  assert.strictEqual(
    typeof factory,
    'function',
    'shared cancellation factory is not implemented'
  );
  return factory as (signal?: AbortSignal) => SharedCancellationHandle | undefined;
}

describe('WASM query preemption', () => {
  it('preempts a running query through a shared flag in the Node worker', async (t) => {
    const workerPath = path.resolve(process.cwd(), 'out/worker.cjs');
    const wasmPath = path.resolve(process.cwd(), 'assets/sqlite3.wasm');
    if (!existsSync(workerPath) || !existsSync(wasmPath)) {
      t.skip('worker build artifacts are missing; run node scripts/build.mjs');
      return;
    }

    const createSharedCancellationFlag = getSharedCancellationFactory();
    const worker = new Worker(workerPath);
    const proxy = connectWorkerPort<BuiltWorkerMethods>(
      worker as unknown as WorkerPort,
      ['initializeDatabase', 'runQuery'],
      undefined,
      5000
    );
    let cancellation: SharedCancellationHandle | undefined;

    try {
      await proxy.initializeDatabase('preemption.db', {
        content: null,
        maxSize: 0,
        wasmBinary: new Uint8Array(readFileSync(wasmPath)),
        readOnlyMode: false,
        queryTimeout: 2000
      });

      const controller = new AbortController();
      cancellation = createSharedCancellationFlag(controller.signal);
      assert.ok(cancellation, 'Node worker_threads must support SharedArrayBuffer');
      const startedAt = performance.now();
      const pendingQuery = proxy.runQuery(LONG_RUNNING_QUERY, [], cancellation.flag);
      const cancelTimer = setTimeout(() => controller.abort(), 20);

      try {
        await assert.rejects(pendingQuery, /Query failed: Query execution cancelled/);
      } finally {
        clearTimeout(cancelTimer);
      }
      assert.ok(
        performance.now() - startedAt < 500,
        'worker query reached its deadline instead of observing host cancellation'
      );
    } finally {
      cancellation?.dispose();
      await worker.terminate();
    }
  });

  it('falls back to the deadline when browser isolation disables shared cancellation', async () => {
    const createSharedCancellationFlag = getSharedCancellationFactory();
    const isolationDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'crossOriginIsolated'
    );
    Object.defineProperty(globalThis, 'crossOriginIsolated', {
      configurable: true,
      value: false
    });

    try {
      assert.strictEqual(
        createSharedCancellationFlag(new AbortController().signal),
        undefined
      );
    } finally {
      if (isolationDescriptor) {
        Object.defineProperty(globalThis, 'crossOriginIsolated', isolationDescriptor);
      } else {
        delete (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
      }
    }

    const result = await createDatabaseEngine({
      content: null,
      maxSize: 0,
      readOnlyMode: false,
      queryTimeout: 20
    });
    const engine = result.operations as WasmDatabaseEngine;
    const startedAt = performance.now();

    try {
      await assert.rejects(
        engine.executeQuery(LONG_RUNNING_QUERY),
        /Query failed: Query execution timed out after 20ms/
      );
      assert.ok(performance.now() - startedAt < 500);
    } finally {
      engine.shutdown();
    }
  });
});
