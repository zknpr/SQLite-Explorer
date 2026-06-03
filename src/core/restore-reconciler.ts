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
 * Known limitation (tracked in #425, addressed in a dedicated follow-up): the
 * "branch" case — undo a saved edit, then record a NEW edit — is not reconstructed
 * here. record() clears the redo stack and the index-based checkpoint cannot
 * describe the resulting divergence, so reopen yields the saved state rather than
 * the branched one. Fixing it requires a checkpoint-model redesign.
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

  const forward = tracker.getUncommittedEntries();
  if (forward.length > 0) {
    await databaseOps.applyModifications(forward, signal);
    return;
  }

  for (const entry of tracker.getEntriesUndoneSinceCheckpoint()) {
    await databaseOps.undoModification(entry);
  }
}
