import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pushHistory,
  explainWrap,
  sanitizeHistory,
  historySkipNotice,
  HISTORY_CAP,
  HISTORY_ENTRY_MAX
} from '../../core/ui/modules/console.js';

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

test('sanitizeHistory drops what would break the console and keeps the reference when clean', () => {
  // settings.json is hand-editable, and a non-string entry used to throw inside
  // createConsole's dropdown builder — leaving `sqlConsole` unassigned and the
  // console unopenable for the whole session.
  assert.deepEqual(
    sanitizeHistory(['select 1', null, 42, undefined, { sql: 'x' }, 'select 2']),
    ['select 1', 'select 2']
  );
  assert.deepEqual(sanitizeHistory(null), []);
  assert.deepEqual(sanitizeHistory('select 1'), []);
  assert.deepEqual(sanitizeHistory([]), []);

  // Over-long entries go too: this module would never have recorded them.
  assert.deepEqual(sanitizeHistory(['ok', 'x'.repeat(HISTORY_ENTRY_MAX + 1)]), ['ok']);
  assert.equal(sanitizeHistory(['x'.repeat(HISTORY_ENTRY_MAX)]).length, 1);

  // Over-cap lists are trimmed newest-first.
  const long = Array.from({ length: HISTORY_CAP + 10 }, (_, i) => `select ${i}`);
  assert.equal(sanitizeHistory(long).length, HISTORY_CAP);
  assert.equal(sanitizeHistory(long)[0], 'select 0');

  // Same-reference convention (mirrors pushHistory) — the viewer's
  // "nothing recorded, skip the settings write" check depends on it.
  const clean = ['select 1', 'select 2'];
  assert.equal(sanitizeHistory(clean), clean);
});

test('historySkipNotice fires only for entries pushHistory would drop as too long', () => {
  assert.equal(historySkipNotice('select 1'), '');
  assert.equal(historySkipNotice('   '), '');
  assert.equal(historySkipNotice('x'.repeat(HISTORY_ENTRY_MAX)), '');
  assert.equal(historySkipNotice('x'.repeat(HISTORY_ENTRY_MAX + 1)), 'not recorded (too long)');
  // Trimmed before measuring, exactly as pushHistory measures it.
  assert.equal(historySkipNotice(`  ${'x'.repeat(HISTORY_ENTRY_MAX)}  `), '');
});
