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
import { plainErrors, plainNotificationText, withPlainErrors } from '../../src/notificationText';

// The pattern VS Code parses extension notifications, modal messages and
// progress titles with (microsoft/vscode src/vs/base/common/linkedText.ts).
// A match is a clickable link; a command: link runs with the link's arguments.
const VSCODE_LINK = /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^\)\s]+)(?: (["'])(.+?)(\3))?\)/gi;
// VS Code removes $(icon) syntax from a progress title before parsing its links
// (stripIcons, src/vs/base/common/iconLabels.ts), so the text is checked both
// as given and with icons removed.
const ICON = /(\s)?(\\)?\$\([A-Za-z0-9-]+(?:~[A-Za-z]+)?\)(\s)?/g;
const stripIcons = (text: string): string =>
    text.replace(ICON, (match, before?: string, escaped?: string, after?: string) => escaped ? match : before || after || '');
const linksIn = (text: string): string[] =>
    [...new Set([text, stripIcons(text)].flatMap(form => [...form.matchAll(VSCODE_LINK)].map(match => match[2])))];

// A crafted database: a view named as a command link, selecting a missing
// column that is also named as one, so reading the view fails with an error
// quoting the name.
const COMMAND = 'command:workbench.action.showCommands';
const VIEW = `[Show export](${COMMAND})`;
const COLUMN = `[Open details](${COMMAND})`;
// No "](" until VS Code removes the icon.
const ICON_TABLE = `[Show export]$(x)(${COMMAND})`;

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
        assert.equal(plainNotificationText(message).replaceAll('\u200B', ''), message);
        assert.equal(plainNotificationText('Export failed: disk full'), 'Export failed: disk full');

        const iconForm = `Exporting "${ICON_TABLE}"`;
        assert.deepEqual(linksIn(iconForm), [COMMAND], 'control arm: VS Code finds the link once icons are removed');
        assert.deepEqual(linksIn(plainNotificationText(iconForm)), []);
    });

    it('shows the export progress title of a table named with icon syntax without a link', async () => {
        const restorations: Array<() => void> = [];
        const opened = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
        const engine = opened.operations as WasmDatabaseEngine;
        const scratch = await fsPromises.mkdtemp(path.join(process.cwd(), '.notification-links-'));
        const docUri = mockVscode.Uri.parse('vscode-sqlite://notification-icon-title.db');
        const titles: string[] = [];

        try {
            await engine.executeQuery(`CREATE TABLE "${ICON_TABLE}"(a); INSERT INTO "${ICON_TABLE}" VALUES (1)`);
            replaceProperty(restorations, mockVscode.window, 'showSaveDialog', async () => mockVscode.Uri.file(path.join(scratch, 'export.csv')));
            const withProgress = mockVscode.window.withProgress;
            replaceProperty(restorations, mockVscode.window, 'withProgress', (options: { title?: string }, task: Function) => {
                titles.push(options.title ?? '');
                return withProgress(options, task);
            });
            DocumentRegistry.set('notification-icon-title', { uri: docUri, databaseOperations: engine } as unknown as DatabaseDocument);

            const result = await exportTableCommand(
                {} as vscode.ExtensionContext,
                undefined,
                { table: ICON_TABLE, uri: docUri.toString() },
                ['a'],
                undefined,
                undefined,
                { format: 'csv' }
            );

            assert.equal(result.success, true);
            assert.ok(titles.some(title => title.includes('[Show export]')), 'control arm: the progress title names the table');
            assert.deepEqual(titles.flatMap(linksIn), []);
        } finally {
            DocumentRegistry.delete('notification-icon-title');
            restorations.reverse().forEach(restore => restore());
            engine.shutdown();
            await fsPromises.rm(scratch, { recursive: true, force: true });
        }
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

    it('keeps a DOMException, whose message has only a getter, as the error VS Code receives', async () => {
        // An aborted save rethrows its AbortSignal's DOMException.
        const aborted = new DOMException('This operation was aborted', 'AbortError');
        await assert.rejects(plainErrors(async () => { throw aborted; })(), (error: unknown) => {
            assert.equal(error, aborted);
            return true;
        });
        const crafted = new DOMException(CRAFTED_ERROR, 'DataCloneError');
        await assert.rejects(plainErrors(async () => { throw crafted; })(), (error: unknown) => {
            assert.equal(error, crafted);
            assert.equal((error as DOMException).name, 'DataCloneError');
            assert.match((error as Error).message, /no such collation sequence/);
            assert.deepEqual(linksIn((error as Error).message), []);
            return true;
        });
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

// Every notification, modal message and detail, progress title and message,
// and input box prompt must be literal text or pass through
// plainNotificationText, so a new call site that shows database text cannot
// reintroduce links. Messages returned from validateInput cannot be checked
// here; the one in src shows a parse error of text the user typed.
describe('notification call sites', () => {
    const NOTIFY = new Set(['showErrorMessage', 'showWarningMessage', 'showInformationMessage']);
    // Commands and providers whose errors VS Code shows itself.
    const REGISTRATIONS = new Map([
        ['registerCommand', 'plainErrors'],
        ['registerTextEditorCommand', 'plainErrors'],
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

    // Literal text, a call to plainNotificationText, or a conditional of those.
    function isPlainText(node: ts.Expression): boolean {
        if (ts.isParenthesizedExpression(node)) return isPlainText(node.expression);
        if (ts.isConditionalExpression(node)) return isPlainText(node.whenTrue) && isPlainText(node.whenFalse);
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'plainNotificationText') {
            return true;
        }
        return isLiteralText(node);
    }

    // A string literal, a template without substitutions, undefined, l10n.t of
    // a literal without placeholders, or a conditional or concatenation of
    // those. A disarmed part may not be concatenated: a literal ending in "]"
    // followed by database text starting with "(" would form a link.
    function isLiteralText(node: ts.Expression): boolean {
        if (ts.isParenthesizedExpression(node)) return isLiteralText(node.expression);
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
        if (ts.isIdentifier(node) && node.text === 'undefined') return true;
        if (ts.isConditionalExpression(node)) return isLiteralText(node.whenTrue) && isLiteralText(node.whenFalse);
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
            return isLiteralText(node.left) && isLiteralText(node.right);
        }
        return ts.isCallExpression(node)
            && ts.isPropertyAccessExpression(node.expression)
            && node.expression.name.text === 't'
            && node.expression.expression.getText().endsWith('l10n')
            && node.arguments.length === 1
            && isLiteralText(node.arguments[0]);
    }

    // The value of the named property. A shorthand property or a spread could
    // hide the text, so it is returned for the check to refuse.
    function textProperty(options: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
        for (const property of options.properties) {
            if (ts.isSpreadAssignment(property)) return property.expression;
            if (property.name?.getText() !== name) continue;
            return ts.isPropertyAssignment(property) ? property.initializer : property.name as ts.Expression;
        }
        return undefined;
    }

    it('pass non-literal text through plainNotificationText and register through the error wrappers', () => {
        const offenders: string[] = [];
        let notificationCalls = 0;
        let registrations = 0;
        let historyEdits = 0;
        let progressReports = 0;
        let inputBoxes = 0;

        for (const file of sourceFiles(sourceRoot)) {
            const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
            const offend = (at: ts.Node, what: string) => {
                const { line } = source.getLineAndCharacterOfPosition(at.getStart());
                offenders.push(`${path.relative(sourceRoot, file)}:${line + 1} ${what}`);
            };
            const check = (node: ts.Expression | undefined, what: string, at: ts.Node) => {
                if (node && !isPlainText(node)) offend(at, what);
            };
            // Options written in place, so their text can be checked.
            const checkOptions = (options: ts.Expression | undefined, name: string, what: string, at: ts.Node) => {
                if (!options) return;
                if (ts.isObjectLiteralExpression(options)) check(textProperty(options, name), what, at);
                else offend(at, `${what} in options not written in place`);
            };
            const visit = (node: ts.Node) => {
                // window and its show*Message functions only through direct
                // calls, so an alias or a passed function cannot skip the checks.
                if (ts.isPropertyAccessExpression(node)) {
                    const parent = node.parent;
                    if (NOTIFY.has(node.name.text) && node.expression.getText().endsWith('window')
                        && !(ts.isCallExpression(parent) && parent.expression === node)) {
                        offend(node, `${node.name.text} used other than in a direct call`);
                    }
                    if (node.name.text === 'window' && /^(vsc|vscode)$/.test(node.expression.getText())
                        && !(ts.isPropertyAccessExpression(parent) && parent.expression === node)) {
                        offend(node, 'window used other than through one of its properties');
                    }
                }
                if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
                    const method = node.expression.name.text;
                    const [first, second] = node.arguments;
                    if (node.expression.expression.getText().endsWith('window')) {
                        if (NOTIFY.has(method)) {
                            notificationCalls++;
                            check(first, `${method} message`, node);
                            // The second argument is the options or the first item.
                            if (second && !ts.isObjectLiteralExpression(second)) check(second, `${method} options or item`, node);
                            else checkOptions(second, 'detail', `${method} detail`, node);
                        } else if (method === 'withProgress') {
                            checkOptions(first, 'title', 'withProgress title', node);
                        } else if (method === 'showInputBox') {
                            inputBoxes++;
                            checkOptions(first, 'prompt', 'showInputBox prompt', node);
                        }
                    }
                    if (method === 'report') {
                        progressReports++;
                        checkOptions(first, 'message', 'progress message', node);
                    }
                    const wrapper = REGISTRATIONS.get(method);
                    if (wrapper) {
                        registrations++;
                        if (!second || !ts.isCallExpression(second) || second.expression.getText() !== wrapper) {
                            offend(node, `${method} without ${wrapper}`);
                        }
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
                                offend(property, `${property.name!.getText()} without plainErrors`);
                            }
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
        assert.ok(progressReports >= 1, `control arm: the scan found ${progressReports} progress reports`);
        assert.ok(inputBoxes >= 1, `control arm: the scan found ${inputBoxes} input boxes`);
        assert.deepEqual(offenders, []);
    });
});
