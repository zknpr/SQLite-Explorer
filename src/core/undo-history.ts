/**
 * Modification Tracker Module
 *
 * Tracks database modifications for undo/redo functionality.
 * Supports serialization for VS Code hot exit backup.
 */

import type { LabeledModification } from './types';
import {
  decodeJsonSafeNumberString,
  encodeJsonSafeNonFiniteNumber,
  escapeJsonSafeNumberString
} from './json-safe-numbers';

// ============================================================================
// JSON Serialization Helpers for Non-JSON Cell Values
// ============================================================================

/**
 * JSON replacer function that handles Uint8Array and BigInt serialization.
 * Converts non-JSON cell values to marker objects that can be restored.
 *
 * IMPORTANT: Standard JSON.stringify corrupts Uint8Array by converting it
 * to an object like {"0": 1, "1": 2, ...} which loses the type information.
 * This replacer preserves the binary data as base64.
 */
function binaryReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return encodeJsonSafeNonFiniteNumber(value);
  }
  if (typeof value === 'string') return escapeJsonSafeNumberString(value);
  if (typeof value === 'bigint') {
    return { __type: 'BigInt', text: value.toString() };
  }
  if (value instanceof Uint8Array) {
    // Convert to base64 with a type marker for restoration
    // Use Buffer in Node.js environment for efficiency
    const base64 = typeof Buffer !== 'undefined'
      ? Buffer.from(value).toString('base64')
      : btoa(String.fromCharCode(...value));
    return { __type: 'Uint8Array', data: base64 };
  }
  return value;
}

/**
 * JSON reviver function that restores Uint8Array from serialized format.
 * Converts the special object format back to Uint8Array.
 */
function binaryReviver(_key: string, value: unknown): unknown {
  if (typeof value === 'string') return decodeJsonSafeNumberString(value);
  if (value && typeof value === 'object' && '__type' in value) {
    const typed = value as { __type: string; data?: unknown; text?: unknown };
    const keys = Object.keys(value);
    if (
      typed.__type === 'BigInt' &&
      typeof typed.text === 'string' &&
      keys.length === 2 &&
      keys.includes('__type') &&
      keys.includes('text')
    ) {
      return BigInt(typed.text);
    }
    if (
      typed.__type === 'Uint8Array' &&
      typeof typed.data === 'string' &&
      keys.length === 2 &&
      keys.includes('__type') &&
      keys.includes('data')
    ) {
      // Restore from base64
      if (typeof Buffer !== 'undefined') {
        return new Uint8Array(Buffer.from(typed.data as string, 'base64'));
      } else {
        const binary = atob(typed.data as string);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
      }
    }
  }
  return value;
}

/**
 * Estimate memory size of a value in bytes.
 *
 * Counts primitive sizes and structural overhead.
 * Handles circular references by tracking seen objects.
 */
export function estimateUndoMemoryBytes(value: unknown): number {
  const seen = new Set<unknown>();
  const stack = [value];
  let size = 0;

  while (stack.length > 0) {
    const current = stack.pop();

    if (current === null || current === undefined) {
      continue;
    }

    if (typeof current === 'boolean') {
      size += 4;
    } else if (typeof current === 'number' || typeof current === 'bigint') {
      size += 8;
    } else if (typeof current === 'string') {
      size += current.length * 2;
    } else if (current instanceof Uint8Array) {
      size += current.byteLength;
    } else if (typeof current === 'object') {
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);

      // Overhead for object/array
      size += 8;

      if (Array.isArray(current)) {
        for (const item of current) {
          stack.push(item);
        }
      } else {
        // Plain object
        for (const key in current) {
          if (Object.prototype.hasOwnProperty.call(current, key)) {
            size += key.length * 2;
            stack.push((current as Record<string, unknown>)[key]);
          }
        }
      }
    }
  }
  return size;
}

// ============================================================================
// Tracker State
// ============================================================================

/**
 * Internal state for tracking modification history.
 */
