import './vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import * as vscode from 'vscode';

import { isReadStatement } from '../../src/core/read-statement';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection, isNativeAvailable } from '../../src/nativeWorker';
import { streamTableExport } from '../../src/tableExportStreaming';
import type { DatabaseOperations, ExportOptions } from '../../src/core/types';

// A read steps with SQLite refusing every write on the connection. The probe
// view has a row only while writes are allowed, so every read entry must find
// it empty, and the connection must accept writes again afterwards.
const PROBE_VIEW = 'CREATE VIEW guard_probe AS SELECT 1 AS writable FROM pragma_query_only WHERE query_only = 0';
const SLOW_VIEW = 'CREATE VIEW slow_view AS WITH RECURSIVE n(x) AS ' +
    '(SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 1000000000) SELECT sum(x) AS total FROM n';

const directories: string[] = [];
after(() => {
    for (const directory of directories) {
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

async function exportedRows(ops: DatabaseOperations, source: string, columns: string[]): Promise<number> {
    const chunks: string[] = [];
    await streamTableExport(
        ops, source, columns,
        { format: 'csv', includeTableName: false, header: false } as ExportOptions,
        { write: async (chunk: string) => { chunks.push(chunk); } }
    );
    return chunks.join('').split('\n').filter(line => line.length > 0).length;
}

async function assertReadsRefuseWrites(ops: DatabaseOperations, exportUsesReadOnlyHandle: boolean): Promise<void> {
    await ops.executeQuery('CREATE TABLE notes (id INTEGER PRIMARY KEY, label TEXT)');
    await ops.executeQuery("INSERT INTO notes (label) VALUES ('one'), ('two')");
    await ops.executeQuery(PROBE_VIEW);

    // Control: the same view read by a statement that is not a read sees a
    // writable connection, so an empty result below is the guard at work.
    const control = await ops.executeQuery(
        'PRAGMA query_only; SELECT count(*) FROM guard_probe'
    );
    assert.equal(Number(control.at(-1)?.rows[0]?.[0]), 1);

    const page = await ops.fetchTableData('guard_probe', { limit: 100, offset: 0 });
    assert.equal(page.rows.length, 0, 'grid page');
    const filtered = await ops.fetchTableData('guard_probe', { limit: 100, offset: 0, globalFilter: '1' });
    assert.equal(filtered.rows.length, 0, 'filtered grid page');
    assert.equal((await ops.fetchTableCount('guard_probe', {})).count, 0, 'count');
    assert.equal((await ops.executeQuery('SELECT * FROM guard_probe'))[0]?.rows.length ?? 0, 0, 'generic SELECT');
    assert.equal(
        Number((await ops.executeQuery(
            '/* lead */ WITH probe (writable) AS (SELECT writable FROM guard_probe) SELECT count(*) FROM probe;'
        ))[0].rows[0][0]),
        0,
        'generic WITH … SELECT'
    );
    assert.equal(
        Number((await ops.executeQuery('VALUES ((SELECT count(*) FROM guard_probe))'))[0].rows[0][0]),
        0,
        'generic VALUES'
    );
    assert.equal(
        (await ops.previewViewDefinition('preview_probe', 'SELECT * FROM guard_probe', 10, 'create')).rows.length,
        0,
        'view preview'
    );
    if (ops.openQueryReadSession) {
        const session = await ops.openQueryReadSession('SELECT * FROM guard_probe');
        try {
            assert.equal((await ops.readQueryRows!(session.sessionId, 100)).rows.length, 0, 'query read session');
        } finally {
            await ops.closeQueryReadSession!(session.sessionId);
        }
    }
    // The native export reads through a handle opened read-only, which
    // PRAGMA query_only does not describe; the WebAssembly export steps on
    // the one connection.
    assert.equal(await exportedRows(ops, 'guard_probe', ['writable']), exportUsesReadOnlyHandle ? 1 : 0, 'export');

    // A write is not a read: a statement that starts with WITH still writes.
    await ops.executeQuery(
        "WITH added (label) AS (VALUES ('three')) INSERT INTO notes (label) SELECT label FROM added"
    );
    assert.equal(Number((await ops.executeQuery('PRAGMA query_only'))[0].rows[0][0]), 0);
    await ops.updateCell('notes', 1, 'label', 'edited');
    assert.deepEqual(
        (await ops.executeQuery('SELECT label FROM notes ORDER BY id'))[0].rows.map(row => row[0]),
        ['edited', 'two', 'three']
    );
}

async function assertTimedOutReadLeavesWritesAllowed(ops: DatabaseOperations): Promise<void> {
    await ops.executeQuery('CREATE TABLE notes (id INTEGER PRIMARY KEY, label TEXT)');
    await ops.executeQuery("INSERT INTO notes (label) VALUES ('one')");
    await ops.executeQuery(SLOW_VIEW);
    await assert.rejects(ops.fetchTableData('slow_view', { limit: 10, offset: 0 }), /timed out/i);
    await assert.rejects(ops.executeQuery('SELECT * FROM slow_view'), /timed out/i);
    assert.equal(Number((await ops.executeQuery('PRAGMA query_only'))[0].rows[0][0]), 0);
    await ops.updateCell('notes', 1, 'label', 'after the timeout');
    assert.equal((await ops.executeQuery('SELECT label FROM notes'))[0].rows[0][0], 'after the timeout');
}

describe('statement classification', () => {
    it('reports only single SELECT statements as reads', () => {
        const reads = [
            'SELECT 1',
            '  select * from t;',
            '-- note\n/* block */ SELECT 1 ; -- tail\n',
            'VALUES (1), (2)',
            'WITH a AS (SELECT 1) SELECT * FROM a',
            'with recursive n(x) as (select 1 union all select x + 1 from n where x < 3) select * from n',
            'WITH a (x, y) AS NOT MATERIALIZED (SELECT 1, 2), "b c" AS MATERIALIZED (SELECT 3) VALUES ((SELECT x FROM a))',
            "WITH replace AS (SELECT ')' AS s, 0x1F AS n, 1e5 AS e) SELECT * FROM replace",
            'SELECT "a;b", \'it\'\'s; fine\', [x;y], `p``q;` FROM t',
            "SELECT 'INSERT INTO t VALUES (1)'"
        ];
        const others = [
            '',
            '   ',
            '-- only a comment',
            'INSERT INTO t VALUES (1)',
            'UPDATE t SET a = 1',
            'DELETE FROM t',
            'REPLACE INTO t VALUES (1)',
            'PRAGMA query_only',
            'EXPLAIN SELECT 1',
            'CREATE TABLE t AS SELECT 1',
            'SAVEPOINT a',
            'WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a',
            'WITH a AS (SELECT 1) REPLACE INTO t SELECT * FROM a',
            'WITH a AS (SELECT 1) UPDATE t SET x = (SELECT * FROM a)',
            'with a(x) as (select 1) delete from t where x in (select x from a)',
            'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 3) INSERT INTO t SELECT x FROM n',
            'WITH a AS (SELECT 1)',
            'SELECT 1; SELECT 2',
            'SELECT 1; DELETE FROM t',
            'SELECT (1',
            'SELECT 1)',
            "SELECT 'unterminated",
            '(SELECT 1)',
            '"SELECT" 1',
            '1 SELECT'
        ];
        for (const sql of reads) assert.equal(isReadStatement(sql), true, sql);
        for (const sql of others) assert.equal(isReadStatement(sql), false, sql);
    });

    it('classifies a long statement without stepping through its literals', () => {
        const literal = `'${'x'.repeat(2_000_000)}'`;
        const started = performance.now();
        assert.equal(isReadStatement(`SELECT ${literal}`), true);
        assert.equal(isReadStatement(`WITH big (v) AS (VALUES (${literal})) SELECT v FROM big`), true);
        assert.equal(isReadStatement(`WITH big (v) AS (VALUES (${literal})) INSERT INTO t SELECT v FROM big`), false);
        assert.ok(performance.now() - started < 1000);
    });
});

describe('reads refuse writes', () => {
    it('on the WebAssembly engine', async () => {
        const engine = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
        try {
            await assertReadsRefuseWrites(engine, false);
        } finally {
            engine.shutdown();
        }
    });

    it('on the WebAssembly engine after a read times out', async () => {
        const engine = (await createDatabaseEngine({
            content: null, maxSize: 0, readOnlyMode: false, queryTimeout: 200
        })).operations as WasmDatabaseEngine;
        try {
            await assertTimedOutReadLeavesWritesAllowed(engine);
        } finally {
            engine.shutdown();
        }
    });

    it('through the bundled native worker', async (context) => {
        if (!await isNativeAvailable(process.cwd())) {
            if (process.env.FUZZ_EXPECT_TARGET) throw new Error(`Missing native runtime for ${process.env.FUZZ_EXPECT_TARGET}`);
            return context.skip('Bundled native runtime unavailable');
        }
        fs.mkdirSync('.tmp', { recursive: true });
        const directory = fs.mkdtempSync(path.resolve('.tmp/read-refuses-writes-'));
        directories.push(directory);
        const open = async (name: string, queryTimeout?: number) => {
            const file = path.join(directory, name);
            fs.closeSync(fs.openSync(file, 'w'));
            const native = await createNativeDatabaseConnection(
                vscode.Uri.file(process.cwd()), undefined, undefined, queryTimeout
            );
            context.after(() => native.workerMethods[Symbol.dispose]());
            return (await native.establishConnection(vscode.Uri.file(file), name, false)).databaseOps;
        };
        await assertReadsRefuseWrites(await open('reads.db'), true);
        await assertTimedOutReadLeavesWritesAllowed(await open('timeout.db', 1000));
    });
});
