import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doubleClickOptions } from '../../core/ui/modules/settings.js';

test('desktop drops the vscode double-click mode', () => {
  assert.deepEqual(doubleClickOptions(true), ['inline', 'modal']);
  assert.deepEqual(doubleClickOptions(false), ['inline', 'modal', 'vscode']);
});
