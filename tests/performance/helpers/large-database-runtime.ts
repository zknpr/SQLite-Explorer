import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as vscode from 'vscode';
import { createNativeDatabaseConnection } from '../../../src/nativeWorker';
import {
  createDatabaseConnection,
  setDesktopTestDatabaseBackend,
  setDesktopTestPagedOpenThresholdBytes
} from '../../../src/workerFactory';
import { streamTableExport } from '../../../src/tableExportStreaming';
import { toWebviewQueryResultSet } from '../../../src/hostBridge';
import { serializeValue } from '../../../src/core/serialization';
import { WEBVIEW_TRANSPORT_SURFACES } from '../../../src/core/webview-transport';
import type { DatabaseOperations, ModificationEntry, TableQueryOptions } from '../../../src/core/types';
import type { DatabaseConnectionBundle } from '../../../src/connectionTypes';

interface Options {
  mode: 'generate' | 'native' | 'wasm';
  root: string;
  runtime: string;
  fixture: string;
  payloadBytes: number;
  generationTimeoutMs: number;
}

const options = JSON.parse(process.argv[2]) as Options;
const CELL_BYTES = 256 * 1024;
const BATCH_ROWS = 256;
const PAGE_ROWS = 25;
const rowCount = options.payloadBytes / CELL_BYTES;
assert.ok(Number.isSafeInteger(rowCount) && rowCount >= 64 && rowCount <= 65536);
const records: Array<Record<string, unknown>> = [];

function memory() {
  const current = process.memoryUsage();
  return {
    processId: process.pid,
    rssBytes: current.rss,
    heapUsedBytes: current.heapUsed,
    externalBytes: current.external,
    nodeProcessMaxRssBytes: process.resourceUsage().maxRSS * 1024
  };
}

function emit(record: Record<string, unknown>) {
  const value = { at: new Date().toISOString(), mode: options.mode, ...record };
  records.push(value);
  process.stdout.write(`LARGE_DATABASE_QA ${JSON.stringify(value)}\n`);
}

async function stage<T>(name: string, body: () => Promise<T>): Promise<T> {
  const started = performance.now();
  emit({ event: 'stage-start', name, memory: memory() });
  try {
    const result = await body();
    emit({ event: 'stage-pass', name, elapsedMs: performance.now() - started, memory: memory() });
    return result;
  } catch (error) {
    emit({ event: 'stage-fail', name, elapsedMs: performance.now() - started,
      error: error instanceof Error ? error.stack : String(error), memory: memory() });
    throw error;
  }
}

async function openNative(file: string) {
  const bundle = await createNativeDatabaseConnection(vscode.Uri.file(options.root), undefined, undefined, 60000);
  try {
    const established = await bundle.establishConnection(vscode.Uri.file(file), path.basename(file), false);
    assert.equal(await established.databaseOps.engineKind, 'native');
    return { bundle, ...established };
  } catch (error) { bundle.workerMethods[Symbol.dispose](); throw error; }
}

async function scalar(db: DatabaseOperations, sql: string): Promise<number> {
  return Number((await db.executeQuery(sql))[0].rows[0][0]);
}

async function geometry(db: DatabaseOperations) {
  const live = (await db.executeQuery(
    'SELECT count(*), sum(length(payload)), min(length(payload)), max(length(payload)) FROM live_rows'
  ))[0].rows[0].map(Number);
  assert.deepEqual(live, [rowCount, options.payloadBytes, CELL_BYTES, CELL_BYTES]);
  const pageSize = await scalar(db, 'PRAGMA page_size');
  const pageCount = await scalar(db, 'PRAGMA page_count');
  const freePages = await scalar(db, 'PRAGMA freelist_count');
  if (options.mode === 'generate') {
    assert.equal(freePages, 0, 'new fixture must consist of live pages rather than preallocated free pages');
  } else {
    // Editing a small field of an overflow row can move that row's payload and
    // free its former overflow pages. This is ordinary mutation behavior; only
    // the newly generated baseline promises zero free pages.
    assert.ok(freePages * pageSize <= CELL_BYTES * 4, 'only bounded mutation-created free space is permitted');
  }
  const stat = await fs.stat(options.fixture);
  assert.equal(stat.size, pageSize * pageCount);
  const allocatedBytes = stat.blocks > 0 ? stat.blocks * 512 : undefined;
  if (allocatedBytes !== undefined) {
    assert.ok(allocatedBytes >= options.payloadBytes * 0.99, 'fixture must be physically allocated rather than sparse');
  }
  return { rows: rowCount, livePayloadBytes: options.payloadBytes, cellBytes: CELL_BYTES,
    pageSize, pageCount, freePages, fileBytes: stat.size, allocatedBytes,
    sparseAllocationCheck: allocatedBytes === undefined ? 'unavailable on this platform' : 'passed' };
}

