import './vscode_mock_setup';

import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert';
import * as vscode from 'vscode';

import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import type { DatabaseOperations, ViewDefinition } from '../../src/core/types';
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

    it('validates with SQLite and previews without changing the schema', async () => {
        const engine = await createEngine();
        try {
            await engine.executeQuery('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
            await engine.executeQuery("INSERT INTO users (name) VALUES ('Ada'), ('Grace')");

            await assert.rejects(
                () => engine.validateViewDefinition('preview_only', 'SELECT missing_column FROM users'),
                /missing_column/
            );
            await assert.rejects(
                () => engine.validateViewDefinition('preview_only', 'DELETE FROM users'),
                /syntax error/
            );

            const preview = await engine.previewViewDefinition(
                'preview_only',
                'SELECT id, upper(name) AS display_name FROM users ORDER BY id',
                1
            );
            assert.deepStrictEqual(preview.headers, ['id', 'display_name']);
            assert.deepStrictEqual(preview.rows, [[1, 'ADA']]);

            const schema = await engine.fetchSchema();
            assert.strictEqual(schema.views.some(view => view.identifier === 'preview_only'), false);
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
