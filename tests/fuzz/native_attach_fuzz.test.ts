import '../unit/vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { it } from 'node:test';

import { getNativeBinaryPath, NativeWorkerProcess } from '../../src/nativeWorker';

// Differential fuzz of the native ATTACH/DETACH/VACUUM INTO refusal (the
// worker's tokenizer guard and the runtime's authorizer): node:sqlite decides
// whether SQLite itself would attach or write a file for a generated
// statement; the native worker must then leave no trace of it. Seeded so a
// failure reproduces. Opt-in (`npm run test:native-fuzz`, outside the unit
// glob); .github/workflows/native-fuzz.yml runs it on every bundled target.
//
// FUZZ_SINGLE / FUZZ_SCRIPTS: statement counts. FUZZ_SEED: generator seed.
// FUZZ_NO_CONTROL=1: skip the node:sqlite oracle. FUZZ_DEBUG=1: log the first
// oracle errors. FUZZ_EXPECT_TARGET: fail unless natives/<target> is the
// runtime exercised (CI sets it per runner).
const ROOT = process.cwd();
const SINGLE = Number(process.env.FUZZ_SINGLE ?? 30000);
const SCRIPTS = Number(process.env.FUZZ_SCRIPTS ?? 10000);
const CONTROL = process.env.FUZZ_NO_CONTROL !== '1';
// Two sanity floors on the generator; neither judges the worker.
// Control share: statements node:sqlite would execute (attach, or create or
// write a file), i.e. work the guard must refuse rather than syntax errors it
// never judges. Default counts measure 50.7% at the default seed and
// 50.3-51.3% over seeds 1-7; the default seed measures 45.2% singles-only and
// 68.7% scripts-only. 25% is about half the lowest of those, so seed, count
// and mix variance cannot trip it while a generator degrading into mostly
// rejected SQL does. Below CONTROL_MIN_SAMPLE statements the share is too
// noisy to judge.
// Distinct share: statements unique once counter digits are normalized. The
// generator measures 99.97% at default counts and a cycling PRNG collapses it
// (see rand), so 90% catches a repeat loop with room for incidental collisions.
const CONTROL_SHARE_FLOOR = 0.25;
const CONTROL_MIN_SAMPLE = 1000;
const DISTINCT_SHARE_FLOOR = 0.9;
let debugLeft = 15;
let seed = Number(process.env.FUZZ_SEED ?? 0x5eed1821);
// Math.imul, not `*`: the double product exceeds 2^53 and drops low bits, and
// that lossy map falls into a 419-step cycle within ~20k draws for most seeds
// (95 distinct statements out of 40,000 at the default seed). The exact
// 32-bit LCG has full period.
const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 0x100000000);
const pick = <T>(items: readonly T[]) => items[Math.floor(rand() * items.length)];
const many = (make: () => string, max: number) => Array.from({ length: Math.floor(rand() * (max + 1)) }, make).join('');

// No \v: SQLite's tokenizer classes 0x0B as illegal, not whitespace.
const TRIVIA = [' ', '\t', '\n', '\r', '\f', '\uFEFF', '-- c\n', '-- c\r\n', '/* c */', '/**/', '/*\n*/'];
const caseVariant = (word: string) => [...word].map(ch => (rand() < 0.5 ? ch.toLowerCase() : ch.toUpperCase())).join('');
const trivia = () => many(() => pick(TRIVIA), 3);
const lead = () => many(() => pick([...TRIVIA, ';', ';\n']), 4);
const sqlEscape = (value: string) => value.replaceAll('\'', '\'\'');
const sqlString = (value: string) => `'${sqlEscape(value)}'`;

function filenameExpression(target: string): { sql: string; params: unknown[] } {
    // Split only at the directory boundary so the control arm can relocate
    // every form by rewriting the outside directory prefix. basename, not a
    // '/' search, so Windows paths split there too.
    const cut = target.length - path.basename(target).length;
    return pick([
        () => ({ sql: sqlString(target), params: [] }),
        () => ({ sql: '?', params: [target] }),
        () => ({ sql: `${sqlString(target.slice(0, cut))}||${sqlString(target.slice(cut))}`, params: [] }),
        () => ({ sql: `printf('%s',${sqlString(target)})`, params: [] }),
        () => ({ sql: `(${sqlString(target)})`, params: [] }),
    ])();
}

