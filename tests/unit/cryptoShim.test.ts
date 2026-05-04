import { describe, it } from 'node:test';
import assert from 'node:assert';
import { crypto } from '../../src/platform/cryptoShim';

describe('Crypto Shim', () => {
  it('should export a valid crypto object', () => {
    assert.ok(crypto, 'crypto object should be defined');
  });

  it('should support randomUUID', () => {
    assert.strictEqual(typeof crypto.randomUUID, 'function', 'randomUUID should be a function');
    const uuid = crypto.randomUUID();
    assert.strictEqual(typeof uuid, 'string', 'randomUUID should return a string');
    assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'should return a valid UUID format');
  });

  it('should support getRandomValues', () => {
    assert.strictEqual(typeof crypto.getRandomValues, 'function', 'getRandomValues should be a function');
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);

    // It's highly unlikely that 16 random bytes are all exactly 0
    let allZeros = true;
    for (let i = 0; i < array.length; i++) {
      if (array[i] !== 0) {
        allZeros = false;
        break;
      }
    }
    assert.strictEqual(allZeros, false, 'getRandomValues should populate array with random bytes');
  });

  it('should support subtle crypto API', () => {
    assert.ok(crypto.subtle, 'subtle crypto should be available');
    assert.strictEqual(typeof crypto.subtle.digest, 'function', 'crypto.subtle.digest should be a function');
  });
});
