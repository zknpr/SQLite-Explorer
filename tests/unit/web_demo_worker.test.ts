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
        content: null,
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
            10
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

    it('validates the CREATE VIEW construct and leaves the schema unchanged', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE VIEW validation_target (a, b) AS SELECT 1, 2');
        const originalSql = await workerScalar(
            worker,
            "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = 'validation_target'"
        );

        await assert.rejects(
            worker.invoke('validateViewDefinition', 'parameter_view', 'SELECT ? AS value'),
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

    it('does not run validation DDL in demo read-only mode', async () => {
        const worker = await createWorkerHarness({ readOnlyMode: true });

        await assert.rejects(
            worker.invoke('validateViewDefinition', 'read_only_view', 'SELECT 1 AS value'),
            /View validation is unavailable because the database is read-only/
        );
        const preview = await worker.invoke(
            'previewViewDefinition',
            'read_only_view',
            'SELECT 1 AS value',
            10
        );
        assert.deepStrictEqual(Array.from(preview.headers), ['value']);
        assert.deepStrictEqual(
            Array.from(preview.rows, (row: unknown[]) => Array.from(row)),
            [[1]]
        );
        assert.strictEqual(await workerScalar(
            worker,
            "SELECT count(*) FROM sqlite_schema WHERE type = 'view' AND name = 'read_only_view'"
        ), 0);
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
            worker.invoke('previewViewDefinition', 'slow_preview', 'SELECT 1 AS value', 10),
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

    it('recreates same-event triggers in schema order', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE TABLE trigger_log (label TEXT)');
        await worker.invoke('runQuery', 'CREATE VIEW trigger_order AS SELECT 1 AS value');
        await worker.invoke(
            'runQuery',
            "CREATE TRIGGER z_created_first INSTEAD OF INSERT ON trigger_order BEGIN INSERT INTO trigger_log VALUES ('z'); END"
        );
        await worker.invoke(
            'runQuery',
            "CREATE TRIGGER a_created_second INSTEAD OF INSERT ON trigger_order BEGIN INSERT INTO trigger_log VALUES ('a'); END"
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
            'INSTEAD OF INSERT ON demo_temp_trigger_view ' +
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
