/**
 * Differential suite for `core/native/sqljs-shim.js`.
 *
 * The shim's contract is "behave like sql.js", so almost every assertion here
 * runs the SAME operation against the real vendored sql.js `Database` and
 * against the shim, and compares. The shim runs over a node:sqlite stand-in
 * reshaped to the fork's `tjs:sqlite` contract (see
 * `helpers/tjs-backing-standin.ts`); the REAL binary runs the same fixture
 * matrix in `scripts/native-lane.mjs` (`npm run native-lane`, macOS-local).
 *
 * Where the fork genuinely differs from sql.js, the difference is asserted
 * EXPLICITLY in the "documented divergences" block rather than smoothed over,
 * so a future fork refresh that changes one of them fails loudly.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import initSqlJs from '../../vendor/sql.js/sql-wasm.js';
import { createShimDatabase, consumedSourceLength } from '../../core/native/sqljs-shim.js';
import type { ShimDatabase, ShimValueConfig, NativeBindParams } from '../../core/native/sqljs-shim.js';
import { standInSqliteModule } from './helpers/tjs-backing-standin';

/** The slice of sql.js's Database the shim reimplements. */
type SqlJsLike = Pick<
    ShimDatabase,
    'exec' | 'run' | 'prepare' | 'iterateStatements' | 'getRowsModified' | 'close'
>;

const SEED_SQL = `
CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, data BLOB, amount REAL);
INSERT INTO t VALUES
  (1, 'alpha', x'0102ff', 1.5),
  (2, NULL, NULL, -0.25),
  (9007199254740993, 'big', x'', 0.0);
CREATE TABLE u(a INTEGER UNIQUE, b TEXT NOT NULL);
INSERT INTO u VALUES (1, 'x');
`;

let SQL: { Database: new (data?: Uint8Array) => SqlJsLike };
const scratchDirs: string[] = [];

/** Synchronous filesystem hooks for the shim's export(); the sidecar supplies tjs's async ones. */
const nodeFileSystem = {
    makeTempDir: () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqljs-shim-'));
        scratchDirs.push(dir);
        return dir;
    },
    readFile: (target: string) => new Uint8Array(fs.readFileSync(target)),
    remove: (target: string) => fs.rmSync(target, { recursive: true, force: true })
};

function createShim(config: Record<string, unknown> = {}): ShimDatabase {
    return createShimDatabase(config, { sqlite: standInSqliteModule, fs: nodeFileSystem });
}

before(async () => {
    SQL = await (initSqlJs as unknown as (c?: unknown) => Promise<typeof SQL>)();
});

/**
 * Compare values across engines.
 *
 * BigInt below 2^53 collapses to Number: sql.js's `useBigInt` returns BigInt
 * for EVERY integer, while the fork only crosses to BigInt at 2^53 (probed,
 * exact boundary). Both shapes are identical after the worker's own
 * `normalizeIntegerRowsForTransport`, which converts safe BigInts to Number and
 * only preserves exact text beyond the safe range — so this normalisation is
 * the real equivalence, not a papered-over difference. Unsafe integers are
 * compared as exact decimal text, which is the property that actually matters.
 */
function normalize(value: unknown): unknown {
    if (typeof value === 'bigint') {
        return Number.isSafeInteger(Number(value)) ? Number(value) : `int64:${value}`;
    }
    if (value instanceof Uint8Array) return { blob: Array.from(value) };
    if (Array.isArray(value)) return value.map(normalize);
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalize(v)])
        );
    }
    return value;
}

/** sql.js throws bare strings from some paths and Errors from others. */
function errorText(error: unknown): string {
    if (typeof error === 'string') return error;
    return (error as Error)?.message ?? String(error);
}

type Probe = (db: SqlJsLike) => unknown;

function runProbe(db: SqlJsLike, probe: Probe): unknown {
    try {
        return { ok: normalize(probe(db)) };
    } catch (error) {
        return { threw: errorText(error) };
    }
}

/** Run `probe` against both engines on a freshly seeded database and assert equality. */
function differential(name: string, probe: Probe, options: { seed?: string } = {}): void {
    it(name, () => {
        const seed = options.seed ?? SEED_SQL;
        const reference = new SQL.Database();
        const shim = createShim();
        try {
            reference.run(seed);
            shim.run(seed);
            const expected = runProbe(reference, probe);
            const actual = runProbe(shim, probe);
            assert.deepStrictEqual(actual, expected);
        } finally {
            reference.close();
            shim.close();
        }
    });
}