interface TrackerState<T> {
  /** All recorded modifications */
  timeline: T[];
  /** Modifications that were undone (for redo) */
  futureStack: T[];
  /** Index marking the saved state */
  checkpointIndex: number;
  /** Maximum entries to retain */
  maxEntries: number;
}

// ============================================================================
// Modification Tracker Implementation
// ============================================================================

/**
 * Tracks database modifications with undo/redo support.
 *
 * The tracker maintains a timeline of modifications that can be
 * navigated backward (undo) and forward (redo). When a new modification
 * is added after undo operations, the redo history is discarded.
 *
 * @typeParam T - Modification entry type with label
 */
export class ModificationTracker<T extends LabeledModification = LabeledModification> {
  private timeline: T[] = [];
  private timelineSizes: number[] = [];
  /** Number of entries that were evicted from the front of the retained timeline. */
  private timelineOffset: number = 0;

  private futureStack: T[] = [];
  private futureStackSizes: number[] = [];
  /**
   * Saved entries that were undone and then removed from redo history by a new
   * branch edit. They are stored in database revert order so hot-exit restore
   * can move checkpoint bytes back to the common-prefix state before replaying
   * live forward edits.
   */
  private revertOnRestore: T[] = [];
  /**
   * Memory sizes for entries stored in revertOnRestore. These entries remain
   * counted in currentSize because they are still required for restore/revert
   * correctness even after they leave futureStack.
   */
  private revertOnRestoreSizes: number[] = [];

  private checkpointIndex: number = 0;
  private maxEntries: number;
  private maxMemory: number;
  private currentSize: number = 0;
  /** Further edits must wait for Save once an unsaved barrier segment reaches a limit. */
  private historyRecordingBlockedByBarrierLimit: boolean = false;
  /** Monotonic counter advanced whenever the undo/redo history changes. */
  private mutationRevision: number = 0;
  /** Monotonic counter advanced when older checkpoint positions may no longer name the same saved state. */
  private checkpointInvalidationRevision: number = 0;

  /**
   * Create a new modification tracker.
   *
   * @param maxEntries - Maximum number of modifications to track
   * @param maxMemory - Maximum memory usage in bytes (default 50MB)
   */
  constructor(maxEntries: number = 100, maxMemory: number = 50 * 1024 * 1024) {
    this.maxEntries = maxEntries;
    this.maxMemory = maxMemory;
  }

  /** Memory ceiling used by producers that must preflight before allocation. */
  get memoryLimitBytes(): number {
    return this.maxMemory;
  }

  /** Fail before a backend mutation when retaining its forward replay would exceed the cap. */
  ensureCanRecord(): void {
    if (!this.historyRecordingBlockedByBarrierLimit) return;
    throw new Error(
      'Undo history reached its configured limit after a forward-only edit. '
      + 'Save the database before making more changes.'
    );
  }

  /** True while another edit would make the replay-complete barrier segment unbounded. */
  get isHistoryRecordingBlockedByBarrierLimit(): boolean {
    return this.historyRecordingBlockedByBarrierLimit;
  }

  /**
   * Record that the undo/redo history changed.
   */
  private advanceMutationRevision(): void {
    this.mutationRevision++;
  }

  /**
   * Record that a previously captured checkpoint position may no longer be safe.
   *
   * Undo, rollback, and eviction remove or shift retained timeline entries. A
   * later save must not clamp an older absolute position onto the shortened
   * timeline because that can mark bytes as clean that are no longer the live
   * in-memory state.
   */
  private invalidateCapturedCheckpointPositions(): void {
    this.advanceMutationRevision();
    this.checkpointInvalidationRevision++;
  }

  /**
   * Record a new modification.
   *
   * Discards any future modifications (redo history) since
   * we're creating a new timeline branch.
   *
   * @param entry - Modification to record
   */
  record(entry: T): void {
    if (entry.undoPolicy === 'barrier') {
      this.recordBarrier(entry);
      return;
    }
    this.recordEntry(entry);
  }

