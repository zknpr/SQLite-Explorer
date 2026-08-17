/**
 * tjs-side half of the native lane. Runs INSIDE the real fork binary.
 *
 *   tjs run scripts/lib/native-lane-harness.mjs <scratchDir>
 *
 * Loads `core/native/sqljs-shim.js` over the REAL `tjs:sqlite`, executes the
 * shared fixture matrix plus the fork-only checks that have no sql.js
 * counterpart, and writes one JSON document to stdout for
 * `scripts/native-lane.mjs` to compare against sql.js. Diagnostics go to
 * stderr so stdout stays parseable.
 */

import { Database } from 'tjs:sqlite';
import { createShimDatabase } from '../../core/native/sqljs-shim.js';
import { runFixtures, runErrnoChecks, normalize, SEED_SQL } from './native-lane-fixtures.mjs';

const scratchDir = tjs.args[3];
if (!scratchDir) {
    console.error('usage: tjs run native-lane-harness.mjs <scratchDir>');
    tjs.exit(2);
}

const sqlite = { Database };

/**
 * The fork has no synchronous filesystem call, so every hook here is a
 * promise: `export()` must refuse and `exportAsync()` must work. That split is
 * the contract the sidecar entry inherits.
 */
const fs = {
    makeTempDir: () => tjs.makeTempDir(`${scratchDir}/export-XXXXXX`),
    readFile: (target) => tjs.readFile(target),
    remove: (target) => tjs.remove(target, { recursive: true })
};

const createDatabase = (config = {}) => createShimDatabase(config, { sqlite, fs });

const forkOnly = [];
const record = async (name, probe) => {
    try {
        forkOnly.push({ name, outcome: { ok: normalize(await probe()) } });
    } catch (error) {
        forkOnly.push({ name, outcome: { threw: true, message: String(error?.message ?? error) } });
    }
};

// --- fork-only behaviour: no sql.js counterpart exists ----------------------

const filePath = `${scratchDir}/lane-fixture.sqlite`;
{
    const seeded = createDatabase({ path: filePath });
    seeded.run(SEED_SQL);
    seeded.close();
}

await record('native/open-by-path', () => {
    const db = createDatabase({ path: filePath });
    try {
        return db.exec('SELECT count(*) AS c FROM t');
    } finally {
        db.close();
    }
});

await record('native/readonly-blocks-writes', () => {
    const db = createDatabase({ path: filePath, readOnly: true });
    try {
        db.run("INSERT INTO t VALUES(99,'no',NULL,0)");
        return 'WROTE -- read-only was not enforced';
    } catch (error) {
        return { blocked: true, errno: error?.errno ?? null };
    } finally {
        db.close();
    }
});

await record('native/readonly-query-only-armed', () => {
    const db = createDatabase({ path: filePath, readOnly: true });
    try {
        return db.exec('PRAGMA query_only');
    } finally {
        db.close();
    }
});

await record('native/readonly-zero-row-columns', () => {
    const db = createDatabase({ path: filePath, readOnly: true });
    try {
        const statement = db.prepare('SELECT id AS alpha, name AS beta FROM t WHERE 0');
        const columns = statement.getColumnNames();
        statement.free();
        // The column probe lifts query_only for its own TEMP VIEW; it must be
        // back on afterwards.
        return { columns, queryOnly: db.exec('PRAGMA query_only')[0].values[0][0] };
    } finally {
        db.close();
    }
});

await record('native/readonly-columns-inside-transaction', () => {
    // The worker brackets cell reads in a SAVEPOINT, so the column probe has to
    // survive being run inside one on a query_only connection.
    const db = createDatabase({ path: filePath, readOnly: true });
    try {
        db.run('SAVEPOINT probe_bracket');
        const statement = db.prepare('SELECT id AS alpha FROM t WHERE 0');
        const columns = statement.getColumnNames();
        statement.free();
        db.run('RELEASE probe_bracket');
        return { columns, queryOnly: db.exec('PRAGMA query_only')[0].values[0][0] };
    } finally {
        db.close();
    }
});

await record('native/readonly-parameterised-zero-row-columns', () => {
    // The Critical from review: a parameterised zero-match filter used to yield
    // no column names, which the grid reports as "Primary-key column missing".
    const db = createDatabase({ path: filePath, readOnly: true });
    try {
        const statement = db.prepare(
            'SELECT id AS alpha, name AS beta FROM t WHERE name LIKE ?',
            ['no-match-%']
        );
        const columns = statement.getColumnNames();
        statement.free();
        return { columns, queryOnly: db.exec('PRAGMA query_only')[0].values[0][0] };
    } finally {
        db.close();
    }
});

