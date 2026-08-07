import * as path from 'node:path';

export const DEFAULT_ITERATIONS = 7;

export const WORKLOAD_IDS = [
  'coldStart',
  'schemaRefresh',
  'firstPage',
  'deepPage',
  'deepPageKeyset',
  'wideResult',
  'aggregate',
  'payloadHeavy',
  'editRoundTrip',
  'cancellationOverhead'
] as const;

export type WorkloadId = typeof WORKLOAD_IDS[number];

export const WORKLOAD_LABELS: Record<WorkloadId, string> = {
  coldStart: 'cold start',
  schemaRefresh: 'schema refresh',
  firstPage: 'first page (500)',
  deepPage: 'deep page OFFSET (500)',
  deepPageKeyset: 'deep page keyset (500)',
  wideResult: 'wide result (~100k)',
  aggregate: 'aggregate COUNT(*)',
  payloadHeavy: 'blob/text heavy',
  editRoundTrip: 'edit round-trip',
  cancellationOverhead: 'cancellation overhead'
};

export interface CliOptions {
  binaries: string[];
  dbPath: string;
  iterations: number;
  jsonPath?: string;
  help: boolean;
}

export interface WorkloadMeasurement {
  durationMs: number;
  rows?: number;
  bytes?: number;
}

export interface WorkloadSummary {
  medianMs: number;
  p95Ms: number;
  rowsPerSecond?: number;
  mibPerSecond?: number;
  samplesMs: number[];
}

export interface CandidateBenchmarkResult {
  label: string;
  binaryPath: string;
  sqliteVersion: string;
  workloads: Partial<Record<WorkloadId, WorkloadSummary>>;
}

function platformDirectory(platform: NodeJS.Platform, arch: string): string | undefined {
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'aarch64-macos' : arch === 'x64' ? 'x86_64-macos' : undefined;
  }
  if (platform === 'linux') {
    return arch === 'arm64' ? 'aarch64-linux-gnu' : arch === 'x64' ? 'x86_64-linux-gnu' : undefined;
  }
  if (platform === 'win32' && arch === 'x64') return 'x86_64-windows';
  return undefined;
}

export function resolveBundledBinaryPath(
  repoRoot: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  const directory = platformDirectory(platform, arch);
  if (!directory) {
    throw new Error(`No bundled native binary for ${platform}-${arch}`);
  }
  return path.join(repoRoot, 'natives', directory, platform === 'win32' ? 'tjs.exe' : 'tjs');
}

function requireOptionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value: string, option: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${option} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function appendBinaryValues(target: string[], value: string): void {
  const candidates = value.split(',').map(candidate => candidate.trim());
  if (candidates.some(candidate => candidate.length === 0)) {
    throw new Error('--binary requires a non-empty path');
  }
  target.push(...candidates.map(candidate => path.resolve(candidate)));
}

