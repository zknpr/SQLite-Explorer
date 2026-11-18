#!/usr/bin/env node
/**
 * Sanitizer and differential lane for src/runtime/query-plan.c.
 *
 * The grid helpers in that file read stored cell bytes inside the native
 * worker's process, where a bad read is memory corruption rather than a
 * WebAssembly trap. The engines' own differential tests run the shipped,
 * unsanitized builds. This lane compiles the helpers with AddressSanitizer
 * and UndefinedBehaviorSanitizer against the same SQLite amalgamation the
 * runtime builder pins, and drives them with tests/runtime/query-plan-fuzz.c.
 *
 *   node scripts/test-runtime-sanitizers.mjs              sanitized fuzz run
 *   node scripts/test-runtime-sanitizers.mjs --mutations  control arm: each
 *       injected defect below must make the same run fail
 *
 * It also compiles the amalgamation as the WebAssembly build patches it
 * (scripts/lib/sqlite-math-patch.mjs) and runs tests/runtime/
 * math-schema-driver.c against it: that C code otherwise only ever runs as
 * WebAssembly, where a bad read is a trap or nothing at all. The mutation
 * arm breaks the patch in one place at a time.
 *
 * Options: --cc PATH (default $CC or clang), --seed N, --databases N,
 * --statements N. Needs a C compiler with both sanitizers and `unzip`; the
 * pinned toolchain of build-query-plan.mjs is not required.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchSqliteMath } from './lib/sqlite-math-patch.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = path.join(root, 'src', 'runtime', 'query-plan.c');
const driver = path.join(root, 'tests', 'runtime', 'query-plan-fuzz.c');
const mathDriver = path.join(root, 'tests', 'runtime', 'math-schema-driver.c');
const work = path.join(root, '.tmp', 'runtime-sanitizers');

const sanitize = ['-g', '-O1', '-fsanitize=address,undefined', '-fno-sanitize-recover=undefined', '-fno-omit-frame-pointer'];
const sqliteFlags = ['-DSQLITE_CORE', '-DSQLITE_THREADSAFE=0', '-DSQLITE_OMIT_LOAD_EXTENSION', '-DSQLITE_ENABLE_FTS5'];
/**
 * `release` mirrors the shipped LIKE setting. `debug` adds SQLite's own
 * assertions, which catch API misuse such as reading a value's text after a
 * conversion freed it. `blobs` drops LIKE_DOESNT_MATCH_BLOBS, the helper's
 * other branch, which no shipped build takes.
 */
const variants = {
  release: { flags: ['-DSQLITE_LIKE_DOESNT_MATCH_BLOBS'], seeds: 3, databases: 60, statements: 2000 },
  debug: { flags: ['-DSQLITE_LIKE_DOESNT_MATCH_BLOBS', '-DSQLITE_DEBUG', '-DSQLITE_ENABLE_API_ARMOR'], seeds: 1, databases: 21, statements: 1500 },
  blobs: { flags: [], seeds: 1, databases: 30, statements: 2000 }
};

/**
 * Defects the lane must catch, as exact replacements in query-plan.c. A
 * mutation whose anchor is gone fails the run, so the control arm cannot
 * silently stop covering code that was rewritten.
 */
