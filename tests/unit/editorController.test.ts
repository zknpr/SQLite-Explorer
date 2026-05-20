import './vscode_mock_setup';

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mockVscode } from './mocks/vscode';

// SupportsWriteMode in databaseModel.ts is evaluated at module-load time from
// `vsc.env.remoteName` and `CurrentExtension?.extensionKind`. Set both so the
// read-write path resolves to true regardless of which test loads databaseModel first.
(mockVscode as any).ExtensionKind = { Workspace: 2, UI: 1 };
mockVscode.env.remoteName = 'remote';
(mockVscode as any).extensions = {
    getExtension: () => ({ extensionKind: 2 })
};

// workerFactory imports threadPool which crashes due to bare `import.meta.env` at
// module load. Mock it in require cache before editorController is required.
const moduleCache = require('module')._cache;
const workerFactoryPath = require.resolve('../../src/workerFactory');
moduleCache[workerFactoryPath] = {
    id: workerFactoryPath,
    filename: workerFactoryPath,
    loaded: true,
    exports: {
        createDatabaseConnection: () => {}
    }
};

const editorControllerModule = require('../../src/editorController');
const { registerEditorProvider, DatabaseViewerProvider, DatabaseEditorProvider } = editorControllerModule;

describe('registerEditorProvider', () => {
    type RegisterCall = { viewType: string; provider: unknown; options: unknown };
    let calls: RegisterCall[];
    let originalRegister: any;

    beforeEach(() => {
        calls = [];
        originalRegister = mockVscode.window.registerCustomEditorProvider;
        (mockVscode.window as any).registerCustomEditorProvider = (
            viewType: string,
            provider: unknown,
            options: unknown
        ) => {
            calls.push({ viewType, provider, options });
            return { dispose: () => {} };
        };
    });

    afterEach(() => {
        (mockVscode.window as any).registerCustomEditorProvider = originalRegister;
    });

    const ctx = { extensionUri: mockVscode.Uri.file('/ext'), globalState: { get: () => undefined } } as any;

    it('registers DatabaseViewerProvider when readOnly=true regardless of verified', () => {
        registerEditorProvider('sqlite-explorer.view', ctx, undefined, null, { verified: true, readOnly: true });

        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].viewType, 'sqlite-explorer.view');
        assert.ok(calls[0].provider instanceof DatabaseViewerProvider);
        assert.ok(!(calls[0].provider instanceof DatabaseEditorProvider));
    });

    it('registers DatabaseViewerProvider when verified=false', () => {
        registerEditorProvider('sqlite-explorer.view', ctx, undefined, null, { verified: false, readOnly: false });

        assert.strictEqual(calls.length, 1);
        assert.ok(calls[0].provider instanceof DatabaseViewerProvider);
        assert.ok(!(calls[0].provider instanceof DatabaseEditorProvider));
    });

    it('registers DatabaseEditorProvider when verified=true and readOnly=false (write mode enabled)', () => {
        registerEditorProvider('sqlite-explorer.edit', ctx, undefined, null, { verified: true, readOnly: false });

        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].viewType, 'sqlite-explorer.edit');
        // DatabaseEditorProvider extends DatabaseViewerProvider, so check the more specific type.
        assert.ok(calls[0].provider instanceof DatabaseEditorProvider);
    });

    it('passes retainContextWhenHidden=false in webview options', () => {
        registerEditorProvider('sqlite-explorer.view', ctx, undefined, null, { verified: true, readOnly: true });

        const options = calls[0].options as { webviewOptions: { retainContextWhenHidden: boolean } };
        assert.strictEqual(options.webviewOptions.retainContextWhenHidden, false);
    });

    it('returns a disposable from registerCustomEditorProvider', () => {
        const result = registerEditorProvider('sqlite-explorer.view', ctx, undefined, null, { verified: true, readOnly: true });

        assert.ok(result && typeof result.dispose === 'function');
    });
});
