/**
 * Resource Lifecycle Management
 *
 * Provides utilities for managing VS Code Disposable resources.
 * Ensures proper cleanup of subscriptions, event handlers, and other resources.
 */

import * as vscode from 'vscode';

// ============================================================================
// Batch Disposal
// ============================================================================

/**
 * Dispose all items in an array, collecting any errors.
 *
 * Iterates through the array in reverse order (LIFO) and disposes each item.
 * If any disposals throw errors, they are collected and re-thrown as an
 * AggregateError after all items have been processed.
 *
 * @param items - Array of disposables to clean up (will be emptied)
 * @throws AggregateError if any disposal operations fail
 */
export function disposeAll(items: vscode.Disposable[]): void {
  const failures: unknown[] = [];

  while (items.length > 0) {
    const item = items.pop();
    if (item) {
      try {
        item.dispose();
      } catch (err) {
        failures.push(err);
      }
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, 'One or more disposal operations failed');
  }
}

// ============================================================================
// Disposable Base Class
// ============================================================================

/**
 * Base class for objects that manage VS Code resources.
 *
 * Provides a structured pattern for resource management:
 * - Child resources are registered via _register()
 * - All registered resources are disposed when the parent is disposed
 * - Prevents double-disposal and resource leaks
 *
 * @example
 * ```typescript
 * class MyService extends Disposable {
 *   constructor() {
 *     super();
 *     // Register resources that should be cleaned up
 *     this._register(vscode.workspace.onDidChangeConfiguration(...));
 *     this._register(vscode.window.createOutputChannel(...));
 *   }
 * }
 * ```
 */
export abstract class Disposable implements vscode.Disposable {
  /** Flag to prevent double-disposal */
  private disposed = false;

  /** Collection of child resources to dispose */
  private readonly children: vscode.Disposable[] = [];

  /**
   * Release all resources held by this object.
   *
   * Safe to call multiple times - subsequent calls are no-ops.
   * Disposes all registered child resources in reverse order of registration.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    disposeAll(this.children);
  }

  /**
   * ES2022 explicit resource management support.
   *
   * Allows this object to be used with `using` declarations:
   * ```typescript
   * using service = new MyService();
   * ```
   */
  [Symbol.dispose](): void {
    this.dispose();
  }

  /**
   * Register a child resource for automatic disposal.
   *
   * If this object has already been disposed, the child is
   * immediately disposed instead of being registered.
   *
   * @param child - Resource to manage
   * @returns The same resource (for chaining)
   */
  protected _register<T extends vscode.Disposable>(child: T): T {
    if (this.disposed) {
      // Parent already disposed - dispose child immediately
      child.dispose();
    } else {
      this.children.push(child);
    }
    return child;
  }

  /**
   * Check if this object has been disposed.
   *
   * Useful for guarding against operations on disposed objects.
   */
  protected get isDisposed(): boolean {
    return this.disposed;
  }
}
