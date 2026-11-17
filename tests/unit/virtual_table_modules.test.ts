import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  findTablesWithMissingModules,
  MAX_MODULE_CHECK_NAME_BYTES,
  MAX_MODULE_CHECK_TABLES,
  WASM_ONLY_VIRTUAL_TABLE_MODULES,
  type ModuleCheckAdapter
} from '../../src/core/virtual-table-modules';

function countingAdapter(
  candidates: readonly unknown[],
  errors: (statements: readonly string[]) => readonly (string | undefined)[] = statements => statements.map(() => undefined)
) {
  const calls = { queries: [] as string[], compiles: [] as (readonly string[])[] };
  const adapter: ModuleCheckAdapter = {
    queryRows: async sql => { calls.queries.push(sql); return candidates.map(name => [name]); },
    compileStatements: async statements => { calls.compiles.push(statements); return errors(statements); }
  };
  return { adapter, calls };
}

describe('findTablesWithMissingModules', () => {
  it('costs a schema without candidates one query and no prepares', async () => {
    const { adapter, calls } = countingAdapter([]);
    assert.deepStrictEqual(await findTablesWithMissingModules(adapter, WASM_ONLY_VIRTUAL_TABLE_MODULES), { checked: true, tables: [] });
    assert.strictEqual(calls.queries.length, 1);
    assert.match(calls.queries[0], /FROM main\.sqlite_schema WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'/);
    assert.match(calls.queries[0], new RegExp(`LIMIT ${MAX_MODULE_CHECK_TABLES + 1}$`));
    assert.match(calls.queries[0], new RegExp(`length\\(CAST\\(name AS BLOB\\)\\) <= ${MAX_MODULE_CHECK_NAME_BYTES}`));
    assert.deepStrictEqual(calls.compiles, []);
  });

  it('prepares nothing past the table cap or for an over-long name', async () => {
    for (const candidates of [
      Array.from({ length: MAX_MODULE_CHECK_TABLES + 1 }, (_, index) => `t${index}`),
      ['ok', null]
    ]) {
      const { adapter, calls } = countingAdapter(candidates);
      const result = await findTablesWithMissingModules(adapter, WASM_ONLY_VIRTUAL_TABLE_MODULES);
      assert.strictEqual(result.checked, false);
      assert.deepStrictEqual(calls.compiles, []);
    }
  });

  it('counts only SQLite\'s exact "no such module" for a listed module, in any ASCII case', async () => {
    const tables = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const errors = [
      'no such module: FtS4',
      'no such module: a; no such module: fts4',
      'vtable constructor failed: no such module: fts4',
      'no such module: fts5',
      'no such module: ftſ4',
      undefined,
      'no such module: fts3tokenize',
      'no such table: main.h'
    ];
    const { adapter, calls } = countingAdapter(tables, () => errors);
    assert.deepStrictEqual(await findTablesWithMissingModules(adapter, WASM_ONLY_VIRTUAL_TABLE_MODULES), {
      checked: true,
      tables: [{ table: 'a', module: 'fts4' }, { table: 'g', module: 'fts3tokenize' }]
    });
    assert.deepStrictEqual(calls.compiles, [tables.map(table => `EXPLAIN SELECT 1 FROM main."${table}"`)]);
  });

  it('answers "not checked" when the file was locked, whatever it learned about the tables before', async () => {
    const { adapter } = countingAdapter(['a', 'b', 'c'], () => ['no such module: fts4', 'database is locked', 'database is locked']);
    const result = await findTablesWithMissingModules(adapter, WASM_ONLY_VIRTUAL_TABLE_MODULES);
    assert.strictEqual(result.checked, false);
    // A name in the schema can put those words into another message, which is not a lock.
    const named = countingAdapter(['a'], () => ['no such table: main.database is locked']);
    assert.deepStrictEqual(await findTablesWithMissingModules(named.adapter, WASM_ONLY_VIRTUAL_TABLE_MODULES), { checked: true, tables: [] });
  });

  it('quotes candidate names and rejects an incomplete or malformed answer', async () => {
    const { adapter, calls } = countingAdapter(['we"ird']);
    await findTablesWithMissingModules(adapter, WASM_ONLY_VIRTUAL_TABLE_MODULES);
    assert.deepStrictEqual(calls.compiles, [['EXPLAIN SELECT 1 FROM main."we""ird"']]);
    await assert.rejects(
      findTablesWithMissingModules(countingAdapter(['a', 'b'], () => [undefined]).adapter, WASM_ONLY_VIRTUAL_TABLE_MODULES),
      /incomplete result set/
    );
    await assert.rejects(
      findTablesWithMissingModules(countingAdapter([42]).adapter, WASM_ONLY_VIRTUAL_TABLE_MODULES),
      /invalid schema metadata/
    );
  });
});
