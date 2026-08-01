import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildSelectQuery, buildCountQuery } from '../../src/core/query-builder';

describe('Query Builder', () => {
  describe('buildSelectQuery', () => {
    it('should build simple select *', () => {
      const { sql, params } = buildSelectQuery('my_table', {});
      assert.strictEqual(sql, 'SELECT * FROM "my_table"');
      assert.deepStrictEqual(params, []);
    });

    it('should select specific columns', () => {
      const { sql } = buildSelectQuery('my_table', { columns: ['name', 'age'] });
      assert.strictEqual(sql, 'SELECT "name", "age" FROM "my_table"');
    });

    it('should handle filters', () => {
      const options = {
        filters: [{ column: 'name', value: 'John' }]
      };
      const { sql, params } = buildSelectQuery('users', options);
      assert.strictEqual(sql, 'SELECT * FROM "users" WHERE "name" LIKE ? ESCAPE \'\\\'');
      assert.deepStrictEqual(params, ['%John%']);
    });

    it('should escape wildcards in filters', () => {
      const options = {
        filters: [{ column: 'name', value: '100%' }]
      };
      const { sql, params } = buildSelectQuery('users', options);
      assert.strictEqual(sql, 'SELECT * FROM "users" WHERE "name" LIKE ? ESCAPE \'\\\'');
      assert.deepStrictEqual(params, ['%100\\%%']);
    });

    it('should handle pagination and sorting', () => {
      const options = {
        limit: 10,
        offset: 20,
        orderBy: 'created_at',
        orderDir: 'DESC' as const
      };
      const { sql } = buildSelectQuery('logs', options);
      assert.strictEqual(sql, 'SELECT * FROM "logs" ORDER BY "created_at" DESC LIMIT 10 OFFSET 20');
    });

    it('should handle global filter with explicit columns', () => {
      const options = {
        columns: ['name', 'description'],
        globalFilter: 'test'
      };
      const { sql, params } = buildSelectQuery('products', options);
      assert.strictEqual(sql, 'SELECT "name", "description" FROM "products" WHERE ("name" LIKE ? ESCAPE \'\\\' OR "description" LIKE ? ESCAPE \'\\\')');
      assert.deepStrictEqual(params, ['%test%', '%test%']);
    });

    it('keeps the synthetic rowid in SELECT but out of the global predicate', () => {
      const options = {
        columns: ['rowid', 'value'],
        globalFilterColumns: ['value'],
        globalFilter: '12'
      };
      const { sql, params } = buildSelectQuery('items', options);

      assert.strictEqual(
        sql,
        'SELECT "rowid" AS "rowid", "value" FROM "items" WHERE ("value" LIKE ? ESCAPE \'\\\')'
      );
      assert.deepStrictEqual(params, ['%12%']);
    });

    it('should handle global filter with default columns (edge case)', () => {
      // This documents current behavior where default ['*'] results in " * " LIKE ?
      const options = {
        globalFilter: 'test'
      };
      const { sql, params } = buildSelectQuery('products', options);
      assert.strictEqual(sql, 'SELECT * FROM "products" WHERE ("*" LIKE ? ESCAPE \'\\\')');
      assert.deepStrictEqual(params, ['%test%']);
    });

    it('should handle global filter with empty columns (safe behavior)', () => {
      const options = {
        columns: [],
        globalFilter: 'test'
      };
      const { sql, params } = buildSelectQuery('products', options);
      // Implementation should avoid generating WHERE ()
      assert.strictEqual(sql, 'SELECT  FROM "products"');
      assert.deepStrictEqual(params, []);
    });

    it('skips whitespace-only filters while preserving padded nonblank values', () => {
      const inactive = buildSelectQuery('products', {
        columns: ['name'],
        filters: [{ column: 'name', value: '   ' }],
        globalFilter: '\t '
      });
      assert.strictEqual(inactive.sql, 'SELECT "name" FROM "products"');
      assert.deepStrictEqual(inactive.params, []);

      const padded = buildSelectQuery('products', {
        columns: ['name'],
        filters: [{ column: 'name', value: ' needle ' }],
        globalFilter: ' global '
      });
      assert.deepStrictEqual(padded.params, ['% needle %', '% global %']);
    });
  });

  describe('buildCountQuery', () => {
    it('should build simple count', () => {
      const { sql, params } = buildCountQuery('my_table', {});
      assert.strictEqual(sql, 'SELECT COUNT(*) as count FROM "my_table"');
      assert.deepStrictEqual(params, []);
    });

    it('should handle global filter with explicit columns', () => {
      const options = {
        columns: ['name', 'description'],
        globalFilter: 'test'
      };
      const { sql, params } = buildCountQuery('products', options);
      assert.strictEqual(sql, 'SELECT COUNT(*) as count FROM "products" WHERE ("name" LIKE ? ESCAPE \'\\\' OR "description" LIKE ? ESCAPE \'\\\')');
      assert.deepStrictEqual(params, ['%test%', '%test%']);
    });

    it('uses the explicitly narrowed global-filter columns for counts', () => {
      const { sql, params } = buildCountQuery('products', {
        columns: ['visible', 'hidden'],
        globalFilterColumns: ['visible'],
        globalFilter: 'needle'
      });

      assert.strictEqual(
        sql,
        'SELECT COUNT(*) as count FROM "products" WHERE ("visible" LIKE ? ESCAPE \'\\\')'
      );
      assert.deepStrictEqual(params, ['%needle%']);
    });

    it('should handle global filter with empty columns (safe behavior)', () => {
      const options = {
        columns: [],
        globalFilter: 'test'
      };
      const { sql, params } = buildCountQuery('products', options);
      assert.strictEqual(sql, 'SELECT COUNT(*) as count FROM "products"');
      assert.deepStrictEqual(params, []);
    });

    it('uses the same whitespace policy for count queries', () => {
      const inactive = buildCountQuery('products', {
        columns: ['name'],
        filters: [{ column: 'name', value: '   ' }],
        globalFilter: '\n'
      });
      assert.strictEqual(inactive.sql, 'SELECT COUNT(*) as count FROM "products"');
      assert.deepStrictEqual(inactive.params, []);

      const padded = buildCountQuery('products', {
        columns: ['name'],
        globalFilter: ' needle '
      });
      assert.deepStrictEqual(padded.params, ['% needle %']);
    });
  });
});
