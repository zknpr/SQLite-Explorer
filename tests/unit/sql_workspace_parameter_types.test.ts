import './vscode_mock_setup';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as vscode from 'vscode';
import { mockVscode } from './mocks/vscode';
import { DocumentRegistry } from '../../src/documentRegistry';
import type { DatabaseDocument } from '../../src/databaseModel';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';
import type { DatabaseOperations, QueryResultSet } from '../../src/core/types';

/**
 * Console parameters are typed the way SQLite types the same literal: a JSON
 * integer binds as INTEGER across the int64 range, a number written with a
 * fraction or exponent binds as REAL, and a string as TEXT. These run through
 * the runQuery/explainQuery commands, so the parameter text is parsed by the
 * console exactly as a user's input box answer is.
 */
type ConsoleRun = (command: 'runQuery' | 'explainQuery', sql: string, parameters?: string) => Promise<QueryResultSet>;

async function withConsole(ops: DatabaseOperations, work: (run: ConsoleRun) => Promise<void>) {
    const restorations: Array<() => void> = [];
    const replace = (object: object, key: string, value: unknown) => {
        const original = Object.getOwnPropertyDescriptor(object, key);
        restorations.push(() => { if (original) Object.defineProperty(object, key, original); else Reflect.deleteProperty(object, key); });
        Object.defineProperty(object, key, { configurable: true, writable: true, value });
    };
    const commands = new Map<string, () => Promise<void>>();
    const errors: string[] = [];
    let sql = '', parameterText = '', validation: string | undefined;
    let result: QueryResultSet | undefined;
    const document = { languageId: 'sql', isClosed: false, getText: () => sql };
    const database = {
        uri: vscode.Uri.file('/workspace/parameter-types.db'),
        onDidDispose: () => ({ dispose() {} }),
        databaseOperations: {
            executeReadQuery: async (...args: Parameters<DatabaseOperations['executeReadQuery']>) => {
                result = await ops.executeReadQuery(...args);
                return result;
            }
        }
    } as unknown as DatabaseDocument;
    let registration: vscode.Disposable | undefined;
    DocumentRegistry.set('sql-parameter-types', database);
    try {
        replace(mockVscode, 'Disposable', class { constructor(private readonly callback: () => void) {} dispose() { this.callback(); } });
        replace(mockVscode.commands, 'registerCommand', (id: string, action: () => Promise<void>) => { commands.set(id, action); return { dispose() {} }; });
        replace(mockVscode.window, 'activeTextEditor', { document, selection: { isEmpty: true } });
        replace(mockVscode.window, 'showInputBox', async (options: vscode.InputBoxOptions) => {
            // The input box refuses to submit while validateInput reports a message.
            validation = (await options.validateInput?.(parameterText)) as string | undefined ?? undefined;
            return validation ? undefined : parameterText;
        });
        replace(mockVscode.window, 'showErrorMessage', async (message: string) => { errors.push(message); });
        replace(mockVscode.window, 'showTextDocument', async () => ({ viewColumn: 2 }));
        replace(mockVscode.window, 'tabGroups', { all: [{ viewColumn: 2 }] });
        replace(mockVscode.workspace, 'openTextDocument', async (uri: vscode.Uri) => ({ uri }));
        replace(mockVscode.workspace, 'registerTextDocumentContentProvider', () => ({ dispose() {} }));
        replace(mockVscode, 'languages', { registerCompletionItemProvider: () => ({ dispose() {} }) });
        const { registerSqlWorkspace } = await import('../../src/sqlWorkspace');
        registration = registerSqlWorkspace({} as vscode.ExtensionContext);
        await work(async (command, nextSql, parameters = '[]') => {
            sql = nextSql; parameterText = parameters;
            errors.length = 0; validation = undefined; result = undefined;
            await commands.get(`sqlite-explorer.${command}`)!();
            if (validation) throw new Error(`rejected by the input box: ${validation}`);
            if (errors.length) throw new Error(errors.join('\n'));
            assert.ok(result, `${command} produced no result`);
            return result;
        });
    } finally {
        registration?.dispose();
        DocumentRegistry.delete('sql-parameter-types');
        restorations.reverse().forEach(restore => restore());
    }
}

/** [parameter as typed, typeof(), quote()] */
const TYPED_PARAMETERS: Array<[string, string, string]> = [
    ['3000000000', 'integer', '3000000000'],
    ['-2147483649', 'integer', '-2147483649'],
    ['2147483647', 'integer', '2147483647'],
    ['9007199254740993', 'integer', '9007199254740993'],
    ['-9223372036854775808', 'integer', '-9223372036854775808'],
    ['9223372036854775807', 'integer', '9223372036854775807'],
    ['-0', 'integer', '0'],
    ['7', 'integer', '7'],
    ['1.0', 'real', '1.0'],
    ['1e3', 'real', '1000.0'],
    ['-2E+2', 'real', '-200.0'],
    ['3e9', 'real', '3000000000.0'],
    ['2.5', 'real', '2.5'],
    ['"7"', 'text', "'7'"],
    ['"3000000000"', 'text', "'3000000000'"],
    ['null', 'null', 'NULL']
];

