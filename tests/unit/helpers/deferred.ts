export interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T | PromiseLike<T>): void;
    reject(reason?: unknown): void;
}

/** A test-controlled promise for deterministic concurrency assertions. */
export function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}
