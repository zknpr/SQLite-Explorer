import '../unit/vscode_mock_setup'; // Must be first for the native production facade.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as vscode from 'vscode';

import { prepareBatchUpdates } from '../../core/ui/modules/batch-update-logic.js';
import { assertCellValuesWithinEditLimit } from '../../src/core/cell-edit-policy';
import {
  WEBVIEW_TRANSPORT_SURFACES,
  assertWebviewTransportPayload
} from '../../src/core/webview-transport';
import { deserializeArgs, serializeValue } from '../../src/core/serialization';
import { ModificationTracker } from '../../src/core/undo-history';
import { createDatabaseEngine } from '../../src/core/sqlite-db';
import type {
  CellUpdate,
  CellUpdateResult,
  DatabaseOperations,
  LabeledModification
} from '../../src/core/types';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';
import { resolveBundledBinaryPath } from '../../scripts/bench-native-lib';

const ROW_COUNT = 10_000;
const EDIT_LIMIT_BYTES = 1024 * 1024;
const TABLE = 'batch_ops';
const ALL_COLUMNS = ['c1', 'c2', 'c3'] as const;

type EngineName = 'wasm' | 'native';

interface BenchmarkOptions {
  engines: EngineName[];
  iterations: number;
}

interface OpenEngine {
  name: EngineName;
  db: DatabaseOperations;
  close(): void;
}

interface BatchCase {
  id: 'singleColumn10k' | 'threeColumn30k';
  columns: readonly string[];
  updates: CellUpdate[];
  requestArgs: unknown[];
  assemblyMs: number[];
  localGridApplyMs: number[];
}

interface TimingSummary {
  medianMs: number;
  samplesMs: number[];
}

function parseOptions(argv: string[]): BenchmarkOptions {
  let iterations = 3;
  let engines: EngineName[] = ['wasm', 'native'];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--iterations') {
      const value = argv[++index];
      if (!value) throw new Error('--iterations requires a value');
      iterations = Number(value);
    } else if (argument.startsWith('--iterations=')) {
      iterations = Number(argument.slice('--iterations='.length));
    } else if (argument === '--engines') {
      const value = argv[++index];
      if (!value) throw new Error('--engines requires a value');
      engines = value.split(',') as EngineName[];
    } else if (argument.startsWith('--engines=')) {
      engines = argument.slice('--engines='.length).split(',') as EngineName[];
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new Error('--iterations must be a positive integer');
  }
  if (engines.length === 0 || engines.some(engine => engine !== 'wasm' && engine !== 'native')) {
    throw new Error('--engines must be wasm, native, or wasm,native');
  }
  return { iterations, engines: [...new Set(engines)] };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function summarize(samplesMs: number[]): TimingSummary {
  if (samplesMs.length === 0 || samplesMs.some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error('Benchmark samples must be finite non-negative durations');
  }
  return { medianMs: median(samplesMs), samplesMs };
}

async function measure<T>(operation: () => T | Promise<T>): Promise<{ value: T; durationMs: number }> {
  const startedAt = performance.now();
  const value = await operation();
  return { value, durationMs: performance.now() - startedAt };
}

function createSelectedCells(columns: readonly string[]) {
  const selectedCells = [];
  for (let rowIndex = 0; rowIndex < ROW_COUNT; rowIndex++) {
    for (const column of columns) {
      const columnIndex = ALL_COLUMNS.indexOf(column as typeof ALL_COLUMNS[number]);
      selectedCells.push({
        rowIdx: rowIndex,
        colIdx: columnIndex,
        rowId: rowIndex + 1,
        value: `old-${column}-${rowIndex + 1}`
      });
    }
  }
  return selectedCells;
}

function assembleBatch(columns: readonly string[]) {
  const selectedCells = createSelectedCells(columns);
  const tableColumns = ALL_COLUMNS.map(name => ({ name, type: 'TEXT', isPrimaryKey: false }));
  const inputsByCol = new Map(columns.map(column => {
    const columnIndex = ALL_COLUMNS.indexOf(column as typeof ALL_COLUMNS[number]);
    return [columnIndex, { value: `new-${column}`, dataset: {} }];
  }));
  const prepared = prepareBatchUpdates(selectedCells, inputsByCol, tableColumns, false);
  const updates: CellUpdate[] = prepared.map(update => ({
    rowId: update.rowId,
    column: update.column,
    value: update.value as CellUpdate['value'],
    originalValue: update.originalValue as CellUpdate['originalValue'],
    operation: update.operation
  }));
  return { prepared, updates };
}

