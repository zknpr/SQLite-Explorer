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
import { plainErrors, plainNotificationError, plainNotificationText, withPlainErrors } from '../../src/notificationText';

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
        // Errors are disarmed in place and can be rethrown through a wrapper again.
        assert.equal(plainNotificationText(plainNotificationText(message)), plainNotificationText(message));

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

    it('plainNotificationError keeps sealed errors and non-text messages, and replaces only frozen ones', () => {
        class CodedError extends Error { readonly code = 'Unavailable'; }
        const sealed = Object.seal(new CodedError(CRAFTED_ERROR));
        assert.equal(plainNotificationError(sealed), sealed);
        assert.deepEqual(linksIn(sealed.message), []);

        const numeric = new Error('placeholder');
        Object.defineProperty(numeric, 'message', { value: 42, writable: true, configurable: true });
        assert.equal(plainNotificationError(numeric), numeric);

        const frozen = Object.freeze(new Error(CRAFTED_ERROR));
        const replaced = plainNotificationError(frozen) as Error;
        assert.notEqual(replaced, frozen);
        assert.equal(replaced.cause, frozen);
        assert.match(replaced.message, /no such collation sequence/);
        assert.deepEqual(linksIn(replaced.message), []);
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
// input box and quick pick prompt, input validation message and undo label
// must be literal text or pass through plainNotificationText, so a new call
// site that shows database text cannot reintroduce links.
describe('notification call sites', () => {
    const NOTIFY = new Set(['showErrorMessage', 'showWarningMessage', 'showInformationMessage']);
    const WINDOW_METHODS = new Set([...NOTIFY, 'withProgress', 'showInputBox', 'showQuickPick', 'createInputBox', 'createQuickPick']);
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

    // A property's name when it is written literally; undefined for a computed
    // name that could be anything.
    function propertyName(name: ts.PropertyName): string | undefined {
        if (ts.isComputedPropertyName(name)) return ts.isStringLiteralLike(name.expression) ? name.expression.text : undefined;
        return (name as ts.Identifier).text;
    }

    // Every value the named property can take. A spread, a shorthand or an
    // accessor yields an expression the check refuses; a computed name counts
    // as every name.
    function textProperty(options: ts.ObjectLiteralExpression, name: string): ts.Expression[] {
        const values: ts.Expression[] = [];
        for (const property of options.properties) {
            if (ts.isSpreadAssignment(property)) {
                values.push(property.expression);
                continue;
            }
            const key = propertyName(property.name);
            if (key !== undefined && key !== name) continue;
            values.push(ts.isPropertyAssignment(property) ? property.initializer : ts.factory.createIdentifier(name));
        }
        return values;
    }

    // The values a validateInput function can return, without the returns of
    // functions nested in it.
    function returnedValues(fn: ts.ArrowFunction | ts.FunctionExpression): ts.Expression[] {
        if (!ts.isBlock(fn.body)) return [fn.body];
        const values: ts.Expression[] = [];
        const visit = (node: ts.Node) => {
            if (ts.isReturnStatement(node) && node.expression) values.push(node.expression);
            if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
        };
        ts.forEachChild(fn.body, visit);
        return values;
    }

    function scan(file: string, text: string) {
        const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        const offenders: string[] = [];
        const counts = { notificationCalls: 0, registrations: 0, historyEdits: 0, progressReports: 0, inputBoxes: 0 };
        const offend = (at: ts.Node, what: string) => {
            const { line } = source.getLineAndCharacterOfPosition(at.getStart());
            offenders.push(`${file}:${line + 1} ${what}`);
        };
        const check = (node: ts.Expression | undefined, what: string, at: ts.Node) => {
            if (node && !isPlainText(node)) offend(at, what);
        };
        // Options written in place, so their text can be checked.
        const checkOptions = (options: ts.Expression | undefined, name: string, what: string, at: ts.Node) => {
            if (!options) return;
            if (!ts.isObjectLiteralExpression(options)) offend(at, `${what} in options not written in place`);
            else for (const value of textProperty(options, name)) check(value, what, at);
        };
        const checkValidation = (options: ts.Expression | undefined, at: ts.Node) => {
            if (!options || !ts.isObjectLiteralExpression(options)) return;
            for (const value of textProperty(options, 'validateInput')) {
                if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) offend(at, 'validateInput not written in place');
                else for (const returned of returnedValues(value)) check(returned, 'validateInput message', returned);
            }
        };
        const directlyCalled = (node: ts.Node) => ts.isCallExpression(node.parent) && node.parent.expression === node;

        // Names this file binds to the vscode module and to its window.
        const namespaces = new Set<string>();
        const windows = new Set<string>();
        for (const statement of source.statements) {
            if (ts.isImportEqualsDeclaration(statement) && statement.moduleReference.getText() === "require('vscode')") {
                namespaces.add(statement.name.text);
            }
            if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
                || statement.moduleSpecifier.text !== 'vscode' || !statement.importClause) continue;
            const { name, namedBindings } = statement.importClause;
            if (name) namespaces.add(name.text);
            if (namedBindings && ts.isNamespaceImport(namedBindings)) namespaces.add(namedBindings.name.text);
            if (namedBindings && ts.isNamedImports(namedBindings)) {
                for (const element of namedBindings.elements) {
                    if ((element.propertyName ?? element.name).text === 'window') windows.add(element.name.text);
                }
            }
        }
        const isWindow = (node: ts.Node): boolean => {
            if (ts.isPropertyAccessExpression(node)) {
                return node.name.text === 'window' && ts.isIdentifier(node.expression) && namespaces.has(node.expression.text);
            }
            return ts.isIdentifier(node) && windows.has(node.text) && !ts.isImportSpecifier(node.parent)
                && !((ts.isPropertyAccessExpression(node.parent) || ts.isPropertyAssignment(node.parent)) && node.parent.name === node);
        };

        const visit = (node: ts.Node) => {
            // window and the functions checked here only through direct use,
            // so an alias cannot skip the checks.
            if (isWindow(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)) {
                offend(node, 'window used other than through one of its properties');
            }
            if (ts.isPropertyAccessExpression(node)) {
                const method = node.name.text;
                if (isWindow(node.expression) && WINDOW_METHODS.has(method) && !directlyCalled(node)) {
                    offend(node, `${method} used other than in a direct call`);
                }
                if ((method === 'report' || REGISTRATIONS.has(method)) && !directlyCalled(node)) {
                    offend(node, `${method} used other than in a direct call`);
                }
            }
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
                const method = node.expression.name.text;
                const [first, second] = node.arguments;
                if (isWindow(node.expression.expression)) {
                    if (NOTIFY.has(method)) {
                        counts.notificationCalls++;
                        check(first, `${method} message`, node);
                        // The second argument is the options or the first item.
                        if (second && !ts.isObjectLiteralExpression(second)) check(second, `${method} options or item`, node);
                        else checkOptions(second, 'detail', `${method} detail`, node);
                    } else if (method === 'withProgress') {
                        checkOptions(first, 'title', 'withProgress title', node);
                    } else if (method === 'showInputBox') {
                        counts.inputBoxes++;
                        checkOptions(first, 'prompt', 'showInputBox prompt', node);
                        checkValidation(first, node);
                    } else if (method === 'showQuickPick') {
                        checkOptions(second, 'prompt', 'showQuickPick prompt', node);
                    } else if (method === 'createInputBox' || method === 'createQuickPick') {
                        offend(node, `${method}: its prompt and validationMessage cannot be checked here`);
                    }
                }
                if (method === 'report') {
                    counts.progressReports++;
                    checkOptions(first, 'message', 'progress message', node);
                }
                const wrapper = REGISTRATIONS.get(method);
                if (wrapper) {
                    counts.registrations++;
                    if (!second || !ts.isCallExpression(second) || second.expression.getText() !== wrapper) {
                        offend(node, `${method} without ${wrapper}`);
                    }
                }
            }
            // A custom-document edit: VS Code shows a rejected undo or redo,
            // and the label in its "Could not undo" warning.
            if (ts.isObjectLiteralExpression(node)) {
                const names = node.properties.map(property => ts.isSpreadAssignment(property) ? undefined : propertyName(property.name));
                if (names.includes('undo') && names.includes('redo')) {
                    counts.historyEdits++;
                    for (const name of ['undo', 'redo']) {
                        for (const value of textProperty(node, name)) {
                            if (!ts.isCallExpression(value) || value.expression.getText() !== 'plainErrors') offend(node, `${name} without plainErrors`);
                        }
                    }
                    for (const value of textProperty(node, 'label')) check(value, 'undo label', node);
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
        return { offenders, counts };
    }

    it('pass non-literal text through plainNotificationText and register through the error wrappers', () => {
        const offenders: string[] = [];
        const totals = { notificationCalls: 0, registrations: 0, historyEdits: 0, progressReports: 0, inputBoxes: 0 };
        for (const file of sourceFiles(sourceRoot)) {
            const result = scan(path.relative(sourceRoot, file), readFileSync(file, 'utf8'));
            offenders.push(...result.offenders);
            for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += result.counts[key];
        }

        assert.ok(totals.notificationCalls > 20, `control arm: the scan found ${totals.notificationCalls} notification calls`);
        assert.ok(totals.registrations >= 6, `control arm: the scan found ${totals.registrations} command and provider registrations`);
        assert.ok(totals.historyEdits >= 1, `control arm: the scan found ${totals.historyEdits} undo/redo edits`);
        assert.ok(totals.progressReports >= 1, `control arm: the scan found ${totals.progressReports} progress reports`);
        assert.ok(totals.inputBoxes >= 1, `control arm: the scan found ${totals.inputBoxes} input boxes`);
        assert.deepEqual(offenders, []);
    });

    it('reports each code shape that could show database text unchecked', () => {
        // Each line marked "flagged" must be reported, and no other line.
        const shapes = [
            "import * as vs from 'vscode';",
            "import { window } from 'vscode';",
            "import { window as win } from 'vscode';",
            'declare const dbText: string;',
            'declare const opts: { title: string };',
            'declare const f: () => void;',
            'declare const progress: { report(value: { message?: string }): void };',
            "vs.window.showErrorMessage(dbText); // flagged",
            "vs.window.showWarningMessage('Failed', { modal: true, 'detail': dbText }); // flagged",
            "vs.window.showWarningMessage('Failed', { ['detail']: dbText }); // flagged",
            "vs.window.showWarningMessage('Failed', { detail: 'x', detail: dbText }); // flagged",
            "vs.window.withProgress({ title: 'Exporting', ...opts }, async () => {}); // flagged",
            "progress.report({ 'message': dbText }); // flagged",
            "vs.window.showInputBox({ 'prompt': dbText }); // flagged",
            'vs.window.showInputBox({ validateInput: value => value }); // flagged',
            "vs.window.showQuickPick(['a'], { prompt: dbText }); // flagged",
            'const box = vs.window.createInputBox(); // flagged',
            'const w = vs.window; // flagged',
            'window.showErrorMessage(dbText); // flagged',
            'const w2 = window; // flagged',
            'win.showInformationMessage(dbText); // flagged',
            'const show = vs.window.showErrorMessage; // flagged',
            'const report = progress.report; // flagged',
            'const register = vs.commands.registerCommand; // flagged',
            "vs.commands.registerCommand('x', f); // flagged",
            'const edit = { label: dbText, undo: plainErrors(f), redo: plainErrors(f) }; // flagged',
            'const edit2 = { label: "x", undo: f, redo: plainErrors(f) }; // flagged'
        ];
        const flagged = shapes.flatMap((line, index) => line.endsWith('// flagged') ? [index + 1] : []);
        const reported = new Set(scan('shapes.ts', shapes.join('\n')).offenders.map(entry => Number(/^shapes\.ts:(\d+) /.exec(entry)![1])));
        assert.deepEqual([...reported].sort((a, b) => a - b), flagged);

        const compliant = [
            "import * as vs from 'vscode';",
            'declare const dbText: string;',
            'declare const f: () => void;',
            "vs.window.showErrorMessage(plainNotificationText(dbText), { modal: true, detail: plainNotificationText(dbText) }, 'Retry');",
            'vs.window.withProgress({ location: 15, title: plainNotificationText(dbText) }, async progress => {',
            '    progress.report({ message: plainNotificationText(dbText) });',
            '});',
            "vs.window.showInputBox({ prompt: 'Value', validateInput: value => value ? undefined : 'Required.' });",
            "vs.window.showQuickPick(['a'], { prompt: plainNotificationText(dbText) });",
            "vs.commands.registerCommand('x', plainErrors(f));",
            'const edit = { label: plainNotificationText(dbText), undo: plainErrors(f), redo: plainErrors(f) };'
        ];
        assert.deepEqual(scan('compliant.ts', compliant.join('\n')).offenders, []);
    });
});
