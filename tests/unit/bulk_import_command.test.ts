import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
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
    sourceUri?: (file: string) => vscode.Uri;
    remoteName?: string;
    afterSourceRead?: (file: string) => void;
    manual?: boolean;
    cancelAfter?: number;
    confirm?: boolean;
    readOnly?: boolean;
    prepare?: (ops: DatabaseOperations) => Promise<void>;
    beforeConfirm?: (database: DatabaseDocument, ops: DatabaseOperations) => void | Promise<void>;
    beforeFirstInsert?: () => Promise<void>;
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
        await scenario.prepare?.(ops);
        if (scenario.beforeFirstInsert) {
            let inserted = false;
            const intercept = (target: DatabaseOperations): DatabaseOperations => new Proxy(target, {
                get(_target, property) {
                    const value = Reflect.get(target, property, target);
                    if (property === 'runReadSnapshot' && typeof value === 'function') {
                        return (action: (snapshot: DatabaseOperations) => Promise<unknown>) => value.call(target,
                            (snapshot: DatabaseOperations) => action(intercept(snapshot)));
                    }
                    if (property === 'insertRowWithHistory') {
                        return async (...args: unknown[]) => {
                            if (!inserted) { inserted = true; await scenario.beforeFirstInsert!(); }
                            return value.apply(target, args);
                        };
                    }
                    return typeof value === 'function' ? value.bind(target) : value;
                }
            });
            ops = intercept(ops);
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
        replace(mockVscode.env, 'remoteName', scenario.remoteName);
        replace(mockVscode.window, 'showOpenDialog', async () => {
            const uri = scenario.sourceUri?.(source) ?? vscode.Uri.file(source);
            if (scenario.afterSourceRead) {
                const handle = await fs.promises.open(source, 'r');
                const prototype = Object.getPrototypeOf(handle);
                const read = prototype.read as (this: FileHandle, buffer: Uint8Array, offset: number, length: number, position: number | null) => Promise<{ bytesRead: number; buffer: Uint8Array }>;
                await handle.close();
                let changed = false;
                // Only the chunk boundary is controlled; the command still reads
                // the real descriptor before and after the in-place file change.
                replace(prototype, 'read', async function (this: FileHandle, buffer: Uint8Array, offset: number, length: number, position: number | null) {
                    const result = await read.call(this, buffer, offset, Math.min(length, 5), position);
                    if (!changed) { changed = true; scenario.afterSourceRead!(source); }
                    return result;
                });
            }
            return [uri];
        });
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
    for (const change of [
        {
            name: 'recreated destination with changed types, defaults and constraints',
            sql: "DROP TABLE items; CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT 'changed', calculated TEXT GENERATED ALWAYS AS (value || '?') VIRTUAL, CHECK (id <> ''))"
        },
        {
            name: 'recreated destination with identical DDL',
            sql: "DROP TABLE items; CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT DEFAULT 'default', calculated TEXT GENERATED ALWAYS AS (value || '!') VIRTUAL)"
        },
        { name: 'new unique index', sql: 'CREATE UNIQUE INDEX items_value ON items(value)' },
        {
            name: 'removed destination trigger',
            prepareSql: "CREATE TRIGGER block_import BEFORE INSERT ON items BEGIN SELECT RAISE(ABORT, 'insert blocked'); END",
            sql: 'DROP TRIGGER block_import'
        },
        {
            name: 'removed temporary destination trigger',
            prepareSql: "CREATE TEMP TRIGGER block_import BEFORE INSERT ON main.items BEGIN SELECT RAISE(ABORT, 'insert blocked'); END",
            sql: 'DROP TRIGGER temp.block_import',
            connectionLocal: true
        }
    ]) {
        it(`${backend} import rejects a ${change.name} during preview`, async () => {
            await runWizard(backend, {
                prepare: async ops => { if (change.prepareSql) await ops.executeQuery(change.prepareSql); },
                beforeConfirm: async (database, ops) => {
                    const generation = database.connectionGeneration;
                    if (backend === 'wasm' || change.connectionLocal) await ops.executeQuery(change.sql);
                    else {
                        const before = fs.statSync(database.uri.fsPath, { bigint: true });
                        const external = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
                        try {
                            const connection = await external.establishConnection(database.uri, 'external-schema', false);
                            await connection.databaseOps.executeQuery(change.sql);
                        } finally { external.workerMethods[Symbol.dispose](); }
                        const after = fs.statSync(database.uri.fsPath, { bigint: true });
                        assert.equal(after.dev, before.dev);
                        assert.equal(after.ino, before.ino);
                    }
                    assert.equal(database.connectionGeneration, generation);
                },
                verify: async ({ ops, errors, edits, messages, preview }) => {
                    assert.ok(preview);
                    assert.deepEqual((await ops.executeQuery('SELECT id FROM items'))[0].rows, []);
                    assert.match(errors[0], /schema changed.*preview/i);
                    assert.deepEqual(edits, []);
                    assert.deepEqual(messages, []);
                }
            });
        });
    }

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

it('native import keeps its schema snapshot through the first write after an external WAL schema commit', async () => {
    let destination: vscode.Uri | undefined;
    await runWizard('native', {
        prepare: async ops => { await ops.executeQuery('PRAGMA journal_mode = WAL'); },
        beforeConfirm: database => { destination = database.uri; },
        beforeFirstInsert: async () => {
            assert.ok(destination);
            const external = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
            try {
                const connection = await external.establishConnection(destination, 'external-schema-race', false);
                await connection.databaseOps.executeQuery('CREATE UNIQUE INDEX items_value ON items(value)');
            } finally { external.workerMethods[Symbol.dispose](); }
        },
        verify: async ({ ops, errors, edits, messages }) => {
            assert.deepEqual((await ops.executeQuery('SELECT id FROM items'))[0].rows, []);
            assert.match(errors[0], /busy|locked|schema/i);
            assert.deepEqual(edits, []);
            assert.deepEqual(messages, []);
        }
    });
});

for (const change of ['truncated', 'overwritten with restored mtime'] as const) {
    it(`import command rejects a source ${change} while reading`, async () => {
        await runWizard('wasm', {
            source: 'id\n1\n2',
            sourceUri: file => {
                fs.utimesSync(file, new Date(0), new Date(0));
                return vscode.Uri.file(file);
            },
            afterSourceRead: file => {
                if (change === 'truncated') fs.truncateSync(file, 5);
                else {
                    const before = fs.statSync(file, { bigint: true });
                    fs.writeFileSync(file, 'id\n3\n4');
                    fs.utimesSync(file, new Date(0), new Date(0));
                    const after = fs.statSync(file, { bigint: true });
                    assert.equal(after.size, before.size);
                    assert.equal(after.mtimeNs, before.mtimeNs);
                    assert.notEqual(after.ctimeNs, before.ctimeNs);
                }
            },
            verify: async ({ ops, errors, edits, messages, preview }) => {
                assert.deepEqual((await ops.executeQuery('SELECT id FROM items'))[0].rows, []);
                assert.match(errors[0], /source file changed while reading/i);
                assert.equal(preview, '');
                assert.deepEqual(edits, []);
                assert.deepEqual(messages, []);
            }
        });
    });
}

it('import command keeps the held descriptor when the selected source symlink is retargeted', async () => {
    let selected = '';
    await runWizard('wasm', {
        source: 'id\n1\n2',
        sourceUri: file => {
            selected = path.join(path.dirname(file), 'selected.csv');
            fs.symlinkSync(file, selected);
            return vscode.Uri.file(selected);
        },
        afterSourceRead: file => {
            const replacement = path.join(path.dirname(file), 'replacement.csv');
            fs.writeFileSync(replacement, 'id\n3\n4');
            fs.unlinkSync(selected);
            fs.symlinkSync(replacement, selected);
        },
        verify: async ({ ops, errors, edits }) => {
            assert.deepEqual(errors, []);
            assert.equal(edits.length, 1);
            assert.deepEqual((await ops.executeQuery('SELECT id FROM items'))[0].rows, [[1], [2]]);
        }
    });
});

for (const remoteName of ['ssh-remote', 'dev-container', 'codespaces']) {
    it(`import command accepts the file URI returned to a ${remoteName} workspace extension host`, async () => {
        await runWizard('wasm', {
            remoteName,
            verify: async ({ ops, errors, edits }) => {
                assert.deepEqual(errors, []);
                assert.equal(edits.length, 1);
                assert.deepEqual((await ops.executeQuery('SELECT id FROM items'))[0].rows, [[1], [2]]);
            }
        });
    });
}

for (const scheme of ['vscode-local', 'vscode-remote', 'memfs']) {
    it(`import command does not treat an untransformed ${scheme} URI as an extension-host file`, async () => {
        await runWizard('wasm', {
            remoteName: 'ssh-remote',
            sourceUri: file => vscode.Uri.from({ scheme, path: file }),
            verify: async ({ ops, errors, edits, messages, preview }) => {
                assert.deepEqual((await ops.executeQuery('SELECT id FROM items'))[0].rows, []);
                assert.match(errors[0], /requires a file on the desktop or remote extension host/i);
                assert.deepEqual(edits, []);
                assert.deepEqual(messages, []);
                assert.equal(preview, '');
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
