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
 * @param signal - Optional cancellation signal used by forward replay
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

  await runInSavepoint(databaseOps, 'sp_restore', async () => {
    // Revert saved entries first to move checkpoint bytes back to the
    // common-prefix state, then replay live entries from that boundary.
    for (const entry of revertSeq) {
      await databaseOps.undoModification(entry);
    }
    if (forward.length > 0) {
      await databaseOps.applyModifications(forward, signal);
    }
  });
}

/**
 * Bring the live database and tracker back to the last saved checkpoint state.
 *
 * Forward entries are undone from the live timeline, then saved-undone entries
 * are re-applied in original application order. The tracker is rolled back only
 * after database mutations commit so a failed revert does not desynchronize the
 * in-memory history from the live database.
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

  await runInSavepoint(databaseOps, 'sp_revert', async () => {
    // Discard live edits first, then re-apply saved entries that the user had
    // undone so the final database bytes match the checkpoint exactly.
    if (forward.length > 0) {
      await databaseOps.discardModifications(forward, signal);
    }
    if (redo.length > 0) {
      await databaseOps.applyModifications(redo, signal);
    }
  });

  tracker.rollbackToCheckpoint();
}

/**
 * Run database mutations inside a SAVEPOINT and roll back all mutations from
 * this helper if any operation in the sequence fails.
 */
async function runInSavepoint(
  databaseOps: DatabaseOperations,
  prefix: string,
  body: () => Promise<void>
): Promise<void> {
  if (typeof databaseOps.executeQuery !== 'function') {
    // Some unit-test doubles only implement the mutation primitive under test.
    // Real DatabaseOperations implementations expose executeQuery and therefore
    // take the atomic SAVEPOINT path below.
    await body();
    return;
  }

  const name = `${prefix}_${Date.now()}`;
  await databaseOps.executeQuery(`SAVEPOINT ${name}`);
  try {
    await body();
    await databaseOps.executeQuery(`RELEASE ${name}`);
  } catch (err) {
    await databaseOps.executeQuery(`ROLLBACK TO ${name}`).catch(() => {});
    await databaseOps.executeQuery(`RELEASE ${name}`).catch(() => {});
    throw err;
  }
}
