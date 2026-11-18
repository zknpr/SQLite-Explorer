import './vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import * as vscode from 'vscode';

import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection, isNativeAvailable } from '../../src/nativeWorker';
import type { DatabaseOperations } from '../../src/core/types';

// SQLite reads "text" as a string literal where no column has that name, and
// older tools wrote views and triggers that way. A build with SQLITE_DQS=0
// still loads such a schema and then fails when the view or trigger runs, so
// both engines must accept it. The fixture is written by the WebAssembly
// engine, which has always accepted it.
const SCHEMA = [
    'CREATE TABLE notes (id INTEGER PRIMARY KEY, label TEXT, status TEXT)',
    'CREATE TABLE audit (note_id INTEGER, what TEXT)',
    'CREATE VIEW open_notes AS SELECT id, label FROM notes WHERE status = "open"',
    'CREATE TRIGGER notes_audit AFTER UPDATE ON notes BEGIN INSERT INTO audit VALUES (new.id, "updated"); END',
    "INSERT INTO notes (label, status) VALUES ('first', 'open'), ('second', 'closed')"
];

const directories: string[] = [];
after(() => {
    for (const directory of directories) {
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

async function fixtureImage(): Promise<Uint8Array> {
    const seed = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
    try {
        for (const sql of SCHEMA) await seed.executeQuery(sql);
        return await seed.serializeDatabase();
    } finally {
        seed.shutdown();
    }
}

async function assertRunsLegacySchema(ops: DatabaseOperations): Promise<void> {
    assert.deepEqual((await ops.executeQuery('SELECT label FROM open_notes'))[0].rows, [['first']]);
    assert.equal((await ops.fetchTableData('open_notes', { limit: 10, offset: 0 })).rows.length, 1);
    assert.equal((await ops.fetchTableCount('open_notes', {})).count, 1);
    await ops.executeQuery("UPDATE notes SET label = 'edited' WHERE id = 2");
    assert.deepEqual((await ops.executeQuery('SELECT note_id, what FROM audit'))[0].rows, [[2, 'updated']]);
    // A statement typed today reads the same way.
    assert.deepEqual((await ops.executeQuery('SELECT "not a column" AS v'))[0].rows, [['not a column']]);
}

describe('views and triggers with double-quoted string literals', () => {
    it('run on the WebAssembly engine', async () => {
        const engine = (await createDatabaseEngine({
            content: await fixtureImage(), maxSize: 0, readOnlyMode: false
        })).operations as WasmDatabaseEngine;
        try {
            await assertRunsLegacySchema(engine);
        } finally {
            engine.shutdown();
        }
    });

    it('run on the bundled native engine', async (context) => {
        if (!await isNativeAvailable(process.cwd())) {
            if (process.env.FUZZ_EXPECT_TARGET) throw new Error(`Missing native runtime for ${process.env.FUZZ_EXPECT_TARGET}`);
            return context.skip('Bundled native runtime unavailable');
        }
        fs.mkdirSync('.tmp', { recursive: true });
        const directory = fs.mkdtempSync(path.resolve('.tmp/double-quoted-literals-'));
        directories.push(directory);
        const file = path.join(directory, 'legacy.db');
        fs.writeFileSync(file, await fixtureImage());
        const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
        context.after(() => native.workerMethods[Symbol.dispose]());
        await assertRunsLegacySchema((await native.establishConnection(vscode.Uri.file(file), 'legacy.db', false)).databaseOps);
    });
});
