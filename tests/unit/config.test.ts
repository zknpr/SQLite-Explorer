import './vscode_mock_setup';
import assert from 'node:assert';
import { test, describe, beforeEach, afterEach } from 'node:test';
import * as vscode from 'vscode';
import { getQueryTimeout, getMaximumFileSizeBytes } from '../../src/config';

describe('Configuration Retrievers', () => {
    let originalGetConfiguration: any;

    beforeEach(() => {
        originalGetConfiguration = vscode.workspace.getConfiguration;
    });

    afterEach(() => {
        vscode.workspace.getConfiguration = originalGetConfiguration;
    });

    describe('getQueryTimeout', () => {
        test('should return default timeout (30000ms) when not configured', () => {
            vscode.workspace.getConfiguration = (section) => {
                assert.strictEqual(section, 'sqliteExplorer');
                return {
                    get: (key: string, defaultValue: any) => {
                        assert.strictEqual(key, 'queryTimeout');
                        return defaultValue;
                    },
                    update: () => Promise.resolve()
                } as any;
            };

            const timeout = getQueryTimeout();
            assert.strictEqual(timeout, 30000);
        });

        test('should return configured timeout when defined', () => {
            vscode.workspace.getConfiguration = (section) => {
                assert.strictEqual(section, 'sqliteExplorer');
                return {
                    get: (key: string, defaultValue: any) => {
                        assert.strictEqual(key, 'queryTimeout');
                        return 15000;
                    },
                    update: () => Promise.resolve()
                } as any;
            };

            const timeout = getQueryTimeout();
            assert.strictEqual(timeout, 15000);
        });
    });

    describe('getMaximumFileSizeBytes', () => {
        test('should return default size (200MB) when not configured', () => {
            vscode.workspace.getConfiguration = (section) => {
                assert.strictEqual(section, 'sqliteExplorer');
                return {
                    get: (key: string, defaultValue: any) => {
                        assert.strictEqual(key, 'maxFileSize');
                        return undefined; // Not configured
                    },
                    update: () => Promise.resolve()
                } as any;
            };

            const size = getMaximumFileSizeBytes();
            assert.strictEqual(size, 200 * (2 ** 20));
        });

        test('should return configured size in bytes', () => {
            vscode.workspace.getConfiguration = (section) => {
                assert.strictEqual(section, 'sqliteExplorer');
                return {
                    get: (key: string, defaultValue: any) => {
                        assert.strictEqual(key, 'maxFileSize');
                        return 50; // 50MB
                    },
                    update: () => Promise.resolve()
                } as any;
            };

            const size = getMaximumFileSizeBytes();
            assert.strictEqual(size, 50 * (2 ** 20));
        });
    });
});
