import { after, before, describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUN_LARGE_CELL_TESTS = process.env.SQLITE_EXPLORER_RUN_LARGE_CELL_TESTS === '1';
const SIZE_MIB = Number(process.env.SQLITE_EXPLORER_LARGE_CELL_MIB ?? '256');
const MIB = 1024 * 1024;
const EXPECTED_CELL_BYTES = SIZE_MIB * MIB;
const MAX_INLINE_CELL_BYTES = MIB;
const MAX_SINGLE_OUTPUT_CHUNK = MIB;
const READ_WINDOW_BYTES = 64 * 1024;
const TEST_ROOT = path.join(REPO_ROOT, '.tmp', `large-cell-tests-${process.pid}`);
const FIXTURE_PATH = path.join(TEST_ROOT, `large-cells-${SIZE_MIB}mib.sqlite`);
const GENERATOR_PATH = path.join(REPO_ROOT, 'scripts', 'generate-large-cell-fixture.mjs');
const PROBE_PATH = path.join(REPO_ROOT, 'tests', 'performance', 'helpers', 'large-cell-probe.ts');
const SQLITE3_PATH = process.env.SQLITE3_PATH || 'sqlite3';

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  elapsedMs: number;
}

interface ProbeResult extends Record<string, unknown> {
  mode: string;
  process?: ProcessResult;
}

function validateSize(): void {
  if (!Number.isSafeInteger(SIZE_MIB) || SIZE_MIB < 1 || SIZE_MIB > 900) {
    throw new Error('SQLITE_EXPLORER_LARGE_CELL_MIB must be an integer from 1 through 900');
  }
}

async function runProcess(
  command: string,
  args: string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv }
): Promise<ProcessResult> {
  const startedAt = performance.now();
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, options.timeoutMs);

  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
    }
  );
  clearTimeout(timeout);

  return {
    code,
    signal,
    stdout,
    stderr,
    timedOut,
    elapsedMs: performance.now() - startedAt
  };
}

function processFailureSummary(result: ProcessResult): string {
  const stderrTail = result.stderr.trim().split('\n').slice(-12).join('\n');
  return [
    `exit=${String(result.code)} signal=${String(result.signal)} timeout=${result.timedOut}`,
    stderrTail
  ].filter(Boolean).join('\n');
}

