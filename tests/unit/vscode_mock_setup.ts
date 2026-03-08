
import Module from 'module';
import { mockVscode } from './mocks/vscode';

// @ts-ignore
const originalLoad = Module._load;

// @ts-ignore
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return mockVscode;
    }
    return originalLoad(request, parent, isMain);
};

mockVscode.extensions = {
    getExtension: () => ({ packageJSON: { version: '1.0.0' }, extensionUri: mockVscode.Uri.file('/fake/path') })
};

// Polyfill import.meta.env for tsx runner
// @ts-ignore
if (typeof process !== 'undefined') {
  // @ts-ignore
  globalThis.import = globalThis.import || {};
  // @ts-ignore
  globalThis.import.meta = globalThis.import.meta || {};
  // @ts-ignore
  globalThis.import.meta.env = globalThis.import.meta.env || { VSCODE_BROWSER_EXT: false };
}
