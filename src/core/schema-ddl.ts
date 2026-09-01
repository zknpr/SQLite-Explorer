import type { ColumnDefinition } from './types';
import {
  assertUsableSqlIdentifier,
  escapeIdentifier,
  escapeMainIdentifier,
  validateSqlType
} from './sql-utils';

const MAX_INDEX_DEFINITION_CODE_UNITS = 1024 * 1024;
const MAX_INDEX_DEFINITION_TOKENS = 200_000;

interface SqlToken {
  kind: 'word' | 'double-quoted' | 'quoted' | 'string' | 'symbol';
  value: string;
  start: number;
  end: number;
}

function sqliteIdentifierKey(identifier: string): string {
  // SQLite's built-in identifier folding is ASCII-only. JavaScript's Unicode
  // lower-casing would incorrectly merge distinct non-ASCII identifiers.
  return identifier.replace(/[A-Z]/g, character => character.toLowerCase());
}

function isIdentifierToken(token: SqlToken | undefined): token is SqlToken {
  return token !== undefined && token.kind !== 'symbol';
}

function isIdentifierStartCharacter(character: string): boolean {
  // SQLite treats every non-ASCII character as alphabetic for bare-token
  // purposes; JavaScript's Unicode letter classes would be both narrower and
  // subject to case-folding rules SQLite does not use.
  return /[A-Za-z_\u0080-\uFFFF]/.test(character);
}

function isIdentifierCharacter(character: string): boolean {
  return /[A-Za-z0-9_$\u0080-\uFFFF]/.test(character);
}

function readDelimitedToken(
  sql: string,
  start: number,
  delimiter: '"' | '`' | "'"
): { end: number; value: string } {
  let cursor = start + 1;
  let value = '';
  while (cursor < sql.length) {
    if (sql[cursor] !== delimiter) {
      value += sql[cursor];
      cursor++;
      continue;
    }
    if (sql[cursor + 1] === delimiter) {
      value += delimiter;
      cursor += 2;
      continue;
    }
    return { end: cursor + 1, value };
  }
  throw new Error('Cannot inspect index dependency: unterminated quoted token');
}

function tokenizeIndexDefinition(sql: string): SqlToken[] {
  if (sql.length > MAX_INDEX_DEFINITION_CODE_UNITS) {
    throw new Error(
      `Cannot inspect index dependency: definition exceeds ${MAX_INDEX_DEFINITION_CODE_UNITS} characters`
    );
  }

  const tokens: SqlToken[] = [];
  const push = (token: SqlToken): void => {
    tokens.push(token);
    if (tokens.length > MAX_INDEX_DEFINITION_TOKENS) {
      throw new Error(
        `Cannot inspect index dependency: definition exceeds ${MAX_INDEX_DEFINITION_TOKENS} tokens`
      );
    }
  };

  let cursor = 0;
  while (cursor < sql.length) {
    const character = sql[cursor];
    if (/\s/.test(character)) {
      cursor++;
      continue;
    }

    if (character === '-' && sql[cursor + 1] === '-') {
      const lineEnd = sql.indexOf('\n', cursor + 2);
      cursor = lineEnd === -1 ? sql.length : lineEnd + 1;
      continue;
    }
    if (character === '/' && sql[cursor + 1] === '*') {
      const commentEnd = sql.indexOf('*/', cursor + 2);
      if (commentEnd === -1) {
        throw new Error('Cannot inspect index dependency: unterminated block comment');
      }
      cursor = commentEnd + 2;
      continue;
    }

    if (character === '"' || character === '`' || character === "'") {
      const token = readDelimitedToken(sql, cursor, character);
      push({
        kind: character === '"'
          ? 'double-quoted'
          : character === "'" ? 'string' : 'quoted',
        value: token.value,
        start: cursor,
        end: token.end
      });
      cursor = token.end;
      continue;
    }

    if (character === '[') {
      const end = sql.indexOf(']', cursor + 1);
      if (end === -1) {
        throw new Error('Cannot inspect index dependency: unterminated bracket identifier');
      }
      push({
        kind: 'quoted',
        value: sql.slice(cursor + 1, end),
        start: cursor,
        end: end + 1
      });
      cursor = end + 1;
      continue;
    }

    if (isIdentifierStartCharacter(character)) {
      let end = cursor + 1;
      while (end < sql.length && isIdentifierCharacter(sql[end])) end++;
      push({ kind: 'word', value: sql.slice(cursor, end), start: cursor, end });
      cursor = end;
      continue;
    }

    push({ kind: 'symbol', value: character, start: cursor, end: cursor + 1 });
    cursor++;
  }

  return tokens;
}

