import { escapeIdentifier } from './sql-utils';
import type {
  CellValue,
  ViewDefinition,
  ViewDefinitionIntent,
  ViewTriggerDefinition
} from './types';

/** Canonical trigger sources, ordered by the schema in which they are replayed. */
export const VIEW_TRIGGER_SCHEMA_QUERIES = [
  {
    sql: "SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE ORDER BY rowid",
    params: (view: string): CellValue[] => [view],
    temporary: false
  },
  {
    // sqlite_temp_schema.tbl_name does not retain the target schema. Return the
    // shadow state with every candidate so mapViewTriggerRows can distinguish
    // an explicit ON main.v from an unqualified ON v when temp.v exists.
    sql: "SELECT temp_trigger.name, temp_trigger.sql, " +
      "EXISTS (SELECT 1 FROM sqlite_temp_schema AS temp_view " +
      "WHERE temp_view.type = 'view' AND temp_view.name = ? COLLATE NOCASE) " +
      "FROM sqlite_temp_schema AS temp_trigger WHERE temp_trigger.type = 'trigger' " +
      "AND temp_trigger.tbl_name = ? COLLATE NOCASE ORDER BY temp_trigger.rowid",
    params: (view: string): CellValue[] => [view, view],
    temporary: true
  }
] as const;

interface SqlToken {
  kind: 'word' | 'identifier' | 'string' | 'symbol';
  value: string;
  start: number;
  end: number;
}

function isSqlWordCharacter(char: string): boolean {
  return /[A-Za-z0-9_$\u0080-\uFFFF]/.test(char);
}

/** Tokenize SQL structure while keeping quoted text and comments opaque. */
function scanSqlTokens(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (char === '-' && next === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') index++;
      continue;
    }
    if (char === '/' && next === '*') {
      const commentEnd = sql.indexOf('*/', index + 2);
      if (commentEnd === -1) break;
      index = commentEnd + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const start = index;
      const closingQuote = char === '[' ? ']' : char;
      const kind = char === "'" ? 'string' : 'identifier';
      let value = '';
      index++;
      while (index < sql.length) {
        if (sql[index] === closingQuote) {
          if (sql[index + 1] === closingQuote) {
            value += closingQuote;
            index += 2;
            continue;
          }
          index++;
          break;
        }
        value += sql[index++];
      }
      tokens.push({ kind, value, start, end: index });
      continue;
    }
    if (isSqlWordCharacter(char)) {
      const start = index++;
      while (index < sql.length && isSqlWordCharacter(sql[index])) index++;
      tokens.push({ kind: 'word', value: sql.slice(start, index), start, end: index });
      continue;
    }

    tokens.push({ kind: 'symbol', value: char, start: index, end: ++index });
  }

  return tokens;
}

function isSqlKeyword(token: SqlToken | undefined, keyword: string): boolean {
  return token?.kind === 'word' && token.value.toUpperCase() === keyword;
}

function isSqlIdentifierToken(token: SqlToken | undefined): token is SqlToken {
  return token?.kind === 'word' || token?.kind === 'identifier';
}

function foldSqlIdentifier(identifier: string): string {
  return identifier.replace(/[A-Z]/g, character => character.toLowerCase());
}

function consumeSqlIdentifier(tokens: readonly SqlToken[], index: number): number {
  const token = tokens[index];
  if (!token || (token.kind !== 'word' && token.kind !== 'identifier')) {
    throw new Error('Expected an SQL identifier');
  }
  return index + 1;
}

function consumeQualifiedSqlIdentifier(tokens: readonly SqlToken[], index: number): number {
  index = consumeSqlIdentifier(tokens, index);
  if (tokens[index]?.kind === 'symbol' && tokens[index].value === '.') {
    index = consumeSqlIdentifier(tokens, index + 1);
  }
  return index;
}

