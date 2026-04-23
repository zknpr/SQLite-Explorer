import './vscode_mock_setup';

// Mock import.meta.env for tests
(globalThis as any).import = { meta: { env: {} } };

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { DatabaseEditorProvider, registerEditorProvider, DatabaseViewerProvider } from '../../src/editorController';
import * as vsc from 'vscode';
import { mockVscode } from './mocks/vscode';

describe('DatabaseEditorProvider', () => {
    it('should correctly report isReadOnly as false', () => {
        const provider = new DatabaseEditorProvider(
            'test-view-type',
            {} as vsc.ExtensionContext,
            undefined,
            null,
            true
        );

        assert.strictEqual(provider.isReadOnly, false);
    });
});

describe('DatabaseViewerProvider', () => {
    it('should correctly report isReadOnly as true', () => {
        const provider = new DatabaseViewerProvider(
            'test-view-type',
            {} as vsc.ExtensionContext,
            undefined,
            null,
            true
        );

        assert.strictEqual(provider.isReadOnly, true);
    });
});

describe('registerEditorProvider', () => {
    it('should register CustomEditorProvider properly', () => {
        let registeredType = '';
        let registeredProvider: any = null;

        const originalRegister = vsc.window.registerCustomEditorProvider;
        vsc.window.registerCustomEditorProvider = (viewType, provider, options) => {
            registeredType = viewType;
            registeredProvider = provider;
            return { dispose: () => {} };
        };

        try {
            const result = registerEditorProvider(
                'sqlite-viewer',
                {} as vsc.ExtensionContext,
                undefined,
                null,
                { verified: true }
            );

            assert.strictEqual(registeredType, 'sqlite-viewer');
            assert.ok(registeredProvider instanceof DatabaseViewerProvider);
            assert.ok(result !== undefined);
        } finally {
            vsc.window.registerCustomEditorProvider = originalRegister;
        }
    });
});
