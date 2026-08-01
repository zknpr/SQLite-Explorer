import './vscode_mock_setup';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import esbuild from 'esbuild';
import initSqlJs from 'sql.js';

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
} = {}): Promise<WorkerHarness> {
    const source = await readCurrentWorkerBundle();
    const responses: any[] = [];
    const workerGlobal: any = {
        initSqlJs: options.initSqlJs ?? initSqlJs,
        postMessage(message: unknown) {
            responses.push(message);
        }
    };
    const context = vm.createContext({
        self: workerGlobal,
        importScripts(url: string) { options.onImportScripts?.(url); },
        console: { log() {}, warn() {}, error() {} },
        Uint8Array,
        ArrayBuffer,
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
    it('loads the package-aligned sql.js release from the CDN fallback', async () => {
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
            'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.14.1/sql-wasm.js'
        ]);
        assert.strictEqual(
            wasmUrl,
            'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.14.1/sql-wasm.wasm'
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

    it('bounds preview stepping with the configured query timeout', async () => {
        let now = 0;
        const worker = await createWorkerHarness({
            queryTimeout: 5,
            now: () => {
                now += 10;
                return now;
            }
        });

        await assert.rejects(
            worker.invoke(
                'previewViewDefinition',
                'slow_preview',
                'SELECT 1 AS value',
                10,
                'create'
            ),
            /Query execution timed out after 5ms/
        );
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
});
