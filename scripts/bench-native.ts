import '../tests/unit/vscode_mock_setup'; // Must precede imports that load vscode.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import * as vscode from 'vscode';

import {
  buildHelpText,
  formatComparisonTable,
  parseCliArgs,
  resolveBundledBinaryPath,
  summarizeMeasurements,
  WORKLOAD_IDS,
  type CandidateBenchmarkResult,
  type WorkloadId,
  type WorkloadMeasurement,
  type WorkloadSummary
} from './bench-native-lib';
import { NativeWorkerProcess, createNativeDatabaseConnection } from '../src/nativeWorker';
import { escapeIdentifier } from '../src/core/sql-utils';
import type { DatabaseConnectionBundle } from '../src/connectionTypes';
import type {
  CellValue,
  ColumnMetadata,
  DatabaseOperations,
  RecordId,
  SchemaSnapshot,
  TableMetadata
} from '../src/core/types';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const WORKER_SCRIPT = path.join(REPO_ROOT, 'natives', 'native-worker.js');
const EDIT_FIXTURE = path.join(REPO_ROOT, 'test_db', 'test.db');
const PAGE_SIZE = 500;
const WIDE_RESULT_LIMIT = 100_000;
const PAYLOAD_RESULT_LIMIT = 500;
const BOUNDED_QUERY_TIMEOUT_MS = 30_000;

export const CANCELLATION_MODE = 'async-signal-required' as const;
export const TEMP_CLEANUP_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 50
} as const;

interface StagedCandidate {
  label: string;
  sourceBinaryPath: string;
  extensionRoot: string;
  stagedBinaryPath: string;
  stagedWorkerScript: string;
  editDatabasePath: string;
}

interface PayloadPlan {
  table: string;
  column: string;
  sql: string;
  maximumCellBytes: number;
}

interface EditPlan {
  table: string;
  column: string;
  rowId: RecordId;
}

interface WorkloadPlan {
  largestTable: string;
  largestTableRows: number;
  tableColumns: string[];
  pageColumns: string[];
  deepOffset: number;
  wideSql: string;
  payload: PayloadPlan;
  edit: EditPlan;
}

interface BenchmarkOutput {
  formatVersion: 1;
  createdAt: string;
  environment: {
    platform: NodeJS.Platform;
    arch: string;
    node: string;
    cpuModel: string;
    logicalCpus: number;
    totalMemoryBytes: number;
  };
  configuration: {
    databasePath: string;
    databaseSizeBytes: number;
    editFixturePath: string;
    iterations: number;
    warmupIterations: 1;
    cancellationMode: typeof CANCELLATION_MODE;
    candidateBinaries: string[];
  };
  workloadPlan: WorkloadPlan;
  candidates: CandidateBenchmarkResult[];
}

function diagnosticMessage(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

async function assertRegularFile(filePath: string, description: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    throw new Error(`${description} not found: ${filePath}`, { cause: error });
  }
  if (!stat.isFile()) throw new Error(`${description} is not a regular file: ${filePath}`);
}

function candidateLabels(binaryPaths: string[]): string[] {
  const counts = new Map<string, number>();
  return binaryPaths.map(binaryPath => {
    const base = `${path.basename(path.dirname(binaryPath))}/${path.basename(binaryPath)}`;
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    return count === 1 ? base : `${base}#${count}`;
  });
}

async function stageCandidates(binaryPaths: string[], runRoot: string): Promise<StagedCandidate[]> {
  await assertRegularFile(WORKER_SCRIPT, 'Native worker script');
  const labels = candidateLabels(binaryPaths);
  const candidates: StagedCandidate[] = [];

  for (let index = 0; index < binaryPaths.length; index++) {
    const sourceBinaryPath = binaryPaths[index];
    await assertRegularFile(sourceBinaryPath, 'Candidate binary');

    const extensionRoot = path.join(runRoot, `candidate-${index + 1}`);
    const stagedBinaryPath = resolveBundledBinaryPath(extensionRoot);
    const stagedWorkerScript = path.join(extensionRoot, 'natives', 'native-worker.js');
    const editDatabasePath = path.join(extensionRoot, 'edit-fixture.sqlite');
    await fs.mkdir(path.dirname(stagedBinaryPath), { recursive: true });
    await fs.copyFile(sourceBinaryPath, stagedBinaryPath);
    if (process.platform !== 'win32') await fs.chmod(stagedBinaryPath, 0o755);
    await fs.copyFile(WORKER_SCRIPT, stagedWorkerScript);

    candidates.push({
      label: labels[index],
      sourceBinaryPath,
      extensionRoot,
      stagedBinaryPath,
      stagedWorkerScript,
      editDatabasePath
    });
  }
  return candidates;
}

