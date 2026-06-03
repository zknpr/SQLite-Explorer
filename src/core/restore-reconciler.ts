import type { DatabaseOperations, LabeledModification } from './types';
import type { ModificationTracker } from './undo-history';

/**
 * Bring a freshly opened database to the live timeline state after hot-exit restore.
 *
 * WASM restore opens the database bytes from the saved checkpoint, so the database
 * must either replay entries that were recorded after that checkpoint or revert
 * entries that were saved and then undone before shutdown. Native SQLite writes
 * edits and undos directly to the on-disk file, so the opened database is already
 * at the live state and only the tracker needs to retain redo state.
 *
 * @param databaseOps - Database operation facade for the restored database
 * @param tracker - Deserialized hot-exit modification tracker
 * @param engineKind - Active database engine type
 * @param signal - Optional cancellation signal checked between revert/replay steps
 */
export async function reconcileRestoredDatabase(
  databaseOps: DatabaseOperations,
  tracker: ModificationTracker<LabeledModification>,
  engineKind: 'wasm' | 'native',
  signal?: AbortSignal
): Promise<void> {
  if (engineKind === 'native') {
    return;
  }

  const revertSeq = tracker.getCheckpointRevertSequence();
  const forward = tracker.getUncommittedEntries();
  if (revertSeq.length === 0 && forward.length === 0) {
    return;
  }

  // Revert saved-then-undone entries first to move the restored bytes back to
  // the common-prefix state, then replay the live entries from that boundary.
  //
  // Each engine operation is individually atomic (it opens its own
  // transaction). We deliberately do NOT wrap the sequence in an outer
  // SAVEPOINT: row/column undos (`undoRowDelete` -> `insertRowBatch`,
  // `undoColumnDrop`) issue their own `BEGIN TRANSACTION`, which SQLite rejects
  // while an outer transaction is open — wrapping them would break restoring
  // deleted rows/columns entirely. A mid-sequence failure instead propagates to
  // the caller (`DatabaseDocument.create`), which opens the document read-only
  // and re-restores from the unchanged backup on the next open.
  for (const entry of revertSeq) {
    signal?.throwIfAborted();
    await databaseOps.undoModification(entry);
  }
  if (forward.length > 0) {
    await databaseOps.applyModifications(forward, signal);
  }
}

/**
 * Bring the live database and tracker back to the last saved checkpoint state.
 *
 * Forward entries are undone from the live timeline, then saved-undone entries
 * are re-applied in original application order. The tracker is rolled back only
 * after the database mutations succeed so a failed revert does not desynchronize
 * the in-memory history from the live database.
 *
 * @param databaseOps - Database operation facade for the open database
 * @param tracker - Modification tracker for the open document
 * @param signal - Optional cancellation signal used by replay/discard helpers
 */
export async function revertDatabaseToSaved(
  databaseOps: DatabaseOperations,
  tracker: ModificationTracker<LabeledModification>,
  signal?: AbortSignal
): Promise<void> {
  const forward = tracker.getUncommittedEntries();
  const redo = [...tracker.getCheckpointRevertSequence()].reverse();

  if (forward.length === 0 && redo.length === 0) {
    tracker.rollbackToCheckpoint();
    return;
  }

  // Discard live edits first, then re-apply the saved entries the user had
  // undone so the final database matches the checkpoint.
  //
  // Re-apply via `redoModification`, NOT `applyModifications`: the native engine
  // implements replay in `redoModification` and treats `applyModifications` as a
  // no-op (`src/nativeWorker.ts`), so using `applyModifications` here would
  // silently leave a native database at the undone state while the tracker is
  // marked clean. As in restore, the sequence is per-operation atomic rather
  // than wrapped in a SAVEPOINT (row/column undos open their own transaction).
  if (forward.length > 0) {
    await databaseOps.discardModifications(forward, signal);
  }
  for (const entry of redo) {
    signal?.throwIfAborted();
    await databaseOps.redoModification(entry);
  }

  // Roll the tracker back to the checkpoint only after the database mutations
  // succeed, so a failed revert does not desynchronize history from the data.
  tracker.rollbackToCheckpoint();
}