function indexExpressionSuffix(indexSql: string): string {
  const tokens = tokenizeIndexDefinition(indexSql);
  const indexKeyword = tokens.findIndex(
    token => token.kind === 'word' && token.value.toUpperCase() === 'INDEX'
  );
  const onKeyword = tokens.findIndex(
    (token, index) => index > indexKeyword
      && token.kind === 'word'
      && token.value.toUpperCase() === 'ON'
  );
  const openingParenthesis = tokens.findIndex(
    (token, index) => index > onKeyword && token.kind === 'symbol' && token.value === '('
  );
  if (indexKeyword < 0 || onKeyword < 0 || openingParenthesis < 0) {
    throw new Error('Cannot inspect index dependency: unsupported CREATE INDEX definition');
  }

  const statementTerminators = tokens.filter(
    (token, index) => index >= openingParenthesis
      && token.kind === 'symbol'
      && token.value === ';'
  );
  if (
    statementTerminators.length > 1
    || (statementTerminators.length === 1
      && tokens.at(-1) !== statementTerminators[0])
  ) {
    throw new Error('Cannot inspect index dependency: multiple statements are not allowed');
  }
  const suffixEnd = statementTerminators[0]?.start ?? indexSql.length;
  return indexSql.slice(tokens[openingParenthesis].start, suffixEnd).trim();
}

export function buildIndexDependencyProbeTableSql(
  probeTable: string,
  tableColumns: readonly string[]
): string {
  const columns = [...tableColumns];
  let dummy = `${probeTable}_dummy`;
  const existing = new Set(tableColumns.map(sqliteIdentifierKey));
  while (existing.has(sqliteIdentifierKey(dummy))) dummy += '_';
  // Keep the last DROP COLUMN valid when callers select every real column.
  // Any failure can then come only from the candidate index definition.
  columns.push(dummy);
  return `CREATE TEMP TABLE ${escapeIdentifier(probeTable)} (`
    + `${columns.map(escapeIdentifier).join(', ')})`;
}

export function resolveIndexDependencyColumns(
  tableColumns: readonly string[],
  requestedColumns: readonly string[]
): string[] {
  const requestedKeys = new Set(requestedColumns.map(sqliteIdentifierKey));
  return tableColumns.filter(column => requestedKeys.has(sqliteIdentifierKey(column)));
}

export function buildIndexDependencyProbeIndexSql(
  probeTable: string,
  probeIndex: string,
  indexSql: string
): string {
  const suffix = indexExpressionSuffix(indexSql);
  return `CREATE INDEX temp.${escapeIdentifier(probeIndex)} `
    + `ON ${escapeIdentifier(probeTable)} ${suffix}`;
}

