/**
 * Modification Tracker Module
 *
 * Tracks database modifications for undo/redo functionality.
 * Supports serialization for VS Code hot exit backup.
 */

import type { LabeledModification } from './types';

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
  private futureStack: T[] = [];
  private checkpointIndex: number = 0;
  private maxEntries: number;

  /**
   * Create a new modification tracker.
   *
   * @param maxEntries - Maximum number of modifications to track
   */
  constructor(maxEntries: number = 100) {
    this.maxEntries = maxEntries;
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
    this.timeline.push(entry);
    this.futureStack = []; // Discard redo history

    // Enforce capacity limit
    if (this.timeline.length > this.maxEntries) {
      const overflow = this.timeline.length - this.maxEntries;
      this.timeline.splice(0, overflow);
      this.checkpointIndex = Math.max(0, this.checkpointIndex - overflow);
    }
  }

  /**
   * Step backward in timeline (undo).
   *
   * @returns The modification that was undone, or undefined if at beginning
   */
  stepBack(): T | undefined {
    const entry = this.timeline.pop();
    if (entry) {
      this.futureStack.push(entry);
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
    if (entry) {
      this.timeline.push(entry);
    }
    return entry;
  }

  /**
   * Check if there are uncommitted modifications.
   *
   * @returns True if timeline differs from checkpoint
   */
  hasUncommittedChanges(): boolean {
    return this.timeline.length !== this.checkpointIndex;
  }

  /**
   * Mark current position as checkpoint (saved state).
   */
  async createCheckpoint(): Promise<void> {
    this.checkpointIndex = this.timeline.length;
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
   * Rollback to the last checkpoint.
   * Moves uncommitted modifications to redo stack.
   */
  rollbackToCheckpoint(): void {
    const uncommittedCount = this.timeline.length - this.checkpointIndex;
    if (uncommittedCount > 0) {
      const uncommitted = this.timeline.splice(this.checkpointIndex);
      this.futureStack.push(...uncommitted.reverse());
    }
  }

  /**
   * Serialize tracker state for backup.
   *
   * @returns Binary representation of state
   */
  serialize(): Uint8Array {
    const payload = {
      timeline: this.timeline,
      checkpointIndex: this.checkpointIndex
    };
    const jsonStr = JSON.stringify(payload);
    return new TextEncoder().encode(jsonStr);
  }

  /**
   * Restore tracker from serialized state.
   *
   * @param data - Previously serialized state
   * @param maxEntries - Maximum capacity
   * @returns Restored tracker
   */
  static deserialize<T extends LabeledModification>(
    data: Uint8Array,
    maxEntries: number = 100
  ): ModificationTracker<T> {
    const jsonStr = new TextDecoder().decode(data);
    const payload = JSON.parse(jsonStr);

    const tracker = new ModificationTracker<T>(maxEntries);
    tracker.timeline = payload.timeline || [];
    tracker.checkpointIndex = payload.checkpointIndex || 0;

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
    return this.timeline.length > 0;
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

/**
 * Alias for backward compatibility with existing code.
 */
export { ModificationTracker as EditTracker };
