/**
 * `core/native/sqlite-errors.js` — recovering a usable diagnosis from the
 * fork's nonspecific SQLite errors.
 *
 * The capstone's error-quality finding: `tjs:sqlite` raises
 * `sqlite3_errstr(rc)` and never `sqlite3_errmsg(db)`, so a missing table, a
 * missing column, a bad function arity and a syntax error are all "SQL logic
 * error". The module's contract is that it improves that WITHOUT inventing —
 * every assertion below is either about the honesty gate (only rewrite text the
 * engine demonstrably contributed nothing to) or about a missing name being
 * PROVEN by SQLite rather than guessed from the SQL.
 */
import './vscode_mock_setup';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildSqliteErrorMessage,
    describeResultCode,
    extractTableReferences,
    findUnresolvedTableNames,
    hasOnlyCanonicalText,
    scanSqlWords
} from '../../core/native/sqlite-errors.js';

/** A catalog where only the listed names exist, and only they compile. */
function probeFor(existing: readonly string[], catalogOnly: readonly string[] = []) {
    return {
        resolves: (name: string) => existing.includes(name),
        inCatalog: (name: string) => existing.includes(name) || catalogOnly.includes(name)
    };
}

describe('result-code classification', () => {
    it('maps the codes the fork actually produces to their canonical text', () => {
        assert.equal(describeResultCode(1)?.name, 'SQLITE_ERROR');
        assert.equal(describeResultCode(1)?.text, 'SQL logic error');
        assert.equal(describeResultCode(19)?.name, 'SQLITE_CONSTRAINT');
        assert.equal(describeResultCode(19)?.text, 'constraint failed');
        assert.equal(describeResultCode(8)?.text, 'attempt to write a readonly database');
        assert.equal(describeResultCode(9)?.text, 'interrupted');
        assert.equal(describeResultCode(26)?.text, 'file is not a database');
        assert.equal(describeResultCode(999), undefined);
    });

    it('recognises the canonical text as "the engine said nothing"', () => {
        assert.equal(hasOnlyCanonicalText('SQL logic error', 1), true);
        assert.equal(hasOnlyCanonicalText('  SQL logic error  ', 1), true);
        // A binding that DOES report detail must pass through untouched — this
        // is what keeps the node:sqlite stand-in and any future fork rebuild
        // from having their good messages overwritten.
        assert.equal(hasOnlyCanonicalText('no such table: absent', 1), false);
        assert.equal(hasOnlyCanonicalText('NOT NULL constraint failed: t.c', 19), false);
        // Right text, wrong code.
        assert.equal(hasOnlyCanonicalText('SQL logic error', 19), false);
        assert.equal(hasOnlyCanonicalText('SQL logic error', 999), false);
    });

    it('adds the class, and only to a message the engine left generic', () => {
        assert.match(
            buildSqliteErrorMessage(19, 'constraint failed', undefined, undefined)!,
            /constraint failed \(SQLITE_CONSTRAINT: .*NOT NULL, UNIQUE, CHECK/
        );
        assert.equal(
            buildSqliteErrorMessage(19, 'NOT NULL constraint failed: t.c', undefined, undefined),
            undefined
        );
        assert.equal(buildSqliteErrorMessage(999, 'boom', undefined, undefined), undefined);
        // Codes whose errstr entry says it all get the name, not a lecture.
        assert.equal(
            buildSqliteErrorMessage(8, 'attempt to write a readonly database', undefined, undefined),
            'attempt to write a readonly database (SQLITE_READONLY)'
        );
    });
});

describe('table-reference extraction', () => {
    it('keeps quoted text and comments opaque', () => {
        const tokens = scanSqlWords("SELECT 'from nope' /* from nope */ -- from nope\n FROM users");
        assert.deepEqual(
            tokens.filter(token => token.kind === 'word').map(token => token.value),
            ['SELECT', 'FROM', 'users']
        );
        assert.deepEqual(extractTableReferences("SELECT 'from nope' FROM users"), ['users']);
    });

    it('reads every table position it is sure about', () => {
        assert.deepEqual(extractTableReferences('SELECT * FROM a JOIN b ON 1'), ['a', 'b']);
        assert.deepEqual(extractTableReferences('INSERT INTO t VALUES (1)'), ['t']);
        assert.deepEqual(extractTableReferences('UPDATE t SET a = 1'), ['t']);
        assert.deepEqual(extractTableReferences('DELETE FROM t WHERE 1'), ['t']);
        assert.deepEqual(extractTableReferences('SELECT * FROM "odd name"'), ['odd name']);
        // schema.table — only main/temp can exist, and the bare name resolves.
        assert.deepEqual(extractTableReferences('SELECT * FROM main.users'), ['users']);
    });

    it('declines every position it cannot be sure about', () => {
        // DDL: `CREATE TABLE t` names a table that SHOULD NOT exist yet.
        assert.equal(extractTableReferences('CREATE TABLE t (a)'), null);
        assert.equal(extractTableReferences('DROP TABLE t'), null);
        assert.equal(extractTableReferences('ALTER TABLE t DROP COLUMN a'), null);
        assert.equal(extractTableReferences('PRAGMA table_info(t)'), null);
        // A CTE name is in no catalog and looks exactly like a missing table.
        assert.equal(extractTableReferences('WITH t AS (SELECT 1) SELECT * FROM t'), null);
        // Subqueries and table-valued functions are not names.
        assert.deepEqual(extractTableReferences('SELECT * FROM (SELECT 1)'), []);
        assert.deepEqual(extractTableReferences("SELECT * FROM pragma_table_info('t')"), []);
        assert.deepEqual(extractTableReferences('SELECT * FROM json_each(?)'), []);
    });

    it('reads through an EXPLAIN wrapper, because that is how views are validated', () => {
        // G-1. createView / editView / validateViewDefinition /
        // previewViewDefinition all compile `EXPLAIN SELECT * FROM (body)
        // LIMIT 0` — so before this, EVERY view-editor failure on the native
        // engine lost its message ("SQL logic error … cannot report SQLite's
        // detailed message") while the identical body named the table through
        // runQuery.
        assert.deepEqual(extractTableReferences('EXPLAIN SELECT * FROM users'), ['users']);
        assert.deepEqual(extractTableReferences('explain select * from users'), ['users']);
        assert.deepEqual(
            extractTableReferences('EXPLAIN QUERY PLAN SELECT * FROM users'),
            ['users']
        );
        // The exact statement the view editor compiles.
        assert.deepEqual(
            extractTableReferences('EXPLAIN SELECT * FROM (SELECT * FROM absent\n) LIMIT 0'),
            ['absent']
        );
        // Every guard still applies to the WRAPPED statement.
        assert.equal(extractTableReferences('EXPLAIN CREATE TABLE t (a)'), null);
        assert.equal(
            extractTableReferences('EXPLAIN WITH t AS (SELECT 1) SELECT * FROM t'),
            null
        );
        // `explain` is only a prefix as the FIRST word: a column of that name
        // must not shift the statement's reading.
        assert.deepEqual(extractTableReferences('SELECT explain FROM users'), ['users']);
        // A lone `QUERY` after EXPLAIN is not the `QUERY PLAN` prefix, so only
        // one word is skipped and the operand is judged as it stands.
        assert.equal(extractTableReferences('EXPLAIN QUERY'), null);
    });
});

describe('missing-table proof', () => {
    it('needs BOTH halves before it accuses a name', () => {
        // Resolves: not missing, whatever the catalog says. This is the system
        // tables and eponymous virtual tables (sqlite_schema, pragma_table_list)
        // — real names with no catalog row.
        assert.deepEqual(findUnresolvedTableNames(['sqlite_schema'], {
            resolves: () => true,
            inCatalog: () => false
        }), []);
        // In the catalog: not missing, even though it will not compile. This is
        // a VIEW whose base table was dropped — which this app can do — and
        // blaming it as a missing table would be flatly wrong.
        assert.deepEqual(findUnresolvedTableNames(['broken_view'], {
            resolves: () => false,
            inCatalog: () => true
        }), []);
        // Neither: genuinely missing.
        assert.deepEqual(findUnresolvedTableNames(['absent'], {
            resolves: () => false,
            inCatalog: () => false
        }), ['absent']);
    });

    it('walks into a broken view to name the table it lost, when the probe can read definitions', () => {
        // The view editor validates through the INSTALLED view since 1.7.2, so
        // the failing statement names only the view — in the catalog, hence
        // never accused on its own. With the stored definition available the
        // proof follows the body to the table that is actually missing.
        const definitions: Record<string, string> = {
            broken_view: 'CREATE VIEW broken_view AS SELECT * FROM definitely_absent',
            outer_view: 'CREATE VIEW outer_view(a) AS SELECT a FROM broken_view',
            cte_view: 'CREATE VIEW cte_view AS WITH x AS (SELECT 1) SELECT * FROM x',
            self_view: 'CREATE VIEW self_view AS SELECT * FROM self_view'
        };
        const probe = {
            resolves: (name: string) => name === 'users',
            inCatalog: (name: string) => name === 'users' || name in definitions,
            viewSql: (name: string) => definitions[name]
        };
        assert.deepEqual(findUnresolvedTableNames(['broken_view'], probe), ['definitely_absent']);
        // Views over views: the walk recurses through the column-listed view.
        assert.deepEqual(findUnresolvedTableNames(['outer_view'], probe), ['definitely_absent']);
        assert.equal(
            buildSqliteErrorMessage(1, 'SQL logic error', 'EXPLAIN SELECT * FROM main."broken_view"', probe),
            'no such table: definitely_absent'
        );
        // A CTE body is not reasoned about (a CTE name is not in any catalog),
        // and a self-referential definition terminates through the visited set.
        assert.deepEqual(findUnresolvedTableNames(['cte_view'], probe), []);
        assert.deepEqual(findUnresolvedTableNames(['self_view'], probe), []);
        // Without a definition reader the old veto still holds: nothing is said.
        assert.deepEqual(findUnresolvedTableNames(['broken_view'], probeFor([], ['broken_view'])), []);
    });

    it('reports a proven missing table in SQLite\'s own words', () => {
        assert.equal(
            buildSqliteErrorMessage(1, 'SQL logic error', 'SELECT * FROM absent', probeFor([])),
            'no such table: absent'
        );
        assert.equal(
            buildSqliteErrorMessage(
                1,
                'SQL logic error',
                'SELECT * FROM a JOIN b ON 1',
                probeFor(['a'])
            ),
            'no such table: b'
        );
    });

    it('falls back to the class when nothing can be proven', () => {
        // A missing COLUMN: every table resolves, so no name is accused and the
        // user is told the class plus WHY the engine cannot say more.
        const message = buildSqliteErrorMessage(
            1,
            'SQL logic error',
            'SELECT nope FROM users',
            probeFor(['users'])
        )!;
        assert.match(message, /^SQL logic error \(SQLITE_ERROR: /);
        assert.match(message, /native engine cannot report/);
        // A CTE query, a broken view, and a DDL statement all decline the proof.
        for (const sql of [
            'WITH t AS (SELECT 1) SELECT * FROM t',
            'ALTER TABLE users DROP COLUMN id',
            "SELECT 'from absent_table' FROM users"
        ]) {
            assert.match(
                buildSqliteErrorMessage(1, 'SQL logic error', sql, probeFor(['users']))!,
                /^SQL logic error \(SQLITE_ERROR: /,
                sql
            );
        }
    });

    it('never lets the probe escalate a failure', () => {
        const exploding = {
            resolves: () => { throw new Error('probe exploded'); },
            inCatalog: () => true
        };
        assert.throws(
            () => buildSqliteErrorMessage(1, 'SQL logic error', 'SELECT * FROM a', exploding),
            /probe exploded/
        );
        // …which is why the shim wraps the whole describe call in a try/catch
        // (describeBackingError) and returns the ORIGINAL error on any throw.
    });
});
