import './vscode_mock_setup';

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, describe, it, type TestContext } from 'node:test';
import * as vscode from 'vscode';
import { createDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection, isNativeAvailable } from '../../src/nativeWorker';
import type { CellValue, DatabaseOperations, ModificationEntry, RecordId } from '../../src/core/types';

// Both engines' SQLite refuses an expression nested more than 1,000 deep and
// a result set of more than 2,000 columns, and allows a table of 2,000
// columns. Row history summed every column's size in one + chain, matched
// every column in one AND chain and read two result columns per column, so
// inserting or deleting a row, or undoing either, failed from about 996
// columns. With the rowid beside them one SELECT reads at most 999 columns,
// so 999 and 1,000 straddle that limit; without it, 1,000 and 1,001 do.
const WIDTHS = [995, 996, 999, 1000, 1001, 2000];
const BUDGET = 50 * 1024 * 1024;
const KINDS = ['rowid', 'withoutRowid'] as const;
type Kind = typeof KINDS[number];

// Every storage class, REAL, TEXT and int64 first: their match terms nest deepest.
function cell(column: number, row: number): { value: CellValue; quoted: string } {
  switch (column % 6) {
    case 0: return { value: row + 0.5, quoted: `${row}.5` };
    case 1: return { value: `t${row}-${column}`, quoted: `'t${row}-${column}'` };
    case 2: return { value: 9007199254740993n + BigInt(row), quoted: String(9007199254740993n + BigInt(row)) };
    case 3: return { value: null, quoted: 'NULL' };
    case 4: {
      const bytes = [row, column % 256];
      return { value: new Uint8Array(bytes), quoted: `X'${bytes.map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join('')}'` };
    }
    default: return { value: row * 10000 + column, quoted: String(row * 10000 + column) };
  }
}

const columnsOf = (width: number) => Array.from({ length: width }, (_, index) => `c${index}`);
const rowData = (width: number, row: number) => Object.fromEntries(
  columnsOf(width).map((column, index) => [column, cell(index, row).value])
);
const expectedRow = (width: number, kind: Kind, row: number) => [
  ...(kind === 'rowid' ? [String(row)] : []),
  ...columnsOf(width).map((_, index) => cell(index, row).quoted)
].join(',');

/** Every row as quote() text, read in column chunks under the result-column cap. */
async function contents(ops: DatabaseOperations, table: string, width: number, kind: Kind): Promise<string[]> {
  const rows: string[][] = [];
  const order = kind === 'rowid' ? 'rowid' : 'c0';
  for (let start = 0; start < width; start += 500) {
    const chunk = columnsOf(width).slice(start, start + 500);
    // Native results are keyed by column name, so every one is aliased.
    const prefix = kind === 'rowid' && start === 0 ? 'CAST(rowid AS TEXT) AS r, ' : '';
    const result = await ops.executeQuery(
      `SELECT ${prefix}${chunk.map(column => `quote(${column}) AS q${column}`).join(', ')} FROM "${table}" ORDER BY ${order}`
    );
    (result[0]?.rows ?? []).forEach((row, index) => (rows[index] ??= []).push(...row.map(String)));
  }
  return rows.map(row => row.join(','));
}

