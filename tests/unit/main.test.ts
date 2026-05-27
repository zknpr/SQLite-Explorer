import './vscode_mock_setup';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import Module from 'module';
import path from 'path';

// Fix TSX transformer replacing import.meta.env by mocking workerFactory completely.
const workerFactoryPath = path.resolve(__dirname, '../../src/workerFactory.ts');
require('module')._cache[workerFactoryPath] = {
  id: workerFactoryPath,
  filename: workerFactoryPath,
  loaded: true,
  exports: {
    createDatabaseConnection: async () => ({ connection: {}, dispose: () => {} }),
  }
};

// Fix getExtension error by extending the mock
import { mockVscode } from './mocks/vscode';
Object.defineProperty(mockVscode, 'extensions', {
    value: { getExtension: () => ({ extensionKind: 2 }) }, writable: true, configurable: true,
});
Object.defineProperty(mockVscode, 'ExtensionKind', {
    value: { Workspace: 2, UI: 1 }, writable: true, configurable: true,
});

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
    if (request === '@vscode/extension-telemetry') {
        return {
            TelemetryReporter: class {
                constructor() {}
                sendTelemetryEvent() {}
                sendTelemetryErrorEvent() {}
                dispose() {}
            }
        };
    }

    if (request === './workerFactory' || request === '../workerFactory') {
        return {
            createDatabaseConnection: async () => ({ connection: {}, dispose: () => {} }),
        };
    }

    return originalLoad.apply(this, arguments);
};

const main = require('../../src/main');

describe('main.ts', () => {
  it('should have a deactivate function that can be called without errors', () => {
    assert.doesNotThrow(() => {
      main.deactivate();
    });
  });
});
