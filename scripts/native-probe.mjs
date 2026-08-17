/**
 * Fork-API + stdio probe for the desktop native sidecar.
 *
 * Interrogates the bundled zknpr/txiki.js binary (`natives/<platform>/tjs`) for
 * the facts the desktop sidecar design depends on, rather than trusting the
 * upstream txiki.js docs — this is a FORK, and several of its behaviours differ
 * from both stock txiki.js and node:sqlite.
 *
 * It is deliberately outside the build/test graph: nothing imports it and it is
 * not wired into `npm test`. It exists so the findings in
 * `.superpowers/sdd/2026-08-17-native-engine/task-1-report.md` can be
 * re-derived on any machine (and re-checked whenever `natives/` is refreshed).
 *
 *   node scripts/native-probe.mjs            # all sections
 *   node scripts/native-probe.mjs sqlite     # one or more section ids
 *
 * Sections: invocation, sqlite, async, stdio, orphan, spawnenv
 *
 * Exits non-zero if a HARD invariant fails (binary missing/not executable, or
 * the framed stdin/stdout transport does not round-trip). Everything else is
 * reported, not asserted — the point is observation.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Mirrors getNativeBinaryPath() in src/nativeWorker.ts. */
function resolveBinary() {
  const platformDir = {
    linux: process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu',
    darwin: process.arch === 'arm64' ? 'aarch64-macos' : 'x86_64-macos',
    win32: 'x86_64-windows'
  }[process.platform];
  if (!platformDir) throw new Error(`unsupported platform: ${process.platform}`);
  const name = process.platform === 'win32' ? 'tjs.exe' : 'tjs';
  return path.join(REPO_ROOT, 'natives', platformDir, name);
}

const BIN = resolveBinary();
const SCRATCH = mkdtempSync(path.join(tmpdir(), 'native-probe-'));
let hardFailure = false;

