import './vscode_mock_setup';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';
import type { DatabaseOperations } from '../../src/core/types';

for (const backend of ['wasm', 'native'] as const) {
    it(`${backend} explains the original parameterized SELECT without executing it`, async () => {
        const wasm = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        let bundle: Awaited<ReturnType<typeof createNativeDatabaseConnection>> | undefined;
        let directory: string | undefined;
        try {
            let db: DatabaseOperations = wasm;
            if (backend === 'native') {
                fs.mkdirSync('.tmp', { recursive: true });
                directory = fs.mkdtempSync(path.resolve('.tmp/query-plan-'));
                const file = path.join(directory, 'plan.db'); fs.writeFileSync(file, await wasm.serializeDatabase());
                bundle = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
                db = (await bundle.establishConnection(vscode.Uri.file(file), 'plan.db')).databaseOps;
            }
            await db.executeQuery('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)');
            await db.executeQuery('CREATE INDEX by_label ON items(label COLLATE NOCASE)');
            const sql = 'SELECT id FROM items WHERE label LIKE ? ORDER BY label';
            const plan = await db.executeReadQuery(sql, ['ab%'], true);
            assert.deepEqual(plan.headers, ['id', 'parent', 'notused', 'detail']);
            assert.deepEqual(plan.rows, (await db.executeQuery(`EXPLAIN QUERY PLAN ${sql}`, ['ab%']))[0].rows);
            assert.match(String(plan.rows), /by_label/);
            const distinctSql = 'SELECT DISTINCT label FROM items ORDER BY label';
            assert.deepEqual((await db.executeReadQuery(distinctSql, [], true)).rows,
                (await db.executeQuery(`EXPLAIN QUERY PLAN ${distinctSql}`))[0].rows,
                'the plan must not include the result reader\'s extra subquery and LIMIT');
            assert.ok((await db.executeReadQuery('SELECT abs(-9223372036854775808) AS overflow', [], true)).rows.length);
            await assert.rejects(db.executeReadQuery('SELECT abs(-9223372036854775808) AS overflow'));
            await db.executeQuery('CREATE TEMP TABLE session_rows (id INTEGER PRIMARY KEY)');
            await db.executeQuery('BEGIN');
            try {
                await db.executeQuery('CREATE INDEX temporary_index ON session_rows(id)');
                const tempSql = 'SELECT id FROM session_rows WHERE id = ?';
                assert.deepEqual((await db.executeReadQuery(tempSql, [42], true)).rows,
                    (await db.executeQuery(`EXPLAIN QUERY PLAN ${tempSql}`, [42]))[0].rows);
            } finally { await db.executeQuery('ROLLBACK'); }
            await assert.rejects(db.executeReadQuery('DELETE FROM items', [], true));
            await assert.rejects(db.executeReadQuery('SELECT ?', [], true), /Expected 1/);
            await assert.rejects(db.executeReadQuery('SELECT missing_column FROM items', [], true));
            assert.deepEqual((await db.executeQuery('SELECT length(zeroblob(2097152))'))[0].rows, [[2097152]],
                'a failed plan must restore the connection length limit');
            const cancelled = new AbortController(); cancelled.abort();
            await assert.rejects(db.executeReadQuery('SELECT 1', [], true, cancelled.signal));
            assert.ok((await db.executeReadQuery('SELECT 1', [], true)).rows.length);
            const widePlan = 'SELECT ' + Array.from({ length: 600 }, (_, index) => `(SELECT count(*) FROM items) AS c${index}`).join(',');
            const bounded = await db.executeReadQuery(widePlan, [], true);
            assert.equal(bounded.rows.length, 1001, 'one lookahead entry marks a plan truncated at 1000 displayed entries');
            assert.deepEqual((await db.executeQuery('SELECT length(zeroblob(2097152))'))[0].rows, [[2097152]],
                'truncating a plan must also restore connection limits');
        } finally {
            bundle?.workerMethods[Symbol.dispose](); wasm.shutdown();
            if (directory) fs.rmSync(directory, { recursive: true, force: true });
        }
    });
}