async function assertWideRowHistory(ops: DatabaseOperations, width: number, kind: Kind, budget: number | undefined): Promise<void> {
  const table = `w${width}_${kind}_${budget === undefined ? 'nobudget' : 'budget'}`;
  const label = `${width} columns, ${kind}, ${budget === undefined ? 'no undo budget' : 'undo budget'}`;
  const columns = columnsOf(width);
  await ops.executeQuery(kind === 'rowid'
    ? `CREATE TABLE "${table}" (${columns.join(', ')})`
    : `CREATE TABLE "${table}" (${columns[0]} PRIMARY KEY, ${columns.slice(1).join(', ')}) WITHOUT ROWID`);
  const read = () => contents(ops, table, width, kind);
  const expected = (...rows: number[]) => rows.map(row => expectedRow(width, kind, row));

  const imported = await ops.insertRowsWithHistory!(table, [rowData(width, 1), rowData(width, 2)], undefined, budget);
  assert.deepEqual(await read(), expected(1, 2), `${label}: import`);
  const importEntry: ModificationEntry = {
    modificationType: 'row_insert', targetTable: table, description: 'Import', insertedRows: imported
  };
  await ops.undoModification(importEntry);
  assert.deepEqual(await read(), [], `${label}: undo import`);
  await ops.redoModification(importEntry);
  assert.deepEqual(await read(), expected(1, 2), `${label}: redo import`);

  const inserted = await ops.insertRowWithHistory!(table, rowData(width, 3), undefined, budget);
  assert.deepEqual(await read(), expected(1, 2, 3), `${label}: insert`);
  const insertEntry: ModificationEntry = {
    modificationType: 'row_insert', targetTable: table, description: 'Insert',
    targetRowId: inserted.rowId, rowData: inserted.row, insertedRow: inserted
  };
  await ops.undoModification(insertEntry);
  assert.deepEqual(await read(), expected(1, 2), `${label}: undo insert`);
  await ops.redoModification(insertEntry);
  assert.deepEqual(await read(), expected(1, 2, 3), `${label}: redo insert`);

  const rowIds: RecordId[] = [imported[0].rowId, inserted.rowId];
  const deletedRows = await ops.deleteRows(table, rowIds, budget);
  assert.deepEqual(await read(), expected(2), `${label}: delete`);
  const deleteEntry: ModificationEntry = {
    modificationType: 'row_delete', targetTable: table, description: 'Delete', affectedRowIds: rowIds, deletedRows
  };
  await ops.undoModification(deleteEntry);
  assert.deepEqual(await read(), expected(1, 2, 3), `${label}: undo delete`);
  await ops.redoModification(deleteEntry);
  assert.deepEqual(await read(), expected(2), `${label}: redo delete`);
}

// Directories go last: a throwing hook skips the hooks behind it.
const directories: string[] = [];
const disposals: Array<() => void> = [];
after(() => {
  for (const dispose of disposals) dispose();
  for (const directory of directories) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

let wasm: Promise<DatabaseOperations> | undefined;
const openWasm = () => (wasm ??= createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })
  .then(engine => engine.operations!));

let native: Promise<DatabaseOperations | undefined> | undefined;
const openNative = () => (native ??= (async () => {
  if (!await isNativeAvailable(process.cwd())) {
    if (process.env.FUZZ_EXPECT_TARGET) throw new Error(`Missing native runtime for ${process.env.FUZZ_EXPECT_TARGET}`);
    return undefined;
  }
  fs.mkdirSync('.tmp', { recursive: true });
  const directory = fs.mkdtempSync(path.resolve('.tmp/wide-row-history-'));
  directories.push(directory);
  const file = path.join(directory, 'wide.db');
  fs.closeSync(fs.openSync(file, 'w'));
  const connection = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
  disposals.push(() => connection.workerMethods[Symbol.dispose]());
  return (await connection.establishConnection(vscode.Uri.file(file), 'wide.db', false)).databaseOps;
})());

for (const [engine, open] of [['WebAssembly', openWasm], ['native', openNative]] as const) {
  describe(`${engine} row history near SQLite's expression and column limits`, () => {
    for (const width of WIDTHS) {
      for (const kind of KINDS) {
        for (const budget of [BUDGET, undefined]) {
          it(`inserts, deletes, undoes and redoes ${width}-column ${kind} rows ${budget === undefined ? 'without' : 'with'} an undo budget`, async (t: TestContext) => {
            const ops = await open();
            if (!ops) return t.skip('Bundled native runtime unavailable');
            await assertWideRowHistory(ops, width, kind, budget);
          });
        }
      }
    }
  });
}
