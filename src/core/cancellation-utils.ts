
import type { CancellationToken } from 'vscode';

/**
 * Convert VS Code CancellationToken to standard AbortSignal.
 *
 * @param token - VS Code cancellation token (or null/undefined)
 * @returns AbortSignal that triggers when token is cancelled
 */
export function cancelTokenToAbortSignal<T extends CancellationToken | null | undefined>(
  token: T
): T extends null | undefined ? undefined : AbortSignal {
  if (token == null) return undefined as any;

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
  return controller.signal as any;
}
