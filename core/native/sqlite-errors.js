/**
 * Turn the fork's nonspecific SQLite errors into something a user can act on.
 *
 * THE PROBLEM. `tjs:sqlite` raises `sqlite3_errstr(rc)` and never
 * `sqlite3_errmsg(db)`, so on the native engine a missing table, a missing
 * column, a bad function arity and a syntax error are ALL "SQL logic error"
 * (probed against the shipped binary; sql.js says "no such table: x",
 * "no such column: x", "incomplete input"). For a SQL console that is the
 * difference between a diagnosable typo and a dead end. `sqlite3_errmsg` cannot
 * be reached from JS without rebuilding the fork, so this module recovers what
 * SQLite WILL still tell us and never guesses beyond it:
 *
 *   1. The primary result code (the one thing the fork does expose, on a
 *      non-enumerable `err.errno`) is expanded into its symbolic name plus a
 *      short factual clause about what the class covers.
 *   2. For the ambiguous SQLITE_ERROR class, a missing table is PROVEN rather
 *      than guessed: every table position in the failing statement is put back
 *      to SQLite as a compile-only `SELECT 1 FROM "name" WHERE 0` probe, and a
 *      name is reported missing only when that probe fails AND the name is
 *      absent from both catalogs. Both halves are needed — see `probe`.
 *
 * NOTHING here invents an error SQLite did not produce: the message is only
 * ever extended when it is byte-identical to the canonical `sqlite3_errstr`
 * text for its own result code, i.e. when the engine demonstrably gave us no
 * detail of its own.
 *
 * PLAIN JS ON PURPOSE. `core/native/sqljs-shim.js` is loaded RAW by the native
 * lane harness (`tjs run scripts/lib/native-lane-harness.mjs`), which has no
 * TypeScript loader, so neither it nor anything it imports may reach into
 * `src/core/*.ts`. That is why the small SQL scanner below is here instead of
 * reusing view-utils.ts's `scanSqlTokens`.
 */

/**
 * SQLite primary result codes: symbolic name, the exact text `sqlite3_errstr`
 * returns for the code (the gate — see `hasOnlyCanonicalText`), and a factual
 * clause naming what the class covers.
 *
 * Codes whose `sqlite3_errstr` entry is NULL render as "unknown error" and are
 * deliberately absent: there is nothing to gate on.
 */
export const SQLITE_RESULT_CODES = Object.freeze({
    1: {
        name: 'SQLITE_ERROR',
        text: 'SQL logic error',
        // Says WHY it is vague. Without the second clause a user reads the
        // shrug as the app's, not the engine's, and goes looking for a bug.
        detail: 'a misspelled name, a syntax error, or a misused construct — the native '
            + 'engine cannot report SQLite’s detailed message'
    },
    3: { name: 'SQLITE_PERM', text: 'access permission denied', detail: '' },
    4: { name: 'SQLITE_ABORT', text: 'query aborted', detail: 'the statement was rolled back before it finished' },
    5: { name: 'SQLITE_BUSY', text: 'database is locked', detail: 'another connection holds a write lock on this file' },
    6: { name: 'SQLITE_LOCKED', text: 'database table is locked', detail: 'a table is locked by another statement on this same connection' },
    7: { name: 'SQLITE_NOMEM', text: 'out of memory', detail: '' },
    8: { name: 'SQLITE_READONLY', text: 'attempt to write a readonly database', detail: '' },
    9: { name: 'SQLITE_INTERRUPT', text: 'interrupted', detail: 'the query deadline elapsed or the run was cancelled' },
    10: { name: 'SQLITE_IOERR', text: 'disk I/O error', detail: '' },
    11: { name: 'SQLITE_CORRUPT', text: 'database disk image is malformed', detail: '' },
    12: { name: 'SQLITE_NOTFOUND', text: 'unknown operation', detail: '' },
    13: { name: 'SQLITE_FULL', text: 'database or disk is full', detail: '' },
    14: { name: 'SQLITE_CANTOPEN', text: 'unable to open database file', detail: '' },
    15: { name: 'SQLITE_PROTOCOL', text: 'locking protocol', detail: '' },
    17: { name: 'SQLITE_SCHEMA', text: 'database schema has changed', detail: '' },
    18: { name: 'SQLITE_TOOBIG', text: 'string or blob too big', detail: 'a value exceeded SQLite’s maximum length for this build' },
    19: {
        name: 'SQLITE_CONSTRAINT',
        text: 'constraint failed',
        detail: 'a NOT NULL, UNIQUE, CHECK, PRIMARY KEY or FOREIGN KEY constraint rejected the row'
    },
    20: {
        name: 'SQLITE_MISMATCH',
        text: 'datatype mismatch',
        detail: 'a value does not fit the target column (an INTEGER PRIMARY KEY only accepts integers)'
    },
    21: { name: 'SQLITE_MISUSE', text: 'bad parameter or other API misuse', detail: '' },
    23: { name: 'SQLITE_AUTH', text: 'authorization denied', detail: '' },
    25: { name: 'SQLITE_RANGE', text: 'column index out of range', detail: '' },
    26: { name: 'SQLITE_NOTADB', text: 'file is not a database', detail: '' }
});

