import './vscode_mock_setup';

import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert';
import * as vscode from 'vscode';

import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import type { DatabaseOperations, ViewDefinition } from '../../src/core/types';
import { normalizeViewSelectSql } from '../../src/core/view-utils';
import { HostBridge } from '../../src/hostBridge';

async function createEngine(): Promise<DatabaseOperations> {
    const result = await createDatabaseEngine({
        content: null,
        maxSize: 0,
        readOnlyMode: false
    });
    return result.operations!;
}

async function readScalar(engine: DatabaseOperations, sql: string): Promise<unknown> {
    const result = await engine.executeQuery(sql);
    return result[0]?.rows[0]?.[0];
}

function createViewDefinition(overrides: Partial<ViewDefinition> = {}): ViewDefinition {
    return {
        identifier: 'active_users',
        sql: 'CREATE VIEW "active_users" AS SELECT id, name FROM users',
        selectSql: 'SELECT id, name FROM users',
        triggers: [],
        ...overrides
    };
}

function createHostBridge(databaseOperations: Partial<DatabaseOperations>) {
    const recordExternalModification = mock.fn();
    const document = {
        uri: vscode.Uri.parse('file:///test.db'),
        documentKey: Promise.resolve('test-key'),
        databaseOperations,
        isReadOnlyMode: false,
        recordExternalModification
    };
    const provider = {
        webviews: new Map(),
        context: {},
        isReadOnly: false
    };

    return {
        bridge: new HostBridge(provider as never, document as never),
        recordExternalModification
    };
}

async function assertCommentBodyRoundTrip(body: string): Promise<void> {
    const engine = await createEngine();
    try {
        await engine.executeQuery('CREATE TABLE inventory (quantity INTEGER)');
        await engine.executeQuery('INSERT INTO inventory (quantity) VALUES (4), (9)');
        await engine.executeQuery(`CREATE VIEW inventory_rollup AS ${body}`);

        const before = await engine.getViewDefinition('inventory_rollup');
        assert.strictEqual(before.selectSql, body);

        await engine.validateViewDefinition('inventory_rollup', before.selectSql);
        const preview = await engine.previewViewDefinition('inventory_rollup', before.selectSql, 10);
        assert.deepStrictEqual(preview.headers, ['m']);
        assert.deepStrictEqual(preview.rows, [[9]]);

        const edit = await engine.editView('inventory_rollup', before.selectSql, true);
        assert.strictEqual(edit.after.selectSql, body);
        assert.strictEqual(await readScalar(engine, 'SELECT m FROM inventory_rollup'), 9);
    } finally {
        (engine as WasmDatabaseEngine).shutdown();
    }
}

