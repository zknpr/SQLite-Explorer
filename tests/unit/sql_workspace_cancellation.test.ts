import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as vscode from 'vscode';
import { mockVscode } from './mocks/vscode';
import { DocumentRegistry } from '../../src/documentRegistry';
import type { DatabaseDocument } from '../../src/databaseModel';

for (const command of ['runQuery', 'explainQuery']) {
    for (const outcome of ['pre-abort', 'signal-abort', 'backend-abort', 'late-abort', 'database-close', 'sql-error', 'timeout']) {
        it(`${command} handles ${outcome} without retaining cancelled results or hiding query failures`, async () => {
            const restorations: Array<() => void> = [];
            const replace = (object: object, key: string, value: unknown) => {
                const original = Object.getOwnPropertyDescriptor(object, key);
                restorations.push(() => { if (original) Object.defineProperty(object, key, original); else Reflect.deleteProperty(object, key); });
                Object.defineProperty(object, key, { configurable: true, writable: true, value });
            };
            const commands = new Map<string, () => Promise<void>>();
            const errors: string[] = [];
            let cancel = () => {}, close = () => {};
            let cancelDisposals = 0, closeDisposals = 0, queries = 0, outputs = 0;
            let history: unknown[] = [];
            const document = { languageId: 'sql', isClosed: false, getText: () => 'SELECT 1 AS value' } as vscode.TextDocument;
            const database = {
                uri: vscode.Uri.file('/workspace/cancellation.db'),
                onDidDispose: (listener: () => void) => { close = listener; return { dispose() { closeDisposals++; } }; },
                databaseOperations: {
                    executeReadQuery: async (_sql: string, _params: unknown[], explain: boolean, signal: AbortSignal) => {
                        queries++;
                        assert.equal(explain, command === 'explainQuery');
                        if (outcome === 'signal-abort') {
                            return await new Promise((_resolve, reject) => {
                                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                                queueMicrotask(cancel);
                            });
                        }
                        if (outcome === 'backend-abort') throw new DOMException('The query was cancelled.', 'AbortError');
                        if (outcome === 'late-abort') cancel();
                        if (outcome === 'database-close') {
                            DocumentRegistry.delete('sql-cancellation-qa');
                            close();
                            // Native backends can reject with an ordinary Error after interruption.
                            throw new Error('interrupted');
                        }
                        if (outcome === 'sql-error') throw new Error('no such table: missing');
                        if (outcome === 'timeout') throw new Error('Query timed out');
                        return { columns: ['value'], rows: [[1]] };
                    }
                }
            } as unknown as DatabaseDocument;
            let registration: vscode.Disposable | undefined;
            DocumentRegistry.set('sql-cancellation-qa', database);
            try {
                replace(mockVscode, 'Disposable', class { constructor(private readonly callback: () => void) {} dispose() { this.callback(); } });
                replace(mockVscode.commands, 'registerCommand', (id: string, action: () => Promise<void>) => { commands.set(id, action); return { dispose() {} }; });
                replace(mockVscode.window, 'activeTextEditor', { document, selection: { isEmpty: true } });
                replace(mockVscode.window, 'withProgress', async (_options: unknown, action: (progress: unknown, token: vscode.CancellationToken) => Promise<void>) => action({}, {
                    isCancellationRequested: outcome === 'pre-abort',
                    onCancellationRequested: (listener: (event: unknown) => unknown) => { cancel = () => { listener(undefined); }; return { dispose() { cancelDisposals++; } }; }
                }));
                replace(mockVscode.window, 'showErrorMessage', async (message: string) => { errors.push(message); });
                replace(mockVscode.window, 'showQuickPick', async (items: unknown[]) => { history = items; return undefined; });
                replace(mockVscode.window, 'showTextDocument', async () => { outputs++; return { viewColumn: 2 }; });
                replace(mockVscode.workspace, 'openTextDocument', async (uri: vscode.Uri) => ({ uri }));
                replace(mockVscode.workspace, 'registerTextDocumentContentProvider', () => ({ dispose() {} }));
                replace(mockVscode, 'languages', { registerCompletionItemProvider: () => ({ dispose() {} }) });
                const { registerSqlWorkspace } = await import('../../src/sqlWorkspace');
                registration = registerSqlWorkspace({} as vscode.ExtensionContext);
                await commands.get(`sqlite-explorer.${command}`)!();
                const expectedErrors = outcome === 'sql-error' ? ['no such table: missing'] : outcome === 'timeout' ? ['Query timed out'] : [];
                assert.deepEqual(errors, expectedErrors, 'user cancellation is quiet; SQL errors and deadlines remain visible');
                assert.equal(queries, outcome === 'pre-abort' ? 0 : 1);
                assert.equal(outputs, 0);
                await commands.get('sqlite-explorer.queryHistory')!();
                assert.deepEqual(history, []);
                assert.equal(cancelDisposals, 1);
                assert.equal(closeDisposals, 1);
            } finally {
                registration?.dispose();
                DocumentRegistry.delete('sql-cancellation-qa');
                restorations.reverse().forEach(restore => restore());
            }
        });
    }
}
