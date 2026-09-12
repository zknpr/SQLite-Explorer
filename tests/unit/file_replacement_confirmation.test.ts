import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import { mockVscode } from './mocks/vscode';
import { confirmFileReplacement } from '../../src/fileReplacementConfirmation';
import * as vsc from 'vscode';

afterEach(() => mock.restoreAll());

it('requires explicit Replace for an existing destination and propagates inspection errors', async () => {
  const uri = vsc.Uri.file('/workspace/existing.csv');
  mock.method(mockVscode.workspace.fs, 'stat', async () => ({ type: 1, size: 8 }));
  const warning = mock.method(mockVscode.window, 'showWarningMessage', async (): Promise<string | undefined> => undefined);
  assert.equal(await confirmFileReplacement(uri), false);
  assert.deepEqual(warning.mock.calls[0].arguments, [
    'Replace the existing file?', { modal: true, detail: uri.fsPath }, 'Replace'
  ]);
  warning.mock.mockImplementation(async () => 'Replace');
  assert.equal(await confirmFileReplacement(uri), true);
  mock.method(mockVscode.workspace.fs, 'stat', async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
  await assert.rejects(() => confirmFileReplacement(uri), /denied/);
});

it('does not prompt for a genuinely missing destination', async () => {
  mock.method(mockVscode.workspace.fs, 'stat', async () => { throw Object.assign(new Error('missing'), { code: 'FileNotFound' }); });
  const warning = mock.method(mockVscode.window, 'showWarningMessage');
  assert.equal(await confirmFileReplacement(vsc.Uri.file('/workspace/new.csv')), true);
  assert.equal(warning.mock.callCount(), 0);
});
