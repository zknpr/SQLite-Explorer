import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { mockVscode } from './mocks/vscode';
import { registerBulkImport } from '../../src/bulkImport';
import { DocumentRegistry } from '../../src/documentRegistry';
import type { DatabaseDocument } from '../../src/databaseModel';
import type { DatabaseOperations, LabeledModification } from '../../src/core/types';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';
import { serializeOperations } from '../../src/core/operation-serializer';

interface Scenario {
    source?: string | Uint8Array;
    fileSize?: number;
    manual?: boolean;
    cancelAfter?: number;
    confirm?: boolean;
    readOnly?: boolean;
    beforeConfirm?: (database: DatabaseDocument, ops: DatabaseOperations) => void | Promise<void>;
    verify: (result: { ops: DatabaseOperations; errors: string[]; messages: string[]; preview: string; details: string; edits: LabeledModification[] }) => Promise<void>;
}

/** Dialog choices are scripted; source I/O, parsing and both SQLite engines are real. */
async function runWizard(backend: 'wasm' | 'native', scenario: Scenario) {
    fs.mkdirSync('.tmp', { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('.tmp/import-command-'));
    const source = path.join(directory, 'source.csv'), file = path.join(directory, 'database.db');
    fs.writeFileSync(source, scenario.source ?? 'id,value\n1,first\n2,second');
    if (scenario.fileSize) fs.truncateSync(source, scenario.fileSize);
    const opened = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
    const wasm = opened.operations as WasmDatabaseEngine;
    await wasm.executeQuery("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT DEFAULT 'default', calculated TEXT GENERATED ALWAYS AS (value || '!') VIRTUAL)");
    let native: Awaited<ReturnType<typeof createNativeDatabaseConnection>> | undefined;
    const changes: Array<() => void> = [];
    const replace = (object: object, key: string, value: unknown) => {
        const original = Object.getOwnPropertyDescriptor(object, key);
        changes.push(() => { if (original) Object.defineProperty(object, key, original); else Reflect.deleteProperty(object, key); });
        Object.defineProperty(object, key, { configurable: true, writable: true, value });
    };
    let registration: vscode.Disposable | undefined;
    try {
        let ops: DatabaseOperations = serializeOperations(wasm);
        if (backend === 'native') {
            fs.writeFileSync(file, await wasm.serializeDatabase());
            native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
            ops = (await native.establishConnection(vscode.Uri.file(file), 'wizard', false)).databaseOps;
        }
        const errors: string[] = [], messages: string[] = [], edits: LabeledModification[] = [];
        let preview = '', details = '', command: (() => Promise<void>) | undefined;
        let cancellationRequested: (() => void) | undefined;
        const database = {
            uri: vscode.Uri.file(file), isReadOnlyMode: scenario.readOnly ?? false, connectionGeneration: 1,
            databaseOperations: ops, undoMemoryLimitBytes: 16 * 1024 * 1024,
            onDidDispose: () => ({ dispose() {} }),
            runTrackedMutation: async (action: () => Promise<void>, recordsHistory: boolean) => {
                assert.equal(recordsHistory, true); await action();
            },
            recordExternalModification: (edit: LabeledModification) => { edits.push(edit); }
        } as unknown as DatabaseDocument;
        DocumentRegistry.set('import-command-qa', database);
        replace(mockVscode.commands, 'registerCommand', (_id: string, callback: () => Promise<void>) => {
            command = callback; return { dispose() {} };
        });
        replace(mockVscode.window, 'showQuickPick', async (items: Array<string | { label: string; target?: string }>, options: { title: string }) => {
            if (options.title === 'Import column mapping') return scenario.manual ? 'Map columns manually' : items[0];
            if (options.title.startsWith('Map source column:')) {
                const column = options.title.split(': ').at(-1);
                assert.ok(!items.some(item => typeof item !== 'string' && item.target === 'calculated'), 'generated columns cannot be selected');
                const target = column === 'external_id' ? 'id' : column === 'note' ? 'value' : undefined;
                return items.find(item => typeof item !== 'string' && item.target === target);
            }
            return items[0];
        });
        replace(mockVscode.window, 'showOpenDialog', async () => [vscode.Uri.file(source)]);
        replace(mockVscode.workspace, 'openTextDocument', async (options: { content: string }) => {
            preview = options.content; return { getText: () => options.content };
        });
        replace(mockVscode.window, 'showTextDocument', async () => undefined);
        replace(mockVscode.window, 'showWarningMessage', async (_message: string, options: { detail: string }) => {
            details = options.detail;
            await scenario.beforeConfirm?.(database, ops);
            return scenario.confirm === false ? undefined : 'Import';
        });
        replace(mockVscode.window, 'showErrorMessage', async (message: string) => { errors.push(message); });
        replace(mockVscode.window, 'showInformationMessage', async (message: string) => { messages.push(message); });
        replace(mockVscode.window, 'withProgress', async (_options: unknown, action: (progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) => Promise<void>) => action({
            report: value => { if (scenario.cancelAfter && Number(value.message?.split(' / ')[0]) >= scenario.cancelAfter) cancellationRequested?.(); }
        }, {
            isCancellationRequested: false,
            onCancellationRequested: callback => { cancellationRequested = () => callback(undefined); return { dispose() {} }; }
        }));
        registration = registerBulkImport();
        assert.ok(command); await command();
        await scenario.verify({ ops, errors, messages, preview, details, edits });
    } finally {
        registration?.dispose(); DocumentRegistry.delete('import-command-qa'); changes.reverse().forEach(restore => restore());
        native?.workerMethods[Symbol.dispose](); wasm.shutdown(); fs.rmSync(directory, { recursive: true, force: true });
    }
}

for (const backend of ['wasm', 'native'] as const) {
    it(`${backend} import preview displays declared defaults and identifies omitted destination columns`, async () => {
        await runWizard(backend, {
            source: 'id\n1',
            verify: async ({ ops, errors, preview }) => {
                assert.deepEqual(errors, []);
                const shown = JSON.parse(preview);
                assert.equal(shown.destinationColumns.find((column: { name: string }) => column.name === 'value').defaultExpression, "'default'");
                assert.deepEqual(shown.omittedDestinationColumns, ['value']);
                assert.deepEqual((await ops.executeQuery('SELECT value FROM items'))[0].rows, [['default']]);
            }
        });
    });

    it(`${backend} import command maps/skips columns, previews, confirms, and records one reversible edit`, async () => {
        await runWizard(backend, {
            source: 'external_id,note,ignored\r\n9007199254740993,"multi\nline",drop\r\n2,,drop', manual: true,
            verify: async ({ ops, errors, preview, details, edits, messages }) => {
                assert.deepEqual(errors, []); assert.equal(edits.length, 1); assert.equal(messages.length, 1);
                assert.equal(JSON.parse(preview).mapping.ignored, '[skip]');
                assert.equal(details.includes('immediately'), backend === 'native');
                assert.deepEqual((await ops.executeQuery('SELECT CAST(id AS TEXT), value, calculated FROM items ORDER BY id'))[0].rows,
                    [['2', '', '!'], ['9007199254740993', 'multi\nline', 'multi\nline!']]);
                await ops.undoModification(edits[0]);
                assert.deepEqual((await ops.executeQuery('SELECT count(*) FROM items'))[0].rows, [[0]]);
                await ops.redoModification(edits[0]);
                assert.deepEqual((await ops.executeQuery('SELECT count(*) FROM items'))[0].rows, [[2]]);
            }
        });
    });

    it(`${backend} progress cancellation rolls back the wizard import and records no edit`, async () => {
        await runWizard(backend, {
            source: 'id,value\n' + Array.from({ length: 150 }, (_, i) => `${i + 1},value`).join('\n'), cancelAfter: 50,
            verify: async ({ ops, edits, errors, messages }) => {
                assert.equal(edits.length, 0); assert.equal(messages.length, 0); assert.match(errors[0], /abort/i);
                assert.deepEqual((await ops.executeQuery('SELECT count(*) FROM items'))[0].rows, [[0]]);
            }
        });
    });
}

for (const [name, scenario, expected] of [
    ['oversized source', { fileSize: 64 * 1024 * 1024 + 1 }, /64 MiB/],
    ['invalid UTF-8', { source: new Uint8Array([0x69, 0x64, 0x0a, 0xc3, 0x28]) }, /encoded data|encoding/i],
    ['read-only destination', { readOnly: true }, /writable SQLite/],
    ['reload during preview', { beforeConfirm: (db: DatabaseDocument) => { (db as unknown as { connectionGeneration: number }).connectionGeneration++; } }, /closed or reloaded/],
    ['close during preview', { beforeConfirm: () => { DocumentRegistry.delete('import-command-qa'); } }, /closed or reloaded/],
    ['destination becomes read-only', { beforeConfirm: (db: DatabaseDocument) => { (db as unknown as { isReadOnlyMode: boolean }).isReadOnlyMode = true; } }, /read-only/],
    ['cancel confirmation', { confirm: false }, undefined]
] as const) {
    it(`import command leaves the database unchanged after ${name}`, async () => {
        await runWizard('wasm', { ...scenario, verify: async ({ ops, errors, edits, messages }) => {
            if (expected) assert.match(errors[0], expected); else assert.deepEqual(errors, []);
            assert.equal(edits.length, 0); assert.equal(messages.length, 0);
            assert.deepEqual((await ops.executeQuery('SELECT count(*) FROM items'))[0].rows, [[0]]);
        } });
    });
}
