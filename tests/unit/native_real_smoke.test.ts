import './vscode_mock_setup'; // Must be first

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { it } from 'node:test';
import * as vscode from 'vscode';

import {
    createNativeDatabaseConnection,
    NativeWorkerProcess
} from '../../src/nativeWorker';

const BUNDLED_TXIKI_SQLITE_VERSION = '3.50.1';
const DIVERGENT_REAL_TEXT_BY_NATIVE_SQLITE_VERSION: Record<string, string> = {
    '3.50.1': '9.6529377952985e+282'
};

const USER_VIEW_BODY = `SELECT
    o.id AS order_id,
    o.order_number,
    u.username,
    u.email,
    o.status,
    o.total_amount,
    COUNT(oi.id) AS item_count,
    o.created_at,
    MAX(oi.price) AS max_item_price
FROM orders o
JOIN users u ON o.user_id = u.id
LEFT JOIN order_items oi ON o.id = oi.order_id
GROUP BY o.id`;

const INITIAL_VIEW_BODY = USER_VIEW_BODY.replace(
    ',\n    MAX(oi.price) AS max_item_price',
    ''
);

function getBundledNativeBinary(repoRoot: string): string | undefined {
    let platformDir: string | undefined;
    if (process.platform === 'darwin') {
        platformDir = process.arch === 'arm64' ? 'aarch64-macos' : 'x86_64-macos';
    } else if (process.platform === 'linux') {
        platformDir = process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu';
    } else if (process.platform === 'win32' && process.arch === 'x64') {
        platformDir = 'x86_64-windows';
    }
    if (!platformDir) return undefined;

    const binary = path.join(
        repoRoot,
        'natives',
        platformDir,
        process.platform === 'win32' ? 'tjs.exe' : 'tjs'
    );
    return fs.existsSync(binary) ? binary : undefined;
}

