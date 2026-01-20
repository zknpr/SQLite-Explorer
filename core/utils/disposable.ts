/**
 * Resource Cleanup Utilities
 *
 * Helpers for managing disposable resources.
 */

import * as vsc from 'vscode';

/**
 * Base class for objects that hold disposable resources.
 */
export abstract class DisposableHolder implements vsc.Disposable {
  private resources: vsc.Disposable[] = [];
  private isDisposed = false;

  /**
   * Register a resource to be disposed when this object is disposed.
   */
  protected registerResource<T extends vsc.Disposable>(resource: T): T {
    if (this.isDisposed) {
      resource.dispose();
    } else {
      this.resources.push(resource);
    }
    return resource;
  }

  /**
   * Dispose all registered resources.
   */
  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    for (const resource of this.resources) {
      try {
        resource.dispose();
      } catch (err) {
        console.error('Error disposing resource:', err);
      }
    }
    this.resources = [];
  }
}

/**
 * Dispose all items in a collection.
 */
export function disposeCollection(items: vsc.Disposable[]): void {
  for (const item of items) {
    try {
      item.dispose();
    } catch (err) {
      console.error('Error disposing item:', err);
    }
  }
}
