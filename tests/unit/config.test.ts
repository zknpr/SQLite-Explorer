import './vscode_mock_setup';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { getMaximumFileSizeBytes, getQueryTimeout } from '../../src/config';
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
});
