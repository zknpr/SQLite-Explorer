/**
 * Modification Tracker Module
 *
 * Tracks database modifications for undo/redo functionality.
 * Supports serialization for VS Code hot exit backup.
 */

import type { LabeledModification } from './types';

// ============================================================================
// JSON Serialization Helpers for Binary Data
// ============================================================================

/**
 * JSON replacer function that handles Uint8Array serialization.
 * Converts Uint8Array to a special object format that can be restored.
 *
 * IMPORTANT: Standard JSON.stringify corrupts Uint8Array by converting it
 * to an object like {"0": 1, "1": 2, ...} which loses the type information.
 * This replacer preserves the binary data as base64.
 */
function binaryReplacer(_key: string, value: unknown): unknown {
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
  if (value && typeof value === 'object' && '__type' in value) {
    const typed = value as { __type: string; data: string };
    if (typed.__type === 'Uint8Array' && typeof typed.data === 'string') {
      // Restore from base64
      if (typeof Buffer !== 'undefined') {
        return new Uint8Array(Buffer.from(typed.data, 'base64'));
      } else {
        const binary = atob(typed.data);
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
function calculateSize(value: unknown): number {
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
    } else if (typeof current === 'number') {
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

  private checkpointIndex: number = 0;
  private maxEntries: number;
  private maxMemory: number;
  private currentSize: number = 0;
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
    this.advanceMutationRevision();

    // Calculate size of new entry
    const entrySize = calculateSize(entry);

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

    // Enforce capacity and memory limits
    // We remove oldest entries until we are within BOTH limits
    while (
      (this.timeline.length > 0) &&
      (this.timeline.length > this.maxEntries || this.currentSize > this.maxMemory)
    ) {
      // Don't remove the just-added entry if it's the only one, to preserve ability to undo at least one step if possible.
      // However, if strict memory limit is required, we might need to, but let's be practical.
      if (this.timeline.length === 1) {
        break;
      }

      const removedEntrySize = this.timelineSizes.shift();
      this.timeline.shift();

      if (removedEntrySize !== undefined) {
        this.currentSize -= removedEntrySize;
      }

      // Adjust checkpoint index since we shifted the array
      this.checkpointIndex = Math.max(0, this.checkpointIndex - 1);
      this.timelineOffset++;
      this.invalidateCapturedCheckpointPositions();
    }
  }

  /**
   * Step backward in timeline (undo).
   *
   * @returns The modification that was undone, or undefined if at beginning
   */
  stepBack(): T | undefined {
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
    return this.timeline.length !== this.checkpointIndex;
  }

  /**
   * Mark current position as checkpoint (saved state).
   */
  async createCheckpoint(): Promise<void> {
    this.checkpointIndex = this.timeline.length;
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
      const uncommittedSizes = this.timelineSizes.splice(this.checkpointIndex);

      this.futureStack.push(...uncommitted.reverse());
      this.futureStackSizes.push(...uncommittedSizes.reverse());
      this.invalidateCapturedCheckpointPositions();
    }
  }

  /**
   * Serialize tracker state for backup.
   * Uses custom JSON replacer to properly handle Uint8Array binary data.
   *
   * @returns Binary representation of state
   */
  serialize(): Uint8Array {
    const payload = {
      timeline: this.timeline,
      checkpointIndex: this.checkpointIndex
    };
    // Use binaryReplacer to properly serialize Uint8Array values
    const jsonStr = JSON.stringify(payload, binaryReplacer);
    return new TextEncoder().encode(jsonStr);
  }

  /**
   * Restore tracker from serialized state.
   * Uses custom JSON reviver to properly restore Uint8Array binary data.
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
    // Use binaryReviver to properly restore Uint8Array values
    const payload = JSON.parse(jsonStr, binaryReviver);

    const tracker = new ModificationTracker<T>(maxEntries, maxMemory);
    tracker.timeline = payload.timeline || [];
    tracker.checkpointIndex = payload.checkpointIndex || 0;

    // Recalculate sizes
    tracker.timelineSizes = tracker.timeline.map(calculateSize);
    tracker.currentSize = tracker.timelineSizes.reduce((a, b) => a + b, 0);

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
