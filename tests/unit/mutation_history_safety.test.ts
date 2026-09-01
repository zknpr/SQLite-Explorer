import './vscode_mock_setup';

import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createDatabaseEngine } from '../../src/core/sqlite-db';
import type { DatabaseOperations, RecordId } from '../../src/core/types';

describe('mutation history side-effect safety', () => {
    let engine: DatabaseOperations;

    beforeEach(async () => {
        const result = await createDatabaseEngine({
            content: null,
            maxSize: 0,
            readOnlyMode: false
        });
        engine = result.operations!;
    });

    afterEach(() => {
        (engine as DatabaseOperations & { shutdown?: () => void }).shutdown?.();
    });

    it('rejects INSERT triggers before either the target or side-effect row is written', async () => {
        await engine.executeQuery(
            'CREATE TABLE insert_target (id INTEGER PRIMARY KEY, value TEXT); ' +
            'CREATE TABLE insert_audit (target_id INTEGER); ' +
            'CREATE TRIGGER insert_audit_trigger AFTER INSERT ON insert_target ' +
            'BEGIN INSERT INTO insert_audit VALUES (NEW.id); END'
        );

        await assert.rejects(
            engine.insertRow('insert_target', { id: 1, value: 'new' }),
            /INSERT trigger.*undo history|undo history.*INSERT trigger/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT (SELECT count(*) FROM insert_target), ' +
                '(SELECT count(*) FROM insert_audit)'
            ))[0].rows,
            [[0, 0]]
        );
    });

    it('rejects UPDATE triggers that write only an audit table', async () => {
        await engine.executeQuery(
            'CREATE TABLE update_target (id INTEGER PRIMARY KEY, value TEXT); ' +
            'CREATE TABLE update_audit (target_id INTEGER); ' +
            "INSERT INTO update_target VALUES (1, 'before'); " +
            'CREATE TRIGGER update_audit_trigger AFTER UPDATE OF value ON update_target ' +
            'BEGIN INSERT INTO update_audit VALUES (NEW.id); END'
        );

        await assert.rejects(
            engine.updateCell('update_target', 1, 'value', 'after'),
            /UPDATE trigger.*undo history|undo history.*UPDATE trigger/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT value, (SELECT count(*) FROM update_audit) FROM update_target'
            ))[0].rows,
            [['before', 0]]
        );
    });

    it('rejects UPDATE triggers on WITHOUT ROWID tables before side effects escape history', async () => {
        await engine.executeQuery(
            'CREATE TABLE update_pk_target (id TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID; ' +
            'CREATE TABLE update_pk_audit (target_id TEXT); ' +
            "INSERT INTO update_pk_target VALUES ('one', 'before'); " +
            'CREATE TRIGGER update_pk_audit_trigger AFTER UPDATE OF value ON update_pk_target ' +
            'BEGIN INSERT INTO update_pk_audit VALUES (NEW.id); END'
        );
        const page = await engine.fetchTableData('update_pk_target', {
            columns: ['rowid', 'id', 'value'],
            limit: 1,
            offset: 0
        });

        await assert.rejects(
            engine.updateCell(
                'update_pk_target',
                page.rows[0][0] as RecordId,
                'value',
                'after'
            ),
            /UPDATE trigger.*undo history|undo history.*UPDATE trigger/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT value, (SELECT count(*) FROM update_pk_audit) FROM update_pk_target'
            ))[0].rows,
            [['before', 0]]
        );
    });

    it('rejects DELETE triggers before a BEFORE IGNORE can forge a deletion snapshot', async () => {
        await engine.executeQuery(
            'CREATE TABLE ignored_delete (id INTEGER PRIMARY KEY, value TEXT); ' +
            "INSERT INTO ignored_delete VALUES (1, 'kept'); " +
            'CREATE TRIGGER ignore_delete BEFORE DELETE ON ignored_delete ' +
            'BEGIN SELECT RAISE(IGNORE); END'
        );

        await assert.rejects(
            engine.deleteRows('ignored_delete', [1]),
            /DELETE trigger.*undo history|undo history.*DELETE trigger/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery('SELECT id, value FROM ignored_delete'))[0].rows,
            [[1, 'kept']]
        );
    });

    it('rejects mutating ON DELETE actions before child rows can escape the undo snapshot', async () => {
        await engine.executeQuery(
            'PRAGMA foreign_keys = ON; ' +
            'CREATE TABLE cascade_parent (id INTEGER PRIMARY KEY); ' +
            'CREATE TABLE cascade_child (' +
            'parent_id INTEGER REFERENCES cascade_parent(id) ON DELETE CASCADE); ' +
            'INSERT INTO cascade_parent VALUES (1); ' +
            'INSERT INTO cascade_child VALUES (1)'
        );

        await assert.rejects(
            engine.deleteRows('cascade_parent', [1]),
            /foreign-key.*DELETE.*undo history|DELETE.*foreign-key.*undo history/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT (SELECT count(*) FROM cascade_parent), ' +
                '(SELECT count(*) FROM cascade_child)'
            ))[0].rows,
            [[1, 1]]
        );
    });

    it('allows an ordinary delete when a non-mutating foreign-key check is satisfied', async () => {
        await engine.executeQuery(
            'PRAGMA foreign_keys = ON; ' +
            'CREATE TABLE checked_parent (id INTEGER PRIMARY KEY); ' +
            'CREATE TABLE checked_child (' +
            'parent_id INTEGER REFERENCES checked_parent(id) ON DELETE RESTRICT); ' +
            'INSERT INTO checked_parent VALUES (1)'
        );

        const deleted = await engine.deleteRows('checked_parent', [1]);
        assert.strictEqual(deleted.length, 1);
        assert.deepStrictEqual(
            (await engine.executeQuery('SELECT count(*) FROM checked_parent'))[0].rows,
            [[0]]
        );
    });

    it('rejects ON UPDATE SET NULL before the child reference escapes undo history', async () => {
        await engine.executeQuery(
            'PRAGMA foreign_keys = ON; ' +
            'CREATE TABLE set_null_parent (id INTEGER PRIMARY KEY); ' +
            'CREATE TABLE set_null_child (' +
            'parent_id INTEGER REFERENCES set_null_parent(id) ON UPDATE SET NULL); ' +
            'INSERT INTO set_null_parent VALUES (1); ' +
            'INSERT INTO set_null_child VALUES (1)'
        );

        await assert.rejects(
            engine.updateCell('set_null_parent', 1, 'id', 2),
            /foreign-key.*UPDATE.*undo history|UPDATE.*foreign-key.*undo history/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT p.id, c.parent_id FROM set_null_parent p JOIN set_null_child c'
            ))[0].rows,
            [[1, 1]]
        );
    });

    it('rejects ON UPDATE SET DEFAULT before the child reference escapes undo history', async () => {
        await engine.executeQuery(
            'PRAGMA foreign_keys = ON; ' +
            'CREATE TABLE set_default_parent (id INTEGER PRIMARY KEY); ' +
            'CREATE TABLE set_default_child (' +
            'parent_id INTEGER DEFAULT 99 ' +
            'REFERENCES set_default_parent(id) ON UPDATE SET DEFAULT); ' +
            'INSERT INTO set_default_parent VALUES (1), (99); ' +
            'INSERT INTO set_default_child VALUES (1)'
        );

        await assert.rejects(
            engine.updateCell('set_default_parent', 1, 'id', 2),
            /foreign-key.*UPDATE.*undo history|UPDATE.*foreign-key.*undo history/i
        );
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT p.id, c.parent_id FROM set_default_parent p ' +
                'JOIN set_default_child c ON c.parent_id = p.id ORDER BY p.id'
            ))[0].rows,
            [[1, 1]]
        );
    });

    it('keeps ON UPDATE CASCADE because undo and redo restore the child reference', async () => {
        await engine.executeQuery(
            'PRAGMA foreign_keys = ON; ' +
            'CREATE TABLE update_cascade_parent (id INTEGER PRIMARY KEY); ' +
            'CREATE TABLE update_cascade_child (' +
            'parent_id INTEGER REFERENCES update_cascade_parent(id) ON UPDATE CASCADE); ' +
            'INSERT INTO update_cascade_parent VALUES (1); ' +
            'INSERT INTO update_cascade_child VALUES (1)'
        );

        assert.strictEqual(
            await engine.updateCell('update_cascade_parent', 1, 'id', 2),
            2
        );
        const modification = {
            modificationType: 'cell_update' as const,
            description: 'Update cascading parent key',
            targetTable: 'update_cascade_parent',
            targetRowId: 1,
            newTargetRowId: 2,
            targetColumn: 'id',
            priorValue: 1,
            newValue: 2,
            operation: 'set' as const,
            priorState: { storageClass: 'integer' as const, value: 1n },
            postState: { storageClass: 'integer' as const, value: 2n }
        };

        await engine.undoModification(modification);
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT p.id, c.parent_id FROM update_cascade_parent p ' +
                'JOIN update_cascade_child c'
            ))[0].rows,
            [[1, 1]]
        );
        await engine.redoModification(modification);
        assert.deepStrictEqual(
            (await engine.executeQuery(
                'SELECT p.id, c.parent_id FROM update_cascade_parent p ' +
                'JOIN update_cascade_child c'
            ))[0].rows,
            [[2, 2]]
        );
    });
});