/** The symbolic name and canonical text for a primary result code, if known. */
export function describeResultCode(errno) {
    return SQLITE_RESULT_CODES[errno];
}

/**
 * True when `message` is exactly the canonical `sqlite3_errstr` text for
 * `errno`, i.e. the engine contributed no detail of its own.
 *
 * This is the whole honesty gate: a binding that DOES surface
 * `sqlite3_errmsg` (a future fork rebuild, or the node:sqlite stand-in the unit
 * suite runs the shim over) produces a different string and is left untouched.
 */
export function hasOnlyCanonicalText(message, errno) {
    const described = SQLITE_RESULT_CODES[errno];
    return described !== undefined && String(message).trim() === described.text;
}

/** Statement leading keywords whose table positions are safe to probe. */
const PROBEABLE_LEADING_KEYWORDS = new Set(['SELECT', 'INSERT', 'REPLACE', 'UPDATE', 'DELETE', 'VALUES']);

/**
 * `EXPLAIN` / `EXPLAIN QUERY PLAN` is a compile-time wrapper around an ordinary
 * statement, and it is how the view editor asks SQLite whether a definition
 * compiles at all (`compileSingleStatement('EXPLAIN SELECT * FROM …')` in
 * createView / editView / validateViewDefinition / previewViewDefinition).
 *
 * Without this skip the wrapper made the operand unreadable to the probe, so on
 * the native engine EVERY view-editor failure — including the everyday typo —
 * came back as the nonspecific "SQL logic error (…the native engine cannot
 * report SQLite's detailed message)" while the identical body reported "no such
 * table: x" through runQuery. Skipping the prefix is safe in both directions:
 * `EXPLAIN <stmt>` fails at compile for exactly the reasons `<stmt>` does, and
 * the guards below still see the operand (`EXPLAIN CREATE TABLE t` still
 * returns null, because CREATE is not probeable).
 *
 * @param {Array<{kind: string, value: string}>} tokens
 * @returns {number} index of the first token of the wrapped statement
 */
function skipExplainPrefix(tokens) {
    const words = [];
    for (let index = 0; index < tokens.length && words.length < 3; index += 1) {
        if (tokens[index].kind === 'word') words.push({ index, value: tokens[index].value.toUpperCase() });
    }
    if (words[0]?.value !== 'EXPLAIN') return 0;
    // Only the complete `QUERY PLAN` pair is a prefix; a lone `QUERY` after
    // EXPLAIN is not valid grammar, so never guess past one word.
    if (words[1]?.value === 'QUERY' && words[2]?.value === 'PLAN') return words[2].index + 1;
    return words[0].index + 1;
}

/** Keywords after which the next bare word names a table. */
const TABLE_POSITION_KEYWORDS = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE']);

/** Never a table name, even in a table position. */
const NOT_A_TABLE_NAME = new Set(['SELECT', 'VALUES', 'WITH']);

/** SQLite's IdChar class: alphanumerics, `_`, `$`, and every code unit at or above 0x80. */
const SQL_WORD_CHARACTER = /[A-Za-z0-9_$\u0080-\uffff]/;

/** At most this many names are probed for one failure. */
const MAX_PROBED_TABLE_CANDIDATES = 4;

/**
 * Split SQL into bare words, quoted identifiers and single-character symbols,
 * skipping string literals and comments.
 *
 * Deliberately structural only: enough to tell `FROM users` from the text
 * `'from users'` inside a literal, which is exactly what stops the candidate
 * scan from blaming a name that is not a name at all.
 */
export function scanSqlWords(sql) {
    const tokens = [];
    let index = 0;
    while (index < sql.length) {
        const char = sql[index];
        if (/\s/.test(char)) { index += 1; continue; }
        if (char === '-' && sql[index + 1] === '-') {
            const lineEnd = sql.indexOf('\n', index);
            index = lineEnd < 0 ? sql.length : lineEnd + 1;
            continue;
        }
        if (char === '/' && sql[index + 1] === '*') {
            const blockEnd = sql.indexOf('*/', index + 2);
            index = blockEnd < 0 ? sql.length : blockEnd + 2;
            continue;
        }
        if (char === "'" || char === '"' || char === '`' || char === '[') {
            const closing = char === '[' ? ']' : char;
            // A single-quoted token is a VALUE, never an identifier, in every
            // position this module inspects.
            const kind = char === "'" ? 'string' : 'identifier';
            let value = '';
            index += 1;
            while (index < sql.length) {
                if (sql[index] === closing) {
                    if (sql[index + 1] === closing) { value += closing; index += 2; continue; }
                    index += 1;
                    break;
                }
                value += sql[index];
                index += 1;
            }
            tokens.push({ kind, value });
            continue;
        }
        if (SQL_WORD_CHARACTER.test(char)) {
            const start = index;
            index += 1;
            while (index < sql.length && SQL_WORD_CHARACTER.test(sql[index])) index += 1;
            tokens.push({ kind: 'word', value: sql.slice(start, index) });
            continue;
        }
        tokens.push({ kind: 'symbol', value: char });
        index += 1;
    }
    return tokens;
}

