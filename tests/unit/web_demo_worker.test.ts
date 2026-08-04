import './vscode_mock_setup';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { Worker as NodeWorker } from 'node:worker_threads';
import esbuild from 'esbuild';
import initSqlJs from '../../vendor/sql.js/sql-wasm.js';

interface WorkerHarness {
    invoke(method: string, ...payload: unknown[]): Promise<any>;
}

const authoredWorkerPath = path.resolve(
    process.cwd(),
    'website/src/sqlite-viewer/worker.js'
);
const bundledWorkerPath = path.resolve(
    process.cwd(),
    'website/public/sqlite-viewer/worker.js'
);
const BUNDLED_SQLJS_SQLITE_VERSION = '3.49.1';
const DIVERGENT_REAL_TEXT_BY_SQLJS_SQLITE_VERSION: Record<string, string> = {
    '3.49.1': '9.6529377952985e+282'
};

let currentWorkerBundle: Promise<string> | undefined;

function readCurrentWorkerBundle(): Promise<string> {
    currentWorkerBundle ??= (async () => {
    assert.ok(
        existsSync(bundledWorkerPath),
        'website worker bundle is missing; run node scripts/build.mjs'
    );
    const rendered = await esbuild.build({
        entryPoints: [authoredWorkerPath],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        target: 'es2020',
        minify: true,
        write: false
    });
    assert.strictEqual(rendered.outputFiles.length, 1);
    const renderedSource = rendered.outputFiles[0].text;
    const expectedHash = createHash('sha256').update(renderedSource).digest('hex');
    const bundledSource = readFileSync(bundledWorkerPath, 'utf8');
    const bundledHash = bundledSource.match(
        /sqlite-viewer-bundle-sha256:([a-f0-9]{64})/
    )?.[1];
    const freshnessFailure =
        'website worker bundle is stale or esbuild output/version drifted; ' +
        'run node scripts/build.mjs';
    assert.strictEqual(
        bundledHash,
        expectedHash,
        freshnessFailure
    );
    assert.strictEqual(
        bundledSource,
        `/*! sqlite-viewer-bundle-sha256:${expectedHash} */\n${renderedSource}`,
        freshnessFailure
    );
    return bundledSource;
    })();
    return currentWorkerBundle;
}

async function createWorkerHarness(options: {
    content?: Uint8Array;
    queryTimeout?: number;
    now?: () => number;
    readOnlyMode?: boolean;
    useBundledWasm?: boolean;
    initSqlJs?: (config: any) => Promise<any>;
    onImportScripts?: (url: string) => void;
    onSql?: (kind: 'exec' | 'prepare', sql: string) => void;
} = {}): Promise<WorkerHarness> {
    const source = await readCurrentWorkerBundle();
    const responses: any[] = [];
    const initializeSqlJs = options.initSqlJs ?? initSqlJs;
    const workerGlobal: any = {
        initSqlJs: async (config: any) => {
            const sqlJs = await initializeSqlJs(config);
            if (!options.onSql) return sqlJs;
            const ObservedDatabase = new Proxy(sqlJs.Database, {
                construct(Target: any, args: any[]): object {
                    const database = Reflect.construct(Target, args) as Record<string, any>;
                    for (const kind of ['exec', 'prepare'] as const) {
                        const original = database[kind].bind(database);
                        database[kind] = (sql: string, ...methodArgs: unknown[]) => {
                            options.onSql?.(kind, sql);
                            return original(sql, ...methodArgs);
                        };
                    }
                    return database;
                }
            });
            return { ...sqlJs, Database: ObservedDatabase };
        },
        postMessage(message: unknown) {
            responses.push(message);
        }
    };
    const context = vm.createContext({
        self: workerGlobal,
        importScripts(url: string) { options.onImportScripts?.(url); },
        console: { log() {}, warn() {}, error() {} },
        Uint8Array,
        Int32Array,
        ArrayBuffer,
        SharedArrayBuffer,
        Atomics,
        DataView,
        crypto: webcrypto,
        TextEncoder,
        TextDecoder,
        Date: options.now ? { now: options.now } : Date,
        setTimeout,
        clearTimeout
    });
    new vm.Script(source, { filename: 'website/public/sqlite-viewer/worker.js' })
        .runInContext(context);

    let messageId = 0;
    const invoke = async (method: string, ...payload: unknown[]) => {
        const id = `test_${++messageId}`;
        await workerGlobal.onmessage({
            data: {
                channel: 'rpc',
                content: {
                    kind: 'invoke',
                    messageId: id,
                    targetMethod: method,
                    payload
                }
            }
        });
        const responseIndex = responses.findIndex(message => message.content?.messageId === id);
        assert.notStrictEqual(responseIndex, -1, `worker did not respond to ${method}`);
        const [response] = responses.splice(responseIndex, 1);
        if (!response.content.success) {
            throw new Error(response.content.errorMessage);
        }
        return response.content.data;
    };

    const initConfig: Record<string, unknown> = {
        content: options.content ?? null,
        queryTimeout: options.queryTimeout,
        readOnlyMode: options.readOnlyMode
    };
    if (options.useBundledWasm !== false) {
        initConfig.wasmBinary = new Uint8Array(readFileSync(
            path.resolve(process.cwd(), 'assets/sqlite3.wasm')
        ));
    }
    await invoke('initializeDatabase', 'test.db', initConfig);
    return { invoke };
}

async function workerScalar(worker: WorkerHarness, sql: string): Promise<unknown> {
    const result = await worker.invoke('runQuery', sql);
    return result[0]?.rows?.[0]?.[0];
}

