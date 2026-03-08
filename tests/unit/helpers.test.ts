import './vscode_mock_setup';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getUriParts, doTry } from '../../src/helpers';
import * as vsc from 'vscode';

describe('getUriParts', () => {
  it('should parse simple file path string', () => {
    const parts = getUriParts('/home/user/test.txt');
    assert.strictEqual(parts.dirname, '/home/user/');
    assert.strictEqual(parts.filename, 'test.txt');
    assert.strictEqual(parts.basename, 'test');
    assert.strictEqual(parts.extname, '.txt');
  });

  it('should parse simple file path URI', () => {
    const uri = vsc.Uri.file('/home/user/test.txt');
    const parts = getUriParts(uri);
    assert.strictEqual(parts.dirname, 'file:///home/user/'); // Regex matches from uri.toString() which returns file://...
    assert.strictEqual(parts.filename, 'test.txt');
    assert.strictEqual(parts.basename, 'test');
    assert.strictEqual(parts.extname, '.txt');
  });

  it('should parse file without extension', () => {
    const parts = getUriParts('/home/user/makefile');
    assert.strictEqual(parts.dirname, '/home/user/');
    assert.strictEqual(parts.filename, 'makefile');
    assert.strictEqual(parts.basename, 'makefile');
    assert.strictEqual(parts.extname, '');
  });

  it('should parse file in root', () => {
    const parts = getUriParts('/config.json');
    assert.strictEqual(parts.dirname, '/');
    assert.strictEqual(parts.filename, 'config.json');
    assert.strictEqual(parts.basename, 'config');
    assert.strictEqual(parts.extname, '.json');
  });

  it('should parse just filename', () => {
      const parts = getUriParts('notes.md');
      assert.strictEqual(parts.dirname, '');
      assert.strictEqual(parts.filename, 'notes.md');
      assert.strictEqual(parts.basename, 'notes');
      assert.strictEqual(parts.extname, '.md');
  });

  it('should handle special characters and decoding', () => {
    // We use string input to test decodeURIComponent logic independently of vsc.Uri mock
    const parts = getUriParts('/path/to/file%20name.txt');
    assert.strictEqual(parts.dirname, '/path/to/');
    assert.strictEqual(parts.filename, 'file name.txt');
    assert.strictEqual(parts.basename, 'file name');
    assert.strictEqual(parts.extname, '.txt');
  });
});

describe('doTry', () => {
  it('should return function result on success', () => {
    const result = doTry(() => 'success');
    assert.strictEqual(result, 'success');
  });

  it('should return undefined and suppress error on failure', () => {
    const result = doTry(() => { throw new Error('fail'); });
    assert.strictEqual(result, undefined);
  });
});