it('passes the native view smoke lane through the bundled txiki worker', async (testContext) => {
    const repoRoot = process.cwd();
    const binary = getBundledNativeBinary(repoRoot);
    const workerScript = path.join(repoRoot, 'natives', 'native-worker.js');
    if (!binary || !fs.existsSync(workerScript)) {
        const reason = `no bundled txiki worker for ${process.platform}-${process.arch}`;
        console.log(`[native smoke] SKIP: ${reason}`);
        testContext.skip(reason);
        return;
    }

    const workspaceTmp = path.join(repoRoot, '.tmp');
    fs.mkdirSync(workspaceTmp, { recursive: true });
    const testDir = fs.mkdtempSync(path.join(workspaceTmp, 'native-smoke-'));
    const databasePath = path.join(testDir, 'native-smoke.sqlite');
    fs.closeSync(fs.openSync(databasePath, 'w'));

    const previousHome = process.env.HOME;
    const previousTmpDir = process.env.TMPDIR;
    process.env.HOME = testDir;
    process.env.TMPDIR = testDir;

    let rawWorker: NativeWorkerProcess | undefined;
    let bundle: Awaited<ReturnType<typeof createNativeDatabaseConnection>> | undefined;
    try {
        const activeRawWorker = new NativeWorkerProcess(binary, workerScript);
        rawWorker = activeRawWorker;
        await activeRawWorker.start();
        await activeRawWorker.call('open', [databasePath, false]);

        await testContext.test('pins the bundled txiki SQLite version', async () => {
            const result = await activeRawWorker.call<{ values: unknown[][] }>('query', [
                'SELECT sqlite_version() AS version'
            ]);
            const version = String(result.values[0]?.[0] ?? '');
            console.log(`[native smoke] SQLite version: ${version}`);
            assert.strictEqual(version, BUNDLED_TXIKI_SQLITE_VERSION);
        });

        await testContext.test('retains the boundary on multiline SQL and rejects a statement tail', async () => {
            const body = `SELECT
    1 AS first_value,
    MAX(2) AS second_value`;
            const createSql = `CREATE VIEW "boundary_multiline" AS ${body}`;
            const boundary = '/*sqlite_explorer_boundary_native_smoke*/';
            await activeRawWorker.call('runSingle', [
                `${createSql}\n${boundary}`,
                createSql,
                undefined,
                boundary
            ]);

            const stored = await activeRawWorker.call<{ values: unknown[][] }>('query', [
                "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = 'boundary_multiline'"
            ]);
            assert.strictEqual(stored.values[0][0], createSql);

            const mismatchSql = 'CREATE VIEW "boundary_mismatch" AS SELECT MAX';
            const validatedMismatchSql = 'CREATE VIEW "boundary_mismatch" AS SELECT MAX(2) AS value';
            const mismatchBoundary = '/*sqlite_explorer_boundary_native_mismatch*/';
            await assert.rejects(
                activeRawWorker.call('runSingle', [
                    `${validatedMismatchSql}\n${mismatchBoundary}`,
                    mismatchSql,
                    undefined,
                    mismatchBoundary
                ]),
                /Single-statement SQL payload mismatch/
            );
            const mismatchView = await activeRawWorker.call<{ values: unknown[][] }>('query', [
                "SELECT name FROM sqlite_schema WHERE type = 'view' AND name = 'boundary_mismatch'"
            ]);
            assert.deepStrictEqual(mismatchView.values, []);

            await activeRawWorker.call('run', ['CREATE TABLE boundary_guard (id INTEGER)']);
            const tailedSql = 'DROP TABLE boundary_guard; SELECT 1';
            const tailBoundary = '/*sqlite_explorer_boundary_native_tail*/';
            await assert.rejects(
                activeRawWorker.call('runSingle', [
                    `${tailedSql}\n${tailBoundary}`,
                    tailedSql,
                    undefined,
                    tailBoundary
                ]),
                /Exactly one SQL statement is required/
            );
            const guard = await activeRawWorker.call<{ values: unknown[][] }>('query', [
                "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'boundary_guard'"
            ]);
            assert.deepStrictEqual(guard.values, [['boundary_guard']]);
        });

        await testContext.test('keeps native value and companion reads on one WAL snapshot', async () => {
            await activeRawWorker.call('query', ['PRAGMA journal_mode = WAL']);
            await activeRawWorker.call('run', [
                'CREATE TABLE native_numeric_snapshot (value REAL)'
            ]);
            await activeRawWorker.call('run', [
                'INSERT INTO native_numeric_snapshot(value) VALUES (1.25)'
            ]);

            const externalWriter = new NativeWorkerProcess(binary, workerScript);
            await externalWriter.start();
            try {
                await externalWriter.call('open', [databasePath, false]);
                await activeRawWorker.call('run', ['SAVEPOINT native_numeric_snapshot_read']);
                try {
                    const source = await activeRawWorker.call<{ values: unknown[][] }>(
                        'queryNumeric',
                        [
                            'SELECT rowid, value FROM native_numeric_snapshot',
                            [],
                            ['rowid', 'value'],
                            undefined
                        ]
                    );
                    await externalWriter.call('run', [
                        'UPDATE native_numeric_snapshot SET value = 2.5 WHERE rowid = 1'
                    ]);
                    const companionBatch = await activeRawWorker.call<{
                        results: Array<{ values: unknown[][] }>;
                    }>('queryBatch', [[{
                        sql: 'SELECT rowid, CAST(value AS TEXT) FROM native_numeric_snapshot WHERE rowid = 1',
                        params: []
                    }]]);

                    assert.strictEqual(source.values[0][1], 1.25);
                    assert.strictEqual(companionBatch.results[0].values[0][1], '1.25');
                    await activeRawWorker.call('run', ['RELEASE native_numeric_snapshot_read']);
                } catch (error) {
                    await activeRawWorker.call('run', [
                        'ROLLBACK TO native_numeric_snapshot_read'
                    ]);
                    await activeRawWorker.call('run', ['RELEASE native_numeric_snapshot_read']);
                    throw error;
                }

                const latest = await activeRawWorker.call<{ values: unknown[][] }>('query', [
                    'SELECT value FROM native_numeric_snapshot'
                ]);
                assert.strictEqual(latest.values[0][0], 2.5);
            } finally {
                externalWriter.stop();
            }
        });
        activeRawWorker.stop();
        rawWorker = undefined;

        bundle = await createNativeDatabaseConnection(vscode.Uri.file(repoRoot));
        const connection = await bundle.establishConnection(
            vscode.Uri.file(databasePath),
            'native-smoke.sqlite'
        );
        const engine = connection.databaseOps;

        await engine.executeQuery(
            'CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, email TEXT)'
        );
        await engine.executeQuery(
            'CREATE TABLE orders (id INTEGER PRIMARY KEY, order_number TEXT, user_id INTEGER, status TEXT, total_amount REAL, created_at TEXT)'
        );
        await engine.executeQuery(
            'CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER, price REAL)'
        );

        await testContext.test('carries exact unsafe INTEGER text through native table fetches', async () => {
            await engine.executeQuery(
                'CREATE TABLE native_unsafe_integers (value INTEGER); ' +
                'INSERT INTO native_unsafe_integers(value) VALUES (9007199254740993)'
            );
            const result = await engine.fetchTableData('native_unsafe_integers', {
                columns: ['value'],
                globalFilterColumns: ['value'],
                globalFilter: '993',
                limit: 10,
                offset: 0
            });

            assert.strictEqual(result.rows[0][0], 9007199254740992);
            assert.strictEqual(result.exactIntegerTexts?.[0]?.[0], '9007199254740993');
        });

        await testContext.test('keeps adjacent unsafe native rowids distinct and editable', async () => {
            await engine.executeQuery(
                'CREATE TABLE native_unsafe_rowids (value TEXT); ' +
                "INSERT INTO native_unsafe_rowids(rowid, value) VALUES " +
                "(11, 'safe'), (9007199254740992, 'lower'), (9007199254740993, 'higher')"
            );
            const result = await engine.fetchTableData('native_unsafe_rowids', {
                columns: ['rowid', 'value'],
                orderBy: 'rowid',
                limit: 10,
                offset: 0
            });

            assert.strictEqual(result.rows[0][0], 11);
            assert.deepStrictEqual(
                result.rows.slice(1).map(row => row[0]),
                ['9007199254740992', '9007199254740993']
            );
            await engine.updateCell(
                'native_unsafe_rowids',
                result.rows[2][0] as string,
                'value',
                'edited'
            );
            const values = await engine.executeQuery(
                'SELECT CAST(rowid AS TEXT), value FROM native_unsafe_rowids ' +
                'WHERE rowid >= 9007199254740992 ORDER BY rowid'
            );
            assert.deepStrictEqual(values[0].rows, [
                ['9007199254740992', 'lower'],
                ['9007199254740993', 'edited']
            ]);
        });

        await testContext.test('edits and replays a WITHOUT ROWID primary-key identity', async () => {
            await engine.executeQuery(
                'CREATE TABLE native_without_rowid (' +
                'tenant TEXT, sequence INTEGER, value TEXT, ' +
                'PRIMARY KEY (tenant, sequence)' +
                ') WITHOUT ROWID; ' +
                "INSERT INTO native_without_rowid VALUES " +
                "('north', 9007199254740993, 'before')"
            );
            const page = await engine.fetchTableData('native_without_rowid', {
                columns: ['rowid', 'tenant', 'sequence', 'value'],
                limit: 10,
                offset: 0
            });
            const oldIdentity = page.rows[0][0] as string;
            assert.match(oldIdentity, /^pk:/);

            const affectedCells = await engine.updateCellBatch('native_without_rowid', [
                { rowId: oldIdentity, column: 'tenant', value: 'south' },
                { rowId: oldIdentity, column: 'value', value: 'after' }
            ]);
            assert.ok(affectedCells[0].newRowId);
            const modification = {
                description: 'Native WITHOUT ROWID edit',
                modificationType: 'cell_update' as const,
                targetTable: 'native_without_rowid',
                affectedCells
            };
            assert.deepStrictEqual(
                (await engine.executeQuery(
                    'SELECT tenant, CAST(sequence AS TEXT), value FROM native_without_rowid'
                ))[0].rows,
                [['south', '9007199254740993', 'after']]
            );

            await engine.undoModification(modification);
            assert.deepStrictEqual(
                (await engine.executeQuery(
                    'SELECT tenant, CAST(sequence AS TEXT), value FROM native_without_rowid'
                ))[0].rows,
                [['north', '9007199254740993', 'before']]
            );
            await engine.redoModification(modification);
            assert.deepStrictEqual(
                (await engine.executeQuery(
                    'SELECT tenant, CAST(sequence AS TEXT), value FROM native_without_rowid'
                ))[0].rows,
                [['south', '9007199254740993', 'after']]
            );
        });

        await testContext.test('carries exact unsafe INTEGER text through native view previews', async () => {
            const preview = await engine.previewViewDefinition(
                'native_unsafe_integer_preview',
                'SELECT 9007199254740993 AS value',
                10,
                'create'
            );

            assert.strictEqual(preview.rows[0][0], 9007199254740992);
            assert.strictEqual(preview.exactIntegerTexts?.[0]?.[0], '9007199254740993');
        });

        await testContext.test('carries integral REAL storage text through native data and previews', async () => {
            await engine.executeQuery(
                'CREATE TABLE native_integral_reals (value); ' +
                'INSERT INTO native_integral_reals(value) VALUES (CAST(1 AS REAL))'
            );
            const result = await engine.fetchTableData('native_integral_reals', {
                columns: ['value'],
                globalFilterColumns: ['value'],
                globalFilter: '.',
                limit: 10,
                offset: 0
            });
            assert.strictEqual(result.rows[0][0], 1);
            assert.strictEqual(result.exactIntegerTexts?.[0]?.[0], '1.0');

            const preview = await engine.previewViewDefinition(
                'native_integral_real_preview',
                'SELECT CAST(1 AS REAL) AS value',
                10,
                'create'
            );
            assert.strictEqual(preview.rows[0][0], 1);
            assert.strictEqual(preview.exactIntegerTexts?.[0]?.[0], '1.0');
        });

        await testContext.test('carries authoritative SQLite text for divergent native REALs', async () => {
            // SQLite REAL-to-text rendering is version-sensitive; the assertion
            // below is paired with the bundled version pinned at the lane start.
            const expectedText = DIVERGENT_REAL_TEXT_BY_NATIVE_SQLITE_VERSION[
                BUNDLED_TXIKI_SQLITE_VERSION
            ];
            assert.ok(expectedText, 'record the REAL rendering when the bundled SQLite version changes');
            const preview = await engine.previewViewDefinition(
                'native_divergent_real_preview',
                'SELECT 9.652937795298495e282 AS value',
                10,
                'create'
            );

            assert.strictEqual(preview.rows[0][0], 9.652937795298495e282);
            assert.strictEqual(
                preview.exactIntegerTexts?.[0]?.[0],
                expectedText
            );
        });

        await testContext.test('degrades exact REAL companions without failing a 1001-column native preview', async () => {
            const expressions = Array.from({ length: 1001 }, (_, index) => {
                if (index === 0) return '9007199254740993 AS c0';
                if (index === 1) return 'CAST(1 AS REAL) AS c1';
                return `0 AS c${index}`;
            });
            const preview = await engine.previewViewDefinition(
                'native_wide_numeric_preview',
                `SELECT ${expressions.join(', ')}`,
                1,
                'create'
            );

            assert.strictEqual(preview.headers.length, 1001);
            assert.strictEqual(preview.rows[0].length, 1001);
            assert.strictEqual(preview.rows[0][0], 9007199254740992);
            assert.strictEqual(preview.exactIntegerTexts?.[0]?.[0], '9007199254740993');
            assert.strictEqual(preview.exactIntegerTexts?.[0]?.[1], undefined);
        });

        await testContext.test('restores divergent REAL text for a 1001-column rowid-keyed native table', async () => {
            const columnNames = Array.from({ length: 1000 }, (_, index) => `c${index}`);
            await engine.executeQuery(
                `CREATE TABLE native_wide_real_rows (${columnNames.map(name => `"${name}"`).join(', ')}); ` +
                'INSERT INTO native_wide_real_rows(c0) VALUES (9.652937795298495e282)'
            );
            const result = await engine.fetchTableData('native_wide_real_rows', {
                columns: ['rowid', ...columnNames],
                globalFilterColumns: columnNames,
                limit: 1,
                offset: 0
            });

            assert.strictEqual(result.rows[0].length, 1001);
            assert.strictEqual(typeof result.exactIntegerTexts?.[0]?.[1], 'string');
            assert.notStrictEqual(
                result.exactIntegerTexts?.[0]?.[1],
                String(result.rows[0][1])
            );
        });

        await testContext.test('nests native batch writes inside a host savepoint', async () => {
            await engine.executeQuery(
                "CREATE TABLE native_nested_batch (value TEXT); " +
                "INSERT INTO native_nested_batch(value) VALUES ('before')"
            );
            await engine.executeQuery('SAVEPOINT native_smoke_outer_batch');
            try {
                await engine.updateCellBatch('native_nested_batch', [{
                    rowId: 1,
                    column: 'value',
                    value: 'after'
                }]);
                await engine.executeQuery('RELEASE SAVEPOINT native_smoke_outer_batch');
            } catch (error) {
                await engine.executeQuery('ROLLBACK TO SAVEPOINT native_smoke_outer_batch');
                await engine.executeQuery('RELEASE SAVEPOINT native_smoke_outer_batch');
                throw error;
            }
            assert.deepStrictEqual(
                (await engine.executeQuery('SELECT value FROM native_nested_batch'))[0].rows,
                [['after']]
            );
        });

        await testContext.test('derives native numeric sidecars from one random evaluation', async () => {
            const preview = await engine.previewViewDefinition(
                'native_random_numeric_preview',
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

        await testContext.test('validates preserved trigger columns against native view edits', async () => {
            await engine.executeQuery(
                "CREATE TABLE native_trigger_column_source (a TEXT, b TEXT); " +
                "INSERT INTO native_trigger_column_source VALUES ('old-a', 'old-b'); " +
                'CREATE TABLE native_trigger_column_log (value TEXT); ' +
                'CREATE VIEW native_trigger_column_view AS ' +
                'SELECT a FROM native_trigger_column_source; ' +
                'CREATE TRIGGER native_trigger_column_update ' +
                'INSTEAD OF UPDATE ON native_trigger_column_view ' +
                "BEGIN INSERT INTO native_trigger_column_log VALUES (NEW.\"a\" || ':' || OLD.[a]); END"
            );

            await assert.rejects(
                engine.editView(
                    'native_trigger_column_view',
                    'SELECT b FROM native_trigger_column_source',
                    true
                ),
                error => {
                    const message = error instanceof Error ? error.message : String(error);
                    assert.match(message, /native_trigger_column_update/i);
                    assert.match(message, /missing view column/i);
                    assert.match(message, /\ba\b/i);
                    return true;
                }
            );
            assert.strictEqual(
                (await engine.getViewDefinition('native_trigger_column_view')).selectSql,
                'SELECT a FROM native_trigger_column_source'
            );
            await engine.executeQuery("UPDATE native_trigger_column_view SET a = 'new-a'");
            assert.strictEqual(
                (await engine.executeQuery('SELECT value FROM native_trigger_column_log'))[0]
                    .rows[0][0],
                'new-a:old-a'
            );

            await engine.executeQuery(
                "CREATE TABLE native_matching_trigger_source (a TEXT, b TEXT); " +
                "INSERT INTO native_matching_trigger_source VALUES ('old-a', 'old-b'); " +
                'CREATE TABLE native_matching_trigger_log (value TEXT); ' +
                'CREATE VIEW native_matching_trigger_view AS ' +
                'SELECT a FROM native_matching_trigger_source; ' +
                'CREATE TRIGGER native_matching_trigger_update ' +
                'INSTEAD OF UPDATE OF b ON native_matching_trigger_view ' +
                'BEGIN INSERT INTO native_matching_trigger_log VALUES (' +
                "NEW.[b] || ':' || OLD.\"b\" || ':NEW.a' /* OLD.a */); END"
            );
            await engine.editView(
                'native_matching_trigger_view',
                'SELECT b FROM native_matching_trigger_source',
                true
            );
            await engine.executeQuery("UPDATE native_matching_trigger_view SET b = 'new-b'");
            assert.strictEqual(
                (await engine.executeQuery('SELECT value FROM native_matching_trigger_log'))[0]
                    .rows[0][0],
                'new-b:old-b:NEW.a'
            );
        });

        await testContext.test('validates and previews with a legal disposable view name', async () => {
            await engine.validateViewDefinition('preview_candidate', USER_VIEW_BODY, 'create');
            const preview = await engine.previewViewDefinition(
                'preview_candidate',
                USER_VIEW_BODY,
                10,
                'create'
            );
            assert.deepStrictEqual(preview.headers, [
                'order_id',
                'order_number',
                'username',
                'email',
                'status',
                'total_amount',
                'item_count',
                'created_at',
                'max_item_price'
            ]);
            assert.deepStrictEqual(preview.rows, []);
        });

        await testContext.test('enforces create and edit intent against the installed schema', async () => {
            await assert.rejects(
                engine.validateViewDefinition(
                    'missing_native_intent_target',
                    'SELECT 2 AS value',
                    'edit'
                ),
                /view no longer exists/i
            );
            await assert.rejects(
                engine.previewViewDefinition(
                    'missing_native_intent_target',
                    'SELECT 2 AS value',
                    10,
                    'edit'
                ),
                /view no longer exists/i
            );

            await engine.createView('native_intent_target', 'SELECT 1 AS value');

            await assert.rejects(
                engine.validateViewDefinition(
                    'native_intent_target',
                    'SELECT 2 AS value',
                    'create'
                ),
                /view already exists/i
            );
            await assert.rejects(
                engine.previewViewDefinition(
                    'native_intent_target',
                    'SELECT 2 AS value',
                    10,
                    'create'
                ),
                /view already exists/i
            );

            await engine.validateViewDefinition(
                'native_intent_target',
                'SELECT 2 AS value',
                'edit'
            );
            const preview = await engine.previewViewDefinition(
                'native_intent_target',
                'SELECT 2 AS value',
                10,
                'edit'
            );
            assert.deepStrictEqual(preview.headers, ['value']);
            assert.deepStrictEqual(preview.rows, [[2]]);
            assert.deepStrictEqual(
                (await engine.executeQuery('SELECT value FROM native_intent_target'))[0].rows,
                [[1]]
            );
        });

        await testContext.test('previews 100 duplicate-alias rows positionally in one native query', async () => {
            const body = `WITH RECURSIVE sequence(value) AS (
    SELECT 1
    UNION ALL
    SELECT value + 1 FROM sequence WHERE value < 100
)
SELECT value AS x, value * 10 AS x FROM sequence`;

            await engine.validateViewDefinition('duplicate_alias_preview', body, 'create');
            const preview = await engine.previewViewDefinition(
                'duplicate_alias_preview',
                body,
                100,
                'create'
            );

            assert.deepStrictEqual(preview.headers, ['x', 'x:1']);
            assert.strictEqual(preview.rows.length, 100);
            assert.deepStrictEqual(preview.rows[0], [1, 10]);
            assert.deepStrictEqual(preview.rows[99], [100, 1000]);
        });

        await testContext.test('previews through an existing explicit column list', async () => {
            await engine.executeQuery(
                'CREATE VIEW preview_columns (public_id, public_name) AS ' +
                "SELECT 1 AS internal_id, 'before' AS internal_name"
            );

            const preview = await engine.previewViewDefinition(
                'preview_columns',
                "SELECT 2 AS replacement_id, 'after' AS replacement_name",
                10
            );

            assert.deepStrictEqual(preview.headers, ['public_id', 'public_name']);
            assert.deepStrictEqual(preview.rows, [[2, 'after']]);
        });

        await testContext.test('previews an edit in the target-name context', async () => {
            await engine.createView('native_self_shadowed_view', 'SELECT 7 AS value');

            await assert.rejects(
                engine.previewViewDefinition(
                    'native_self_shadowed_view',
                    'SELECT value FROM main.native_self_shadowed_view',
                    10
                ),
                /circular/i
            );
            assert.deepStrictEqual(
                (await engine.executeQuery('SELECT value FROM native_self_shadowed_view'))[0].rows,
                [[7]]
            );
        });

        await testContext.test('edits and drops main views without touching a TEMP shadow', async () => {
            await engine.createView(
                'native_shadowed_view',
                "SELECT 'main-before' AS value"
            );
            await engine.executeQuery(
                "CREATE TEMP VIEW native_shadowed_view AS SELECT 'temp-value' AS value"
            );

            await engine.editView(
                'native_shadowed_view',
                "SELECT 'main-after' AS value",
                true
            );
            assert.deepStrictEqual(
                (await engine.executeQuery('SELECT value FROM main.native_shadowed_view'))[0].rows,
                [['main-after']]
            );
            assert.deepStrictEqual(
                (await engine.executeQuery('SELECT value FROM temp.native_shadowed_view'))[0].rows,
                [['temp-value']]
            );

            await engine.dropView('native_shadowed_view');
            assert.deepStrictEqual(
                (await engine.executeQuery(
                    "SELECT count(*) FROM sqlite_schema WHERE type = 'view' AND name = 'native_shadowed_view'"
                ))[0].rows,
                [[0]]
            );
            assert.deepStrictEqual(
                (await engine.executeQuery('SELECT value FROM temp.native_shadowed_view'))[0].rows,
                [['temp-value']]
            );
        });

        await testContext.test('compiles created, edited, and restored main views through broken TEMP shadows', async () => {
            await engine.executeQuery(
                'CREATE TEMP VIEW native_create_compile_shadow AS ' +
                'SELECT value FROM missing_native_create_source'
            );
            await engine.createView(
                'native_create_compile_shadow',
                "SELECT 'main-created' AS value"
            );
            assert.deepStrictEqual(
                (await engine.executeQuery(
                    'SELECT value FROM main.native_create_compile_shadow'
                ))[0].rows,
                [['main-created']]
            );

            await engine.createView(
                'native_edit_compile_shadow',
                "SELECT 'main-before' AS value"
            );
            await engine.executeQuery(
                'CREATE TEMP VIEW native_edit_compile_shadow AS ' +
                'SELECT value FROM missing_native_edit_source'
            );
            await engine.editView(
                'native_edit_compile_shadow',
                "SELECT 'main-after' AS value",
                true
            );
            assert.deepStrictEqual(
                (await engine.executeQuery(
                    'SELECT value FROM main.native_edit_compile_shadow'
                ))[0].rows,
                [['main-after']]
            );

            await engine.createView(
                'native_restore_compile_shadow',
                "SELECT 'main-before' AS value"
            );
            const edit = await engine.editView(
                'native_restore_compile_shadow',
                "SELECT 'main-after' AS value",
                true
            );
            await engine.executeQuery(
                'CREATE TEMP VIEW native_restore_compile_shadow AS ' +
                'SELECT value FROM missing_native_restore_source'
            );
            await engine.undoModification({
                description: 'Edit native_restore_compile_shadow',
                modificationType: 'view_edit',
                targetTable: 'native_restore_compile_shadow',
                viewDefBefore: edit.before,
                viewDefAfter: edit.after
            });
            assert.deepStrictEqual(
                (await engine.executeQuery(
                    'SELECT value FROM main.native_restore_compile_shadow'
                ))[0].rows,
                [['main-before']]
            );
        });

        await testContext.test('validates and previews main through a same-named TEMP shadow', async () => {
            await engine.createView(
                'native_dry_run_shadow',
                "SELECT 'main-before' AS value"
            );
            await engine.executeQuery(
                "CREATE TEMP VIEW native_dry_run_shadow AS SELECT 'temp-value' AS value"
            );

            await engine.validateViewDefinition(
                'native_dry_run_shadow',
                "SELECT 'candidate' AS value",
                'edit'
            );
            const preview = await engine.previewViewDefinition(
                'native_dry_run_shadow',
                "SELECT 'candidate' AS value",
                10,
                'edit'
            );

            assert.deepStrictEqual(preview.headers, ['value']);
            assert.deepStrictEqual(preview.rows, [['candidate']]);
            assert.deepStrictEqual(
                (await engine.executeQuery('SELECT value FROM main.native_dry_run_shadow'))[0].rows,
                [['main-before']]
            );
            assert.deepStrictEqual(
                (await engine.executeQuery('SELECT value FROM temp.native_dry_run_shadow'))[0].rows,
                [['temp-value']]
            );
        });

        await testContext.test('round-trips the incident multiline view SQL exactly', async () => {
            await engine.createView('order_summary', INITIAL_VIEW_BODY);
            const initial = await engine.getViewDefinition('order_summary');
            assert.strictEqual(initial.selectSql, INITIAL_VIEW_BODY);

            const editedBody = initial.selectSql.replace(
                '    o.created_at',
                '    o.created_at,\n    MAX(oi.price) AS max_item_price'
            );
            assert.strictEqual(editedBody, USER_VIEW_BODY);
            await engine.editView('order_summary', `${editedBody}\n`, true);

            const after = await engine.getViewDefinition('order_summary');
            assert.strictEqual(after.selectSql, USER_VIEW_BODY);
            const stored = await engine.executeQuery(
                "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = 'order_summary'"
            );
            assert.strictEqual(
                stored[0].rows[0][0],
                `CREATE VIEW "order_summary" AS ${USER_VIEW_BODY}`
            );
        });

        await testContext.test('atomically rejects a stale expected view definition', async () => {
            await engine.createView('native_shared_view', 'SELECT 1 AS value');
            const stale = await engine.getViewDefinition('native_shared_view');
            await engine.executeQuery('DROP VIEW native_shared_view');
            await engine.executeQuery(
                'CREATE VIEW native_shared_view AS SELECT 2 AS value'
            );

            await assert.rejects(
                engine.editView(
                    'native_shared_view',
                    'SELECT 3 AS value',
                    true,
                    stale.sql
                ),
                /changed outside this editor/i
            );
            const current = await engine.getViewDefinition('native_shared_view');
            assert.strictEqual(current.selectSql, 'SELECT 2 AS value');
            assert.deepStrictEqual(
                (await engine.executeQuery('SELECT value FROM native_shared_view'))[0].rows,
                [[2]]
            );
        });

        await testContext.test('atomically rejects a stale native trigger snapshot', async () => {
            await engine.createView('native_trigger_cas_view', 'SELECT 1 AS value');
            await engine.executeQuery(
                'CREATE TRIGGER native_trigger_cas_first ' +
                'INSTEAD OF INSERT ON native_trigger_cas_view BEGIN SELECT 1; END'
            );
            const stale = await engine.getViewDefinition('native_trigger_cas_view');
            await engine.executeQuery(
                'CREATE TRIGGER native_trigger_cas_second ' +
                'INSTEAD OF UPDATE ON native_trigger_cas_view BEGIN SELECT 2; END'
            );

            await assert.rejects(
                engine.editView(
                    'native_trigger_cas_view',
                    'SELECT 2 AS value',
                    false,
                    stale.sql,
                    stale.triggers
                ),
                /changed outside this editor/i
            );
            const current = await engine.getViewDefinition('native_trigger_cas_view');
            assert.strictEqual(current.selectSql, 'SELECT 1 AS value');
            assert.deepStrictEqual(
                current.triggers.map(trigger => trigger.identifier),
                ['native_trigger_cas_first', 'native_trigger_cas_second']
            );
        });

        await testContext.test('rejects stale native view-history undo and redo replay', async () => {
            await engine.createView('native_history_cas', 'SELECT 1 AS value');
            const edit = await engine.editView(
                'native_history_cas',
                'SELECT 2 AS value',
                true
            );
            const modification = {
                description: 'Edit native_history_cas',
                modificationType: 'view_edit' as const,
                targetTable: 'native_history_cas',
                viewDefBefore: edit.before,
                viewDefAfter: edit.after
            };

            await engine.executeQuery(
                'CREATE TRIGGER native_history_undo_external ' +
                'INSTEAD OF INSERT ON native_history_cas BEGIN SELECT 1; END'
            );
            await assert.rejects(
                engine.undoModification(modification),
                /changed outside this editor/i
            );
            let current = await engine.getViewDefinition('native_history_cas');
            assert.strictEqual(current.selectSql, 'SELECT 2 AS value');
            assert.deepStrictEqual(
                current.triggers.map(trigger => trigger.identifier),
                ['native_history_undo_external']
            );

            await engine.executeQuery('DROP TRIGGER native_history_undo_external');
            await engine.undoModification(modification);
            await engine.executeQuery(
                'CREATE TRIGGER native_history_redo_external ' +
                'INSTEAD OF UPDATE ON native_history_cas BEGIN SELECT 2; END'
            );
            await assert.rejects(
                engine.redoModification(modification),
                /changed outside this editor/i
            );
            current = await engine.getViewDefinition('native_history_cas');
            assert.strictEqual(current.selectSql, 'SELECT 1 AS value');
            assert.deepStrictEqual(
                current.triggers.map(trigger => trigger.identifier),
                ['native_history_redo_external']
            );
        });

        await testContext.test('rejects a native drop whose confirmed triggers became stale', async () => {
            await engine.createView('native_drop_cas', 'SELECT 1 AS value');
            await engine.executeQuery(
                'CREATE TRIGGER native_drop_first ' +
                'INSTEAD OF INSERT ON native_drop_cas BEGIN SELECT 1; END'
            );
            const confirmed = await engine.getViewDefinition('native_drop_cas');
            await engine.executeQuery(
                'CREATE TRIGGER native_drop_second ' +
                'INSTEAD OF UPDATE ON native_drop_cas BEGIN SELECT 2; END'
            );

            await assert.rejects(
                engine.dropView(
                    'native_drop_cas',
                    confirmed.sql,
                    confirmed.triggers
                ),
                /changed outside this editor/i
            );
            const current = await engine.getViewDefinition('native_drop_cas');
            assert.deepStrictEqual(
                current.triggers.map(trigger => trigger.identifier),
                ['native_drop_first', 'native_drop_second']
            );
        });

        await testContext.test('preserves TEMP view triggers through native edit and history replay', async () => {
            await engine.executeQuery('CREATE TABLE native_temp_trigger_rows (value INTEGER)');
            await engine.executeQuery('CREATE TABLE native_temp_trigger_log (value INTEGER)');
            await engine.executeQuery(
                'CREATE VIEW native_temp_trigger_view AS SELECT value FROM native_temp_trigger_rows'
            );
            await engine.executeQuery(
                'CREATE TEMP TRIGGER native_temp_trigger_insert ' +
                'INSTEAD OF INSERT ON NATIVE_TEMP_TRIGGER_VIEW ' +
                'BEGIN INSERT INTO native_temp_trigger_log VALUES (NEW.value); END'
            );

            const before = await engine.getViewDefinition('native_temp_trigger_view');
            assert.strictEqual(before.triggers.length, 1);
            assert.strictEqual(before.triggers[0].temporary, true);

            const edit = await engine.editView(
                'native_temp_trigger_view',
                'SELECT value * 2 AS value FROM native_temp_trigger_rows',
                true
            );
            const modification = {
                description: 'Edit native_temp_trigger_view',
                modificationType: 'view_edit' as const,
                targetTable: 'native_temp_trigger_view',
                viewDefBefore: edit.before,
                viewDefAfter: edit.after
            };

            const assertTemporaryTriggerWorks = async (value: number) => {
                const tempTrigger = await engine.executeQuery(
                    "SELECT count(*) FROM sqlite_temp_schema " +
                    "WHERE type = 'trigger' AND name = 'native_temp_trigger_insert'"
                );
                const mainTrigger = await engine.executeQuery(
                    "SELECT count(*) FROM sqlite_schema " +
                    "WHERE type = 'trigger' AND name = 'native_temp_trigger_insert'"
                );
                assert.strictEqual(tempTrigger[0].rows[0][0], 1);
                assert.strictEqual(mainTrigger[0].rows[0][0], 0);
                await engine.executeQuery(`INSERT INTO native_temp_trigger_view VALUES (${value})`);
                const logged = await engine.executeQuery(
                    'SELECT value FROM native_temp_trigger_log ORDER BY rowid DESC LIMIT 1'
                );
                assert.strictEqual(logged[0].rows[0][0], value);
            };

            assert.strictEqual(edit.after.triggers[0].temporary, true);
            await assertTemporaryTriggerWorks(21);
            await engine.undoModification(modification);
            await assertTemporaryTriggerWorks(22);
            await engine.redoModification(modification);
            await assertTemporaryTriggerWorks(23);
        });

        await testContext.test('rejects a shadowed unqualified native TEMP trigger before editing main', async () => {
            await engine.executeQuery('CREATE TABLE native_shadow_trigger_main_rows (value INTEGER)');
            await engine.executeQuery('INSERT INTO native_shadow_trigger_main_rows VALUES (3)');
            await engine.executeQuery(
                'CREATE VIEW native_shadow_trigger_view AS ' +
                'SELECT value FROM native_shadow_trigger_main_rows'
            );
            await engine.executeQuery('CREATE TEMP TABLE native_shadow_trigger_temp_rows (value INTEGER)');
            await engine.executeQuery('INSERT INTO native_shadow_trigger_temp_rows VALUES (7)');
            await engine.executeQuery(
                'CREATE TEMP VIEW native_shadow_trigger_view AS ' +
                'SELECT value FROM native_shadow_trigger_temp_rows'
            );
            await engine.executeQuery('CREATE TEMP TABLE native_shadow_trigger_log (value INTEGER)');
            await engine.executeQuery(
                'CREATE TEMP TRIGGER native_shadow_trigger_insert ' +
                'INSTEAD OF INSERT ON native_shadow_trigger_view ' +
                'BEGIN INSERT INTO native_shadow_trigger_log VALUES (NEW.value); END'
            );

            const browsed = await engine.getViewDefinition('native_shadow_trigger_view');
            assert.deepStrictEqual(browsed.triggers, []);
            assert.deepStrictEqual(
                browsed.ambiguousTemporaryTriggerNames,
                ['native_shadow_trigger_insert']
            );
            await assert.rejects(
                engine.editView(
                    'native_shadow_trigger_view',
                    'SELECT value * 2 AS value FROM native_shadow_trigger_main_rows',
                    true
                ),
                /native_shadow_trigger_insert.*drop the TEMP shadow view.*schema-qualified target/is
            );
            const mainRows = await engine.executeQuery(
                'SELECT value FROM main.native_shadow_trigger_view'
            );
            const tempRows = await engine.executeQuery(
                'SELECT value FROM temp.native_shadow_trigger_view'
            );
            assert.strictEqual(mainRows[0].rows[0][0], 3);
            assert.strictEqual(tempRows[0].rows[0][0], 7);
            await engine.executeQuery('INSERT INTO native_shadow_trigger_view VALUES (11)');
            const logged = await engine.executeQuery(
                'SELECT value FROM native_shadow_trigger_log'
            );
            assert.strictEqual(logged[0].rows[0][0], 11);
        });

        await testContext.test('rejects native edit and drop for a main-bound TEMP trigger made ambiguous', async () => {
            await engine.executeQuery('CREATE TABLE native_ambiguous_main_rows (value INTEGER)');
            await engine.executeQuery('INSERT INTO native_ambiguous_main_rows VALUES (3)');
            await engine.executeQuery('CREATE TABLE native_ambiguous_main_log (value INTEGER)');
            await engine.executeQuery(
                'CREATE VIEW native_ambiguous_trigger_view AS ' +
                'SELECT value FROM native_ambiguous_main_rows'
            );
            await engine.executeQuery(
                'CREATE TEMP TRIGGER native_ambiguous_main_insert ' +
                'INSTEAD OF INSERT ON native_ambiguous_trigger_view ' +
                'BEGIN INSERT INTO native_ambiguous_main_log VALUES (NEW.value); END'
            );
            await engine.executeQuery('CREATE TEMP TABLE native_ambiguous_temp_rows (value INTEGER)');
            await engine.executeQuery('INSERT INTO native_ambiguous_temp_rows VALUES (7)');
            await engine.executeQuery(
                'CREATE TEMP VIEW native_ambiguous_trigger_view AS ' +
                'SELECT value FROM native_ambiguous_temp_rows'
            );

            const browsed = await engine.getViewDefinition('native_ambiguous_trigger_view');
            assert.strictEqual(
                browsed.selectSql,
                'SELECT value FROM native_ambiguous_main_rows'
            );
            assert.deepStrictEqual(browsed.triggers, []);
            assert.deepStrictEqual(
                browsed.ambiguousTemporaryTriggerNames,
                ['native_ambiguous_main_insert']
            );

            const expectedError = /native_ambiguous_main_insert.*drop the TEMP shadow view.*TEMP trigger.*schema-qualified target/is;
            await assert.rejects(
                engine.editView(
                    'native_ambiguous_trigger_view',
                    'SELECT value * 2 AS value FROM native_ambiguous_main_rows',
                    true
                ),
                expectedError
            );
            await assert.rejects(
                engine.dropView('native_ambiguous_trigger_view'),
                expectedError
            );

            const mainRows = await engine.executeQuery(
                'SELECT value FROM main.native_ambiguous_trigger_view'
            );
            const tempRows = await engine.executeQuery(
                'SELECT value FROM temp.native_ambiguous_trigger_view'
            );
            assert.strictEqual(mainRows[0].rows[0][0], 3);
            assert.strictEqual(tempRows[0].rows[0][0], 7);
            await engine.executeQuery(
                'INSERT INTO main.native_ambiguous_trigger_view VALUES (19)'
            );
            const logged = await engine.executeQuery(
                'SELECT value FROM native_ambiguous_main_log'
            );
            assert.strictEqual(logged[0].rows[0][0], 19);
        });

        await testContext.test('preserves a bracket-qualified main TEMP trigger through a temp shadow', async () => {
            await engine.executeQuery('CREATE TABLE native_qualified_main_rows (value INTEGER)');
            await engine.executeQuery('INSERT INTO native_qualified_main_rows VALUES (3)');
            await engine.executeQuery(
                'CREATE VIEW native_qualified_trigger_view AS ' +
                'SELECT value FROM native_qualified_main_rows'
            );
            await engine.executeQuery('CREATE TEMP TABLE native_qualified_temp_rows (value INTEGER)');
            await engine.executeQuery('INSERT INTO native_qualified_temp_rows VALUES (7)');
            await engine.executeQuery(
                'CREATE TEMP VIEW native_qualified_trigger_view AS ' +
                'SELECT value FROM native_qualified_temp_rows'
            );
            await engine.executeQuery(
                'CREATE TEMP TABLE native_qualified_trigger_log (target TEXT, value INTEGER)'
            );
            await engine.executeQuery(
                'CREATE TEMP TRIGGER native_qualified_main_insert ' +
                'INSTEAD OF INSERT ON [main].[native_qualified_trigger_view] ' +
                "BEGIN INSERT INTO native_qualified_trigger_log VALUES ('main', NEW.value); END"
            );
            await engine.executeQuery(
                'CREATE TEMP TRIGGER native_qualified_temp_insert ' +
                'INSTEAD OF INSERT ON temp.native_qualified_trigger_view ' +
                "BEGIN INSERT INTO native_qualified_trigger_log VALUES ('temp', NEW.value); END"
            );

            const edit = await engine.editView(
                'native_qualified_trigger_view',
                'SELECT value * 2 AS value FROM native_qualified_main_rows',
                true
            );

            assert.deepStrictEqual(
                edit.before.triggers.map(trigger => trigger.identifier),
                ['native_qualified_main_insert']
            );
            assert.deepStrictEqual(
                edit.after.triggers.map(trigger => trigger.identifier),
                ['native_qualified_main_insert']
            );
            const tempRows = await engine.executeQuery(
                'SELECT value FROM temp.native_qualified_trigger_view'
            );
            assert.strictEqual(tempRows[0].rows[0][0], 7);
            await engine.executeQuery('INSERT INTO main.native_qualified_trigger_view VALUES (13)');
            await engine.executeQuery('INSERT INTO temp.native_qualified_trigger_view VALUES (17)');
            const logRows = await engine.executeQuery(
                'SELECT target, value FROM native_qualified_trigger_log ORDER BY rowid'
            );
            assert.deepStrictEqual(logRows[0].rows, [['main', 13], ['temp', 17]]);
        });
    } finally {
        rawWorker?.stop();
        bundle?.workerMethods[Symbol.dispose]();
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousTmpDir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmpDir;
        fs.rmSync(testDir, { recursive: true, force: true });
    }
});
