
import type { CancellationToken } from 'vscode';

export interface SharedCancellationFlag {
  readonly flag: Int32Array;
  dispose(): void;
}

/**
 * Mirror AbortSignal state into memory that a synchronously blocked worker can
 * poll from SQLite's progress handler.
 */
export function createSharedCancellationFlag(
  signal?: AbortSignal
): SharedCancellationFlag | undefined {
  if (!signal) return undefined;

  const browserLike = typeof window !== 'undefined' || typeof self !== 'undefined';
  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
  // Browser agents may share this flag only when the page explicitly exposes a
  // cross-origin-isolated realm. Without that probe, cancellation degrades to
  // the SQLite deadline; Node worker_threads has no isolation property.
  if ((browserLike && isolated !== true) || isolated === false) return undefined;
  if (typeof SharedArrayBuffer !== 'function') return undefined;

  let flag: Int32Array;
  try {
    flag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    Atomics.store(flag, 0, 0);
  } catch {
    return undefined;
  }

  const markCancelled = () => {
    Atomics.store(flag, 0, 1);
  };
  if (signal.aborted) {
    markCancelled();
  } else {
    signal.addEventListener('abort', markCancelled, { once: true });
  }

  return {
    flag,
    dispose() {
      signal.removeEventListener('abort', markCancelled);
    }
  };
}

/**
 * Convert VS Code CancellationToken to standard AbortSignal.
 *
 * @param token - VS Code cancellation token (or null/undefined)
 * @returns AbortSignal that triggers when token is cancelled
 */
export function cancelTokenToAbortSignal<T extends CancellationToken | null | undefined>(
  token: T
): T extends null | undefined ? undefined : AbortSignal;
export function cancelTokenToAbortSignal(
  token: CancellationToken | null | undefined
): AbortSignal | undefined {
  if (token == null) return undefined;

  const controller = new AbortController();
  // We access properties on 'token' assuming it adheres to the CancellationToken interface.
  // Since we only import it as a type, this code doesn't depend on the vscode module at runtime.
  if (token.isCancellationRequested) {
    controller.abort();
  } else {
    // Store the disposable and clean it up after abort to prevent memory leak
    const disposable = token.onCancellationRequested(() => {
      controller.abort();
      disposable.dispose();
    });
  }
  return controller.signal;
}
