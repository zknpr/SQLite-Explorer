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