interface ParsedStoredTriggerSql {
  tokens: SqlToken[];
  targetSchema?: string;
  updateOfColumns: SqlToken[];
  referenceStartIndex: number;
  bodyStartIndex: number;
}

/** Parse the structural header shared by trigger attribution and compatibility checks. */
function parseStoredTriggerSql(triggerSql: string): ParsedStoredTriggerSql {
  const tokens = scanSqlTokens(triggerSql);
  const updateOfColumns: SqlToken[] = [];
  let index = 0;
  const expectKeyword = (keyword: string) => {
    if (!isSqlKeyword(tokens[index], keyword)) {
      throw new Error(`Expected ${keyword} in stored CREATE TRIGGER SQL`);
    }
    index++;
  };

  expectKeyword('CREATE');
  if (isSqlKeyword(tokens[index], 'TEMP') || isSqlKeyword(tokens[index], 'TEMPORARY')) index++;
  expectKeyword('TRIGGER');
  if (isSqlKeyword(tokens[index], 'IF')) {
    index++;
    expectKeyword('NOT');
    expectKeyword('EXISTS');
  }
  index = consumeQualifiedSqlIdentifier(tokens, index);

  if (isSqlKeyword(tokens[index], 'BEFORE') || isSqlKeyword(tokens[index], 'AFTER')) {
    index++;
  } else if (isSqlKeyword(tokens[index], 'INSTEAD')) {
    index++;
    expectKeyword('OF');
  }

  if (isSqlKeyword(tokens[index], 'INSERT') || isSqlKeyword(tokens[index], 'DELETE')) {
    index++;
  } else if (isSqlKeyword(tokens[index], 'UPDATE')) {
    index++;
    if (isSqlKeyword(tokens[index], 'OF')) {
      index++;
      if (!isSqlIdentifierToken(tokens[index])) {
        throw new Error('Expected an SQL identifier after UPDATE OF');
      }
      updateOfColumns.push(tokens[index]);
      index = consumeSqlIdentifier(tokens, index);
      while (tokens[index]?.kind === 'symbol' && tokens[index].value === ',') {
        index++;
        if (!isSqlIdentifierToken(tokens[index])) {
          throw new Error('Expected an SQL identifier in UPDATE OF column list');
        }
        updateOfColumns.push(tokens[index]);
        index = consumeSqlIdentifier(tokens, index);
      }
    }
  } else {
    throw new Error('Expected a trigger event in stored CREATE TRIGGER SQL');
  }

  expectKeyword('ON');
  const schemaToken = tokens[index];
  index = consumeSqlIdentifier(tokens, index);
  let targetSchema: string | undefined;
  if (tokens[index]?.kind === 'symbol' && tokens[index].value === '.') {
    targetSchema = schemaToken.value;
    index = consumeSqlIdentifier(tokens, index + 1);
  }
  const referenceStartIndex = index;
  const beginIndex = tokens.findIndex((token, tokenIndex) => (
    tokenIndex >= index && isSqlKeyword(token, 'BEGIN')
  ));
  if (beginIndex < 0) {
    throw new Error('Expected BEGIN in stored CREATE TRIGGER SQL');
  }
  return {
    tokens,
    targetSchema,
    updateOfColumns,
    referenceStartIndex,
    bodyStartIndex: beginIndex + 1
  };
}

/** Return the schema explicitly named by a CREATE TRIGGER ON target, if any. */
function extractTriggerTargetSchema(triggerSql: string): string | undefined {
  return parseStoredTriggerSql(triggerSql).targetSchema;
}

/** Qualify a persistent view so a same-named TEMP view cannot shadow DDL. */
export function escapeMainViewIdentifier(view: string): string {
  return `main.${escapeIdentifier(view)}`;
}

