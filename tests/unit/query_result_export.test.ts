import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { it, mock } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { writeQueryResultFile } from '../../src/tableExporter';
import { DocumentRegistry } from '../../src/documentRegistry';
import type { DatabaseDocument } from '../../src/databaseModel';

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

it('refuses an open database or an alias as the query export destination', async () => {
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
