import { describe, it } from 'node:test';
import assert from 'node:assert';
import { processProtocolMessage, buildMethodProxy } from '../../src/core/rpc';

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
  });
});