const mutations = [
  ['pack descriptor one byte short',
    'else if (cell->tag == 4) descriptors += 5 + (sqlite3_uint64) cell->length;',
    'else if (cell->tag == 4) descriptors += 4 + (sqlite3_uint64) cell->length;'],
  ['pack text area one byte long',
    'if (cell->tag == 3) { descriptors += 9; area += (sqlite3_uint64) cell->length; }',
    'if (cell->tag == 3) { descriptors += 9; area += (sqlite3_uint64) cell->length + 1; }'],
  ['BLOB preview copies one byte past its size',
    'cell->length = (int) limit;\n                descriptors += 9 + (sqlite3_uint64) limit;',
    'cell->length = (int) limit + 1;\n                descriptors += 9 + (sqlite3_uint64) limit;'],
  ['preview splits a character at its continuation bytes',
    'while (index < length && (text[index] & 0xc0) == 0x80) index++;',
    'while (0 && index < length && (text[index] & 0xc0) == 0x80) index++;'],
  ['filter compares the first byte without folding case',
    'if (fold_ascii(*at) != first) continue;',
    'if (*at != first) continue;'],
  ['filter treats a needle with a NUL as ASCII',
    'if (!c || c >= 0x80) ascii = 0;',
    'if (c >= 0x80) ascii = 0;'],
  ['pack formats a REAL-held integer past 2^53 itself',
    'if (real > -9007199254740992.0 && real < 9007199254740992.0) {',
    'if (real > -9223372036854775808.0 && real < 9223372036854775808.0) {'],
  ['pack formats a REAL with 15 digits',
    'cell->real, "%!.*g", 17, real);',
    'cell->real, "%!.*g", 15, real);'],
  ['pack formats a REAL into less room than its check assumes',
    'sqlite3_snprintf(PACK_REAL_TEXT_ROOM, cell->real,',
    'sqlite3_snprintf(12, cell->real,']
];

function parseArguments(argv) {
  const options = { cc: process.env.CC || 'clang', mutations: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--mutations') { options.mutations = true; continue; }
    const key = { '--cc': 'cc', '--seed': 'seed', '--databases': 'databases', '--statements': 'statements' }[argument];
    if (!key || argv[index + 1] === undefined) {
      throw new Error('Usage: node scripts/test-runtime-sanitizers.mjs [--mutations] [--cc PATH] [--seed N] [--databases N] [--statements N]');
    }
    options[key] = key === 'cc' ? argv[++index] : Number(argv[++index]);
    if (key !== 'cc' && !(Number.isSafeInteger(options[key]) && options[key] > 0)) {
      throw new Error(`${argument} needs a positive integer`);
    }
  }
  return options;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with ${result.status ?? result.signal}:\n${result.stderr || result.stdout}`);
}

function runAsync(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, output }));
  });
}

/** The amalgamation the runtime builder pins; this lane must test that SQLite. */
function pinnedAmalgamation() {
  const builder = fs.readFileSync(path.join(root, 'scripts', 'build-query-plan.mjs'), 'utf8');
  const pin = builder.match(/download\('(https:\/\/sqlite\.org\/\d+\/(sqlite-amalgamation-\d+)\.zip)', zip, 'sha3-256', '([0-9a-f]{64})'\)/);
  if (!pin) throw new Error('scripts/build-query-plan.mjs no longer names the SQLite amalgamation this lane reads from it');
  return { url: pin[1], name: pin[2], sha3: pin[3] };
}

/**
 * Defects in the math schema patch that math-schema-driver.c must catch, as
 * exact replacements in the patched amalgamation.
 */
const mathMutations = [
  ['an index that depends on a math function is opened',
    '  if( sqliteExplorerIndexUsesLibm(pParse, pIdx) ){\n    sqlite3ErrorMsg(pParse, "index %s depends on a math function',
    '  if( 0 && sqliteExplorerIndexUsesLibm(pParse, pIdx) ){\n    sqlite3ErrorMsg(pParse, "index %s depends on a math function'],
  ['the unique-lookup shortcut picks such an index',
    '       || sqliteExplorerIndexUsesLibm(pWInfo->pParse, pIdx)\n      ) continue;\n',
    '      ) continue;\n'],
  ['the planner picks such an index',
    '    if( pProbe->bNoQuery || sqliteExplorerIndexUsesLibm(pWInfo->pParse, pProbe) ) continue;\n',
    '    if( pProbe->bNoQuery ) continue;\n'],
  ['IN (SELECT ...) reads such an index',
    '          if( sqliteExplorerIndexUsesLibm(pParse, pIdx) ) continue;\n',
    ''],
  ['an index on a virtual column is not traced to the table\'s generated columns',
    '  if( (w.eCode & 2)==0 ) return 0;\n  return sqliteExplorerGeneratedUsesLibm(pParse, pTab);\n',
    '  return 0;\n'],
  ['a table that stores a math column is modified',
    '  if( !IsVirtual(pTab) && sqliteExplorerTableStoresLibm(pParse, pTab) ){\n',
    '  if( 0 && !IsVirtual(pTab) && sqliteExplorerTableStoresLibm(pParse, pTab) ){\n']
];

const mathSqliteFlags = [...sqliteFlags, '-DSQLITE_ENABLE_MATH_FUNCTIONS'];

/** Compile `source` (a patched amalgamation) with the driver and return the binary. */
function buildMathDriver(options, amalgamation, source, tag, extraFlags = []) {
  const directory = path.join(work, `math-${tag}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'sqlite3.c'), source);
  const sqliteObject = path.join(directory, 'sqlite3.o');
  run(options.cc, [...sanitize, ...mathSqliteFlags, ...extraFlags, '-w', '-I', amalgamation, '-c', path.join(directory, 'sqlite3.c'), '-o', sqliteObject]);
  const driverObject = path.join(work, 'math-driver.o');
  if (!fs.existsSync(driverObject)) {
    run(options.cc, [...sanitize, '-Wall', '-Wextra', '-Werror', '-I', amalgamation, '-c', mathDriver, '-o', driverObject]);
  }
  const binary = path.join(directory, 'math-driver');
  run(options.cc, [...sanitize, sqliteObject, driverObject, '-o', binary, '-lm']);
  return binary;
}