async function generate() {
  const file = await fs.open(options.fixture, 'wx');
  await file.close();
  const opened = await openNative(options.fixture);
  const db = opened.databaseOps;
  const started = Date.now();
  try {
    await db.executeQuery('PRAGMA journal_mode=DELETE; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-16384;');
    await db.executeQuery(
      'CREATE TABLE live_rows (id INTEGER PRIMARY KEY, bucket TEXT NOT NULL, label TEXT NOT NULL, payload BLOB NOT NULL);' +
      'CREATE INDEX live_rows_bucket ON live_rows(bucket, id);'
    );
    await stage('generate-live-payload', async () => {
      for (let first = 1; first <= rowCount; first += BATCH_ROWS) {
        if (Date.now() - started > options.generationTimeoutMs) throw new Error('Fixture generation exceeded its explicit deadline');
        const last = Math.min(rowCount, first + BATCH_ROWS - 1);
        await db.executeQuery('BEGIN IMMEDIATE');
        try {
          await db.executeQuery(
            'WITH RECURSIVE sequence(id) AS (SELECT ? UNION ALL SELECT id+1 FROM sequence WHERE id < ?) ' +
            'INSERT INTO live_rows SELECT id, printf(\'b%03d\', id % 128), printf(\'row-%08d\', id), zeroblob(?) FROM sequence',
            [first, last, CELL_BYTES]
          );
          await db.executeQuery('COMMIT');
        } catch (error) {
          try { await db.executeQuery('ROLLBACK'); }
          catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Generation and rollback failed'); }
          throw error;
        }
        if (last === rowCount || last % 4096 === 0) emit({ event: 'generation-progress', rows: last, livePayloadBytes: last * CELL_BYTES });
      }
    });
    await db.flushChanges();
    const shape = await stage('verify-live-geometry', () => geometry(db));
    await fs.writeFile(`${options.fixture}.meta.json`, JSON.stringify({ ...shape,
      sqliteVersion: (await db.executeQuery('SELECT sqlite_version()'))[0].rows[0][0],
      generatedBy: 'createNativeDatabaseConnection with shipped native worker', generatedAt: new Date().toISOString()
    }, null, 2) + '\n');
    emit({ event: 'fixture-ready', ...shape });
  } finally { opened.bundle.workerMethods[Symbol.dispose](); }
}

