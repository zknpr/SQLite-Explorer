import './vscode_mock_setup'; // Must be first

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as vscode from 'vscode';

import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { readHasTriggers } from '../../src/core/schema-dependency';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';
import type { DatabaseOperations } from '../../src/core/types';

/** fetchSchema reports a main or TEMP trigger, which lets a cell edit change row counts. */
async function assertTriggerPresence(ops: DatabaseOperations) {
    await ops.executeQuery('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const hasTriggers = async () => (await ops.fetchSchema!()).hasTriggers;
    assert.strictEqual(await hasTriggers(), false);
    await ops.executeQuery('CREATE TRIGGER main_trigger AFTER UPDATE ON t BEGIN DELETE FROM t WHERE id < 0; END');
    assert.strictEqual(await hasTriggers(), true);
    await ops.executeQuery('DROP TRIGGER main_trigger');
    assert.strictEqual(await hasTriggers(), false);
    await ops.executeQuery('CREATE TEMP TRIGGER temp_trigger AFTER UPDATE ON main.t BEGIN SELECT 1; END');
    assert.strictEqual(await hasTriggers(), true);
    await ops.executeQuery('DROP TRIGGER temp.temp_trigger');
    assert.strictEqual(await hasTriggers(), false);
}

describe('schema trigger presence', () => {
    it('reads only a single 0 or 1', () => {
        assert.strictEqual(readHasTriggers([[0]]), false);
        assert.strictEqual(readHasTriggers([[1n]]), true);
        for (const rows of [undefined, [], [[2]], [['1']], [[1], [0]], [[null]]]) {
            assert.throws(() => readHasTriggers(rows as unknown[][] | undefined), /trigger presence/, JSON.stringify(rows));
        }
    });

    it('reports main and TEMP triggers on WebAssembly', async () => {
        const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        try {
            await assertTriggerPresence(engine);
        } finally {
            engine.shutdown();
        }
    });

    it('reports main and TEMP triggers on the native engine', async (context) => {
        const platformDir = process.platform === 'darwin'
            ? (process.arch === 'arm64' ? 'aarch64-macos' : 'x86_64-macos')
            : process.platform === 'linux'
                ? (process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu')
                : process.platform === 'win32' && process.arch === 'x64' ? 'x86_64-windows' : undefined;
        if (!platformDir || !fs.existsSync(path.join('natives', platformDir, process.platform === 'win32' ? 'tjs.exe' : 'tjs'))) {
            return context.skip(`no bundled txiki worker for ${process.platform}-${process.arch}`);
        }
        fs.mkdirSync('.tmp', { recursive: true });
        const directory = fs.mkdtempSync(path.resolve('.tmp/schema-trigger-presence-'));
        const file = path.join(directory, 'main.db');
        fs.closeSync(fs.openSync(file, 'w'));
        const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
        try {
            const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), 'schema-trigger-presence', false);
            await assertTriggerPresence(databaseOps);
        } finally {
            native.workerMethods[Symbol.dispose]();
            fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });
});