  /** Add an entry using the shared branching, retention, and checkpoint rules. */
  private recordEntry(entry: T): void {
    this.ensureCanRecord();
    this.advanceMutationRevision();

    // Calculate size of new entry
    const entrySize = estimateUndoMemoryBytes(entry);

    const savedUndoneCount = this.checkpointIndex - this.timeline.length;
    if (savedUndoneCount > 0) {
      const start = Math.max(0, this.futureStack.length - savedUndoneCount);
      this.revertOnRestore.push(...this.futureStack.slice(start));
      this.revertOnRestoreSizes.push(...this.futureStackSizes.slice(start));

      // Captured entries remain necessary for restore, so leave their memory in
      // currentSize and trim futureStack down to only redo entries that the new
      // branch truly discards.
      this.futureStack = this.futureStack.slice(0, start);
      this.futureStackSizes = this.futureStackSizes.slice(0, start);
      this.checkpointIndex = this.timeline.length;

      // Intentionally do NOT invalidate captured save positions here. Any
      // in-flight save that predates this undo+branch was already invalidated by
      // stepBack() (line ~285); a save that started *after* the undo is writing
      // exactly this common-prefix state, so it must be allowed to commit its
      // checkpoint — createCheckpointAt() then clears revertOnRestore to match
      // the bytes now on disk. Invalidating here would make save() skip that
      // checkpoint and leave revertOnRestore describing the pre-save state,
      // desyncing File>Revert and hot-exit restore from the saved file
      // (Codex P2, #434).
    }

    // Subtract size of redo history that we are about to discard
    const redoSize = this.futureStackSizes.reduce((a, b) => a + b, 0);
    this.currentSize -= redoSize;

    // Discard redo history
    this.futureStack = [];
    this.futureStackSizes = [];

    // Add new entry
    this.timeline.push(entry);
    this.timelineSizes.push(entrySize);
    this.currentSize += entrySize;

    this.enforceRetentionLimits();
  }

  /** Apply ordinary eviction, or saturate an unsaved replay-complete barrier segment. */
  private enforceRetentionLimits(): void {
    // Remove oldest entries until within both limits. An unsaved barrier and
    // every entry after it are one indivisible forward-replay segment: dropping
    // only part would make hot-exit restore silently lose database changes.
    while (
      (this.timeline.length > 0) &&
      (this.timeline.length > this.maxEntries || this.currentSize > this.maxMemory)
    ) {
      // Preserve the existing guarantee that even an individually oversized
      // edit remains available as the sole undo entry.
      if (this.timeline.length === 1) {
        break;
      }

      // History replay is ordered: retaining a barrier while evicting entries
      // after it would create a non-contiguous replay and silently lose later
      // edits. Once an unsaved barrier reaches the front, pin the complete
      // uncommitted segment until a save establishes a new checkpoint.
      if (this.checkpointIndex === 0 && this.hasUncommittedHistoryBarrier) {
        break;
      }

      const removedEntrySize = this.timelineSizes.shift();
      this.timeline.shift();

      if (removedEntrySize !== undefined) {
        this.currentSize -= removedEntrySize;
      }

      this.checkpointIndex = Math.max(0, this.checkpointIndex - 1);
      this.timelineOffset++;
      this.invalidateCapturedCheckpointPositions();
    }

    // At equality the *next* entry would cross the cap. Stop before that entry's
    // backend write; the threshold-crossing entry itself remains fully retained.
    this.historyRecordingBlockedByBarrierLimit =
      this.checkpointIndex === 0
      && this.hasUncommittedHistoryBarrier
      && (
        this.timeline.length >= this.maxEntries
        || this.currentSize >= this.maxMemory
      );
  }

  /**
   * Insert a bounded, forward-replayable barrier into the current timeline.
   * Earlier entries remain available to hot-exit/revert reconciliation but are
   * no longer reachable through Undo. Recording the barrier also applies the
   * normal branch rule, so stale redo entries are discarded.
   */
  recordBarrier(entry: T): void {
    if (entry.undoPolicy !== 'barrier') {
      throw new Error('A history barrier entry must declare undoPolicy="barrier"');
    }
    this.recordEntry(entry);
  }

