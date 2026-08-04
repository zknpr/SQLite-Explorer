import './vscode_mock_setup'; // Must precede imports that load vscode.

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import {
  formatComparisonTable,
  parseCliArgs,
  relativeDeltaPercent,
  summarizeMeasurements,
  type CandidateBenchmarkResult
} from '../../scripts/bench-native-lib';
import {
  assertAsyncCancellationAvailable,
  buildPayloadMaximumExpression,
  buildPayloadQuerySql,
  CANCELLATION_MODE,
  TEMP_CLEANUP_OPTIONS
} from '../../scripts/bench-native';

describe('native benchmark CLI plumbing', () => {
  const repoRoot = path.resolve('/repo');

  it('uses the bundled platform binary, large fixture, and stable default iteration count', () => {
    const options = parseCliArgs([], repoRoot, 'darwin', 'arm64');

    assert.deepStrictEqual(options, {
      binaries: [path.join(repoRoot, 'natives', 'aarch64-macos', 'tjs')],
      dbPath: path.join(repoRoot, 'test_db', 'large-1gb.sqlite'),
      iterations: 7,
      help: false
    });
  });

  it('combines repeated and comma-separated candidate binaries without reordering them', () => {
    const options = parseCliArgs([
      '--binary', './candidate-a',
      '--binary=./candidate-b,./candidate-c',
      '--db', './fixture.sqlite',
      '--iterations=11',
      '--json', './result.json'
    ], repoRoot, 'linux', 'x64');

    assert.deepStrictEqual(options.binaries, [
      path.resolve('./candidate-a'),
      path.resolve('./candidate-b'),
      path.resolve('./candidate-c')
    ]);
    assert.strictEqual(options.dbPath, path.resolve('./fixture.sqlite'));
    assert.strictEqual(options.iterations, 11);
    assert.strictEqual(options.jsonPath, path.resolve('./result.json'));
  });

  it('rejects invalid or incomplete arguments instead of silently changing the run', () => {
    assert.throws(
      () => parseCliArgs(['--iterations', '0'], repoRoot, 'darwin', 'arm64'),
      /positive integer/
    );
    assert.throws(
      () => parseCliArgs(['--binary'], repoRoot, 'darwin', 'arm64'),
      /requires a value/
    );
    assert.throws(
      () => parseCliArgs(['--unknown'], repoRoot, 'darwin', 'arm64'),
      /Unknown option/
    );
  });

  it('fails explicitly on unsupported default platforms', () => {
    assert.throws(
      () => parseCliArgs([], repoRoot, 'freebsd', 'x64'),
      /No bundled native binary/
    );
  });

  it('runs --help offline without starting a native worker', () => {
    const script = path.resolve(process.cwd(), 'scripts', 'bench-native.ts');
    const result = spawnSync(process.execPath, ['--import', 'tsx', script, '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: 'tsconfig.test.json'
      }
    });

    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /--binary <path>/);
    assert.match(result.stdout, /does not flush OS filesystem caches/);
    assert.match(result.stdout, /linked worktrees do not inherit untracked fixtures/);
    assert.match(result.stdout, /fixed candidate order/);
    assert.match(result.stdout, /nearest-rank p95/);
    assert.doesNotMatch(result.stderr, /\[native-worker\]/i);
  });
});

describe('native benchmark statistics', () => {
  it('reports median, nearest-rank p95, and median per-sample throughput', () => {
    const summary = summarizeMeasurements([
      { durationMs: 30, rows: 90, bytes: 3 * 1024 * 1024 },
      { durationMs: 10, rows: 100, bytes: 1 * 1024 * 1024 },
      { durationMs: 20, rows: 100, bytes: 2 * 1024 * 1024 }
    ]);

    assert.strictEqual(summary.medianMs, 20);
    assert.strictEqual(summary.p95Ms, 30);
    assert.strictEqual(summary.rowsPerSecond, 5000);
    assert.strictEqual(summary.mibPerSecond, 100);
    assert.deepStrictEqual(summary.samplesMs, [30, 10, 20]);
  });

  it('uses positive deltas for regressions and negative deltas for improvements', () => {
    assert.strictEqual(relativeDeltaPercent(120, 100), 20);
    assert.strictEqual(relativeDeltaPercent(80, 100), -20);
    assert.strictEqual(relativeDeltaPercent(0, 0), 0);
  });
});

describe('native benchmark comparison output', () => {
  it('prints side-by-side candidate columns with p95, throughput, and relative delta', () => {
    const candidates: CandidateBenchmarkResult[] = [
      {
        label: 'baseline',
        binaryPath: '/bin/baseline',
        sqliteVersion: '3.50.1',
        workloads: {
          coldStart: {
            medianMs: 10,
            p95Ms: 12,
            samplesMs: [10, 12]
          },
          wideResult: {
            medianMs: 20,
            p95Ms: 25,
            rowsPerSecond: 5000,
            samplesMs: [20, 25]
          }
        }
      },
      {
        label: 'candidate',
        binaryPath: '/bin/candidate',
        sqliteVersion: '3.50.1',
        workloads: {
          coldStart: {
            medianMs: 8,
            p95Ms: 9,
            samplesMs: [8, 9]
          },
          wideResult: {
            medianMs: 24,
            p95Ms: 30,
            rowsPerSecond: 4000,
            samplesMs: [24, 30]
          }
        }
      }
    ];

    const table = formatComparisonTable(candidates, ['coldStart', 'wideResult']);

    assert.match(table, /cold start/);
    assert.match(table, /10\.00 \/ 12\.00 ms/);
    assert.match(table, /8\.00 \/ 9\.00 ms \| -20\.0%/);
    assert.match(table, /5\.00k rows\/s/);
    assert.match(table, /24\.00 \/ 30\.00 ms \| 4\.00k rows\/s \| \+20\.0%/);
  });
});

describe('native benchmark workload invariants', () => {
  it('discovers and times only runtime TEXT/BLOB payload values', () => {
    const maximumExpression = buildPayloadMaximumExpression('mixed_payload', 'payload_max');
    const timedQuery = buildPayloadQuerySql('payloads', 'mixed_payload', ['rowid']);

    assert.match(maximumExpression, /typeof\("mixed_payload"\) IN \('text', 'blob'\)/);
    assert.match(timedQuery, /WHERE typeof\("mixed_payload"\) IN \('text', 'blob'\)/);
    assert.match(timedQuery, /ORDER BY length\(CAST\("mixed_payload" AS BLOB\)\) DESC, "rowid" ASC/);
  });

  it('rejects a candidate that cannot interrupt the cancellation capability probe', async () => {
    const synchronousFallback = {
      async call<T>(): Promise<T> {
        return { values: [[1]] } as T;
      }
    };

    await assert.rejects(
      assertAsyncCancellationAvailable(synchronousFallback),
      /AsyncDatabase signal path required/
    );
  });

  it('accepts a candidate whose bounded query observes the abort signal', async () => {
    const interruptibleWorker = {
      call<T>(
        _method: string,
        _args: unknown[],
        _timeoutMs: number,
        signal?: AbortSignal
      ): Promise<T> {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        });
      }
    };

    await assert.doesNotReject(assertAsyncCancellationAvailable(interruptibleWorker));
  });

  it('keeps cancellation metadata and bounded recursive cleanup explicit', () => {
    assert.strictEqual(CANCELLATION_MODE, 'async-signal-required');
    assert.deepStrictEqual(TEMP_CLEANUP_OPTIONS, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50
    });
  });
});
