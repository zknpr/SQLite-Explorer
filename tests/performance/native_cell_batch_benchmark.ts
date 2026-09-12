import '../unit/vscode_mock_setup';

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import * as vscode from 'vscode';
import * as currentHost from '../../src/nativeWorker';
import type { CellUpdate, CellUpdateResult, ModificationEntry } from '../../src/core/types';

// Same wide-grid shape as the reported stress test. Runtime roots let the host
// implementation be held constant while comparing two pinned native builds.
async function main() {
  const { createNativeDatabaseConnection, NativeWorkerProcess } = process.argv[6]
    ? await import(pathToFileURL(path.resolve(process.argv[6])).href) as typeof currentHost
    : currentHost;
  const runtimeRoot = path.resolve(process.argv[2] ?? process.cwd());
  const rows = Number(process.argv[3] ?? 5000);
  const iterations = Number(process.argv[4] ?? 3);
  const editedColumns = Number(process.argv[5] ?? 1);
  if (![rows, iterations, editedColumns].every(Number.isSafeInteger)
    || rows < 1 || iterations < 1 || editedColumns < 1 || editedColumns > 50) {
    throw new Error('Usage: native_cell_batch_benchmark.ts [runtime-root] [rows] [iterations] [edited-columns:1-50] [host-source]');
  }
  fs.mkdirSync(path.join(process.cwd(), '.tmp'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(process.cwd(), '.tmp', 'native-cell-batch-'));
  const file = path.join(directory, 'benchmark.sqlite');
  const columns = Array.from({ length: 50 }, (_, index) => `c${index}`);
  const seed = new DatabaseSync(file);
  try {
    seed.exec(`CREATE TABLE stress_test(id INTEGER PRIMARY KEY, ${columns.map(column => `${column} TEXT`).join(', ')})`);
    seed.exec(`WITH RECURSIVE rows(id) AS (VALUES(1) UNION ALL SELECT id + 1 FROM rows WHERE id < ${rows})
      INSERT INTO stress_test SELECT id, ${columns.map(column => `'${column}-' || id`).join(', ')} FROM rows`);
  } finally { seed.close(); }

  const actualCall = NativeWorkerProcess.prototype.call;
  let calls: Record<string, number> = {};
  let callMs: Record<string, number> = {};
  NativeWorkerProcess.prototype.call = async function<T>(...args: Parameters<typeof actualCall>): Promise<T> {
    calls[args[0]] = (calls[args[0]] ?? 0) + 1;
    const start = performance.now();
    try { return await actualCall.apply(this, args) as T; }
    finally { callMs[args[0]] = (callMs[args[0]] ?? 0) + performance.now() - start; }
  };
  const samples: Record<string, number[]> = {};
  async function measure<T>(phase: string, operation: () => Promise<T>): Promise<T> {
    calls = {};
    callMs = {};
    const start = performance.now();
    const value = await operation();
    const ms = performance.now() - start;
    (samples[phase] ??= []).push(ms);
    console.log(JSON.stringify({ phase, ms, calls, callMs }));
    return value;
  }

  let bundle: Awaited<ReturnType<typeof createNativeDatabaseConnection>> | undefined;
  try {
    bundle = await createNativeDatabaseConnection(vscode.Uri.file(runtimeRoot));
    const { databaseOps: db } = await bundle.establishConnection(vscode.Uri.file(file), 'benchmark.sqlite');
    const updates: CellUpdate[] = Array.from({ length: rows }, (_, index) => columns.slice(0, editedColumns)
      .map(column => ({ rowId: index + 1, column, value: 'updated' }))).flat();
    const modification = (cells: CellUpdateResult[]): ModificationEntry => ({
      modificationType: 'cell_update', targetTable: 'stress_test',
      description: 'Stress-test batch', affectedCells: cells
    });
    const verify = async (updated: boolean) => {
      const predicate = columns.slice(0, editedColumns).map(column => (
        updated ? `${column} = 'updated'` : `${column} = '${column}-' || id`
      )).join(' AND ');
      const result = await db.executeQuery(`SELECT COUNT(*) FROM stress_test WHERE ${predicate}`);
      assert.equal(Number(result[0].rows[0][0]), rows);
    };
    const warm = await db.updateCellBatch('stress_test', updates, 1024 * 1024, 50 * 1024 * 1024);
    await db.undoModification(modification(warm));
    for (let iteration = 0; iteration < iterations; iteration++) {
      const cells = await measure('update', () => db.updateCellBatch('stress_test', updates, 1024 * 1024, 50 * 1024 * 1024));
      await verify(true);
      await measure('undo', () => db.undoModification(modification(cells)));
      await verify(false);
      await measure('redo', () => db.redoModification(modification(cells)));
      await verify(true);
      await measure('fetchPage', () => db.fetchTableData('stress_test', { columns: ['id', ...columns], limit: rows, offset: 0 }));
      await db.undoModification(modification(cells));
    }
    const medians = Object.fromEntries(Object.entries(samples).map(([phase, values]) => (
      [phase, [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]]
    )));
    console.log(JSON.stringify({ runtimeRoot, rows, editedColumns, iterations, medians, samples }));
  } finally {
    NativeWorkerProcess.prototype.call = actualCall;
    bundle?.workerMethods[Symbol.dispose]();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