function explainPrefix(): string {
    return pick(['', '', '', `${caseVariant('explain')}${trivia() || ' '}`,
        `${caseVariant('explain')} ${trivia()}${caseVariant('query')} ${trivia()}${caseVariant('plan')} ${trivia()}`]);
}

function attachStatement(target: string, alias: string) {
    const file = filenameExpression(target);
    const verb = caseVariant('attach') + (rand() < 0.5 ? ` ${trivia()}${caseVariant('database')}` : '');
    return { sql: `${explainPrefix()}${verb} ${trivia()}${file.sql}${trivia()} ${caseVariant('as')} ${trivia()}${alias}`, params: file.params };
}

function vacuumStatement(target: string) {
    const file = filenameExpression(target);
    const schema = pick(['', ' main', ' "main"', ' [main]', ' `main`', " 'main'"]);
    return { sql: `${explainPrefix()}${caseVariant('vacuum')}${schema} ${trivia()}${caseVariant('into')} ${trivia()}${file.sql}`, params: file.params };
}

function controlEffect(sql: string, params: unknown[], outside: string, dir: string): boolean {
    // Would SQLite itself attach or write a file? Relocate the whole outside
    // directory into a scratch mirror (with the same seeded files) so the
    // control never touches the fixture the worker is judged on.
    const scratch = fs.mkdtempSync(path.join(dir, 'control-'));
    const mirror = path.join(scratch, 'outside');
    fs.cpSync(outside, mirror, { recursive: true });
    const before = new Set(fs.readdirSync(mirror));
    // In SQL text a path only appears inside string literals, i.e. with its
    // quotes doubled; matching the raw spelling there would miss a tmpdir
    // containing a quote and run the control against the real fixture.
    const relocateSql = (text: string) => text.split(sqlEscape(outside)).join(sqlEscape(mirror));
    const relocateValue = (text: string) => text.split(outside).join(mirror);
    const db = new DatabaseSync(path.join(scratch, 'c.sqlite'));
    try {
        db.exec('CREATE TABLE t(v)');
        try {
            if (params.length > 0) db.prepare(relocateSql(sql)).all(...params.map(value => relocateValue(String(value))));
            else db.exec(relocateSql(sql));
        } catch (error) {
            // A script SQLite rejects part-way can still have attached first.
            if (process.env.FUZZ_DEBUG && debugLeft-- > 0) console.log('CONTROL-ERR', (error as Error).message, JSON.stringify(sql.slice(0, 160)));
        }
        const attached = db.prepare('PRAGMA database_list').all().some(row => row.name !== 'main' && row.name !== 'temp');
        const created = fs.readdirSync(mirror).some(entry => !before.has(entry));
        return attached || created;
    } finally {
        db.close();
        // Retries: Windows briefly refuses to delete just-closed files
        // (EBUSY/EPERM while a scanner holds them).
        fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10 });
    }
}