function disposeBundle(bundle: DatabaseConnectionBundle | undefined): void {
  bundle?.workerMethods[Symbol.dispose]();
}

async function openFacade(
  candidate: StagedCandidate,
  databasePath: string,
  readOnly: boolean
): Promise<{ bundle: DatabaseConnectionBundle; operations: DatabaseOperations }> {
  const bundle = await createNativeDatabaseConnection(vscode.Uri.file(candidate.extensionRoot));
  try {
    const connection = await bundle.establishConnection(
      vscode.Uri.file(databasePath),
      path.basename(databasePath),
      readOnly
    );
    return { bundle, operations: connection.databaseOps };
  } catch (error) {
    disposeBundle(bundle);
    throw error;
  }
}

function tableOrderColumns(table: TableMetadata): string[] {
  const identity = table.identity;
  if (!identity) throw new Error(`Table identity missing from schema: ${table.identifier}`);
  return identity.kind === 'rowid'
    ? ['rowid']
    : identity.columns.map(column => column.identifier);
}

function orderBySql(columns: string[]): string {
  return columns.map(column => `${escapeIdentifier(column)} ASC`).join(', ');
}

export function buildPayloadMaximumExpression(columnIdentifier: string, alias: string): string {
  const column = escapeIdentifier(columnIdentifier);
  return (
    `MAX(CASE WHEN typeof(${column}) IN ('text', 'blob') ` +
    `THEN length(CAST(${column} AS BLOB)) END) AS ${escapeIdentifier(alias)}`
  );
}

export function buildPayloadQuerySql(
  tableIdentifier: string,
  columnIdentifier: string,
  identityColumns: string[]
): string {
  const column = escapeIdentifier(columnIdentifier);
  return (
    `SELECT ${column}, length(CAST(${column} AS BLOB)) AS "payload_bytes" ` +
    `FROM ${escapeIdentifier(tableIdentifier)} ` +
    `WHERE typeof(${column}) IN ('text', 'blob') ` +
    `ORDER BY length(CAST(${column} AS BLOB)) DESC, ${orderBySql(identityColumns)} ` +
    `LIMIT ${PAYLOAD_RESULT_LIMIT}`
  );
}

function resultRows(result: Awaited<ReturnType<DatabaseOperations['executeQuery']>>): CellValue[][] {
  const first = result[0];
  if (!first || !Array.isArray(first.rows)) {
    throw new Error('Native query returned no result set');
  }
  return first.rows;
}

async function discoverLargestTable(
  operations: DatabaseOperations,
  schema: SchemaSnapshot
): Promise<{ table: TableMetadata; columns: ColumnMetadata[]; rows: number }> {
  if (schema.tables.length === 0) throw new Error('Benchmark database has no tables');
  const sizes: Array<{ table: TableMetadata; columns: ColumnMetadata[]; rows: number }> = [];
  for (const table of [...schema.tables].sort((left, right) => left.identifier.localeCompare(right.identifier))) {
    const [rows, columns] = await Promise.all([
      operations.fetchTableCount(table.identifier, {}),
      operations.getTableInfo(table.identifier)
    ]);
    sizes.push({ table, columns, rows });
  }
  sizes.sort((left, right) => right.rows - left.rows || left.table.identifier.localeCompare(right.table.identifier));
  if (sizes[0].rows < 1) throw new Error('Benchmark database has no table rows');
  return sizes[0];
}