  /**
   * Step backward in timeline (undo).
   *
   * @returns The modification that was undone, or undefined if at beginning
   */
  stepBack(): T | undefined {
    if (this.timeline.at(-1)?.undoPolicy === 'barrier') return undefined;
    const entry = this.timeline.pop();
    const size = this.timelineSizes.pop();

    if (entry) {
      this.futureStack.push(entry);
      this.futureStackSizes.push(size || 0);
      // currentSize doesn't change as entry just moves from timeline to futureStack
      this.invalidateCapturedCheckpointPositions();
    }
    return entry;
  }

  /**
   * Step forward in timeline (redo).
   *
   * @returns The modification to reapply, or undefined if at end
   */
  stepForward(): T | undefined {
    const entry = this.futureStack.pop();
    const size = this.futureStackSizes.pop();

    if (entry) {
      this.timeline.push(entry);
      this.timelineSizes.push(size || 0);
      // currentSize doesn't change as entry just moves from futureStack to timeline
      this.advanceMutationRevision();
    }
    return entry;
  }

  /**
   * Check if there are uncommitted modifications.
   *
   * @returns True if timeline differs from checkpoint
   */
  hasUncommittedChanges(): boolean {
    return this.timeline.length !== this.checkpointIndex || this.revertOnRestore.length > 0;
  }

  /**
   * Mark current position as checkpoint (saved state).
   */
  async createCheckpoint(): Promise<void> {
    this.checkpointIndex = this.timeline.length;
    this.currentSize -= this.revertOnRestoreSizes.reduce((a, b) => a + b, 0);
    this.revertOnRestore = [];
    this.revertOnRestoreSizes = [];
    this.enforceRetentionLimits();
  }

  /**
   * Make the current database image a new clean baseline with no undo history.
   *
   * Reload replaces the database independently of the retained entries. Keeping
   * any timeline or redo entry would let an old custom-editor callback apply to
   * the replacement database. Advancing the invalidation revision also prevents
   * an in-flight persistence checkpoint from naming a position in this reset
   * timeline.
   */
  resetToCleanState(): void {
    this.timeline = [];
    this.timelineSizes = [];
    this.timelineOffset = 0;
    this.futureStack = [];
    this.futureStackSizes = [];
    this.revertOnRestore = [];
    this.revertOnRestoreSizes = [];
    this.checkpointIndex = 0;
    this.currentSize = 0;
    this.historyRecordingBlockedByBarrierLimit = false;
    this.invalidateCapturedCheckpointPositions();
  }

  /**
   * Return the absolute timeline position after the latest retained entry.
   *
   * This position is stable across later front-eviction because it includes the
   * count of entries already removed from the retained timeline.
   */
  getCurrentPosition(): number {
    return this.timelineOffset + this.timeline.length;
  }

  /**
   * Return the current history mutation revision.
   *
   * The value is only meaningful for equality comparisons against a previously
   * captured value from the same tracker instance.
   */
  getMutationRevision(): number {
    return this.mutationRevision;
  }

  /**
   * Return the current checkpoint invalidation revision.
   *
   * The value changes when undo, rollback, or retention eviction can make a
   * previously captured absolute checkpoint position unsafe to commit.
   */
  getCheckpointInvalidationRevision(): number {
    return this.checkpointInvalidationRevision;
  }

  /**
   * Mark a previously captured absolute timeline position as the saved state.
   *
   * The position is translated back into the retained timeline, clamped when
   * old entries were evicted or when callers provide a future position.
   */
  createCheckpointAt(position: number): void {
    const relativePosition = position - this.timelineOffset;
    this.checkpointIndex = Math.max(0, Math.min(this.timeline.length, relativePosition));
    this.currentSize -= this.revertOnRestoreSizes.reduce((a, b) => a + b, 0);
    this.revertOnRestore = [];
    this.revertOnRestoreSizes = [];
    this.enforceRetentionLimits();
  }