async function runRequiredProcess(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<ProcessResult> {
  const result = await runProcess(command, args, { timeoutMs });
  if (result.code !== 0 || result.signal !== null || result.timedOut) {
    throw new Error(processFailureSummary(result));
  }
  return result;
}

async function runProbe(
  mode: string,
  options: { kind?: 'blob' | 'text'; heapMib?: number; timeoutMs?: number } = {}
): Promise<ProbeResult> {
  const args = [
    `--max-old-space-size=${options.heapMib ?? 2048}`,
    '--import',
    'tsx',
    PROBE_PATH,
    '--mode',
    mode,
    '--fixture',
    FIXTURE_PATH,
    '--size-bytes',
    String(EXPECTED_CELL_BYTES),
    '--scratch-root',
    TEST_ROOT
  ];
  if (options.kind) args.push('--kind', options.kind);

  const processResult = await runProcess(process.execPath, args, {
    timeoutMs: options.timeoutMs ?? 180_000
  });
  const marker = processResult.stdout
    .split('\n')
    .find(line => line.startsWith('LARGE_CELL_PROBE '));
  if (!marker) {
    return {
      mode,
      failureStage: processResult.timedOut ? 'timeout' : 'process-exit',
      process: {
        ...processResult,
        stdout: processResult.stdout.slice(-2_000),
        stderr: processResult.stderr.slice(-8_000)
      }
    };
  }

  const parsed = JSON.parse(marker.slice('LARGE_CELL_PROBE '.length)) as ProbeResult;
  parsed.process = {
    ...processResult,
    stdout: '',
    stderr: processResult.code === 0 && !processResult.timedOut
      ? ''
      : processResult.stderr.slice(-8_000)
  };
  return parsed;
}

function diagnose(t: TestContext, result: ProbeResult): void {
  t.diagnostic(JSON.stringify(result));
}

function knownFailure(
  name: string,
  reason: string,
  body: (t: TestContext) => Promise<void>
): void {
  const options = RUN_LARGE_CELL_TESTS
    ? { todo: reason, timeout: 300_000 }
    : { skip: `set SQLITE_EXPLORER_RUN_LARGE_CELL_TESTS=1 to run the ${SIZE_MIB} MiB probes` };
  test(name, options, body);
}

before(async () => {
  if (!RUN_LARGE_CELL_TESTS) return;
  validateSize();
  await fs.mkdir(TEST_ROOT, { recursive: true });
  await runRequiredProcess(process.execPath, [
    GENERATOR_PATH,
    '--output',
    FIXTURE_PATH,
    '--size-mib',
    String(SIZE_MIB)
  ], 300_000);
});

after(async () => {
  if (!RUN_LARGE_CELL_TESTS) return;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe('very large single-cell behavior (opt-in)', () => {
  test('fixture contains one exact-size BLOB and one exact-size TEXT cell', {
    skip: !RUN_LARGE_CELL_TESTS && 'set SQLITE_EXPLORER_RUN_LARGE_CELL_TESTS=1'
  }, async () => {
    const result = await runRequiredProcess(SQLITE3_PATH, [
      FIXTURE_PATH,
      "SELECT kind || '|' || typeof(payload) || '|' || length(CAST(payload AS BLOB)) FROM large_cells ORDER BY kind"
    ], 60_000);
    assert.deepStrictEqual(result.stdout.trim().split('\n'), [
      `blob|blob|${EXPECTED_CELL_BYTES}`,
      `text|text|${EXPECTED_CELL_BYTES}`
    ]);
  });

  test('existing engines can return bounded substr windows with size/type metadata', {
    skip: !RUN_LARGE_CELL_TESTS && 'set SQLITE_EXPLORER_RUN_LARGE_CELL_TESTS=1'
  }, async t => {
    const result = await runProbe('windowed-read');
    diagnose(t, result);
    assert.equal(result.failureStage, undefined);
    assert.deepStrictEqual(result.sourceBytes, [EXPECTED_CELL_BYTES, EXPECTED_CELL_BYTES]);
    assert.deepStrictEqual(result.windowBytes, [READ_WINDOW_BYTES, READ_WINDOW_BYTES]);
  });

  for (const kind of ['blob', 'text'] as const) {
    knownFailure(
      `grid fetch keeps an oversized ${kind.toUpperCase()} out of the native IPC result`,
      'fetchTableData currently transports the complete cell',
      async t => {
        const result = await runProbe('grid-fetch', { kind });
        diagnose(t, result);
        assert.equal(result.failureStage, undefined);
        assert.equal(result.oversized, true);
        assert.ok(Number(result.transportedCellBytes) <= MAX_INLINE_CELL_BYTES);
      }
    );
  }

  knownFailure(
    'extension-host response refuses an oversized BLOB before base64 webview serialization',
    'fetchTableData currently base64-encodes the complete BLOB response',
    async t => {
      const result = await runProbe('host-webview-response', { kind: 'blob', heapMib: 2560 });
      diagnose(t, result);
      assert.equal(result.failureStage, 'size-guard');
      assert.equal(result.rawCellBytes, EXPECTED_CELL_BYTES);
    }
  );

  knownFailure(
    'webview request refuses an oversized replacement BLOB before base64 encoding',
    'blob replacement currently builds one full base64 request in the webview',
    async t => {
      const result = await runProbe('webview-update-request', { kind: 'blob', heapMib: 2048 });
      diagnose(t, result);
      assert.equal(result.failureStage, 'size-guard');
      assert.equal(result.rawCellBytes, EXPECTED_CELL_BYTES);
    }
  );

  knownFailure(
    'blob inspector decodes only a bounded preview of a text-like oversized BLOB',
    'blob inspector currently decodes the complete value into DOM text',
    async t => {
      const result = await runProbe('blob-inspector', { kind: 'blob' });
      diagnose(t, result);
      assert.equal(result.failureStage, undefined);
      assert.ok(Number(result.largestDomTextChars) <= MAX_INLINE_CELL_BYTES);
    }
  );

  knownFailure(
    'VFS editor open avoids returning an oversized cell from readFile',
    'FileSystemProvider.readFile currently returns one whole Uint8Array',
    async t => {
      const result = await runProbe('vfs-read', { kind: 'text' });
      diagnose(t, result);
      assert.equal(result.failureStage, undefined);
      assert.ok(Number(result.returnedBytes) <= MAX_INLINE_CELL_BYTES);
    }
  );

  knownFailure(
    'oversized prior values are not retained in the in-memory undo entry',
    'maxUndoMemory deliberately keeps one entry even when that entry exceeds the limit',
    async t => {
      const result = await runProbe('cell-save-undo', { kind: 'blob' });
      diagnose(t, result);
      assert.equal(result.failureStage, undefined);
      assert.equal(result.undoable, false);
      assert.equal(result.retainedPriorBytes, 0);
    }
  );

  knownFailure(
    'streaming JSON export never writes a cell-sized formatted chunk',
    'table export batches rows but still materializes and formats each complete cell',
    async t => {
      const result = await runProbe('export-json', { kind: 'blob', heapMib: 2048 });
      diagnose(t, result);
      assert.equal(result.failureStage, undefined);
      assert.ok(Number(result.largestWriteChars) <= MAX_SINGLE_OUTPUT_CHUNK);
    }
  );

  knownFailure(
    'web demo rejects a raw oversized worker BLOB before forwarding it to the iframe',
    'the demo currently structured-clones raw cells and its iframe deserializer enumerates typed-array keys',
    async t => {
      const result = await runProbe('web-demo-response', { kind: 'blob', heapMib: 1024 });
      diagnose(t, result);
      assert.equal(result.failureStage, 'size-guard');
      assert.equal(result.rawCellBytes, EXPECTED_CELL_BYTES);
    }
  );
});