const heading = (s) => console.log(`\n${'='.repeat(72)}\n${s}\n${'='.repeat(72)}`);
const fail = (s) => { hardFailure = true; console.log(`!! HARD FAILURE: ${s}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Write a tjs-side script into the scratch dir and return its absolute path. */
function tjsScript(name, source) {
  const file = path.join(SCRATCH, name);
  writeFileSync(file, source);
  return file;
}

/** Run a tjs script to completion, capturing stdout/stderr/exit code. */
function runTjs(scriptPath, args = [], { stdin = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(BIN, ['run', scriptPath, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (stdin !== null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

/**
 * Shared tjs-side probe preamble: `T(label, fn)` prints one line per probe,
 * never throwing, so a single unsupported API cannot truncate a whole section.
 * BigInt is stringified because JSON.stringify refuses it outright.
 */
const PREAMBLE = `
const J = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? \`BIGINT(\${x})\` : x));
const T = async (label, fn) => {
  try {
    const r = await fn();
    console.log(label, '=> OK', typeof r === 'string' ? r : J(r));
  } catch (e) {
    console.log(label, '=> THROW', e && e.constructor && e.constructor.name, J(e && e.message));
  }
};
`;

// ---------------------------------------------------------------------------
// 1. Invocation + argv
// ---------------------------------------------------------------------------
async function sectionInvocation() {
  heading('1. INVOCATION + ARGV');
  console.log(`binary: ${BIN}`);

  const version = await runTjs(tjsScript('v.js', 'console.log(tjs.version)'));
  if (version.code !== 0) {
    fail(`binary not executable (exit ${version.code}): ${version.stderr.trim()}`);
    return;
  }
  console.log(`tjs.version: ${version.stdout.trim()}`);

  const argvJs = tjsScript('argv.js', `
console.log('tjs.args        =', JSON.stringify(tjs.args));
console.log('user args start =', JSON.stringify(tjs.args.slice(3)));
console.log('tjs globals     =', Object.keys(tjs).sort().join(','));
`);
  console.log('\n-- tjs run <script> a b --');
  console.log((await runTjs(argvJs, ['a', 'b'])).stdout.trim());
  console.log('\n-- tjs run <script> -- a b --');
  console.log((await runTjs(argvJs, ['--', 'a', 'b'])).stdout.trim());

  console.log('\n-- exit codes --');
  for (const [label, src] of [
    ['uncaught sync throw', 'throw new Error("boom")'],
    ['unhandled top-level await rejection', 'await Promise.reject(new Error("x"))'],
    ['tjs.exit(7)', 'tjs.exit(7)']
  ]) {
    const r = await runTjs(tjsScript(`exit-${label.replace(/\W+/g, '-')}.js`, src));
    console.log(`  ${label} => exit ${r.code}`);
  }
  const missing = await runTjs(path.join(SCRATCH, 'does-not-exist.js'));
  console.log(`  missing script => exit ${missing.code}`);
}

// ---------------------------------------------------------------------------
// 2. tjs:sqlite — sync Database surface + behaviour
// ---------------------------------------------------------------------------
async function sectionSqlite() {
  heading('2. tjs:sqlite — SYNC Database');
  const roDb = path.join(SCRATCH, 'ro.db');
  const vacSrc = path.join(SCRATCH, 'vac-src.db');
  const vacOut = path.join(SCRATCH, 'vac-out.db');

  const script = tjsScript('sqlite.js', `
import * as sqlite from "tjs:sqlite";
const { Database } = sqlite;
${PREAMBLE}
const describe = (o) => {
  const d = Object.getOwnPropertyDescriptors(o);
  return Object.entries(d).map(([k, v]) =>
    k + (v.get ? '[getter]' : (typeof v.value === 'function' ? '(' + v.value.length + ')' : ''))).join(', ');
};
console.log('module exports        :', Object.keys(sqlite).join(','));
console.log('Database.prototype    :', describe(sqlite.Database.prototype));
const probe = new Database(':memory:');
const stmt = probe.prepare('SELECT 1 AS a');
console.log('Statement.prototype   :', describe(Object.getPrototypeOf(stmt)));
stmt.finalize();
probe.close();

console.log('\\n-- constructor / readonly enforcement --');
await T('new Database() (no args)', () => { const d = new Database(); d.close(); return 'ok'; });
await T('missing file + {readOnly:true}', () => { const d = new Database(${JSON.stringify(path.join(SCRATCH, 'nope.db'))}, { readOnly: true }); d.close(); return 'ok'; });
{ const d = new Database(${JSON.stringify(roDb)}); d.exec('CREATE TABLE t(a)'); d.exec('INSERT INTO t VALUES(1)'); d.close(); }
await T('{readonly:true} (lowercase) then INSERT', () => {
  const d = new Database(${JSON.stringify(roDb)}, { readonly: true });
  try { d.exec('INSERT INTO t VALUES(999)'); return 'INSERT SUCCEEDED -- option IGNORED'; }
  catch (e) { return 'blocked: ' + e.message; } finally { d.close(); }
});
await T('on-disk rows after that write', () => { const d = new Database(${JSON.stringify(roDb)}); const r = d.prepare('SELECT group_concat(a) AS g FROM t').all(); d.close(); return r; });
await T('{readOnly:true} (camelCase) then INSERT', () => {
  const d = new Database(${JSON.stringify(roDb)}, { readOnly: true });
  try { d.exec('INSERT INTO t VALUES(888)'); return 'INSERT SUCCEEDED -- option IGNORED'; }
  catch (e) { return 'blocked: ' + e.message; } finally { d.close(); }
});
await T('PRAGMA query_only under {readonly:true}', () => { const d = new Database(${JSON.stringify(roDb)}, { readonly: true }); const r = d.prepare('PRAGMA query_only').all(); d.close(); return r; });

const db = new Database(':memory:');
db.exec('CREATE TABLE t(a INTEGER, b TEXT)');

console.log('\\n-- return values --');
await T('db.exec(...) returns', () => String(db.exec('CREATE TABLE ret(a)')));
await T('stmt.run(...) returns', () => { const s = db.prepare('INSERT INTO t VALUES(?,?)'); const r = s.run([1, 'x']); s.finalize(); return String(r); });
await T('changes/lastInsertRowid as JS props', () => ({
  changes: String(db.changes), totalChanges: String(db.totalChanges),
  rowsModified: String(db.rowsModified), getRowsModified: typeof db.getRowsModified,
  lastInsertRowId: String(db.lastInsertRowId)
}));
await T('changes() via SQL', () => db.prepare('SELECT changes() AS ch, total_changes() AS tot, last_insert_rowid() AS lid').all());

console.log('\\n-- rows / columns --');
await T('stmt.all() row shape', () => { const s = db.prepare('SELECT * FROM t'); const r = s.all(); s.finalize(); return r; });
await T('stmt.step exists?', () => typeof db.prepare('SELECT 1').step);
await T('EMPTY result -> column names?', () => { const s = db.prepare('SELECT a AS alpha, b AS beta FROM t WHERE 0'); const r = s.all(); s.finalize(); return { rows: r, len: r.length }; });
await T('duplicate column names', () => { const s = db.prepare('SELECT 1 AS x, 2 AS x'); const r = s.all(); s.finalize(); return r; });
await T('unaliased expression column key', () => db.prepare('SELECT 1').all());
await T('multi-statement via prepare', () => { const s = db.prepare('SELECT 1 AS one; SELECT 2 AS two'); const r = s.all(); s.finalize(); return r; });
await T('stmt reusable after all()', () => { const s = db.prepare('SELECT 1 AS z'); const a = s.all(); const b = s.all(); s.finalize(); return { a, b }; });
await T('use after finalize', () => { const s = db.prepare('SELECT 1'); s.finalize(); return s.all(); });
await T('double finalize', () => { const s = db.prepare('SELECT 1'); s.finalize(); s.finalize(); return 'ok'; });
await T('stmt.toString()', () => { const s = db.prepare('SELECT * FROM t WHERE a=?'); const r = String(s); s.finalize(); return r; });

console.log('\\n-- column names for an EMPTY result (workaround) --');
await T('TEMP VIEW + pragma_table_info', () => {
  db.exec("CREATE TEMP VIEW __cols AS SELECT a AS alpha, b AS beta, 1+1, 'lit' FROM t WHERE 0");
  const r = db.prepare("SELECT cid, name, type FROM pragma_table_info('__cols')").all();
  db.exec('DROP VIEW __cols');
  return r;
});
await T('TEMP VIEW disambiguates duplicates', () => {
  db.exec('CREATE TEMP VIEW __dup AS SELECT 1 AS x, 2 AS x');
  const r = db.prepare("SELECT cid, name FROM pragma_table_info('__dup')").all();
  db.exec('DROP VIEW __dup');
  return r;
});

console.log('\\n-- parameter binding --');
await T('all([1]) array form', () => db.prepare('SELECT ? AS v').all([1]));
await T('all(1) spread form', () => db.prepare('SELECT ? AS v').all(1));
await T('all(null) bare null', () => db.prepare('SELECT ? AS v').all(null));
await T('all([null]) wrapped null', () => { const r = db.prepare('SELECT ? AS v').all([null]); return { t: typeof r[0].v, v: String(r[0].v) }; });
await T('all(Uint8Array) bare blob', () => db.prepare('SELECT hex(?) AS h').all(new Uint8Array([1, 2, 255])));
await T('all([Uint8Array]) wrapped blob', () => db.prepare('SELECT hex(?) AS h, typeof(?) AS t').all([new Uint8Array([1, 2, 255]), new Uint8Array([1])]));
await T('named {$x:1}', () => db.prepare('SELECT $x AS v').all({ $x: 1 }));
await T('named {":x":1}', () => db.prepare('SELECT :x AS v').all({ ':x': 1 }));
await T('named {x:1} (no sigil)', () => db.prepare('SELECT :x AS v').all({ x: 1 }));
await T('too few params', () => db.prepare('SELECT ?,?').all([1]));
await T('too many params', () => db.prepare('SELECT ?').all([1, 2]));
await T('boolean param', () => { const r = db.prepare('SELECT ? AS v').all([true]); return { t: typeof r[0].v, v: String(r[0].v) }; });
await T('undefined param', () => db.prepare('SELECT ? AS v').all([undefined]));

console.log('\\n-- value types / int64 --');
for (const lit of ['9007199254740991', '9007199254740992', '9007199254740993', '-9007199254740992', '9223372036854775807', '-9223372036854775808', '2147483648']) {
  await T('literal ' + lit, () => { const r = db.prepare('SELECT ' + lit + ' AS v').all(); return { t: typeof r[0].v, s: String(r[0].v) }; });
}
await T('bind BigInt max int64, read back', () => { const r = db.prepare('SELECT ? AS v').all([9223372036854775807n]); return { t: typeof r[0].v, s: String(r[0].v), exact: r[0].v === 9223372036854775807n }; });
await T('bind Number 2^53+1 (lossy at the JS boundary)', () => { const r = db.prepare('SELECT ? AS v').all([9007199254740993]); return { t: typeof r[0].v, s: String(r[0].v) }; });
await T('REAL / TEXT / NULL / BLOB typeof', () => {
  const row = db.prepare("SELECT 1.5 AS r, 1.0 AS rInt, 'txt' AS t, NULL AS n, x'DEADBEEF' AS b").all()[0];
  return { r: typeof row.r, rInt: typeof row.rInt + ':' + String(row.rInt), t: typeof row.t, n: String(row.n), b: row.b && row.b.constructor.name + ':' + row.b.byteLength };
});

console.log('\\n-- schema_version / sqlite build --');
await T('PRAGMA schema_version', () => db.prepare('PRAGMA schema_version').all());
await T('PRAGMA schema_version after DDL', () => { db.exec('CREATE TABLE sv(x)'); return db.prepare('PRAGMA schema_version').all(); });
await T('PRAGMA data_version', () => db.prepare('PRAGMA data_version').all());
await T('PRAGMA via exec() (result discarded)', () => String(db.exec('PRAGMA schema_version')));
await T('sqlite_version / page_size / cache_size / FTS5', () => db.prepare(
  "SELECT sqlite_version() AS version, (SELECT count(*) FROM pragma_compile_options WHERE compile_options LIKE '%FTS5%') AS fts5"
).all().concat(db.prepare('PRAGMA page_size').all(), db.prepare('PRAGMA cache_size').all()));

console.log('\\n-- transactions / interrupt / deadline --');
await T('db.inTransaction (getter, not method)', () => ({ value: db.inTransaction, type: typeof db.inTransaction }));
await T('inTransaction inside BEGIN', () => { db.exec('BEGIN'); const v = db.inTransaction; db.exec('ROLLBACK'); return { inside: v, after: db.inTransaction }; });
await T('db.transaction(fn) wrapper', () => db.transaction(() => 'inner-return')());
const LONG = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<200000000) SELECT max(x) AS m FROM c';
await T('setQueryDeadline(50) on a long query', () => {
  db.setQueryDeadline(50);
  const t0 = Date.now();
  try { db.prepare(LONG).all(); return 'COMPLETED in ' + (Date.now() - t0) + 'ms -- deadline IGNORED'; }
  catch (e) { return 'threw after ' + (Date.now() - t0) + 'ms: ' + e.constructor.name + ' ' + J(e.message); }
  finally { db.clearQueryDeadline(); }
});
await T('connection usable after deadline abort', () => db.prepare('SELECT 1 AS ok').all());

console.log('\\n-- error shapes --');
// e.errno carries the PRIMARY SQLite result code on a non-enumerable property
// (Object.keys(e) is empty, so naive error serialisation silently drops it).
// It is the primary code only -- no extended code -- so e.g. UNIQUE and
// NOT NULL both surface as 19 with the same "constraint failed" message.
const errShape = (fn) => {
  try { fn(); return 'no throw'; }
  catch (e) {
    return { ctor: e.constructor.name, message: e.message, errno: String(e.errno), code: String(e.code), enumerableKeys: Object.keys(e), ownProps: Object.getOwnPropertyNames(e) };
  }
};
await T('syntax error', () => errShape(() => db.prepare('SELEC 1')));
await T('no such table', () => errShape(() => db.exec('SELECT * FROM nope')));
await T('UNIQUE constraint', () => errShape(() => { db.exec('CREATE TABLE u(a UNIQUE)'); db.exec('INSERT INTO u VALUES(1)'); db.exec('INSERT INTO u VALUES(1)'); }));
await T('NOT NULL constraint', () => errShape(() => { db.exec('CREATE TABLE nn(a NOT NULL)'); db.exec('INSERT INTO nn VALUES(NULL)'); }));
await T('deadline interrupt', () => errShape(() => { db.setQueryDeadline(20); try { db.prepare(LONG).all(); } finally { db.clearQueryDeadline(); } }));
await T('readonly write', () => errShape(() => { const d = new Database(${JSON.stringify(roDb)}, { readOnly: true }); try { d.exec('INSERT INTO t VALUES(1)'); } finally { d.close(); } }));
await T('cannot open', () => errShape(() => new Database(${JSON.stringify(path.join(SCRATCH, 'absent.db'))}, { readOnly: true })));
db.close();
await T('use after db.close()', () => db.exec('SELECT 1'));
await T('double db.close()', () => { const d = new Database(':memory:'); d.close(); d.close(); return 'ok'; });

console.log('\\n-- VACUUM INTO --');
await T('setup source db', () => { const d = new Database(${JSON.stringify(vacSrc)}); d.exec('CREATE TABLE t(a)'); d.exec('INSERT INTO t VALUES(1),(2),(3)'); d.close(); return 'ok'; });
await T('VACUUM INTO via exec()', () => { const d = new Database(${JSON.stringify(vacSrc)}); try { d.exec("VACUUM INTO '" + ${JSON.stringify(vacOut)} + "'"); return 'ok'; } finally { d.close(); } });
await T('vacuumed copy readable', () => { const d = new Database(${JSON.stringify(vacOut)}, { readOnly: true }); const r = d.prepare('SELECT count(*) AS c FROM t').all(); d.close(); return r; });
await T('VACUUM INTO existing path', () => { const d = new Database(${JSON.stringify(vacSrc)}); try { d.exec("VACUUM INTO '" + ${JSON.stringify(vacOut)} + "'"); return 'OVERWROTE'; } catch (e) { return 'blocked: ' + e.message; } finally { d.close(); } });
await T('VACUUM INTO with a bound parameter', () => { const d = new Database(${JSON.stringify(vacSrc)}); try { const s = d.prepare('VACUUM INTO ?'); s.run([${JSON.stringify(path.join(SCRATCH, 'vac-param.db'))}]); s.finalize(); return 'ok'; } catch (e) { return 'failed: ' + e.message; } finally { d.close(); } });
await T('VACUUM INTO from a {readOnly:true} connection', () => { const d = new Database(${JSON.stringify(vacSrc)}, { readOnly: true }); try { d.exec("VACUUM INTO '" + ${JSON.stringify(path.join(SCRATCH, 'vac-ro.db'))} + "'"); return 'ok'; } catch (e) { return 'blocked: ' + e.message; } finally { d.close(); } });
`);

  const r = await runTjs(script);
  console.log(r.stdout.trimEnd());
  if (r.stderr.trim()) console.log('[stderr]', r.stderr.trim());
}

// ---------------------------------------------------------------------------
// 3. tjs:sqlite — AsyncDatabase
// ---------------------------------------------------------------------------
async function sectionAsync() {
  heading('3. tjs:sqlite — AsyncDatabase');
  const dbPath = path.join(SCRATCH, 'async.db');

  const script = tjsScript('async.js', `
import * as sqlite from "tjs:sqlite";
const { AsyncDatabase, Database } = sqlite;
${PREAMBLE}
const describe = (o) => Object.entries(Object.getOwnPropertyDescriptors(o))
  .map(([k, v]) => k + (v.get ? '[getter]' : (typeof v.value === 'function' ? '(' + v.value.length + ')' : ''))).join(', ');
console.log('AsyncDatabase.prototype:', describe(AsyncDatabase.prototype));

{ const d = new Database(${JSON.stringify(dbPath)}); d.exec('CREATE TABLE t(a)'); d.exec('INSERT INTO t VALUES(1),(2),(3)'); d.close(); }
const adb = new AsyncDatabase(${JSON.stringify(dbPath)});
await T('constructor is synchronous (not a promise)', () => ({ isThenable: typeof adb.then === 'function', ctor: adb.constructor.name }));
await T('all(sql)', () => adb.all('SELECT * FROM t'));
await T('all(sql, params)', () => adb.all('SELECT ? AS v', [42]));
await T('all() int64 -> BigInt', async () => { const r = await adb.all('SELECT 9223372036854775807 AS v'); return { t: typeof r[0].v, s: String(r[0].v) }; });
await T('run() return value', async () => String(await adb.run('CREATE TABLE IF NOT EXISTS at(a)')));
await T('run() then changes() via all()', async () => { await adb.run('INSERT INTO at VALUES(?)', [7]); return adb.all('SELECT changes() AS ch, last_insert_rowid() AS lid, total_changes() AS tot'); });
await T('all() on a no-result statement', () => adb.all('CREATE TABLE IF NOT EXISTS at2(a)'));
await T('EMPTY result -> column names?', async () => { const r = await adb.all('SELECT a AS alpha FROM t WHERE 0'); return { rows: r, len: r.length }; });
await T('error shape + errno', async () => { try { await adb.all('SELECT * FROM nope'); return 'no throw'; } catch (e) { return { ctor: e.constructor.name, message: e.message, errno: String(e.errno) }; } });
await T('setQueryDeadline on AsyncDatabase?', () => typeof adb.setQueryDeadline);
await T('{readonly:true} (lowercase)', async () => { const d = new AsyncDatabase(${JSON.stringify(dbPath)}, { readonly: true }); try { await d.run('INSERT INTO t VALUES(99)'); return 'INSERT SUCCEEDED -- option IGNORED'; } catch (e) { return 'blocked: ' + e.message; } finally { await d.close(); } });
await T('{readOnly:true} (camelCase)', async () => { const d = new AsyncDatabase(${JSON.stringify(dbPath)}, { readOnly: true }); try { await d.run('INSERT INTO t VALUES(98)'); return 'INSERT SUCCEEDED -- option IGNORED'; } catch (e) { return 'blocked: ' + e.message; } finally { await d.close(); } });

const LONG = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<200000000) SELECT max(x) AS m FROM c';
console.log('\\n-- cancellation --');
// Note the two distinct rejections: an AbortSignal yields Error("Aborted")
// with NO errno, while interrupt() yields Error("interrupted") errno=9.
await T('all(..., {signal}) aborted mid-flight', async () => {
  const ac = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ac.abort(), 30);
  try { await adb.all(LONG, [], { signal: ac.signal }); return 'COMPLETED -- signal IGNORED'; }
  catch (e) { return 'rejected after ' + (Date.now() - t0) + 'ms: ' + e.constructor.name + ' ' + J(e.message) + ' errno=' + e.errno; }
});
await T('connection usable after abort', () => adb.all('SELECT 1 AS ok'));
await T('pre-aborted signal', async () => { const ac = new AbortController(); ac.abort(); try { await adb.all('SELECT 1', [], { signal: ac.signal }); return 'ran anyway'; } catch (e) { return 'rejected: ' + e.constructor.name + ' ' + J(e.message); } });
await T('run(..., {signal}) aborted mid-flight', async () => { const ac = new AbortController(); setTimeout(() => ac.abort(), 30); const t0 = Date.now(); try { await adb.run(LONG, [], { signal: ac.signal }); return 'COMPLETED -- signal IGNORED'; } catch (e) { return 'rejected after ' + (Date.now() - t0) + 'ms: ' + J(e.message); } });
await T('interrupt() during an in-flight query', async () => {
  const t0 = Date.now();
  const p = adb.all(LONG);
  setTimeout(() => adb.interrupt(), 30);
  try { await p; return 'COMPLETED -- interrupt IGNORED'; }
  catch (e) { return 'rejected after ' + (Date.now() - t0) + 'ms: ' + J(e.message); }
});
await T('connection usable after interrupt()', () => adb.all('SELECT 3 AS ok'));
await T('two concurrent queries preserve FIFO order', async () => {
  const order = [];
  await Promise.all([
    adb.all('SELECT 1 AS a').then(() => order.push('q1')),
    adb.all('SELECT 2 AS b').then(() => order.push('q2'))
  ]);
  return order;
});
await adb.close();
await T('use after close()', () => adb.all('SELECT 1'));
`);

  const r = await runTjs(script);
  console.log(r.stdout.trimEnd());
  if (r.stderr.trim()) console.log('[stderr]', r.stderr.trim());
}

// ---------------------------------------------------------------------------
// 4. stdio — the framed transport proof (HARD invariant)
// ---------------------------------------------------------------------------

/**
 * The echo loop the sidecar's transport is modelled on: 4-byte big-endian
 * length prefix + JSON body, in and out.
 *
 * The reassembly buffer is the load-bearing part. `reader.read()` resolves with
 * whatever the OS pipe happened to deliver — it honours neither frame nor
 * request boundaries — so a chunk can carry a partial header, several whole
 * frames, or a frame plus the first bytes of the next. `readExact` therefore
 * keeps the unconsumed tail across calls.
 */
const ECHO_SOURCE = `
const reader = tjs.stdin.getReader();
const writer = tjs.stdout.getWriter();

let pending = new Uint8Array(0);
let pendingOffset = 0;
let ended = false;

// Fill \`buffer\` completely; returns bytes actually read (< length only at EOF).
async function readExact(buffer) {
  let total = 0;
  while (total < buffer.byteLength) {
    if (pendingOffset >= pending.byteLength) {
      if (ended) return total;
      const { value, done } = await reader.read();
      if (done) { ended = true; return total; }
      if (!value || value.byteLength === 0) continue;
      pending = value;
      pendingOffset = 0;
    }
    const n = Math.min(buffer.byteLength - total, pending.byteLength - pendingOffset);
    buffer.set(pending.subarray(pendingOffset, pendingOffset + n), total);
    pendingOffset += n;
    total += n;
  }
  return total;
}

async function writeFrame(obj) {
  const body = new TextEncoder().encode(JSON.stringify(obj));
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, body.byteLength, false); // big-endian
  await writer.write(header);
  await writer.write(body);
}

console.error('[echo] ready pid=' + tjs.pid + ' ppid=' + tjs.ppid);
for (;;) {
  const header = new Uint8Array(4);
  const got = await readExact(header);
  if (got === 0) { console.error('[echo] stdin EOF -> exit'); break; }
  if (got < 4) { console.error('[echo] truncated header: ' + got + '/4'); break; }
  const len = new DataView(header.buffer).getUint32(0, false);
  const body = new Uint8Array(len);
  const bodyGot = await readExact(body);
  if (bodyGot < len) { console.error('[echo] truncated body: ' + bodyGot + '/' + len); break; }
  const msg = JSON.parse(new TextDecoder().decode(body));
  await writeFrame({ echoOf: msg.id, payloadLen: len, roundTrip: msg });
}
`;

async function sectionStdio() {
  heading('4. STDIO — FRAMED TRANSPORT ROUND-TRIP');

  const surface = await runTjs(tjsScript('stdio-surface.js', `
const describe = (o) => Object.entries(Object.getOwnPropertyDescriptors(Object.getPrototypeOf(o)))
  .map(([k, v]) => k + (v.get ? '[getter]' : (typeof v.value === 'function' ? '(' + v.value.length + ')' : ''))).join(', ');
console.log('tjs.stdin  ctor:', tjs.stdin.constructor.name, '| proto:', describe(tjs.stdin));
console.log('tjs.stdout ctor:', tjs.stdout.constructor.name, '| proto:', describe(tjs.stdout));
console.log('legacy tjs.stdin.read      :', typeof tjs.stdin.read);
console.log('legacy tjs.stdout.write    :', typeof tjs.stdout.write);
console.log('WHATWG tjs.stdin.getReader :', typeof tjs.stdin.getReader);
console.log('WHATWG tjs.stdout.getWriter:', typeof tjs.stdout.getWriter);
`));
  console.log(surface.stdout.trimEnd());

  console.log('\n-- echo loop round-trip --');
  const echo = tjsScript('echo.js', ECHO_SOURCE);
  const child = spawn(BIN, ['run', echo], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => process.stdout.write('  [child stderr] ' + d));

  const frames = [];
  let buf = Buffer.alloc(0);
  child.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 4) break;
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) break;
      frames.push(JSON.parse(buf.subarray(4, 4 + len).toString()));
      buf = buf.subarray(4 + len);
    }
  });

  const frame = (obj) => {
    const body = Buffer.from(JSON.stringify(obj));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    return Buffer.concat([header, body]);
  };

  // (a) one frame, one write
  child.stdin.write(frame({ id: 1, hello: 'world' }));
  // (b) two frames coalesced into a single write -- proves leftover-tail retention
  child.stdin.write(Buffer.concat([frame({ id: 2, a: 1 }), frame({ id: 3, b: 2 })]));
  // (c) 256 KiB payload -- forces the child to reassemble across many pipe chunks
  child.stdin.write(frame({ id: 4, big: 'x'.repeat(256 * 1024) }));
  await sleep(300);

  // (d) drip-feed one byte per write -- the strictest partial-read case
  const drip = frame({ id: 5, drip: 'reassembled' });
  console.log(`  drip-feeding ${drip.length} bytes, 1 byte per write`);
  for (const byte of drip) { child.stdin.write(Buffer.from([byte])); await sleep(2); }
  await sleep(300);

  // (e) header split across three writes
  const split = frame({ id: 6, splitHeader: true });
  child.stdin.write(split.subarray(0, 2)); await sleep(40);
  child.stdin.write(split.subarray(2, 4)); await sleep(40);
  child.stdin.write(split.subarray(4));
  await sleep(300);

  child.stdin.end();
  const code = await new Promise((r) => child.on('exit', r));

  console.log(`  child exit code on stdin EOF: ${code}`);
  console.log(`  frames received: ${frames.length}/6`);
  for (const f of frames) {
    const rt = f.roundTrip;
    const desc = rt.big ? `big(len=${rt.big.length}, intact=${/^x+$/.test(rt.big)})` : JSON.stringify(rt);
    console.log(`    echoOf=${f.echoOf} payloadLen=${f.payloadLen} roundTrip=${desc}`);
  }

  const ids = frames.map((f) => f.echoOf).join(',');
  if (ids !== '1,2,3,4,5,6') fail(`framed transport round-trip incomplete or out of order (got ids: ${ids})`);
  const bigFrame = frames.find((f) => f.echoOf === 4);
  if (!bigFrame || bigFrame.roundTrip.big.length !== 256 * 1024) fail('256 KiB frame did not round-trip intact');
  if (code !== 0) fail(`echo loop exited ${code} on stdin EOF (expected 0)`);
}