await record('native/probe-leaves-no-temp-view', () => {
    const db = createDatabase({ path: filePath, readOnly: true });
    try {
        for (let attempt = 0; attempt < 3; attempt++) {
            const statement = db.prepare('SELECT id AS alpha FROM t WHERE id > ?', [0]);
            statement.getColumnNames();
            statement.free();
        }
        return db.exec(
            "SELECT count(*) AS c FROM temp.sqlite_master WHERE name LIKE '_sqlx_shim_cols_%'"
        );
    } finally {
        db.close();
    }
});

await record('native/metadata-never-mutates', () => {
    const db = createDatabase();
    try {
        db.run(SEED_SQL);
        const insert = db.prepare("INSERT INTO t VALUES(60,'sixty',NULL,0)");
        const insertColumns = insert.getColumnNames();
        const insertRow = insert.get();
        insert.free();
        const ddl = db.prepare('CREATE TABLE created_by_metadata(a)');
        const ddlColumns = ddl.getColumnNames();
        ddl.free();
        return {
            insertColumns,
            insertRow,
            ddlColumns,
            inserted: db.exec('SELECT count(*) AS c FROM t WHERE id = 60'),
            created: db.exec(
                "SELECT count(*) AS c FROM sqlite_master WHERE name = 'created_by_metadata'"
            )
        };
    } finally {
        db.close();
    }
});

await record('native/duplicate-columns-repaired', () => {
    const db = createDatabase();
    try {
        const statement = db.prepare('SELECT 1 AS x, 2 AS x');
        const columns = statement.getColumnNames();
        const rows = [];
        while (statement.step()) rows.push(statement.get());
        statement.free();
        return { columns, rows };
    } finally {
        db.close();
    }
});

await record('native/parameterised-duplicate-names-keep-bound-values', () => {
    // The probe view for a parameterised statement holds NULLs where the bound
    // values belong, so the duplicate repair must NOT re-read through it.
    const db = createDatabase();
    try {
        const statement = db.prepare('SELECT ? AS x, ? AS x', [1, 2]);
        const before = statement.getColumnNames();
        const rows = [];
        while (statement.step()) rows.push(statement.get());
        const after = statement.getColumnNames();
        statement.free();
        return { before, after, rows };
    } finally {
        db.close();
    }
});

await record('native/export-sync-refused', () => {
    const db = createDatabase({ path: filePath, readOnly: true });
    try {
        db.export();
        return 'export() SUCCEEDED -- the fork gained a synchronous filesystem';
    } catch (error) {
        return { refused: true, mentionsExportAsync: /exportAsync/.test(String(error?.message)) };
    } finally {
        db.close();
    }
});

await record('native/export-async-roundtrip', async () => {
    const db = createDatabase({ path: filePath, readOnly: true });
    let bytes;
    try {
        bytes = await db.exportAsync();
    } finally {
        db.close();
    }
    const copyPath = `${scratchDir}/exported.sqlite`;
    await tjs.writeFile(copyPath, bytes);
    const reopened = createDatabase({ path: copyPath, readOnly: true });
    try {
        return {
            header: String.fromCharCode(...bytes.subarray(0, 15)),
            rows: reopened.exec('SELECT count(*) AS c FROM t')
        };
    } finally {
        reopened.close();
        await tjs.remove(copyPath);
    }
});

await record('native/content-mode-rejected', () => {
    createDatabase({ content: new Uint8Array([1, 2, 3]) });
    return 'ACCEPTED -- the shim must refuse byte-mode opens';
});

await record('native/in-transaction', () => {
    const db = createDatabase();
    try {
        const before = db.inTransaction;
        db.run('BEGIN');
        const during = db.inTransaction;
        db.run('ROLLBACK');
        return { before, during, after: db.inTransaction };
    } finally {
        db.close();
    }
});

// --- shared matrix ---------------------------------------------------------

const fixtures = runFixtures(() => createDatabase());
const errnoChecks = runErrnoChecks(() => createDatabase());

console.log(JSON.stringify({
    engine: { tjs: tjs.version, sqlite: new Database(':memory:').prepare('SELECT sqlite_version() AS v').all()[0].v },
    fixtures,
    errnoChecks,
    forkOnly
}));
