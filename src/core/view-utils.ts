import { escapeIdentifier } from './sql-utils';
import type { CellValue, ViewDefinitionIntent, ViewTriggerDefinition } from './types';

/** Canonical trigger sources, ordered by the schema in which they are replayed. */
export const VIEW_TRIGGER_SCHEMA_QUERIES = [
  {
    sql: "SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE ORDER BY rowid",
    temporary: false
  },
  {
    sql: "SELECT name, sql FROM sqlite_temp_schema WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE ORDER BY rowid",
    temporary: true
  }
] as const;

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
    rowsBySchema[index].map(row => {
      if (typeof row[0] !== 'string' || typeof row[1] !== 'string') {
        throw new Error(`View trigger definition is unavailable for ${view}`);
      }
      return source.temporary
        ? { identifier: row[0], sql: row[1], temporary: true }
        : { identifier: row[0], sql: row[1] };
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
  let index = 0;
  let columnListStart = -1;
  let columnListEnd = -1;

  while (index < createSql.length) {
    const char = createSql[index];
    const next = createSql[index + 1];

    if (char === '-' && next === '-') {
      index += 2;
      while (index < createSql.length && createSql[index] !== '\n') index++;
      continue;
    }
    if (char === '/' && next === '*') {
      const commentEnd = createSql.indexOf('*/', index + 2);
      if (commentEnd === -1) break;
      index = commentEnd + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      index++;
      while (index < createSql.length) {
        if (createSql[index] === quote) {
          if (createSql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index++;
          break;
        }
        index++;
      }
      continue;
    }
    if (char === '[') {
      index++;
      while (index < createSql.length) {
        if (createSql[index] === ']') {
          if (createSql[index + 1] === ']') {
            index += 2;
            continue;
          }
          index++;
          break;
        }
        index++;
      }
      continue;
    }
    if (char === '(') {
      if (depth === 0 && columnListStart === -1) columnListStart = index;
      depth++;
      index++;
      continue;
    }
    if (char === ')') {
      if (depth === 1 && columnListStart !== -1 && columnListEnd === -1) {
        columnListEnd = index + 1;
      }
      depth = Math.max(0, depth - 1);
      index++;
      continue;
    }
    if (depth === 0 && /[A-Za-z_]/.test(char)) {
      const tokenStart = index;
      index++;
      while (index < createSql.length && /[A-Za-z0-9_$]/.test(createSql[index])) index++;
      if (createSql.slice(tokenStart, index).toUpperCase() === 'AS') {
        return {
          selectStart: index,
          columnListSql: columnListStart !== -1 && columnListEnd !== -1
            ? createSql.slice(columnListStart, columnListEnd)
            : undefined
        };
      }
      continue;
    }

    index++;
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
 * Undefined means the caller did not load a snapshot (undo/redo and legacy RPC
 * callers); editor saves always supply the exact sqlite_schema.sql value.
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

/** Recognize the stable conflict after it crosses worker/webview RPC boundaries. */
export function isViewDefinitionConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(VIEW_DEFINITION_CONFLICT_MESSAGE)
    || /\b(?:the|this) view changed outside this editor\b.*\bnot modified\b/i.test(message);
}
