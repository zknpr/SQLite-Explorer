import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  processProtocolMessage,
  buildMethodProxy,
  connectWorkerPort,
  WorkerPort,
  Transfer,
  InvocationTimeoutError,
  isInvocationTimeoutError
} from '../../src/core/rpc';

describe('RPC', () => {
  describe('processProtocolMessage', () => {
    it('should ignore invalid messages', () => {
      assert.strictEqual(processProtocolMessage(null), false);
      assert.strictEqual(processProtocolMessage({}), false);
      assert.strictEqual(processProtocolMessage({ kind: 'unknown' }), false);
    });

    it('should handle invocations', (context) => {
      const methods: Record<string, (...args: unknown[]) => unknown> = {
        add: (...args: unknown[]) => (args[0] as number) + (args[1] as number)
      };

      let response: any = null;
      const sendResponse = (msg: any) => { response = msg; };

      const handled = processProtocolMessage({
        kind: 'invoke',
        correlationId: '123',
        methodName: 'add',
        parameters: [1, 2]
      }, methods, sendResponse);

      assert.strictEqual(handled, true);

      // Wait for promise resolution (processProtocolMessage handles async invocation)
      setTimeout(() => {
        assert.deepStrictEqual(response, {
          kind: 'result',
          correlationId: '123',
          payload: 3
        });
      }, 0);
    });

    it('should handle log messages with onLog callback', () => {
      let capturedLevel: string | null = null;
      let capturedArgs: unknown[] | null = null;
      const onLog = (level: string, args: unknown[]) => {
        capturedLevel = level;
        capturedArgs = args;
      };

      const handled = processProtocolMessage(
        { kind: 'log', level: 'warn', args: ['test warning', 42] },
        undefined,
        undefined,
        onLog
      );

      assert.strictEqual(handled, true);
      assert.strictEqual(capturedLevel, 'warn');
      assert.deepStrictEqual(capturedArgs, ['test warning', 42]);
    });

    it('should handle log messages without onLog callback (silent drop)', () => {
      // Log messages should still return true (handled) even without a callback
      const handled = processProtocolMessage(
        { kind: 'log', level: 'error', args: ['ignored error'] }
      );

      assert.strictEqual(handled, true);
    });

    it('should handle unknown methods', () => {
      const methods = {};
      let response: any = null;
      const sendResponse = (msg: any) => { response = msg; };

      processProtocolMessage({
        kind: 'invoke',
        correlationId: '123',
        methodName: 'unknown',
        parameters: []
      }, methods, sendResponse);

      assert.deepStrictEqual(response, {
        kind: 'result',
        correlationId: '123',
        errorText: 'Unknown method: unknown'
      });
    });

    it('should handle Transfer wrappers in return value', () => {
      const buffer = new ArrayBuffer(8);
      const methods = {
        getData: () => new Transfer({ data: buffer }, [buffer])
      };

      let response: any = null;
      let transfer: Transferable[] | undefined = undefined;
      const sendResponse = (msg: any, t?: Transferable[]) => {
        response = msg;
        transfer = t;
      };

      processProtocolMessage({
        kind: 'invoke',
        correlationId: '123',
        methodName: 'getData',
        parameters: []
      }, methods, sendResponse);

      setTimeout(() => {
        assert.deepStrictEqual(response, {
          kind: 'result',
          correlationId: '123',
          payload: { data: buffer }
        });
        assert.strictEqual(transfer?.length, 1);
        assert.strictEqual(transfer?.[0], buffer);
      }, 0);
    });
  });

  describe('buildMethodProxy', () => {
    it('should extract transferables from arguments', () => {
      let dispatchedEnvelope: any = null;
      let dispatchedTransfer: Transferable[] | undefined = undefined;

      const dispatcher = (envelope: any, transfer?: Transferable[]) => {
        dispatchedEnvelope = envelope;
        dispatchedTransfer = transfer;
      };

      const proxy = buildMethodProxy<{ sendData: (data: any) => Promise<void> }>(
        dispatcher,
        ['sendData']
      );

      const buffer = new ArrayBuffer(8);
      const data = new Transfer({ buf: buffer }, [buffer]);

      // Promise executor runs synchronously so dispatcher should be called immediately
      proxy.sendData(data).catch(() => {}); // Prevent unhandled rejection

      assert.ok(dispatchedEnvelope);
      assert.strictEqual(dispatchedEnvelope.kind, 'invoke');
      assert.strictEqual(dispatchedEnvelope.methodName, 'sendData');
      assert.deepStrictEqual(dispatchedEnvelope.parameters, [{ buf: buffer }]);

      const transfer = dispatchedTransfer as unknown as Transferable[];
      assert.ok(transfer);
      assert.strictEqual(transfer.length, 1);
      assert.strictEqual(transfer[0], buffer);
    });
  });

  it('preserves invocation-timeout identity across a worker response', async () => {
    let invocation: unknown;
    const proxy = buildMethodProxy<{ revert: () => Promise<void> }>(
      envelope => { invocation = envelope; },
      ['revert']
    );
    const pending = proxy.revert();
    const response = await new Promise<unknown>(resolve => {
      processProtocolMessage(
        invocation,
        {
          revert() {
            throw new InvocationTimeoutError('discardModifications', 'worker history timed out');
          }
        },
        resolve as any
      );
    });

    processProtocolMessage(
      response,
      undefined,
      undefined,
      undefined,
      proxy.__pendingInvocations
    );

    await assert.rejects(pending, error => {
      assert.strictEqual(isInvocationTimeoutError(error), true);
      assert.ok(error instanceof InvocationTimeoutError);
      assert.strictEqual(error.methodName, 'discardModifications');
      assert.strictEqual(error.message, 'worker history timed out');
      return true;
    });
  });

  it('does not infer timeout recovery from ordinary error text', () => {
    assert.strictEqual(
      isInvocationTimeoutError(new Error('Request discardModifications timed out')),
      false
    );
  });

  describe('connectWorkerPort', () => {
    let originalWarn: any;

    afterEach(() => {
      if (originalWarn) {
        console.warn = originalWarn;
        originalWarn = undefined;
      }
    });

    it('should route invocations and responses', async () => {
      let messageHandler: ((data: any) => void) | undefined;
      let postedMessage: any;

      const port: WorkerPort = {
        postMessage: (msg: any, transfer: any) => {
          postedMessage = msg;
        },
        on: (event: string, handler: any) => {
          if (event === 'message') messageHandler = handler;
        }
      };

      const proxy = connectWorkerPort<{ add: (a: number, b: number) => Promise<number> }>(
        port,
        ['add']
      );

      assert.ok(messageHandler);

      // Call proxy
      const promise = proxy.add(2, 3);

      // Check envelope
      assert.strictEqual(postedMessage.kind, 'invoke');
      assert.strictEqual(postedMessage.methodName, 'add');
      assert.deepStrictEqual(postedMessage.parameters, [2, 3]);

      // Emulate reply
      messageHandler({
        kind: 'result',
        correlationId: postedMessage.correlationId,
        payload: 5
      });

      const result = await promise;
      assert.strictEqual(result, 5);
    });

    it('should pass transfer list to postMessage', async () => {
      let postedTransfer: any;

      const port: WorkerPort = {
        postMessage: (msg: any, transfer: any) => {
          postedTransfer = transfer;
        },
        on: () => {}
      };

      const proxy = connectWorkerPort<{ send: (data: any) => Promise<void> }>(
        port,
        ['send']
      );

      const buffer = new ArrayBuffer(8);
      proxy.send(new Transfer({ buf: buffer }, [buffer])).catch(() => {});

      assert.strictEqual(postedTransfer?.length, 1);
      assert.strictEqual(postedTransfer?.[0], buffer);
    });

    it('should fallback to copy if transfer throws', async () => {
      let callCount = 0;
      let hadTransfer = false;
      let fallbackMessage = null;

      originalWarn = console.warn;
      let warnCalled = false;
      let warnArgs: any[] = [];
      console.warn = (...args: any[]) => {
        warnCalled = true;
        warnArgs = args;
      };

      const errorToThrow = new Error('Transfer not supported');

      const port: WorkerPort = {
        postMessage: (msg: any, transfer: any) => {
          callCount++;
          if (transfer && transfer.length > 0) {
            hadTransfer = true;
            throw errorToThrow;
          } else {
            fallbackMessage = msg;
          }
        },
        on: () => {}
      };

      const proxy = connectWorkerPort<{ send: (data: any) => Promise<void> }>(
        port,
        ['send']
      );

      const buffer = new ArrayBuffer(8);
      proxy.send(new Transfer({ buf: buffer }, [buffer])).catch(() => {});

      assert.strictEqual(callCount, 2);
      assert.strictEqual(hadTransfer, true);
      assert.ok(fallbackMessage);
      assert.strictEqual(warnCalled, true);
      assert.strictEqual(warnArgs[0], 'Transfer failed, falling back to copy');
      assert.strictEqual(warnArgs[1], errorToThrow);
    });

    it('should route log messages to onLog', () => {
      let messageHandler: ((data: any) => void) | undefined;
      let logLevel: string | null = null;
      let logArgs: any = null;

      const port: WorkerPort = {
        postMessage: () => {},
        on: (event: string, handler: any) => {
          if (event === 'message') messageHandler = handler;
        }
      };

      connectWorkerPort(port, [], (level, args) => {
        logLevel = level;
        logArgs = args;
      });

      assert.ok(messageHandler);

      messageHandler({
        kind: 'log',
        level: 'info',
        args: ['hello world']
      });

      assert.strictEqual(logLevel, 'info');
      assert.deepStrictEqual(logArgs, ['hello world']);
    });
  });
});