  /**
   * Get all modifications since last checkpoint.
   *
   * @returns Array of uncommitted modifications
   */
  getUncommittedEntries(): T[] {
    return this.timeline.slice(this.checkpointIndex);
  }

  /**
   * Get saved checkpoint entries that were undone after the last save.
   *
   * A hot-exit restore opens WASM bytes at the checkpoint state. When the live
   * timeline is behind that checkpoint, the restored database must undo the
   * saved entries that are now stored on the redo stack. The returned entries
   * are ordered exactly as they must be reverted to replay the user's undo
   * sequence against checkpoint bytes.
   *
   * @returns Saved-then-undone entries in database revert order
   */
  getEntriesUndoneSinceCheckpoint(): T[] {
    const delta = this.checkpointIndex - this.timeline.length;
    if (delta <= 0) {
      return [];
    }
    // Clamp defensively: a corrupted or hand-edited backup could make delta exceed
    // futureStack.length, where a negative slice start would silently drop entries.
    return this.futureStack.slice(Math.max(0, this.futureStack.length - delta));
  }

  /**
   * Get all saved checkpoint entries that restore/revert must undo first.
   *
   * The returned sequence is ordered newest-first for database undo. It combines
   * entries already captured from abandoned branches with entries that are still
   * available on the redo stack in the base undo-saved case.
   *
   * @returns Saved entries in database revert order
   */
  getCheckpointRevertSequence(): T[] {
    return [...this.revertOnRestore, ...this.getEntriesUndoneSinceCheckpoint()];
  }

  /**
   * Rollback to the last checkpoint.
   * Moves uncommitted modifications to redo stack.
   */
  rollbackToCheckpoint(): void {
    const savedUndoneCount = Math.max(0, this.checkpointIndex - this.timeline.length);
    const savedUndoneStart = Math.max(0, this.futureStack.length - savedUndoneCount);
    const savedUndone = this.futureStack.slice(savedUndoneStart);
    const savedUndoneSizes = this.futureStackSizes.slice(savedUndoneStart);
    let changed = false;

    if (savedUndone.length > 0) {
      // Entries below the checkpoint that are currently undone already exist on
      // futureStack. Rolling back to saved consumes them because they become part
      // of the active saved timeline again.
      this.futureStack = this.futureStack.slice(0, savedUndoneStart);
      this.futureStackSizes = this.futureStackSizes.slice(0, savedUndoneStart);
      changed = true;
    }

    const uncommittedCount = this.timeline.length - this.checkpointIndex;
    if (uncommittedCount > 0) {
      const uncommitted = this.timeline.splice(this.checkpointIndex);
      const uncommittedSizes = this.timelineSizes.splice(this.checkpointIndex);

      this.futureStack.push(...uncommitted.reverse());
      this.futureStackSizes.push(...uncommittedSizes.reverse());
      changed = true;
    }

    const restoreSequence = [...this.revertOnRestore, ...savedUndone];
    if (restoreSequence.length > 0) {
      // Saved-undone entries are stored newest-first for undo. Rolling back to
      // the saved checkpoint needs them in original application order.
      const restoreSizes = [...this.revertOnRestoreSizes, ...savedUndoneSizes];
      const restored = restoreSequence.reverse();
      const restoredSizes = restoreSizes.reverse();
      this.timeline.push(...restored);
      this.timelineSizes.push(...restoredSizes);
      this.checkpointIndex = this.timeline.length;
      this.revertOnRestore = [];
      this.revertOnRestoreSizes = [];
      changed = true;
    }

    if (changed) {
      this.invalidateCapturedCheckpointPositions();
    }
    this.historyRecordingBlockedByBarrierLimit = false;
  }