async function characterize() {
  let bundle: DatabaseConnectionBundle | undefined;
  let db!: DatabaseOperations;
  async function open() {
    if (options.mode === 'native') {
      const opened = await openNative(options.fixture);
      bundle = opened.bundle; db = opened.databaseOps;
      emit({ event: 'opened', engineKind: await db.engineKind, storage: opened.storage ?? 'native', readOnly: opened.isReadOnly });
    } else {
      setDesktopTestDatabaseBackend('wasm');
      setDesktopTestPagedOpenThresholdBytes(8 * 1024 * 1024);
      bundle = await createDatabaseConnection(vscode.Uri.file(options.runtime));
      const opened = await bundle.establishConnection(vscode.Uri.file(options.fixture), path.basename(options.fixture), false, false);
      db = opened.databaseOps;
      assert.equal(await db.engineKind, 'wasm');
      assert.equal(opened.storage, 'paged', 'the large test must exercise production worker-backed paging');
      assert.equal(opened.isReadOnly, false, 'the persistence checks require the writable overlay');
      emit({ event: 'opened', engineKind: await db.engineKind, storage: opened.storage, readOnly: opened.isReadOnly });
    }
  }

  try {
    await stage('open-production-connection', open);
    emit({ event: 'fixture-geometry', ...await stage('verify-live-geometry', () => geometry(db)) });
    await stage('schema-and-column-metadata', async () => {
      assert.ok((await db.fetchSchema()).tables.some(table => table.identifier === 'live_rows'));
      assert.deepEqual((await db.getTableInfo('live_rows')).map(column => column.identifier), ['id', 'bucket', 'label', 'payload']);
    });
    const page: TableQueryOptions = { columns: ['rowid', 'id', 'bucket', 'label'], orderBy: 'id', orderDir: 'ASC', limit: PAGE_ROWS, offset: 0 };
    await stage('first-keyset-page', async () => {
      const result = await db.fetchTableData('live_rows', { ...page, keyset: { mode: 'first' } });
      assert.deepEqual(result.rows.map(row => Number(row[1])), Array.from({ length: PAGE_ROWS }, (_, index) => index + 1));
      assert.ok(result.keysetAnchors?.first && result.keysetAnchors.last);
    });
    const remainder = rowCount % PAGE_ROWS || PAGE_ROWS;
    const last = await stage('last-deep-keyset-page', async () => {
      const result = await db.fetchTableData('live_rows', { ...page, offset: rowCount - remainder,
        keyset: { mode: 'last', lastPageRowCount: remainder } });
      assert.deepEqual(result.rows.map(row => Number(row[1])), Array.from({ length: remainder }, (_, index) => rowCount - remainder + index + 1));
      assert.ok(result.keysetAnchors?.first && result.keysetAnchors.last);
      return result;
    });
    const previous = await stage('previous-deep-keyset-page', async () => {
      const result = await db.fetchTableData('live_rows', { ...page, offset: rowCount - remainder - PAGE_ROWS,
        keyset: { mode: 'before', anchor: last.keysetAnchors!.first } });
      assert.deepEqual(result.rows.map(row => Number(row[1])), Array.from({ length: PAGE_ROWS }, (_, index) => rowCount - remainder - PAGE_ROWS + index + 1));
      return result;
    });
    await stage('next-and-refetch-deep-keyset-page', async () => {
      const next = await db.fetchTableData('live_rows', { ...page, offset: rowCount - remainder,
        keyset: { mode: 'after', anchor: previous.keysetAnchors!.last } });
      assert.deepEqual(next.rows, last.rows);
      const current = await db.fetchTableData('live_rows', { ...page, offset: rowCount - remainder,
        keyset: { mode: 'atOrAfter', anchor: last.keysetAnchors!.first } });
      assert.deepEqual(current.rows, last.rows);
    });
    await stage('deep-offset-baseline', async () => {
      const result = await db.fetchTableData('live_rows', { ...page, offset: rowCount - PAGE_ROWS });
      assert.equal(Number(result.rows[0][1]), rowCount - PAGE_ROWS + 1);
      assert.equal(Number(result.rows.at(-1)![1]), rowCount);
    });
    await stage('indexed-filter-count-and-original-plan', async () => {
      const count = await db.executeReadQuery('SELECT count(*) AS total FROM live_rows WHERE bucket = ?', ['b007']);
      const expected = Math.floor((rowCount - 7) / 128) + 1;
      assert.equal(Number(count.rows[0][0]), expected);
      const plan = await db.executeReadQuery('SELECT count(*) AS total FROM live_rows WHERE bucket = ?', ['b007'], true);
      assert.match(JSON.stringify(plan.rows), /SEARCH.*live_rows_bucket/i);
      const gridCount = await db.fetchTableCount('live_rows', { filters: [{ column: 'bucket', value: 'b007' }] });
      assert.equal(gridCount.count, expected); assert.equal(gridCount.isExact, true);
      const filtered = await db.fetchTableData('live_rows', { ...page, filters: [{ column: 'bucket', value: 'b007' }] });
      assert.ok(filtered.rows.length > 0 && filtered.rows.every(row => row[2] === 'b007'));
      emit({ event: 'indexed-query-result', count: expected, plan: plan.rows });
    });
    await stage('default-5000-row-grid-payload-and-host-transport', async () => {
      const rows = Math.min(rowCount, 5000);
      const result = await db.fetchTableData('live_rows', {
        columns: ['rowid', 'id', 'bucket', 'label', 'payload'], orderBy: 'id', limit: rows, offset: 0
      });
      assert.equal(result.rows.length, rows);
      let previewBytes = 0;
      for (let index = 0; index < rows; index++) {
        const row = result.rows[index];
        assert.equal(Number(row[1]), index + 1);
        assert.ok(row[4] instanceof Uint8Array);
        previewBytes += row[4].byteLength;
        if (row[4].byteLength < CELL_BYTES) assert.equal(result.oversizedCells?.[index]?.[4]?.byteLength, CELL_BYTES);
      }
      assert.ok(previewBytes <= 16 * 1024 * 1024);
      const transport = serializeValue(toWebviewQueryResultSet(result), { surface: WEBVIEW_TRANSPORT_SURFACES.hostResponse });
      const jsonBytes = Buffer.byteLength(JSON.stringify(transport));
      assert.ok(jsonBytes <= 32 * 1024 * 1024);
      emit({ event: 'default-grid-result', rows, underlyingPayloadBytes: rows * CELL_BYTES,
        actualPreviewBytes: previewBytes, hostTransportJsonBytes: jsonBytes });
    });
    await stage('bounded-live-payload-preview-and-chunks', async () => {
      const preview = await db.fetchTableData('live_rows', { columns: ['rowid', 'payload'], limit: 1, offset: rowCount - 1,
        maxInlineCellBytes: 1024, maxPageResponseBytes: 4096 });
      assert.equal(preview.oversizedCells?.[0]?.[1]?.byteLength, CELL_BYTES);
      assert.ok((preview.rows[0][1] as Uint8Array).byteLength <= 1024);
      const session = await db.openCellReadSession({ table: 'live_rows', rowId: rowCount, column: 'payload' });
      try {
        assert.equal(session.metadata.byteLength, CELL_BYTES);
        for (const offset of [0, CELL_BYTES / 2, CELL_BYTES - 65536]) {
          const chunk = await db.readCellChunk(session.sessionId, offset, 65536);
          assert.equal(chunk.bytes.byteLength, 65536); assert.ok(chunk.bytes.every(value => value === 0));
        }
      } finally { await db.closeCellReadSession(session.sessionId); }
    });
    const before = String((await db.executeReadQuery('SELECT label FROM live_rows WHERE id = ?', [rowCount])).rows[0][0]);
    const changed = `${options.mode}-persisted`;
    await stage('edit-undo-redo-production-history', async () => {
      const [update] = await db.updateCellBatch('live_rows', [{ rowId: rowCount, column: 'label', value: changed }]);
      const modification: ModificationEntry = { description: 'Large database label update', modificationType: 'cell_update',
        targetTable: 'live_rows', targetRowId: rowCount, targetColumn: 'label', priorValue: update.priorValue,
        newValue: update.newValue, priorState: update.priorState, postState: update.postState, operation: update.operation };
      const read = async () => (await db.executeReadQuery('SELECT label FROM live_rows WHERE id = ?', [rowCount])).rows[0][0];
      assert.equal(await read(), changed);
      await db.undoModification(modification); assert.equal(await read(), before);
      await db.redoModification(modification); assert.equal(await read(), changed);
    });
    await stage('bounded-selected-row-export', async () => {
      let text = '', maximumChunkBytes = 0;
      const count = await streamTableExport(db, 'live_rows', ['id', 'bucket', 'label'],
        { format: 'json', rowIds: [1, Math.floor(rowCount / 2), rowCount] }, { write: async chunk => {
          maximumChunkBytes = Math.max(maximumChunkBytes, Buffer.byteLength(chunk));
          text += chunk; assert.ok(Buffer.byteLength(text) < 4096);
        } });
      assert.equal(count, 3);
      assert.deepEqual(JSON.parse(text).map((row: { id: number }) => row.id), [1, Math.floor(rowCount / 2), rowCount]);
      assert.equal(JSON.parse(text).at(-1).label, changed);
      emit({ event: 'selected-export-result', rows: count, bytes: Buffer.byteLength(text), maximumChunkBytes });
    });
    await stage('cancel-payload-export-and-reuse-connection', async () => {
      let bytes = 0, cancelled = false;
      await assert.rejects(streamTableExport(db, 'live_rows', ['id', 'payload'], { format: 'json', rowIds: [rowCount] }, {
        write: async chunk => { bytes += Buffer.byteLength(chunk); if (bytes >= 128 * 1024) cancelled = true; }
      }, { get isCancellationRequested() { return cancelled; } }), /cancel/i);
      assert.ok(bytes > 0 && bytes < 1024 * 1024);
      assert.equal((await db.executeReadQuery('SELECT 1')).rows[0][0], 1);
      emit({ event: 'cancelled-export-result', emittedBytesBeforeCancellation: bytes });
    });
    await stage('persist-production-path', async () => {
      if (options.mode === 'wasm') {
        assert.ok(db.writeToFile);
        const result = await db.writeToFile(options.fixture);
        assert.equal(result?.requiresReopen, true);
      } else { await db.flushChanges(); }
    });
    bundle!.workerMethods[Symbol.dispose](); bundle = undefined;
    await stage('close-reopen-and-verify-persisted-label', async () => {
      await open();
      assert.equal((await db.executeReadQuery('SELECT label FROM live_rows WHERE id = ?', [rowCount])).rows[0][0], changed);
      assert.equal(Number((await db.executeReadQuery('SELECT length(payload) FROM live_rows WHERE id = ?', [rowCount])).rows[0][0]), CELL_BYTES);
    });
    emit({ event: 'characterization-pass', fixture: options.fixture, expectedLivePayloadBytes: options.payloadBytes, memory: memory() });
  } finally { bundle?.workerMethods[Symbol.dispose](); }
}

emit({ event: 'environment', platform: process.platform, arch: process.arch, node: process.version,
  totalPhysicalMemoryBytes: os.totalmem(), fixture: options.fixture, expectedLivePayloadBytes: options.payloadBytes,
  caveat: 'WASM RSS is the whole Node process including worker threads. Native sidecar RSS is recorded separately by the parent sampler. This is not VS Code UI coverage or a cold-cache benchmark.' });
(options.mode === 'generate' ? generate() : characterize()).catch(error => {
  emit({ event: 'fatal', error: error instanceof Error ? error.stack : String(error) });
  process.exitCode = 1;
}).finally(async () => {
  await fs.writeFile(`${options.fixture}.${options.mode}.json`, JSON.stringify(records, null, 2) + '\n');
});