// ---------------------------------------------------------------------------
// 5. Orphan detection
// ---------------------------------------------------------------------------
async function sectionOrphan() {
  heading('5. ORPHAN DETECTION (ppid + stdin EOF)');
  const log = path.join(SCRATCH, 'orphan.log');

  const childScript = tjsScript('orphan-child.js', `
const d = Object.getOwnPropertyDescriptor(tjs, 'ppid');
const kind = d ? (d.get ? 'GETTER (re-read on every access)' : 'plain VALUE (snapshot)') : 'MISSING';
const lines = [];
const rec = (s) => { lines.push(s); tjs.writeFile(${JSON.stringify(log)}, new TextEncoder().encode(lines.join('\\n') + '\\n')); };
const t0 = Date.now();
rec('t=0ms tjs.ppid is a ' + kind + '; ppid=' + tjs.ppid + ' pid=' + tjs.pid);
(async () => {
  const r = tjs.stdin.getReader();
  for (;;) { const { done } = await r.read(); if (done) { rec('STDIN_EOF at t=' + (Date.now() - t0) + 'ms; tjs.ppid now = ' + tjs.ppid); break; } }
})();
for (let i = 0; i < 25; i++) { await new Promise((r) => setTimeout(r, 100)); rec('t=' + (Date.now() - t0) + 'ms ppid=' + tjs.ppid); }
rec('child loop finished on its own -- it was NOT killed by the parent dying');
`);

  // A throwaway node parent so it can be SIGKILLed without taking the probe down.
  const parentScript = path.join(SCRATCH, 'orphan-parent.mjs');
  writeFileSync(parentScript, `
import { spawn } from 'node:child_process';
const c = spawn(${JSON.stringify(BIN)}, ['run', ${JSON.stringify(childScript)}], { stdio: ['pipe', 'pipe', 'ignore'] });
console.log(JSON.stringify({ parentPid: process.pid, childPid: c.pid }));
setTimeout(() => {}, 60000);
`);

  const parent = spawn(process.execPath, [parentScript], { stdio: ['ignore', 'pipe', 'ignore'] });
  const pids = await new Promise((resolve) => parent.stdout.once('data', (d) => resolve(JSON.parse(d.toString()))));
  console.log(`  node parent pid=${pids.parentPid}, tjs child pid=${pids.childPid}`);

  await sleep(700);
  console.log(`  SIGKILL the node parent (simulates a host crash, not a clean shutdown)`);
  process.kill(pids.parentPid, 'SIGKILL');

  await sleep(1000);
  let stillAlive = true;
  try { process.kill(pids.childPid, 0); } catch { stillAlive = false; }
  console.log(`  1s after parent SIGKILL, tjs child still running: ${stillAlive}`);

  await sleep(1800);
  console.log('  --- child log ---');
  try {
    for (const line of readFileSync(log, 'utf8').trimEnd().split('\n')) console.log('    ' + line);
  } catch (err) {
    console.log('    (no log written: ' + err.message + ')');
  }
  try { process.kill(pids.childPid, 'SIGKILL'); } catch { /* already gone */ }
}