async function fetchAmalgamation() {
  const pin = pinnedAmalgamation();
  const zip = path.join(work, `${pin.name}.zip`);
  const matches = () => fs.existsSync(zip)
    && createHash('sha3-256').update(fs.readFileSync(zip)).digest('hex') === pin.sha3;
  if (!matches()) {
    const response = await fetch(pin.url);
    if (!response.ok) throw new Error(`Download of ${pin.url} failed: ${response.status}`);
    fs.writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
    if (!matches()) {
      fs.rmSync(zip, { force: true });
      throw new Error(`${pin.url} does not have the pinned sha3-256 ${pin.sha3}`);
    }
  }
  const extracted = path.join(work, 'amalgamation');
  fs.rmSync(extracted, { recursive: true, force: true });
  fs.mkdirSync(extracted, { recursive: true });
  run('unzip', ['-q', zip, '-d', extracted]);
  return path.join(extracted, pin.name);
}

function buildVariant(options, amalgamation, name, helperSource, tag = name) {
  const { flags } = variants[name];
  const sqliteObject = path.join(work, `sqlite3-${name}.o`);
  if (!fs.existsSync(sqliteObject)) {
    run(options.cc, [...sanitize, ...sqliteFlags, ...flags, '-w', '-I', amalgamation, '-c', path.join(amalgamation, 'sqlite3.c'), '-o', sqliteObject]);
  }
  const driverObject = path.join(work, `driver-${name}.o`);
  if (!fs.existsSync(driverObject)) {
    run(options.cc, [...sanitize, '-Wall', '-Wextra', '-Werror', '-I', amalgamation, '-c', driver, '-o', driverObject]);
  }
  const helperObject = path.join(work, `query-plan-${tag}.o`);
  run(options.cc, [...sanitize, '-DSQLITE_CORE', '-Wall', '-Wextra', '-Werror', '-I', amalgamation, '-c', helperSource, '-o', helperObject]);
  const binary = path.join(work, `fuzz-${tag}`);
  run(options.cc, [...sanitize, sqliteObject, helperObject, driverObject, '-o', binary, '-lm']);
  return binary;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const amalgamation = await fetchAmalgamation();

  if (options.mutations) {
    const source = fs.readFileSync(helper, 'utf8');
    let missed = 0;
    for (const [index, [label, from, to]] of mutations.entries()) {
      if (source.split(from).length !== 2) {
        throw new Error(`Mutation "${label}" no longer matches query-plan.c exactly once; update it with the code it guards`);
      }
      const mutated = path.join(work, `mutation-${index}.c`);
      fs.writeFileSync(mutated, source.replace(from, () => to));
      const binary = buildVariant(options, amalgamation, 'release', mutated, `mutation-${index}`);
      const result = await runAsync(binary, [String(options.seed ?? 1), String(options.databases ?? 12), String(options.statements ?? 600)]);
      const caught = result.code !== 0 || result.signal !== null;
      if (!caught) missed++;
      console.log(`${caught ? 'caught' : 'MISSED'}: ${label}`);
    }
    const patched = patchSqliteMath(fs.readFileSync(path.join(amalgamation, 'sqlite3.c'), 'utf8'));
    for (const [index, [label, from, to]] of mathMutations.entries()) {
      if (patched.split(from).length !== 2) {
        throw new Error(`Mutation "${label}" no longer matches the patched amalgamation exactly once; update it with the patch it guards`);
      }
      const binary = buildMathDriver(options, amalgamation, patched.replace(from, () => to), `mutation-${index}`);
      const result = await runAsync(binary, []);
      const caught = result.code !== 0 || result.signal !== null;
      if (!caught) missed++;
      console.log(`${caught ? 'caught' : 'MISSED'}: ${label}`);
    }
    if (missed > 0) throw new Error(`${missed} injected defect(s) passed the sanitizer lane`);
    console.log(`All ${mutations.length + mathMutations.length} injected defects were caught.`);
    return;
  }

  const runs = [];
  for (const [name, variant] of Object.entries(variants)) {
    const binary = buildVariant(options, amalgamation, name, helper);
    for (let index = 0; index < variant.seeds; index++) {
      const seed = (options.seed ?? 1) + index * 1000 + name.length;
      runs.push(runAsync(binary, [String(seed), String(options.databases ?? variant.databases), String(options.statements ?? variant.statements)])
        .then(result => ({ name, seed, ...result })));
    }
  }
  let failed = 0;
  for (const result of await Promise.all(runs)) {
    const summary = result.output.trim().split('\n').pop() ?? '';
    // The driver exits non-zero on any failed check; this also requires that it
    // reached its summary and that at least half its statements were distinct,
    // so a generator that starts repeating itself cannot pass as coverage.
    const counts = /(\d+) statements \((\d+) distinct inputs\)/.exec(summary);
    const ok = result.code === 0 && result.signal === null && counts !== null
      && Number(counts[2]) * 2 >= Number(counts[1]);
    if (!ok) {
      failed++;
      console.error(`--- ${result.name} seed ${result.seed}: exit ${result.code ?? result.signal}\n${result.output.slice(-6000)}`);
    } else {
      console.log(`${result.name}: ${summary}`);
    }
  }
  // The amalgamation as the WebAssembly build patches it, without and with
  // SQLite's own assertions.
  const patched = patchSqliteMath(fs.readFileSync(path.join(amalgamation, 'sqlite3.c'), 'utf8'));
  for (const [tag, extraFlags] of [['release', []], ['debug', ['-DSQLITE_DEBUG', '-DSQLITE_ENABLE_API_ARMOR']]]) {
    const result = await runAsync(buildMathDriver(options, amalgamation, patched, tag, extraFlags), []);
    if (result.code !== 0 || result.signal !== null || !/math schema checks passed/.test(result.output)) {
      failed++;
      console.error(`--- math schema ${tag}: exit ${result.code ?? result.signal}\n${result.output.slice(-6000)}`);
    } else {
      console.log(`math schema ${tag}: ${result.output.trim().split('\n').pop()}`);
    }
  }
  if (failed > 0) throw new Error(`${failed} sanitizer run(s) failed`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