/** Same, but only the two engines' error CLASSIFICATION is comparable (messages differ). */
function differentialThrows(name: string, probe: Probe, expectedErrno: number): void {
    it(name, () => {
        const reference = new SQL.Database();
        const shim = createShim();
        try {
            reference.run(SEED_SQL);
            shim.run(SEED_SQL);
            assert.throws(() => probe(reference), 'sql.js should reject this input');
            let captured: unknown;
            assert.throws(() => probe(shim), (error: unknown) => {
                captured = error;
                return true;
            });
            assert.strictEqual(
                (captured as { errno?: number }).errno,
                expectedErrno,
                'the fork classifies failures on errno; messages are nonspecific'
            );
        } finally {
            reference.close();
            shim.close();
        }
    });
}

// ---------------------------------------------------------------------------

describe('sqljs-shim: exec', () => {
    differential('multi-statement results, one entry per row-producing statement',
        db => db.exec('SELECT 1 AS a; SELECT 2 AS b'));
    differential('statements without rows contribute nothing',
        db => db.exec("INSERT INTO t VALUES(4, 'four', NULL, 1.0)"));
    differential('a zero-row SELECT contributes nothing',
        db => db.exec('SELECT id FROM t WHERE 0'));
    differential('unaliased expressions are named by their source text',
        db => db.exec('SELECT 1'));
    differential('trivia-only SQL yields no results',
        db => db.exec('  -- nothing at all\n'));
    differential('empty SQL yields no results', db => db.exec(''));
    differential('empty statements between real ones are consumed',
        db => db.exec('SELECT 1 AS a;; SELECT 2 AS b'));
    differential('a leading semicolon does not truncate the script',
        db => db.exec('; SELECT 1 AS a'));
    differential('PRAGMA reads return rows', db => db.exec('PRAGMA schema_version'));
    differential('positional parameters bind',
        db => db.exec('SELECT ? AS p, ? AS q', [7, 'seven']));
    differential('named parameters bind (sigil included in the key)',
        db => db.exec('SELECT :x AS p', { ':x': 5 } as unknown as NativeBindParams));
    differential('NULL, BLOB, REAL and int64 values cross intact',
        db => db.exec('SELECT id, name, data, amount FROM t ORDER BY id'));
    differential('useBigInt preserves an int64 beyond 2^53',
        db => db.exec('SELECT id FROM t ORDER BY id', null, { useBigInt: true } as ShimValueConfig));
    differential('without useBigInt an int64 beyond 2^53 is a lossy Number',
        db => db.exec('SELECT id FROM t ORDER BY id'));
    differential('an empty BLOB is a zero-length Uint8Array',
        db => db.exec("SELECT x'' AS empty_blob"));
    differential('semicolons inside string literals are not statement boundaries',
        db => db.exec("SELECT ';' AS semi; SELECT 2 AS after"));
    differential('a statement spanning a comment containing a semicolon',
        db => db.exec('SELECT 1 AS a /* ; not a boundary */ ; SELECT 2 AS b'));
});

describe('sqljs-shim: run and getRowsModified', () => {
    differential('run reports rows modified by the last statement', db => {
        db.run("INSERT INTO t VALUES(10, 'ten', NULL, 0.5)");
        return db.getRowsModified();
    });
    differential('run with parameters', db => {
        db.run('INSERT INTO t VALUES(?, ?, ?, ?)', [11, 'eleven', null, 0.5]);
        return db.getRowsModified();
    });
    differential('a multi-row UPDATE reports every row', db => {
        db.run('UPDATE t SET name = name');
        return db.getRowsModified();
    });
    differential('a SELECT does not reset the change counter', db => {
        db.run('UPDATE t SET name = name');
        db.exec('SELECT 1');
        return db.getRowsModified();
    });
    differential('run without parameters executes every statement in the script', db => {
        db.run("INSERT INTO t VALUES(20,'a',NULL,0); INSERT INTO t VALUES(21,'b',NULL,0)");
        return db.exec('SELECT count(*) AS c FROM t WHERE id >= 20');
    });
    differential('run returns the database for chaining', db => db.run('SELECT 1') === db);
});