describe('web demo view worker', () => {
    it('loads the patched sql.js release from self-hosted files', async () => {
        const importedUrls: string[] = [];
        let wasmUrl = '';

        await createWorkerHarness({
            useBundledWasm: false,
            onImportScripts: url => importedUrls.push(url),
            initSqlJs: async config => {
                wasmUrl = config.locateFile('sql-wasm.wasm');
                return { Database: class {} };
            }
        });

        assert.deepStrictEqual(importedUrls, [
            './sql-wasm.js'
        ]);
        assert.strictEqual(
            wasmUrl,
            './sql-wasm.wasm'
        );
    });

    it('deletes a column using the demo worker table-info shape', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE TABLE demo_delete (id INTEGER, kept TEXT, removed TEXT); " +
            "INSERT INTO demo_delete VALUES (1, 'survives', 'gone')"
        );

        await worker.invoke('deleteColumns', 'demo_delete', ['removed']);

        const tableInfo = await worker.invoke('getTableInfo', 'demo_delete');
        assert.deepStrictEqual(
            Array.from(tableInfo, (column: any) => column.identifier),
            ['id', 'kept']
        );
        const rows = await worker.invoke('runQuery', 'SELECT id, kept FROM demo_delete');
        assert.deepStrictEqual(Array.from(rows[0].rows[0]), [1, 'survives']);
    });

    it('does not execute a trailing statement smuggled through preview', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE TABLE preview_sentinel (id INTEGER)');

        await assert.rejects(() => worker.invoke(
            'previewViewDefinition',
            'unsafe_preview',
            'SELECT 1) LIMIT 1; DROP TABLE preview_sentinel; --',
            10,
            'create'
        ));

        assert.strictEqual(await workerScalar(
            worker,
            "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = 'preview_sentinel'"
        ), 1);
    });

    it('preserves duplicate explicit columns through an edit', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE VIEW duplicate_names (a, a) AS SELECT 1, 2');

        await worker.invoke('editView', 'duplicate_names', 'SELECT 3, 4', true);

        const storedSql = await workerScalar(
            worker,
            "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = 'duplicate_names'"
        );
        assert.match(String(storedSql), /\(a, a\)/);
        assert.doesNotMatch(String(storedSql), /a:1/);
    });

    it('rejects a stale expected view definition without replacing the newer demo view', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE VIEW shared_view AS SELECT 1 AS value');
        const stale = await worker.invoke('getViewDefinition', 'shared_view');
        await worker.invoke(
            'runQuery',
            'DROP VIEW shared_view; CREATE VIEW shared_view AS SELECT 2 AS value'
        );

        await assert.rejects(
            worker.invoke(
                'editView',
                'shared_view',
                'SELECT 3 AS value',
                true,
                stale.sql
            ),
            /changed outside this editor/i
        );
        assert.strictEqual(await workerScalar(worker, 'SELECT value FROM shared_view'), 2);
    });

    it('rejects a stale trigger snapshot before discarding demo triggers', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE VIEW trigger_cas_view AS SELECT 1 AS value');
        await worker.invoke(
            'runQuery',
            'CREATE TRIGGER trigger_cas_first INSTEAD OF INSERT ON trigger_cas_view ' +
            'BEGIN SELECT 1; END'
        );
        const stale = await worker.invoke('getViewDefinition', 'trigger_cas_view');
        await worker.invoke(
            'runQuery',
            'CREATE TRIGGER trigger_cas_second INSTEAD OF UPDATE ON trigger_cas_view ' +
            'BEGIN SELECT 2; END'
        );

        await assert.rejects(
            worker.invoke(
                'editView',
                'trigger_cas_view',
                'SELECT 2 AS value',
                false,
                stale.sql,
                stale.triggers
            ),
            /changed outside this editor/i
        );
        const current = await worker.invoke('getViewDefinition', 'trigger_cas_view');
        assert.strictEqual(current.selectSql, 'SELECT 1 AS value');
        assert.deepStrictEqual(
            Array.from(current.triggers, (trigger: any) => trigger.identifier),
            ['trigger_cas_first', 'trigger_cas_second']
        );
    });

    it('rejects demo view-history undo and redo when the installed state changed', async () => {
        const worker = await createWorkerHarness();
        const before = await worker.invoke('createView', 'demo_history_cas', 'SELECT 1 AS value');
        const edit = await worker.invoke(
            'editView',
            'demo_history_cas',
            'SELECT 2 AS value',
            true
        );
        const modification = {
            description: 'Edit demo_history_cas',
            modificationType: 'view_edit',
            targetTable: 'demo_history_cas',
            viewDefBefore: before,
            viewDefAfter: edit.after
        };

        await worker.invoke(
            'runQuery',
            'CREATE TRIGGER demo_history_undo_external ' +
            'INSTEAD OF INSERT ON demo_history_cas BEGIN SELECT 1; END'
        );
        await assert.rejects(
            worker.invoke('undoModification', modification),
            /changed outside this editor/i
        );
        let current = await worker.invoke('getViewDefinition', 'demo_history_cas');
        assert.strictEqual(current.selectSql, 'SELECT 2 AS value');
        assert.deepStrictEqual(
            Array.from(current.triggers, (trigger: any) => trigger.identifier),
            ['demo_history_undo_external']
        );

        await worker.invoke('runQuery', 'DROP TRIGGER demo_history_undo_external');
        await worker.invoke('undoModification', modification);
        await worker.invoke(
            'runQuery',
            'CREATE TRIGGER demo_history_redo_external ' +
            'INSTEAD OF UPDATE ON demo_history_cas BEGIN SELECT 2; END'
        );
        await assert.rejects(
            worker.invoke('redoModification', modification),
            /changed outside this editor/i
        );
        current = await worker.invoke('getViewDefinition', 'demo_history_cas');
        assert.strictEqual(current.selectSql, 'SELECT 1 AS value');
        assert.deepStrictEqual(
            Array.from(current.triggers, (trigger: any) => trigger.identifier),
            ['demo_history_redo_external']
        );
    });

    it('rejects a demo drop whose confirmed trigger snapshot became stale', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('createView', 'demo_drop_cas', 'SELECT 1 AS value');
        await worker.invoke(
            'runQuery',
            'CREATE TRIGGER demo_drop_first ' +
            'INSTEAD OF INSERT ON demo_drop_cas BEGIN SELECT 1; END'
        );
        const confirmed = await worker.invoke('getViewDefinition', 'demo_drop_cas');
        await worker.invoke(
            'runQuery',
            'CREATE TRIGGER demo_drop_second ' +
            'INSTEAD OF UPDATE ON demo_drop_cas BEGIN SELECT 2; END'
        );

        await assert.rejects(
            worker.invoke(
                'dropView',
                'demo_drop_cas',
                confirmed.sql,
                confirmed.triggers
            ),
            /changed outside this editor/i
        );
        const current = await worker.invoke('getViewDefinition', 'demo_drop_cas');
        assert.deepStrictEqual(
            Array.from(current.triggers, (trigger: any) => trigger.identifier),
            ['demo_drop_first', 'demo_drop_second']
        );
    });

    it('previews an edited view through its preserved explicit column list', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE VIEW preview_columns (public_id, public_name) AS " +
            "SELECT 1 AS internal_id, 'before' AS internal_name"
        );

        const preview = await worker.invoke(
            'previewViewDefinition',
            'preview_columns',
            "SELECT 2 AS replacement_id, 'after' AS replacement_name",
            10
        );

        assert.deepStrictEqual(Array.from(preview.headers), ['public_id', 'public_name']);
        assert.deepStrictEqual(
            Array.from(preview.rows, (row: unknown[]) => Array.from(row)),
            [[2, 'after']]
        );
    });

    it('previews an edit in the target-name context instead of reading the old demo view', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('createView', 'self_shadowed_view', 'SELECT 7 AS value');

        await assert.rejects(
            worker.invoke(
                'previewViewDefinition',
                'self_shadowed_view',
                'SELECT value FROM main.self_shadowed_view',
                10
            ),
            /circular/i
        );
        assert.strictEqual(await workerScalar(worker, 'SELECT value FROM self_shadowed_view'), 7);
    });

    it('edits and drops main views without touching same-named TEMP views', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('createView', 'demo_shadowed_view', "SELECT 'main-before' AS value");
        await worker.invoke(
            'runQuery',
            "CREATE TEMP VIEW demo_shadowed_view AS SELECT 'temp-value' AS value"
        );

        await worker.invoke(
            'editView',
            'demo_shadowed_view',
            "SELECT 'main-after' AS value",
            true
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM main.demo_shadowed_view'),
            'main-after'
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM temp.demo_shadowed_view'),
            'temp-value'
        );

        await worker.invoke('dropView', 'demo_shadowed_view');
        assert.strictEqual(await workerScalar(
            worker,
            "SELECT count(*) FROM sqlite_schema WHERE type = 'view' AND name = 'demo_shadowed_view'"
        ), 0);
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM temp.demo_shadowed_view'),
            'temp-value'
        );
    });

    it('compiles created and edited main views through broken TEMP shadows', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TEMP VIEW demo_create_compile_shadow AS ' +
            'SELECT value FROM missing_demo_create_source'
        );

        await worker.invoke(
            'createView',
            'demo_create_compile_shadow',
            "SELECT 'main-created' AS value"
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM main.demo_create_compile_shadow'),
            'main-created'
        );

        await worker.invoke(
            'createView',
            'demo_edit_compile_shadow',
            "SELECT 'main-before' AS value"
        );
        await worker.invoke(
            'runQuery',
            'CREATE TEMP VIEW demo_edit_compile_shadow AS ' +
            'SELECT value FROM missing_demo_edit_source'
        );
        await worker.invoke(
            'editView',
            'demo_edit_compile_shadow',
            "SELECT 'main-after' AS value",
            true
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM main.demo_edit_compile_shadow'),
            'main-after'
        );
    });

    it('validates and previews the main demo view through a same-named TEMP shadow', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('createView', 'demo_dry_run_shadow', "SELECT 'main-before' AS value");
        await worker.invoke(
            'runQuery',
            "CREATE TEMP VIEW demo_dry_run_shadow AS SELECT 'temp-value' AS value"
        );

        await worker.invoke(
            'validateViewDefinition',
            'demo_dry_run_shadow',
            "SELECT 'candidate' AS value",
            'edit'
        );
        const preview = await worker.invoke(
            'previewViewDefinition',
            'demo_dry_run_shadow',
            "SELECT 'candidate' AS value",
            10,
            'edit'
        );

        assert.deepStrictEqual(Array.from(preview.headers), ['value']);
        assert.deepStrictEqual(
            Array.from(preview.rows, (row: unknown[]) => Array.from(row)),
            [['candidate']]
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM main.demo_dry_run_shadow'),
            'main-before'
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM temp.demo_dry_run_shadow'),
            'temp-value'
        );
    });

    it('treats percent and underscore filters as literal LIKE text', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE TABLE literal_filters (value TEXT); " +
            "INSERT INTO literal_filters VALUES ('100% literal'), ('1000 literal'), " +
            "('under_score'), ('underXscore')"
        );

        const percent = await worker.invoke('fetchTableData', 'literal_filters', {
            columns: ['value'],
            filters: [{ column: 'value', value: '%' }],
            limit: 100,
            offset: 0
        });
        const underscore = await worker.invoke('fetchTableData', 'literal_filters', {
            columns: ['value'],
            globalFilter: '_',
            limit: 100,
            offset: 0
        });
        const underscoreCount = await worker.invoke('fetchTableCount', 'literal_filters', {
            columns: ['value'],
            globalFilter: '_'
        });

        assert.deepStrictEqual(
            Array.from(percent.rows, (row: unknown[]) => Array.from(row)),
            [['100% literal']]
        );
        assert.deepStrictEqual(
            Array.from(underscore.rows, (row: unknown[]) => Array.from(row)),
            [['under_score']]
        );
        assert.strictEqual(underscoreCount, 1);
    });

    it('matches native/WASM bounded TEXT and BLOB grid previews', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_contained_cells (text_value TEXT, blob_value BLOB); ' +
            "INSERT INTO demo_contained_cells VALUES ('😀😀😀', x'000102030405060708090a0b'); " +
            "INSERT INTO demo_contained_cells VALUES ('ok', x'0102')"
        );

        const page = await worker.invoke('fetchTableData', 'demo_contained_cells', {
            columns: ['rowid', 'text_value', 'blob_value'],
            orderBy: 'rowid',
            limit: 2,
            offset: 0,
            maxInlineCellBytes: 8,
            maxPageResponseBytes: 64
        });

        assert.deepStrictEqual(Array.from(page.rows[0].slice(0, 2)), [1, '😀😀']);
        assert.deepStrictEqual(Array.from(page.rows[0][2]), [0, 1, 2, 3, 4, 5, 6, 7]);
        assert.deepStrictEqual(Array.from(page.rows[1].slice(0, 2)), [2, 'ok']);
        assert.deepStrictEqual(Array.from(page.rows[1][2]), [1, 2]);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(page.oversizedCells)), {
            0: {
                1: { storageClass: 'text', byteLength: 12 },
                2: { storageClass: 'blob', byteLength: 12 }
            }
        });

        const small = await worker.invoke('fetchTableData', 'demo_contained_cells', {
            columns: ['rowid', 'text_value', 'blob_value'],
            filters: [{ column: 'text_value', value: 'ok' }],
            limit: 1,
            offset: 0,
            maxInlineCellBytes: 8,
            maxPageResponseBytes: 64
        });
        assert.deepStrictEqual(Array.from(small.rows[0].slice(0, 2)), [2, 'ok']);
        assert.deepStrictEqual(Array.from(small.rows[0][2]), [1, 2]);
        assert.strictEqual(small.oversizedCells, undefined);
    });

    it('marks an oversized demo WITHOUT ROWID primary key read-only', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_oversized_identity ' +
            '(key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID; ' +
            "INSERT INTO demo_oversized_identity VALUES ('abcdefghijklmnopqrstuvwxyz012345', 'visible')"
        );
        const page = await worker.invoke('fetchTableData', 'demo_oversized_identity', {
            columns: ['rowid', 'key', 'value'],
            limit: 1,
            offset: 0,
            maxInlineCellBytes: 8,
            maxPageResponseBytes: 64
        });
        const identity = page.rows[0][0];

        assert.match(String(identity), /^readonly-pk:/);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(page.oversizedCells)), {
            0: { 1: { storageClass: 'text', byteLength: 32 } }
        });
        assert.match(
            page.readOnlyRowReasons?.[0] ?? '',
            /WITHOUT ROWID primary-key column "key".*32 bytes.*identity was not transported/
        );
        await assert.rejects(
            worker.invoke('updateCell', 'demo_oversized_identity', identity, 'value', 'changed'),
            /WITHOUT ROWID primary-key column "key".*32 bytes.*identity was not transported/
        );
    });

    it('excludes the hidden rowid from demo data and count global filters', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE TABLE rowid_filters (value TEXT); " +
            "INSERT INTO rowid_filters(rowid, value) VALUES (12, 'visible text')"
        );

        const data = await worker.invoke('fetchTableData', 'rowid_filters', {
            columns: ['rowid', 'value'],
            globalFilterColumns: ['value'],
            globalFilter: '12',
            limit: 100,
            offset: 0
        });
        const count = await worker.invoke('fetchTableCount', 'rowid_filters', {
            columns: ['value'],
            globalFilterColumns: ['value'],
            globalFilter: '12'
        });

        assert.deepStrictEqual(Array.from(data.rows), []);
        assert.strictEqual(count, 0);
    });

    it('keeps a declared rowid column in demo data and count global filters', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE TABLE declared_rowid_filters (rowid TEXT); " +
            "INSERT INTO declared_rowid_filters(rowid) VALUES ('needle'), ('other')"
        );
        const options = {
            // Match the table-grid request shape: the first entry is its identity
            // projection and globalFilterColumns is the displayed schema.
            columns: ['rowid', 'rowid'],
            globalFilterColumns: ['rowid'],
            globalFilter: 'needle'
        };

        const data = await worker.invoke('fetchTableData', 'declared_rowid_filters', {
            ...options,
            limit: 100,
            offset: 0
        });
        const count = await worker.invoke('fetchTableCount', 'declared_rowid_filters', {
            columns: ['rowid'],
            globalFilterColumns: ['rowid'],
            globalFilter: 'needle'
        });

        assert.deepStrictEqual(
            Array.from(data.rows, (row: unknown[]) => Array.from(row)),
            [['needle', 'needle']]
        );
        assert.strictEqual(count, 1);
    });

    it('returns exact unsafe INTEGER text alongside rounded demo grid values', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE unsafe_integers (value INTEGER); ' +
            'INSERT INTO unsafe_integers(value) VALUES (9007199254740993)'
        );

        const data = await worker.invoke('fetchTableData', 'unsafe_integers', {
            columns: ['value'],
            globalFilterColumns: ['value'],
            globalFilter: '993',
            limit: 100,
            offset: 0
        });

        assert.strictEqual(data.rows[0][0], 9007199254740992);
        assert.strictEqual(data.exactIntegerTexts[0][0], '9007199254740993');
    });

    it('keeps adjacent unsafe demo table rowids distinct and editable', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE unsafe_demo_rowids (value TEXT); ' +
            "INSERT INTO unsafe_demo_rowids(rowid, value) VALUES " +
            "(7, 'safe'), (9007199254740992, 'lower'), (9007199254740993, 'higher')"
        );

        const data = await worker.invoke('fetchTableData', 'unsafe_demo_rowids', {
            columns: ['rowid', 'value'],
            orderBy: 'rowid',
            limit: 10,
            offset: 0
        });
        assert.strictEqual(data.rows[0][0], 7);
        assert.deepStrictEqual(
            data.rows.slice(1).map((row: unknown[]) => row[0]),
            ['9007199254740992', '9007199254740993']
        );

        await worker.invoke(
            'updateCell',
            'unsafe_demo_rowids',
            data.rows[2][0],
            'value',
            'edited'
        );
        const values = await worker.invoke('fetchTableData', 'unsafe_demo_rowids', {
            columns: ['rowid', 'value'],
            orderBy: 'rowid',
            limit: 10,
            offset: 0
        });
        assert.deepStrictEqual(
            values.rows.slice(1).map((row: unknown[]) => Array.from(row)),
            [
                ['9007199254740992', 'lower'],
                ['9007199254740993', 'edited']
            ]
        );
    });

    it('edits and deletes rows through WITHOUT ROWID primary-key identities', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_without_rowid (' +
            'tenant TEXT, sequence INTEGER, value TEXT, ' +
            'PRIMARY KEY (tenant, sequence)' +
            ') WITHOUT ROWID; ' +
            "INSERT INTO demo_without_rowid VALUES " +
            "('north', 9007199254740993, 'before')"
        );
        const page = await worker.invoke('fetchTableData', 'demo_without_rowid', {
            columns: ['rowid', 'tenant', 'sequence', 'value'],
            limit: 10,
            offset: 0
        });
        const oldIdentity = page.rows[0][0];
        assert.match(oldIdentity, /^pk:/);
        assert.strictEqual(page.exactIntegerTexts[0][2], '9007199254740993');

        const outcomes = await worker.invoke('updateCellBatch', 'demo_without_rowid', [
            { rowId: oldIdentity, column: 'tenant', value: 'south' },
            { rowId: oldIdentity, column: 'value', value: 'after' }
        ]);
        const newIdentity = outcomes[0].newRowId;
        assert.ok(newIdentity);
        assert.deepStrictEqual(
            (await worker.invoke(
                'runQuery',
                'SELECT tenant, CAST(sequence AS TEXT), value FROM demo_without_rowid'
            ))[0].rows,
            [['south', '9007199254740993', 'after']]
        );

        const updateModification = {
            modificationType: 'cell_update',
            targetTable: 'demo_without_rowid',
            affectedCells: outcomes
        };
        await worker.invoke('undoModification', updateModification);
        assert.deepStrictEqual(
            (await worker.invoke(
                'runQuery',
                'SELECT tenant, CAST(sequence AS TEXT), value FROM demo_without_rowid'
            ))[0].rows,
            [['north', '9007199254740993', 'before']]
        );
        await worker.invoke('redoModification', updateModification);
        assert.deepStrictEqual(
            (await worker.invoke(
                'runQuery',
                'SELECT tenant, CAST(sequence AS TEXT), value FROM demo_without_rowid'
            ))[0].rows,
            [['south', '9007199254740993', 'after']]
        );

        const deletedRows = await worker.invoke('deleteRows', 'demo_without_rowid', [newIdentity]);
        assert.strictEqual(
            await workerScalar(worker, 'SELECT count(*) FROM demo_without_rowid'),
            0
        );
        const deleteModification = {
            modificationType: 'row_delete',
            targetTable: 'demo_without_rowid',
            affectedRowIds: [newIdentity],
            deletedRows
        };
        await worker.invoke('undoModification', deleteModification);
        assert.strictEqual(
            await workerScalar(worker, 'SELECT count(*) FROM demo_without_rowid'),
            1
        );
        await worker.invoke('redoModification', deleteModification);
        assert.strictEqual(
            await workerScalar(worker, 'SELECT count(*) FROM demo_without_rowid'),
            0
        );
    });

    it('undoes dependent demo composite-key changes in reverse transition order', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_dependent_identity (' +
            'tenant INTEGER, sequence INTEGER, value TEXT, ' +
            'PRIMARY KEY (tenant, sequence)' +
            ') WITHOUT ROWID; ' +
            "INSERT INTO demo_dependent_identity VALUES (1, 1, 'first'), (1, 2, 'second')"
        );
        const page = await worker.invoke('fetchTableData', 'demo_dependent_identity', {
            columns: ['rowid', 'tenant', 'sequence', 'value'],
            orderBy: 'sequence',
            limit: 10,
            offset: 0
        });
        const affectedCells = await worker.invoke('updateCellBatch', 'demo_dependent_identity', [
            { rowId: page.rows[0][0], column: 'tenant', value: 2 },
            { rowId: page.rows[1][0], column: 'sequence', value: 1 }
        ]);

        await worker.invoke('undoModification', {
            modificationType: 'cell_update',
            targetTable: 'demo_dependent_identity',
            affectedCells
        });

        assert.deepStrictEqual(
            (await worker.invoke(
                'runQuery',
                'SELECT tenant, sequence, value FROM demo_dependent_identity ORDER BY sequence'
            ))[0].rows,
            [[1, 1, 'first'], [1, 2, 'second']]
        );
    });

    it('restores a deleted demo WITHOUT ROWID row without inserting generated columns', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_generated_pk_row (' +
            'id INTEGER PRIMARY KEY, base INTEGER, ' +
            'stored_value INTEGER GENERATED ALWAYS AS (base * 2) STORED, ' +
            'virtual_value INTEGER GENERATED ALWAYS AS (base * 3) VIRTUAL' +
            ') WITHOUT ROWID; ' +
            'INSERT INTO demo_generated_pk_row (id, base) VALUES (7, 5)'
        );
        const page = await worker.invoke('fetchTableData', 'demo_generated_pk_row', {
            columns: ['rowid', 'id', 'base', 'stored_value', 'virtual_value'],
            limit: 10,
            offset: 0
        });
        const deletedRows = await worker.invoke(
            'deleteRows',
            'demo_generated_pk_row',
            [page.rows[0][0]]
        );

        await worker.invoke('undoModification', {
            modificationType: 'row_delete',
            targetTable: 'demo_generated_pk_row',
            deletedRows
        });

        assert.deepStrictEqual(
            (await worker.invoke(
                'runQuery',
                'SELECT id, base, stored_value, virtual_value FROM demo_generated_pk_row'
            ))[0].rows,
            [[7, 5, 10, 15]]
        );
    });

    it('restores a deleted demo rowid row without inserting generated columns', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_generated_rowid_row (' +
            'base INTEGER, ' +
            'stored_value INTEGER GENERATED ALWAYS AS (base * 2) STORED, ' +
            'virtual_value INTEGER GENERATED ALWAYS AS (base * 3) VIRTUAL' +
            '); ' +
            'INSERT INTO demo_generated_rowid_row (rowid, base) VALUES (9, 5)'
        );
        const deletedRows = await worker.invoke(
            'deleteRows',
            'demo_generated_rowid_row',
            [9]
        );
        assert.ok(deletedRows);

        await worker.invoke('undoModification', {
            modificationType: 'row_delete',
            targetTable: 'demo_generated_rowid_row',
            deletedRows
        });

        assert.deepStrictEqual(
            (await worker.invoke(
                'runQuery',
                'SELECT rowid, base, stored_value, virtual_value FROM demo_generated_rowid_row'
            ))[0].rows,
            [[9, 5, 10, 15]]
        );
    });

    it('preserves an unsafe demo INTEGER prior storage class when undoing a typeless cell', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_typeless_undo (' +
            'id INTEGER PRIMARY KEY, value' +
            ') WITHOUT ROWID; ' +
            'INSERT INTO demo_typeless_undo VALUES (1, 9007199254740993)'
        );
        const page = await worker.invoke('fetchTableData', 'demo_typeless_undo', {
            columns: ['rowid', 'id', 'value'],
            limit: 10,
            offset: 0
        });
        const affectedCells = await worker.invoke('updateCellBatch', 'demo_typeless_undo', [{
            rowId: page.rows[0][0],
            column: 'value',
            value: 'changed'
        }]);
        assert.strictEqual(typeof affectedCells[0].priorValue, 'bigint');

        await worker.invoke('undoModification', {
            modificationType: 'cell_update',
            targetTable: 'demo_typeless_undo',
            affectedCells
        });

        assert.deepStrictEqual(
            (await worker.invoke(
                'runQuery',
                'SELECT typeof(value), CAST(value AS TEXT) FROM demo_typeless_undo'
            ))[0].rows,
            [['integer', '9007199254740993']]
        );
    });

    it('preserves an unsafe demo INTEGER storage class when restoring a deleted typeless row', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_typeless_restore (value); ' +
            'INSERT INTO demo_typeless_restore (rowid, value) VALUES (11, 9007199254740993)'
        );
        const deletedRows = await worker.invoke('deleteRows', 'demo_typeless_restore', [11]);
        assert.strictEqual(typeof deletedRows[0].row.value, 'bigint');

        await worker.invoke('undoModification', {
            modificationType: 'row_delete',
            targetTable: 'demo_typeless_restore',
            deletedRows
        });

        assert.deepStrictEqual(
            (await worker.invoke(
                'runQuery',
                'SELECT rowid, typeof(value), CAST(value AS TEXT) FROM demo_typeless_restore'
            ))[0].rows,
            [[11, 'integer', '9007199254740993']]
        );
    });

    it('loads and edits rowid-addressable demo FTS virtual and shadow tables', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE VIRTUAL TABLE demo_fts4_identity USING fts4(body); " +
            "INSERT INTO demo_fts4_identity(body) VALUES ('before')"
        );

        const schema = await worker.invoke('fetchSchema');
        assert.strictEqual(
            schema.tables.find((table: any) => table.identifier === 'demo_fts4_identity')?.identity?.kind,
            'rowid'
        );
        const shadows = schema.tables.filter((table: any) => (
            table.identifier.startsWith('demo_fts4_identity_')
        ));
        assert.ok(shadows.length > 0);
        assert.ok(shadows.every((table: any) => table.identity?.kind === 'rowid'));

        const page = await worker.invoke('fetchTableData', 'demo_fts4_identity', {
            columns: ['rowid', 'body'],
            limit: 10,
            offset: 0
        });
        await worker.invoke(
            'updateCell',
            'demo_fts4_identity',
            page.rows[0][0],
            'body',
            'after'
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT body FROM demo_fts4_identity'),
            'after'
        );

        const shadowPage = await worker.invoke(
            'fetchTableData',
            'demo_fts4_identity_content',
            { columns: ['rowid', 'c0body'], limit: 10, offset: 0 }
        );
        await worker.invoke(
            'updateCell',
            'demo_fts4_identity_content',
            shadowPage.rows[0][0],
            'c0body',
            'shadow-after'
        );
        assert.strictEqual(
            await workerScalar(
                worker,
                'SELECT c0body FROM demo_fts4_identity_content'
            ),
            'shadow-after'
        );
    });

    it('loads and edits demo FTS5 when the bundled SQLite provides FTS5', async t => {
        const worker = await createWorkerHarness();
        try {
            await worker.invoke(
                'runQuery',
                "CREATE VIRTUAL TABLE demo_fts5_identity USING fts5(body); " +
                "INSERT INTO demo_fts5_identity(body) VALUES ('before')"
            );
        } catch (error) {
            if (/no such module: fts5/i.test(String(error))) {
                t.skip('bundled sql.js does not include FTS5');
                return;
            }
            throw error;
        }

        const schema = await worker.invoke('fetchSchema');
        assert.strictEqual(
            schema.tables.find((table: any) => table.identifier === 'demo_fts5_identity')?.identity?.kind,
            'rowid'
        );
        const page = await worker.invoke('fetchTableData', 'demo_fts5_identity', {
            columns: ['rowid', 'body'],
            limit: 10,
            offset: 0
        });
        await worker.invoke(
            'updateCell',
            'demo_fts5_identity',
            page.rows[0][0],
            'body',
            'after'
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT body FROM demo_fts5_identity'),
            'after'
        );
    });

    it('loads all demo table identities with one bulk metadata query', async () => {
        const observedSql: string[] = [];
        const worker = await createWorkerHarness({
            onSql: (kind, sql) => {
                if (kind === 'exec') observedSql.push(sql);
            }
        });
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_schema_rowid (value TEXT); ' +
            'CREATE TABLE demo_schema_pk_a (id TEXT PRIMARY KEY) WITHOUT ROWID; ' +
            'CREATE TABLE demo_schema_pk_b (' +
            'tenant TEXT, sequence INTEGER, PRIMARY KEY (tenant, sequence)' +
            ') WITHOUT ROWID'
        );
        observedSql.length = 0;

        const schema = await worker.invoke('fetchSchema');

        assert.strictEqual(schema.tables.length, 3);
        assert.strictEqual(
            observedSql.filter(sql => sql.includes('pragma_table_list')).length,
            1
        );
        assert.strictEqual(
            observedSql.filter(sql => /PRAGMA\s+(?:main\.)?table_info/i.test(sql)).length,
            0,
            'schema identity must use one set-based metadata query'
        );
    });

    it('returns exact unsafe INTEGER text from demo view previews', async () => {
        const worker = await createWorkerHarness();

        const preview = await worker.invoke(
            'previewViewDefinition',
            'unsafe_integer_preview',
            'SELECT 9007199254740993 AS value',
            10,
            'create'
        );

        assert.strictEqual(preview.rows[0][0], 9007199254740992);
        assert.strictEqual(preview.exactIntegerTexts[0][0], '9007199254740993');
    });

    it('returns integral REAL storage text from demo table fetches and previews', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_integral_reals (value); ' +
            'INSERT INTO demo_integral_reals(value) VALUES (CAST(1 AS REAL))'
        );

        const data = await worker.invoke('fetchTableData', 'demo_integral_reals', {
            columns: ['value'],
            globalFilterColumns: ['value'],
            globalFilter: '.',
            limit: 100,
            offset: 0
        });
        assert.strictEqual(data.rows[0][0], 1);
        assert.strictEqual(data.exactIntegerTexts[0][0], '1.0');

        const preview = await worker.invoke(
            'previewViewDefinition',
            'demo_integral_real_preview',
            'SELECT CAST(1 AS REAL) AS value',
            10,
            'create'
        );
        assert.strictEqual(preview.rows[0][0], 1);
        assert.strictEqual(preview.exactIntegerTexts[0][0], '1.0');
    });

    it('returns authoritative SQLite text for divergent non-integral demo REALs', async () => {
        const worker = await createWorkerHarness();
        assert.strictEqual(
            await workerScalar(worker, 'SELECT sqlite_version()'),
            BUNDLED_SQLJS_SQLITE_VERSION,
            'the REAL text expectation below is pinned to the bundled SQLite version'
        );
        const expectedText = DIVERGENT_REAL_TEXT_BY_SQLJS_SQLITE_VERSION[
            BUNDLED_SQLJS_SQLITE_VERSION
        ];
        assert.ok(expectedText, 'record the REAL rendering when bundled sql.js SQLite changes');
        const preview = await worker.invoke(
            'previewViewDefinition',
            'demo_divergent_real_preview',
            'SELECT 9.652937795298495e282 AS value',
            10,
            'create'
        );

        assert.strictEqual(preview.rows[0][0], 9.652937795298495e282);
        assert.strictEqual(
            preview.exactIntegerTexts[0][0],
            expectedText
        );
    });

    it('degrades exact REAL companions without failing a 1001-column demo preview', async () => {
        const worker = await createWorkerHarness();
        const expressions = Array.from({ length: 1001 }, (_, index) => {
            if (index === 0) return '9007199254740993 AS c0';
            if (index === 1) return 'CAST(1 AS REAL) AS c1';
            return `0 AS c${index}`;
        });
        const preview = await worker.invoke(
            'previewViewDefinition',
            'demo_wide_numeric_preview',
            `SELECT ${expressions.join(', ')}`,
            1,
            'create'
        );

        assert.strictEqual(preview.headers.length, 1001);
        assert.strictEqual(preview.rows[0].length, 1001);
        assert.strictEqual(preview.rows[0][0], 9007199254740992);
        assert.strictEqual(preview.exactIntegerTexts[0][0], '9007199254740993');
        assert.strictEqual(preview.exactIntegerTexts[0][1], undefined);
    });

    it('restores divergent REAL text for a 1001-column rowid-keyed demo table', async () => {
        const worker = await createWorkerHarness();
        const columnNames = Array.from({ length: 1000 }, (_, index) => `c${index}`);
        await worker.invoke(
            'runQuery',
            `CREATE TABLE demo_wide_real_rows (${columnNames.map(name => `"${name}"`).join(', ')}); ` +
            'INSERT INTO demo_wide_real_rows(c0) VALUES (9.652937795298495e282)'
        );

        const result = await worker.invoke('fetchTableData', 'demo_wide_real_rows', {
            columns: ['rowid', ...columnNames],
            globalFilterColumns: columnNames,
            limit: 1,
            offset: 0
        });
        assert.strictEqual(result.rows[0].length, 1001);
        assert.strictEqual(typeof result.exactIntegerTexts?.[0]?.[1], 'string');
        assert.notStrictEqual(
            result.exactIntegerTexts[0][1],
            String(result.rows[0][1])
        );
    });

    it('does not issue rowid companions for a wide demo view named rowid', async () => {
        const observedSql: string[] = [];
        const worker = await createWorkerHarness({
            onSql(_kind, sql) { observedSql.push(sql); }
        });
        const dataColumnNames = Array.from({ length: 1000 }, (_, index) => `c${index}`);
        const viewExpressions = [
            '1 AS rowid',
            '9.652937795298495e282 AS c0',
            ...dataColumnNames.slice(1).map(name => `0 AS "${name}"`)
        ];
        await worker.invoke(
            'runQuery',
            `CREATE VIEW demo_wide_named_rowid AS SELECT ${viewExpressions.join(', ')}`
        );
        observedSql.length = 0;

        const result = await worker.invoke('fetchTableData', 'demo_wide_named_rowid', {
            columns: ['rowid', ...dataColumnNames],
            globalFilterColumns: dataColumnNames,
            limit: 1,
            offset: 0
        });
        assert.strictEqual(result.rows[0].length, 1001);
        assert.strictEqual(result.exactIntegerTexts?.[0]?.[1], undefined);
        assert.strictEqual(
            observedSql.filter(sql => sql.includes('__sqlite_explorer_numeric_rowid')).length,
            0
        );
    });

    it('loads a wide demo view with a null first column without rowid companions', async () => {
        const observedSql: string[] = [];
        const worker = await createWorkerHarness({
            onSql(_kind, sql) { observedSql.push(sql); }
        });
        const dataColumnNames = Array.from({ length: 1000 }, (_, index) => `c${index}`);
        const viewExpressions = [
            'NULL AS first_value',
            ...dataColumnNames.map(name => `0 AS "${name}"`)
        ];
        await worker.invoke(
            'runQuery',
            `CREATE VIEW demo_wide_null_first AS SELECT ${viewExpressions.join(', ')}`
        );
        observedSql.length = 0;

        const result = await worker.invoke('fetchTableData', 'demo_wide_null_first', {
            columns: ['first_value', ...dataColumnNames],
            globalFilterColumns: dataColumnNames,
            limit: 1,
            offset: 0
        });
        assert.strictEqual(result.rows[0].length, 1001);
        assert.strictEqual(result.rows[0][0], null);
        assert.strictEqual(result.exactIntegerTexts, undefined);
        assert.strictEqual(
            observedSql.filter(sql => sql.includes('__sqlite_explorer_numeric_rowid')).length,
            0
        );
    });

    it('does not issue rowid companions for a wide demo WITHOUT ROWID table', async () => {
        const observedSql: string[] = [];
        const worker = await createWorkerHarness({
            onSql(_kind, sql) { observedSql.push(sql); }
        });
        const dataColumnNames = Array.from({ length: 1000 }, (_, index) => `c${index}`);
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_wide_without_rowid (' +
            '"rowid" INTEGER PRIMARY KEY, ' +
            dataColumnNames.map(name => `"${name}"`).join(', ') +
            ') WITHOUT ROWID; ' +
            'INSERT INTO demo_wide_without_rowid(rowid, c0) VALUES ' +
            '(1, 9.652937795298495e282)'
        );
        observedSql.length = 0;

        const result = await worker.invoke('fetchTableData', 'demo_wide_without_rowid', {
            columns: ['rowid', ...dataColumnNames],
            globalFilterColumns: dataColumnNames,
            limit: 1,
            offset: 0
        });
        assert.strictEqual(result.rows[0].length, 1001);
        assert.strictEqual(result.exactIntegerTexts?.[0]?.[1], undefined);
        assert.strictEqual(
            observedSql.filter(sql => sql.includes('__sqlite_explorer_numeric_rowid')).length,
            0
        );
    });

    it('derives demo numeric sidecars from one evaluation of random expressions', async () => {
        const worker = await createWorkerHarness();
        const preview = await worker.invoke(
            'previewViewDefinition',
            'demo_random_numeric_preview',
            'WITH RECURSIVE sequence(n) AS (' +
            'SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 24' +
            ') SELECT CAST(random() % 1000000 AS REAL) AS value FROM sequence',
            24,
            'create'
        );

        assert.strictEqual(preview.rows.length, 24);
        for (let rowIndex = 0; rowIndex < preview.rows.length; rowIndex++) {
            const exactText = preview.exactIntegerTexts?.[rowIndex]?.[0];
            assert.strictEqual(typeof exactText, 'string', `missing sidecar for row ${rowIndex}`);
            assert.strictEqual(Number(exactText), preview.rows[rowIndex][0]);
        }
    });

    it('uses the same narrowed global-filter columns for demo data and counts', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE TABLE scoped_filters (visible TEXT, hidden TEXT); " +
            "INSERT INTO scoped_filters VALUES ('shown', 'secret')"
        );
        const options = {
            columns: ['visible', 'hidden'],
            globalFilterColumns: ['visible'],
            globalFilter: 'secret'
        };

        const data = await worker.invoke('fetchTableData', 'scoped_filters', {
            ...options,
            limit: 100,
            offset: 0
        });
        const count = await worker.invoke('fetchTableCount', 'scoped_filters', options);

        assert.deepStrictEqual(Array.from(data.rows), []);
        assert.strictEqual(count, 0);
    });

    it('falls back to selected columns when count globalFilterColumns is null', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE TABLE null_scoped_filters (visible TEXT, hidden TEXT); " +
            "INSERT INTO null_scoped_filters VALUES ('shown', 'secret')"
        );

        const count = await worker.invoke('fetchTableCount', 'null_scoped_filters', {
            columns: ['visible'],
            globalFilterColumns: null,
            globalFilter: 'secret'
        });

        assert.strictEqual(count, 0);
    });

    it('treats whitespace-only filters as inactive but preserves padded terms', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE TABLE whitespace_filters (value TEXT); " +
            "INSERT INTO whitespace_filters VALUES ('needle'), (' needle '), ('other')"
        );

        for (const options of [
            { columns: ['value'], globalFilter: '   ' },
            { columns: ['value'], filters: [{ column: 'value', value: '   ' }] }
        ]) {
            const data = await worker.invoke('fetchTableData', 'whitespace_filters', {
                ...options,
                limit: 100,
                offset: 0
            });
            const count = await worker.invoke('fetchTableCount', 'whitespace_filters', options);
            assert.strictEqual(data.rows.length, 3);
            assert.strictEqual(count, 3);
        }

        const padded = await worker.invoke('fetchTableData', 'whitespace_filters', {
            columns: ['value'],
            globalFilter: ' needle ',
            limit: 100,
            offset: 0
        });
        const paddedCount = await worker.invoke('fetchTableCount', 'whitespace_filters', {
            columns: ['value'],
            globalFilter: ' needle '
        });
        assert.deepStrictEqual(
            Array.from(padded.rows, (row: unknown[]) => Array.from(row)),
            [[' needle ']]
        );
        assert.strictEqual(paddedCount, 1);
    });

    it('validates the CREATE VIEW construct and leaves the schema unchanged', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE VIEW validation_target (a, b) AS SELECT 1, 2');
        const originalSql = await workerScalar(
            worker,
            "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = 'validation_target'"
        );

        await assert.rejects(
            worker.invoke(
                'validateViewDefinition',
                'parameter_view',
                'SELECT ? AS value',
                'create'
            ),
            /parameters are not allowed in views/
        );
        await assert.rejects(
            worker.invoke('validateViewDefinition', 'validation_target', 'SELECT 1'),
            /expected 2 columns/
        );

        assert.strictEqual(await workerScalar(
            worker,
            "SELECT count(*) FROM sqlite_schema WHERE type = 'view' AND name = 'parameter_view'"
        ), 0);
        assert.strictEqual(await workerScalar(
            worker,
            "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = 'validation_target'"
        ), originalSql);
    });

    it('enforces create and edit intent against the installed schema', async () => {
        const worker = await createWorkerHarness();

        await assert.rejects(
            worker.invoke(
                'validateViewDefinition',
                'missing_intent_target',
                'SELECT 2 AS value',
                'edit'
            ),
            /view no longer exists/i
        );
        await assert.rejects(
            worker.invoke(
                'previewViewDefinition',
                'missing_intent_target',
                'SELECT 2 AS value',
                10,
                'edit'
            ),
            /view no longer exists/i
        );

        await worker.invoke('createView', 'intent_target', 'SELECT 1 AS value');

        await assert.rejects(
            worker.invoke(
                'validateViewDefinition',
                'intent_target',
                'SELECT 2 AS value',
                'create'
            ),
            /view already exists/i
        );
        await assert.rejects(
            worker.invoke(
                'previewViewDefinition',
                'intent_target',
                'SELECT 2 AS value',
                10,
                'create'
            ),
            /view already exists/i
        );

        await worker.invoke(
            'validateViewDefinition',
            'intent_target',
            'SELECT 2 AS value',
            'edit'
        );
        const preview = await worker.invoke(
            'previewViewDefinition',
            'intent_target',
            'SELECT 2 AS value',
            10,
            'edit'
        );
        assert.deepStrictEqual(Array.from(preview.headers), ['value']);
        assert.deepStrictEqual(
            Array.from(preview.rows, (row: unknown[]) => Array.from(row)),
            [[2]]
        );
        assert.strictEqual(await workerScalar(worker, 'SELECT value FROM intent_target'), 1);
    });

    it('does not run validation DDL in demo read-only mode', async () => {
        const worker = await createWorkerHarness({ readOnlyMode: true });

        await assert.rejects(
            worker.invoke(
                'validateViewDefinition',
                'read_only_view',
                'SELECT 1 AS value',
                'create'
            ),
            /View validation is unavailable because the database is read-only/
        );
        const preview = await worker.invoke(
            'previewViewDefinition',
            'read_only_view',
            'SELECT 1 AS value',
            10,
            'create'
        );
        assert.deepStrictEqual(Array.from(preview.headers), ['value']);
        assert.deepStrictEqual(
            Array.from(preview.rows, (row: unknown[]) => Array.from(row)),
            [[1]]
        );
        const schema = await worker.invoke('fetchSchema');
        assert.strictEqual(
            schema.views.some((view: { identifier: string }) => view.identifier === 'read_only_view'),
            false
        );
    });

    it('rejects every demo mutation when initialized read-only', async () => {
        const writable = await createWorkerHarness();
        await writable.invoke(
            'runQuery',
            "CREATE TABLE read_only_rows (value TEXT, spare TEXT); " +
            "INSERT INTO read_only_rows VALUES ('original', 'keep')"
        );
        await writable.invoke('createView', 'read_only_existing', 'SELECT 1 AS value');
        const content = await writable.invoke('exportDatabase', 'test.db');
        const worker = await createWorkerHarness({
            content: Uint8Array.from(content),
            readOnlyMode: true
        });

        const mutations: Array<[string, ...unknown[]]> = [
            ['runQuery', "UPDATE read_only_rows SET value = 'raw-sql'"],
            ['setPragma', 'foreign_keys', 1],
            ['updateCell', 'read_only_rows', 1, 'value', 'changed'],
            ['insertRow', 'read_only_rows', { value: 'inserted' }],
            ['deleteRows', 'read_only_rows', [1]],
            ['deleteColumns', 'read_only_rows', ['spare']],
            ['createTable', 'read_only_new_table', [{ name: 'id', type: 'INTEGER' }]],
            ['updateCellBatch', 'read_only_rows', [{ rowId: 1, column: 'value', value: 'batch' }]],
            ['addColumn', 'read_only_rows', 'added', 'TEXT'],
            ['createView', 'read_only_new', 'SELECT 2 AS value'],
            ['editView', 'read_only_existing', 'SELECT 2 AS value'],
            ['dropView', 'read_only_existing']
        ];
        for (const [method, ...args] of mutations) {
            await assert.rejects(
                worker.invoke(method, ...args),
                /unavailable because the database is read-only/i,
                method
            );
        }

        const rows = await worker.invoke('fetchTableData', 'read_only_rows', {
            columns: ['value', 'spare'],
            limit: 10,
            offset: 0
        });
        assert.deepStrictEqual(
            Array.from(rows.rows, (row: unknown[]) => Array.from(row)),
            [['original', 'keep']]
        );
        const tableInfo = await worker.invoke('getTableInfo', 'read_only_rows');
        assert.deepStrictEqual(
            Array.from(tableInfo, (column: { identifier: string }) => column.identifier),
            ['value', 'spare']
        );
        const schema = await worker.invoke('fetchSchema');
        assert.strictEqual(
            schema.tables.some((table: { identifier: string }) => table.identifier === 'read_only_new_table'),
            false
        );
        assert.strictEqual(
            schema.views.some((view: { identifier: string }) => view.identifier === 'read_only_new'),
            false
        );
        assert.strictEqual(
            schema.views.some((view: { identifier: string }) => view.identifier === 'read_only_existing'),
            true
        );
    });

    it('rejects unsafe demo PRAGMA assignments before execution', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE TABLE pragma_sentinel (id INTEGER)');

        await worker.invoke('setPragma', 'foreign_keys', true);
        await worker.invoke('setPragma', 'cache_size', 64);
        await worker.invoke('setPragma', 'journal_mode', 'memory');
        await assert.rejects(
            worker.invoke(
                'setPragma',
                'foreign_keys',
                'OFF; DROP TABLE pragma_sentinel; --'
            ),
            /Invalid PRAGMA string value/
        );
        await assert.rejects(
            worker.invoke('setPragma', 'foreign_keys; DROP TABLE pragma_sentinel', 'OFF'),
            /Invalid or disallowed PRAGMA/
        );
        await assert.rejects(
            worker.invoke('setPragma', 'cache_size', Number.POSITIVE_INFINITY),
            /Invalid PRAGMA numeric value/
        );

        assert.strictEqual(
            await workerScalar(
                worker,
                "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = 'pragma_sentinel'"
            ),
            1
        );
    });

    it('nests demo batch updates inside an existing savepoint', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE TABLE nested_batch (value TEXT); " +
            "INSERT INTO nested_batch VALUES ('before'); " +
            'SAVEPOINT outer_batch'
        );

        const outcomes = await worker.invoke('updateCellBatch', 'nested_batch', [
            { rowId: 1, column: 'value', value: 'after' }
        ]);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(outcomes)), [{
            rowId: 1,
            columnName: 'value',
            priorValue: 'before',
            newValue: 'after',
            operation: 'set'
        }]);
        await worker.invoke('runQuery', 'RELEASE outer_batch');

        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM nested_batch WHERE rowid = 1'),
            'after'
        );
    });

    it('keeps the outer savepoint in control of a nested demo batch update', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE TABLE nested_batch_rollback (value TEXT); " +
            "INSERT INTO nested_batch_rollback VALUES ('before'); " +
            'SAVEPOINT outer_batch_rollback'
        );

        await worker.invoke('updateCellBatch', 'nested_batch_rollback', [
            { rowId: 1, column: 'value', value: 'after' }
        ]);
        await worker.invoke(
            'runQuery',
            'ROLLBACK TO outer_batch_rollback; RELEASE outer_batch_rollback'
        );

        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM nested_batch_rollback WHERE rowid = 1'),
            'before'
        );
    });

    it('nests demo column deletion and lets the outer savepoint restore the schema', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE TABLE nested_delete (kept TEXT, removed TEXT); " +
            "INSERT INTO nested_delete VALUES ('keep', 'restore'); " +
            'SAVEPOINT outer_delete'
        );

        await worker.invoke('deleteColumns', 'nested_delete', ['removed']);
        await worker.invoke('runQuery', 'ROLLBACK TO outer_delete; RELEASE outer_delete');

        const schema = await worker.invoke('getTableInfo', 'nested_delete');
        assert.deepStrictEqual(
            Array.from(schema, (column: { identifier: string }) => column.identifier),
            ['kept', 'removed']
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT removed FROM nested_delete'),
            'restore'
        );
    });

    it('interrupts a long-running preview before its first row is produced', async () => {
        const worker = await createWorkerHarness({
            queryTimeout: 20
        });
        const startedAt = performance.now();

        await assert.rejects(
            worker.invoke(
                'previewViewDefinition',
                'slow_preview',
                'WITH RECURSIVE counter(value) AS (' +
                'VALUES(1) UNION ALL SELECT value + 1 FROM counter WHERE value < 10000000' +
                ') SELECT sum(value) AS value FROM counter',
                10,
                'create'
            ),
            /Query execution timed out after 20ms/
        );
        assert.ok(
            performance.now() - startedAt < 500,
            'demo preview completed before timeout rejection instead of being interrupted'
        );
    });

    it('interrupts a long-running ad hoc query at the configured deadline', async () => {
        const worker = await createWorkerHarness({ queryTimeout: 20 });
        const startedAt = performance.now();

        await assert.rejects(
            worker.invoke(
                'runQuery',
                'WITH RECURSIVE counter(value) AS (' +
                'VALUES(1) UNION ALL SELECT value + 1 FROM counter WHERE value < 10000000' +
                ') SELECT sum(value) FROM counter'
            ),
            /Query execution timed out after 20ms/
        );
        assert.ok(performance.now() - startedAt < 500);
    });

    it('preempts a running query through a shared cancellation flag', async () => {
        const worker = await createWorkerHarness({ queryTimeout: 200 });
        const cancellationFlag = new Int32Array(
            new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
        );
        const flagSetter = new NodeWorker(
            `const { parentPort, workerData } = require('node:worker_threads');
             setTimeout(() => {
               Atomics.store(workerData, 0, 1);
               parentPort.postMessage('cancelled');
             }, 20);`,
            { eval: true, workerData: cancellationFlag }
        );
        const startedAt = performance.now();

        try {
            await assert.rejects(
                worker.invoke(
                    'runQuery',
                    'WITH RECURSIVE counter(value) AS (' +
                    'VALUES(1) UNION ALL SELECT value + 1 FROM counter WHERE value < 10000000' +
                    ') SELECT sum(value) FROM counter',
                    [],
                    cancellationFlag
                ),
                /Query execution cancelled/
            );
            assert.ok(performance.now() - startedAt < 150);
        } finally {
            await flagSetter.terminate();
        }
    });

    it('drops a view whose stored SQL cannot be extracted for editing', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE VIEW opaque_view AS SELECT 1 AS value');
        await worker.invoke('runQuery', 'PRAGMA writable_schema = ON');
        await worker.invoke(
            'runQuery',
            "UPDATE sqlite_schema SET sql = 'opaque stored view text' " +
            "WHERE type = 'view' AND name = 'opaque_view'"
        );
        await worker.invoke('runQuery', 'PRAGMA writable_schema = OFF');

        const dropped = await worker.invoke('dropView', 'opaque_view');

        assert.strictEqual(dropped.sql, 'opaque stored view text');
        assert.strictEqual(dropped.selectSql, '');
        assert.strictEqual(await workerScalar(
            worker,
            "SELECT count(*) FROM sqlite_schema WHERE type = 'view' AND name = 'opaque_view'"
        ), 0);
    });

    it('captures the demo drop snapshot inside the drop savepoint', async () => {
        const order: string[] = [];
        const worker = await createWorkerHarness({
            initSqlJs: async config => {
                const SQL = await initSqlJs(config);
                const BaseDatabase = SQL.Database;
                class RecordingDatabase extends BaseDatabase {
                    exec(sql: string, params?: any) {
                        if (
                            sql.startsWith("SELECT sql FROM sqlite_schema WHERE type = 'view'") &&
                            params?.[0] === 'drop_order_view'
                        ) {
                            order.push('snapshot');
                        }
                        return super.exec(sql, params);
                    }

                    prepare(sql: string, params?: any) {
                        if (!sql.includes('sqlite_explorer_boundary_')) {
                            if (/^SAVEPOINT "sp_drop_view_/.test(sql)) order.push('savepoint');
                            if (sql === 'DROP VIEW main."drop_order_view"') order.push('drop');
                            if (/^RELEASE "sp_drop_view_/.test(sql)) order.push('release');
                        }
                        return super.prepare(sql, params);
                    }
                }
                return { ...SQL, Database: RecordingDatabase };
            }
        });
        await worker.invoke(
            'runQuery',
            'CREATE VIEW drop_order_view AS SELECT 1 AS value'
        );
        order.length = 0;

        const dropped = await worker.invoke('dropView', 'drop_order_view');

        assert.strictEqual(dropped.selectSql, 'SELECT 1 AS value');
        assert.deepStrictEqual(order, ['savepoint', 'snapshot', 'drop', 'release']);
    });

    it('recreates same-event triggers in schema order', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE TABLE trigger_log (label TEXT)');
        await worker.invoke('runQuery', 'CREATE VIEW trigger_order AS SELECT 1 AS value');
        await worker.invoke(
            'runQuery',
            "CREATE TRIGGER z_created_first INSTEAD OF INSERT ON TRIGGER_ORDER BEGIN INSERT INTO trigger_log VALUES ('z'); END"
        );
        await worker.invoke(
            'runQuery',
            "CREATE TRIGGER a_created_second INSTEAD OF INSERT ON TRIGGER_ORDER BEGIN INSERT INTO trigger_log VALUES ('a'); END"
        );

        const before = await worker.invoke('getViewDefinition', 'trigger_order');
        assert.deepStrictEqual(
            Array.from(before.triggers, (trigger: any) => trigger.identifier),
            ['z_created_first', 'a_created_second']
        );

        await worker.invoke('runQuery', 'INSERT INTO trigger_order VALUES (1)');
        const originalOrder = await worker.invoke('runQuery', 'SELECT label FROM trigger_log ORDER BY rowid');
        await worker.invoke('runQuery', 'DELETE FROM trigger_log');
        await worker.invoke('editView', 'trigger_order', 'SELECT 2 AS value', true);
        await worker.invoke('runQuery', 'INSERT INTO trigger_order VALUES (2)');
        const recreatedOrder = await worker.invoke('runQuery', 'SELECT label FROM trigger_log ORDER BY rowid');

        assert.deepStrictEqual(
            Array.from(recreatedOrder[0].rows, (row: unknown[]) => Array.from(row)),
            Array.from(originalOrder[0].rows, (row: unknown[]) => Array.from(row))
        );
    });

    it('rejects a preserved demo trigger that references a removed view column', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE TABLE demo_trigger_column_source (a TEXT, b TEXT); " +
            "INSERT INTO demo_trigger_column_source VALUES ('old-a', 'old-b'); " +
            'CREATE TABLE demo_trigger_column_log (value TEXT); ' +
            'CREATE VIEW demo_trigger_column_view AS SELECT a FROM demo_trigger_column_source; ' +
            'CREATE TRIGGER demo_trigger_column_update ' +
            'INSTEAD OF UPDATE ON demo_trigger_column_view ' +
            "BEGIN INSERT INTO demo_trigger_column_log VALUES (NEW.\"a\" || ':' || OLD.[a]); END"
        );

        await assert.rejects(
            worker.invoke(
                'editView',
                'demo_trigger_column_view',
                'SELECT b FROM demo_trigger_column_source',
                true
            ),
            /demo_trigger_column_update.*missing view column.*\ba\b/i
        );

        const definition = await worker.invoke('getViewDefinition', 'demo_trigger_column_view');
        assert.strictEqual(definition.selectSql, 'SELECT a FROM demo_trigger_column_source');
        await worker.invoke(
            'runQuery',
            "UPDATE demo_trigger_column_view SET a = 'new-a'"
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM demo_trigger_column_log'),
            'new-a:old-a'
        );
    });

    it('preserves a demo trigger whose quoted references match the renamed column', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            "CREATE TABLE demo_matching_trigger_source (a TEXT, b TEXT); " +
            "INSERT INTO demo_matching_trigger_source VALUES ('old-a', 'old-b'); " +
            'CREATE TABLE demo_matching_trigger_log (value TEXT); ' +
            'CREATE VIEW demo_matching_trigger_view AS SELECT a FROM demo_matching_trigger_source; ' +
            'CREATE TRIGGER demo_matching_trigger_update ' +
            'INSTEAD OF UPDATE OF b ON demo_matching_trigger_view ' +
            'BEGIN INSERT INTO demo_matching_trigger_log VALUES (' +
            "NEW.[b] || ':' || OLD.\"b\" || ':NEW.a' /* OLD.a */); END"
        );

        await worker.invoke(
            'editView',
            'demo_matching_trigger_view',
            'SELECT b FROM demo_matching_trigger_source',
            true
        );
        await worker.invoke(
            'runQuery',
            "UPDATE demo_matching_trigger_view SET b = 'new-b'"
        );

        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM demo_matching_trigger_log'),
            'new-b:old-b:NEW.a'
        );
    });

    it('preserves a TEMP trigger when editing a main-schema view', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE TABLE demo_temp_trigger_rows (value INTEGER)');
        await worker.invoke('runQuery', 'CREATE TABLE demo_temp_trigger_log (value INTEGER)');
        await worker.invoke(
            'runQuery',
            'CREATE VIEW demo_temp_trigger_view AS SELECT value FROM demo_temp_trigger_rows'
        );
        await worker.invoke(
            'runQuery',
            'CREATE TEMP TRIGGER demo_temp_trigger_insert ' +
            'INSTEAD OF INSERT ON DEMO_TEMP_TRIGGER_VIEW ' +
            'BEGIN INSERT INTO demo_temp_trigger_log VALUES (NEW.value); END'
        );

        const before = await worker.invoke('getViewDefinition', 'demo_temp_trigger_view');
        assert.strictEqual(before.triggers.length, 1);
        assert.strictEqual(before.triggers[0].temporary, true);

        const edit = await worker.invoke(
            'editView',
            'demo_temp_trigger_view',
            'SELECT value * 2 AS value FROM demo_temp_trigger_rows',
            true
        );
        assert.strictEqual(edit.after.triggers[0].temporary, true);
        assert.strictEqual(await workerScalar(
            worker,
            "SELECT count(*) FROM sqlite_temp_schema " +
            "WHERE type = 'trigger' AND name = 'demo_temp_trigger_insert'"
        ), 1);
        assert.strictEqual(await workerScalar(
            worker,
            "SELECT count(*) FROM sqlite_schema " +
            "WHERE type = 'trigger' AND name = 'demo_temp_trigger_insert'"
        ), 0);

        await worker.invoke('runQuery', 'INSERT INTO demo_temp_trigger_view VALUES (17)');
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM demo_temp_trigger_log'),
            17
        );
    });

    it('rejects a shadowed unqualified demo TEMP trigger before editing the main view', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE TABLE demo_shadow_trigger_main_rows (value INTEGER)');
        await worker.invoke('runQuery', 'INSERT INTO demo_shadow_trigger_main_rows VALUES (3)');
        await worker.invoke(
            'runQuery',
            'CREATE VIEW demo_shadow_trigger_view AS ' +
            'SELECT value FROM demo_shadow_trigger_main_rows'
        );
        await worker.invoke('runQuery', 'CREATE TEMP TABLE demo_shadow_trigger_temp_rows (value INTEGER)');
        await worker.invoke('runQuery', 'INSERT INTO demo_shadow_trigger_temp_rows VALUES (7)');
        await worker.invoke(
            'runQuery',
            'CREATE TEMP VIEW demo_shadow_trigger_view AS ' +
            'SELECT value FROM demo_shadow_trigger_temp_rows'
        );
        await worker.invoke('runQuery', 'CREATE TEMP TABLE demo_shadow_trigger_log (value INTEGER)');
        await worker.invoke(
            'runQuery',
            'CREATE TEMP TRIGGER demo_shadow_trigger_insert ' +
            'INSTEAD OF INSERT ON demo_shadow_trigger_view ' +
            'BEGIN INSERT INTO demo_shadow_trigger_log VALUES (NEW.value); END'
        );

        const browsed = await worker.invoke('getViewDefinition', 'demo_shadow_trigger_view');
        assert.deepStrictEqual(Array.from(browsed.triggers), []);
        assert.deepStrictEqual(
            Array.from(browsed.ambiguousTemporaryTriggerNames),
            ['demo_shadow_trigger_insert']
        );
        await assert.rejects(
            worker.invoke(
                'editView',
                'demo_shadow_trigger_view',
                'SELECT value * 2 AS value FROM demo_shadow_trigger_main_rows',
                true
            ),
            /demo_shadow_trigger_insert.*drop the TEMP shadow view.*schema-qualified target/is
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM main.demo_shadow_trigger_view'),
            3
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM temp.demo_shadow_trigger_view'),
            7
        );
        await worker.invoke('runQuery', 'INSERT INTO demo_shadow_trigger_view VALUES (11)');
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM demo_shadow_trigger_log'),
            11
        );
    });

    it('rejects demo edit and drop when a main-bound TEMP trigger becomes ambiguous', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke(
            'runQuery',
            'CREATE TABLE demo_ambiguous_main_rows (value INTEGER); ' +
            'INSERT INTO demo_ambiguous_main_rows VALUES (3); ' +
            'CREATE TABLE demo_ambiguous_main_log (value INTEGER); ' +
            'CREATE VIEW demo_ambiguous_trigger_view AS ' +
            'SELECT value FROM demo_ambiguous_main_rows; ' +
            'CREATE TEMP TRIGGER demo_ambiguous_main_insert ' +
            'INSTEAD OF INSERT ON demo_ambiguous_trigger_view ' +
            'BEGIN INSERT INTO demo_ambiguous_main_log VALUES (NEW.value); END; ' +
            'CREATE TEMP TABLE demo_ambiguous_temp_rows (value INTEGER); ' +
            'INSERT INTO demo_ambiguous_temp_rows VALUES (7); ' +
            'CREATE TEMP VIEW demo_ambiguous_trigger_view AS ' +
            'SELECT value FROM demo_ambiguous_temp_rows'
        );

        const browsed = await worker.invoke(
            'getViewDefinition',
            'demo_ambiguous_trigger_view'
        );
        assert.strictEqual(browsed.selectSql, 'SELECT value FROM demo_ambiguous_main_rows');
        assert.deepStrictEqual(Array.from(browsed.triggers), []);
        assert.deepStrictEqual(
            Array.from(browsed.ambiguousTemporaryTriggerNames),
            ['demo_ambiguous_main_insert']
        );

        const expectedError = /demo_ambiguous_main_insert.*drop the TEMP shadow view.*TEMP trigger.*schema-qualified target/is;
        await assert.rejects(
            worker.invoke(
                'editView',
                'demo_ambiguous_trigger_view',
                'SELECT value * 2 AS value FROM demo_ambiguous_main_rows',
                true
            ),
            expectedError
        );
        await assert.rejects(
            worker.invoke('dropView', 'demo_ambiguous_trigger_view'),
            expectedError
        );

        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM main.demo_ambiguous_trigger_view'),
            3
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM temp.demo_ambiguous_trigger_view'),
            7
        );
        assert.strictEqual(await workerScalar(
            worker,
            "SELECT count(*) FROM sqlite_temp_schema " +
            "WHERE type = 'trigger' AND name = 'demo_ambiguous_main_insert'"
        ), 1);
        await worker.invoke(
            'runQuery',
            'INSERT INTO main.demo_ambiguous_trigger_view VALUES (19)'
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM demo_ambiguous_main_log'),
            19
        );
    });

    it('preserves a quoted-main TEMP trigger through a same-named TEMP view shadow', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE TABLE demo_qualified_main_rows (value INTEGER)');
        await worker.invoke('runQuery', 'INSERT INTO demo_qualified_main_rows VALUES (3)');
        await worker.invoke(
            'runQuery',
            'CREATE VIEW demo_qualified_trigger_view AS SELECT value FROM demo_qualified_main_rows'
        );
        await worker.invoke('runQuery', 'CREATE TEMP TABLE demo_qualified_temp_rows (value INTEGER)');
        await worker.invoke('runQuery', 'INSERT INTO demo_qualified_temp_rows VALUES (7)');
        await worker.invoke(
            'runQuery',
            'CREATE TEMP VIEW demo_qualified_trigger_view AS ' +
            'SELECT value FROM demo_qualified_temp_rows'
        );
        await worker.invoke(
            'runQuery',
            'CREATE TEMP TABLE demo_qualified_trigger_log (target TEXT, value INTEGER)'
        );
        await worker.invoke(
            'runQuery',
            'CREATE TEMP TRIGGER demo_qualified_main_insert ' +
            'INSTEAD OF INSERT ON "main"."demo_qualified_trigger_view" ' +
            "BEGIN INSERT INTO demo_qualified_trigger_log VALUES ('main', NEW.value); END"
        );
        await worker.invoke(
            'runQuery',
            'CREATE TEMP TRIGGER demo_qualified_temp_insert ' +
            'INSTEAD OF INSERT ON temp.demo_qualified_trigger_view ' +
            "BEGIN INSERT INTO demo_qualified_trigger_log VALUES ('temp', NEW.value); END"
        );

        const edit = await worker.invoke(
            'editView',
            'demo_qualified_trigger_view',
            'SELECT value * 2 AS value FROM demo_qualified_main_rows',
            true
        );

        assert.deepStrictEqual(
            Array.from(edit.before.triggers, (trigger: any) => trigger.identifier),
            ['demo_qualified_main_insert']
        );
        assert.deepStrictEqual(
            Array.from(edit.after.triggers, (trigger: any) => trigger.identifier),
            ['demo_qualified_main_insert']
        );
        assert.strictEqual(
            await workerScalar(worker, 'SELECT value FROM temp.demo_qualified_trigger_view'),
            7
        );
        await worker.invoke('runQuery', 'INSERT INTO main.demo_qualified_trigger_view VALUES (13)');
        await worker.invoke('runQuery', 'INSERT INTO temp.demo_qualified_trigger_view VALUES (17)');
        assert.strictEqual(
            await workerScalar(
                worker,
                "SELECT value FROM demo_qualified_trigger_log WHERE target = 'main'"
            ),
            13
        );
        assert.strictEqual(
            await workerScalar(
                worker,
                "SELECT value FROM demo_qualified_trigger_log WHERE target = 'temp'"
            ),
            17
        );
    });
});
