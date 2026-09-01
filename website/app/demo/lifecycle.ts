export interface PendingWorkerCall {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class DemoWorkerRetiredError extends Error {
  override readonly name = 'DemoWorkerRetiredError';
}

/** Reject every request owned by a worker before terminating that worker. */
export function retireDemoWorker(
  worker: Pick<Worker, 'terminate'> | null,
  pendingCalls: Map<string, PendingWorkerCall>,
  error: Error
): void {
  const calls = [...pendingCalls.values()];
  pendingCalls.clear();
  for (const call of calls) call.reject(error);
  worker?.terminate();
}

/** Reopen the exact source retained by the page; never acknowledge a no-op reload. */
export async function reloadDemoDatabase<T>(
  source: Uint8Array | File | null,
  filename: string | null,
  initialize: (source: Uint8Array | File, filename: string) => Promise<T>
): Promise<T> {
  if (!source || !filename) {
    throw new Error('Cannot reload because the original database source is unavailable');
  }
  return initialize(source, filename);
}

/** Trigger one browser download without retaining a dead anchor or Blob URL. */
export function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  let appended = false;
  let clicked = false;
  try {
    document.body.appendChild(anchor);
    appended = true;
    anchor.click();
    clicked = true;
  } finally {
    try {
      if (appended) document.body.removeChild(anchor);
    } finally {
      if (clicked) setTimeout(() => URL.revokeObjectURL(url), 100);
      else URL.revokeObjectURL(url);
    }
  }
}