/** Recreate a captured persistent index explicitly in main despite TEMP shadows. */
export function qualifyMainCreateIndexSql(
  indexSql: string,
  expectedIdentifier: string
): string {
  // Reuse the full suffix inspection so malformed or multi-statement catalog
  // text is rejected before any replay DDL is constructed.
  indexExpressionSuffix(indexSql);
  const tokens = tokenizeIndexDefinition(indexSql);
  let cursor = 0;
  const expectKeyword = (keyword: string): void => {
    const token = tokens[cursor];
    if (token?.kind !== 'word' || token.value.toUpperCase() !== keyword) {
      throw new Error(`Expected ${keyword} in stored CREATE INDEX SQL`);
    }
    cursor++;
  };
  expectKeyword('CREATE');
  if (tokens[cursor]?.kind === 'word' && tokens[cursor].value.toUpperCase() === 'UNIQUE') {
    cursor++;
  }
  expectKeyword('INDEX');
  if (tokens[cursor]?.kind === 'word' && tokens[cursor].value.toUpperCase() === 'IF') {
    cursor++;
    expectKeyword('NOT');
    expectKeyword('EXISTS');
  }

  const first = tokens[cursor];
  if (!isIdentifierToken(first)) {
    throw new Error('Expected an index identifier in stored CREATE INDEX SQL');
  }
  const qualified = tokens[cursor + 1]?.kind === 'symbol'
    && tokens[cursor + 1].value === '.';
  const name = qualified ? tokens[cursor + 2] : first;
  if (!isIdentifierToken(name)
      || sqliteIdentifierKey(name.value) !== sqliteIdentifierKey(expectedIdentifier)) {
    throw new Error(`Stored CREATE INDEX identifier does not match ${expectedIdentifier}`);
  }
  if (qualified) {
    if (sqliteIdentifierKey(first.value) !== 'main') {
      throw new Error(`Stored CREATE INDEX for ${expectedIdentifier} is not in main`);
    }
    return indexSql;
  }
  return `${indexSql.slice(0, first.start)}main.${indexSql.slice(first.start)}`;
}

export function buildCreateTableSql(
  table: string,
  columns: readonly ColumnDefinition[]
): string {
  assertUsableSqlIdentifier(table, 'Table name');
  if (columns.length === 0) throw new Error('At least one column is required');

  const primaryKeyColumns = columns.filter(column => column.primaryKey);
  const compositePrimaryKey = primaryKeyColumns.length > 1;
  const seenColumnNames = new Set<string>();
  const definitions = columns.map(column => {
    if (typeof column === 'string') {
      throw new Error('Legacy string column definitions not supported for security');
    }
    assertUsableSqlIdentifier(column.name, 'Column name');
    validateSqlType(column.type);
    const columnKey = sqliteIdentifierKey(column.name);
    if (seenColumnNames.has(columnKey)) {
      throw new Error(`Column ${JSON.stringify(column.name)} is defined more than once`);
    }
    seenColumnNames.add(columnKey);

    let definition = `${escapeIdentifier(column.name)} ${column.type}`;
    if (column.primaryKey && !compositePrimaryKey) definition += ' PRIMARY KEY';
    if (column.notNull) definition += ' NOT NULL';
    definition += buildColumnDefaultClause(column.defaultValue);
    return definition;
  });

  if (compositePrimaryKey) {
    definitions.push(
      `PRIMARY KEY (${primaryKeyColumns.map(column => escapeIdentifier(column.name)).join(', ')})`
    );
  }
  return `CREATE TABLE ${escapeMainIdentifier(table)} (${definitions.join(', ')})`;
}

/** Reject a duplicate before backend-specific SQLite bindings can erase the cause. */
export function assertColumnNameAvailable(
  table: string,
  column: string,
  existingColumns: readonly string[]
): void {
  const columnKey = sqliteIdentifierKey(column);
  if (existingColumns.some(existing => sqliteIdentifierKey(existing) === columnKey)) {
    throw new Error(
      `Column ${JSON.stringify(column)} already exists in table ${JSON.stringify(table)}`
    );
  }
}

/** Render the string-valued Create/Add Column default contract as a safe SQL clause. */
export function buildColumnDefaultClause(defaultValue?: string): string {
  if (defaultValue === undefined || defaultValue === null || defaultValue === '') return '';
  if (defaultValue.toLowerCase() === 'null') return ' DEFAULT NULL';
  if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(defaultValue)) {
    return ` DEFAULT ${defaultValue}`;
  }
  return ` DEFAULT '${defaultValue.replace(/'/g, "''")}'`;
}