function buildBatchCase(
  id: BatchCase['id'],
  columns: readonly string[],
  localIterations = 7
): BatchCase {
  const assemblyMs: number[] = [];
  let assembled = assembleBatch(columns);
  for (let index = 0; index < localIterations; index++) {
    const startedAt = performance.now();
    assembled = assembleBatch(columns);
    assemblyMs.push(performance.now() - startedAt);
  }

  const grid: unknown[][] = Array.from({ length: ROW_COUNT }, (_, rowIndex) => [
    rowIndex + 1,
    ...ALL_COLUMNS.map(column => `old-${column}-${rowIndex + 1}`)
  ]);
  const localGridApplyMs: number[] = [];
  for (let index = 0; index < localIterations; index++) {
    const startedAt = performance.now();
    for (const update of assembled.prepared) {
      grid[update.rowIdx][update.colIdx + 1] = update.value;
    }
    localGridApplyMs.push(performance.now() - startedAt);
  }

  return {
    id,
    columns,
    updates: assembled.updates,
    requestArgs: [TABLE, assembled.updates, `Batch update ${assembled.updates.length} cells`],
    assemblyMs,
    localGridApplyMs
  };
}

async function seedTable(db: DatabaseOperations): Promise<void> {
  await db.executeQuery(`DROP TABLE IF EXISTS ${TABLE}`);
  await db.executeQuery(`CREATE TABLE ${TABLE} (c1 TEXT, c2 TEXT, c3 TEXT)`);
  await db.executeQuery(
    `WITH RECURSIVE rows(id) AS (` +
    `VALUES(1) UNION ALL SELECT id + 1 FROM rows WHERE id < ${ROW_COUNT}` +
    `) INSERT INTO ${TABLE}(c1, c2, c3) ` +
    `SELECT 'old-c1-' || id, 'old-c2-' || id, 'old-c3-' || id FROM rows`
  );
}

async function resetValues(db: DatabaseOperations): Promise<void> {
  await db.executeQuery(
    `UPDATE ${TABLE} SET ` +
    `c1 = 'old-c1-' || rowid, c2 = 'old-c2-' || rowid, c3 = 'old-c3-' || rowid`
  );
}

function numericCell(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'number') throw new Error(`Expected numeric SQLite value, got ${typeof value}`);
  return value;
}

async function assertUpdatedState(db: DatabaseOperations, columns: readonly string[]): Promise<void> {
  const predicate = columns.map(column => `${column} = ?`).join(' AND ');
  const result = await db.executeQuery(
    `SELECT COUNT(*) FROM ${TABLE} WHERE ${predicate}`,
    columns.map(column => `new-${column}`)
  );
  assert.equal(numericCell(result[0]?.rows[0]?.[0]), ROW_COUNT);
}

async function assertOriginalState(db: DatabaseOperations): Promise<void> {
  const result = await db.executeQuery(
    `SELECT COUNT(*) FROM ${TABLE} WHERE ` +
    ALL_COLUMNS.map(column => `${column} = 'old-${column}-' || rowid`).join(' AND ')
  );
  assert.equal(numericCell(result[0]?.rows[0]?.[0]), ROW_COUNT);
}

async function openWasm(): Promise<OpenEngine> {
  const result = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
  if (!result.operations) throw new Error('WASM benchmark engine did not initialize');
  const db = result.operations;
  return {
    name: 'wasm',
    db,
    close: () => (db as DatabaseOperations & { shutdown?: () => void }).shutdown?.()
  };
}

async function openNative(repoRoot: string, databasePath: string): Promise<OpenEngine> {
  const binary = resolveBundledBinaryPath(repoRoot);
  if (!fs.existsSync(binary)) {
    throw new Error(`Bundled native binary is not runnable: ${binary}`);
  }
  fs.writeFileSync(databasePath, new Uint8Array());
  const bundle = await createNativeDatabaseConnection(vscode.Uri.file(repoRoot));
  const established = await bundle.establishConnection(
    vscode.Uri.file(databasePath),
    path.basename(databasePath),
    false
  );
  return {
    name: 'native',
    db: established.databaseOps,
    close: () => bundle.workerMethods[Symbol.dispose]()
  };
}

