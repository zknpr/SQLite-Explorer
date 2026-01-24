/**
 * Modification History Tracker
 *
 * Manages undo/redo stack for database modifications.
 * Tracks changes and enables reverting or reapplying operations.
 */

import type { ModificationRecord } from './handler';

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
    const base64 = btoa(String.fromCharCode(...value));
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
      const binary = atob(typed.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    }
  }
  return value;
}

// ============================================================================
// Modification Tracker
// ============================================================================

/**
 * History manager for tracking database modifications.
 * Supports undo, redo, save state tracking, and serialization.
 */
export class ModificationTracker<T extends ModificationRecord = ModificationRecord> {
  private changeStack: T[] = [];
  private redoStack: T[] = [];
  private persistedPosition: number = 0;
  private readonly stackLimit: number;

  constructor(stackLimit: number = 100) {
    this.stackLimit = stackLimit;
  }

  /**
   * Record a new modification.
   * Clears redo stack since history branches.
   */
  record(modification: T): void {
    this.changeStack.push(modification);
    this.redoStack = [];

    // Enforce stack size limit
    if (this.changeStack.length > this.stackLimit) {
      const overflow = this.changeStack.length - this.stackLimit;
      this.changeStack.splice(0, overflow);
      this.persistedPosition = Math.max(0, this.persistedPosition - overflow);
    }
  }

  /**
   * Undo last modification.
   * Returns the modification that was undone.
   */
  undoLast(): T | undefined {
    const modification = this.changeStack.pop();
    if (modification) {
      this.redoStack.push(modification);
    }
    return modification;
  }

  /**
   * Redo last undone modification.
   * Returns the modification that was redone.
   */
  redoLast(): T | undefined {
    const modification = this.redoStack.pop();
    if (modification) {
      this.changeStack.push(modification);
    }
    return modification;
  }

  /**
   * Check for unpersisted modifications.
   */
  hasUnpersistedChanges(): boolean {
    return this.changeStack.length !== this.persistedPosition;
  }

  /**
   * Mark current state as persisted.
   */
  async markPersisted(): Promise<void> {
    this.persistedPosition = this.changeStack.length;
  }

  /**
   * Get modifications since last persist.
   */
  getUnpersistedModifications(): T[] {
    return this.changeStack.slice(this.persistedPosition);
  }

  /**
   * Revert to last persisted state.
   */
  revertToPersistedState(): void {
    const unpersistedCount = this.changeStack.length - this.persistedPosition;
    if (unpersistedCount > 0) {
      const reverted = this.changeStack.splice(this.persistedPosition);
      this.redoStack.push(...reverted.reverse());
    }
  }

  /**
   * Serialize history for backup/restore.
   * Uses custom JSON replacer to properly handle Uint8Array binary data.
   */
  serialize(): Uint8Array {
    const payload = {
      changes: this.changeStack,
      persistedAt: this.persistedPosition
    };
    // Use binaryReplacer to properly serialize Uint8Array values
    const jsonString = JSON.stringify(payload, binaryReplacer);
    return new TextEncoder().encode(jsonString);
  }

  /**
   * Restore history from serialized data.
   * Uses custom JSON reviver to properly restore Uint8Array binary data.
   */
  static deserialize<T extends ModificationRecord>(
    data: Uint8Array,
    stackLimit: number = 100
  ): ModificationTracker<T> {
    const jsonString = new TextDecoder().decode(data);
    // Use binaryReviver to properly restore Uint8Array values
    const payload = JSON.parse(jsonString, binaryReviver);

    const tracker = new ModificationTracker<T>(stackLimit);
    tracker.changeStack = payload.changes || [];
    tracker.persistedPosition = payload.persistedAt || 0;

    return tracker;
  }

  /**
   * Current number of tracked modifications.
   */
  get count(): number {
    return this.changeStack.length;
  }

  /**
   * Whether undo is available.
   */
  get undoAvailable(): boolean {
    return this.changeStack.length > 0;
  }

  /**
   * Whether redo is available.
   */
  get redoAvailable(): boolean {
    return this.redoStack.length > 0;
  }
}
