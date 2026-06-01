import './vscode_mock_setup';
import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert';
import * as vscode from 'vscode';
import { HostBridge } from '../../src/hostBridge';
import { createDatabaseEngine } from '../../src/core/sqlite-db';
import type { DatabaseOperations, LabeledModification, ModificationEntry } from '../../src/core/types';

function createRecordingBridge(
  databaseOperations: DatabaseOperations,
  recorded: LabeledModification[]
): HostBridge {
  const document = {
    uri: vscode.Uri.parse('file:///hot-exit-replay.db'),
    documentKey: Promise.resolve('hot-exit-replay'),
    databaseOperations,
    isReadOnlyMode: false,
    recordExternalModification: (modification: LabeledModification) => {
      recorded.push(modification);
    }
  };
  const provider = {
    webviews: new Map(),
    context: { globalState: { update: () => Promise.resolve() } },
    isReadOnly: false
  };

  return new HostBridge(provider as any, document as any);
}

async function createEngine(): Promise<DatabaseOperations> {
  const result = await createDatabaseEngine({
    content: null,
    maxSize: 0,
    readOnlyMode: false
  });
  assert.ok(result.operations, 'database operations should be initialized');

  return result.operations;
}

describe('hot-exit restore forward replay', () => {
  afterEach(() => {
    mock.reset();
  });

  it('round-trips recorded json_patch batch cells as merge patches', async () => {
    const originalJson = JSON.stringify({
      keep: true,
      nested: { before: 1 },
      remove: 'old'
    });
    const patchJson = JSON.stringify({
      nested: { after: 2 },
      remove: null,
      added: 3
    });
    const expectedJson = {
      keep: true,
      nested: { before: 1, after: 2 },
      added: 3
    };

    const writer = await createEngine();
    await writer.executeQuery('CREATE TABLE patch_docs (id INTEGER PRIMARY KEY, content TEXT)');
    await writer.insertRow('patch_docs', { id: 1, content: originalJson });

    const recorded: LabeledModification[] = [];
    const bridge = createRecordingBridge(writer, recorded);

    await bridge.updateCellBatch(
      'patch_docs',
      [{ rowId: 1, column: 'content', value: patchJson, operation: 'json_patch' }],
      'Patch JSON'
    );

    assert.strictEqual(recorded.length, 1);

    const replay = await createEngine();
    await replay.executeQuery('CREATE TABLE patch_docs (id INTEGER PRIMARY KEY, content TEXT)');
    await replay.insertRow('patch_docs', { id: 1, content: originalJson });

    await replay.applyModifications([recorded[0]]);

    const result = await replay.executeQuery('SELECT content FROM patch_docs WHERE id = 1');
    assert.deepStrictEqual(JSON.parse(result[0].rows[0][0] as string), expectedJson);
    assert.strictEqual(recorded[0].affectedCells?.[0].operation, 'json_patch');
  });

  it('replays column_drop history with dependent indexes dropped first', async () => {
    const writer = await createEngine();
    await writer.executeQuery('CREATE TABLE indexed_docs (id INTEGER PRIMARY KEY, payload TEXT, keep TEXT)');
    await writer.executeQuery('CREATE INDEX idx_indexed_docs_payload ON indexed_docs(payload)');
    await writer.insertRow('indexed_docs', { id: 1, payload: 'drop me', keep: 'keep me' });

    mock.method(
      vscode.window,
      'showWarningMessage',
      async (_message: string, _options: unknown, continueButton: unknown) => continueButton
    );

    const recorded: LabeledModification[] = [];
    const bridge = createRecordingBridge(writer, recorded);

    await bridge.deleteColumns('indexed_docs', ['payload']);

    assert.strictEqual(recorded.length, 1);

    const replay = await createEngine();
    await replay.executeQuery('CREATE TABLE indexed_docs (id INTEGER PRIMARY KEY, payload TEXT, keep TEXT)');
    await replay.executeQuery('CREATE INDEX idx_indexed_docs_payload ON indexed_docs(payload)');
    await replay.insertRow('indexed_docs', { id: 1, payload: 'drop me', keep: 'keep me' });

    await replay.applyModifications([recorded[0]]);

    const columns = await replay.getTableInfo('indexed_docs');
    assert.deepStrictEqual(columns.map(column => column.identifier), ['id', 'keep']);

    const indexes = await replay.executeQuery(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'indexed_docs'"
    );
    assert.deepStrictEqual(indexes[0]?.rows ?? [], []);
    assert.deepStrictEqual(recorded[0].droppedIndexes, ['idx_indexed_docs_payload']);
  });

  it('rolls back all replayed entries when strict restore hits a malformed entry', async () => {
    const engine = await createEngine();
    await engine.executeQuery('CREATE TABLE atomic_restore (id INTEGER PRIMARY KEY, name TEXT)');

    const modifications: ModificationEntry[] = [
      {
        description: 'Insert draft row',
        modificationType: 'row_insert',
        targetTable: 'atomic_restore',
        targetRowId: 1,
        rowData: { name: 'Draft' }
      },
      {
        description: 'Malformed cell update',
        modificationType: 'cell_update',
        targetTable: 'atomic_restore'
      }
    ];

    await assert.rejects(
      () => engine.applyModifications(modifications),
      /Cannot apply cell_update: missing target cell or affected cells/
    );

    const result = await engine.executeQuery('SELECT COUNT(*) FROM atomic_restore');
    assert.strictEqual(result[0].rows[0][0], 0);
  });
});