// ---------------------------------------------------------------------------
// 6. The extension's spawn env allowlist
// ---------------------------------------------------------------------------
async function sectionSpawnEnv() {
  heading('6. EXTENSION SPAWN SITE (src/nativeWorker.ts)');
  const file = path.join(REPO_ROOT, 'src', 'nativeWorker.ts');
  const lines = readFileSync(file, 'utf8').split('\n');
  const show = (from, to, label) => {
    console.log(`\n-- ${label} (src/nativeWorker.ts:${from}-${to}) --`);
    for (let i = from; i <= to; i++) console.log(String(i).padStart(5) + ' | ' + (lines[i - 1] ?? ''));
  };
  const envStart = lines.findIndex((l) => l.includes('function buildSpawnEnv')) + 1;
  if (envStart > 0) {
    const envEnd = lines.findIndex((l, i) => i >= envStart && l === '}') + 1;
    show(envStart, envEnd, 'env allowlist');
  }
  const spawnLine = lines.findIndex((l) => l.includes('= spawn(this.binaryPath')) + 1;
  if (spawnLine > 0) show(spawnLine, spawnLine + 4, 'spawn options');
}

// ---------------------------------------------------------------------------

const SECTIONS = {
  invocation: sectionInvocation,
  sqlite: sectionSqlite,
  async: sectionAsync,
  stdio: sectionStdio,
  orphan: sectionOrphan,
  spawnenv: sectionSpawnEnv
};

const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const selected = requested.length ? requested : Object.keys(SECTIONS);

for (const name of selected) {
  const fn = SECTIONS[name];
  if (!fn) {
    console.error(`unknown section: ${name} (known: ${Object.keys(SECTIONS).join(', ')})`);
    process.exitCode = 2;
    break;
  }
  await fn();
}

rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${hardFailure ? 'PROBE FAILED (see HARD FAILURE above)' : 'probe complete'}`);
if (hardFailure) process.exitCode = 1;
