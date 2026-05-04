import "./vscode_mock_setup";

import { test, describe, mock, beforeEach } from "node:test";
import * as assert from "node:assert";

// Now import the module under test
import { DatabaseEditorProvider } from "../../src/editorController";
import { mockVscode } from "./mocks/vscode";

describe("DatabaseEditorProvider", () => {
    let provider: DatabaseEditorProvider;
    let mockContext: any;

    beforeEach(() => {
        mockContext = {
            extensionUri: mockVscode.Uri.file("/test/path"),
            globalState: {
                get: () => undefined,
                update: () => Promise.resolve()
            }
        };
        provider = new DatabaseEditorProvider("viewType", mockContext, undefined, null, true);
    });

    test("isReadOnly returns false", () => {
        assert.strictEqual(provider.isReadOnly, false);
    });

    test("saveCustomDocument calls document.save", async () => {
        const doc: any = {
            save: mock.fn(() => Promise.resolve())
        };
        await provider.saveCustomDocument(doc, {} as any);
        assert.strictEqual(doc.save.mock.calls.length, 1);
    });

    test("saveCustomDocumentAs calls document.saveAs", async () => {
        const doc: any = {
            saveAs: mock.fn(() => Promise.resolve())
        };
        const dest = mockVscode.Uri.file("/dest/path");
        await provider.saveCustomDocumentAs(doc, dest, {} as any);
        assert.strictEqual(doc.saveAs.mock.calls.length, 1);
        assert.strictEqual(doc.saveAs.mock.calls[0].arguments[0], dest);
    });

    test("revertCustomDocument calls document.revert", async () => {
        const doc: any = {
            revert: mock.fn(() => Promise.resolve())
        };
        await provider.revertCustomDocument(doc, {} as any);
        assert.strictEqual(doc.revert.mock.calls.length, 1);
    });

    test("backupCustomDocument calls document.backup", async () => {
        const doc: any = {
            backup: mock.fn(() => Promise.resolve({ id: "backup-id", delete: () => {} }))
        };
        const dest = mockVscode.Uri.file("/backup/path");
        const res = await provider.backupCustomDocument(doc, { destination: dest } as any, {} as any);
        assert.strictEqual(doc.backup.mock.calls.length, 1);
        assert.strictEqual(doc.backup.mock.calls[0].arguments[0], dest);
        assert.strictEqual(res.id, "backup-id");
    });
});
