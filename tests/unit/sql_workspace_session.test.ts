import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as vscode from 'vscode';
import { mockVscode } from './mocks/vscode';
import { DocumentRegistry } from '../../src/documentRegistry';
import type { DatabaseDocument } from '../../src/databaseModel';
import type { DatabaseOperations } from '../../src/core/types';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';

it('bounds SQL history/results, excludes bindings, and serves cached completions without SQLite calls', async () => {
    const opened = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
    const operations = opened.operations as WasmDatabaseEngine;
    await operations.executeQuery('CREATE TABLE items (id INTEGER, label TEXT)');
    const restorations: Array<() => void> = [];
    const replace = (object: object, key: string, value: unknown) => {
        const original = Object.getOwnPropertyDescriptor(object, key);
        restorations.push(() => { if (original) Object.defineProperty(object, key, original); else Reflect.deleteProperty(object, key); });
        Object.defineProperty(object, key, { configurable: true, writable: true, value });
    };
    const commands = new Map<string, () => Promise<void>>(), errors: string[] = [], uris: vscode.Uri[] = [];
    let sql = 'SELECT 1 AS value', parameters: string | undefined = '["bound fixture"]', queryCalls = 0;
    let history: Array<{ sql: string }> = [];
    let provider: vscode.TextDocumentContentProvider | undefined;
    let completionProvider: vscode.CompletionItemProvider | undefined;
    const groups = [{ viewColumn: 1 }];
    const document = { languageId: 'sql', isClosed: false, getText: () => sql } as vscode.TextDocument;
    const database = {
        uri: vscode.Uri.file('/workspace/session.db'), onDidDispose: () => ({ dispose() {} }),
        databaseOperations: { executeReadQuery: (...args: Parameters<DatabaseOperations['executeReadQuery']>) => {
            queryCalls++; return operations.executeReadQuery(...args);
        } }
    } as unknown as DatabaseDocument;
    let registration: vscode.Disposable | undefined;
    DocumentRegistry.set('sql-session-qa', database);
    try {
        replace(mockVscode, 'Disposable', class { constructor(private readonly callback: () => void) {} dispose() { this.callback(); } });
        replace(mockVscode, 'CompletionItem', class { constructor(public label: string, public kind: number) {} });
        replace(mockVscode, 'CompletionItemKind', { Module: 8, Class: 6, Field: 4 });
        replace(mockVscode.commands, 'registerCommand', (id: string, command: () => Promise<void>) => { commands.set(id, command); return { dispose() {} }; });
        replace(mockVscode.window, 'activeTextEditor', { document, selection: { isEmpty: true } });
        replace(mockVscode.window, 'showInputBox', async () => parameters);
        replace(mockVscode.window, 'showQuickPick', async (items: Array<{ sql: string }>) => { history = items; return undefined; });
        replace(mockVscode.window, 'showErrorMessage', async (message: string) => { errors.push(message); });
        replace(mockVscode.window, 'tabGroups', { all: groups });
        replace(mockVscode.window, 'showTextDocument', async (_document: unknown, options: vscode.TextDocumentShowOptions) => {
            let viewColumn = options.viewColumn;
            if (viewColumn === vscode.ViewColumn.Beside) {
                viewColumn = groups.length + 1;
                groups.push({ viewColumn });
            }
            return { viewColumn };
        });
        replace(mockVscode.workspace, 'openTextDocument', async (uri: vscode.Uri) => { uris.push(uri); return { uri }; });
        replace(mockVscode.workspace, 'registerTextDocumentContentProvider', (_scheme: string, value: vscode.TextDocumentContentProvider) => { provider = value; return { dispose() {} }; });
        replace(mockVscode, 'languages', { registerCompletionItemProvider: (_selector: unknown, value: vscode.CompletionItemProvider) => { completionProvider = value; return { dispose() {} }; } });
        const { registerSqlWorkspace } = await import('../../src/sqlWorkspace');
        registration = registerSqlWorkspace({} as vscode.ExtensionContext);
        const run = async (suffix: string) => { await commands.get(`sqlite-explorer.${suffix}`)!(); assert.deepEqual(errors, []); };
        for (let index = 1; index <= 51; index++) { sql = `SELECT ${index} AS value`; await run('runQuery'); }
        assert.equal(groups.length, 2, 'repeated queries must reuse their result pane instead of creating another editor group');
        await run('queryHistory'); assert.equal(history.length, 50);
        assert.equal(history[0].sql, 'SELECT 51 AS value'); assert.equal(history[49].sql, 'SELECT 2 AS value');
        const output = (index: number) => provider!.provideTextDocumentContent(uris[index], {} as vscode.CancellationToken);
        assert.match(String(await output(45)), /expired/);
        assert.match(String(await output(46)), /"47"/);
        sql = 'SELECT ? AS value'; await run('runQuery'); await run('queryHistory');
        assert.equal(history[0].sql, sql); assert.ok(history.every(item => !item.sql.includes('bound fixture')));
        const beforeCancel = queryCalls;
        parameters = undefined; sql = 'SELECT ? AS cancelled'; await run('runQuery');
        assert.equal(queryCalls, beforeCancel); await run('queryHistory'); assert.notEqual(history[0].sql, sql);
        await run('clearQueryHistory'); await run('queryHistory'); assert.equal(history.length, 0);
        for (let index = 0; index < 6; index++) { sql = `SELECT ${index} AS value /*${'x'.repeat(55000)}*/`; await run('runQuery'); }
        await run('queryHistory'); assert.equal(history.length, 4);
        assert.ok(history.reduce((sum, item) => sum + item.sql.length, 0) <= 256 * 1024);
        await run('refreshQueryCompletions');
        const beforeTyping = queryCalls;
        const items = await completionProvider!.provideCompletionItems(document, {} as vscode.Position, {} as vscode.CancellationToken, {} as vscode.CompletionContext) as vscode.CompletionItem[];
        assert.deepEqual(items.map(item => item.label), ['main', 'temp', 'items', 'id', 'label']);
        await completionProvider!.provideCompletionItems(document, {} as vscode.Position, {} as vscode.CancellationToken, {} as vscode.CompletionContext);
        assert.equal(queryCalls, beforeTyping);
    } finally {
        registration?.dispose(); DocumentRegistry.delete('sql-session-qa'); restorations.reverse().forEach(restore => restore()); operations.shutdown();
    }
});
