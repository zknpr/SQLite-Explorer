import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushHistory, explainWrap } from '../../core/ui/modules/console.js';

test('history caps at 50, dedupes consecutive, skips over-long entries', () => {
  let h: string[] = [];
  for (let i = 0; i < 60; i++) h = pushHistory(h, `select ${i}`);
  assert.equal(h.length, 50);
  assert.equal(h[0], 'select 59');            // newest first
  assert.equal(pushHistory(h, 'select 59'), h); // consecutive dedupe → same reference
  const long = 'x'.repeat(5000);
  assert.equal(pushHistory(h, long).length, 50); // not recorded
  assert.equal(pushHistory(h, long)[0], 'select 59');
});

test('explainWrap prefixes exactly once', () => {
  assert.equal(explainWrap('SELECT 1'), 'EXPLAIN QUERY PLAN SELECT 1');
  assert.equal(explainWrap('  explain query plan SELECT 1'), '  explain query plan SELECT 1');
});