async function exerciseParameterTypes(ops: DatabaseOperations) {
    for (const statement of [
        'CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT)',
        "INSERT INTO t VALUES (7, 'small'), (3000000000, 'big'), (9007199254740993, 'past53'), (-9223372036854775808, 'min')",
        'CREATE TABLE s (code TEXT)',
        "INSERT INTO s VALUES ('7'), ('3000000000')"
    ]) await ops.executeQuery(statement);

    await withConsole(ops, async run => {
        const typed = await run('runQuery',
            'SELECT ' + TYPED_PARAMETERS.map((_, index) => `typeof(?${index + 1}) AS t${index}, quote(?${index + 1}) AS q${index}`).join(', '),
            `[${TYPED_PARAMETERS.map(([text]) => text).join(', ')}]`);
        assert.deepEqual(typed.rows, [TYPED_PARAMETERS.flatMap(([, type, quoted]) => [type, quoted])]);

        // INTEGER PRIMARY KEY lookups; 7 is the int32 control.
        for (const [parameter, label] of [['7', 'small'], ['3000000000', 'big'], ['9007199254740993', 'past53'], ['-9223372036854775808', 'min']]) {
            assert.deepEqual((await run('runQuery', 'SELECT label FROM t WHERE id = ?', `[${parameter}]`)).rows, [[label]], parameter);
        }
        // A TEXT column applies TEXT affinity to the parameter: a REAL bind
        // would compare '3000000000.0'. 7 is the int32 control.
        for (const parameter of ['7', '3000000000']) {
            assert.deepEqual((await run('runQuery', 'SELECT count(*) AS n FROM s WHERE code = ?', `[${parameter}]`)).rows, [[1]], parameter);
        }
        // A REAL divides as REAL; the integer 1 is the control.
        assert.deepEqual((await run('runQuery', 'SELECT ? / 2 AS half', '[1.0]')).rows, [[0.5]]);
        assert.deepEqual((await run('runQuery', 'SELECT ? / 2 AS half', '[1]')).rows, [[0]]);
        // The bound value carries no affinity, as a plain ? does: a text
        // literal never equals an integer parameter.
        assert.deepEqual((await run('runQuery', "SELECT '3000000000' = ? AS same, '7' = ? AS small", '[3000000000, 7]')).rows, [[0, 0]]);
        // Result labels do not depend on how a parameter is bound.
        const labels: string[][] = [];
        for (const parameters of ['[7]', '[3000000000]', '[1.0]', '["x"]']) {
            labels.push((await run('runQuery', 'SELECT typeof(?), ?1 + 0 AS sum', parameters)).headers);
        }
        for (const headers of labels) assert.deepEqual(headers, labels[0]);
        // ?NNN reuse mixed with bare ?, which numbers past the largest so far.
        assert.deepEqual((await run('runQuery', 'SELECT quote(?2) AS a, quote(?) AS b, quote(?1) AS c, quote(?) AS d, quote(?2) AS e',
            '[10, 3000000000, 1.0, "x"]')).rows, [['3000000000', '1.0', '10', "'x'", '3000000000']]);
        // Placeholders that touch the surrounding tokens.
        assert.deepEqual((await run('runQuery', 'SELECT label FROM t WHERE(id>=?)AND(id<?)ORDER BY id LIMIT(?)',
            '[3000000000, 9007199254740993, 3000000000]')).rows, [['big']]);
        assert.deepEqual((await run('runQuery', 'SELECT label FROM t WHERE id=?', '[9007199254740993]')).rows, [['past53']]);

        const plan = await run('explainQuery', 'SELECT label FROM t WHERE id = ?', '[9007199254740993]');
        assert.ok(plan.rows.some(row => /INTEGER PRIMARY KEY/.test(String(row[3]))), JSON.stringify(plan.rows));

        for (const outOfRange of ['9223372036854775808', '-9223372036854775809', '100000000000000000000']) {
            await assert.rejects(run('runQuery', 'SELECT ?', `[${outOfRange}]`), /64-bit/, outOfRange);
        }
        await assert.rejects(run('runQuery', 'SELECT ?', '[1e400]'), /finite/);
    });
}

describe('query console parameter types', () => {
    it('binds integer literals exactly and keeps reals and text on WebAssembly', async () => {
        const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        try { await exerciseParameterTypes(engine); } finally { engine.shutdown(); }
    });

    it('binds integer literals exactly and keeps reals and text on the bundled native engine', async (context) => {
        const platformDir = process.platform === 'darwin'
            ? (process.arch === 'arm64' ? 'aarch64-macos' : 'x86_64-macos')
            : process.platform === 'linux'
                ? (process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu')
                : process.platform === 'win32' && process.arch === 'x64' ? 'x86_64-windows' : undefined;
        const binary = platformDir && path.join('natives', platformDir, process.platform === 'win32' ? 'tjs.exe' : 'tjs');
        if (!binary || !fs.existsSync(binary)) return context.skip(`no bundled txiki worker for ${process.platform}-${process.arch}`);
        fs.mkdirSync('.tmp', { recursive: true });
        const directory = fs.mkdtempSync(path.resolve('.tmp/sql-parameter-types-'));
        const file = path.join(directory, 'parameters.db');
        fs.closeSync(fs.openSync(file, 'w'));
        const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
        try {
            const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), 'parameters.db', false);
            await exerciseParameterTypes(databaseOps);
        } finally {
            native.workerMethods[Symbol.dispose]();
            fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });
});