async function discoverPayloadPlan(
  operations: DatabaseOperations,
  schema: SchemaSnapshot
): Promise<PayloadPlan> {
  let selected: { table: TableMetadata; column: string; bytes: number } | undefined;
  for (const table of [...schema.tables].sort((left, right) => left.identifier.localeCompare(right.identifier))) {
    const columns = await operations.getTableInfo(table.identifier);
    if (columns.length === 0) continue;
    const aliases = columns.map((_, index) => `payload_${index}`);
    const expressions = columns.map((column, index) => (
      buildPayloadMaximumExpression(column.identifier, aliases[index])
    ));
    const rows = resultRows(await operations.executeQuery(
      `SELECT ${expressions.join(', ')} FROM ${escapeIdentifier(table.identifier)}`
    ));
    const maxima = rows[0] ?? [];
    for (let index = 0; index < columns.length; index++) {
      const raw = maxima[index];
      const bytes = typeof raw === 'bigint' ? Number(raw) : typeof raw === 'number' ? raw : 0;
      const challenger = { table, column: columns[index].identifier, bytes };
      if (
        !selected ||
        challenger.bytes > selected.bytes ||
        (
          challenger.bytes === selected.bytes &&
          `${challenger.table.identifier}\0${challenger.column}` <
            `${selected.table.identifier}\0${selected.column}`
        )
      ) {
        selected = challenger;
      }
    }
  }
  if (!selected || selected.bytes < 1) {
    throw new Error('Benchmark database has no non-empty declared BLOB/TEXT cells');
  }

  const sql = buildPayloadQuerySql(
    selected.table.identifier,
    selected.column,
    tableOrderColumns(selected.table)
  );
  return {
    table: selected.table.identifier,
    column: selected.column,
    sql,
    maximumCellBytes: selected.bytes
  };
}

async function discoverEditPlan(operations: DatabaseOperations): Promise<EditPlan> {
  const schema = await operations.fetchSchema();
  for (const table of [...schema.tables].sort((left, right) => left.identifier.localeCompare(right.identifier))) {
    if (table.identity?.kind !== 'rowid') continue;
    const columns = (await operations.getTableInfo(table.identifier))
      .filter(column => (
        column.primaryKeyPosition === 0 && /(?:CHAR|CLOB|TEXT)/i.test(column.declaredType)
      ))
      .sort((left, right) => left.ordinal - right.ordinal);
    for (const column of columns) {
      const rows = resultRows(await operations.executeQuery(
        `SELECT CAST(rowid AS TEXT), ${escapeIdentifier(column.identifier)} ` +
        `FROM ${escapeIdentifier(table.identifier)} ORDER BY rowid ASC LIMIT 1`
      ));
      if (rows.length > 0 && typeof rows[0][0] === 'string') {
        return { table: table.identifier, column: column.identifier, rowId: rows[0][0] };
      }
    }
  }
  throw new Error('Edit fixture has no populated rowid table with an editable TEXT column');
}

/**
 * Prove the candidate is using the interruptible AsyncDatabase path before
 * timing its happy path. Older binaries otherwise fall back to a synchronous
 * query that has no armed SQLite interruption deadline, making comparisons
 * look valid while measuring a different mechanism.
 */