describe('sqljs-shim: prepare and statement', () => {
    differential('getSQL reports only the first statement of a multi-statement string', db => {
        const statement = db.prepare('SELECT 1 AS a; SELECT 2 AS b');
        const sql = statement.getSQL();
        statement.free();
        return sql;
    });
    differential('getSQL keeps leading trivia (worker.js boundary guard depends on it)', db => {
        const statement = db.prepare('  -- lead\n  SELECT 1 AS one');
        const sql = statement.getSQL();
        statement.free();
        return sql;
    });
    differential('a trailing boundary comment survives a single-statement prepare', db => {
        const statement = db.prepare('SELECT 1 AS one\n/*boundary*/');
        const sql = statement.getSQL();
        statement.free();
        return sql.trimEnd().endsWith('/*boundary*/');
    });
    differential('a trailing boundary comment is absent after a multi-statement prepare', db => {
        const statement = db.prepare('SELECT 1; SELECT 2\n/*boundary*/');
        const sql = statement.getSQL();
        statement.free();
        return sql.trimEnd().endsWith('/*boundary*/');
    });
    differential('step/get walks every row', db => {
        const statement = db.prepare('SELECT id, name FROM t ORDER BY id');
        const rows = [];
        while (statement.step()) rows.push(statement.get());
        const columns = statement.getColumnNames();
        statement.free();
        return { rows, columns };
    });
    differential('get(null, {useBigInt}) reads the current row', db => {
        const statement = db.prepare('SELECT id FROM t ORDER BY id DESC LIMIT 1');
        statement.step();
        const row = statement.get(null, { useBigInt: true });
        statement.free();
        return row;
    });
    differential('get before any step is empty', db => {
        const statement = db.prepare('SELECT 1 AS a');
        const row = statement.get();
        statement.free();
        return row;
    });
    differential('getColumnNames answers for a zero-row result', db => {
        const statement = db.prepare('SELECT id AS alpha, name AS beta FROM t WHERE 0');
        const columns = statement.getColumnNames();
        statement.free();
        return columns;
    });
    differential('getColumnNames answers before the first step', db => {
        const statement = db.prepare('SELECT id, name FROM t');
        const columns = statement.getColumnNames();
        statement.free();
        return columns;
    });
    differential('getColumnNames is empty for a statement with no result columns', db => {
        const statement = db.prepare("INSERT INTO t VALUES(30,'x',NULL,0)");
        const columns = statement.getColumnNames();
        statement.free();
        return columns;
    });
    differential('step past the end restarts the cursor', db => {
        const statement = db.prepare('SELECT 1 AS a');
        const steps = [statement.step(), statement.step(), statement.step()];
        statement.free();
        return steps;
    });
    differential('statement.run executes DML once', db => {
        const statement = db.prepare("INSERT INTO t VALUES(40,'forty',NULL,0)");
        statement.run();
        statement.free();
        return db.exec('SELECT count(*) AS c FROM t WHERE id = 40');
    });
    differential('statement.run binds its argument', db => {
        const statement = db.prepare('INSERT INTO t VALUES(?,?,?,?)');
        statement.run([41, 'forty-one', null, 0]);
        statement.free();
        return db.exec('SELECT name FROM t WHERE id = 41');
    });
    differential('prepare accepts parameters up front', db => {
        const statement = db.prepare('SELECT ? AS bound', [3]);
        statement.step();
        const row = statement.get();
        statement.free();
        return row;
    });
    differential('double free is tolerated', db => {
        const statement = db.prepare('SELECT 1');
        statement.free();
        statement.free();
        return 'survived';
    });
    differential('use after free throws', db => {
        const statement = db.prepare('SELECT 1');
        statement.free();
        return statement.step();
    });
    differential('prepare of trivia-only SQL throws', db => db.prepare('-- nothing'));
    differential('use after close throws', db => {
        db.close();
        return db.exec('SELECT 1');
    });
});

