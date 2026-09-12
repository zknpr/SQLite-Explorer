import * as vscode from 'vscode';
import type { DatabaseDocument } from './databaseModel';
import { DocumentRegistry } from './documentRegistry';
import { ExtensionId } from './config';
import { escapeIdentifier } from './core/sql-utils';
import { parseQueryParameters, prepareReadQuery, resultCsv, SQL_RESULT_ROWS } from './core/sql-workspace';
import type { QueryResultSet } from './core/types';
import { writeQueryResultFile } from './tableExporter';

interface QueryBinding { database: DatabaseDocument }
interface QueryOutput { text: string; csv: string }
const RESULT_SCHEME = 'sqlite-query-result';

/** Standard SQL documents retain file ownership; only result documents use a read-only provider. */
export function registerSqlWorkspace(_context: vscode.ExtensionContext): vscode.Disposable {
    const bindings = new WeakMap<vscode.TextDocument, QueryBinding>();
    const completions = new WeakMap<DatabaseDocument, vscode.CompletionItem[]>();
    const outputs = new Map<string, QueryOutput>();
    const history: string[] = [];
    const subscriptions: vscode.Disposable[] = [];
    let resultSequence = 0;
    let resultColumn: vscode.ViewColumn | undefined;
    const resultSession = crypto.randomUUID();
    let disposed = false;

    const alive = (database: DatabaseDocument) => !disposed
        && Array.from(DocumentRegistry.values()).includes(database);
    const assertAlive = (database: DatabaseDocument) => {
        if (!alive(database)) throw new Error('The query database was closed. Use Choose Query Database to select an open database explicitly.');
    };
    const selectDatabase = async (target?: unknown): Promise<DatabaseDocument | undefined> => {
        const databases = Array.from(new Set(DocumentRegistry.values())).filter(alive);
        if (!databases.length) throw new Error('Open a SQLite database before running a query.');
        if (target !== undefined) {
            const requested = target && typeof target === 'object' && 'scheme' in target
                && typeof target.toString === 'function' ? target.toString() : undefined;
            const database = databases.find(candidate => candidate.uri.toString() === requested);
            if (!database) throw new Error('The query database is not open or was closed. Open it again before creating a query.');
            return database;
        }
        if (databases.length === 1) return databases[0];
        const chosen = await vscode.window.showQuickPick(databases.map(database => ({
            label: database.uri.path.split('/').pop() || database.uri.toString(),
            description: database.uri.toString(), database
        })), { title: 'Choose query database', ignoreFocusOut: true });
        if (chosen) assertAlive(chosen.database);
        return chosen?.database;
    };
    const sqlEditor = () => {
        const editor = vscode.window.activeTextEditor;
        // SQLite language extensions commonly assign .sql files the sqlite ID.
        if (!editor || !['sql', 'sqlite'].includes(editor.document.languageId)) throw new Error('Open a SQL editor first.');
        return editor;
    };
    const resolveDatabase = async (document: vscode.TextDocument) => {
        const binding = bindings.get(document);
        if (binding) { assertAlive(binding.database); return binding.database; }
        const database = await selectDatabase();
        if (database && !document.isClosed) bindings.set(document, { database });
        return database;
    };
    const refreshCompletions = async (database: DatabaseDocument) => {
        assertAlive(database);
        const metadata = await database.databaseOperations.executeReadQuery(
            "SELECT s.name AS table_name, p.name AS column_name FROM main.sqlite_schema AS s JOIN pragma_table_info(s.name, 'main') AS p WHERE s.type IN ('table', 'view') ORDER BY s.name, p.cid LIMIT 500"
        );
        assertAlive(database);
        const items: vscode.CompletionItem[] = ['main', 'temp'].map(name => {
            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Module);
            item.insertText = escapeIdentifier(name); return item;
        });
        const tables = new Set<string>();
        for (const row of metadata.rows.slice(0, 500)) {
            const table = String(row[0]), column = String(row[1]);
            if (!tables.has(table)) {
                tables.add(table);
                const item = new vscode.CompletionItem(table, vscode.CompletionItemKind.Class);
                item.insertText = escapeIdentifier(table); item.detail = 'main'; items.push(item);
            }
            const item = new vscode.CompletionItem(column, vscode.CompletionItemKind.Field);
            item.insertText = escapeIdentifier(column); item.detail = table; items.push(item);
        }
        completions.set(database, items.slice(0, 1000));
    };
    const remember = (sql: string) => {
        const old = history.indexOf(sql); if (old >= 0) history.splice(old, 1);
        history.unshift(sql);
        while (history.length > 50 || history.join('').length > 256 * 1024) history.pop();
    };
    const showOutput = async (result: QueryResultSet, database: DatabaseDocument, elapsed: number, explain: boolean) => {
        assertAlive(database);
        const csv = resultCsv(result);
        const clipped = result.rows.length > SQL_RESULT_ROWS;
        const count = Math.min(result.rows.length, SQL_RESULT_ROWS);
        const rowLabel = explain ? (count === 1 ? 'plan entry' : 'plan entries') : (count === 1 ? 'row' : 'rows');
        const kind = explain ? 'Query plan' : 'Query results';
        const uri = vscode.Uri.from({ scheme: RESULT_SCHEME, path: `/${resultSession}/${++resultSequence}-${explain ? 'plan' : 'results'}.txt` });
        outputs.set(uri.toString(), {
            csv,
            text: `${kind} | ${database.uri.toString()}\n${count} ${rowLabel} | ${elapsed} ms${clipped ? ` | TRUNCATED at 1000 ${explain ? 'plan entries' : 'rows'}` : ''}\n` +
                'Read-only CSV table. Export Query Results exports these displayed rows only.\n' +
                (explain ? 'Plan for the original SQL and supplied parameters. The query was not executed.\n\n' :
                    'Cells may be previews; original sizes are marked. Duplicate and unaliased parameter column labels may be normalized.\n\n') + csv
        });
        // Retain at most five result documents. Older open documents display a
        // clear expiry notice on reload instead of retaining unbounded tables.
        while (outputs.size > 5) outputs.delete(outputs.keys().next().value!);
        // Repeated runs must not keep splitting the workbench into narrower
        // panes. A closed result group is recreated beside the current query.
        const existingResultColumn = resultColumn !== undefined
            && vscode.window.tabGroups.all.some(group => group.viewColumn === resultColumn);
        const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
            viewColumn: existingResultColumn ? resultColumn : vscode.ViewColumn.Beside,
            preview: true
        });
        resultColumn = editor.viewColumn;
    };
    const run = async (explain: boolean) => {
        const editor = sqlEditor();
        const document = editor.document;
        const sql = editor.selection.isEmpty ? document.getText() : document.getText(editor.selection);
        const prepared = prepareReadQuery(sql);
        const database = await resolveDatabase(document);
        if (!database) return;
        assertAlive(database);
        let params = [] as ReturnType<typeof parseQueryParameters>;
        if (prepared.parameterCount) {
            const answer = await vscode.window.showInputBox({
                title: `${prepared.parameterCount} positional SQL parameters`,
                prompt: 'JSON array: null, strings, numbers. Exact integers: quoted string with CAST(? AS INTEGER). Bindings are never kept in history.',
                password: true, ignoreFocusOut: true,
                validateInput: value => {
                    try {
                        const values = parseQueryParameters(value);
                        return values.length === prepared.parameterCount ? undefined : `Expected ${prepared.parameterCount} values.`;
                    } catch (error) { return error instanceof Error ? error.message : String(error); }
                }
            });
            if (answer === undefined) return;
            params = parseQueryParameters(answer);
        }
        assertAlive(database);
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: explain ? 'Explaining SQL query' : 'Running SQL query', cancellable: true }, async (_progress, token) => {
            const controller = new AbortController();
            const cancel = token.onCancellationRequested(() => controller.abort());
            const close = database.onDidDispose(() => controller.abort());
            if (token.isCancellationRequested) controller.abort();
            const started = Date.now();
            try {
                controller.signal.throwIfAborted();
                assertAlive(database);
                const result = await database.databaseOperations.executeReadQuery(sql, params, explain, controller.signal);
                controller.signal.throwIfAborted(); assertAlive(database);
                remember(sql);
                await showOutput(result, database, Date.now() - started, explain);
            } catch (error) {
                // Backend interrupts and AbortSignal use different error types;
                // only this operation's cancellation suppresses ordinary errors.
                if (!controller.signal.aborted && !(error instanceof Error && error.name === 'AbortError')) throw error;
            } finally { cancel.dispose(); close.dispose(); }
        });
    };
    const command = (suffix: string, action: (...args: unknown[]) => Promise<unknown> | unknown) => subscriptions.push(vscode.commands.registerCommand(`${ExtensionId}.${suffix}`, async (...args: unknown[]) => {
        try { await action(...args); }
        catch (error) {
            if (!(error instanceof vscode.CancellationError)) await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
    }));
    command('newQuery', async (target?: unknown) => {
        const database = await selectDatabase(target); if (!database) return;
        const document = await vscode.workspace.openTextDocument({ language: 'sql', content: 'SELECT 1 AS value;\n' });
        assertAlive(database); bindings.set(document, { database });
        await vscode.window.showTextDocument(document);
        await refreshCompletions(database);
    });
    command('chooseQueryDatabase', async () => {
        const document = sqlEditor().document;
        const database = await selectDatabase(); if (!database || document.isClosed) return;
        bindings.set(document, { database }); await refreshCompletions(database);
    });
    command('runQuery', () => run(false));
    command('explainQuery', () => run(true));
    command('refreshQueryCompletions', async () => {
        const database = await resolveDatabase(sqlEditor().document); if (database) await refreshCompletions(database);
    });
    command('queryHistory', async () => {
        const chosen = await vscode.window.showQuickPick(history.map((sql, index) => ({
            label: sql.replace(/\s+/g, ' ').slice(0, 160), description: `Session query ${index + 1}`, sql
        })), { title: 'SQL query history (session only; parameter values excluded)' });
        if (!chosen) return;
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'sql', content: chosen.sql }));
    });
    command('clearQueryHistory', () => { history.length = 0; });
    command('exportQueryResults', async () => {
        const uri = vscode.window.activeTextEditor?.document.uri;
        const output = uri && outputs.get(uri.toString());
        if (!output) throw new Error('Focus a current query result document before exporting.');
        const destination = await vscode.window.showSaveDialog({ filters: { CSV: ['csv'] }, title: 'Export displayed query rows' });
        if (destination) await writeQueryResultFile(destination, output.csv);
    });
    subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(RESULT_SCHEME, { provideTextDocumentContent: uri => outputs.get(uri.toString())?.text ?? 'This query result expired. Run the query again.' }),
        vscode.workspace.onDidCloseTextDocument(document => { outputs.delete(document.uri.toString()); }),
        vscode.languages.registerCompletionItemProvider([{ language: 'sql' }, { language: 'sqlite' }], {
            provideCompletionItems(document) {
                const database = bindings.get(document)?.database;
                return database && alive(database) ? completions.get(database) ?? [] : [];
            }
        })
    );
    return new vscode.Disposable(() => { disposed = true; outputs.clear(); history.length = 0; subscriptions.forEach(item => item.dispose()); });
}
