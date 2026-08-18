/**
 * The fixture matrix shared by both halves of the native lane.
 *
 * `scripts/native-lane.mjs` (node) runs these against the real vendored sql.js
 * `Database`; `scripts/lib/native-lane-harness.mjs` runs the identical
 * functions inside the real tjs binary against `core/native/sqljs-shim.js` over
 * real `tjs:sqlite`. Both sides normalise through `normalize()` and hand back
 * plain JSON, so any behavioural drift between the fork and sql.js shows up as
 * a diff rather than as a subtly wrong grid.
 *
 * Every fixture must stay inside the surface BOTH engines expose (the sql.js
 * `Database` API). Fork-only behaviour lives in the harness's own section.
 */

export const SEED_SQL = `
CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, data BLOB, amount REAL);
INSERT INTO t VALUES
  (1, 'alpha', x'0102ff', 1.5),
  (2, NULL, NULL, -0.25),
  (9007199254740993, 'big', x'', 0.0);
CREATE TABLE u(a INTEGER UNIQUE, b TEXT NOT NULL);
INSERT INTO u VALUES (1, 'x');
`;

/**
 * Collapse engine-specific value encodings to a comparable, JSON-safe form.
 *
 * BigInt below 2^53 becomes Number because sql.js's `useBigInt` returns BigInt
 * for every integer while the fork only crosses at 2^53 (probed, exact) — the
 * worker's own `normalizeIntegerRowsForTransport` erases that difference
 * downstream. Anything beyond the safe range is compared as exact decimal text,
 * which is the property that actually has to hold.
 */
export function normalize(value) {
    if (typeof value === 'bigint') {
        return Number.isSafeInteger(Number(value)) ? Number(value) : `int64:${value}`;
    }
    if (value instanceof Uint8Array) return { blob: Array.from(value) };
    if (Array.isArray(value)) return value.map(normalize);
    if (value !== null && typeof value === 'object') {
        const out = {};
        for (const [key, entry] of Object.entries(value)) out[key] = normalize(entry);
        return out;
    }
    if (typeof value === 'function') return '[function]';
    return value;
}

/** Walk an iterator exactly as worker.js's console does. */
function walkStatements(sql) {
    return (db) => {
        const iterator = db.iterateStatements(sql);
        const steps = [];
        try {
            for (;;) {
                const step = iterator.next();
                // The post-completion tail is engine-specific (sql.js reads a
                // freed pointer); the tail after each YIELDED statement is the
                // value the console consumes, and that is compared.
                if (step.done) {
                    steps.push({ done: true });
                    break;
                }
                steps.push({
                    sql: step.value.getSQL(),
                    columns: step.value.getColumnNames(),
                    remaining: iterator.getRemainingSQL()
                });
                step.value.free();
            }
        } catch (error) {
            steps.push({ threw: true, remaining: iterator.getRemainingSQL() });
        }
        return steps;
    };
}

