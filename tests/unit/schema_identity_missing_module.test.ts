import './vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as vscode from 'vscode';

import { TABLE_IDENTITY_METADATA_SQL } from '../../src/core/row-identity';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import type { DatabaseOperations } from '../../src/core/types';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';

/**
 * A schema load reads identity metadata for every table in one query. That
 * query joined pragma_table_info to every table, and SQLite ran it for each
 * joined row before the ON clause that keeps only WITHOUT ROWID tables. For a
 * virtual table whose module the build lacks, table_info fails with "no such
 * module", so one such table failed the schema load of the whole database:
 * FTS3/FTS4 on the native engine, or an extension's module on either engine.
 * The query now asks table_info only about the tables whose columns it reads.
 */

/** The query before that change. It must return the same rows wherever it runs. */
const PREVIOUS_IDENTITY_SQL = `
SELECT
  tl."name" AS table_name,
  tl."type" AS object_type,
  tl."wr" AS without_rowid,
  ti."cid" AS column_ordinal,
  ti."name" AS column_name,
  ti."type" AS declared_type,
  ti."pk" AS primary_key_position,
  CASE WHEN ti."pk" > 0 THEN (
    SELECT key."coll" FROM pragma.pragma_index_list(tl."name", tl."schema") AS pk_index
    JOIN pragma.pragma_index_xinfo(pk_index."name", tl."schema") AS key
    WHERE pk_index."origin" = 'pk' AND key."name" = ti."name" AND key."key" = 1 LIMIT 1
  ) END AS primary_key_collation
FROM pragma.pragma_table_list AS tl
LEFT JOIN pragma.pragma_table_info(tl."name", tl."schema") AS ti
  ON tl."type" IN ('table', 'shadow') AND tl."wr" = 1
WHERE tl."schema" = 'main' AND tl."name" NOT LIKE 'sqlite_%'
ORDER BY tl."name", ti."cid"`;

/** Every kind of object the query classifies, on both engines. */
const SCHEMAS: Array<[string, string]> = [
    ['an empty database', 'SELECT 1'],
    ['ordinary, WITHOUT ROWID, generated, STRICT, view, FTS5, R*Tree and TEMP objects', `
        CREATE TABLE plain(a, b);
        CREATE INDEX plain_a ON plain(a);
        CREATE TABLE "we""ird name"(x INTEGER PRIMARY KEY, y TEXT);
        CREATE TABLE seq(id INTEGER PRIMARY KEY AUTOINCREMENT, v);
        INSERT INTO seq(v) VALUES (1);
        CREATE TABLE wr(k TEXT COLLATE NOCASE, n INTEGER, v, PRIMARY KEY (n DESC, k)) WITHOUT ROWID;
        CREATE TABLE "wr ""quoted"""(a INTEGER, g INTEGER GENERATED ALWAYS AS (a + 1) VIRTUAL,
            k TEXT PRIMARY KEY COLLATE RTRIM) WITHOUT ROWID;
        CREATE TABLE strict_wr(id INTEGER PRIMARY KEY, t TEXT) STRICT, WITHOUT ROWID;
        CREATE VIEW v AS SELECT a FROM plain;
        CREATE VIRTUAL TABLE search USING fts5(body);
        INSERT INTO search VALUES ('hello');
        CREATE VIRTUAL TABLE boxes USING rtree(id, minx, maxx);
        CREATE TEMP TABLE scratch(a PRIMARY KEY) WITHOUT ROWID;
    `],
    // User tables in main may take the PRAGMA tables' names; the query reads
    // SQLite's own through the pragma schema.
    ['user tables named like the PRAGMA tables', `
        CREATE TABLE pragma_table_list(schema, name, type, ncol, wr, strict);
        INSERT INTO pragma_table_list VALUES ('main', 'ghost', 'table', 1, 1, 0);
        CREATE TABLE pragma_table_info(cid, name, type, "notnull", dflt_value, pk, PRIMARY KEY (cid)) WITHOUT ROWID;
    `]
];

async function rows(ops: DatabaseOperations, sql: string): Promise<unknown[][]> {
    return (await ops.executeQuery(sql))[0]?.rows ?? [];
}