/**
 * Names in a table position in `sql`, or `null` when the statement is not one
 * this module is willing to reason about.
 *
 * A leading `EXPLAIN` / `EXPLAIN QUERY PLAN` is skipped first (see
 * `skipExplainPrefix`) and the wrapped statement is what the rules below judge.
 *
 * Returns null — never a guess — for:
 *   - DDL (`CREATE TABLE t` names a table that SHOULD NOT exist yet, so a
 *     "no such table" claim there would be exactly backwards);
 *   - anything containing a bare `WITH`, because a CTE name is not in any
 *     catalog and would look identical to a missing table;
 *   - a table position holding a subquery, a table-valued function call
 *     (`pragma_table_info(...)`, `json_each(...)`) or a keyword.
 */
export function extractTableReferences(sql) {
    const allTokens = scanSqlWords(sql);
    // The EXPLAIN wrapper is not part of the statement being reasoned about.
    const tokens = allTokens.slice(skipExplainPrefix(allTokens));
    const first = tokens.find(token => token.kind === 'word');
    if (!first || !PROBEABLE_LEADING_KEYWORDS.has(first.value.toUpperCase())) return null;
    if (tokens.some(token => token.kind === 'word' && token.value.toUpperCase() === 'WITH')) return null;

    const names = [];
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token.kind !== 'word' || !TABLE_POSITION_KEYWORDS.has(token.value.toUpperCase())) continue;
        let candidate = tokens[index + 1];
        let after = tokens[index + 2];
        if (!candidate) continue;
        // `schema.table`: only main/temp can exist (the shim blocks ATTACH), and
        // the unqualified name is what the probe below resolves.
        if (after?.kind === 'symbol' && after.value === '.' && tokens[index + 3]) {
            candidate = tokens[index + 3];
            after = tokens[index + 4];
        }
        if (candidate.kind === 'string' || candidate.kind === 'symbol') continue;
        if (candidate.kind === 'word' && NOT_A_TABLE_NAME.has(candidate.value.toUpperCase())) continue;
        // A following '(' makes this a table-valued function, not a table.
        if (after?.kind === 'symbol' && after.value === '(') continue;
        if (!names.includes(candidate.value)) names.push(candidate.value);
        if (names.length >= MAX_PROBED_TABLE_CANDIDATES) break;
    }
    return names;
}

/**
 * Ask SQLite which of `names` does not resolve as a table.
 *
 * `probe` supplies two independent answers and BOTH are required before a name
 * is reported missing:
 *   - `resolves(name)`: compiles (never steps) `SELECT 1 FROM "name" WHERE 0`.
 *     This is SQLite's own name resolution, so it accepts the system tables and
 *     eponymous virtual tables that no catalog row describes
 *     (`sqlite_schema`, `pragma_table_list`, …).
 *   - `inCatalog(name)`: a row in `sqlite_schema` or `sqlite_temp_schema`. This
 *     is what keeps a view whose BODY is broken (its base table was dropped —
 *     which this very app can do) from being reported as a missing table: the
 *     compile probe fails for it, but the name is right there in the catalog.
 */
export function findUnresolvedTableNames(names, probe) {
    const missing = [];
    for (const name of names) {
        if (probe.resolves(name)) continue;
        if (probe.inCatalog(name)) continue;
        missing.push(name);
    }
    return missing;
}

/**
 * Build the enriched message for a nonspecific engine error, or `undefined`
 * when there is nothing honest to add.
 *
 * @param {number} errno primary SQLite result code
 * @param {string} message the engine's own message
 * @param {string|undefined} sql the failing statement's source text
 * @param {{resolves(name: string): boolean, inCatalog(name: string): boolean}|undefined} probe
 */
export function buildSqliteErrorMessage(errno, message, sql, probe) {
    if (!hasOnlyCanonicalText(message, errno)) return undefined;
    const described = SQLITE_RESULT_CODES[errno];

    if (errno === 1 && sql && probe) {
        const names = extractTableReferences(sql);
        if (names && names.length > 0) {
            const missing = findUnresolvedTableNames(names, probe);
            if (missing.length > 0) {
                // SQLite's own phrasing for exactly this condition, so the two
                // engines report a missing table identically.
                return missing.map(name => `no such table: ${name}`).join('; ');
            }
        }
    }

    const suffix = described.detail ? `: ${described.detail}` : '';
    return `${described.text} (${described.name}${suffix})`;
}
