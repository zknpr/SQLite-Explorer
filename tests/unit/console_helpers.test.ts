import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pushHistory,
  stripExplainPrefix,
  parseConsoleParameters,
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

test('stripExplainPrefix removes a leading EXPLAIN [QUERY PLAN] and nothing else', () => {
  // The worker owns the wrapping now; the console only keeps a user's own
  // EXPLAIN from being wrapped a second time (a syntax error in SQLite).
  assert.equal(stripExplainPrefix('EXPLAIN QUERY PLAN SELECT 1'), 'SELECT 1');
  assert.equal(stripExplainPrefix('  explain query plan SELECT 1'), 'SELECT 1');
  assert.equal(stripExplainPrefix('explain\n  SELECT 1'), 'SELECT 1');
  assert.equal(stripExplainPrefix('EXPLAIN SELECT 1'), 'SELECT 1');
  assert.equal(stripExplainPrefix('SELECT 1'), 'SELECT 1');
  // A word that merely starts with "explain" is an identifier, not the keyword.
  assert.equal(stripExplainPrefix('explainer'), 'explainer');
  assert.equal(stripExplainPrefix("SELECT 'explain'"), "SELECT 'explain'");
});

test('parseConsoleParameters treats a blank field as no parameters and otherwise delegates', () => {
  assert.deepEqual(parseConsoleParameters(''), []);
  assert.deepEqual(parseConsoleParameters('   '), []);
  assert.deepEqual(parseConsoleParameters(undefined), []);
  assert.deepEqual(parseConsoleParameters(' [1, "a", null, 2.5] '), [1, 'a', null, 2.5]);
  // parseQueryParameters' own refusals come through with its own messages.
  assert.throws(() => parseConsoleParameters('{"a": 1}'), /JSON array/);
  assert.throws(() => parseConsoleParameters('[true]'), /null, string, or number/);
  assert.throws(() => parseConsoleParameters('[9007199254740993]'), /safe integer/);
  assert.throws(() => parseConsoleParameters('not json'));
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
