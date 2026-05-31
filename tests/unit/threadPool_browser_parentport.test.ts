/**
 * Regression tests for the browser parentPort adapter.
 *
 * databaseWorker.ts expects Node's worker_threads parentPort shape, while a
 * DedicatedWorkerGlobalScope exposes DOM event APIs. These tests exercise the
 * adapter against a fake worker global scope so the browser behavior is covered
 * without depending on a real browser.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createBrowserParentPort } from '../../src/platform/threadPool';

describe('createBrowserParentPort', () => {
  it('adapts browser worker scope events to Node-style parentPort methods', () => {
    const registeredListeners: Array<{
      event: string;
      listener: EventListenerOrEventListenerObject;
    }> = [];
    const removedListeners: Array<{
      event: string;
      listener: EventListenerOrEventListenerObject;
    }> = [];
    const postedMessages: Array<{ data: unknown; transfer?: Transferable[] }> = [];

    const fakeScope = {
      postMessage(data: unknown, transfer?: Transferable[]) {
        // The fake scope records the exact payload and transfer list forwarded by
        // the adapter so the test can verify postMessage does not transform them.
        postedMessages.push({ data, transfer });
      },
      addEventListener(event: string, listener: EventListenerOrEventListenerObject) {
        // The fake scope stores listeners exactly as registered, allowing the
        // test to invoke the wrapped DOM listener with controlled event objects.
        registeredListeners.push({ event, listener });
      },
      removeEventListener(event: string, listener: EventListenerOrEventListenerObject) {
        // The fake scope records removals so off() can be checked against the
        // wrapped listener that on() installed.
        removedListeners.push({ event, listener });
      },
    };

    const parentPort = createBrowserParentPort(fakeScope);

    assert.strictEqual(typeof parentPort.postMessage, 'function');
    assert.strictEqual(typeof parentPort.on, 'function');
    assert.strictEqual(typeof parentPort.off, 'function');

    const receivedMessages: unknown[] = [];
    const messageHandler = (payload: unknown) => {
      receivedMessages.push(payload);
    };

    parentPort.on('message', messageHandler);

    assert.strictEqual(registeredListeners.length, 1);
    assert.strictEqual(registeredListeners[0].event, 'message');

    const messageListener = registeredListeners[0].listener as EventListener;
    messageListener({ data: 'database-bytes' } as MessageEvent);

    assert.deepStrictEqual(receivedMessages, ['database-bytes']);

    const receivedErrors: unknown[] = [];
    const errorHandler = (event: unknown) => {
      receivedErrors.push(event);
    };
    const errorEvent = new Event('error');

    parentPort.on('error', errorHandler);

    assert.strictEqual(registeredListeners.length, 2);
    assert.strictEqual(registeredListeners[1].event, 'error');

    const errorListener = registeredListeners[1].listener as EventListener;
    errorListener(errorEvent);

    assert.deepStrictEqual(receivedErrors, [errorEvent]);

    const transferBuffer = new ArrayBuffer(8);
    parentPort.postMessage({ ready: true }, [transferBuffer]);

    assert.deepStrictEqual(postedMessages, [
      { data: { ready: true }, transfer: [transferBuffer] },
    ]);

    parentPort.off('message', messageHandler);

    assert.strictEqual(removedListeners.length, 1);
    assert.strictEqual(removedListeners[0].event, 'message');
    assert.strictEqual(removedListeners[0].listener, registeredListeners[0].listener);
  });
});
