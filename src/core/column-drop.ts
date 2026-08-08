import { escapeIdentifier } from './sql-utils';

export type ColumnDropStatementExecutor = (
  sql: string
) => void | Promise<void>;

/**
 * Run SQLite's schema-aware DROP COLUMN statements in dependency-first order.
 * The caller owns the surrounding savepoint because rollback APIs differ by
 * engine; keeping statement construction here prevents demo/desktop drift.
 */
export async function executeSchemaPreservingColumnDrop(
  table: string,
  columns: readonly string[],
  dropDependentIndexes: readonly string[] | undefined,
  execute: ColumnDropStatementExecutor
): Promise<void> {
  for (const indexName of dropDependentIndexes ?? []) {
    await execute(`DROP INDEX IF EXISTS ${escapeIdentifier(indexName)}`);
  }

  const escapedTable = escapeIdentifier(table);
  for (const column of columns) {
    await execute(
      `ALTER TABLE ${escapedTable} DROP COLUMN ${escapeIdentifier(column)}`
    );
  }
}