export interface CancellationProbeWorker {
  call<T>(
    method: string,
    args?: unknown[],
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<T>;
}

export async function assertAsyncCancellationAvailable(
  worker: CancellationProbeWorker
): Promise<void> {
  const sql =
    'WITH RECURSIVE native_benchmark_probe(value) AS (' +
    'SELECT 1 UNION ALL SELECT value + 1 FROM native_benchmark_probe' +
    ') SELECT max(value) AS value FROM native_benchmark_probe';
  const boundary = '/*sqlite_explorer_native_benchmark_capability_boundary*/';
  const controller = new AbortController();
  const query = worker.call(
    'queryBounded',
    [
      `${sql}\n${boundary}`,
      sql,
      boundary,
      ['value'],
      undefined,
      1,
      BOUNDED_QUERY_TIMEOUT_MS
    ],
    2000,
    controller.signal
  );
  const abortTimer = setTimeout(() => controller.abort(), 0);
  try {
    await query;
    throw new Error('candidate completed the runaway cancellation capability probe');
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return;
    throw new Error(
      'Candidate does not provide the AsyncDatabase signal path required for the cancellation-overhead workload',
      { cause: error }
    );
  } finally {
    clearTimeout(abortTimer);
  }
}

async function discoverWorkloadPlan(
  candidate: StagedCandidate,
  databasePath: string
): Promise<WorkloadPlan> {
  let largeBundle: DatabaseConnectionBundle | undefined;
  let editBundle: DatabaseConnectionBundle | undefined;
  try {
    const large = await openFacade(candidate, databasePath, true);
    largeBundle = large.bundle;
    const schema = await large.operations.fetchSchema();
    const largest = await discoverLargestTable(large.operations, schema);
    const identityOrder = orderBySql(tableOrderColumns(largest.table));
    const tableColumns = largest.columns.map(column => column.identifier);
    const pageColumns = ['rowid', ...tableColumns];
    const payload = await discoverPayloadPlan(large.operations, schema);

    const edit = await openFacade(candidate, EDIT_FIXTURE, true);
    editBundle = edit.bundle;
    const editPlan = await discoverEditPlan(edit.operations);

    return {
      largestTable: largest.table.identifier,
      largestTableRows: largest.rows,
      tableColumns,
      pageColumns,
      deepOffset: Math.max(0, largest.rows - PAGE_SIZE),
      wideSql:
        `SELECT * FROM ${escapeIdentifier(largest.table.identifier)} ` +
        `ORDER BY ${identityOrder} LIMIT ${WIDE_RESULT_LIMIT}`,
      payload,
      edit: editPlan
    };
  } finally {
    disposeBundle(editBundle);
    disposeBundle(largeBundle);
  }
}

async function measure(
  label: string,
  iterations: number,
  operation: (iteration: number) => Promise<WorkloadMeasurement>
): Promise<WorkloadSummary> {
  process.stderr.write(`[bench-native] ${label}: warmup + ${iterations} measured\n`);
  await operation(-1);
  const measurements: WorkloadMeasurement[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    measurements.push(await operation(iteration));
  }
  return summarizeMeasurements(measurements);
}

function elapsedMeasurement(startedAt: number, extra: Omit<WorkloadMeasurement, 'durationMs'> = {}): WorkloadMeasurement {
  return { durationMs: performance.now() - startedAt, ...extra };
}

async function measureColdStart(
  candidate: StagedCandidate,
  databasePath: string,
  iterations: number
): Promise<WorkloadSummary> {
  return measure('cold start', iterations, async () => {
    const startedAt = performance.now();
    let bundle: DatabaseConnectionBundle | undefined;
    try {
      const connection = await openFacade(candidate, databasePath, true);
      bundle = connection.bundle;
      await connection.operations.fetchSchema();
      return elapsedMeasurement(startedAt);
    } finally {
      disposeBundle(bundle);
    }
  });
}

async function measureCancellationOverhead(
  candidate: StagedCandidate,
  databasePath: string,
  iterations: number
): Promise<WorkloadSummary> {
  const worker = new NativeWorkerProcess(candidate.stagedBinaryPath, candidate.stagedWorkerScript);
  await worker.start();
  try {
    await worker.call('open', [databasePath, true]);
    await assertAsyncCancellationAvailable(worker);
    const sql = 'SELECT 1 AS value';
    const boundary = '/*sqlite_explorer_native_benchmark_boundary*/';
    const args = [
      `${sql}\n${boundary}`,
      sql,
      boundary,
      ['value'],
      undefined,
      1,
      BOUNDED_QUERY_TIMEOUT_MS
    ];
    return await measure('cancellation overhead', iterations, async () => {
      const startedAt = performance.now();
      const result = await worker.call<{ values: CellValue[][] }>(
        'queryBounded',
        args,
        BOUNDED_QUERY_TIMEOUT_MS + 2000
      );
      if (result.values[0]?.[0] !== 1) {
        throw new Error('Bounded-query verification failed');
      }
      return elapsedMeasurement(startedAt, { rows: 1 });
    });
  } finally {
    worker.stop();
  }
}

async function measureEditRoundTrip(
  candidate: StagedCandidate,
  plan: WorkloadPlan,
  iterations: number
): Promise<WorkloadSummary> {
  await fs.copyFile(EDIT_FIXTURE, candidate.editDatabasePath);
  let bundle: DatabaseConnectionBundle | undefined;
  try {
    const connection = await openFacade(candidate, candidate.editDatabasePath, false);
    bundle = connection.bundle;
    const { table, column, rowId } = plan.edit;
    const values = ['sqlite-explorer-native-benchmark-a', 'sqlite-explorer-native-benchmark-b'];
    return await measure('edit round-trip', iterations, async iteration => {
      const value = values[(iteration + 2) % values.length];
      const startedAt = performance.now();
      await connection.operations.updateCell(table, rowId, column, value);
      const rows = resultRows(await connection.operations.executeQuery(
        `SELECT ${escapeIdentifier(column)} FROM ${escapeIdentifier(table)} WHERE rowid = ?`,
        [rowId]
      ));
      if (rows.length !== 1 || rows[0][0] !== value) {
        throw new Error(`Edit verification failed for ${table}.${column} rowid ${String(rowId)}`);
      }
      return elapsedMeasurement(startedAt, { rows: 1 });
    });
  } finally {
    disposeBundle(bundle);
  }
}

async function runCandidate(
  candidate: StagedCandidate,
  databasePath: string,
  plan: WorkloadPlan,
  iterations: number
): Promise<CandidateBenchmarkResult> {
  process.stderr.write(`[bench-native] candidate ${candidate.label}: ${candidate.sourceBinaryPath}\n`);
  const workloads: Partial<Record<WorkloadId, WorkloadSummary>> = {};
  workloads.coldStart = await measureColdStart(candidate, databasePath, iterations);

  let bundle: DatabaseConnectionBundle | undefined;
  try {
    const connection = await openFacade(candidate, databasePath, true);
    bundle = connection.bundle;
    const versionRows = resultRows(await connection.operations.executeQuery(
      'SELECT sqlite_version() AS version'
    ));
    const sqliteVersion = String(versionRows[0]?.[0] ?? 'unknown');

    workloads.schemaRefresh = await measure('schema refresh', iterations, async () => {
      const startedAt = performance.now();
      await connection.operations.fetchSchema();
      return elapsedMeasurement(startedAt);
    });

    const pageOptions = {
      columns: plan.pageColumns,
      orderBy: 'rowid',
      orderDir: 'ASC' as const,
      limit: PAGE_SIZE
    };
    workloads.firstPage = await measure('first page', iterations, async () => {
      const startedAt = performance.now();
      const result = await connection.operations.fetchTableData(plan.largestTable, {
        ...pageOptions,
        offset: 0
      });
      return elapsedMeasurement(startedAt, { rows: result.rows.length });
    });
    workloads.deepPage = await measure('deep page OFFSET', iterations, async () => {
      const startedAt = performance.now();
      const result = await connection.operations.fetchTableData(plan.largestTable, {
        ...pageOptions,
        offset: plan.deepOffset
      });
      return elapsedMeasurement(startedAt, { rows: result.rows.length });
    });

    // The grid's deep navigation shape: seek by engine-issued anchor instead
    // of scanning to OFFSET. Preparation replays a Last -> Prev navigation to
    // hold the second-to-last page's anchor; the measured operation is the
    // Next page turn at depth (the workload that hits the OFFSET cliff above).
    const totalPages = Math.max(1, Math.ceil(plan.largestTableRows / PAGE_SIZE));
    const lastPageRows = plan.largestTableRows - (totalPages - 1) * PAGE_SIZE;
    if (totalPages < 2) {
      process.stderr.write('[bench-native] deep page keyset: skipped (single-page table)\n');
    } else {
      const lastPage = await connection.operations.fetchTableData(plan.largestTable, {
        ...pageOptions,
        offset: (totalPages - 1) * PAGE_SIZE,
        keyset: { mode: 'last', lastPageRowCount: lastPageRows }
      });
      const previousPage = lastPage.keysetAnchors?.first
        ? await connection.operations.fetchTableData(plan.largestTable, {
            ...pageOptions,
            offset: (totalPages - 2) * PAGE_SIZE,
            keyset: { mode: 'before', anchor: lastPage.keysetAnchors.first }
          })
        : undefined;
      const anchor = previousPage?.keysetAnchors?.last;
      if (!anchor) {
        process.stderr.write(
          '[bench-native] deep page keyset: skipped (table did not issue anchors)\n'
        );
      } else {
        workloads.deepPageKeyset = await measure('deep page keyset', iterations, async () => {
          const startedAt = performance.now();
          const result = await connection.operations.fetchTableData(plan.largestTable, {
            ...pageOptions,
            offset: (totalPages - 1) * PAGE_SIZE,
            keyset: { mode: 'after', anchor }
          });
          if (result.rows.length !== lastPageRows) {
            throw new Error(
              `Keyset deep page returned ${result.rows.length} rows; expected ${lastPageRows}`
            );
          }
          return elapsedMeasurement(startedAt, { rows: result.rows.length });
        });
      }
    }

    // A keyset request that silently degrades to the OFFSET fallback returns
    // the exact same rows, so row comparison cannot expose it — only timing
    // can: at depth the seek must be clearly cheaper than the OFFSET scan
    // once the scan itself is non-trivial. Warn only; timing is environment-
    // sensitive and must never fail a benchmark run.
    if (
      workloads.deepPage && workloads.deepPageKeyset
      && workloads.deepPage.medianMs >= 20
      && workloads.deepPageKeyset.medianMs >= 0.5 * workloads.deepPage.medianMs
    ) {
      process.stderr.write(
        '[bench-native] WARNING: deep page keyset median ' +
        `(${workloads.deepPageKeyset.medianMs.toFixed(2)} ms) is not clearly below ` +
        `deep page OFFSET (${workloads.deepPage.medianMs.toFixed(2)} ms); ` +
        'the keyset request may be silently falling back to the OFFSET query\n'
      );
    }

    workloads.wideResult = await measure('wide result', iterations, async () => {
      const startedAt = performance.now();
      const rows = resultRows(await connection.operations.executeQuery(plan.wideSql));
      return elapsedMeasurement(startedAt, { rows: rows.length });
    });

    workloads.aggregate = await measure('aggregate', iterations, async () => {
      const startedAt = performance.now();
      const count = await connection.operations.fetchTableCount(plan.largestTable, {});
      if (count !== plan.largestTableRows) {
        throw new Error(
          `Aggregate verification failed: expected ${plan.largestTableRows}, received ${count}`
        );
      }
      return elapsedMeasurement(startedAt);
    });

    workloads.payloadHeavy = await measure('blob/text heavy', iterations, async () => {
      const startedAt = performance.now();
      const rows = resultRows(await connection.operations.executeQuery(plan.payload.sql));
      let bytes = 0;
      for (const row of rows) {
        const value = row[1];
        if (typeof value === 'bigint') bytes += Number(value);
        else if (typeof value === 'number') bytes += value;
        else throw new Error('Payload query returned an invalid byte count');
      }
      return elapsedMeasurement(startedAt, { rows: rows.length, bytes });
    });

    disposeBundle(bundle);
    bundle = undefined;
    workloads.editRoundTrip = await measureEditRoundTrip(candidate, plan, iterations);
    workloads.cancellationOverhead = await measureCancellationOverhead(
      candidate,
      databasePath,
      iterations
    );

    return {
      label: candidate.label,
      binaryPath: candidate.sourceBinaryPath,
      sqliteVersion,
      workloads
    };
  } finally {
    disposeBundle(bundle);
  }
}

async function withCapturedNativeDiagnostics<T>(operation: () => Promise<T>): Promise<T> {
  const originalWarn = console.warn;
  const diagnostics: string[] = [];
  let diagnosticBytes = 0;
  console.warn = (...args: unknown[]) => {
    if (String(args[0] ?? '').startsWith('[NativeWorker]')) {
      const message = args.map(String).join(' ');
      if (diagnosticBytes < 64 * 1024) {
        diagnostics.push(message);
        diagnosticBytes += Buffer.byteLength(message);
      }
      return;
    }
    originalWarn(...args);
  };
  try {
    return await operation();
  } catch (error) {
    const tail = diagnostics.slice(-8).join('\n');
    throw new Error(
      tail ? `${diagnosticMessage(error)}\nNative worker diagnostics:\n${tail}` : diagnosticMessage(error),
      { cause: error }
    );
  } finally {
    console.warn = originalWarn;
  }
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2), REPO_ROOT);
  if (options.help) {
    process.stdout.write(`${buildHelpText(REPO_ROOT)}\n`);
    return;
  }

  await assertRegularFile(options.dbPath, 'Benchmark database');
  await assertRegularFile(EDIT_FIXTURE, 'Edit fixture');
  const databaseStat = await fs.stat(options.dbPath);
  await fs.mkdir(path.join(REPO_ROOT, '.tmp'), { recursive: true });
  const runRoot = await fs.mkdtemp(path.join(REPO_ROOT, '.tmp', 'native-bench-'));

  try {
    const candidates = await stageCandidates(options.binaries, runRoot);
    const results = await withCapturedNativeDiagnostics(async () => {
      process.stderr.write('[bench-native] discovering one shared workload plan\n');
      const plan = await discoverWorkloadPlan(candidates[0], options.dbPath);
      process.stderr.write(
        `[bench-native] largest table ${plan.largestTable} (${plan.largestTableRows} rows); ` +
        `payload ${plan.payload.table}.${plan.payload.column} ` +
        `(max ${plan.payload.maximumCellBytes} bytes)\n`
      );
      const candidateResults: CandidateBenchmarkResult[] = [];
      for (const candidate of candidates) {
        candidateResults.push(await runCandidate(
          candidate,
          options.dbPath,
          plan,
          options.iterations
        ));
      }
      return { plan, candidateResults };
    });

    const output: BenchmarkOutput = {
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        cpuModel: os.cpus()[0]?.model ?? 'unknown',
        logicalCpus: os.cpus().length,
        totalMemoryBytes: os.totalmem()
      },
      configuration: {
        databasePath: options.dbPath,
        databaseSizeBytes: databaseStat.size,
        editFixturePath: EDIT_FIXTURE,
        iterations: options.iterations,
        warmupIterations: 1,
        cancellationMode: CANCELLATION_MODE,
        candidateBinaries: options.binaries
      },
      workloadPlan: results.plan,
      candidates: results.candidateResults
    };

    process.stdout.write('Native backend benchmark\n');
    for (const candidate of output.candidates) {
      process.stdout.write(
        `${candidate.label}: ${candidate.binaryPath} (SQLite ${candidate.sqliteVersion})\n`
      );
    }
    process.stdout.write(`\nmedian / p95; delta is median vs first candidate\n`);
    process.stdout.write(`${formatComparisonTable(output.candidates, WORKLOAD_IDS)}\n`);

    if (options.jsonPath) {
      await fs.mkdir(path.dirname(options.jsonPath), { recursive: true });
      await fs.writeFile(options.jsonPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
      process.stderr.write(`[bench-native] wrote JSON ${options.jsonPath}\n`);
    }
  } finally {
    // Child-process exit notification can lag kill(), especially on Windows.
    // Node retries only when recursive removal is enabled and maxRetries is set.
    await fs.rm(runRoot, TEMP_CLEANUP_OPTIONS);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch(error => {
    process.stderr.write(`[bench-native] FAILED: ${diagnosticMessage(error)}\n`);
    process.exitCode = 1;
  });
}
