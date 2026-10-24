import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { promises as fsPromises, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';
import * as vscode from 'vscode';
import { mockVscode } from './mocks/vscode';
import { DocumentRegistry } from '../../src/documentRegistry';
import type { DatabaseDocument } from '../../src/databaseModel';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { exportTableCommand } from '../../src/tableExporter';
import { plainNotificationText, withPlainErrors } from '../../src/notificationText';

// The pattern VS Code parses extension notifications, modal messages and
// progress titles with (microsoft/vscode src/vs/base/common/linkedText.ts).
// A match is a clickable link; a command: link runs with the link's arguments.
const VSCODE_LINK = /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^\)\s]+)(?: (["'])(.+?)(\3))?\)/gi;
const linksIn = (text: string): string[] => [...text.matchAll(VSCODE_LINK)].map(match => match[2]);

// A crafted database: a view named as a command link, selecting a missing
// column that is also named as one, so reading the view fails with an error
// quoting the name.
const COMMAND = 'command:workbench.action.showCommands';
const VIEW = `[Show export](${COMMAND})`;
const COLUMN = `[Open details](${COMMAND})`;

async function openCraftedDatabase(): Promise<WasmDatabaseEngine> {
    const opened = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
    const engine = opened.operations as WasmDatabaseEngine;
    await engine.executeQuery('CREATE TABLE t(a)');
    await engine.executeQuery(`CREATE VIEW "${VIEW}" AS SELECT t.\`${COLUMN}\` FROM t`);
    return engine;
}

function replaceProperty(restorations: Array<() => void>, object: object, key: string, value: unknown): void {
    const original = Object.getOwnPropertyDescriptor(object, key);
    restorations.push(() => {
        if (original) Object.defineProperty(object, key, original);
        else Reflect.deleteProperty(object, key);
    });
    Object.defineProperty(object, key, { configurable: true, writable: true, value });
}

describe('notification text from a crafted database', () => {
    it('plainNotificationText leaves VS Code no link and keeps the text', () => {
        const message = `Export failed: no such column: t.${COLUMN}`;

        assert.deepEqual(linksIn(message), [COMMAND], 'control arm: VS Code finds the link in the raw text');
        assert.deepEqual(linksIn(plainNotificationText(message)), []);
        assert.equal(plainNotificationText(message).replaceAll('​', ''), message);
        assert.equal(plainNotificationText('Export failed: disk full'), 'Export failed: disk full');
    });

    it('shows a failed export of a crafted view without a link', async () => {
        const restorations: Array<() => void> = [];
        const engine = await openCraftedDatabase();
        const scratch = await fsPromises.mkdtemp(path.join(process.cwd(), '.notification-links-'));
        const docUri = mockVscode.Uri.parse('vscode-sqlite://notification-links.db');
        const errors: string[] = [];
        const titles: string[] = [];

        try {
            replaceProperty(restorations, mockVscode.window, 'showErrorMessage', async (message: string) => { errors.push(message); });
            replaceProperty(restorations, mockVscode.window, 'showSaveDialog', async () => mockVscode.Uri.file(path.join(scratch, 'export.csv')));
            const withProgress = mockVscode.window.withProgress;
            replaceProperty(restorations, mockVscode.window, 'withProgress', (options: { title?: string }, task: Function) => {
                titles.push(options.title ?? '');
                return withProgress(options, task);
            });
            replaceProperty(restorations, console, 'error', () => {});
            DocumentRegistry.set('notification-links', { uri: docUri, databaseOperations: engine } as unknown as DatabaseDocument);

            const result = await exportTableCommand(
                {} as vscode.ExtensionContext,
                undefined,
                { table: VIEW, uri: docUri.toString() },
                [COLUMN],
                undefined,
                undefined,
                { format: 'csv' }
            );

            assert.equal(result.success, false);
            assert.equal(errors.length, 1);
            assert.match(errors[0], /no such column/, 'control arm: the error quotes the crafted column');
            assert.deepEqual(linksIn(errors[0]), []);
            assert.ok(titles.length > 0, 'control arm: the export showed a progress title');
            assert.deepEqual(titles.flatMap(linksIn), []);
        } finally {
            DocumentRegistry.delete('notification-links');
            restorations.reverse().forEach(restore => restore());
            engine.shutdown();
            await fsPromises.rm(scratch, { recursive: true, force: true });
        }
    });

    it('shows a failed query console read of a crafted view without a link', async () => {
        const restorations: Array<() => void> = [];
        const engine = await openCraftedDatabase();
        const database = {
            uri: vscode.Uri.file('/workspace/crafted.db'),
            databaseOperations: engine,
            onDidDispose: () => ({ dispose() {} })
        } as unknown as DatabaseDocument;
        const commands = new Map<string, (...args: unknown[]) => Promise<void>>();
        const errors: string[] = [];
        const document = { languageId: 'sql', isClosed: false, getText: () => `SELECT * FROM "${VIEW}"` };
        let registration: vscode.Disposable | undefined;

        try {
            DocumentRegistry.set('notification-links-console', database);
            replaceProperty(restorations, mockVscode, 'Disposable', class { constructor(private callback: () => void) {} dispose() { this.callback(); } });
            replaceProperty(restorations, mockVscode, 'CompletionItem', class { constructor(public label: string, public kind: number) {} });
            replaceProperty(restorations, mockVscode, 'CompletionItemKind', { Module: 8, Class: 6, Field: 4 });
            replaceProperty(restorations, mockVscode.commands, 'registerCommand', (id: string, action: (...args: unknown[]) => Promise<void>) => {
                commands.set(id, action);
                return { dispose() {} };
            });
            replaceProperty(restorations, mockVscode.window, 'showQuickPick', async (items: unknown[]) => items[0]);
            replaceProperty(restorations, mockVscode.window, 'showErrorMessage', async (message: string) => { errors.push(message); });
            replaceProperty(restorations, mockVscode.window, 'activeTextEditor', { document, selection: { isEmpty: true } });
            replaceProperty(restorations, mockVscode.window, 'showTextDocument', async () => ({ viewColumn: 2 }));
            replaceProperty(restorations, mockVscode.workspace, 'openTextDocument', async () => document);
            replaceProperty(restorations, mockVscode.workspace, 'registerTextDocumentContentProvider', () => ({ dispose() {} }));
            replaceProperty(restorations, mockVscode, 'languages', { registerCompletionItemProvider: () => ({ dispose() {} }) });
            const { registerSqlWorkspace } = await import('../../src/sqlWorkspace');
            registration = registerSqlWorkspace({} as vscode.ExtensionContext);

            await commands.get('sqlite-explorer.newQuery')!(database.uri);
            await commands.get('sqlite-explorer.runQuery')!();

            assert.ok(errors.length > 0, 'control arm: the failed read was reported');
            for (const error of errors) {
                assert.match(error, /no such column/, 'control arm: the error quotes the crafted column');
                assert.deepEqual(linksIn(error), []);
            }
        } finally {
            registration?.dispose();
            DocumentRegistry.delete('notification-links-console');
            restorations.reverse().forEach(restore => restore());
            engine.shutdown();
        }
    });
});

// Errors thrown back to VS Code are shown by VS Code itself ("Failed to save
// '…': <message>"). VS Code 1.110 to 1.140 parse links in those messages too.
describe('errors handed back to VS Code', () => {
    const CRAFTED_ERROR = `no such collation sequence: ${COLUMN}`;

    it('disarms a failed save through the registered editor provider', async () => {
        const restorations: Array<() => void> = [];
        let registered: vscode.CustomEditorProvider | undefined;
        try {
            replaceProperty(restorations, mockVscode.window, 'registerCustomEditorProvider', (_viewType: string, provider: vscode.CustomEditorProvider) => {
                registered = provider;
                return { dispose() {} };
            });
            const context = { extensionUri: mockVscode.Uri.file('/ext'), globalState: { get: () => undefined } } as unknown as vscode.ExtensionContext;
            // Imported here: a static import would load sqlWorkspace before the
            // query console test installs the vscode.languages mock it reads.
            const { registerEditorProvider } = await import('../../src/editorController');
            registerEditorProvider('sqlite-explorer.view', context, undefined, null, { verified: true, readOnly: false });
            assert.ok(registered, 'control arm: the provider was registered');

            const failure = new Error(CRAFTED_ERROR);
            const document = { save: async () => { throw failure; } } as unknown as vscode.CustomDocument;
            await assert.rejects(
                async () => registered!.saveCustomDocument(document, {} as vscode.CancellationToken),
                (error: unknown) => {
                    assert.equal(error, failure, 'the same error object reaches VS Code');
                    assert.match((error as Error).message, /no such collation sequence/);
                    assert.deepEqual(linksIn((error as Error).message), []);
                    return true;
                }
            );
        } finally {
            restorations.reverse().forEach(restore => restore());
        }
    });

    it('withPlainErrors keeps private fields, events, error classes and absent methods', async () => {
        class FileSystemFailure extends Error { readonly code = 'Unavailable'; }
        class Provider {
            readonly #message = CRAFTED_ERROR;
            readonly onDidChange = (listener: () => void) => { listener(); return { dispose() {} }; };
            async readFile(): Promise<Uint8Array> { throw new FileSystemFailure(this.#message); }
            watch(): string { return this.#message; }
        }
        const provider = withPlainErrors(new Provider(), ['readFile', 'writeFile']);
        let fired = false;

        provider.onDidChange(() => { fired = true; });
        assert.equal(fired, true);
        assert.equal(provider.watch(), CRAFTED_ERROR, 'an unlisted method still reaches private fields');
        assert.equal('writeFile' in provider, false, 'a listed method the provider lacks stays absent');
        await assert.rejects(provider.readFile(), (error: unknown) => {
            assert.ok(error instanceof FileSystemFailure);
            assert.equal(error.code, 'Unavailable');
            assert.deepEqual(linksIn(error.message), []);
            return true;
        });
    });
});

// Every notification, modal message, modal detail and progress title must be
// literal text or pass through plainNotificationText, so a new call site that
// shows database text cannot reintroduce links.
describe('notification call sites', () => {
    const NOTIFY = new Set(['showErrorMessage', 'showWarningMessage', 'showInformationMessage']);
    // Commands and providers whose errors VS Code shows itself.
    const REGISTRATIONS = new Map([
        ['registerCommand', 'plainErrors'],
        ['registerCustomEditorProvider', 'withPlainErrors'],
        ['registerFileSystemProvider', 'withPlainErrors']
    ]);
    const sourceRoot = path.resolve(__dirname, '..', '..', 'src');

    function sourceFiles(directory: string): string[] {
        return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) return sourceFiles(full);
            return entry.name.endsWith('.ts') ? [full] : [];
        });
    }

    // A string literal, a template without substitutions, l10n.t of a literal
    // without placeholders, a conditional or concatenation of such texts, or a
    // call to plainNotificationText.
    function isPlainText(node: ts.Expression): boolean {
        if (ts.isParenthesizedExpression(node)) return isPlainText(node.expression);
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
        if (ts.isConditionalExpression(node)) return isPlainText(node.whenTrue) && isPlainText(node.whenFalse);
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
            return isPlainText(node.left) && isPlainText(node.right);
        }
        if (!ts.isCallExpression(node)) return false;
        const callee = node.expression;
        if (ts.isIdentifier(callee) && callee.text === 'plainNotificationText') return true;
        return ts.isPropertyAccessExpression(callee)
            && callee.name.text === 't'
            && callee.expression.getText().endsWith('l10n')
            && node.arguments.length === 1
            && isPlainText(node.arguments[0]);
    }

    function textProperty(argument: ts.Expression | undefined, name: string): ts.Expression | undefined {
        if (!argument || !ts.isObjectLiteralExpression(argument)) return undefined;
        for (const property of argument.properties) {
            if (ts.isPropertyAssignment(property) && property.name.getText() === name) return property.initializer;
        }
        return undefined;
    }

    it('pass non-literal text through plainNotificationText and register through the error wrappers', () => {
        const offenders: string[] = [];
        let notificationCalls = 0;
        let registrations = 0;
        let historyEdits = 0;

        for (const file of sourceFiles(sourceRoot)) {
            const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
            const check = (node: ts.Expression | undefined, what: string, at: ts.Node) => {
                if (node && !isPlainText(node)) {
                    const { line } = source.getLineAndCharacterOfPosition(at.getStart());
                    offenders.push(`${path.relative(sourceRoot, file)}:${line + 1} ${what}`);
                }
            };
            const visit = (node: ts.Node) => {
                if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
                    && node.expression.expression.getText().endsWith('window')) {
                    const method = node.expression.name.text;
                    if (NOTIFY.has(method)) {
                        notificationCalls++;
                        check(node.arguments[0], `${method} message`, node);
                        check(textProperty(node.arguments[1], 'detail'), `${method} detail`, node);
                    } else if (method === 'withProgress') {
                        check(textProperty(node.arguments[0], 'title'), 'withProgress title', node);
                    }
                }
                // A custom-document edit: VS Code shows a rejected undo or redo itself.
                if (ts.isObjectLiteralExpression(node)) {
                    const history = node.properties.filter(property =>
                        !ts.isSpreadAssignment(property) && ['undo', 'redo'].includes(property.name.getText()));
                    if (history.length === 2) {
                        historyEdits++;
                        for (const property of history) {
                            const value = ts.isPropertyAssignment(property) ? property.initializer : undefined;
                            if (!value || !ts.isCallExpression(value) || value.expression.getText() !== 'plainErrors') {
                                const { line } = source.getLineAndCharacterOfPosition(property.getStart());
                                offenders.push(`${path.relative(sourceRoot, file)}:${line + 1} ${property.name!.getText()} without plainErrors`);
                            }
                        }
                    }
                }
                if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
                    const method = node.expression.name.text;
                    const wrapper = REGISTRATIONS.get(method);
                    if (wrapper) {
                        registrations++;
                        const handler = node.arguments[1];
                        if (!handler || !ts.isCallExpression(handler) || handler.expression.getText() !== wrapper) {
                            const { line } = source.getLineAndCharacterOfPosition(node.getStart());
                            offenders.push(`${path.relative(sourceRoot, file)}:${line + 1} ${method} without ${wrapper}`);
                        }
                    }
                }
                ts.forEachChild(node, visit);
            };
            visit(source);
        }

        assert.ok(notificationCalls > 20, `control arm: the scan found ${notificationCalls} notification calls`);
        assert.ok(registrations >= 6, `control arm: the scan found ${registrations} command and provider registrations`);
        assert.ok(historyEdits >= 1, `control arm: the scan found ${historyEdits} undo/redo edits`);
        assert.deepEqual(offenders, []);
    });
});
