import { describe, it } from 'node:test';
import assert from 'node:assert';

const utilsModulePath = '../../core/ui/modules/utils.js';

describe('error message formatting', () => {
    it('handles non-Error promise rejections without throwing from the catch path', async () => {
        const { getErrorMessage } = await import(utilsModulePath);

        assert.strictEqual(getErrorMessage(new Error('broken')), 'broken');
        assert.strictEqual(getErrorMessage('plain failure'), 'plain failure');
        assert.strictEqual(getErrorMessage(null), 'null');
        assert.strictEqual(getErrorMessage(undefined, 'Operation failed'), 'undefined');
    });

    it('falls back when an attacker-controlled rejection cannot be stringified', async () => {
        const { getErrorMessage } = await import(utilsModulePath);
        const hostile = {
            [Symbol.toPrimitive]() {
                throw new Error('stringification trap');
            }
        };

        assert.strictEqual(getErrorMessage(hostile, 'Operation failed'), 'Operation failed');
    });

    it('bounds error text before assigning it to UI status elements', async () => {
        const { getErrorMessage } = await import(utilsModulePath);
        const message = getErrorMessage(new Error('x'.repeat(20_000)));

        assert.ok(message.length < 8400);
        assert.match(message, /truncated from 20000 characters/i);
    });
});
