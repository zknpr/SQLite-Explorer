import { escapeIdentifier } from './sql-utils';

/**
 * Virtual-table modules that only the bundled WebAssembly engine registers.
 * The native build leaves FTS3 and FTS4 out on purpose: they would parse index
 * data from the file in an unsandboxed process, and the WebAssembly engine runs
 * them in a sandbox. Every module the native build registers is in the
 * WebAssembly build too, so opening a file there loses no table.
 * native_module_fallback.test.ts reads pragma_module_list from both bundled
 * builds, so a rebuild that changes either fact fails there.
 */
export const WASM_ONLY_VIRTUAL_TABLE_MODULES: readonly string[] = ['fts3', 'fts3tokenize', 'fts4', 'fts4aux'];

/** Most virtual tables one check prepares. Past it, none are prepared. */
export const MAX_MODULE_CHECK_TABLES = 256;
/** Longest table name, in bytes, that a check reads and prepares. */
export const MAX_MODULE_CHECK_NAME_BYTES = 1024;

export interface ModuleCheckAdapter {
  queryRows(sql: string): Promise<readonly (readonly unknown[])[]>;
  /** One error message per statement, undefined where it compiled. */
  compileStatements(statements: readonly string[]): Promise<readonly (string | undefined)[]>;
}

export interface ModuleTable {
  table: string;
  /** The module's name as listed in WASM_ONLY_VIRTUAL_TABLE_MODULES, not as written. */
  module: string;
}

export type ModuleCheckResult =
  | { checked: true; tables: ModuleTable[] }
  | { checked: false; reason: string };

const NO_SUCH_MODULE = 'no such module: ';

function foldAscii(text: string): string {
  return text.replace(/[A-Z]/g, character => character.toLowerCase());
}

/**
 * The main-schema virtual tables whose module, on the connection the adapter
 * reads, is one of `modules` and is missing.
 *
 * SQLite reports the module itself: preparing a statement that names a virtual
 * table connects it, and a missing module fails with "no such module: <name>".
 * Nothing here parses CREATE VIRTUAL TABLE text. The query only narrows which
 * tables get prepared: SQLite looks a module up by its name in ASCII case, and
 * its parser only removes quotes from that name, so a table using one of these
 * modules has the module's name, in some ASCII case, inside its stored SQL,
 * which LIKE matches without case. SQLite stores every virtual table's SQL
 * starting with this prefix. An ordinary database matches no row, so this
 * costs it one query. A table that only mentions one of these names, in its
 * own name or in its arguments, matches too and is prepared with the rest;
 * its answer is not "no such module", so it is not counted.
 *
 * Bounded: past MAX_MODULE_CHECK_TABLES matching tables, or with a matching
 * table named longer than MAX_MODULE_CHECK_NAME_BYTES, nothing is prepared
 * and the result says why. TEMP is not read: it is never in the file.
 */
export async function findTablesWithMissingModules(
  adapter: ModuleCheckAdapter,
  modules: readonly string[]
): Promise<ModuleCheckResult> {
  if (!modules.every(module => /^[a-z0-9_]+$/.test(module))) {
    throw new Error('Virtual-table module names to check must be lower-case identifiers');
  }
  const mentions = modules.map(module => `sql LIKE '%${module}%'`).join(' OR ');
  const rows = await adapter.queryRows(
    `SELECT CASE WHEN length(CAST(name AS BLOB)) <= ${MAX_MODULE_CHECK_NAME_BYTES} THEN name END ` +
    "FROM main.sqlite_schema WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%' " +
    `AND (${mentions}) LIMIT ${MAX_MODULE_CHECK_TABLES + 1}`
  );
  if (rows.length > MAX_MODULE_CHECK_TABLES) {
    return { checked: false, reason: `more than ${MAX_MODULE_CHECK_TABLES} virtual tables might use them` };
  }
  const tables: string[] = [];
  for (const [name] of rows) {
    if (name === null) {
      return {
        checked: false,
        reason: `a virtual table that might use them has a name longer than ${MAX_MODULE_CHECK_NAME_BYTES} bytes`
      };
    }
    if (typeof name !== 'string') {
      throw new Error('SQLite returned invalid schema metadata while checking virtual-table modules');
    }
    tables.push(name);
  }
  if (tables.length === 0) return { checked: true, tables: [] };

  const errors = await adapter.compileStatements(
    tables.map(table => `EXPLAIN SELECT 1 FROM main.${escapeIdentifier(table)}`)
  );
  if (errors.length !== tables.length) {
    throw new Error('The virtual-table module check returned an incomplete result set');
  }
  // A locked file answered for none of them: nothing was learned about any table.
  if (errors.some(error => error === 'database is locked')) {
    return { checked: false, reason: 'another program has the database locked' };
  }
  const found: ModuleTable[] = [];
  tables.forEach((table, index) => {
    const error = errors[index];
    // Only SQLite's own message counts. A module's constructor can fail with
    // text taken from the schema, which could imitate it after a prefix.
    if (error === undefined || !error.startsWith(NO_SUCH_MODULE)) return;
    const named = foldAscii(error.slice(NO_SUCH_MODULE.length));
    const module = modules.find(candidate => candidate === named);
    if (module !== undefined) found.push({ table, module });
  });
  return { checked: true, tables: found };
}
