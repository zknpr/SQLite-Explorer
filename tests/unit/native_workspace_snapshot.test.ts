import './vscode_mock_setup';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { it, type TestContext } from 'node:test';
import * as vscode from 'vscode';
import { createNativeDatabaseConnection, isNativeAvailable, NativeWorkerProcess } from '../../src/nativeWorker';

async function fixture(t: TestContext, timeout = 1500) {
    const root = process.cwd();
    if (!await isNativeAvailable(root)) { t.skip('Bundled native runtime unavailable'); return; }
    fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
    const directory = fs.mkdtempSync(path.join(root, '.tmp', 'native-workspace-snapshot-'));
    const file = path.join(directory, 'query.db');
    const seed = new DatabaseSync(file);
    seed.exec('PRAGMA journal_mode=WAL; CREATE TABLE items(value INTEGER); INSERT INTO items VALUES (7)');
    seed.close();
    const bundle = await createNativeDatabaseConnection(vscode.Uri.file(root), undefined, null, timeout);
    const externalConnections: DatabaseSync[] = [];
    t.after(() => {
        for (const connection of externalConnections) connection.close();
        bundle.workerMethods[Symbol.dispose]();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const { databaseOps: db } = await bundle.establishConnection(vscode.Uri.file(file), 'query.db');
    return { db, file, externalConnections };
}

for (const context of ['TEMP state', 'pending transaction'] as const) {
    it(`cancels a dispatched native Run Query with ${context} before its deadline`, async t => {
        const f = await fixture(t); if (!f) return;
        if (context === 'TEMP state') {
            await f.db.executeQuery('CREATE TEMP TABLE retained(value); INSERT INTO retained VALUES (9)');
        } else {
            await f.db.executeQuery('BEGIN; INSERT INTO items VALUES (11); CREATE INDEX pending_index ON items(value)');
        }
        const call = NativeWorkerProcess.prototype.call;
        let intercepted = false, accepted = false, elapsed = 0;
        t.mock.method(NativeWorkerProcess.prototype, 'call', async function(this: NativeWorkerProcess, ...args: Parameters<typeof call>) {
            const pending = call.apply(this, args);
            if (args[0] !== 'workspaceQuery' || intercepted) return pending;
            intercepted = true;
            const id = (this as unknown as { messageId: number }).messageId;
            const outcome = pending.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
            // The finite aggregate is deliberately longer than this delay. A
            // positive cancel acknowledgement proves it reached active work.
            await new Promise(resolve => setTimeout(resolve, 20));
            const started = performance.now();
            const cancellation = await call.call(this, 'cancel', [id]) as { cancelled: boolean };
            accepted = cancellation.cancelled;
            const result = await outcome;
            elapsed = performance.now() - started;
            if (result.error) throw result.error;
            return result.value;
        });
        const error = await f.db.executeReadQuery(
            'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT sum(x) FROM n'
        ).then(() => undefined, (error: unknown) => error);
        assert.equal(accepted, true, 'the worker must handle cancellation while the primary query is active');
        assert.ok(error instanceof Error);
        assert.equal(error.name, 'AbortError');
        assert.ok(elapsed < 750, `cancellation took ${elapsed} ms against a 1500 ms deadline`);
        t.diagnostic(`Acknowledged ${context} cancellation settled in ${elapsed.toFixed(3)} ms`);
        assert.deepEqual((await f.db.executeReadQuery('SELECT 42 AS value')).rows, [[42]]);
        if (context === 'TEMP state') {
            assert.deepEqual((await f.db.executeReadQuery('SELECT value FROM retained')).rows, [[9]]);
        } else {
            assert.deepEqual((await f.db.executeReadQuery('SELECT value FROM items ORDER BY value')).rows, [[7], [11]]);
            await f.db.executeQuery('ROLLBACK');
            assert.deepEqual((await f.db.executeReadQuery('SELECT value FROM items')).rows, [[7]]);
            assert.deepEqual((await f.db.executeQuery("SELECT name FROM sqlite_schema WHERE name='pending_index'"))[0].rows, []);
        }
    });
}

for (const change of ['reordered table', 'wider view'] as const) {
    it(`keeps native result headers and values on one snapshot during an external ${change} change`, async t => {
        const f = await fixture(t); if (!f) return;
        await f.db.executeQuery("CREATE TABLE source(first TEXT, second TEXT); INSERT INTO source VALUES ('left', 'right')");
        if (change === 'wider view') await f.db.executeQuery('CREATE VIEW selected AS SELECT first, second FROM source');
        const sql = change === 'wider view' ? 'SELECT * FROM selected' : 'SELECT * FROM source';
        const external = new DatabaseSync(f.file);
        f.externalConnections.push(external);
        assert.equal(external.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
        const call = NativeWorkerProcess.prototype.call;
        let changed = false;
        t.mock.method(NativeWorkerProcess.prototype, 'call', async function(this: NativeWorkerProcess, ...args: Parameters<typeof call>) {
            const result = await call.apply(this, args);
            if (args[0] === 'describeReadQuery' && !changed) {
                changed = true;
                external.exec(change === 'wider view'
                    ? "DROP VIEW selected; CREATE VIEW selected AS SELECT second, first, 'new' AS added FROM source"
                    : "DROP TABLE source; CREATE TABLE source(second TEXT, first TEXT); INSERT INTO source VALUES ('new-right', 'new-left')");
            }
            return result;
        });
        const result = await f.db.executeReadQuery(sql);
        assert.equal(changed, true);
        assert.deepEqual(result.headers, ['first', 'second']);
        assert.deepEqual(result.rows, [['left', 'right']], 'the same read must not attach old labels to a new row layout');
        const next = await f.db.executeReadQuery(sql);
        assert.deepEqual(next.headers, change === 'wider view' ? ['second', 'first', 'added'] : ['second', 'first']);
        assert.deepEqual(next.rows, change === 'wider view' ? [['right', 'left', 'new']] : [['new-right', 'new-left']]);
    });
}
