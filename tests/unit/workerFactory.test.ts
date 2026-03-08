import { test } from 'node:test';
import * as assert from 'assert';
import './vscode_mock_setup';
import { getMaximumFileSizeBytes } from '../../src/workerFactory';
import { mockVscode } from './mocks/vscode';

test('getMaximumFileSizeBytes - returns default 200MB in bytes when config is missing', () => {
    mockVscode.workspace._config.clear();

    const sizeBytes = getMaximumFileSizeBytes();

    assert.strictEqual(sizeBytes, 200 * (2 ** 20)); // 200 MB
});

test('getMaximumFileSizeBytes - returns correct bytes when maxFileSize is set', () => {
    mockVscode.workspace._config.set('maxFileSize', 500);

    const sizeBytes = getMaximumFileSizeBytes();

    assert.strictEqual(sizeBytes, 500 * (2 ** 20)); // 500 MB
});

test('getMaximumFileSizeBytes - returns 0 bytes when maxFileSize is 0 (unlimited)', () => {
    mockVscode.workspace._config.set('maxFileSize', 0);

    const sizeBytes = getMaximumFileSizeBytes();

    assert.strictEqual(sizeBytes, 0); // 0 MB
});
