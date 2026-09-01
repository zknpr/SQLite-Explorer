import './vscode_mock_setup';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getMaximumFileSizeBytes, getQueryTimeout } from '../../src/config';
import * as configModule from '../../src/config';
import * as vsc from 'vscode';

// Access the mock's config store
const configStore = (vsc.workspace as any)._config as Map<string, unknown>;

describe('getMaximumFileSizeBytes', () => {
  beforeEach(() => {
    configStore.clear();
  });

  it('should return default 200MB when no config set', () => {
    assert.strictEqual(getMaximumFileSizeBytes(), 200 * (2 ** 20));
  });

  it('should return configured value in bytes', () => {
    configStore.set('maxFileSize', 50);
    assert.strictEqual(getMaximumFileSizeBytes(), 50 * (2 ** 20));
  });

  it('should return 0 when configured as unlimited', () => {
    configStore.set('maxFileSize', 0);
    assert.strictEqual(getMaximumFileSizeBytes(), 0);
  });

  it('uses the safe default for non-numeric and non-finite runtime values', () => {
    configStore.set('maxFileSize', 'not-a-number');
    assert.strictEqual(getMaximumFileSizeBytes(), 200 * (2 ** 20));

    configStore.set('maxFileSize', Number.POSITIVE_INFINITY);
    assert.strictEqual(getMaximumFileSizeBytes(), 200 * (2 ** 20));
  });

  it('uses the safe default for hand-edited negative values instead of treating them as unlimited', () => {
    configStore.set('maxFileSize', -1);
    assert.strictEqual(getMaximumFileSizeBytes(), 200 * (2 ** 20));
  });
});

describe('getQueryTimeout', () => {
  beforeEach(() => {
    configStore.clear();
  });

  it('should return default 30000ms when no config set', () => {
    assert.strictEqual(getQueryTimeout(), 30000);
  });

  it('should return configured value', () => {
    configStore.set('queryTimeout', 60000);
    assert.strictEqual(getQueryTimeout(), 60000);
  });

  it('clamps hand-edited values below the configuration schema minimum', () => {
    configStore.set('queryTimeout', 0);
    assert.strictEqual(getQueryTimeout(), 1000);
  });

  it('uses the default for a non-numeric hand-edited value', () => {
    configStore.set('queryTimeout', 'not-a-number');
    assert.strictEqual(getQueryTimeout(), 30000);
  });

  it('uses the default for a non-finite hand-edited value', () => {
    configStore.set('queryTimeout', Number.POSITIVE_INFINITY);
    assert.strictEqual(getQueryTimeout(), 30000);
  });
});

describe('getMaxInlineCellBytes', () => {
  beforeEach(() => {
    configStore.clear();
  });

  it('defaults to the 1 MiB containment threshold', () => {
    const accessor = (configModule as any).getMaxInlineCellBytes;
    assert.strictEqual(typeof accessor, 'function');
    assert.strictEqual(accessor(), 1024 * 1024);
  });

  it('clamps hand-edited values so the grid can never request unlimited cells', () => {
    const accessor = (configModule as any).getMaxInlineCellBytes;
    assert.strictEqual(typeof accessor, 'function');

    configStore.set('maxInlineCellBytes', 0);
    assert.strictEqual(accessor(), 1024);
    configStore.set('maxInlineCellBytes', Number.POSITIVE_INFINITY);
    assert.strictEqual(accessor(), 1024 * 1024);
  });
});

describe('extension manifest', () => {
  it('opens GeoPackage files with the default custom editor', () => {
    const manifest = JSON.parse(
      readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')
    );
    const viewerPatterns = manifest.contributes.customEditors
      .find((editor: any) => editor.viewType === 'sqlite-explorer.view').selector
      .map((selector: any) => selector.filenamePattern);

    assert.ok(viewerPatterns.includes('*.gpkg'));
  });
});