  /**
   * Serialize tracker state for backup.
   * Uses a custom JSON replacer for Uint8Array and BigInt cell values.
   *
   * @returns Binary representation of state
   */
  serialize(): Uint8Array {
    const payload = {
      timeline: this.timeline,
      checkpointIndex: this.checkpointIndex,
      futureStack: this.futureStack,
      revertOnRestore: this.revertOnRestore
    };
    // Preserve every non-JSON SQLite value used by undo and hot-exit replay.
    const jsonStr = JSON.stringify(payload, binaryReplacer);
    return new TextEncoder().encode(jsonStr);
  }

  /**
   * Restore tracker from serialized state.
   * Uses a custom JSON reviver to restore Uint8Array and BigInt cell values.
   *
   * @param data - Previously serialized state
   * @param maxEntries - Maximum capacity
   * @param maxMemory - Maximum memory usage in bytes
   * @returns Restored tracker
   */
  static deserialize<T extends LabeledModification>(
    data: Uint8Array,
    maxEntries: number = 100,
    maxMemory?: number
  ): ModificationTracker<T> {
    const jsonStr = new TextDecoder().decode(data);
    // Restore marker values before rebuilding tracker memory accounting.
    const payload = JSON.parse(jsonStr, binaryReviver);

    const tracker = new ModificationTracker<T>(maxEntries, maxMemory);
    tracker.timeline = payload.timeline || [];
    tracker.checkpointIndex = payload.checkpointIndex || 0;
    tracker.futureStack = payload.futureStack || [];
    tracker.revertOnRestore = payload.revertOnRestore || [];

    // Recalculate sizes for active timeline entries, redo entries, and captured
    // branch-revert entries so restored trackers enforce the same memory
    // accounting as live trackers.
    tracker.timelineSizes = tracker.timeline.map(estimateUndoMemoryBytes);
    tracker.futureStackSizes = tracker.futureStack.map(estimateUndoMemoryBytes);
    tracker.revertOnRestoreSizes = tracker.revertOnRestore.map(estimateUndoMemoryBytes);
    tracker.currentSize =
      tracker.timelineSizes.reduce((a, b) => a + b, 0) +
      tracker.futureStackSizes.reduce((a, b) => a + b, 0) +
      tracker.revertOnRestoreSizes.reduce((a, b) => a + b, 0);
    tracker.historyRecordingBlockedByBarrierLimit =
      tracker.checkpointIndex === 0
      && tracker.hasUncommittedHistoryBarrier
      && (
        tracker.timeline.length >= tracker.maxEntries
        || tracker.currentSize >= tracker.maxMemory
      );

    return tracker;
  }

  /**
   * Get total number of modifications in timeline.
   */
  get entryCount(): number {
    return this.timeline.length;
  }

  /**
   * Check if undo is available.
   */
  get canStepBack(): boolean {
    return this.timeline.length > 0 && this.timeline.at(-1)?.undoPolicy !== 'barrier';
  }

  /** True when an undo attempt is stopped by the forward-only sentinel. */
  get isUndoBlockedByBarrier(): boolean {
    return this.timeline.at(-1)?.undoPolicy === 'barrier';
  }

  /** The forward-only entry currently stopping Undo, when present. */
  get undoBlockingEntry(): T | undefined {
    const entry = this.timeline.at(-1);
    return entry?.undoPolicy === 'barrier' ? entry : undefined;
  }

  /** True while File Revert would have to cross a prior value we did not retain. */
  get hasUncommittedHistoryBarrier(): boolean {
    return this.timeline
      .slice(this.checkpointIndex)
      .some(entry => entry.undoPolicy === 'barrier');
  }

  /** Unsaved forward-only entries that File Revert would need to cross. */
  getUncommittedHistoryBarriers(): T[] {
    return this.timeline
      .slice(this.checkpointIndex)
      .filter(entry => entry.undoPolicy === 'barrier');
  }

  /**
   * Check if redo is available.
   */
  get canStepForward(): boolean {
    return this.futureStack.length > 0;
  }
}

// ============================================================================
// Compatibility Aliases
// ============================================================================
