import './vscode_mock_setup';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mockVscode } from './mocks/vscode';

// Setup ExtensionKind which databaseModel needs
(mockVscode as any).ExtensionKind = { Workspace: 2, UI: 1 };
mockVscode.env.remoteName = 'remote';
(mockVscode as any).extensions = {
    getExtension: () => ({ extensionKind: 2 })
};

// We must bypass workerFactory using require hook before we do actual imports.
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

(mockVscode as any).window.registerCustomEditorProvider = () => ({ dispose: () => {} });
(mockVscode as any).window.onDidChangeActiveColorTheme = () => ({ dispose: () => {} });
(mockVscode as any).workspace.onDidChangeConfiguration = () => ({ dispose: () => {} });
(mockVscode as any).window.activeColorTheme = { kind: 1 };
(mockVscode as any).env.machineId = 'mock-machine-id';
mockVscode.env.remoteName = 'remote';

// Before requiring, mock readFileSync if necessary. Let's just import
const _editorController = require('../../src/editorController');
const DatabaseViewerProvider = _editorController.DatabaseViewerProvider;
const DatabaseEditorProvider = _editorController.DatabaseEditorProvider;
const registerEditorProvider = _editorController.registerEditorProvider;
const _databaseModel = require('../../src/databaseModel');
const DatabaseDocument = _databaseModel.DatabaseDocument;

describe('EditorController', () => {

    describe('DatabaseViewerProvider', () => {
        let provider: any;

        beforeEach(() => {
            provider = new DatabaseViewerProvider('test-view', { extensionUri: mockVscode.Uri.file('/ext'), globalState: { get: () => undefined } } as any, undefined, null, true, undefined, false);
        });

        it('isReadOnly should be true', () => {
            assert.strictEqual(provider.isReadOnly, true);
        });

        it('openCustomDocument should return a DatabaseDocument instance', async () => {
             const originalCreate = DatabaseDocument.create;

             let passedUri: any;
             DatabaseDocument.create = async (p: any, uri: any) => {
                 passedUri = uri;
                 return { uri, onDidChange: () => ({ dispose: () => {} }), onDidChangeContent: () => ({ dispose: () => {} }) } as any;
             };

             const uri = mockVscode.Uri.file('/test.db') as any;
             const doc = await provider.openCustomDocument(uri, {} as any, undefined);

             assert.strictEqual(passedUri, uri);
             assert.strictEqual(doc.uri, uri);

             DatabaseDocument.create = originalCreate;
        });

        // We can't safely test resolveCustomEditor because of import.meta.env crash on TSX runner,
        // so we'll test the other critical delegation methods
    });

    describe('DatabaseEditorProvider', () => {
        let provider: any;

        beforeEach(() => {
            provider = new DatabaseEditorProvider('test-view', { extensionUri: mockVscode.Uri.file('/ext') } as any, undefined, null, true, undefined, false);
        });

        it('isReadOnly should be false', () => {
            assert.strictEqual(provider.isReadOnly, false);
        });

        it('saveCustomDocument should delegate to document.save', async () => {
            let saveCalled = false;
            const doc = { save: async () => { saveCalled = true; } };

            await provider.saveCustomDocument(doc as any, {} as any);
            assert.strictEqual(saveCalled, true);
        });

        it('saveCustomDocumentAs should delegate to document.saveAs', async () => {
            let saveAsCalledWith: any = null;
            const doc = { saveAs: async (dest: any) => { saveAsCalledWith = dest; } };

            const destUri = mockVscode.Uri.file('/dest.db');
            await provider.saveCustomDocumentAs(doc as any, destUri as any, {} as any);
            assert.strictEqual(saveAsCalledWith, destUri);
        });

        it('revertCustomDocument should delegate to document.revert', async () => {
            let revertCalled = false;
            const doc = { revert: async () => { revertCalled = true; } };

            await provider.revertCustomDocument(doc as any, {} as any);
            assert.strictEqual(revertCalled, true);
        });

        it('backupCustomDocument should delegate to document.backup', async () => {
            let backupCalledWith: any = null;
            const doc = { backup: async (dest: any) => { backupCalledWith = dest; return {}; } };

            const destUri = mockVscode.Uri.file('/backup.db');
            await provider.backupCustomDocument(doc as any, { destination: destUri } as any, {} as any);
            assert.strictEqual(backupCalledWith, destUri);
        });
    });
});
