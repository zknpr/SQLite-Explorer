
import './vscode_mock_setup'; // Must be first
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { getMaximumFileSizeBytes } from '../../src/workerFactory';
import { mockVscode } from './mocks/vscode';

describe('workerFactory configuration helpers', () => {

    afterEach(() => {
        // Clear mock config after each test
        mockVscode.workspace._config.clear();
    });

    describe('getMaximumFileSizeBytes', () => {
        it('should return default size (200MB) when no config is set', () => {
            const result = getMaximumFileSizeBytes();
            assert.strictEqual(result, 200 * 1024 * 1024);
        });

        it('should return configured size when set', () => {
            mockVscode.workspace._config.set('sqliteExplorer.maxFileSize', 50);
            const result = getMaximumFileSizeBytes();
            assert.strictEqual(result, 50 * 1024 * 1024);
        });

        it('should return 0 when set to 0 (unlimited)', () => {
            mockVscode.workspace._config.set('sqliteExplorer.maxFileSize', 0);
            const result = getMaximumFileSizeBytes();
            assert.strictEqual(result, 0);
        });
    });
});
