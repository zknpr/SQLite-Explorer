import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modLabel, saveHint } from '../../core/ui/modules/platform.js';

test('modifier copy per platform', () => {
  assert.equal(modLabel('S', true), '⌘S');
  assert.equal(modLabel('S', false), 'Ctrl+S');
  assert.equal(saveHint(true), '⌘S to save');
  assert.equal(saveHint(false), 'Ctrl+S to save');
});