export const FIXTURES = [
    ['exec/multi-statement', db => db.exec('SELECT 1 AS a; SELECT 2 AS b')],
    ['exec/dml-only', db => db.exec("INSERT INTO t VALUES(4,'four',NULL,1.0)")],
    ['exec/zero-rows', db => db.exec('SELECT id FROM t WHERE 0')],
    ['exec/unaliased-column', db => db.exec('SELECT 1')],
    ['exec/trivia-only', db => db.exec('  -- nothing at all\n')],
    ['exec/empty', db => db.exec('')],
    ['exec/empty-statement-between', db => db.exec('SELECT 1 AS a;; SELECT 2 AS b')],
    ['exec/leading-semicolon', db => db.exec('; SELECT 1 AS a')],
    ['exec/pragma', db => db.exec('PRAGMA schema_version')],
    ['exec/positional-params', db => db.exec('SELECT ? AS p, ? AS q', [7, 'seven'])],
    ['exec/named-params', db => db.exec('SELECT :x AS p', { ':x': 5 })],
    // Parameterised queries that read a REAL TABLE. The original matrix was all
    // FROM-less SELECTs, which is exactly why a zero-row parameterised table
    // query returning no column names went unnoticed.
    ['exec/params-table-zero-rows',
        db => db.exec('SELECT id AS alpha, name AS beta FROM t WHERE name LIKE ?', ['no-match-%'])],
    ['exec/params-table-with-rows',
        db => db.exec('SELECT id AS alpha, name AS beta FROM t WHERE name LIKE ?', ['alpha'])],
    ['exec/values', db => db.exec('SELECT id, name, data, amount FROM t ORDER BY id')],
    ['exec/int64-useBigInt', db => db.exec('SELECT id FROM t ORDER BY id', null, { useBigInt: true })],
    ['exec/int64-lossy', db => db.exec('SELECT id FROM t ORDER BY id')],
    ['exec/empty-blob', db => db.exec("SELECT x'' AS empty_blob")],
    ['exec/semicolon-in-literal', db => db.exec("SELECT ';' AS semi; SELECT 2 AS after")],
    ['exec/semicolon-in-comment', db => db.exec('SELECT 1 AS a /* ; */ ; SELECT 2 AS b')],

    // Duplicate result names: sql.js reads sqlite3_column_name positionally and
    // repeats `id`, the shim recovers SQLite's own disambiguated `id:1`. The
    // header TEXT is a documented divergence; the ARITY and the VALUES are not,
    // and `exec` used to silently drop one of each (capstone E-4).
    ['exec/duplicate-result-columns-keep-every-value', db => {
        db.run(
            'CREATE TABLE dup_parent(id INTEGER PRIMARY KEY, label TEXT);'
            + 'CREATE TABLE dup_child(id INTEGER PRIMARY KEY, parent_id INTEGER, note TEXT);'
            + "INSERT INTO dup_parent VALUES (1,'p1'); INSERT INTO dup_child VALUES (7,1,'c1')"
        );
        const [result] = db.exec(
            'SELECT * FROM dup_parent JOIN dup_child ON dup_child.parent_id = dup_parent.id'
        );
        return { columnCount: result.columns.length, values: result.values };
    }],
    ['exec/duplicate-aliases-keep-every-value', db => {
        const [result] = db.exec('SELECT 1 AS x, 2 AS x');
        return { columnCount: result.columns.length, values: result.values };
    }],
    // The duplicate repair re-reads the rows through a TEMP VIEW. That extra
    // read must not disturb the change counter worker.js reads right after
    // every mutation.
    ['changes/duplicate-column-exec-does-not-reset', db => {
        db.run('UPDATE t SET name = name');
        db.exec('SELECT 1 AS x, 2 AS x');
        return db.getRowsModified();
    }],

    ['changes/after-insert', db => {
        db.run("INSERT INTO t VALUES(10,'ten',NULL,0.5)");
        return db.getRowsModified();
    }],
    ['changes/after-parameterised-insert', db => {
        db.run('INSERT INTO t VALUES(?,?,?,?)', [11, 'eleven', null, 0.5]);
        return db.getRowsModified();
    }],
    ['changes/multi-row-update', db => {
        db.run('UPDATE t SET name = name');
        return db.getRowsModified();
    }],
    ['changes/select-does-not-reset', db => {
        db.run('UPDATE t SET name = name');
        db.exec('SELECT 1');
        return db.getRowsModified();
    }],
    ['run/multi-statement-script', db => {
        db.run("INSERT INTO t VALUES(20,'a',NULL,0); INSERT INTO t VALUES(21,'b',NULL,0)");
        return db.exec('SELECT count(*) AS c FROM t WHERE id >= 20');
    }],
    ['run/returns-database', db => db.run('SELECT 1') === db],

    ['prepare/getSQL-first-statement', db => {
        const s = db.prepare('SELECT 1 AS a; SELECT 2 AS b');
        const sql = s.getSQL();
        s.free();
        return sql;
    }],
    ['prepare/getSQL-keeps-leading-trivia', db => {
        const s = db.prepare('  -- lead\n  SELECT 1 AS one');
        const sql = s.getSQL();
        s.free();
        return sql;
    }],
    ['prepare/boundary-comment-single', db => {
        const s = db.prepare('SELECT 1 AS one\n/*boundary*/');
        const sql = s.getSQL();
        s.free();
        return sql.trimEnd().endsWith('/*boundary*/');
    }],
    ['prepare/boundary-comment-multi', db => {
        const s = db.prepare('SELECT 1; SELECT 2\n/*boundary*/');
        const sql = s.getSQL();
        s.free();
        return sql.trimEnd().endsWith('/*boundary*/');
    }],
    ['statement/step-get-sequence', db => {
        const s = db.prepare('SELECT id, name FROM t ORDER BY id');
        const rows = [];
        while (s.step()) rows.push(s.get());
        const columns = s.getColumnNames();
        s.free();
        return { rows, columns };
    }],
    ['statement/get-useBigInt', db => {
        const s = db.prepare('SELECT id FROM t ORDER BY id DESC LIMIT 1');
        s.step();
        const row = s.get(null, { useBigInt: true });
        s.free();
        return row;
    }],
    ['statement/get-before-step', db => {
        const s = db.prepare('SELECT 1 AS a');
        const row = s.get();
        s.free();
        return row;
    }],
    ['statement/columns-for-zero-rows', db => {
        const s = db.prepare('SELECT id AS alpha, name AS beta FROM t WHERE 0');
        const columns = s.getColumnNames();
        s.free();
        return columns;
    }],
    ['statement/columns-before-step', db => {
        const s = db.prepare('SELECT id, name FROM t');
        const columns = s.getColumnNames();
        s.free();
        return columns;
    }],
    ['statement/columns-for-dml', db => {
        const s = db.prepare("INSERT INTO t VALUES(30,'x',NULL,0)");
        const columns = s.getColumnNames();
        s.free();
        return columns;
    }],
    // The regression that motivated the expanded-text column probe: worker.js's
    // table fetch is prepare(sql, params) -> getColumnNames() -> headers, and an
    // empty header list surfaces as "Primary-key column missing from table
    // fetch" on any zero-match filter.
    ['statement/columns-params-table-zero-rows', db => {
        const s = db.prepare('SELECT id AS alpha, name AS beta FROM t WHERE name LIKE ?', ['none-%']);
        const columns = s.getColumnNames();
        s.free();
        return columns;
    }],
    ['statement/columns-params-table-with-rows', db => {
        const s = db.prepare('SELECT id AS alpha, name AS beta FROM t WHERE name LIKE ?', ['alpha']);
        const columns = s.getColumnNames();
        const rows = [];
        while (s.step()) rows.push(s.get());
        s.free();
        return { columns, rows };
    }],
    ['statement/columns-params-page-query', db => {
        const s = db.prepare(
            'SELECT rowid, id AS alpha, name AS beta FROM t WHERE id > ? ORDER BY id LIMIT ? OFFSET ?',
            [0, 2, 0]
        );
        const columns = s.getColumnNames();
        s.free();
        return columns;
    }],
    ['statement/columns-named-params-table', db => {
        const s = db.prepare('SELECT id AS alpha FROM t WHERE name = :wanted AND id > @floor', {
            ':wanted': 'nothing',
            '@floor': 0
        });
        const columns = s.getColumnNames();
        s.free();
        return columns;
    }],

    // Metadata must never mutate. These compare the SIDE EFFECT, not the
    // return value: an earlier revision passed every value assertion while
    // silently running a prepared INSERT as soon as its columns were asked for.
    ['side-effects/columns-on-insert', db => {
        const s = db.prepare("INSERT INTO t VALUES(60,'sixty',NULL,0)");
        const columns = s.getColumnNames();
        s.free();
        return { columns, rows: db.exec('SELECT count(*) AS c FROM t WHERE id = 60') };
    }],
    ['side-effects/columns-on-update', db => {
        const s = db.prepare("UPDATE t SET name = 'clobbered'");
        const columns = s.getColumnNames();
        s.free();
        return { columns, names: db.exec('SELECT name FROM t ORDER BY id') };
    }],
    ['side-effects/columns-on-delete', db => {
        const s = db.prepare('DELETE FROM t');
        const columns = s.getColumnNames();
        s.free();
        return { columns, remaining: db.exec('SELECT count(*) AS c FROM t') };
    }],
    ['side-effects/columns-on-ddl', db => {
        const s = db.prepare('CREATE TABLE created_by_metadata(a)');
        const columns = s.getColumnNames();
        s.free();
        return {
            columns,
            exists: db.exec("SELECT count(*) AS c FROM sqlite_master WHERE name = 'created_by_metadata'")
        };
    }],
    ['side-effects/get-before-step', db => {
        const s = db.prepare("INSERT INTO t VALUES(61,'sixty-one',NULL,0)");
        const row = s.get();
        s.free();
        return { row, rows: db.exec('SELECT count(*) AS c FROM t WHERE id = 61') };
    }],
    ['side-effects/probe-leaves-change-counter-alone', db => {
        db.run("INSERT INTO t VALUES(62,'sixty-two',NULL,0)");
        const s = db.prepare('SELECT id FROM t WHERE 0');
        s.getColumnNames();
        s.free();
        return db.getRowsModified();
    }],
    ['side-effects/probe-leaves-schema-version-alone', db => {
        const before = db.exec('PRAGMA schema_version');
        const s = db.prepare('SELECT id AS alpha FROM t WHERE name LIKE ?', ['x%']);
        s.getColumnNames();
        s.free();
        return { before, after: db.exec('PRAGMA schema_version') };
    }],
    ['side-effects/parameterised-page-runs-once', db => {
        db.run('CREATE TABLE exec_probe(n INTEGER)');
        const s = db.prepare('INSERT INTO exec_probe VALUES(?) RETURNING n', [1]);
        s.getColumnNames();
        while (s.step()) { /* drain */ }
        s.free();
        return db.exec('SELECT count(*) AS runs FROM exec_probe');
    }],
    ['statement/columns-for-explain', db => {
        const s = db.prepare('EXPLAIN QUERY PLAN SELECT 1');
        const columns = s.getColumnNames();
        s.free();
        return columns;
    }],
    ['statement/step-past-end-restarts', db => {
        const s = db.prepare('SELECT 1 AS a');
        const steps = [s.step(), s.step(), s.step()];
        s.free();
        return steps;
    }],
    ['statement/run-executes-dml-once', db => {
        const s = db.prepare("INSERT INTO t VALUES(40,'forty',NULL,0)");
        s.run();
        s.free();
        return db.exec('SELECT count(*) AS c FROM t WHERE id = 40');
    }],
    ['statement/run-binds', db => {
        const s = db.prepare('INSERT INTO t VALUES(?,?,?,?)');
        s.run([41, 'forty-one', null, 0]);
        s.free();
        return db.exec('SELECT name FROM t WHERE id = 41');
    }],
    ['statement/prepare-with-params', db => {
        const s = db.prepare('SELECT ? AS bound', [3]);
        s.step();
        const row = s.get();
        s.free();
        return row;
    }],
    ['statement/double-free', db => {
        const s = db.prepare('SELECT 1');
        s.free();
        s.free();
        return 'survived';
    }],
    ['statement/use-after-free', db => {
        const s = db.prepare('SELECT 1');
        s.free();
        return s.step();
    }],
    ['statement/prepare-trivia-throws', db => db.prepare('-- nothing')],

    ['iterate/two-statements', walkStatements('SELECT 1 AS a; SELECT 2 AS b')],
    ['iterate/trailing-semicolon', walkStatements('SELECT 1 AS a; SELECT 2 AS b;')],
    ['iterate/trailing-comment', walkStatements('SELECT 1 AS a; -- trailing comment')],
    ['iterate/trailing-whitespace', walkStatements('SELECT 1 AS a;   ')],
    ['iterate/leading-semicolon', walkStatements('; SELECT 1 AS a')],
    ['iterate/empty-statement-between', walkStatements('SELECT 1 AS a;; SELECT 2 AS b')],
    ['iterate/trivia-only', walkStatements('  -- only a comment')],
    ['iterate/semicolon-in-literal', walkStatements("SELECT ';' AS semi; SELECT 2 AS b")],
    ['iterate/semicolon-in-identifier', walkStatements('SELECT 1 AS "semi;colon"; SELECT 2 AS b')],
    ['iterate/compile-error-mid-script',
        walkStatements('SELECT 1 AS a; SELEC bad; SELECT 3 AS c')],
    ['iterate/trigger-body-semicolons', db => {
        db.run('CREATE TABLE tg(a)');
        return walkStatements(
            'CREATE TRIGGER tr AFTER INSERT ON tg BEGIN UPDATE tg SET a=1; END; SELECT 1 AS after'
        )(db);
    }],
    ['iterate/positional-placeholder', walkStatements('SELECT ? AS p; SELECT 2 AS q')],
    ['iterate/named-placeholders',
        walkStatements('SELECT :name AS p, @other AS o, $third AS t; SELECT 2 AS q')],
    ['iterate/placeholder-in-final-statement',
        walkStatements('SELECT 1 AS a; SELECT ?1 AS first, ?2 AS p')],
    ['iterate/placeholder-over-a-real-table',
        walkStatements('SELECT id AS a FROM t WHERE name LIKE ?; SELECT 2 AS q')],

    ['error/syntax', db => db.exec('SELEC 1')],
    ['error/no-such-table', db => db.exec('SELECT * FROM nope')],
    ['error/unique-violation', db => db.run("INSERT INTO u VALUES(1,'y')")],
    ['error/not-null-violation', db => db.run('INSERT INTO u VALUES(2, NULL)')],
    ['error/use-after-close', db => {
        db.close();
        return db.exec('SELECT 1');
    }]
];

