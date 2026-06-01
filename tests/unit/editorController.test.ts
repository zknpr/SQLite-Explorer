import './vscode_mock_setup';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import Module from 'node:module';
import esbuild from 'esbuild';
import { mockVscode } from './mocks/vscode';
import { HostBridge } from '../../src/hostBridge';

// SupportsWriteMode in databaseModel.ts is evaluated at module-load time from
// `vsc.env.remoteName` and `CurrentExtension?.extensionKind`. Set both so the
// read-write path resolves to true regardless of which test loads databaseModel first.
// Use Object.defineProperty (not direct assignment) to mirror VS Code's readonly
// API fields — direct writes can silently no-op or throw if a field is a getter.
Object.defineProperty(mockVscode, 'ExtensionKind', {
    value: { Workspace: 2, UI: 1 }, writable: true, configurable: true,
});
Object.defineProperty(mockVscode.env, 'remoteName', {
    value: 'remote', writable: true, configurable: true,
});
Object.defineProperty(mockVscode, 'extensions', {
    value: { getExtension: () => ({ extensionKind: 2 }) }, writable: true, configurable: true,
});

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

const editorControllerPath = path.resolve(__dirname, '../../src/editorController.ts');
const editorControllerSource = fs.readFileSync(editorControllerPath, 'utf8');

function loadBrowserEditorController(supportsWriteMode = true) {
    const jsCode = esbuild.transformSync(editorControllerSource, {
        loader: 'ts',
        format: 'cjs',
        define: {
            'import.meta.env.VSCODE_BROWSER_EXT': 'true'
        }
    }).code;

    const scriptModule = new Module(editorControllerPath, module as unknown as Module);
    scriptModule.filename = editorControllerPath;
    scriptModule.paths = (Module as unknown as { _nodeModulePaths(dirname: string): string[] })
        ._nodeModulePaths(path.dirname(editorControllerPath));

    const originalRequire = Module.prototype.require;
    Module.prototype.require = function(request: string) {
        if (request === 'vscode') return mockVscode;
        if (request.endsWith('databaseModel')) {
            return {
                SupportsWriteMode: supportsWriteMode,
                IsRemoteWorkspaceMode: false,
                DatabaseDocument: class DatabaseDocument {},
                isAutoCommitEnabled: () => false
            };
        }
        return originalRequire.call(this, request);
    };

    try {
        (scriptModule as unknown as { _compile(code: string, filename: string): void })
            ._compile(jsCode, editorControllerPath);
    } finally {
        Module.prototype.require = originalRequire;
    }

    return scriptModule.exports as typeof import('../../src/editorController');
}

describe('registerEditorProvider', () => {
    type RegisterCall = { viewType: string; provider: unknown; options: unknown };
    let calls: RegisterCall[];
    let originalRegister: any;

    beforeEach(() => {
        calls = [];
        originalRegister = (mockVscode.window as any).registerCustomEditorProvider;
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

    it('registers the read-write provider in browser mode when write mode is supported', () => {
        const {
            registerEditorProvider: registerBrowserEditorProvider,
            DatabaseEditorProvider: BrowserDatabaseEditorProvider
        } = loadBrowserEditorController(true);

        registerBrowserEditorProvider('sqlite-explorer.edit', ctx, undefined, null, {
            verified: true,
            readOnly: false
        });

        assert.strictEqual(calls.length, 1);
        assert.ok(calls[0].provider instanceof BrowserDatabaseEditorProvider);

        const bridge = new HostBridge(calls[0].provider as any, {} as any);
        assert.strictEqual(bridge.isReadOnly, false);
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
