import './vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { it, type TestContext } from 'node:test';

import { NativeWorkerProcess } from '../../src/nativeWorker';

/**
 * SQL-level ATTACH on the native engine's real-filesystem connection opens or
 * creates any path SQLite can reach, so the worker refuses ATTACH/DETACH on
 * every connection it opens. These tests drive the bundled txiki runtime
 * through the raw host->worker RPC channel: that channel, not a host helper,
 * is the boundary the guard has to hold.
 */

const BLOCKED = /ERR_NATIVE_SQL_ATTACH_BLOCKED/;
const NOT_TEXT = /Native SQLite requires SQL text as a string/;
const SECRET = 'TOP-SECRET-OUTSIDE-BOUND-PATH';
const BOUNDARY = '/*sqlite_explorer_boundary_attach_guard*/';

interface QueryResult {
    columns: string[];
    values: unknown[][];
    resultSets?: QueryResult[];
}

function bundledRuntime(): { binary: string; library: string } | undefined {
    const target = process.platform === 'darwin'
        ? (process.arch === 'arm64' ? 'aarch64-macos' : 'x86_64-macos')
        : process.platform === 'linux'
            ? (process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu')
            : process.platform === 'win32' && process.arch === 'x64' ? 'x86_64-windows' : undefined;
    if (!target) return undefined;
    const directory = path.join(process.cwd(), 'natives', target);
    const binary = path.join(directory, process.platform === 'win32' ? 'tjs.exe' : 'tjs');
    const suffix = process.platform === 'darwin' ? 'dylib' : process.platform === 'win32' ? 'dll' : 'so';
    return fs.existsSync(binary)
        ? { binary, library: path.join(directory, `query-plan.${suffix}`) }
        : undefined;
}

function render(value: unknown): string {
    try {
        return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? `${item}n` : item);
    } catch {
        return String(value);
    }
}