function historyEntry(historyCells: CellUpdateResult[]): LabeledModification {
  return {
    label: `Batch update ${historyCells.length} cells`,
    description: `Update ${historyCells.length} cells in ${TABLE}`,
    modificationType: 'cell_update',
    targetTable: TABLE,
    affectedCells: historyCells
  };
}

async function measureHistory(historyCells: CellUpdateResult[]) {
  const entry = historyEntry(historyCells);
  const tracker = new ModificationTracker<LabeledModification>();
  const recorded = await measure(() => tracker.record(entry));
  const serialized = await measure(() => tracker.serialize());
  return {
    recordMs: recorded.durationMs,
    estimatedMemoryBytes: (tracker as unknown as { currentSize: number }).currentSize,
    hotExitSerializeMs: serialized.durationMs,
    hotExitBytes: serialized.value.byteLength
  };
}

async function measureRefresh(db: DatabaseOperations, batch: BatchCase) {
  const dataOptions = {
    columns: ['rowid', ...ALL_COLUMNS],
    globalFilterColumns: [...ALL_COLUMNS],
    limit: ROW_COUNT,
    offset: 0
  };
  const unfiltered = await measure(() => db.fetchTableData(TABLE, dataOptions));
  assert.equal(unfiltered.value.rows.length, ROW_COUNT);

  const filteredOptions = {
    ...dataOptions,
    filters: [{ column: batch.columns[0], value: `new-${batch.columns[0]}` }]
  };
  const filtered = await measure(() => Promise.all([
    db.fetchTableCount(TABLE, filteredOptions),
    db.fetchTableData(TABLE, filteredOptions)
  ]));
  assert.equal(filtered.value[0], ROW_COUNT);
  assert.equal(filtered.value[1].rows.length, ROW_COUNT);
  return {
    unfilteredDataRefetchMs: unfiltered.durationMs,
    filteredCountAndDataRefetchMs: filtered.durationMs
  };
}

async function measureEngineCase(
  db: DatabaseOperations,
  batch: BatchCase,
  iterations: number
) {
  const updateMs: number[] = [];
  const undoMs: number[] = [];
  const redoMs: number[] = [];
  const refreshUnfilteredMs: number[] = [];
  const refreshFilteredMs: number[] = [];
  let representativeHistory: CellUpdateResult[] | undefined;
  let historyMetrics: Awaited<ReturnType<typeof measureHistory>> | undefined;

  for (let index = 0; index < iterations; index++) {
    await resetValues(db);
    const applied = await measure(() => db.updateCellBatch(TABLE, batch.updates, EDIT_LIMIT_BYTES));
    updateMs.push(applied.durationMs);
    representativeHistory ??= applied.value;
    assert.equal(applied.value.length, batch.updates.length);
    await assertUpdatedState(db, batch.columns);

    if (!historyMetrics) historyMetrics = await measureHistory(applied.value);
    const entry = historyEntry(applied.value);
    const undone = await measure(() => db.undoModification(entry));
    undoMs.push(undone.durationMs);
    await assertOriginalState(db);

    const redone = await measure(() => db.redoModification(entry));
    redoMs.push(redone.durationMs);
    await assertUpdatedState(db, batch.columns);

    const refresh = await measureRefresh(db, batch);
    refreshUnfilteredMs.push(refresh.unfilteredDataRefetchMs);
    refreshFilteredMs.push(refresh.filteredCountAndDataRefetchMs);
  }

  return {
    update: summarize(updateMs),
    history: historyMetrics!,
    undo: summarize(undoMs),
    redo: summarize(redoMs),
    refreshUnfiltered: summarize(refreshUnfilteredMs),
    refreshFilteredAfterCountInvalidation: summarize(refreshFilteredMs),
    historyCells: representativeHistory!
  };
}

async function snapshotRowsForHost(db: DatabaseOperations) {
  const columns = await db.executeQuery(
    `SELECT name FROM pragma.pragma_table_xinfo(?) WHERE hidden NOT IN (2, 3) ORDER BY cid`,
    [TABLE]
  );
  const names = columns[0].rows.map(row => String(row[0]));
  const rowIds = Array.from({ length: ROW_COUNT }, (_, index) => index + 1);
  const placeholders = rowIds.map(() => '?').join(', ');
  return db.executeQuery(
    `SELECT CAST(rowid AS TEXT), ${names.map(name => `"${name.replace(/"/g, '""')}"`).join(', ')} ` +
    `FROM ${TABLE} WHERE rowid IN (${placeholders})`,
    rowIds
  );
}

