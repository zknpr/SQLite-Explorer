/** Build the bounded plan reader from authored C and an immutable sql.js base. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPinnedArtifactPolicy } from './lib/pinned-artifacts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceCommit = '3181cc5ee888d3251228d3995c32bf9ea03c3240';
const manifestPath = 'vendor/query-plan-manifest.json';
const sourceFiles = ['src/runtime/query-plan.c', 'scripts/build-query-plan.mjs'];
const nativeTargets = [
  ['aarch64-macos', 'aarch64-macos', 'dylib'],
  ['x86_64-macos', 'x86_64-macos', 'dylib'],
  ['x86_64-linux-gnu', 'x86_64-linux-gnu.2.28', 'so'],
  ['aarch64-linux-gnu', 'aarch64-linux-gnu.2.28', 'so'],
  ['x86_64-windows', 'x86_64-windows-gnu', 'dll']
];
const wasmCopies = {
  'sql-wasm.js': ['vendor/sql.js/sql-wasm.js', 'website/public/sqlite-viewer/sql-wasm.js'],
  'sql-wasm.wasm': ['vendor/sql.js/sql-wasm.wasm', 'assets/sqlite3.wasm', 'website/public/sqlite-viewer/sql-wasm.wasm']
};
const outputFiles = [...Object.values(wasmCopies).flat(), ...nativeTargets.map(([triple, , extension]) => `natives/${triple}/query-plan.${extension}`)];
const hash = contents => createHash('sha256').update(contents).digest('hex');
// Exact identities, not substrings: a different Emscripten commit or a Zig
// distribution with another bundled LLVM produces different bytes.
const expectedEmcc = 'emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 5.0.0 (a7c5deabd7c88ba1c38ebe988112256775f944c6)';
const expectedZigVersion = '0.16.0';
const expectedZigClang = 'clang version 21.1.0';

export function verifyQueryPlanArtifacts(directory = root, { includeBuildAssets = true } = {}) {
  const manifest = JSON.parse(readFileSync(path.join(directory, manifestPath), 'utf8'));
  if (manifest.schema !== 1 || manifest.sqlJsCommit !== sourceCommit) throw new Error('Invalid query-plan runtime provenance.');
  for (const [field, files] of [['inputs', sourceFiles], ['outputs', outputFiles]]) {
    const entries = manifest[field];
    if (!entries || Object.keys(entries).sort().join('\n') !== [...files].sort().join('\n')) throw new Error(`Invalid query-plan ${field} inventory.`);
    for (const file of files) {
      // A clean extension build recreates this ignored copy from the verified
      // vendor runtime. The build checks it again after copying assets.
      if (!includeBuildAssets && file === 'assets/sqlite3.wasm') continue;
      if (hash(readFileSync(path.join(directory, file))) !== entries[file]) {
        throw new Error(`Query-plan artifact drift: ${file}. Run node scripts/build-query-plan.mjs to rebuild from source.`);
      }
    }
  }
  return manifest;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
}

async function download(url, destination, algorithm, expectedHash) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const contents = Buffer.from(await response.arrayBuffer());
  if (createHash(algorithm).update(contents).digest('hex') !== expectedHash) throw new Error(`Source checksum mismatch: ${url}`);
  writeFileSync(destination, contents);
}

export async function buildQueryPlanRuntime(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--check') { verifyQueryPlanArtifacts(); console.log('Query-plan runtime inputs and all generated copies match.'); return; }
  const options = { emcc: process.env.EMCC || 'emcc', zig: process.env.ZIG || 'zig', source: undefined };
  for (let index = 0; index < args.length; index += 2) {
    const key = { '--emcc': 'emcc', '--zig': 'zig', '--sqljs-source': 'source' }[args[index]];
    if (!key || !args[index + 1]) throw new Error('Usage: node scripts/build-query-plan.mjs [--check] [--emcc PATH] [--zig PATH] [--sqljs-source GIT_CHECKOUT]');
    options[key] = args[index + 1];
  }
  // Resolve once so every child process runs the same tool whatever its cwd.
  // Either separator marks a path on Windows; a bare name stays a PATH lookup.
  for (const tool of ['emcc', 'zig']) if (/[\\/]/.test(options[tool])) options[tool] = path.resolve(options[tool]);
  const emccVersion = String(run(options.emcc, ['--version'], { stdio: 'pipe' })).split('\n')[0].trim();
  if (emccVersion !== expectedEmcc) {
    throw new Error(`Reproducible runtime builds require Emscripten 5.0.0 ("${expectedEmcc}"); found "${emccVersion}".`);
  }
  const zigVersion = String(run(options.zig, ['version'], { stdio: 'pipe' })).trim();
  if (zigVersion !== expectedZigVersion) {
    throw new Error(`Reproducible runtime builds require the official Zig ${expectedZigVersion} release; found "${zigVersion}".`);
  }
  const inputs = Object.fromEntries(sourceFiles.map(file => [file, hash(readFileSync(path.join(root, file)))]));
  mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const build = mkdtempSync(path.join(root, '.tmp/query-plan-build-'));
  try {
    // Linux outputs record the linker identity in .comment, so only the official
    // Zig 0.16.0 release (bundled LLVM 21.1.0) reproduces the pinned bytes.
    // Distribution builds such as Homebrew's report the same `zig version`.
    // `zig cc --version` also writes an empty a.o, so it runs in the build dir.
    const zigClang = String(run(options.zig, ['cc', '--version'], { stdio: 'pipe', cwd: build })).split('\n')[0].trim();
    if (zigClang !== expectedZigClang) {
      throw new Error(`Reproducible runtime builds require the official Zig ${expectedZigVersion} release ` +
        `(zig cc must report "${expectedZigClang}"); found "${zigClang}".`);
    }
    let checkout = options.source && path.resolve(options.source);
    if (!checkout) {
      checkout = path.join(build, 'upstream');
      run('git', ['clone', '--no-checkout', '--filter=blob:none', 'https://github.com/zknpr/sql.js.git', checkout]);
    }
    const archive = run('git', ['-C', checkout, 'archive', '--format=tar', sourceCommit], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
    const source = path.join(build, 'source'); mkdirSync(source);
    run('tar', ['-xf', '-', '-C', source], { input: archive, stdio: ['pipe', 'inherit', 'inherit'] });
    const sqliteSource = path.join(source, 'sqlite-src'); mkdirSync(sqliteSource, { recursive: true });
    const zip = path.join(build, 'sqlite.zip');
    await download('https://sqlite.org/2026/sqlite-amalgamation-3540100.zip', zip, 'sha3-256', '92281c86e2957f9b9305890f9ac04204caa7b677cc868dc326d942689df28e30');
    run('unzip', ['-q', zip, '-d', sqliteSource]);
    const headers = path.join(sqliteSource, 'sqlite-amalgamation-3540100');
    await download('https://www.sqlite.org/contrib/download/extension-functions.c?get=25', path.join(headers, 'extension-functions.c'), 'sha1', 'c68fa706d6d9ff98608044c00212473f9c14892f');
    const helper = path.join(root, sourceFiles[0]);
    const outputs = new Map();
    for (const [triple, target, extension] of nativeTargets) {
      const library = path.join(build, `query-plan-${triple}.${extension}`);
      const linker = extension === 'dylib' ? ['-Wl,-install_name,@rpath/query-plan.dylib'] : [];
      // Windows needs the toolchain's DLL startup and stack-probe support.
      const runtime = extension === 'dll' ? [] : ['-nostdlib', '-ffreestanding', '-fno-builtin'];
      run(options.zig, ['cc', '-target', target, '-shared', ...runtime,
        '-fPIC', '-Oz', '-Wall', '-Wextra', '-Werror', ...linker, '-I', headers, helper, '-o', library]);
      outputs.set(`natives/${triple}/query-plan.${extension}`, readFileSync(library));
    }
    const out = path.join(source, 'out'), dist = path.join(source, 'dist');
    mkdirSync(out, { recursive: true }); mkdirSync(dist, { recursive: true });
    // extension-functions.c asserts embed __FILE__; map the random build
    // directory (and the checkout) to fixed names so outputs reproduce.
    const prefixMaps = [`-ffile-prefix-map=${build}=/query-plan-build`, `-ffile-prefix-map=${root}=/sqlite-explorer`];
    const compileFlags = ['-Oz', ...prefixMaps, '-DSQLITE_OMIT_LOAD_EXTENSION', '-DSQLITE_DISABLE_LFS', '-DSQLITE_ENABLE_FTS3', '-DSQLITE_ENABLE_FTS3_PARENTHESIS',
      '-DSQLITE_ENABLE_FTS5', '-DSQLITE_THREADSAFE=0', '-DSQLITE_ENABLE_NORMALIZE', '-DSQLITE_LIKE_DOESNT_MATCH_BLOBS'];
    for (const [input, name, flags] of [
      [path.join(headers, 'sqlite3.c'), 'sqlite3', compileFlags],
      [path.join(headers, 'extension-functions.c'), 'extension-functions', compileFlags],
      [path.join(source, 'src/vfs.c'), 'vfs', compileFlags],
      [helper, 'query-plan', ['-Oz', ...prefixMaps, '-DSQLITE_CORE']]
    ]) run(options.emcc, [...flags, '-I', headers, '-c', input, '-o', path.join(out, `${name}.o`)]);
    const exportsPath = path.join(source, 'src/exported_functions.json');
    const exported = JSON.parse(readFileSync(exportsPath, 'utf8'));
    exported.push('_sqlite_explorer_register_query_plan');
    writeFileSync(exportsPath, JSON.stringify(exported));
    // The Makefile's object prerequisites download tools that are unnecessary
    // here: all three upstream sources were verified and compiled above.
    run('make', ['dist/sql-wasm.js', `EMCC=${options.emcc.includes(path.sep) ? path.resolve(options.emcc) : options.emcc}`, 'BITCODE_FILES=out/sqlite3.o out/extension-functions.o out/vfs.o out/query-plan.o',
      '-o', 'out/sqlite3.o', '-o', 'out/extension-functions.o', '-o', 'out/vfs.o'], { cwd: source });
    for (const [file, copies] of Object.entries(wasmCopies)) {
      const contents = readFileSync(path.join(dist, file));
      for (const copy of copies) outputs.set(copy, contents);
    }
    for (const file of sourceFiles) if (hash(readFileSync(path.join(root, file))) !== inputs[file]) throw new Error(`Source changed during runtime build: ${file}`);
    const manifest = { schema: 1, sqlJsCommit: sourceCommit, emcc: emccVersion, zig: zigVersion, zigClang, inputs,
      outputs: Object.fromEntries([...outputs].map(([file, contents]) => [file, hash(contents)])) };
    outputs.set(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
    // Reuse only the rollback-protected installer. The manifest above is this
    // source build's provenance; a local build has no Actions run to pin.
    const { installArtifacts } = createPinnedArtifactPolicy({ scriptName: 'build-query-plan.mjs', repository: 'zknpr/sql.js',
      sourceBranch: 'master', sourceCommit, pinnedRunId: null, expectedArtifactPaths: {} });
    installArtifacts([...outputs].map(([file, contents]) => ({ destination: path.join(root, file), contents, expectedHash: hash(contents) })));
    verifyQueryPlanArtifacts();
    console.log('Built and verified WASM query-plan support and five native libraries.');
  } finally { rmSync(build, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildQueryPlanRuntime().catch(error => { console.error(error); process.exitCode = 1; });
}
