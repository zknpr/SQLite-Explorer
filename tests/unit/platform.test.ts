import { test } from 'node:test';
import assert from 'node:assert';
import { getNodeFs } from '../../src/core/platform';

test('getNodeFs returns fs module in Node.js environment', () => {
  const fs = getNodeFs();
  assert.ok(fs, 'fs should be defined');
  assert.strictEqual(typeof fs?.promises?.writeFile, 'function', 'fs.promises.writeFile should be a function');
  assert.strictEqual(typeof fs?.statSync, 'function', 'fs.statSync should be a function');
});
