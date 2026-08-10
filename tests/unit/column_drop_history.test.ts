import './vscode_mock_setup';
import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  assertColumnDropHistoryFitsUndoBudget,
  buildColumnDropHistorySizePreflight
} from '../../src/core/column-drop';
import { createDatabaseEngine } from '../../src/core/sqlite-db';

describe('column-drop undo history preflight', () => {
  it('chunks escaped metadata-only aggregates at bounded SQL width', () => {
    const columns = Array.from({ length: 130 }, (_, index) => (
      index === 0 ? 'value"x' : `value_${index}`
    ));
    const preflight = buildColumnDropHistorySizePreflight(
      'odd" table',
      columns,
      { kind: 'rowid' }
    );

    assert.strictEqual(preflight.queries.filter(query => query.kind === 'values').length, 3);
    assert.strictEqual(preflight.queries.filter(query => query.kind === 'identity').length, 1);
    assert.match(preflight.queries[0].sql, /FROM "odd"" table"/);
    assert.match(preflight.queries[0].sql, /typeof\("value""x"\)/);
    assert.doesNotMatch(preflight.queries[0].sql, /^SELECT\s+"value/i);
  });

  it('counts each row identity and entry shape once per dropped column', () => {
    const preflight = buildColumnDropHistorySizePreflight(
      'items',
      ['left', 'right'],
      { kind: 'rowid' }
    );
    const input = {
      table: 'items',
      droppedColumnCount: 2,
      preflight,
      resultRows: [[1, 10], [1, 8]],
      maxSnapshotBytes: 82
    };

    assert.doesNotThrow(() => assertColumnDropHistoryFitsUndoBudget(input));
    assert.throws(
      () => assertColumnDropHistoryFitsUndoBudget({ ...input, maxSnapshotBytes: 81 }),
      /Column-drop undo snapshot exceeds the 81-byte memory budget/i
    );
  });

  it('reserves every composite-key member in the encoded identity', () => {
    const preflight = buildColumnDropHistorySizePreflight(
      'items',
      ['payload'],
      {
        kind: 'primaryKey',
        columns: [
          { identifier: 'tenant', declaredType: 'TEXT', position: 1 },
          { identifier: 'sequence', declaredType: 'BLOB', position: 2 }
        ]
      }
    );
    const exactBound = preflight.primaryKeyStaticIdentityBytes + 4 + 28;

    assert.ok(preflight.primaryKeyStaticIdentityBytes > 0);
    assert.match(
      preflight.queries.find(query => query.kind === 'identity')?.sql ?? '',
      /typeof\("tenant"\).*typeof\("sequence"\)/
    );
    assert.doesNotThrow(() => assertColumnDropHistoryFitsUndoBudget({
      table: 'items',
      droppedColumnCount: 1,
      preflight,
      resultRows: [[1, 0], [1, 4]],
      maxSnapshotBytes: exactBound
    }));
  });

  it('rejects unsafe or incomplete SQLite aggregate metadata', () => {
    const preflight = buildColumnDropHistorySizePreflight(
      'items',
      ['payload'],
      { kind: 'rowid' }
    );
    assert.throws(
      () => assertColumnDropHistoryFitsUndoBudget({
        table: 'items',
        droppedColumnCount: 1,
        preflight,
        resultRows: [[1, Number.MAX_SAFE_INTEGER + 1], [1, 8]],
        maxSnapshotBytes: 1024
      }),
      /unsafe byte count/i
    );
    assert.throws(
      () => assertColumnDropHistoryFitsUndoBudget({
        table: 'items',
        droppedColumnCount: 1,
        preflight,
        resultRows: [[1, 1]],
        maxSnapshotBytes: 1024
      }),
      /incomplete column-drop undo preflight metadata/i
    );
  });

  it('executes the metadata aggregates against the bundled WASM SQLite', async () => {
    const opened = await createDatabaseEngine({ content: null, maxSize: 0 });
    const engine = opened.operations!;
    try {
      await engine.executeQuery(
        'CREATE TABLE aggregate_drop (' +
        'tenant TEXT, sequence BLOB, payload TEXT, ' +
        'PRIMARY KEY (tenant, sequence)) WITHOUT ROWID; ' +
        "INSERT INTO aggregate_drop VALUES ('north', X'0102', char(0) || 'quoted\"'), " +
        "('south', X'0304', 'plain')"
      );
      const preflight = buildColumnDropHistorySizePreflight(
        'aggregate_drop',
        ['payload'],
        {
          kind: 'primaryKey',
          columns: [
            { identifier: 'tenant', declaredType: 'TEXT', position: 1 },
            { identifier: 'sequence', declaredType: 'BLOB', position: 2 }
          ]
        }
      );
      const resultRows: Array<readonly unknown[] | undefined> = [];
      for (const query of preflight.queries) {
        const result = await engine.executeQuery(query.sql, query.params);
        resultRows.push(result[0]?.rows[0]);
      }

      assert.ok(resultRows.every(row => row?.[0] === 2));
      assert.doesNotThrow(() => assertColumnDropHistoryFitsUndoBudget({
        table: 'aggregate_drop',
        droppedColumnCount: 1,
        preflight,
        resultRows,
        maxSnapshotBytes: 1024 * 1024
      }));
    } finally {
      (engine as typeof engine & { shutdown?: () => void }).shutdown?.();
    }
  });
});