export function parseCliArgs(
  argv: string[],
  repoRoot: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): CliOptions {
  const binaries: string[] = [];
  let dbPath = path.join(repoRoot, 'test_db', 'large-1gb.sqlite');
  let iterations = DEFAULT_ITERATIONS;
  let jsonPath: string | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      help = true;
    } else if (argument === '--binary') {
      appendBinaryValues(binaries, requireOptionValue(argv, index, '--binary'));
      index++;
    } else if (argument.startsWith('--binary=')) {
      appendBinaryValues(binaries, argument.slice('--binary='.length));
    } else if (argument === '--db') {
      dbPath = path.resolve(requireOptionValue(argv, index, '--db'));
      index++;
    } else if (argument.startsWith('--db=')) {
      const value = argument.slice('--db='.length);
      if (!value) throw new Error('--db requires a value');
      dbPath = path.resolve(value);
    } else if (argument === '--iterations') {
      iterations = parsePositiveInteger(
        requireOptionValue(argv, index, '--iterations'),
        '--iterations'
      );
      index++;
    } else if (argument.startsWith('--iterations=')) {
      iterations = parsePositiveInteger(
        argument.slice('--iterations='.length),
        '--iterations'
      );
    } else if (argument === '--json') {
      jsonPath = path.resolve(requireOptionValue(argv, index, '--json'));
      index++;
    } else if (argument.startsWith('--json=')) {
      const value = argument.slice('--json='.length);
      if (!value) throw new Error('--json requires a value');
      jsonPath = path.resolve(value);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  const options: CliOptions = {
    binaries: binaries.length > 0
      ? binaries
      : [resolveBundledBinaryPath(repoRoot, platform, arch)],
    dbPath,
    iterations,
    help
  };
  if (jsonPath) options.jsonPath = jsonPath;
  return options;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function nearestRankP95(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

export function summarizeMeasurements(measurements: WorkloadMeasurement[]): WorkloadSummary {
  if (measurements.length === 0) throw new Error('Cannot summarize an empty measurement set');
  for (const measurement of measurements) {
    if (!Number.isFinite(measurement.durationMs) || measurement.durationMs <= 0) {
      throw new Error('Benchmark durations must be positive finite numbers');
    }
  }

  const durations = measurements.map(measurement => measurement.durationMs);
  const summary: WorkloadSummary = {
    medianMs: median(durations),
    p95Ms: nearestRankP95(durations),
    samplesMs: durations
  };

  const rowRates = measurements
    .filter((measurement): measurement is WorkloadMeasurement & { rows: number } => (
      measurement.rows !== undefined
    ))
    .map(measurement => measurement.rows * 1000 / measurement.durationMs);
  if (rowRates.length === measurements.length) summary.rowsPerSecond = median(rowRates);

  const mibRates = measurements
    .filter((measurement): measurement is WorkloadMeasurement & { bytes: number } => (
      measurement.bytes !== undefined
    ))
    .map(measurement => measurement.bytes / (1024 * 1024) * 1000 / measurement.durationMs);
  if (mibRates.length === measurements.length) summary.mibPerSecond = median(mibRates);

  return summary;
}

export function relativeDeltaPercent(candidate: number, baseline: number): number {
  if (baseline === 0) return candidate === 0 ? 0 : Number.POSITIVE_INFINITY;
  return (candidate - baseline) / baseline * 100;
}

function formatRate(summary: WorkloadSummary): string | undefined {
  if (summary.mibPerSecond !== undefined) {
    return `${summary.mibPerSecond.toFixed(2)} MiB/s`;
  }
  if (summary.rowsPerSecond !== undefined) {
    if (Math.abs(summary.rowsPerSecond) >= 1000) {
      return `${(summary.rowsPerSecond / 1000).toFixed(2)}k rows/s`;
    }
    return `${summary.rowsPerSecond.toFixed(2)} rows/s`;
  }
  return undefined;
}

function formatDelta(delta: number): string {
  if (!Number.isFinite(delta)) return '+inf%';
  return `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`;
}

export function formatComparisonTable(
  candidates: CandidateBenchmarkResult[],
  workloads: readonly WorkloadId[] = WORKLOAD_IDS
): string {
  if (candidates.length === 0) throw new Error('At least one benchmark candidate is required');

  const headers = ['workload', ...candidates.map(candidate => candidate.label)];
  const rows = workloads.map(workload => {
    const baseline = candidates[0].workloads[workload];
    return [
      WORKLOAD_LABELS[workload],
      ...candidates.map((candidate, candidateIndex) => {
        const summary = candidate.workloads[workload];
        if (!summary) return '-';
        const parts = [
          `${summary.medianMs.toFixed(2)} / ${summary.p95Ms.toFixed(2)} ms`
        ];
        const rate = formatRate(summary);
        if (rate) parts.push(rate);
        if (candidateIndex > 0 && baseline) {
          parts.push(formatDelta(relativeDeltaPercent(summary.medianMs, baseline.medianMs)));
        }
        return parts.join(' | ');
      })
    ];
  });

  const widths = headers.map((header, column) => Math.max(
    header.length,
    ...rows.map(row => row[column].length)
  ));
  const renderRow = (row: string[]) => row
    .map((cell, column) => cell.padEnd(widths[column]))
    .join(' | ')
    .trimEnd();
  const separator = widths.map(width => '-'.repeat(width)).join('-|-');

  return [renderRow(headers), separator, ...rows.map(renderRow)].join('\n');
}

export function buildHelpText(repoRoot: string): string {
  const defaultDb = path.join(repoRoot, 'test_db', 'large-1gb.sqlite');
  return `Usage:
  npx tsx --tsconfig tsconfig.test.json scripts/bench-native.ts [options]

Options:
  --binary <path>      Candidate tjs binary. Repeat the option or use commas.
                       Default: bundled binary for this platform.
  --db <path>          Read-only large benchmark database.
                       Default: ${defaultDb}
  --iterations <N>     Measured iterations after one excluded warmup (default: ${DEFAULT_ITERATIONS}).
  --json <out>         Also write the complete samples and metadata as JSON.
  -h, --help           Show this help.

Environmental caveats:
  "cold start" means a fresh worker process; the harness does not flush OS filesystem caches.
  Close other heavy workloads, keep power/thermal settings stable, and compare binaries in one run.
  Storage cache, filesystem, CPU governor, thermals, and background activity affect results.
  Candidates run in fixed candidate order; confirm close deltas with a reversed-order comparison run.
  nearest-rank p95 is used; with the default 7 samples it is the observed sample maximum.
  The default DB must already exist; linked worktrees do not inherit untracked fixtures. Use --db explicitly.
  Cancellation overhead requires the AsyncDatabase signal path; incompatible candidates fail the run.
  The large database is always opened read-only. Edits use an isolated temporary copy of test_db/test.db.
  Temporary staging and database copies live under this checkout's ignored .tmp directory and are removed.`;
}