describe('sqljs-shim: iterateStatements', () => {
    /** Drive an iterator exactly as worker.js's console does, recording the tail at each step. */
    const walk = (sql: string) => (db: SqlJsLike) => {
        const iterator = db.iterateStatements(sql);
        const steps: unknown[] = [];
        try {
            for (;;) {
                const step = iterator.next();
                if (step.done) {
                    // The tail is deliberately NOT compared here: sql.js reads a
                    // freed pointer once its iterator is done and reports ''
                    // or stray bytes. The tail after each YIELDED statement --
                    // the value worker.js's console actually consumes -- is
                    // compared below, and the post-completion behaviour is
                    // pinned in "documented divergences".
                    steps.push({ done: true });
                    break;
                }
                const statement = step.value;
                steps.push({
                    sql: statement.getSQL(),
                    columns: statement.getColumnNames(),
                    remaining: iterator.getRemainingSQL()
                });
                statement.free();
            }
        } catch (error) {
            steps.push({ threw: errorText(error), remaining: iterator.getRemainingSQL() });
        }
        return steps;
    };

    differential('two statements, tail after each', walk('SELECT 1 AS a; SELECT 2 AS b'));
    differential('trailing semicolon', walk('SELECT 1 AS a; SELECT 2 AS b;'));
    differential('trailing comment trivia', walk('SELECT 1 AS a; -- trailing comment'));
    differential('trailing whitespace', walk('SELECT 1 AS a;   '));
    differential('a leading semicolon belongs to the next statement', walk('; SELECT 1 AS a'));
    differential('an empty statement between two real ones', walk('SELECT 1 AS a;; SELECT 2 AS b'));
    differential('trivia only yields nothing', walk('  -- only a comment'));
    differential('semicolon inside a string literal', walk("SELECT ';' AS semi; SELECT 2 AS b"));
    differential('semicolon inside a quoted identifier',
        walk('SELECT 1 AS "semi;colon"; SELECT 2 AS b'));
    differential('a compile error stops iteration and the tail names the failure',
        walk('SELECT 1 AS a; SELEC bad; SELECT 3 AS c'));
    differential('a trigger body\'s internal semicolons are not boundaries', db => {
        db.run('CREATE TABLE tg(a)');
        return walk(
            'CREATE TRIGGER tr AFTER INSERT ON tg BEGIN UPDATE tg SET a=1; END; SELECT 1 AS after'
        )(db);
    });
    // Parameters make the compiled statement text diverge from its source
    // (`?` renders as NULL), which is exactly the case consumedSourceLength's
    // resynchronising walk exists for.
    differential('placeholders do not shift the statement boundary',
        walk('SELECT ? AS p; SELECT 2 AS q'));
    differential('named placeholders do not shift the statement boundary',
        walk('SELECT :name AS p, @other AS o, $third AS t; SELECT 2 AS q'));
    differential('a placeholder in the final statement',
        walk('SELECT 1 AS a; SELECT ?, ?2 AS p'));
});

describe('sqljs-shim: error surfaces', () => {
    differentialThrows('syntax error', db => db.exec('SELEC 1'), 1);
    differentialThrows('no such table', db => db.exec('SELECT * FROM nope'), 1);
    differentialThrows('UNIQUE violation', db => db.run("INSERT INTO u VALUES(1, 'y')"), 19);
    differentialThrows('NOT NULL violation', db => db.run('INSERT INTO u VALUES(2, NULL)'), 19);

    it('a statement-level failure carries errno', () => {
        const shim = createShim();
        try {
            shim.run(SEED_SQL);
            const statement = shim.prepare('INSERT INTO u VALUES(1, ?)');
            assert.throws(() => statement.run(['dup']), (error: unknown) => {
                assert.strictEqual((error as { errno?: number }).errno, 19);
                return true;
            });
            statement.free();
        } finally {
            shim.close();
        }
    });
});

describe('sqljs-shim: statement boundary alignment', () => {
    it('returns the compiled length when the source has no parameters', () => {
        assert.strictEqual(consumedSourceLength('SELECT 1; SELECT 2', 'SELECT 1;'), 9);
    });
    it('resynchronises across an unbound positional parameter', () => {
        assert.strictEqual(
            consumedSourceLength('SELECT ? AS v; rest', 'SELECT NULL AS v;'),
            14
        );
    });
    it('resynchronises across numbered and named parameters', () => {
        assert.strictEqual(
            consumedSourceLength('SELECT ?12, :name, @a, $b; rest', 'SELECT NULL, NULL, NULL, NULL;'),
            'SELECT ?12, :name, @a, $b;'.length
        );
    });
    it('does not mistake a question mark inside a literal for a parameter', () => {
        assert.strictEqual(consumedSourceLength("SELECT '?' AS v;", "SELECT '?' AS v;"), 16);
    });
    it('reports failure rather than guessing when the texts cannot be aligned', () => {
        assert.strictEqual(consumedSourceLength('SELECT 1', 'TOTALLY DIFFERENT'), -1);
    });
});

