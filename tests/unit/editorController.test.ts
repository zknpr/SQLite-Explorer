import './vscode_mock_setup'; // Must be first

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as vsc from 'vscode';

// We must mock import.meta for TSX
Object.defineProperty(globalThis, 'import', {
  value: {
    meta: {
      env: {
        VSCODE_BROWSER_EXT: false
      }
    }
  }
});

import { registerEditorProvider, DatabaseEditorProvider, DatabaseViewerProvider } from '../../src/editorController';

describe('editorController', () => {
    it('registerEditorProvider should register the custom editor provider', () => {
        let called = false;
        let registeredViewType = '';
        let registeredProvider: any;
        let registeredOptions: any;

        (vsc.window as any).registerCustomEditorProvider = (viewType: string, provider: any, options: any) => {
            called = true;
            registeredViewType = viewType;
            registeredProvider = provider;
            registeredOptions = options;
            return { dispose: () => {} };
        };

        const context = {} as any;
        registerEditorProvider('test-view', context, undefined, null, { verified: true });

        assert.ok(called, 'registerCustomEditorProvider was not called');
        assert.strictEqual(registeredViewType, 'test-view', 'viewType is incorrect');
        assert.ok(registeredProvider instanceof DatabaseEditorProvider || registeredProvider instanceof DatabaseViewerProvider, 'provider is not a recognized type');

        assert.ok(registeredOptions, 'options not provided');
        assert.strictEqual(registeredOptions.supportsMultipleEditorsPerDocument, true);
        assert.strictEqual(registeredOptions.webviewOptions.retainContextWhenHidden, false);
        assert.strictEqual(registeredOptions.webviewOptions.enableFindWidget, false);
    });

    it('registerEditorProvider should register a Viewer provider if readOnly is true', () => {
        let registeredProvider: any;

        (vsc.window as any).registerCustomEditorProvider = (viewType: string, provider: any, options: any) => {
            registeredProvider = provider;
            return { dispose: () => {} };
        };

        const context = {} as any;
        // Even if verified is true, readOnly overrides to Viewer
        registerEditorProvider('test-view', context, undefined, null, { verified: true, readOnly: true });

        assert.ok(registeredProvider instanceof DatabaseViewerProvider, 'provider should be DatabaseViewerProvider when readOnly is true');
        assert.strictEqual(registeredProvider.isReadOnly, true);
    });

    it('registerEditorProvider should register an Editor provider if not readOnly', () => {
        let registeredProvider: any;

        (vsc.window as any).registerCustomEditorProvider = (viewType: string, provider: any, options: any) => {
            registeredProvider = provider;
            return { dispose: () => {} };
        };

        const context = {} as any;
        registerEditorProvider('test-view', context, undefined, null, { verified: true, readOnly: false });

        assert.ok(registeredProvider instanceof DatabaseEditorProvider, 'provider should be DatabaseEditorProvider when not readOnly and verified');
        assert.strictEqual(registeredProvider.isReadOnly, false);
    });
});
