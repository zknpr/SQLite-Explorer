import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as vscode from 'vscode';
import { mockVscode } from './mocks/vscode';
import { DocumentRegistry } from '../../src/documentRegistry';
import type { DatabaseDocument } from '../../src/databaseModel';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';

it('binds a query opened from a database viewer to that database when another is open', async () => {
    const restorations: Array<() => void> = [];
    const replace = (object: object, key: string, value: unknown) => {
        const original = Object.getOwnPropertyDescriptor(object, key);
        restorations.push(() => { if (original) Object.defineProperty(object, key, original); else Reflect.deleteProperty(object, key); });
        Object.defineProperty(object, key, { configurable: true, writable: true, value });
    };
    const engines: WasmDatabaseEngine[] = [];
    const databases: DatabaseDocument[] = [];
    for (const name of ['database B', 'database A']) {
        const opened = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
        const engine = opened.operations as WasmDatabaseEngine;
        engines.push(engine);
        await engine.executeQuery('CREATE TABLE markers (name TEXT)');
        await engine.executeQuery('INSERT INTO markers VALUES (?)', [name]);
        const database = { uri: vscode.Uri.file(`/workspace/${name}.db`), databaseOperations: engine,
            onDidDispose: () => ({ dispose() {} }) } as unknown as DatabaseDocument;
        databases.push(database); DocumentRegistry.set(name, database);
    }
    const commands = new Map<string, (...args: unknown[]) => Promise<void>>();
    const errors: string[] = [];
    let provider: vscode.TextDocumentContentProvider | undefined;
    let sql = 'SELECT name FROM markers', resultText = '';
    const document = { languageId: 'sql', isClosed: false, getText: () => sql };
    let registration: vscode.Disposable | undefined;
    try {
        replace(mockVscode, 'Disposable', class { constructor(private callback: () => void) {} dispose() { this.callback(); } });
        replace(mockVscode, 'CompletionItem', class { constructor(public label: string, public kind: number) {} });
        replace(mockVscode, 'CompletionItemKind', { Module: 8, Class: 6, Field: 4 });
        replace(mockVscode.commands, 'registerCommand', (id: string, action: (...args: unknown[]) => Promise<void>) => { commands.set(id, action); return { dispose() {} }; });
        replace(mockVscode.window, 'showQuickPick', async (items: unknown[]) => items[0]);
        replace(mockVscode.window, 'showErrorMessage', async (message: string) => { errors.push(message); });
        replace(mockVscode.window, 'activeTextEditor', { document, selection: { isEmpty: true } });
        replace(mockVscode.window, 'showTextDocument', async () => ({ viewColumn: 2 }));
        replace(mockVscode.workspace, 'openTextDocument', async (input: vscode.Uri | { language: string }) => {
            if ('language' in input) return document;
            resultText = String(await provider!.provideTextDocumentContent(input, {} as vscode.CancellationToken));
            return { uri: input };
        });
        replace(mockVscode.workspace, 'registerTextDocumentContentProvider', (_scheme: string, value: vscode.TextDocumentContentProvider) => { provider = value; return { dispose() {} }; });
        replace(mockVscode, 'languages', { registerCompletionItemProvider: () => ({ dispose() {} }) });
        const { registerSqlWorkspace } = await import('../../src/sqlWorkspace');
        registration = registerSqlWorkspace({} as vscode.ExtensionContext);
        await commands.get('sqlite-explorer.newQuery')!(databases[1].uri);
        await commands.get('sqlite-explorer.runQuery')!();
        assert.deepEqual(errors, []);
        assert.match(resultText, /"database A"/);
        assert.doesNotMatch(resultText, /"database B"/);
        await commands.get('sqlite-explorer.newQuery')!(vscode.Uri.file('/workspace/closed.db'));
        assert.match(errors.at(-1) ?? '', /database.*closed|database.*not open/i);
    } finally {
        registration?.dispose();
        for (const name of ['database A', 'database B']) DocumentRegistry.delete(name);
        restorations.reverse().forEach(restore => restore());
        engines.forEach(engine => engine.shutdown());
    }
});