describe('sqljs-shim: native-only behaviour', () => {
    const withFileDatabase = (body: (file: string) => void) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqljs-shim-db-'));
        try {
            const file = path.join(dir, 'fixture.sqlite');
            const seeded = createShim({ path: file });
            seeded.run(SEED_SQL);
            seeded.close();
            body(file);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    };

    it('opens a file by path without inhaling its bytes', () => {
        withFileDatabase(file => {
            const db = createShim({ path: file });
            try {
                assert.deepStrictEqual(
                    normalize(db.exec('SELECT count(*) AS c FROM t')),
                    [{ columns: ['c'], values: [[3]] }]
                );
            } finally {
                db.close();
            }
        });
    });

    it('a readOnly open refuses writes with SQLITE_READONLY', () => {
        withFileDatabase(file => {
            const db = createShim({ path: file, readOnly: true });
            try {
                assert.throws(
                    () => db.run("INSERT INTO t VALUES(99,'no',NULL,0)"),
                    (error: unknown) => {
                        assert.strictEqual((error as { errno?: number }).errno, 8);
                        return true;
                    }
                );
                // Enforcement is a connection flag, not a trusted open option:
                // the fork silently ignores a mis-cased `readonly` key, so the
                // shim arms PRAGMA query_only and verifies it.
                assert.deepStrictEqual(
                    normalize(db.exec('PRAGMA query_only')),
                    [{ columns: ['query_only'], values: [[1]] }]
                );
            } finally {
                db.close();
            }
        });
    });

    it('a readOnly connection still answers column names for a zero-row query', () => {
        withFileDatabase(file => {
            const db = createShim({ path: file, readOnly: true });
            try {
                const statement = db.prepare('SELECT id AS alpha, name AS beta FROM t WHERE 0');
                assert.deepStrictEqual(statement.getColumnNames(), ['alpha', 'beta']);
                statement.free();
                // The probe lifts query_only only for its own TEMP VIEW and puts it back.
                assert.deepStrictEqual(
                    normalize(db.exec('PRAGMA query_only')),
                    [{ columns: ['query_only'], values: [[1]] }]
                );
            } finally {
                db.close();
            }
        });
    });

    it('export() produces a readable image with the same contents', () => {
        const db = createShim();
        try {
            db.run(SEED_SQL);
            const bytes = db.export();
            assert.ok(bytes instanceof Uint8Array);
            assert.strictEqual(
                Buffer.from(bytes.subarray(0, 15)).toString('latin1'),
                'SQLite format 3'
            );
            const reference = new SQL.Database(bytes);
            try {
                assert.deepStrictEqual(
                    normalize(reference.exec('SELECT count(*) AS c FROM t')),
                    [{ columns: ['c'], values: [[3]] }]
                );
            } finally {
                reference.close();
            }
        } finally {
            db.close();
        }
    });

    it('exportAsync() matches export()', async () => {
        const db = createShim();
        try {
            db.run(SEED_SQL);
            const asyncBytes = await db.exportAsync();
            const syncBytes = db.export();
            assert.deepStrictEqual(Array.from(asyncBytes), Array.from(syncBytes));
        } finally {
            db.close();
        }
    });

    it('export() from a readOnly connection works (VACUUM INTO writes only its output)', () => {
        withFileDatabase(file => {
            const db = createShim({ path: file, readOnly: true });
            try {
                const bytes = db.export();
                assert.ok(bytes.length > 0);
            } finally {
                db.close();
            }
        });
    });

    it('rejects opening from bytes', () => {
        assert.throws(
            () => createShim({ content: new Uint8Array([1, 2, 3]) }),
            /opening from bytes is not supported/
        );
    });

    it('requires a backing sqlite module', () => {
        assert.throws(
            () => createShimDatabase({}, {} as never),
            /requires deps\.sqlite\.Database/
        );
    });

    it('export() without filesystem hooks fails loudly', () => {
        const db = createShimDatabase({}, { sqlite: standInSqliteModule });
        try {
            assert.throws(() => db.export(), /requires deps\.fs/);
        } finally {
            db.close();
        }
    });

    it('inTransaction tracks an explicit transaction', () => {
        const db = createShim();
        try {
            assert.strictEqual(db.inTransaction, false);
            db.run('BEGIN');
            assert.strictEqual(db.inTransaction, true);
            db.run('ROLLBACK');
            assert.strictEqual(db.inTransaction, false);
        } finally {
            db.close();
        }
    });

    it('close is idempotent and frees outstanding statements', () => {
        const db = createShim();
        db.run(SEED_SQL);
        const statement = db.prepare('SELECT 1');
        db.close();
        db.close();
        assert.throws(() => statement.step(), /Statement closed/);
    });

    it('progress_handler is recorded but inert (the fork has no per-row callback)', () => {
        const db = createShim();
        try {
            const callback = () => false;
            db.progress_handler(1000, callback);
            assert.strictEqual(db.progressHandler?.callback, callback);
            db.progress_handler(null);
            assert.strictEqual(db.progressHandler, null);
        } finally {
            db.close();
        }
    });
});

