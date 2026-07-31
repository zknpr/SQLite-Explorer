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
  hasExplicitColumnList: boolean;
}

/** Locate the declaration's top-level AS without treating quoted text as SQL structure. */
function locateViewSqlParts(createSql: string): ViewSqlParts {
  let depth = 0;
  let index = 0;
  let hasExplicitColumnList = false;

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
      if (depth === 0) hasExplicitColumnList = true;
      depth++;
      index++;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      index++;
      continue;
    }
    if (depth === 0 && /[A-Za-z_]/.test(char)) {
      const tokenStart = index;
      index++;
      while (index < createSql.length && /[A-Za-z0-9_$]/.test(createSql[index])) index++;
      if (createSql.slice(tokenStart, index).toUpperCase() === 'AS') {
        return { selectStart: index, hasExplicitColumnList };
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

/** Whether the stored declaration pins view output names with `(column, ...)`. */
export function hasExplicitViewColumnList(createSql: string): boolean {
  return locateViewSqlParts(createSql).hasExplicitColumnList;
}
