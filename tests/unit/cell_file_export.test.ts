import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { it, mock } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { writeCellFile } from '../../src/tableExporter';

it('confirms cell replacements, preserves changed destinations, and copies binary bytes exactly', async () => {
    fs.mkdirSync('.tmp', { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('.tmp/cell-file-export-'));
    const source = path.join(directory, 'source.bin'), destination = path.join(directory, 'saved.bin');
    const bytes = Buffer.alloc(5 * 1024 * 1024, 0xa5);
    fs.writeFileSync(source, bytes); fs.writeFileSync(destination, 'original');
    let action = 'cancel';
    const warning = mock.method(vscode.window, 'showWarningMessage', async (): Promise<string | undefined> => {
        if (action === 'change') fs.writeFileSync(destination, 'external change');
        return action === 'cancel' ? undefined : 'Replace';
    });
    try {
        await assert.rejects(writeCellFile(vscode.Uri.file(destination), vscode.Uri.file(source)), vscode.CancellationError);
        assert.equal(fs.readFileSync(destination, 'utf8'), 'original');
        action = 'change';
        await assert.rejects(writeCellFile(vscode.Uri.file(destination), vscode.Uri.file(source)), /destination changed/);
        assert.equal(fs.readFileSync(destination, 'utf8'), 'external change');
        action = 'replace';
        await writeCellFile(vscode.Uri.file(destination), vscode.Uri.file(source));
        assert.deepEqual(fs.readFileSync(destination), bytes);
        await writeCellFile(vscode.Uri.file(destination), Uint8Array.of(0, 255, 0, 128));
        assert.deepEqual(fs.readFileSync(destination), Buffer.from([0, 255, 0, 128]));
        assert.deepEqual(fs.readdirSync(directory).sort(), ['saved.bin', 'source.bin']);
    } finally { warning.mock.restore(); fs.rmSync(directory, { recursive: true, force: true }); }
});