describe('view operations', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('creates a view from a compiled SELECT body', async () => {
        const engine = await createEngine();
        try {
            await engine.executeQuery('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, active INTEGER)');
            await engine.executeQuery("INSERT INTO users (name, active) VALUES ('Ada', 1), ('Grace', 0)");

            const definition = await engine.createView(
                'active users',
                'SELECT id, name FROM users WHERE active = 1'
            );

            assert.strictEqual(definition.identifier, 'active users');
            assert.strictEqual(definition.selectSql, 'SELECT id, name FROM users WHERE active = 1');
            assert.deepStrictEqual(definition.triggers, []);
            assert.strictEqual(await readScalar(engine, 'SELECT name FROM "active users"'), 'Ada');
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('enforces create and edit intent against the installed schema', async () => {
        const engine = await createEngine();
        try {
            await assert.rejects(
                () => engine.validateViewDefinition(
                    'missing_intent_target',
                    'SELECT 2 AS value',
                    'edit'
                ),
                /view no longer exists/i
            );
            await assert.rejects(
                () => engine.previewViewDefinition(
                    'missing_intent_target',
                    'SELECT 2 AS value',
                    10,
                    'edit'
                ),
                /view no longer exists/i
            );

            await engine.createView('intent_target', 'SELECT 1 AS value');

            await assert.rejects(
                () => engine.validateViewDefinition(
                    'intent_target',
                    'SELECT 2 AS value',
                    'create'
                ),
                /view already exists/i
            );
            await assert.rejects(
                () => engine.previewViewDefinition(
                    'intent_target',
                    'SELECT 2 AS value',
                    10,
                    'create'
                ),
                /view already exists/i
            );

            await engine.validateViewDefinition('intent_target', 'SELECT 2 AS value', 'edit');
            const preview = await engine.previewViewDefinition(
                'intent_target',
                'SELECT 2 AS value',
                10,
                'edit'
            );
            assert.deepStrictEqual(preview.headers, ['value']);
            assert.deepStrictEqual(preview.rows, [[2]]);
            assert.strictEqual(
                (await engine.getViewDefinition('intent_target')).selectSql,
                'SELECT 1 AS value'
            );
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('edits a view and recreates its INSTEAD OF triggers', async () => {
        const engine = await createEngine();
        try {
            await engine.executeQuery('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
            await engine.createView('user_names', 'SELECT id, name FROM users');
            await engine.executeQuery(`
                CREATE TRIGGER "insert user name"
                INSTEAD OF INSERT ON "user_names"
                BEGIN
                    INSERT INTO users (id, name) VALUES (NEW.id, NEW.name);
                END
            `);

            const result = await engine.editView(
                'user_names',
                'SELECT id, name, upper(name) AS display_name FROM users',
                true
            );

            assert.strictEqual(result.before.triggers.length, 1);
            assert.strictEqual(result.after.triggers.length, 1);
            assert.strictEqual(result.after.triggers[0].identifier, 'insert user name');

            await engine.executeQuery("INSERT INTO user_names (id, name) VALUES (7, 'Ada')");
            assert.strictEqual(await readScalar(engine, 'SELECT name FROM users WHERE id = 7'), 'Ada');
            assert.strictEqual(await readScalar(engine, 'SELECT display_name FROM user_names WHERE id = 7'), 'ADA');
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('preserves TEMP view triggers through edit, undo, and redo', async () => {
        const engine = await createEngine();
        try {
            await engine.executeQuery('CREATE TABLE temp_trigger_rows (value INTEGER)');
            await engine.executeQuery('CREATE TABLE temp_trigger_log (value INTEGER)');
            await engine.executeQuery(
                'CREATE VIEW temp_trigger_view AS SELECT value FROM temp_trigger_rows'
            );
            await engine.executeQuery(`
                CREATE TEMP TRIGGER temp_trigger_view_insert
                INSTEAD OF INSERT ON temp_trigger_view
                BEGIN
                    INSERT INTO temp_trigger_log (value) VALUES (NEW.value);
                END
            `);

            const before = await engine.getViewDefinition('temp_trigger_view');
            assert.strictEqual(before.triggers.length, 1);
            assert.strictEqual(before.triggers[0].identifier, 'temp_trigger_view_insert');
            assert.strictEqual(before.triggers[0].temporary, true);

            const edit = await engine.editView(
                'temp_trigger_view',
                'SELECT value * 2 AS value FROM temp_trigger_rows',
                true
            );
            const modification = {
                description: 'Edit temp_trigger_view',
                modificationType: 'view_edit' as const,
                targetTable: 'temp_trigger_view',
                viewDefBefore: edit.before,
                viewDefAfter: edit.after
            };

            const assertTemporaryTriggerWorks = async (value: number) => {
                assert.strictEqual(await readScalar(
                    engine,
                    "SELECT count(*) FROM sqlite_temp_schema " +
                    "WHERE type = 'trigger' AND name = 'temp_trigger_view_insert'"
                ), 1);
                assert.strictEqual(await readScalar(
                    engine,
                    "SELECT count(*) FROM sqlite_schema " +
                    "WHERE type = 'trigger' AND name = 'temp_trigger_view_insert'"
                ), 0);
                await engine.executeQuery(`INSERT INTO temp_trigger_view VALUES (${value})`);
                assert.strictEqual(await readScalar(
                    engine,
                    'SELECT value FROM temp_trigger_log ORDER BY rowid DESC LIMIT 1'
                ), value);
            };

            assert.strictEqual(edit.after.triggers[0].temporary, true);
            await assertTemporaryTriggerWorks(11);

            await engine.undoModification(modification);
            assert.strictEqual(
                (await engine.getViewDefinition('temp_trigger_view')).triggers[0].temporary,
                true
            );
            await assertTemporaryTriggerWorks(12);

            await engine.redoModification(modification);
            assert.strictEqual(
                (await engine.getViewDefinition('temp_trigger_view')).triggers[0].temporary,
                true
            );
            await assertTemporaryTriggerWorks(13);
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('preserves an explicit view column list when replacing its SELECT body', async () => {
        const engine = await createEngine();
        try {
            await engine.executeQuery('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
            await engine.executeQuery(
                'CREATE VIEW user_names (user_id, display_name) AS SELECT id, name FROM users'
            );
            await engine.executeQuery(`
                CREATE TRIGGER user_names_insert
                INSTEAD OF INSERT ON user_names
                BEGIN
                    INSERT INTO users (id, name) VALUES (NEW.user_id, NEW.display_name);
                END
            `);

            await engine.editView(
                'user_names',
                'SELECT id, upper(name) FROM users',
                true
            );

            const columns = await engine.executeQuery('PRAGMA table_info("user_names")');
            assert.deepStrictEqual(columns[0].rows.map(row => row[1]), ['user_id', 'display_name']);

            await engine.executeQuery("INSERT INTO user_names (user_id, display_name) VALUES (11, 'ADA')");
            assert.strictEqual(await readScalar(engine, 'SELECT name FROM users WHERE id = 11'), 'ADA');
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('previews an edited view through its preserved explicit column list', async () => {
        const engine = await createEngine();
        try {
            await engine.executeQuery(
                'CREATE VIEW preview_columns (public_id, public_name) AS ' +
                'SELECT 1 AS internal_id, \'before\' AS internal_name'
            );

            const preview = await engine.previewViewDefinition(
                'preview_columns',
                "SELECT 2 AS replacement_id, 'after' AS replacement_name",
                10
            );

            assert.deepStrictEqual(preview.headers, ['public_id', 'public_name']);
            assert.deepStrictEqual(preview.rows, [[2, 'after']]);
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('round-trips a verbatim explicit column list with duplicate names', async () => {
        const engine = await createEngine();
        try {
            await engine.executeQuery('CREATE VIEW duplicate_names (a, a) AS SELECT 1, 2');

            const edit = await engine.editView(
                'duplicate_names',
                'SELECT 3, 4',
                true
            );
            const editedSql = await readScalar(
                engine,
                "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = 'duplicate_names'"
            );
            assert.match(String(editedSql), /\(a, a\)/);
            assert.doesNotMatch(String(editedSql), /a:1/);
            assert.deepStrictEqual(
                (await engine.executeQuery('SELECT * FROM duplicate_names'))[0].rows,
                [[3, 4]]
            );

            await engine.undoModification({
                description: 'Edit duplicate_names',
                modificationType: 'view_edit',
                targetTable: 'duplicate_names',
                viewDefBefore: edit.before,
                viewDefAfter: edit.after
            });
            const restoredSql = await readScalar(
                engine,
                "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = 'duplicate_names'"
            );
            assert.match(String(restoredSql), /\(a, a\)/);
            assert.doesNotMatch(String(restoredSql), /a:1/);
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('recreates same-event triggers in schema order', async () => {
        const engine = await createEngine();
        try {
            await engine.executeQuery('CREATE TABLE trigger_log (label TEXT)');
            await engine.executeQuery('CREATE VIEW trigger_order AS SELECT 1 AS value');
            await engine.executeQuery(`
                CREATE TRIGGER z_created_first
                INSTEAD OF INSERT ON trigger_order
                BEGIN INSERT INTO trigger_log VALUES ('z'); END
            `);
            await engine.executeQuery(`
                CREATE TRIGGER a_created_second
                INSTEAD OF INSERT ON trigger_order
                BEGIN INSERT INTO trigger_log VALUES ('a'); END
            `);

            const before = await engine.getViewDefinition('trigger_order');
            assert.deepStrictEqual(
                before.triggers.map(trigger => trigger.identifier),
                ['z_created_first', 'a_created_second']
            );

            await engine.executeQuery('INSERT INTO trigger_order VALUES (1)');
            const originalOrder = (await engine.executeQuery('SELECT label FROM trigger_log ORDER BY rowid'))[0].rows;
            assert.deepStrictEqual(originalOrder, [['a'], ['z']]);
            await engine.executeQuery('DELETE FROM trigger_log');

            await engine.editView('trigger_order', 'SELECT 2 AS value', true);
            await engine.executeQuery('INSERT INTO trigger_order VALUES (2)');
            const recreatedOrder = (await engine.executeQuery('SELECT label FROM trigger_log ORDER BY rowid'))[0].rows;
            assert.deepStrictEqual(recreatedOrder, originalOrder);
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('validates, previews, and edits a view body ending in a line comment', async () => {
        await assertCommentBodyRoundTrip(
            'SELECT MAX(quantity) AS m FROM inventory -- rollup of stock'
        );
    });

    it('validates, previews, and edits a view body ending in a block comment', async () => {
        await assertCommentBodyRoundTrip(
            'SELECT MAX(quantity) AS m FROM inventory /* rollup of stock */'
        );
    });

    for (const [commentKind, draft, normalized] of [
        [
            'line',
            'SELECT MAX(quantity) AS m FROM inventory; -- rollup of stock',
            'SELECT MAX(quantity) AS m FROM inventory -- rollup of stock'
        ],
        [
            'block',
            'SELECT MAX(quantity) AS m FROM inventory; /* rollup of stock */',
            'SELECT MAX(quantity) AS m FROM inventory /* rollup of stock */'
        ]
    ] as const) {
        it(`strips a terminator before a trailing ${commentKind} comment`, async () => {
            assert.strictEqual(normalizeViewSelectSql(draft), normalized);

            const engine = await createEngine();
            try {
                await engine.executeQuery('CREATE TABLE inventory (quantity INTEGER)');
                await engine.executeQuery('INSERT INTO inventory VALUES (4), (9)');
                const created = await engine.createView('commented_rollup', draft);
                assert.strictEqual(created.selectSql, normalized);

                await engine.validateViewDefinition('commented_rollup', draft);
                const preview = await engine.previewViewDefinition('commented_rollup', draft, 10);
                assert.deepStrictEqual(preview.headers, ['m']);
                assert.deepStrictEqual(preview.rows, [[9]]);

                const edit = await engine.editView('commented_rollup', draft, true);
                assert.strictEqual(edit.after.selectSql, normalized);
            } finally {
                (engine as WasmDatabaseEngine).shutdown();
            }
        });
    }

    it('rejects a trailing statement before creating any view', async () => {
        const engine = await createEngine();
        try {
            await engine.executeQuery('CREATE TABLE sentinel (id INTEGER)');

            await assert.rejects(
                () => engine.createView('unsafe_body', 'SELECT 1; DROP TABLE sentinel'),
                /syntax error/
            );

            assert.strictEqual(await readScalar(
                engine,
                "SELECT count(*) FROM sqlite_schema WHERE type = 'view' AND name = 'unsafe_body'"
            ), 0);
            assert.strictEqual(await readScalar(
                engine,
                "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = 'sentinel'"
            ), 1);
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('rolls back a failed replacement with the original view and triggers intact', async () => {
        const engine = await createEngine();
        try {
            await engine.executeQuery('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
            await engine.createView('user_names', 'SELECT id, name FROM users');
            await engine.executeQuery(`
                CREATE TRIGGER user_names_insert
                INSTEAD OF INSERT ON user_names
                BEGIN
                    INSERT INTO users (id, name) VALUES (NEW.id, NEW.name);
                END
            `);

            await assert.rejects(
                () => engine.editView('user_names', 'SELECT id, missing_column FROM users', true),
                /missing_column/
            );

            const definition = await engine.getViewDefinition('user_names');
            assert.strictEqual(definition.selectSql, 'SELECT id, name FROM users');
            assert.strictEqual(definition.triggers.length, 1);

            await engine.executeQuery("INSERT INTO user_names (id, name) VALUES (9, 'Grace')");
            assert.strictEqual(await readScalar(engine, 'SELECT name FROM users WHERE id = 9'), 'Grace');
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('rejects a stale view replacement snapshot without overwriting the newer definition', async () => {
        const engine = await createEngine();
        try {
            await engine.executeQuery('CREATE VIEW shared_view AS SELECT 1 AS value');
            const stale = await engine.getViewDefinition('shared_view');
            await engine.executeQuery('DROP VIEW shared_view');
            await engine.executeQuery('CREATE VIEW shared_view AS SELECT 2 AS value');

            await assert.rejects(
                () => engine.editView(
                    'shared_view',
                    'SELECT 3 AS value',
                    true,
                    stale.sql
                ),
                /changed outside this editor/i
            );

            const current = await engine.getViewDefinition('shared_view');
            assert.strictEqual(current.selectSql, 'SELECT 2 AS value');
            assert.deepStrictEqual(
                (await engine.executeQuery('SELECT value FROM shared_view'))[0].rows,
                [[2]]
            );
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('rejects a stale trigger snapshot atomically before discarding any trigger', async () => {
        const engine = await createEngine();
        try {
            await engine.executeQuery('CREATE VIEW trigger_cas_view AS SELECT 1 AS value');
            await engine.executeQuery(
                'CREATE TRIGGER trigger_cas_first INSTEAD OF INSERT ON trigger_cas_view ' +
                'BEGIN SELECT 1; END'
            );
            const stale = await engine.getViewDefinition('trigger_cas_view');
            await engine.executeQuery(
                'CREATE TRIGGER trigger_cas_second INSTEAD OF UPDATE ON trigger_cas_view ' +
                'BEGIN SELECT 2; END'
            );

            await assert.rejects(
                () => engine.editView(
                    'trigger_cas_view',
                    'SELECT 2 AS value',
                    false,
                    stale.sql,
                    stale.triggers
                ),
                /changed outside this editor/i
            );

            const current = await engine.getViewDefinition('trigger_cas_view');
            assert.strictEqual(current.selectSql, 'SELECT 1 AS value');
            assert.deepStrictEqual(
                current.triggers.map(trigger => trigger.identifier),
                ['trigger_cas_first', 'trigger_cas_second']
            );
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('validates with SQLite and previews without changing the schema', async () => {
        const engine = await createEngine();
        try {
            await engine.executeQuery('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
            await engine.executeQuery("INSERT INTO users (name) VALUES ('Ada'), ('Grace')");

            await assert.rejects(
                () => engine.validateViewDefinition(
                    'preview_only',
                    'SELECT missing_column FROM users',
                    'create'
                ),
                /missing_column/
            );
            await assert.rejects(
                () => engine.validateViewDefinition('preview_only', 'DELETE FROM users', 'create'),
                /syntax error/
            );

            const preview = await engine.previewViewDefinition(
                'preview_only',
                'SELECT id, upper(name) AS display_name FROM users ORDER BY id',
                1,
                'create'
            );
            assert.deepStrictEqual(preview.headers, ['id', 'display_name']);
            assert.deepStrictEqual(preview.rows, [[1, 'ADA']]);

            const schema = await engine.fetchSchema();
            assert.strictEqual(schema.views.some(view => view.identifier === 'preview_only'), false);
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('previews an edit in the target-name context instead of resolving the old view', async () => {
        const engine = await createEngine();
        try {
            await engine.createView('self_shadowed_view', 'SELECT 7 AS value');

            await assert.rejects(
                () => engine.previewViewDefinition(
                    'self_shadowed_view',
                    'SELECT value FROM main.self_shadowed_view',
                    10
                ),
                /circular/i
            );

            assert.strictEqual(
                (await engine.getViewDefinition('self_shadowed_view')).selectSql,
                'SELECT 7 AS value'
            );
            assert.deepStrictEqual(
                (await engine.executeQuery('SELECT value FROM self_shadowed_view'))[0].rows,
                [[7]]
            );
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('validates the disposable CREATE VIEW construct, including view-only restrictions', async () => {
        const engine = await createEngine();
        try {
            await engine.executeQuery('CREATE VIEW validation_target (a, b) AS SELECT 1, 2');
            const originalSql = await readScalar(
                engine,
                "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = 'validation_target'"
            );

            await assert.rejects(
                () => engine.validateViewDefinition(
                    'new_parameter_view',
                    'SELECT ? AS value',
                    'create'
                ),
                /parameters are not allowed in views/
            );
            await assert.rejects(
                () => engine.validateViewDefinition('validation_target', 'SELECT 1'),
                /expected 2 columns/
            );

            assert.strictEqual(await readScalar(
                engine,
                "SELECT count(*) FROM sqlite_schema WHERE type = 'view' AND name = 'new_parameter_view'"
            ), 0);
            assert.strictEqual(await readScalar(
                engine,
                "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = 'validation_target'"
            ), originalSql);
            assert.deepStrictEqual(
                (await engine.executeQuery('SELECT * FROM validation_target'))[0].rows,
                [[1, 2]]
            );
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('does not run disposable validation DDL in WASM read-only mode', async () => {
        const result = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: true
        });
        const engine = result.operations!;
        try {
            await assert.rejects(
                () => engine.validateViewDefinition(
                    'read_only_view',
                    'SELECT 1 AS value',
                    'create'
                ),
                /View validation is unavailable because the database is read-only/
            );

            const preview = await engine.previewViewDefinition(
                'read_only_view',
                'SELECT 1 AS value',
                10,
                'create'
            );
            assert.deepStrictEqual(preview.headers, ['value']);
            assert.deepStrictEqual(preview.rows, [[1]]);
            assert.strictEqual(
                await readScalar(
                    engine,
                    "SELECT count(*) FROM sqlite_schema WHERE type = 'view' AND name = 'read_only_view'"
                ),
                0
            );
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('does not execute a trailing statement smuggled through the preview wrapper', async () => {
        const engine = await createEngine();
        try {
            await engine.executeQuery('CREATE TABLE preview_sentinel (id INTEGER)');

            await assert.rejects(() => engine.previewViewDefinition(
                'unsafe_preview',
                'SELECT 1) LIMIT 1; DROP TABLE preview_sentinel; --',
                10,
                'create'
            ));

            assert.strictEqual(await readScalar(
                engine,
                "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = 'preview_sentinel'"
            ), 1);
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('drops a view even when its stored SQL cannot be extracted for editing', async () => {
        const engine = await createEngine();
        try {
            await engine.executeQuery('CREATE VIEW opaque_view AS SELECT 1 AS value');
            await engine.executeQuery('PRAGMA writable_schema = ON');
            await engine.executeQuery(
                "UPDATE sqlite_schema SET sql = 'opaque stored view text' " +
                "WHERE type = 'view' AND name = 'opaque_view'"
            );
            await engine.executeQuery('PRAGMA writable_schema = OFF');

            const dropped = await engine.dropView('opaque_view');

            assert.strictEqual(dropped.sql, 'opaque stored view text');
            assert.strictEqual(dropped.selectSql, '');
            assert.strictEqual(await readScalar(
                engine,
                "SELECT count(*) FROM sqlite_schema WHERE type = 'view' AND name = 'opaque_view'"
            ), 0);
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('captures the WASM drop snapshot inside the drop savepoint', async () => {
        const engine = await createEngine();
        const target = engine as any;
        const order: string[] = [];
        const executeQuery = target.executeQuery.bind(target);
        const readViewDefinition = target.readViewDefinition.bind(target);
        const runSingleStatement = target.runSingleStatement.bind(target);
        try {
            await engine.createView('drop_order_view', 'SELECT 1 AS value');

            mock.method(target, 'executeQuery', async (sql: string, ...args: unknown[]) => {
                if (/^SAVEPOINT "sp_drop_view_/.test(sql)) order.push('savepoint');
                if (/^RELEASE "sp_drop_view_/.test(sql)) order.push('release');
                return executeQuery(sql, ...args);
            });
            mock.method(target, 'readViewDefinition', async (...args: unknown[]) => {
                order.push('snapshot');
                return readViewDefinition(...args);
            });
            mock.method(target, 'runSingleStatement', (sql: string) => {
                if (sql === 'DROP VIEW "drop_order_view"') order.push('drop');
                return runSingleStatement(sql);
            });

            const dropped = await engine.dropView('drop_order_view');

            assert.strictEqual(dropped.selectSql, 'SELECT 1 AS value');
            assert.deepStrictEqual(order, ['savepoint', 'snapshot', 'drop', 'release']);
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('restores a raw view definition without requiring an extracted SELECT body', async () => {
        const engine = await createEngine();
        try {
            await engine.executeQuery('CREATE VIEW raw_restore AS SELECT 7 AS value');
            const definition = await engine.dropView('raw_restore');
            definition.selectSql = '';

            await engine.undoModification({
                description: 'Restore raw view',
                modificationType: 'view_drop',
                targetTable: 'raw_restore',
                viewDefBefore: definition
            });

            assert.strictEqual(await readScalar(engine, 'SELECT value FROM raw_restore'), 7);
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('logs a missing WASM view definition while preserving undo no-op behavior', async () => {
        const engine = await createEngine();
        const warning = mock.method(console, 'warn', () => {});
        try {
            await engine.undoModification({
                description: 'Legacy view edit',
                modificationType: 'view_edit',
                targetTable: 'legacy_view'
            });

            assert.strictEqual(warning.mock.callCount(), 1);
            assert.strictEqual(
                warning.mock.calls[0].arguments[0],
                '[WasmDatabaseEngine] Skipping view undo: definition missing from history entry'
            );
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('undoes and redoes a tracked view edit with its exact trigger state', async () => {
        const engine = await createEngine();
        try {
            await engine.executeQuery('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
            await engine.createView('user_names', 'SELECT id, name FROM users');
            await engine.executeQuery(`
                CREATE TRIGGER user_names_insert
                INSTEAD OF INSERT ON user_names
                BEGIN
                    INSERT INTO users (id, name) VALUES (NEW.id, NEW.name);
                END
            `);
            const edit = await engine.editView(
                'user_names',
                'SELECT id, name, length(name) AS name_length FROM users',
                true
            );
            const modification = {
                label: 'Edit View',
                description: 'Edit view user_names',
                modificationType: 'view_edit' as const,
                targetTable: 'user_names',
                viewDefBefore: edit.before,
                viewDefAfter: edit.after
            };

            await engine.undoModification(modification);
            assert.strictEqual((await engine.getViewDefinition('user_names')).selectSql, 'SELECT id, name FROM users');
            assert.strictEqual((await engine.getViewDefinition('user_names')).triggers.length, 1);

            await engine.redoModification(modification);
            assert.strictEqual(
                (await engine.getViewDefinition('user_names')).selectSql,
                'SELECT id, name, length(name) AS name_length FROM users'
            );
            assert.strictEqual((await engine.getViewDefinition('user_names')).triggers.length, 1);
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('requires an explicit warning confirmation before an edit can discard triggers', async () => {
        const before = createViewDefinition({
            triggers: [{
                identifier: 'active_users_insert',
                sql: 'CREATE TRIGGER active_users_insert INSTEAD OF INSERT ON active_users BEGIN SELECT 1; END'
            }]
        });
        const editView = mock.fn(async () => ({ before, after: { ...before, triggers: [] } }));
        const getViewDefinition = mock.fn(async () => before);
        const { bridge, recordExternalModification } = createHostBridge({ editView, getViewDefinition });
        const warning = mock.method(vscode.window, 'showWarningMessage', async () => ({
            title: 'Cancel',
            value: false,
            isCloseAffordance: true
        }));

        const result = await bridge.editView('active_users', 'SELECT id, name FROM users', false);

        assert.deepStrictEqual(result, { cancelled: true });
        assert.strictEqual(warning.mock.callCount(), 1);
        assert.match(String(warning.mock.calls[0].arguments[0]), /active_users_insert/);
        assert.strictEqual(editView.mock.callCount(), 0);
        assert.strictEqual(recordExternalModification.mock.callCount(), 0);
    });

    it('forwards the expected stored definition through the host edit bridge', async () => {
        const before = createViewDefinition();
        const after = createViewDefinition({
            sql: 'CREATE VIEW "active_users" AS SELECT id FROM users',
            selectSql: 'SELECT id FROM users'
        });
        const editView = mock.fn(async () => ({ before, after }));
        const { bridge, recordExternalModification } = createHostBridge({ editView });

        const result = await bridge.editView(
            'active_users',
            after.selectSql,
            true,
            before.sql,
            before.triggers
        );

        assert.deepStrictEqual(editView.mock.calls[0].arguments, [
            'active_users',
            after.selectSql,
            true,
            before.sql,
            before.triggers
        ]);
        assert.deepStrictEqual(result, { before, after });
        assert.strictEqual(recordExternalModification.mock.callCount(), 1);
    });

    it('atomically guards the trigger snapshot accepted by the discard confirmation', async () => {
        const before = createViewDefinition({
            triggers: [{
                identifier: 'active_users_insert',
                sql: 'CREATE TRIGGER active_users_insert INSTEAD OF INSERT ON active_users BEGIN SELECT 1; END'
            }]
        });
        const after = { ...before, triggers: [] };
        const editView = mock.fn(async () => ({ before, after }));
        const getViewDefinition = mock.fn(async () => before);
        const { bridge } = createHostBridge({ editView, getViewDefinition });
        mock.method(vscode.window, 'showWarningMessage', async () => ({
            title: 'Edit and Drop Triggers',
            value: true
        }));

        await bridge.editView('active_users', 'SELECT id FROM users', false, before.sql);

        assert.deepStrictEqual(editView.mock.calls[0].arguments, [
            'active_users',
            'SELECT id FROM users',
            false,
            before.sql,
            before.triggers
        ]);
    });

    it('drops a view only after modal confirmation and records the reversible definition', async () => {
        const before = createViewDefinition();
        const dropView = mock.fn(async () => before);
        const { bridge, recordExternalModification } = createHostBridge({ dropView });
        const warning = mock.method(vscode.window, 'showWarningMessage', async () => ({
            title: 'Drop View',
            value: true
        }));

        const result = await bridge.dropView('active_users');

        assert.strictEqual(result, undefined);
        assert.strictEqual(warning.mock.callCount(), 1);
        assert.strictEqual(dropView.mock.callCount(), 1);
        assert.deepStrictEqual(recordExternalModification.mock.calls[0].arguments[0], {
            label: 'Drop View',
            description: 'Drop view active_users',
            modificationType: 'view_drop',
            targetTable: 'active_users',
            viewDefBefore: before
        });
    });

    it('does not drop a view when confirmation is dismissed', async () => {
        const dropView = mock.fn(async () => createViewDefinition());
        const { bridge, recordExternalModification } = createHostBridge({ dropView });
        mock.method(vscode.window, 'showWarningMessage', async () => undefined);

        const result = await bridge.dropView('active_users');

        assert.deepStrictEqual(result, { cancelled: true });
        assert.strictEqual(dropView.mock.callCount(), 0);
        assert.strictEqual(recordExternalModification.mock.callCount(), 0);
    });
});
