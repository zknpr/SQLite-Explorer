// WASM (vendored sql.js) scaling curve — same query set as bench-scaling.sh,
// so the two can be compared directly. sql.js loads the WHOLE database into the
// WASM heap, so this also finds the size at which the engine simply cannot open
// a file at all.
import { createRequire } from 'node:module';
import { readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = '/Users/zero/dev/SQLite-Explorer/.claude/worktrees/issue-520-pk-identity';
const initSqlJs = require(path.join(ROOT, 'vendor/sql.js/sql-wasm.js'));
const wasmBinary = readFileSync(path.join(ROOT, 'vendor/sql.js/sql-wasm.wasm'));

const dir = process.argv[2] || '/private/tmp/claude-501/scale';
const sizes = process.argv.slice(3).map(Number);

const ms = () => Number(process.hrtime.bigint()) / 1e6;
const fmt = n => (n === null ? '  —' : n.toFixed(1));

function timeIt(fn, warm = true) {
  if (warm) { try { fn(); } catch { /* ignore warmup failure */ } }
  const t0 = ms();
  fn();
  return ms() - t0;
}

function rows(db, sql) {
  const st = db.prepare(sql);
  let n = 0;
  while (st.step()) { st.get(); n++; }
  st.free();
  return n;
}

const SQL = await initSqlJs({ wasmBinary });
console.log('sql.js loaded (vendored fork build)\n');

const header = ['ROWS', 'FILE', 'OPEN', 'FIRST', 'OFFSET', 'KEYSET', 'COUNT(*)', 'SCAN', 'RSS/heap'];
console.log(header.map((h, i) => h.padStart(i === 0 ? 12 : 10)).join(''));

for (const n of sizes) {
  const file = path.join(dir, `scale-${n}.sqlite`);
  if (!existsSync(file)) { console.log(`${String(n).padStart(12)}  (fixture missing)`); continue; }
  const bytes = statSync(file).size;
  const human = bytes > 1e9 ? (bytes / 1e9).toFixed(1) + 'G' : (bytes / 1e6).toFixed(0) + 'M';

  let db = null, openMs = null, first = null, off = null, keyset = null, cnt = null, scan = null, mem = '';
  try {
    // Time the WHOLE open: sql.js has no path-based open, so reading the file
    // into memory is an unavoidable part of what a user waits for.
    const t0 = ms();
    const buf = readFileSync(file);
    db = new SQL.Database(buf);
    rows(db, 'SELECT 1');            // force real initialisation
    openMs = ms() - t0;

    const total = db.exec('SELECT count(*) FROM t')[0].values[0][0];

    first = timeIt(() => rows(db, 'SELECT id,n,s FROM t ORDER BY id LIMIT 500'));
    off = timeIt(() => rows(db, `SELECT id,n,s FROM t ORDER BY id LIMIT 500 OFFSET ${Math.max(0, total - 500)}`));
    keyset = timeIt(() => rows(db, 'SELECT id,n,s FROM t ORDER BY id DESC LIMIT 500'));
    cnt = timeIt(() => rows(db, 'SELECT count(*) FROM t'));
    scan = timeIt(() => rows(db, "SELECT count(*) FROM t WHERE s = 'no-such-value'"));
    mem = (process.memoryUsage().rss / 1e6).toFixed(0) + 'M';
  } catch (err) {
    mem = 'FAILED: ' + String(err.message || err).slice(0, 48);
  } finally {
    try { if (db) db.close(); } catch { /* already gone */ }
  }

  console.log(
    String(n).padStart(12) + human.padStart(10) +
    fmt(openMs).padStart(10) + fmt(first).padStart(10) + fmt(off).padStart(10) +
    fmt(keyset).padStart(10) + fmt(cnt).padStart(10) + fmt(scan).padStart(10) +
    '  ' + mem
  );
  if (global.gc) global.gc();
}
console.log('\nall times ms; OPEN includes reading the file and loading it into the WASM heap');
