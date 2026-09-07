
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { cancelTokenToAbortSignal } from '../../src/core/cancellation-utils';

describe('Cancellation Utils', () => {
    describe('cancelTokenToAbortSignal', () => {
        it('should return undefined if token is null', () => {
            assert.strictEqual(cancelTokenToAbortSignal(null), undefined);
        });

        it('should return undefined if token is undefined', () => {
            assert.strictEqual(cancelTokenToAbortSignal(undefined), undefined);
        });

        it('should return AbortSignal if token is provided', () => {
            const token: any = {
                isCancellationRequested: false,
                onCancellationRequested: () => {}
            };
            const signal = cancelTokenToAbortSignal(token);
            assert.ok(signal instanceof AbortSignal);
            assert.strictEqual(signal.aborted, false);
        });

        it('should abort if token is already cancelled', () => {
            const token: any = {
                isCancellationRequested: true,
                onCancellationRequested: () => {}
            };
            const signal = cancelTokenToAbortSignal(token);
            assert.ok(signal instanceof AbortSignal);
            assert.strictEqual(signal.aborted, true);
        });

        it('should abort when token is cancelled later', () => {
            let callback: (() => void) | undefined;
            const token: any = {
                isCancellationRequested: false,
                onCancellationRequested: (cb: () => void) => {
                    callback = cb;
                    return { dispose: () => {} };
                }
            };

            const signal = cancelTokenToAbortSignal(token);
            assert.strictEqual(signal!.aborted, false);

            // Simulate cancellation
            assert.ok(callback);
            callback();

            assert.strictEqual(signal!.aborted, true);
        });

        it('handles cancellation racing the listener subscription', () => {
            let disposed = false;
            const token: any = {
                isCancellationRequested: false,
                onCancellationRequested: (callback: () => void) => {
                    callback();
                    return { dispose: () => { disposed = true; } };
                }
            };

            const signal = cancelTokenToAbortSignal(token);

            assert.strictEqual(signal!.aborted, true);
            assert.strictEqual(disposed, true);
        });
    });
});
