import './vscode_mock_setup';
import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import path from 'path';

// Fix import.meta.env by adding it globally since we know workerFactory is trying to access it
(globalThis as any).import = { meta: { env: { VSCODE_BROWSER_EXT: false } } };

// Intercept TSX compilation using module cache
const baseDir = path.resolve(__dirname, '..', '..');
require('module')._cache[path.resolve(baseDir, 'src/workerFactory.ts')] = {
    id: path.resolve(baseDir, 'src/workerFactory.ts'),
    filename: path.resolve(baseDir, 'src/workerFactory.ts'),
    loaded: true,
    exports: { getWorker: () => {} }
};

require('module')._cache[path.resolve(baseDir, 'src/editorController.ts')] = {
    id: path.resolve(baseDir, 'src/editorController.ts'),
    filename: path.resolve(baseDir, 'src/editorController.ts'),
    loaded: true,
    exports: { registerEditorProvider: () => ({ dispose: () => {} }) }
};

require('module')._cache[path.resolve(baseDir, 'src/tableExporter.ts')] = {
    id: path.resolve(baseDir, 'src/tableExporter.ts'),
    filename: path.resolve(baseDir, 'src/tableExporter.ts'),
    loaded: true,
    exports: { exportTableCommand: () => {} }
};

require('module')._cache[path.resolve(baseDir, 'src/virtualFileSystem.ts')] = {
    id: path.resolve(baseDir, 'src/virtualFileSystem.ts'),
    filename: path.resolve(baseDir, 'src/virtualFileSystem.ts'),
    loaded: true,
    exports: { SQLiteFileSystemProvider: class {} }
};

import { mockVscode } from './mocks/vscode';

// Ensure mockVscode properties are completely overridable functions
(mockVscode.commands as any).registerCommand = () => ({ dispose: () => {} });
(mockVscode.commands as any).executeCommand = () => Promise.resolve();
(mockVscode.workspace as any).registerFileSystemProvider = () => ({ dispose: () => {} });
(mockVscode.window as any).createOutputChannel = () => ({ dispose: () => {} });
(mockVscode.window as any).registerCustomEditorProvider = () => ({ dispose: () => {} });
(mockVscode as any).ConfigurationTarget = { Global: 1 };
(mockVscode.workspace as any).getConfiguration = () => {
    return {
        get: () => ({}),
        update: () => Promise.resolve()
    };
};

// Mock telemetry via _load
import Module from 'module';
const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
    if (request === '@vscode/extension-telemetry') {
        return {
            TelemetryReporter: class {
                constructor() {}
                dispose() {}
            }
        };
    }
    return originalLoad(request, parent, isMain);
};

// Let's import config to see the real ID strings
import * as config from '../../src/config';

// Let's import main via require!
const main = require('../../src/main');
const vsc = require('vscode');