/**
 * Primary SQLite result codes the shim must surface on `err.errno`.
 *
 * sql.js exposes no result code at all, so this half is asserted against the
 * shim only — but it is the fork's ONLY reliable failure classifier (its
 * messages are nonspecific: syntax errors and missing tables are both
 * "SQL logic error").
 */
export const ERRNO_CHECKS = [
    ['syntax error', db => db.exec('SELEC 1'), 1],
    ['no such table', db => db.exec('SELECT * FROM nope'), 1],
    ['unique violation', db => db.run("INSERT INTO u VALUES(1,'y')"), 19],
    ['not null violation', db => db.run('INSERT INTO u VALUES(2, NULL)'), 19]
];

/** Run every fixture against a freshly seeded database from `createDatabase`. */
export function runFixtures(createDatabase) {
    return FIXTURES.map(([name, probe]) => {
        const db = createDatabase();
        try {
            db.run(SEED_SQL);
            let outcome;
            try {
                outcome = { ok: normalize(probe(db)) };
            } catch {
                // Message text is engine-specific by design (the fork reports
                // "SQL logic error" where sql.js names the token); ERRNO_CHECKS
                // pins the part that is comparable.
                outcome = { threw: true };
            }
            return { name, outcome };
        } finally {
            try {
                db.close();
            } catch {
                // Fixtures that close the database themselves.
            }
        }
    });
}

/** Run the errno matrix against a shim database factory. */
export function runErrnoChecks(createDatabase) {
    return ERRNO_CHECKS.map(([name, probe, expected]) => {
        const db = createDatabase();
        try {
            db.run(SEED_SQL);
            try {
                probe(db);
                return { name, expected, actual: null, ok: false };
            } catch (error) {
                const actual = error?.errno ?? null;
                return { name, expected, actual, ok: actual === expected };
            }
        } finally {
            db.close();
        }
    });
}
