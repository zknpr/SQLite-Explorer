import { describe, it } from 'node:test';
import assert from 'node:assert';
import type {
    CellValue,
    QueryResultSet,
    ModificationType,
    ColumnMetadata,
    SchemaSnapshot,
    ModificationEntry,
    CellUpdate,
    ExportOptions,
    DialogConfig
} from '../../src/core/types';

describe('Core Types Definitions', () => {
    describe('Primitive Types', () => {
        it('CellValue should allow valid types at runtime', () => {
            const str: CellValue = 'text';
            const num: CellValue = 123.45;
            const n: CellValue = null;
            const blob: CellValue = new Uint8Array([1, 2, 3]);

            assert.strictEqual(typeof str, 'string');
            assert.strictEqual(typeof num, 'number');
            assert.strictEqual(n, null);
            assert.ok(blob instanceof Uint8Array);
        });

        it('ModificationType should accept specific literal strings', () => {
            const t1: ModificationType = 'cell_update';
            const t2: ModificationType = 'row_insert';
            const t3: ModificationType = 'row_delete';
            const t4: ModificationType = 'table_create';

            assert.strictEqual(t1, 'cell_update');
            assert.strictEqual(t2, 'row_insert');
            assert.strictEqual(t3, 'row_delete');
            assert.strictEqual(t4, 'table_create');
        });
    });

    describe('Data Structures', () => {
        it('QueryResultSet should structure data and headers properly', () => {
            const result: QueryResultSet = {
                headers: ['id', 'name'],
                rows: [[1, 'Alice'], [2, 'Bob']],
                columns: ['id', 'name'],
                values: [[1, 'Alice'], [2, 'Bob']]
            };

            assert.strictEqual(result.headers.length, 2);
            assert.strictEqual(result.rows.length, 2);
            assert.strictEqual(result.rows[0][1], 'Alice');
        });

        it('ColumnMetadata should structure PRAGMA table_info correctly', () => {
            const col: ColumnMetadata = {
                ordinal: 0,
                identifier: 'id',
                declaredType: 'INTEGER',
                isRequired: 1,
                defaultExpression: null,
                primaryKeyPosition: 1
            };

            assert.strictEqual(col.identifier, 'id');
            assert.strictEqual(col.primaryKeyPosition, 1);
        });

        it('SchemaSnapshot should encapsulate database structure', () => {
            const schema: SchemaSnapshot = {
                tables: [{ identifier: 'users', columnCount: 5 }],
                views: [{ identifier: 'active_users' }],
                indexes: [{ identifier: 'idx_users_id', parentTable: 'users' }]
            };

            assert.strictEqual(schema.tables.length, 1);
            assert.strictEqual(schema.views[0].identifier, 'active_users');
            assert.strictEqual(schema.indexes[0].parentTable, 'users');
        });
    });

    describe('Operation and Dialog Types', () => {
        it('ModificationEntry should support comprehensive edit tracking', () => {
            const mod: ModificationEntry = {
                description: 'Update user name',
                modificationType: 'cell_update',
                targetTable: 'users',
                targetRowId: 1,
                targetColumn: 'name',
                priorValue: 'Alice',
                newValue: 'Alicia'
            };

            assert.strictEqual(mod.modificationType, 'cell_update');
            assert.strictEqual(mod.newValue, 'Alicia');
            assert.strictEqual(mod.targetRowId, 1);
        });

        it('CellUpdate should encapsulate batch update operations', () => {
            const update: CellUpdate = {
                rowId: 10,
                column: 'status',
                value: 'active',
                operation: 'set'
            };

            assert.strictEqual(update.rowId, 10);
            assert.strictEqual(update.value, 'active');
        });

        it('ExportOptions should define CSV/SQL export configurations', () => {
            const opts: ExportOptions = {
                format: 'csv',
                header: true,
                includeTableName: false,
                rowIds: [1, 2, 3]
            };

            assert.strictEqual(opts.format, 'csv');
            assert.strictEqual(opts.header, true);
            assert.strictEqual(opts.rowIds?.length, 3);
        });

        it('DialogConfig should define modal properties', () => {
            const dialog: DialogConfig = {
                modal: true,
                detailText: 'Are you sure?'
            };

            assert.strictEqual(dialog.modal, true);
            assert.strictEqual(dialog.detailText, 'Are you sure?');
        });
    });
});