describe('sqljs-shim: documented divergences from sql.js', () => {
    it('duplicate result names are disambiguated, and both values survive', () => {
        // sql.js reports ['x','x'] because it reads sqlite3_column_name
        // positionally. The fork only exposes rows as objects, so a duplicate
        // name would collapse to a single key AND lose a value; the shim's TEMP
        // VIEW repair recovers both values under SQLite's own disambiguated
        // names. Losing the `:1` suffix would be worse than keeping it: names
        // and values must stay the same length or the grid mis-renders.
        const reference = new SQL.Database();
        const shim = createShim();
        try {
            assert.deepStrictEqual(normalize(reference.exec('SELECT 1 AS x, 2 AS x')), [
                { columns: ['x', 'x'], values: [[1, 2]] }
            ]);
            const statement = shim.prepare('SELECT 1 AS x, 2 AS x');
            const columns = statement.getColumnNames();
            const rows = [];
            while (statement.step()) rows.push(statement.get());
            statement.free();
            assert.deepStrictEqual(columns, ['x', 'x:1']);
            assert.deepStrictEqual(normalize(rows), [[1, 2]]);
        } finally {
            reference.close();
            shim.close();
        }
    });

    it('errors are Error instances, never bare strings', () => {
        // sql.js throws the STRING "Nothing to prepare"/"Statement closed";
        // worker.js already duck-types error messages, so the shim raises real
        // Errors and keeps stack traces.
        const shim = createShim();
        try {
            assert.throws(() => shim.prepare('-- nothing'), (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.strictEqual((error as Error).message, 'Nothing to prepare');
                return true;
            });
        } finally {
            shim.close();
        }
    });

    it('getRemainingSQL after natural completion reports the leftover trivia', () => {
        // sql.js reads a freed pointer at this point and usually reports "";
        // the shim reports the trailing trivia deterministically. worker.js only
        // tests `remaining.trim() !== ''`, which both satisfy.
        const shim = createShim();
        try {
            const iterator = shim.iterateStatements('SELECT 1; -- tail');
            for (;;) {
                const step = iterator.next();
                if (step.done) break;
                step.value.free();
            }
            assert.strictEqual(iterator.getRemainingSQL().trim(), '-- tail');
        } finally {
            shim.close();
        }
    });

    it('over-stepping a DML statement does not re-run its side effects', () => {
        // sqlite3_step implicitly resets after SQLITE_DONE, so sql.js re-executes
        // an INSERT when a caller steps it again. The shim replays rows but never
        // side effects; nothing in the worker layer over-steps.
        const shim = createShim();
        try {
            shim.run(SEED_SQL);
            const statement = shim.prepare("INSERT INTO t VALUES(50,'fifty',NULL,0)");
            statement.step();
            statement.step();
            statement.free();
            assert.deepStrictEqual(
                normalize(shim.exec('SELECT count(*) AS c FROM t WHERE id = 50')),
                [{ columns: ['c'], values: [[1]] }]
            );
        } finally {
            shim.close();
        }
    });
});