it('native worker leaves no trace of any ATTACH/DETACH/VACUUM INTO SQLite would execute', { timeout: 3_600_000 }, async () => {
    // The extension's own platform/arch -> natives/<target> resolution, so the
    // lane exercises the runtime a user on this host gets. No skip: the lane
    // is opt-in, and a missing runtime must fail rather than pass vacuously.
    const binary = await getNativeBinaryPath(ROOT);
    assert.ok(binary, `no bundled native runtime for ${process.platform}-${process.arch} under ${ROOT}`);
    const target = path.basename(path.dirname(binary));
    const expectedTarget = process.env.FUZZ_EXPECT_TARGET;
    if (expectedTarget) assert.equal(target, expectedTarget, `exercised natives/${target}, expected natives/${expectedTarget}`);

    const worker = new NativeWorkerProcess(binary, path.join(ROOT, 'natives', 'native-worker.js'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-explorer-attach-fuzz-'));
    try {
        const bound = path.join(dir, 'bound', 'bound.sqlite');
        const outside = path.join(dir, 'outside');
        fs.mkdirSync(path.dirname(bound));
        fs.mkdirSync(outside);
        const secret = path.join(outside, 'secret.sqlite');
        for (const [file, sql] of [[bound, 'CREATE TABLE entries(v); INSERT INTO entries VALUES (1);'], [secret, 'CREATE TABLE secret(v); INSERT INTO secret VALUES (1);']]) {
            const seedDb = new DatabaseSync(file);
            seedDb.exec(sql);
            seedDb.close();
        }
        const empty = path.join(outside, 'empty.bin');
        fs.writeFileSync(empty, new Uint8Array(0));
        const secretBytes = fs.readFileSync(secret);

        await worker.start();
        await worker.call('open', [bound, false]);
        const version = (await worker.call<{ values: unknown[][] }>('query', ['SELECT sqlite_version()'])).values[0]?.[0];
        console.log(`[native fuzz] target=${target} binary=${path.relative(ROOT, binary)} host=${process.platform}-${process.arch} sqlite=${version}`);

        const seen = new Set(fs.readdirSync(outside));
        let counter = 0;
        const stats = { generated: 0, distinct: 0, sqliteWouldExecute: 0, workerTraces: 0, workerRefused: 0, workerOther: 0 };
        const shapes = new Set<string>();
        const failures: string[] = [];

        const traces = async (): Promise<string[]> => {
            const found: string[] = [];
            const list = await worker.call<{ values: unknown[][] }>('query', ['PRAGMA database_list']);
            for (const row of list.values) if (row[1] !== 'main' && row[1] !== 'temp') found.push(`schema ${row[1]}`);
            for (const entry of fs.readdirSync(outside)) if (!seen.has(entry)) { seen.add(entry); found.push(`file ${entry}`); }
            if (fs.statSync(empty).size !== 0) found.push('empty.bin written');
            if (!fs.readFileSync(secret).equals(secretBytes)) found.push('secret.sqlite modified');
            return found;
        };

        // Positive control for the detector: the worker's own export snapshot
        // (vacuumInto, the runtime's one exception to the ATTACH refusal)
        // creates a file in outside and fills the empty file. A detector blind
        // to either would make every clean run below vacuous. The schema check
        // reads PRAGMA database_list's name column, so pin that column first.
        const schemas = (await worker.call<{ values: unknown[][] }>('query', ['PRAGMA database_list'])).values.map(row => row[1]);
        assert.ok(schemas.includes('main'), `unexpected PRAGMA database_list shape: ${JSON.stringify(schemas)}`);
        assert.deepEqual(await traces(), [], 'fixture must start without traces');
        const probe = path.join(outside, 'detector-probe.sqlite');
        await worker.call('vacuumInto', [probe]);
        await worker.call('vacuumInto', [empty]);
        assert.deepEqual((await traces()).sort(), ['empty.bin written', 'file detector-probe.sqlite'], 'detector must see the permitted export writes');
        fs.rmSync(probe, { recursive: true, maxRetries: 10 });
        seen.delete(path.basename(probe));
        fs.writeFileSync(empty, new Uint8Array(0));
        assert.deepEqual(await traces(), [], 'detector probe must reset cleanly');
        console.log('[native fuzz] detector probe: export file and empty-file write both detected');

        const attempt = async (sql: string, params: unknown[], entry: string) => {
            stats.generated++;
            // Counter digits (new-N, aN, SELECT N) make every statement unique
            // on their own; normalize them so only the generated shape counts.
            shapes.add(`${entry}\0${sql}\0${params.join('\0')}`.replace(/\d+/g, 'N'));
            if (CONTROL && controlEffect(sql, params, outside, dir)) stats.sqliteWouldExecute++;
            try {
                if (entry === 'query') await worker.call('query', [sql, params]);
                else if (entry === 'run') await worker.call('run', [sql, params]);
                else await worker.call('exec', [sql]);
            } catch (error) {
                if (/ERR_NATIVE_SQL_ATTACH_BLOCKED|authorization denied/.test((error as Error).message)) stats.workerRefused++;
                else stats.workerOther++;
            }
            const found = await traces();
            if (found.length > 0) {
                stats.workerTraces++;
                if (failures.length < 20) failures.push(`${entry}: ${JSON.stringify(sql)} params=${JSON.stringify(params)} -> ${found.join(', ')}`);
            }
        };

        for (let i = 0; i < SINGLE; i++) {
            const kind = pick(['attach', 'attach', 'vacuum', 'detach']);
            const destination = kind === 'vacuum'
                ? path.join(outside, `vac-${++counter}.sqlite`)
                : pick([secret, empty, path.join(outside, `new-${++counter}.sqlite`)]);
            const statement = kind === 'vacuum'
                ? vacuumStatement(destination)
                : kind === 'detach'
                    ? { sql: `${explainPrefix()}${caseVariant('detach')} ${trivia()}${pick(['x', 'main', 'temp', '"x"'])}`, params: [] }
                    : attachStatement(destination, `a${counter}`);
            const parameterized = statement.params.length > 0;
            // A bound statement must be the first one: prepare compiles only that.
            const prefix = parameterized ? '' : pick(['', '', 'SELECT 1;', 'SELECT 1;\n']);
            const entry = parameterized ? pick(['query', 'run']) : pick(['query', 'run', 'exec']);
            await attempt(`${parameterized ? trivia() : lead()}${prefix}${trivia()}${statement.sql}`, statement.params, entry);
        }
        for (let i = 0; i < SCRIPTS; i++) {
            const parts: string[] = [];
            const count = 2 + Math.floor(rand() * 4);
            for (let j = 0; j < count; j++) {
                const kind = pick(['select', 'attach', 'vacuum', 'select']);
                // Scripts run unbound, so a '?' filename becomes a literal.
                // Replacer functions: a '$' in a path is not a pattern.
                if (kind === 'select') parts.push(`${trivia()}SELECT ${j}`);
                else if (kind === 'vacuum') {
                    const file = path.join(outside, `svac-${++counter}.sqlite`);
                    parts.push(vacuumStatement(file).sql.replace(/\?$/, () => sqlString(file)));
                } else parts.push(attachStatement(pick([secret, empty]), `s${++counter}`).sql.replace(/\?(\s|$)/, (_match, tail: string) => `${sqlString(secret)}${tail}`));
            }
            await attempt(`${lead()}${parts.join(pick([';', ';\n', ';/* c */', ';\uFEFF']))}`, [], 'exec');
        }

        stats.distinct = shapes.size;
        console.log(`[native fuzz] target=${target} ${JSON.stringify(stats)}`);
        if (failures.length > 0) console.log(failures.join('\n'));
        // The security result first, so a sanity floor never masks a trace.
        assert.deepEqual(failures, [], `worker left traces (${JSON.stringify(stats)})`);
        assert.ok(stats.distinct >= stats.generated * DISTINCT_SHARE_FLOOR, `generator coverage: at least ${DISTINCT_SHARE_FLOOR * 100}% of generated statements must be distinct (${JSON.stringify(stats)})`);
        if (CONTROL && stats.generated >= CONTROL_MIN_SAMPLE) {
            assert.ok(stats.sqliteWouldExecute >= stats.generated * CONTROL_SHARE_FLOOR, `control arm: SQLite must execute at least ${CONTROL_SHARE_FLOOR * 100}% of generated statements (${JSON.stringify(stats)})`);
        }
    } finally {
        // Release the worker's file handles before removing the fixture:
        // Windows refuses to delete files a live process holds open.
        await worker.call('close').catch((error: Error) => console.warn(`[native fuzz] worker close failed: ${error.message}`));
        worker.stop();
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
    }
});