describe('main.ts', () => {
    let mockContext: any;

    beforeEach(() => {
        mockContext = {
            subscriptions: [],
            globalState: {
                _store: new Map(),
                get(key: string, defaultValue?: any) {
                    return this._store.has(key) ? this._store.get(key) : defaultValue;
                },
                update(key: string, value: any) {
                    this._store.set(key, value);
                    return Promise.resolve();
                },
                setKeysForSync: mock.fn()
            }
        };

        // Reset vscode mocks
        mock.method(vsc.commands, 'registerCommand', (id: string, cb: any) => {
            // execute callbacks for coverage if it's the refresh command
            if (id === `${config.ExtensionId}.refresh`) cb();
            return { dispose: () => {} };
        });
        mock.method(vsc.commands, 'executeCommand', () => Promise.resolve());
        mock.method(vsc.workspace, 'registerFileSystemProvider', () => ({ dispose: () => {} }));
        mock.method(vsc.window, 'createOutputChannel', () => ({ dispose: () => {} } as any));
        mock.method(vsc.window, 'registerCustomEditorProvider', () => ({ dispose: () => {} }));
        mock.method(vsc.workspace, 'getConfiguration', () => {
            return {
                get: mock.fn(() => ({})),
                update: mock.fn(() => Promise.resolve())
            } as any;
        });
        mock.method(vsc.extensions, 'getExtension', () => ({ packageJSON: { version: '1.0.0' } } as any));
    });

    afterEach(() => {
        mock.reset();
    });

    it('should deactivate without throwing', () => {
        assert.doesNotThrow(() => main.deactivate());
    });

    it('should run activation sequence successfully', async () => {
        await assert.doesNotReject(main.activate(mockContext));

        assert(mockContext.subscriptions.length > 0);
        assert.strictEqual(mockContext.globalState.setKeysForSync.mock.calls.length, 1);
        assert.ok(mockContext.globalState.get(config.FirstInstallMs) !== undefined);
        assert.strictEqual(mockContext.globalState.get(config.FileNestingPatternsAdded), true);
    });

    it('should not update firstInstall if already installed', async () => {
        mockContext.globalState.update(config.FirstInstallMs, 12345);
        await main.activate(mockContext);
        assert.strictEqual(mockContext.globalState.get(config.FirstInstallMs), 12345);
    });

    it('should not add file nesting patterns again if already added', async () => {
        mockContext.globalState.update(config.FileNestingPatternsAdded, true);
        const configUpdateMock = mock.fn(() => Promise.resolve());
        mock.method(vsc.workspace, 'getConfiguration', () => {
            return {
                get: mock.fn(() => ({})),
                update: configUpdateMock
            } as any;
        });

        await main.activate(mockContext);

        assert.strictEqual(configUpdateMock.mock.calls.length, 0);
    });

    it('should add file nesting patterns with existing ones', async () => {
        const configUpdateMock = mock.fn(() => Promise.resolve());
        mock.method(vsc.workspace, 'getConfiguration', () => {
            return {
                get: mock.fn(() => ({ "*.txt": "test.txt" })),
                update: configUpdateMock
            } as any;
        });

        await main.activate(mockContext);

        assert.strictEqual(configUpdateMock.mock.calls.length, 1);
        const callArgs = configUpdateMock.mock.calls[0].arguments as any[];
        assert.strictEqual(callArgs[0], 'patterns');
        // The actual value in codebase may be different, we should check it
        assert.ok(callArgs[1]['*.sqlite']);
        assert.strictEqual(callArgs[1]['*.txt'], 'test.txt');
    });

    it('should update current extension version in global state', async () => {
        mock.method(vsc.extensions, 'getExtension', () => ({ packageJSON: { version: '2.5.0' } } as any));
        await main.activate(mockContext);
        assert.strictEqual(mockContext.globalState.get(config.FullExtensionId), '2.5.0');
    });

    it('should skip updating extension version if getExtension returns undefined', async () => {
        mock.method(vsc.extensions, 'getExtension', () => undefined);
        await main.activate(mockContext);
        assert.strictEqual(mockContext.globalState.get(config.FullExtensionId), undefined);
    });

    it('should skip updating extension version if packageJSON is missing', async () => {
        mock.method(vsc.extensions, 'getExtension', () => ({}));
        await main.activate(mockContext);
        assert.strictEqual(mockContext.globalState.get(config.FullExtensionId), undefined);
    });

    it('should register commands correctly', async () => {
        const registerCmdSpy = mock.method(vsc.commands, 'registerCommand');
        const executeCmdSpy = mock.method(vsc.commands, 'executeCommand');
        await main.activate(mockContext);

        // Find refresh command call
        const refreshCall = registerCmdSpy.mock.calls.find((call: any) => call.arguments[0] === `${config.ExtensionId}.refresh`);
        assert.ok(refreshCall);
        assert.strictEqual(executeCmdSpy.mock.calls.length, 1);
        assert.strictEqual(executeCmdSpy.mock.calls[0].arguments[0], 'workbench.action.webview.reloadWebviewAction');

        // Find export table command call
        const exportCall = registerCmdSpy.mock.calls.find((call: any) => call.arguments[0] === `${config.ExtensionId}.exportTable`);
        assert.ok(exportCall);

        // Execute export callback for coverage
        exportCall.arguments[1]({} as any, [], undefined, undefined, undefined, undefined);
    });

    it('should activate providers successfully', async () => {
        const createOutputChannelSpy = mock.method(vsc.window, 'createOutputChannel');
        const registerFSSpy = mock.method(vsc.workspace, 'registerFileSystemProvider');

        await main.activateProviders(mockContext);

        assert.strictEqual(createOutputChannelSpy.mock.calls[0].arguments[0], config.Title);
        assert.strictEqual(createOutputChannelSpy.mock.calls[0].arguments[1], 'sql');
        assert.strictEqual(registerFSSpy.mock.calls[0].arguments[0], config.UriScheme);
        assert.ok(main.GlobalOutputChannel);
    });
});
