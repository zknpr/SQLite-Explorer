import './vscode_mock_setup';

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import type { DatabaseOperations } from '../../src/core/types';
import {
    assertViewTriggersCompatibleWithColumns,
    mapViewTriggerRows
} from '../../src/core/view-utils';

// SQLite accepts single-quoted identifiers in DDL for historical compatibility
// and stores them verbatim, so stored trigger SQL in real-world databases can
// use 'name' where the grammar requires an identifier. The trigger header
// parser must accept those, and an entirely unparseable persistent trigger
// must not make the owning view permanently uneditable.

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

describe('view trigger single-quoted identifiers', () => {
    it('accepts single-quoted trigger name, target, and NEW references', () => {
        assertViewTriggersCompatibleWithColumns([
            {
                identifier: 'quoted insert',
                sql: "CREATE TRIGGER 'quoted insert' INSTEAD OF INSERT ON 'quoted_view' " +
                    "BEGIN INSERT INTO base (id, label) VALUES (NEW.id, NEW.'label'); END"
            }
        ], ['id', 'label']);
    });

    it('still validates columns referenced through single-quoted tokens', () => {
        assert.throws(
            () => assertViewTriggersCompatibleWithColumns([
                {
                    identifier: 'quoted insert',
                    sql: "CREATE TRIGGER 'quoted insert' INSTEAD OF INSERT ON 'quoted_view' " +
                        "BEGIN INSERT INTO base (label) VALUES (NEW.'label'); END"
                }
            ], ['id']),
            /references missing view column "label"/
        );
    });

    it('validates a single-quoted UPDATE OF column list', () => {
        const updateOfSql = "CREATE TRIGGER 'quoted update' INSTEAD OF UPDATE OF 'label' " +
            "ON 'quoted_view' BEGIN SELECT 1; END";

        assertViewTriggersCompatibleWithColumns(
            [{ identifier: 'quoted update', sql: updateOfSql }],
            ['label']
        );
        assert.throws(
            () => assertViewTriggersCompatibleWithColumns(
                [{ identifier: 'quoted update', sql: updateOfSql }],
                ['id']
            ),
            /references missing view column "label"/
        );
    });

    it('degrades to accepting a stored trigger the header parser cannot read', () => {
        // SQLite recompiles preserved trigger SQL when it is recreated and
        // resolves NEW/OLD at fire time, so "cannot verify" must not block
        // the edit the way a parse throw previously did.
        assertViewTriggersCompatibleWithColumns([
            { identifier: 'unreadable', sql: 'CREATE TRIGGER' }
        ], ['id']);
    });

    it('attributes single-quoted schema-qualified TEMP trigger targets', () => {
        const auxRows = mapViewTriggerRows('v', [
            [],
            [['aux trigger', "CREATE TRIGGER 'aux trigger' INSTEAD OF INSERT ON 'aux'.'v' BEGIN SELECT 1; END", 0]]
        ]);
        assert.deepStrictEqual(auxRows.triggers, []);
        assert.deepStrictEqual(auxRows.ambiguousTemporaryTriggerNames, []);

        const mainRows = mapViewTriggerRows('v', [
            [],
            [['main trigger', "CREATE TRIGGER 'main trigger' INSTEAD OF INSERT ON 'MAIN'.'v' BEGIN SELECT 1; END", 1]]
        ]);
        assert.strictEqual(mainRows.triggers.length, 1);
        assert.strictEqual(mainRows.triggers[0].temporary, true);
        assert.deepStrictEqual(mainRows.ambiguousTemporaryTriggerNames, []);
    });

    it('edits a view whose stored trigger uses single-quoted identifiers', async () => {
        const engine = await createEngine();
        try {
            await engine.executeQuery(
                'CREATE TABLE quoted_rows (id INTEGER PRIMARY KEY, label TEXT)'
            );
            await engine.createView('quoted_view', 'SELECT id, label FROM quoted_rows');
            // Legal legacy quoting: SQLite resolves each 'name' below to an
            // identifier and stores this SQL verbatim in sqlite_schema.
            await engine.executeQuery(`
                CREATE TRIGGER 'quoted trigger'
                INSTEAD OF INSERT ON 'quoted_view'
                BEGIN
                    INSERT INTO quoted_rows (id, label) VALUES (NEW.id, NEW.'label');
                END
            `);

            const result = await engine.editView(
                'quoted_view',
                'SELECT id, label, upper(label) AS loud_label FROM quoted_rows',
                true
            );
            assert.strictEqual(result.after.triggers.length, 1);
            assert.strictEqual(result.after.triggers[0].identifier, 'quoted trigger');

            await engine.executeQuery(
                "INSERT INTO quoted_view (id, label) VALUES (3, 'ada')"
            );
            assert.strictEqual(
                await readScalar(engine, 'SELECT label FROM quoted_rows WHERE id = 3'),
                'ada'
            );
            assert.strictEqual(
                await readScalar(engine, 'SELECT loud_label FROM quoted_view WHERE id = 3'),
                'ADA'
            );
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('rejects an edit that removes a column a single-quoted trigger still needs', async () => {
        const engine = await createEngine();
        try {
            await engine.executeQuery(
                'CREATE TABLE quoted_guard_rows (id INTEGER PRIMARY KEY, label TEXT)'
            );
            await engine.createView('quoted_guard_view', 'SELECT id, label FROM quoted_guard_rows');
            await engine.executeQuery(`
                CREATE TRIGGER 'quoted guard trigger'
                INSTEAD OF INSERT ON 'quoted_guard_view'
                BEGIN
                    INSERT INTO quoted_guard_rows (id, label) VALUES (NEW.id, NEW.'label');
                END
            `);

            await assert.rejects(
                () => engine.editView('quoted_guard_view', 'SELECT id FROM quoted_guard_rows', true),
                /references missing view column "label"/
            );
            // The failed edit must leave the original definition installed.
            assert.strictEqual(
                await readScalar(
                    engine,
                    "SELECT count(*) FROM sqlite_schema WHERE name = 'quoted guard trigger'"
                ),
                1
            );
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });
});
