import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { it, mock } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { exportTableCommand, writeCellFile, writeQueryResultFile } from '../../src/tableExporter';
import { DocumentRegistry } from '../../src/documentRegistry';
import type { DatabaseDocument } from '../../src/databaseModel';
import { createDatabaseEngine, type WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { NO_FILE_SYMLINKS } from './helpers/symlinks';

it('replaces query exports atomically and preserves an existing file after a failed rename', async () => {
    const confirmation = mock.method(vscode.window, 'showWarningMessage', async () => 'Replace');
    fs.mkdirSync('.tmp', { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('.tmp/query-export-'));
    const file = path.join(directory, 'result.csv');
    const rename = fs.promises.rename;
    try {
        fs.writeFileSync(file, 'old');
        await writeQueryResultFile(vscode.Uri.file(file), 'first');
        assert.equal(fs.readFileSync(file, 'utf8'), 'first');
        fs.promises.rename = async () => { throw new Error('simulated rename failure'); };
        await assert.rejects(writeQueryResultFile(vscode.Uri.file(file), 'second'), /simulated rename failure/);
        assert.equal(fs.readFileSync(file, 'utf8'), 'first');
        assert.deepEqual(fs.readdirSync(directory), ['result.csv']);
    } finally { confirmation.mock.restore(); fs.promises.rename = rename; fs.rmSync(directory, { recursive: true, force: true }); }
});

it('does not replace query output when the user declines the explicit confirmation', async () => {
    fs.mkdirSync('.tmp', { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('.tmp/query-export-confirm-'));
    const file = path.join(directory, 'result.csv');
    fs.writeFileSync(file, 'keep this');
    const confirmation = mock.method(vscode.window, 'showWarningMessage', async () => undefined);
    try {
        await assert.rejects(writeQueryResultFile(vscode.Uri.file(file), 'replacement'), vscode.CancellationError);
        assert.equal(fs.readFileSync(file, 'utf8'), 'keep this');
    } finally { confirmation.mock.restore(); fs.rmSync(directory, { recursive: true, force: true }); }
});

it('refuses an open database or an alias as the query export destination', { skip: NO_FILE_SYMLINKS }, async () => {
    fs.mkdirSync('.tmp', { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('.tmp/query-destination-'));
    const file = path.join(directory, 'database.db'), alias = path.join(directory, 'alias.csv');
    fs.writeFileSync(file, 'database bytes'); fs.symlinkSync(file, alias);
    const uri = vscode.Uri.file(file);
    DocumentRegistry.set('query-export-destination', { uri } as DatabaseDocument);
    try {
        await assert.rejects(writeQueryResultFile(uri, 'csv'), /open database/);
        await assert.rejects(writeQueryResultFile(vscode.Uri.file(alias), 'csv'), /aliases an open database/);
        assert.equal(fs.readFileSync(file, 'utf8'), 'database bytes');
    } finally { DocumentRegistry.delete('query-export-destination'); fs.rmSync(directory, { recursive: true, force: true }); }
});

for (const suffix of ['-wal', '-shm', '-journal']) {
    for (const kind of ['query', 'cell']) {
        it(`refuses a missing ${suffix} destination through directory aliases for ${kind} exports`, { skip: NO_FILE_SYMLINKS }, async () => {
            fs.mkdirSync('.tmp', { recursive: true });
            const directory = fs.mkdtempSync(path.resolve('.tmp/export-sidecar-'));
            const real = path.join(directory, 'real'), alias = path.join(directory, 'alias');
            fs.mkdirSync(real);
            fs.symlinkSync(real, alias, 'junction');
            // An inert registry fixture exercises destination admission without
            // opening or modifying an actual SQLite database or journal.
            fs.writeFileSync(path.join(real, 'open.db'), 'registry fixture');
            const exportTo = (file: string) => kind === 'query'
                ? writeQueryResultFile(vscode.Uri.file(file), 'value\r\n7')
                : writeCellFile(vscode.Uri.file(file), Uint8Array.of(0, 255));
            try {
                for (const [registered, destination] of [[real, alias], [alias, real]]) {
                    DocumentRegistry.set('export-sidecar', { uri: vscode.Uri.file(path.join(registered, 'open.db')) } as DatabaseDocument);
                    await assert.rejects(exportTo(path.join(destination, `open.db${suffix}`)), /open database.*journal/);
                    assert.deepEqual(fs.readdirSync(real), ['open.db']);
                }
                const databaseAlias = path.join(directory, 'shortcut.db');
                fs.symlinkSync(path.join(real, 'open.db'), databaseAlias);
                DocumentRegistry.set('export-sidecar', { uri: vscode.Uri.file(databaseAlias) } as DatabaseDocument);
                await assert.rejects(exportTo(path.join(alias, `open.db${suffix}`)), /open database.*journal/);
                await exportTo(path.join(alias, 'safe-output.txt'));
                assert.ok(fs.existsSync(path.join(real, 'safe-output.txt')), 'unrelated absent destinations stay usable');
            } finally {
                DocumentRegistry.delete('export-sidecar');
                fs.rmSync(directory, { recursive: true, force: true });
            }
        });
    }
}

it('pins a missing export leaf to its canonical parent before an alias is retargeted', async () => {
    fs.mkdirSync('.tmp', { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('.tmp/export-parent-'));
    const original = path.join(directory, 'original'), other = path.join(directory, 'other');
    const alias = path.join(directory, 'alias');
    fs.mkdirSync(original); fs.mkdirSync(other); fs.symlinkSync(original, alias, 'junction');
    const rename = fs.promises.rename;
    const replacement = mock.method(fs.promises, 'rename', async (source: fs.PathLike, destination: fs.PathLike) => {
        fs.unlinkSync(alias);
        fs.symlinkSync(other, alias, 'junction');
        await rename(source, destination);
    });
    try {
        await writeQueryResultFile(vscode.Uri.file(path.join(alias, 'result.csv')), 'original destination');
        assert.equal(fs.readFileSync(path.join(original, 'result.csv'), 'utf8'), 'original destination');
        assert.deepEqual(fs.readdirSync(other), []);
        assert.deepEqual(fs.readdirSync(original), ['result.csv']);
    } finally { replacement.mock.restore(); fs.rmSync(directory, { recursive: true, force: true }); }
});

for (const kind of ['query', 'cell']) {
    it(`reserves case and normalization variants of open database sidecars for ${kind} exports`, async () => {
        fs.mkdirSync('.tmp', { recursive: true });
        const directory = fs.mkdtempSync(path.resolve('.tmp/export-reserved-name-'));
        const real = path.join(directory, 'real'), alias = path.join(directory, 'alias');
        fs.mkdirSync(real); fs.symlinkSync(real, alias, 'junction');
        const databaseName = 'caf\u00e9.db';
        fs.writeFileSync(path.join(real, databaseName), 'registry fixture');
        DocumentRegistry.set('export-reserved-name', { uri: vscode.Uri.file(path.join(real, databaseName)) } as DatabaseDocument);
        const exportTo = (file: string) => kind === 'query'
            ? writeQueryResultFile(vscode.Uri.file(file), 'value\r\n7')
            : writeCellFile(vscode.Uri.file(file), Uint8Array.of(0, 255));
        try {
            // Reserve these spellings on all volumes, without relying on the
            // test machine's case-sensitivity or creating a filesystem probe.
            for (const suffix of ['-wal', '-shm', '-journal']) {
                for (const name of [`${databaseName}${suffix}`.toUpperCase(), `cafe\u0301.db${suffix}`]) {
                    await assert.rejects(exportTo(path.join(alias, name)), /open database.*journal/);
                    assert.deepEqual(fs.readdirSync(real).map(name => name.normalize('NFC')), [databaseName]);
                }
            }
            await exportTo(path.join(alias, 'CAFE-result.txt'));
            assert.ok(fs.existsSync(path.join(real, 'CAFE-result.txt')));
        } finally {
            DocumentRegistry.delete('export-reserved-name');
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
}

it('refuses an open database, its journals and their aliases as the table export destination', { skip: NO_FILE_SYMLINKS }, async () => {
    const confirmation = mock.method(vscode.window, 'showWarningMessage', async () => 'Replace');
    fs.mkdirSync('.tmp', { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('.tmp/table-export-destination-'));
    const real = path.join(directory, 'real'), alias = path.join(directory, 'alias');
    fs.mkdirSync(real); fs.symlinkSync(real, alias, 'junction');
    const file = path.join(real, 'open.db');
    const opened = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
    const operations = opened.operations!;
    await operations.executeQuery("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('row')");
    await operations.writeToFile(file);
    const databaseBytes = fs.readFileSync(file);
    const uri = vscode.Uri.file(file);
    DocumentRegistry.set('table-export-destination', { uri, databaseOperations: operations } as unknown as DatabaseDocument);
    let destination = '';
    const dialog = mock.method(vscode.window, 'showSaveDialog', async () => vscode.Uri.file(destination));
    const exportTo = async (target: string) => {
        destination = target;
        const result = await exportTableCommand({} as any, undefined,
            { table: 't', uri: uri.toString() }, ['v'], undefined, undefined, { format: 'csv' });
        if (!result.success) throw new Error('message' in result ? result.message : 'cancelled');
    };
    try {
        await assert.rejects(exportTo(file), /open database/);
        const shortcut = path.join(directory, 'shortcut.csv');
        fs.symlinkSync(file, shortcut);
        await assert.rejects(exportTo(shortcut), /aliases an open database/);
        for (const suffix of ['-wal', '-shm', '-journal']) {
            await assert.rejects(exportTo(path.join(alias, `open.db${suffix}`)), /open database.*journal/);
            await assert.rejects(exportTo(path.join(real, `OPEN.DB${suffix}`)), /open database.*journal/);
        }
        assert.deepEqual(fs.readFileSync(file), databaseBytes);
        assert.deepEqual(fs.readdirSync(real), ['open.db']);
        await exportTo(path.join(alias, 'open.csv'));
        assert.equal(fs.readFileSync(path.join(real, 'open.csv'), 'utf8'), 'v\nrow');
    } finally {
        dialog.mock.restore(); confirmation.mock.restore();
        DocumentRegistry.delete('table-export-destination');
        (operations as WasmDatabaseEngine).shutdown();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

it('refuses the open database as a non-local table export destination', async () => {
    const confirmation = mock.method(vscode.window, 'showWarningMessage', async () => 'Replace');
    const opened = await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false });
    const operations = opened.operations!;
    await operations.executeQuery("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('row')");
    const uri = vscode.Uri.parse('vscode-sqlite://remote-open.db');
    DocumentRegistry.set('remote-table-export-destination', { uri, databaseOperations: operations } as unknown as DatabaseDocument);
    const dialog = mock.method(vscode.window, 'showSaveDialog', async () => uri);
    const rename = mock.method(vscode.workspace.fs, 'rename', async () => undefined);
    try {
        const result = await exportTableCommand({} as any, undefined,
            { table: 't', uri: uri.toString() }, ['v'], undefined, undefined, { format: 'csv' });
        assert.equal(result.success, false);
        assert.match('message' in result ? result.message : '', /open database/);
        assert.equal(rename.mock.callCount(), 0);
    } finally {
        rename.mock.restore(); dialog.mock.restore(); confirmation.mock.restore();
        DocumentRegistry.delete('remote-table-export-destination');
        (operations as WasmDatabaseEngine).shutdown();
    }
});