/** Map canonical trigger-query rows while keeping temp-schema provenance intact. */
export function mapViewTriggerRows(
  view: string,
  rowsBySchema: readonly (readonly (readonly CellValue[])[])[]
): ViewTriggerDefinition[] {
  if (rowsBySchema.length !== VIEW_TRIGGER_SCHEMA_QUERIES.length) {
    throw new Error(`View trigger definition fetch was incomplete for ${view}`);
  }

  return VIEW_TRIGGER_SCHEMA_QUERIES.flatMap((source, index) => (
    rowsBySchema[index].flatMap(row => {
      if (typeof row[0] !== 'string' || typeof row[1] !== 'string') {
        throw new Error(`View trigger definition is unavailable for ${view}`);
      }
      if (source.temporary) {
        const hasTempShadow = row[2] === 1 || row[2] === 1n;
        if (row[2] !== 0 && row[2] !== 0n && !hasTempShadow) {
          throw new Error(`Temporary view shadow state is unavailable for ${view}`);
        }
        let targetSchema: string | undefined;
        try {
          targetSchema = extractTriggerTargetSchema(row[1]);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Unable to determine the target of temporary trigger ${row[0]}: ${detail}`
          );
        }
        // Explicit schema qualification is authoritative even without a TEMP
        // shadow: aux.v must never be captured as a trigger on main.v.
        if (targetSchema !== undefined && targetSchema.toLowerCase() !== 'main') return [];
        if (targetSchema === undefined && hasTempShadow) return [];
      }
      return source.temporary
        ? [{ identifier: row[0], sql: row[1], temporary: true }]
        : [{ identifier: row[0], sql: row[1] }];
    })
  ));
}

/**
 * Remove one optional statement terminator from an editable SELECT body.
 * SQLite still performs the actual syntax and semantic validation.
 */
export function normalizeViewSelectSql(selectSql: string): string {
  const trimmed = selectSql.trim();
  if (!trimmed) {
    throw new Error('View SELECT definition is required');
  }

  // A semicolon is still the statement terminator when only comments follow
  // it. Track the last non-comment SQL token instead of looking at the final
  // character, while treating quoted semicolons as expression text.
  let lastSqlToken = -1;
  let quote: "'" | '"' | '`' | ']' | undefined;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index];
    const next = trimmed[index + 1];

    if (inLineComment) {
      if (char === '\n' || char === '\r') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      lastSqlToken = index;
      if (char === quote) {
        if (next === quote) {
          lastSqlToken = ++index;
        } else {
          quote = undefined;
        }
      }
      continue;
    }

    if (char === '-' && next === '-') {
      inLineComment = true;
      index++;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      index++;
      continue;
    }
    if (/\s/.test(char)) continue;

    lastSqlToken = index;
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '[') {
      quote = ']';
    }
  }

  if (lastSqlToken >= 0 && trimmed[lastSqlToken] === ';') {
    return (
      trimmed.slice(0, lastSqlToken).trimEnd()
      + trimmed.slice(lastSqlToken + 1)
    ).trim();
  }
  return trimmed;
}

interface ViewSqlParts {
  selectStart: number;
  columnListSql?: string;
}

/** Locate the declaration's top-level AS without treating quoted text as SQL structure. */
function locateViewSqlParts(createSql: string): ViewSqlParts {
  let depth = 0;
  let columnListStart = -1;
  let columnListEnd = -1;

  for (const token of scanSqlTokens(createSql)) {
    if (token.kind === 'symbol' && token.value === '(') {
      if (depth === 0 && columnListStart === -1) columnListStart = token.start;
      depth++;
      continue;
    }
    if (token.kind === 'symbol' && token.value === ')') {
      if (depth === 1 && columnListStart !== -1 && columnListEnd === -1) {
        columnListEnd = token.end;
      }
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && isSqlKeyword(token, 'AS')) {
      return {
        selectStart: token.end,
        columnListSql: columnListStart !== -1 && columnListEnd !== -1
          ? createSql.slice(columnListStart, columnListEnd)
          : undefined
      };
    }
  }

  throw new Error('Unable to locate the SELECT body in the stored view definition');
}

/**
 * Extract the SELECT body from SQLite's stored CREATE VIEW statement.
 *
 * This only locates the top-level AS token for editor presentation. It does not
 * decide whether the SQL is safe or valid; every saved definition is compiled
 * by SQLite itself before its SAVEPOINT is released.
 */
export function extractViewSelectSql(createSql: string): string {
  const { selectStart } = locateViewSqlParts(createSql);
  return normalizeViewSelectSql(createSql.slice(selectStart));
}

/** Return the stored explicit column-list SQL, including its parentheses. */
export function extractViewColumnListSql(createSql: string): string | undefined {
  return locateViewSqlParts(createSql).columnListSql;
}

/** Build CREATE VIEW while preserving a stored explicit column list verbatim. */
export function buildCreateViewSql(
  view: string,
  selectSql: string,
  columnListSql?: string,
  legacyColumns?: string[]
): string {
  const preservedColumnList = columnListSql
    ?? (legacyColumns?.length
      ? `(${legacyColumns.map(column => escapeIdentifier(column)).join(', ')})`
      : undefined);
  return `CREATE VIEW ${escapeIdentifier(view)}${preservedColumnList ? ` ${preservedColumnList}` : ''} AS ${selectSql}`;
}

/** Rebuild a captured trigger in the schema it originally occupied. */
export function buildCreateViewTriggerSql(trigger: ViewTriggerDefinition): string {
  if (!trigger.temporary) return trigger.sql;

  const createTriggerPrefix = /^(\s*CREATE\s+)(?:(?:TEMP|TEMPORARY)\s+)?(TRIGGER\b)/i;
  if (!createTriggerPrefix.test(trigger.sql)) {
    throw new Error(
      `Unable to recreate temporary trigger ${trigger.identifier}: stored SQL is not a CREATE TRIGGER statement`
    );
  }
  // sqlite_temp_schema normally omits TEMP from its stored SQL, so restore the
  // schema qualifier explicitly instead of accidentally creating a main trigger.
  return trigger.sql.replace(createTriggerPrefix, '$1TEMP $2');
}

interface TriggerReferenceScope {
  parent?: number;
  aliases: Set<string>;
  hasAmbiguousSource: boolean;
}

interface TriggerReferenceScopeMap {
  scopes: TriggerReferenceScope[];
  tokenScopes: Array<number | undefined>;
  matchingParentheses: Map<number, number>;
}

const SOURCE_ALIAS_STOP_KEYWORDS = new Set([
  'AS', 'CROSS', 'END', 'EXCEPT', 'FULL', 'GROUP', 'HAVING', 'INDEXED',
  'INNER', 'INTERSECT', 'JOIN', 'LEFT', 'LIMIT', 'NATURAL', 'NOT', 'OFFSET',
  'ON', 'ORDER', 'OUTER', 'RETURNING', 'RIGHT', 'SET', 'UNION', 'USING',
  'VALUES', 'WHERE', 'WINDOW'
]);

const FROM_CLAUSE_END_KEYWORDS = new Set([
  'END', 'EXCEPT', 'GROUP', 'HAVING', 'INTERSECT', 'LIMIT', 'OFFSET', 'ON',
  'ORDER', 'RETURNING', 'SET', 'UNION', 'USING', 'VALUES', 'WHERE', 'WINDOW'
]);

function createTriggerReferenceScope(
  scopes: TriggerReferenceScope[],
  parent?: number
): number {
  scopes.push({ parent, aliases: new Set(), hasAmbiguousSource: false });
  return scopes.length - 1;
}

/** Assign every trigger expression token to a statement/parenthesis scope. */
function buildTriggerReferenceScopes(parsed: ParsedStoredTriggerSql): TriggerReferenceScopeMap {
  const { tokens, referenceStartIndex, bodyStartIndex } = parsed;
  const scopes: TriggerReferenceScope[] = [];
  const tokenScopes: Array<number | undefined> = new Array(tokens.length);
  const matchingParentheses = new Map<number, number>();
  const openParentheses: number[] = [];
  let scopeStack = [createTriggerReferenceScope(scopes)];
  let startNewStatement = false;

  for (let index = referenceStartIndex; index < tokens.length; index++) {
    if (index === bodyStartIndex || startNewStatement) {
      scopeStack = [createTriggerReferenceScope(scopes)];
      startNewStatement = false;
    }

    const token = tokens[index];
    tokenScopes[index] = scopeStack[scopeStack.length - 1];
    if (token.kind === 'symbol' && token.value === '(') {
      openParentheses.push(index);
      scopeStack.push(createTriggerReferenceScope(
        scopes,
        scopeStack[scopeStack.length - 1]
      ));
    } else if (token.kind === 'symbol' && token.value === ')') {
      const openIndex = openParentheses.pop();
      if (openIndex !== undefined) matchingParentheses.set(openIndex, index);
      if (scopeStack.length > 1) scopeStack.pop();
    } else if (token.kind === 'symbol' && token.value === ';' && scopeStack.length === 1) {
      startNewStatement = true;
    }
  }

  return { scopes, tokenScopes, matchingParentheses };
}

function addRelevantSourceAlias(scope: TriggerReferenceScope, alias: string | undefined): void {
  if (alias && /^(?:NEW|OLD)$/i.test(alias)) {
    scope.aliases.add(foldSqlIdentifier(alias));
  }
}

/** Parse one FROM/JOIN source and register aliases that can shadow NEW or OLD. */
function registerTriggerSourceAlias(
  tokens: readonly SqlToken[],
  startIndex: number,
  scopeIndex: number,
  scopeMap: TriggerReferenceScopeMap
): number {
  const scope = scopeMap.scopes[scopeIndex];
  let index = startIndex;
  let sourceName: string | undefined;

  if (tokens[index]?.kind === 'symbol' && tokens[index].value === '(') {
    const closeIndex = scopeMap.matchingParentheses.get(index);
    if (closeIndex === undefined) {
      scope.hasAmbiguousSource = true;
      return index + 1;
    }
    index = closeIndex + 1;
  } else if (isSqlIdentifierToken(tokens[index])) {
    sourceName = tokens[index].value;
    index++;
    if (tokens[index]?.kind === 'symbol' && tokens[index].value === '.') {
      if (!isSqlIdentifierToken(tokens[index + 1])) {
        scope.hasAmbiguousSource = true;
        return index + 1;
      }
      sourceName = tokens[index + 1].value;
      index += 2;
    }
    if (tokens[index]?.kind === 'symbol' && tokens[index].value === '(') {
      const closeIndex = scopeMap.matchingParentheses.get(index);
      if (closeIndex === undefined) {
        scope.hasAmbiguousSource = true;
        return index + 1;
      }
      index = closeIndex + 1;
    }
  } else {
    scope.hasAmbiguousSource = true;
    return index + 1;
  }

  let alias: string | undefined;
  if (isSqlKeyword(tokens[index], 'AS')) {
    if (!isSqlIdentifierToken(tokens[index + 1])) {
      scope.hasAmbiguousSource = true;
      return index + 1;
    }
    alias = tokens[index + 1].value;
    index += 2;
  } else if (isSqlIdentifierToken(tokens[index])) {
    const candidate = tokens[index];
    const isClauseKeyword = candidate.kind === 'word'
      && SOURCE_ALIAS_STOP_KEYWORDS.has(candidate.value.toUpperCase());
    if (!isClauseKeyword) {
      alias = candidate.value;
      index++;
    }
  }

  // Once an alias is present SQLite hides the source's original name.
  addRelevantSourceAlias(scope, alias ?? sourceName);
  return index;
}

function collectTriggerSourceAliases(
  parsed: ParsedStoredTriggerSql,
  scopeMap: TriggerReferenceScopeMap
): void {
  const inFromClause = new Map<number, boolean>();
  for (let index = parsed.referenceStartIndex; index < parsed.tokens.length; index++) {
    const token = parsed.tokens[index];
    const scopeIndex = scopeMap.tokenScopes[index];
    if (scopeIndex === undefined) continue;

    if (isSqlKeyword(token, 'FROM') || isSqlKeyword(token, 'JOIN')) {
      inFromClause.set(scopeIndex, true);
      registerTriggerSourceAlias(parsed.tokens, index + 1, scopeIndex, scopeMap);
      continue;
    }
    if (token.kind === 'word' && FROM_CLAUSE_END_KEYWORDS.has(token.value.toUpperCase())) {
      inFromClause.set(scopeIndex, false);
      continue;
    }
    if (token.kind === 'symbol' && token.value === ',' && inFromClause.get(scopeIndex)) {
      registerTriggerSourceAlias(parsed.tokens, index + 1, scopeIndex, scopeMap);
    }
  }
}

function triggerQualifierResolvesToAlias(
  qualifier: string,
  scopeIndex: number | undefined,
  scopes: readonly TriggerReferenceScope[]
): boolean {
  const foldedQualifier = foldSqlIdentifier(qualifier);
  while (scopeIndex !== undefined) {
    const scope = scopes[scopeIndex];
    if (scope.aliases.has(foldedQualifier)) return true;
    // This validation exists to prevent known-broken trigger replay, not to
    // implement SQLite's entire name resolver. If a valid source form is not
    // understood, accepting it avoids blocking a legitimate edit; SQLite still
    // validates the stored trigger SQL and remains the final arbiter at fire time.
    if (scope.hasAmbiguousSource) return true;
    scopeIndex = scope.parent;
  }
  return false;
}

function throwMissingTriggerColumn(
  trigger: ViewTriggerDefinition,
  column: string,
  reference: string
): never {
  throw new Error(
    `Preserved trigger "${trigger.identifier}" references missing view column ` +
    `"${column}" via ${reference}`
  );
}

/**
 * Reject preserved triggers that would become unusable after a view edit.
 * SQLite accepts unresolved NEW/OLD columns in CREATE TRIGGER and defers the
 * error until DML fires, so the edit path must compare these references with
 * the replacement view's actual schema before releasing its savepoint.
 */
export function assertViewTriggersCompatibleWithColumns(
  triggers: readonly ViewTriggerDefinition[],
  columns: readonly string[]
): void {
  const availableColumns = new Set(columns.map(foldSqlIdentifier));
  const intrinsicPseudoRowColumns = new Set(['rowid', '_rowid_', 'oid']);

  for (const trigger of triggers) {
    const parsed = parseStoredTriggerSql(trigger.sql);
    for (const column of parsed.updateOfColumns) {
      if (!availableColumns.has(foldSqlIdentifier(column.value))) {
        throwMissingTriggerColumn(trigger, column.value, `UPDATE OF ${column.value}`);
      }
    }

    const scopeMap = buildTriggerReferenceScopes(parsed);
    collectTriggerSourceAliases(parsed, scopeMap);
    for (let index = parsed.referenceStartIndex; index + 2 < parsed.tokens.length; index++) {
      const tokens = parsed.tokens;
      const qualifier = tokens[index];
      const separator = tokens[index + 1];
      const column = tokens[index + 2];
      if (!isSqlIdentifierToken(qualifier)
          || !/^(?:NEW|OLD)$/i.test(qualifier.value)
          || tokens[index - 1]?.value === '.'
          || separator.kind !== 'symbol'
          || separator.value !== '.'
          || !isSqlIdentifierToken(column)) {
        continue;
      }
      if (triggerQualifierResolvesToAlias(
        qualifier.value,
        scopeMap.tokenScopes[index],
        scopeMap.scopes
      )) {
        continue;
      }
      const foldedColumn = foldSqlIdentifier(column.value);
      // SQLite accepts intrinsic rowid aliases on NEW/OLD pseudo-rows even
      // when they are not projected view columns. Keep UPDATE OF strict: its
      // identifiers are event columns, not pseudo-row references.
      if (intrinsicPseudoRowColumns.has(foldedColumn)) {
        continue;
      }
      if (!availableColumns.has(foldedColumn)) {
        throwMissingTriggerColumn(
          trigger,
          column.value,
          `${qualifier.value.toUpperCase()}.${column.value}`
        );
      }
    }
  }
}

/** Enforce create/edit intent against SQLite's currently installed schema. */
export function assertViewDefinitionIntent(
  view: string,
  viewExists: boolean,
  intent: ViewDefinitionIntent
): void {
  if (intent !== 'create' && intent !== 'edit') {
    throw new Error(`Invalid view definition intent: ${String(intent)}`);
  }
  if (intent === 'create' && viewExists) {
    throw new Error(`View already exists: ${view}`);
  }
  if (intent === 'edit' && !viewExists) {
    throw new Error(`View no longer exists: ${view}`);
  }
}

/** Compare the exact stored CREATE VIEW SQL used by editor conflict checks. */
export function isViewDefinitionSnapshotCurrent(
  snapshotSql: string | undefined,
  currentSql: string | undefined
): boolean {
  return snapshotSql === currentSql;
}

/** Compare an ordered trigger snapshot, including temp-schema provenance. */
export function isViewTriggerSnapshotCurrent(
  snapshot: readonly ViewTriggerDefinition[] | undefined,
  current: readonly ViewTriggerDefinition[] | undefined
): boolean {
  if (snapshot === undefined) return true;
  if (current === undefined || snapshot.length !== current.length) return false;
  return snapshot.every((trigger, index) => {
    const currentTrigger = current[index];
    return trigger.identifier === currentTrigger.identifier
      && trigger.sql === currentTrigger.sql
      && (trigger.temporary === true) === (currentTrigger.temporary === true);
  });
}

/** Stable cross-RPC error text used by both view-editor conflict surfaces. */
export const VIEW_DEFINITION_CONFLICT_MESSAGE =
  'The view changed outside this editor. Reload before saving; the view was not modified.';

/**
 * Enforce an optional compare-and-swap precondition for a stored CREATE VIEW.
 * Undefined means a legacy caller did not load a snapshot. Editor saves and
 * history replay supply the exact sqlite_schema.sql value and trigger set.
 */
export function assertViewDefinitionSnapshotCurrent(
  expectedSql: string | undefined,
  currentSql: string | undefined,
  expectedTriggers?: readonly ViewTriggerDefinition[],
  currentTriggers?: readonly ViewTriggerDefinition[]
): void {
  if ((expectedSql !== undefined && !isViewDefinitionSnapshotCurrent(expectedSql, currentSql))
      || !isViewTriggerSnapshotCurrent(expectedTriggers, currentTriggers)) {
    throw new Error(VIEW_DEFINITION_CONFLICT_MESSAGE);
  }
}

/** Compare a complete installed view state, including the meaningful absence state. */
export function assertViewDefinitionStateCurrent(
  expected: ViewDefinition | null,
  current: ViewDefinition | null
): void {
  if (expected === null || current === null) {
    if (expected !== current) throw new Error(VIEW_DEFINITION_CONFLICT_MESSAGE);
    return;
  }
  assertViewDefinitionSnapshotCurrent(
    expected.sql,
    current.sql,
    expected.triggers,
    current.triggers
  );
}

/** Recognize the stable conflict after it crosses worker/webview RPC boundaries. */
export function isViewDefinitionConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(VIEW_DEFINITION_CONFLICT_MESSAGE)
    || /\b(?:the|this) view changed outside this editor\b.*\bnot modified\b/i.test(message);
}
