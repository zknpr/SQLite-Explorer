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

        await testContext.test('validates and previews with a legal disposable view name', async () => {
            await engine.validateViewDefinition('preview_candidate', USER_VIEW_BODY);
            const preview = await engine.previewViewDefinition('preview_candidate', USER_VIEW_BODY, 10);
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

        await testContext.test('previews 100 duplicate-alias rows positionally in one native query', async () => {
            const body = `WITH RECURSIVE sequence(value) AS (
    SELECT 1
    UNION ALL
    SELECT value + 1 FROM sequence WHERE value < 100
)
SELECT value AS x, value * 10 AS x FROM sequence`;

            await engine.validateViewDefinition('duplicate_alias_preview', body);
            const preview = await engine.previewViewDefinition('duplicate_alias_preview', body, 100);

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

        await testContext.test('preserves TEMP view triggers through native edit and history replay', async () => {
            await engine.executeQuery('CREATE TABLE native_temp_trigger_rows (value INTEGER)');
            await engine.executeQuery('CREATE TABLE native_temp_trigger_log (value INTEGER)');
            await engine.executeQuery(
                'CREATE VIEW native_temp_trigger_view AS SELECT value FROM native_temp_trigger_rows'
            );
            await engine.executeQuery(
                'CREATE TEMP TRIGGER native_temp_trigger_insert ' +
                'INSTEAD OF INSERT ON native_temp_trigger_view ' +
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