function scratchDirectory(prefix: string): string {
    fs.mkdirSync('.tmp', { recursive: true });
    return fs.mkdtempSync(path.resolve(`.tmp/${prefix}-`));
}

async function withWasm(content: Uint8Array | null, work: (ops: WasmDatabaseEngine) => Promise<void>) {
    const engine = (await createDatabaseEngine({ content, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
    try {
        await work(engine);
    } finally {
        engine.shutdown();
    }
}

async function withNative(file: string, work: (ops: DatabaseOperations) => Promise<void>) {
    const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
    try {
        const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), path.basename(file), false);
        await work(databaseOps);
    } finally {
        native.workerMethods[Symbol.dispose]();
    }
}

function bundledNativeBinary(): string | undefined {
    const platformDir = process.platform === 'darwin'
        ? (process.arch === 'arm64' ? 'aarch64-macos' : 'x86_64-macos')
        : process.platform === 'linux'
            ? (process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu')
            : process.platform === 'win32' && process.arch === 'x64' ? 'x86_64-windows' : undefined;
    const binary = platformDir && path.join('natives', platformDir, process.platform === 'win32' ? 'tjs.exe' : 'tjs');
    return binary && fs.existsSync(binary) ? binary : undefined;
}

const noNative = () => bundledNativeBinary() ? false : `no bundled txiki worker for ${process.platform}-${process.arch}`;

/** Both queries' rows; the corpus must hold what the query tells apart. */
async function compareQueries(ops: DatabaseOperations, label: string, expectKinds: boolean) {
    const previous = await rows(ops, PREVIOUS_IDENTITY_SQL);
    const current = await rows(ops, TABLE_IDENTITY_METADATA_SQL);
    assert.deepEqual(current, previous, label);
    if (!expectKinds) return;
    const kinds = new Set(current.map(row => `${String(row[1])}/${String(row[2])}`));
    for (const kind of ['table/0', 'table/1', 'view/0', 'virtual/0', 'shadow/0', 'shadow/1']) {
        assert.ok(kinds.has(kind), `${label}: the corpus has no ${kind} object`);
    }
    assert.ok(current.some(row => row[7] === 'NOCASE') && current.some(row => row[7] === 'RTRIM'), label);
}

type SqlJsDatabase = { run(sql: string): void; export(): Uint8Array; close(): void };

/**
 * A database with a virtual table whose module no build has, as a loadable
 * extension leaves one. sql.js writes the schema row directly: node:sqlite
 * refuses that in the Node versions that open a database in defensive mode.
 */
async function imageWithUnknownModule(): Promise<Uint8Array> {
    const initSqlJs = (await import('../../vendor/sql.js/sql-wasm.js')).default as unknown as
        (config: object) => Promise<{ Database: new () => SqlJsDatabase }>;
    const db = new (await initSqlJs({})).Database();
    try {
        db.run(`
            CREATE TABLE plain(id INTEGER PRIMARY KEY, a);
            INSERT INTO plain VALUES (1, 'before');
            CREATE TABLE wr(k TEXT PRIMARY KEY COLLATE NOCASE, v) WITHOUT ROWID;
            INSERT INTO wr VALUES ('a', 1);
            PRAGMA writable_schema = ON;
            INSERT INTO sqlite_schema(type, name, tbl_name, rootpage, sql)
                VALUES ('table', 'ext_idx', 'ext_idx', 0, 'CREATE VIRTUAL TABLE ext_idx USING absent_module()');
            PRAGMA writable_schema = OFF;
        `);
        return db.export();
    } finally {
        db.close();
    }
}

/** The schema loads, ordinary tables page and edit, and only the virtual table fails. */
async function expectOnlyTheVirtualTableToFail(ops: DatabaseOperations, virtualTable: string, module: string) {
    const missing = new RegExp(`no such module: ${module}`);
    const schema = await ops.fetchSchema();
    const identities = new Map(schema.tables.map(table => [table.identifier, table.identity]));
    assert.deepEqual(identities.get('plain'), { kind: 'rowid' });
    assert.deepEqual(identities.get(virtualTable), { kind: 'rowid' });
    assert.deepEqual(identities.get('wr'), {
        kind: 'primaryKey',
        columns: [{ identifier: 'k', declaredType: 'TEXT', position: 1, collation: 'NOCASE' }]
    });

    assert.deepEqual((await ops.fetchTableData('plain', { limit: 10, offset: 0 })).rows, [[1, 'before']]);
    assert.deepEqual(await ops.fetchTableCount('plain', {}), { count: 1, isExact: true });
    await ops.updateCell('plain', 1, 'a', 'after');
    assert.deepEqual(await rows(ops, 'SELECT a FROM plain'), [['after']]);
    assert.deepEqual((await ops.fetchTableData('wr', { limit: 10, offset: 0 })).rows, [['a', 1]]);

    await assert.rejects(ops.getTableInfo(virtualTable), missing);
    await assert.rejects(ops.fetchTableData(virtualTable, { limit: 10, offset: 0 }), missing);
    await assert.rejects(ops.fetchTableCount(virtualTable, {}), missing);
}

describe('schema identity metadata', () => {
    for (const [label, schema] of SCHEMAS) {
        const expectKinds = schema.includes('fts5');
        it(`returns the previous query's rows on WebAssembly for ${label}`, async () => {
            await withWasm(null, async ops => {
                await ops.executeQuery(schema);
                await compareQueries(ops, label, expectKinds);
            });
        });

        it(`returns the previous query's rows on native for ${label}`, { skip: noNative() }, async () => {
            const directory = scratchDirectory('identity-rows');
            try {
                const file = path.join(directory, 'corpus.db');
                fs.closeSync(fs.openSync(file, 'w'));
                await withNative(file, async ops => {
                    await ops.executeQuery(schema);
                    await compareQueries(ops, label, expectKinds);
                });
            } finally {
                fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            }
        });
    }

    it('loads a WebAssembly schema that has a virtual table whose module is missing', async () => {
        await withWasm(await imageWithUnknownModule(), async ops => {
            await assert.rejects(rows(ops, PREVIOUS_IDENTITY_SQL), /no such module: absent_module/);
            await expectOnlyTheVirtualTableToFail(ops, 'ext_idx', 'absent_module');
        });
    });

    it('loads a native schema that has a virtual table whose module is missing', { skip: noNative() }, async () => {
        const directory = scratchDirectory('identity-module');
        try {
            const file = path.join(directory, 'unknown-module.db');
            fs.writeFileSync(file, await imageWithUnknownModule());
            await withNative(file, async ops => {
                await assert.rejects(rows(ops, PREVIOUS_IDENTITY_SQL), /no such module: absent_module/);
                await expectOnlyTheVirtualTableToFail(ops, 'ext_idx', 'absent_module');
            });
        } finally {
            fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });

    it('loads a native schema that has FTS4 tables, which the native build leaves out', { skip: noNative() }, async () => {
        const directory = scratchDirectory('identity-fts4');
        try {
            const file = path.join(directory, 'fts4.db');
            // The WebAssembly build has FTS4 and writes the file.
            await withWasm(null, async ops => {
                await ops.executeQuery(`
                    CREATE TABLE plain(id INTEGER PRIMARY KEY, a);
                    INSERT INTO plain VALUES (1, 'before');
                    CREATE TABLE wr(k TEXT PRIMARY KEY COLLATE NOCASE, v) WITHOUT ROWID;
                    INSERT INTO wr VALUES ('a', 1);
                    CREATE VIRTUAL TABLE notes USING fts4(body);
                    INSERT INTO notes(docid, body) VALUES (1, 'hello world');
                `);
                fs.writeFileSync(file, await ops.serializeDatabase());
            });
            await withNative(file, async ops => {
                await assert.rejects(rows(ops, PREVIOUS_IDENTITY_SQL), /no such module: fts4/);
                await expectOnlyTheVirtualTableToFail(ops, 'notes', 'fts4');
                // Without the module SQLite cannot tell that these belong to
                // the virtual table, and lists them as ordinary tables.
                const schema = await ops.fetchSchema();
                assert.ok(schema.tables.some(table => table.identifier === 'notes_content'));
            });
        } finally {
            fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });
});
