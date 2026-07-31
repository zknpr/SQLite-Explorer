import { escapeIdentifier } from './sql-utils';
import type { ViewTriggerDefinition } from './types';

/**
 * Remove one optional statement terminator from an editable SELECT body.
 * SQLite still performs the actual syntax and semantic validation.
 */
export function normalizeViewSelectSql(selectSql: string): string {
  const trimmed = selectSql.trim();
  if (!trimmed) {
    throw new Error('View SELECT definition is required');
  }
  return trimmed.endsWith(';') ? trimmed.slice(0, -1).trimEnd() : trimmed;
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

/** Compare the exact stored CREATE VIEW SQL used by editor conflict checks. */
export function isViewDefinitionSnapshotCurrent(
  snapshotSql: string | undefined,
  currentSql: string | undefined
): boolean {
  return snapshotSql === currentSql;
}
