import { describe, it } from 'node:test';
import assert from 'node:assert';
import { processProtocolMessage, buildMethodProxy, Transfer } from '../../src/core/rpc';

describe('RPC', () => {
  describe('processProtocolMessage', () => {
    it('should ignore invalid messages', () => {
      assert.strictEqual(processProtocolMessage(null), false);
      assert.strictEqual(processProtocolMessage({}), false);
      assert.strictEqual(processProtocolMessage({ kind: 'unknown' }), false);
    });

    it('should handle invocations', (context) => {
      const methods = {
        add: (a: number, b: number) => a + b
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

      assert.ok(dispatchedTransfer);
      assert.strictEqual(dispatchedTransfer.length, 1);
      assert.strictEqual(dispatchedTransfer[0], buffer);
    });
  });
});