async function measureDelete(db: DatabaseOperations) {
  await resetValues(db);
  const rowIds = Array.from({ length: ROW_COUNT }, (_, index) => index + 1);
  const hostSnapshot = await measure(() => snapshotRowsForHost(db));
  assert.equal(hostSnapshot.value[0].rows.length, ROW_COUNT);

  const deleted = await measure(() => db.deleteRows(TABLE, rowIds));
  assert.equal(deleted.value?.length, ROW_COUNT);
  const entry: LabeledModification = {
    label: 'Delete Rows',
    description: `Delete ${ROW_COUNT} rows from ${TABLE}`,
    modificationType: 'row_delete',
    targetTable: TABLE,
    affectedRowIds: rowIds,
    deletedRows: deleted.value
  };
  const history = new ModificationTracker<LabeledModification>();
  const recorded = await measure(() => history.record(entry));

  const undo = await measure(() => db.undoModification(entry));
  await assertOriginalState(db);
  const redo = await measure(() => db.redoModification(entry));
  const count = await db.fetchTableCount(TABLE, {});
  assert.equal(count, 0);

  return {
    duplicateHostSnapshotMs: hostSnapshot.durationMs,
    engineDeleteMs: deleted.durationMs,
    historyRecordMs: recorded.durationMs,
    undoReinsertMs: undo.durationMs,
    redoDeleteMs: redo.durationMs,
    historyEstimatedMemoryBytes: (history as unknown as { currentSize: number }).currentSize
  };
}

async function loadWebviewApi() {
  let postReceiver: ((message: any) => void) | undefined;
  Object.defineProperty(globalThis, 'acquireVsCodeApi', {
    configurable: true,
    value: () => ({
      getState: () => undefined,
      setState: () => undefined,
      postMessage: (message: unknown) => {
        const receiver = postReceiver;
        postReceiver = undefined;
        receiver?.(message);
      }
    })
  });
  // @ts-expect-error Webview sources are intentionally plain JavaScript modules.
  const api = await import('../../core/ui/modules/api.js');
  const captureNextPost = () => new Promise<any>(resolve => {
    if (postReceiver) throw new Error('Concurrent benchmark webview posts are unsupported');
    postReceiver = resolve;
  });
  return { api, captureNextPost };
}

async function measureRequestBridge(
  webview: Awaited<ReturnType<typeof loadWebviewApi>>,
  batch: BatchCase,
  iterations = 5
) {
  const webviewSerializeMs: number[] = [];
  let envelope: any;
  for (let index = 0; index < iterations; index++) {
    const posted = webview.captureNextPost();
    const startedAt = performance.now();
    const pending = webview.api.sendRpcRequest('updateCellBatch', batch.requestArgs);
    envelope = await posted;
    webviewSerializeMs.push(performance.now() - startedAt);
    webview.api.handleRpcResponse({
      kind: 'response',
      messageId: envelope.content.messageId,
      success: true,
      data: []
    });
    await pending;
  }

  const structuredCloneMs: number[] = [];
  const hostDeserializeMs: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const cloneStartedAt = performance.now();
    structuredClone(envelope);
    structuredCloneMs.push(performance.now() - cloneStartedAt);

    const deserializeStartedAt = performance.now();
    assertWebviewTransportPayload(envelope, {
      surface: WEBVIEW_TRANSPORT_SURFACES.webviewRequest
    });
    deserializeArgs(envelope.content.payload, {
      surface: WEBVIEW_TRANSPORT_SURFACES.webviewRequest
    });
    hostDeserializeMs.push(performance.now() - deserializeStartedAt);
  }

  return {
    jsonBytes: Buffer.byteLength(JSON.stringify(envelope)),
    estimatedEncodedBytes: assertWebviewTransportPayload(envelope, {
      surface: WEBVIEW_TRANSPORT_SURFACES.webviewRequest
    }),
    webviewSerialize: summarize(webviewSerializeMs),
    structuredClone: summarize(structuredCloneMs),
    hostValidateAndDeserialize: summarize(hostDeserializeMs)
  };
}

