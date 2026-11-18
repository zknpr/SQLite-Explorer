import './vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';

/**
 * A save writes the database's journal mode back with it. sql.js exports
 * through the backup API and marks its copy as a rollback-journal file
 * (header bytes 18 and 19 set to 1), so without the engine's correction a
 * WAL database would silently become a rollback-journal one on its first save.
 */

async function image(walHeader: boolean): Promise<Uint8Array> {
    const seed = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
    try {
        await seed.executeQuery("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t VALUES (1, 'a')");
        const bytes = Uint8Array.from(await seed.serializeDatabase());
        if (walHeader) { bytes[18] = 2; bytes[19] = 2; }
        return bytes;
    } finally {
        seed.shutdown();
    }
}

async function saveAfterEdit(content: Uint8Array, setup?: (engine: WasmDatabaseEngine) => Promise<void>) {
    const engine = (await createDatabaseEngine({ content, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
    try {
        await setup?.(engine);
        await engine.executeQuery("INSERT INTO t VALUES (2, 'b')");
        const journalMode = (await engine.executeQuery('PRAGMA journal_mode'))[0].rows[0][0];
        const saved = await engine.serializeDatabase();
        return { journalMode, header: [saved[18], saved[19]], saved };
    } finally {
        engine.shutdown();
    }
}

async function rows(content: Uint8Array) {
    const engine = (await createDatabaseEngine({ content, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
    try {
        return (await engine.executeQuery('SELECT id, v FROM t ORDER BY id'))[0].rows;
    } finally {
        engine.shutdown();
    }
}

describe('WebAssembly save journal mode', () => {
    it('keeps a WAL database in WAL mode', async () => {
        const result = await saveAfterEdit(await image(true));
        assert.equal(result.journalMode, 'wal');
        assert.deepEqual(result.header, [2, 2]);
        assert.deepEqual(await rows(result.saved), [[1, 'a'], [2, 'b']]);
    });

    it('writes WAL mode when the session switched the database to WAL', async () => {
        const result = await saveAfterEdit(await image(false), engine => engine.setPragma('journal_mode', 'wal'));
        assert.equal(result.journalMode, 'wal');
        assert.deepEqual(result.header, [2, 2]);
        assert.deepEqual(await rows(result.saved), [[1, 'a'], [2, 'b']]);
    });

    it('keeps a rollback-journal database in rollback-journal mode', async () => {
        const result = await saveAfterEdit(await image(false));
        assert.equal(result.journalMode, 'delete');
        assert.deepEqual(result.header, [1, 1]);
    });

    it('writes rollback-journal mode when the session left WAL', async () => {
        const result = await saveAfterEdit(await image(true), engine => engine.setPragma('journal_mode', 'delete'));
        assert.notEqual(result.journalMode, 'wal');
        assert.deepEqual(result.header, [1, 1]);
    });
});