async function startFixture(t: TestContext) {
    const runtime = bundledRuntime();
    if (!runtime) {
        t.skip(`no bundled native runtime for ${process.platform}-${process.arch}`);
        return undefined;
    }
    const root = process.cwd();
    fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
    const directory = fs.mkdtempSync(path.join(root, '.tmp', 'native-attach-guard-'));
    // The bound database and the attacker's targets live in sibling
    // directories: nothing under outside/ is reachable through the bound path.
    const boundDirectory = path.join(directory, 'bound');
    const outsideDirectory = path.join(directory, 'outside');
    fs.mkdirSync(boundDirectory);
    fs.mkdirSync(outsideDirectory);
    const bound = path.join(boundDirectory, 'bound.sqlite');
    const secret = path.join(outsideDirectory, 'secret.sqlite');
    for (const [file, sql] of [
        [bound, "CREATE TABLE entries(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO entries VALUES (1, 'kept');"],
        [secret, `CREATE TABLE secret(v TEXT); INSERT INTO secret VALUES ('${SECRET}');`]
    ] as const) {
        const seed = new DatabaseSync(file);
        try { seed.exec(sql); } finally { seed.close(); }
    }
    // SQLite treats an existing zero-byte file as an empty database, so ATTACH
    // can turn any empty file the user owns into one.
    const emptyFile = path.join(outsideDirectory, 'empty.bin');
    fs.writeFileSync(emptyFile, new Uint8Array(0));
    const outsideSeen = new Set(fs.readdirSync(outsideDirectory));
    let emptyFileSize = 0;

    const worker = new NativeWorkerProcess(runtime.binary, path.join(root, 'natives', 'native-worker.js'));
    await worker.start();
    t.after(() => {
        worker.stop();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    await worker.call('open', [bound, false]);

    let counter = 0;
    const outsidePath = (label: string) => path.join(outsideDirectory, `${label}-${++counter}.sqlite`);
    const query = (sql: string, params?: unknown[]) => worker.call<QueryResult>('query', [sql, params]);
    const attachedSchemas = async () => (await query('PRAGMA database_list')).values
        .map(row => String(row[1]))
        .filter(name => name !== 'main' && name !== 'temp');

    /**
     * Observable effects of an executed ATTACH since the last call: an extra
     * schema on the connection, or a file the bound path does not cover. Any
     * schema found is detached so one executed case cannot mask the next.
     */
    const sideEffects = async (): Promise<string[]> => {
        const effects: string[] = [];
        for (const schema of await attachedSchemas()) {
            effects.push(`schema "${schema}" attached`);
            try {
                await worker.call('exec', [`DETACH DATABASE "${schema}"`]);
            } catch (error) {
                effects.push(`could not detach "${schema}": ${(error as Error).message}`);
            }
        }
        // Report each file effect once, so a later case is not blamed for it.
        for (const entry of fs.readdirSync(outsideDirectory)) {
            if (outsideSeen.has(entry)) continue;
            outsideSeen.add(entry);
            effects.push(`created outside/${entry}`);
        }
        const size = fs.statSync(emptyFile).size;
        if (size !== emptyFileSize) {
            effects.push(`wrote ${size} bytes into outside/empty.bin`);
            emptyFileSize = size;
        }
        return effects;
    };

    const control = async () => {
        assert.deepEqual((await query('SELECT value FROM entries')).values, [['kept']],
            'a benign read on the same connection must keep working');
    };

    return { worker, runtime, directory, bound, secret, emptyFile, outsidePath, query, attachedSchemas, sideEffects, control };
}

type Fixture = NonNullable<Awaited<ReturnType<typeof startFixture>>>;

/**
 * Run one attempt and describe what the native worker actually did. Returns
 * undefined only for a policy refusal that left no side effect.
 */
async function refusalProblem(
    f: Fixture,
    label: string,
    attempt: () => Promise<unknown>,
    expectedRefusal: RegExp = BLOCKED
): Promise<string | undefined> {
    let outcome: unknown;
    let failure: Error | undefined;
    try {
        outcome = await attempt();
    } catch (error) {
        failure = error as Error;
    }
    const effects = await f.sideEffects();
    if (failure === undefined) {
        return `${label}: EXECUTED by the native worker; result=${render(outcome)}` +
            (effects.length > 0 ? `; side effects: ${effects.join(', ')}` : '');
    }
    if (!expectedRefusal.test(failure.message)) {
        return `${label}: refused for an unrelated reason (${failure.message})` +
            (effects.length > 0 ? `; side effects: ${effects.join(', ')}` : '');
    }
    if (effects.length > 0) return `${label}: refused but left side effects: ${effects.join(', ')}`;
    return undefined;
}

it('refuses SQL-level ATTACH that reads a database outside the bound path', async t => {
    const f = await startFixture(t); if (!f) return;
    await f.control();

    const readSecret = `SELECT 1 AS ok; ATTACH DATABASE '${f.secret}' AS leak; SELECT v FROM leak.secret`;
    const writable = await refusalProblem(f, 'query: ATTACH as 2nd statement, then read', () => f.query(readSecret));

    // A read-only open does not help: it blocks writes through the attached
    // schema, never the ATTACH itself or a read through it.
    await f.worker.call('open', [f.bound, true]);
    const readOnly = await refusalProblem(f, 'read-only open: ATTACH, then read', () => f.query(readSecret));
    await f.worker.call('open', [f.bound, false]);

    assert.deepEqual([writable, readOnly].filter(problem => problem !== undefined), []);
    await f.control();
});

it('refuses SQL-level ATTACH that writes files outside the bound path', async t => {
    const f = await startFixture(t); if (!f) return;
    await f.control();

    const problems: string[] = [];
    const record = (problem: string | undefined) => { if (problem !== undefined) problems.push(problem); };

    // Write into an existing SQLite database outside the bound directory.
    record(await refusalProblem(f, 'exec: ATTACH an existing outside database, CREATE TABLE, INSERT', () => f.worker.call('exec', [
        `ATTACH '${f.secret}' AS planted; CREATE TABLE planted.injected(a); INSERT INTO planted.injected VALUES ('written')`
    ])));
    const secretCopy = new DatabaseSync(f.secret, { readOnly: true });
    try {
        const injected = secretCopy.prepare("SELECT name FROM sqlite_schema WHERE name = 'injected'").all();
        if (injected.length > 0) problems.push('outside/secret.sqlite now contains table "injected"');
    } finally {
        secretCopy.close();
    }

    // Turn an existing empty file into a database.
    record(await refusalProblem(f, 'exec: ATTACH an existing empty file, CREATE TABLE', () => f.worker.call('exec', [
        `ATTACH '${f.emptyFile}' AS planted_empty; CREATE TABLE planted_empty.t(a); INSERT INTO planted_empty.t VALUES ('written')`
    ])));

    // Create a new file. The worker opens without SQLITE_OPEN_CREATE, which
    // attached schemas inherit, so SQLite itself refuses this one today; the
    // guard must refuse it before SQLite is consulted at all.
    const target = f.outsidePath('created');
    record(await refusalProblem(f, 'exec: ATTACH a new path, CREATE TABLE', () => f.worker.call('exec', [
        `ATTACH '${target}' AS planted_new; CREATE TABLE planted_new.t(a)`
    ])));

    assert.deepEqual(problems, []);
    assert.equal(fs.existsSync(target), false);
    await f.control();
});

it('refuses ATTACH and DETACH at every SQL entry point of the native worker', async t => {
    const f = await startFixture(t); if (!f) return;
    const { worker } = f;

    const cases: Array<[string, (target: string, alias: string) => Promise<unknown>, RegExp?]> = [
        ['query', (p, a) => f.query(`ATTACH '${p}' AS ${a}`)],
        ['query: 2nd of three statements', (p, a) => f.query(`SELECT 1; ATTACH '${p}' AS ${a}; SELECT 2`)],
        ['query: block and line comments first', (p, a) => f.query(`/* leading */ -- line comment\n  ATTACH '${p}' AS ${a}`)],
        ['query: empty statements, mixed case', (p, a) => f.query(`;;\n\t; AtTaCh DATABASE '${p}' AS ${a}`)],
        // SQLite skips a U+FEFF byte-order mark at any token start (CC_BOM).
        ['query: byte-order mark after a comment', (p, a) => f.query(`/**/\uFEFFATTACH '${p}' AS ${a}`)],
        ['exec: byte-order mark before the 2nd statement', (p, a) => worker.call('exec', [`SELECT 1;\uFEFF\uFEFFATTACH '${p}' AS ${a}`])],
        ['query: bound filename', (p, a) => f.query(`ATTACH ? AS ${a}`, [p])],
        ['queryNumeric', (p, a) => worker.call('queryNumeric', [`ATTACH '${p}' AS ${a}`, [], ['x']])],
        ['queryBatch: 2nd item', (p, a) => worker.call('queryBatch', [[{ sql: 'SELECT 1' }, { sql: `ATTACH '${p}' AS ${a}` }]])],
        ['querySingle', (p, a) => worker.call('querySingle', [`ATTACH '${p}' AS ${a}\n${BOUNDARY}`, [], BOUNDARY])],
        ['run', (p, a) => worker.call('run', [`ATTACH '${p}' AS ${a}`])],
        ['runSingle', (p, a) => {
            const sql = `ATTACH '${p}' AS ${a}`;
            return worker.call('runSingle', [`${sql}\n${BOUNDARY}`, sql, [], BOUNDARY]);
        }],
        ['exec: 2nd statement', (p, a) => worker.call('exec', [`SELECT 1; ATTACH '${p}' AS ${a}`])],
        ['execBatch', (p, a) => worker.call('execBatch', [[{ sql: `ATTACH '${p}' AS ${a}` }]])],
        ['execBatch: paramsList', (p, a) => worker.call('execBatch', [[{ sql: `ATTACH ? AS ${a}`, paramsList: [[p]] }]])],
        ['prepare + stmtRun', async (p, a) => {
            const { stmtId } = await worker.call<{ stmtId: number }>('prepare', [`ATTACH ? AS ${a}`]);
            return worker.call('stmtRun', [stmtId, [p]]);
        }],
        ['queryBounded', (p, a) => {
            const sql = `ATTACH '${p}' AS ${a}`;
            return worker.call('queryBounded', [`${sql}\n${BOUNDARY}`, sql, BOUNDARY, ['x'], undefined, 1, 5000]);
        }],
        ['workspaceQuery: primary allAsync', (p, a) => worker.call('workspaceQuery', [`ATTACH '${p}' AS ${a}`, BOUNDARY, [], [], 5000])],
        ['workspaceQueryPlan: primary allAsync', (p, a) => worker.call('workspaceQueryPlan', [`ATTACH '${p}' AS ${a}`, [], f.runtime.library, 5000])],
        // The binding coerces non-string SQL with ToString, so an array whose
        // only element is the statement compiles exactly like the string.
        ['prepare: SQL as a one-element array', async (p, a) => {
            const { stmtId } = await worker.call<{ stmtId: number }>('prepare', [[`ATTACH '${p}' AS ${a}`]]);
            return worker.call('stmtRun', [stmtId, []]);
        }, NOT_TEXT],
        ['workspaceQueryPlan: SQL as a one-element array', (p, a) => worker.call('workspaceQueryPlan', [[`ATTACH '${p}' AS ${a}`], [], f.runtime.library, 5000]), NOT_TEXT],
        // EXPLAIN of an ATTACH is inert on SQLite 3.51.2 (it lists opcodes and
        // opens nothing); it is refused anyway so the guard never depends on that.
        ['query: EXPLAIN ATTACH', (p, a) => f.query(`EXPLAIN ATTACH '${p}' AS ${a}`)],
        ['query: EXPLAIN QUERY PLAN ATTACH', (p, a) => f.query(`EXPLAIN /* c */ QUERY\nPLAN ATTACH '${p}' AS ${a}`)],
    ];

    // Every case targets the existing outside database: an executed ATTACH
    // then shows up as an attached schema rather than as an open failure.
    const problems: string[] = [];
    let index = 0;
    for (const [label, attempt, expectedRefusal] of cases) {
        const alias = `guard_${++index}`;
        const problem = await refusalProblem(f, label, () => attempt(f.secret, alias), expectedRefusal);
        if (problem !== undefined) problems.push(problem);
    }

    // compileBatch reports compile failures per probe instead of rejecting.
    const compiled = await worker.call<{ errors: Array<string | null> }>('compileBatch', [[
        `EXPLAIN ATTACH '${f.secret}' AS compile_probe`
    ]]);
    if (!BLOCKED.test(compiled.errors[0] ?? '')) {
        problems.push(`compileBatch: EXPLAIN ATTACH compiled (errors=${render(compiled.errors)})`);
    }

    // DETACH needs a schema to detach. Before the fix the ATTACH below
    // succeeds; after it, the ATTACH is refused and the DETACH must be too.
    try { await worker.call('exec', [`ATTACH '${f.secret}' AS detach_target`]); } catch { /* refused */ }
    for (const [label, sql] of [
        ['query: DETACH', 'DETACH DATABASE detach_target'],
        ['run: comment-prefixed DETACH', '/* c */ DETACH detach_target'],
        ['exec: DETACH main', 'SELECT 1; DETACH main']
    ] as const) {
        let outcome: unknown;
        let failure: Error | undefined;
        try {
            outcome = await worker.call(label.startsWith('exec') ? 'exec' : label.startsWith('run') ? 'run' : 'query', [sql]);
        } catch (error) {
            failure = error as Error;
        }
        if (failure === undefined) problems.push(`${label}: EXECUTED; result=${render(outcome)}`);
        else if (!BLOCKED.test(failure.message)) problems.push(`${label}: refused for an unrelated reason (${failure.message})`);
    }
    const leftover = await f.sideEffects();
    if (leftover.length > 0) problems.push(`after DETACH cases: ${leftover.join(', ')}`);

    assert.deepEqual(problems, []);
    await f.control();
});

it('keeps the worker\'s own SQL and benign scripts working (control arm)', async t => {
    const f = await startFixture(t); if (!f) return;
    const { worker } = f;
    await f.control();

    // exec runs a multi-statement script whose later statement depends on the
    // DDL of an earlier one, so each statement must execute before the next compiles.
    await worker.call('exec', ["CREATE TABLE made(a TEXT); INSERT INTO made VALUES ('ok'); -- trailing comment\n"]);
    assert.deepEqual((await f.query('SELECT a FROM made')).values, [['ok']]);

    // Mentioning attach/detach as an identifier, a string or a column is not ATTACH.
    await worker.call('run', ['CREATE TABLE attach_log(detach TEXT, "attach" TEXT, attach_count INTEGER)']);
    await worker.call('run', ["INSERT INTO attach_log VALUES ('ATTACH x', 'DETACH y', 1)"]);
    const mentions = await f.query("SELECT detach, \"attach\", attach_count FROM attach_log; SELECT 'ATTACH ''q'' AS z' AS word");
    assert.deepEqual(mentions.resultSets?.map(set => set.values), [[['ATTACH x', 'DETACH y', 1]], [["ATTACH 'q' AS z"]]]);

    // Internal statements: the execBatch SAVEPOINT bracket, PRAGMA journal_mode,
    // compile-only EXPLAIN probes, the primary allAsync read and VACUUM INTO.
    await worker.call('execBatch', [[{ sql: 'INSERT INTO made VALUES (?)', params: ['batched'] }]]);
    await worker.call('setJournalMode', ['wal']);
    assert.equal((await f.query('PRAGMA journal_mode')).values[0][0], 'wal');
    await worker.call('setJournalMode', ['delete']);
    assert.equal((await f.query('PRAGMA journal_mode')).values[0][0], 'delete');
    assert.deepEqual((await worker.call<{ errors: unknown[] }>('compileBatch', [['EXPLAIN SELECT a FROM made']])).errors, [null]);
    const read = await worker.call<{ values: unknown[][] }>('workspaceQuery', ['SELECT a FROM made ORDER BY rowid', BOUNDARY, [], ['a'], 5000]);
    assert.deepEqual(read.values, [['ok'], ['batched']]);

    const snapshot = path.join(f.directory, 'snapshot.sqlite');
    await worker.call('vacuumInto', [snapshot, 5000]);
    const copy = new DatabaseSync(snapshot, { readOnly: true });
    try {
        assert.deepEqual(copy.prepare('SELECT a FROM made ORDER BY rowid').all().map(row => row.a), ['ok', 'batched']);
    } finally {
        copy.close();
    }

    assert.deepEqual(await f.attachedSchemas(), []);
    await f.control();
});
