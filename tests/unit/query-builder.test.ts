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
      assert.strictEqual(sql, 'SELECT * FROM "users" WHERE "name" LIKE ?');
      assert.deepStrictEqual(params, ['%John%']);
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
  });
});
