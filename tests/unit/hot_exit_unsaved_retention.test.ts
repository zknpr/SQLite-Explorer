import './vscode_mock_setup';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as vscode from 'vscode';
import { HostBridge } from '../../src/hostBridge';
import { createDatabaseEngine } from '../../src/core/sqlite-db';
import { ModificationTracker } from '../../src/core/undo-history';
import { reconcileRestoredDatabase, revertDatabaseToSaved } from '../../src/core/restore-reconciler';
import type { DatabaseOperations, LabeledModification } from '../../src/core/types';

const ROWS = 6;
const MEMORY = 50 * 1024 * 1024;

async function createEngine(): Promise<DatabaseOperations> {
  const result = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
  assert.ok(result.operations, 'database operations should be initialized');
  await result.operations.executeQuery('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
  for (let id = 1; id <= ROWS; id++) {
    await result.operations.executeQuery('INSERT INTO notes VALUES (?, ?)', [id, `saved ${id}`]);
  }
  return result.operations;
}

function createBridge(databaseOperations: DatabaseOperations, tracker: ModificationTracker<LabeledModification>): HostBridge {
  const document = {
    uri: vscode.Uri.parse('file:///hot-exit-retention.db'),
    documentKey: Promise.resolve('hot-exit-retention'),
    databaseOperations,
    isReadOnlyMode: false,
    recordExternalModification: (modification: LabeledModification) => tracker.record(modification)
  };
  const provider = {
    webviews: new Map(),
    context: { globalState: { update: () => Promise.resolve() } },
    isReadOnly: false
  };
  return new HostBridge(provider as any, document as any);
}

async function bodies(databaseOperations: DatabaseOperations): Promise<unknown[]> {
  const result = await databaseOperations.executeQuery('SELECT body FROM notes ORDER BY id');
  return result[0].rows.map(row => row[0]);
}

/** One unsaved cell edit per row, more edits than the tracker's entry limit. */
async function editEveryRow(bridge: HostBridge): Promise<string[]> {
  const edited: string[] = [];
  for (let id = 1; id <= ROWS; id++) {
    await bridge.updateCellBatch(
      'notes',
      [{ rowId: id, column: 'body', value: `edited ${id}`, operation: 'set' }],
      'Edit note'
    );
    edited.push(`edited ${id}`);
  }
  return edited;
}

describe('unsaved history that a WebAssembly hot-exit restore must replay', () => {
  it('restores every unsaved edit when there are more of them than the entry limit', async () => {
    const live = await createEngine();
    const tracker = new ModificationTracker<LabeledModification>(3, MEMORY);
    tracker.pinUncommittedEntries(true);
    const edited = await editEveryRow(createBridge(live, tracker));
    assert.deepStrictEqual(await bodies(live), edited);

    // Hot exit keeps only the tracker; the file still holds the saved rows.
    const restored = ModificationTracker.deserialize<LabeledModification>(tracker.serialize(), 3, MEMORY);
    restored.pinUncommittedEntries(true);
    const reopened = await createEngine();
    await reconcileRestoredDatabase(reopened, restored, 'wasm');

    assert.deepStrictEqual(await bodies(reopened), edited);
  });

  it('reverts every unsaved edit when there are more of them than the entry limit', async () => {
    const live = await createEngine();
    const saved = await bodies(live);
    const tracker = new ModificationTracker<LabeledModification>(3, MEMORY);
    tracker.pinUncommittedEntries(true);
    await editEveryRow(createBridge(live, tracker));

    await revertDatabaseToSaved(live, tracker);

    assert.deepStrictEqual(await bodies(live), saved);
    assert.strictEqual(tracker.hasUncommittedChanges(), false);
  });

  it('evicts saved entries first and keeps the unsaved ones that follow', async () => {
    const live = await createEngine();
    const tracker = new ModificationTracker<LabeledModification>(3, MEMORY);
    tracker.pinUncommittedEntries(true);
    const bridge = createBridge(live, tracker);
    await bridge.updateCellBatch('notes', [{ rowId: 1, column: 'body', value: 'first', operation: 'set' }], 'Edit note');
    await tracker.createCheckpoint();
    const edited = await editEveryRow(bridge);

    assert.strictEqual(tracker.getUncommittedEntries().length, ROWS);
    await revertDatabaseToSaved(live, tracker);
    assert.deepStrictEqual(await bodies(live), ['first', ...edited.slice(1).map((_, index) => `saved ${index + 2}`)]);
  });

  it('keeps evicting unsaved entries when they are not pinned, as the native engine needs', async () => {
    const tracker = new ModificationTracker<LabeledModification>(3, MEMORY);
    await editEveryRow(createBridge(await createEngine(), tracker));
    assert.strictEqual(tracker.getUncommittedEntries().length, 3);
    assert.doesNotThrow(() => tracker.ensureCanRecord());
  });

  it('asks for a save once pinned unsaved history reaches the memory limit, and accepts edits after it', async () => {
    const live = await createEngine();
    // Room for a few of these small edits, not for all six.
    const tracker = new ModificationTracker<LabeledModification>(100, 2500);
    tracker.pinUncommittedEntries(true);
    const bridge = createBridge(live, tracker);
    let accepted = 0;
    for (let id = 1; id <= ROWS; id++) {
      try {
        tracker.ensureCanRecord();
      } catch (error) {
        assert.match((error as Error).message, /Save the database before making more changes/);
        break;
      }
      await bridge.updateCellBatch('notes', [{ rowId: id, column: 'body', value: `edited ${id}`, operation: 'set' }], 'Edit note');
      accepted++;
    }
    assert.ok(accepted >= 1 && accepted < ROWS, `expected the limit to stop some edits, accepted ${accepted}`);
    assert.strictEqual(tracker.isHistoryRecordingBlockedByUncommittedLimit, true);
    // Everything recorded before the stop is still there to replay.
    assert.strictEqual(tracker.getUncommittedEntries().length, accepted);

    await tracker.createCheckpoint();
    assert.strictEqual(tracker.isHistoryRecordingBlockedByUncommittedLimit, false);
    assert.doesNotThrow(() => tracker.ensureCanRecord());
  });

  it('accepts a new edit after an undo leaves the unsaved entries under the limit', async () => {
    const live = await createEngine();
    const tracker = new ModificationTracker<LabeledModification>(100, 2500);
    tracker.pinUncommittedEntries(true);
    const bridge = createBridge(live, tracker);
    let id = 1;
    while (!tracker.isHistoryRecordingBlockedByUncommittedLimit) {
      await bridge.updateCellBatch('notes', [{ rowId: id, column: 'body', value: `edited ${id}`, operation: 'set' }], 'Edit note');
      id++;
    }
    // The undone entry moves to redo history, which the next edit discards.
    assert.ok(tracker.stepBack());
    assert.strictEqual(tracker.isHistoryRecordingBlockedByUncommittedLimit, false);
    assert.doesNotThrow(() => tracker.ensureCanRecord());
  });
});