async function measureResponseBridge(
  webview: Awaited<ReturnType<typeof loadWebviewApi>>,
  historyCells: CellUpdateResult[],
  iterations = 3
) {
  const hostSerializeMs: number[] = [];
  const webviewDeserializeMs: number[] = [];
  let serializedHistory: unknown;
  for (let index = 0; index < iterations; index++) {
    const startedAt = performance.now();
    const raw = {
      channel: 'rpc',
      content: { kind: 'response', messageId: 'bench-response', success: true, data: historyCells }
    };
    assertWebviewTransportPayload(raw, { surface: WEBVIEW_TRANSPORT_SURFACES.hostResponse });
    serializedHistory = serializeValue(historyCells, {
      surface: WEBVIEW_TRANSPORT_SURFACES.hostResponse
    });
    hostSerializeMs.push(performance.now() - startedAt);
  }

  for (let index = 0; index < iterations; index++) {
    const posted = webview.captureNextPost();
    const pending = webview.api.sendRpcRequest('benchResponse', []);
    const request = await posted;
    const startedAt = performance.now();
    webview.api.handleRpcResponse({
      kind: 'response',
      messageId: request.content.messageId,
      success: true,
      data: serializedHistory
    });
    webviewDeserializeMs.push(performance.now() - startedAt);
    await pending;
  }

  return {
    jsonBytes: Buffer.byteLength(JSON.stringify(serializedHistory)),
    estimatedEncodedBytes: assertWebviewTransportPayload(serializedHistory, {
      surface: WEBVIEW_TRANSPORT_SURFACES.hostResponse
    }),
    hostValidateAndSerialize: summarize(hostSerializeMs),
    webviewValidateAndDeserialize: summarize(webviewDeserializeMs)
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const repoRoot = process.cwd();
  const workspaceTmp = path.join(repoRoot, '.tmp');
  fs.mkdirSync(workspaceTmp, { recursive: true });
  const runDirectory = fs.mkdtempSync(path.join(workspaceTmp, 'batch-ops-'));
  const batches = [
    buildBatchCase('singleColumn10k', ['c1']),
    buildBatchCase('threeColumn30k', ALL_COLUMNS)
  ];
  const webview = await loadWebviewApi();
  const output: any = {
    benchmark: 'batch-update-delete-full-path',
    rowCount: ROW_COUNT,
    iterations: options.iterations,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    uiAndRequestBridge: {},
    engines: {}
  };

  try {
    for (const batch of batches) {
      const values = batch.updates.map(update => update.value);
      const validation = await measure(() => assertCellValuesWithinEditLimit(values, EDIT_LIMIT_BYTES));
      output.uiAndRequestBridge[batch.id] = {
        cells: batch.updates.length,
        assembly: summarize(batch.assemblyMs),
        localGridApply: summarize(batch.localGridApplyMs),
        hostValueValidationMs: validation.durationMs,
        request: await measureRequestBridge(webview, batch)
      };
    }

    let representativeHistories: Record<string, CellUpdateResult[]> = {};
    for (const engineName of options.engines) {
      const originalWarn = console.warn;
      if (engineName === 'native') {
        console.warn = (...args: unknown[]) => {
          if (args[0] !== '[NativeWorker]') originalWarn(...args);
        };
      }
      const opened = engineName === 'wasm'
        ? await openWasm()
        : await openNative(repoRoot, path.join(runDirectory, 'native.sqlite'));
      try {
        await seedTable(opened.db);
        const engineOutput: any = { cases: {} };
        for (const batch of batches) {
          const measured = await measureEngineCase(opened.db, batch, options.iterations);
          representativeHistories[batch.id] ??= measured.historyCells;
          delete (measured as { historyCells?: CellUpdateResult[] }).historyCells;
          engineOutput.cases[batch.id] = measured;
        }
        await seedTable(opened.db);
        engineOutput.delete10k = await measureDelete(opened.db);
        output.engines[opened.name] = engineOutput;
      } finally {
        opened.close();
        console.warn = originalWarn;
      }
    }

    for (const batch of batches) {
      const history = representativeHistories[batch.id];
      if (!history) throw new Error(`No runnable engine produced history for ${batch.id}`);
      output.uiAndRequestBridge[batch.id].response = await measureResponseBridge(webview, history);
    }

    console.log(JSON.stringify(output, null, 2));
  } finally {
    const resolvedRunDirectory = path.resolve(runDirectory);
    const resolvedWorkspaceTmp = path.resolve(workspaceTmp);
    if (!resolvedRunDirectory.startsWith(`${resolvedWorkspaceTmp}${path.sep}`)) {
      throw new Error(`Refusing to clean unexpected benchmark directory: ${resolvedRunDirectory}`);
    }
    fs.rmSync(resolvedRunDirectory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
