import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (process.cwd() !== root) throw new Error(`Run from the intended checkout: ${root}`);
const args = process.argv.slice(2);
const take = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const allowed = new Set(['--payload-mib', '--fixture', '--backend', '--reuse', '--generate-only', '--prebuilt-runtime', '--build-runtime-only']);
for (let index = 0; index < args.length; index++) {
  if (!allowed.has(args[index])) throw new Error(`Unknown argument ${args[index]}`);
  if (!['--reuse', '--generate-only'].includes(args[index])) {
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${args[index]}`);
    index++;
  }
}
const prebuiltRuntime = take('--prebuilt-runtime');
const buildRuntimeOnly = take('--build-runtime-only');
if (prebuiltRuntime && buildRuntimeOnly) throw new Error('--prebuilt-runtime and --build-runtime-only cannot be combined');
const payloadMiB = Number(take('--payload-mib') ?? 16384);
if (!Number.isSafeInteger(payloadMiB) || payloadMiB < 16 || payloadMiB > 16384) throw new Error('--payload-mib must be an integer from 16 to 16384');
const backend = take('--backend') ?? 'both';
if (!['native', 'wasm', 'both'].includes(backend)) throw new Error('--backend must be native, wasm or both');
const payloadBytes = payloadMiB * 1024 * 1024;
const fixture = path.resolve(take('--fixture') ?? path.join(root, '.tmp/full-extension-qa/large-db', `live-${payloadMiB}mib.sqlite`));
function requireInsideCheckout(filename) {
  const relative = path.relative(root, filename);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Task-owned fixture and runtime outputs must be inside this checkout');
  }
}
requireInsideCheckout(fixture);
const directory = path.dirname(fixture);
const requiredFreeBytes = payloadBytes * (args.includes('--reuse') ? 2 : 3) + 1024 ** 3;
if (!buildRuntimeOnly) {
  await fs.mkdir(directory, { recursive: true });
  const available = await fs.statfs(directory);
  if (Number(available.bavail) * Number(available.bsize) < requiredFreeBytes) {
    throw new Error(`Require ${requiredFreeBytes} free bytes for ${args.includes('--reuse') ? 'remaining atomic-save headroom' : 'fixture and atomic-save headroom'}`);
  }
}
const runtime = buildRuntimeOnly ? path.resolve(buildRuntimeOnly) : path.join(directory, `runtime-${process.pid}`);
requireInsideCheckout(runtime);
await fs.mkdir(runtime, { recursive: true });
if ((await fs.readdir(runtime)).length !== 0) throw new Error('The runtime output directory must be empty');
const hashFile = async filename => createHash('sha256').update(await fs.readFile(filename)).digest('hex');
const toPortablePath = filename => filename.split(path.sep).join('/');
let runtimeManifest;

if (prebuiltRuntime) {
  const source = path.resolve(prebuiltRuntime);
  runtimeManifest = JSON.parse(await fs.readFile(path.join(source, 'runtime-manifest.json'), 'utf8'));
  if (runtimeManifest.schema !== 'large-database-runtime/v1') throw new Error('Unsupported prebuilt runtime manifest');
  for (const required of ['large-database.cjs', 'worker.cjs', 'assets/sqlite3.wasm']) {
    if (!runtimeManifest.artifactHashes?.[required]) throw new Error(`Prebuilt runtime is missing ${required}`);
  }
  for (const [filename, hash] of Object.entries(runtimeManifest.artifactHashes)) {
    if (path.posix.isAbsolute(filename) || filename.split('/').some(part => !part || part === '.' || part === '..') || filename.includes('\\')) {
      throw new Error(`Invalid runtime artifact path: ${filename}`);
    }
    if (await hashFile(path.join(source, filename)) !== hash) throw new Error(`Prebuilt runtime hash mismatch: ${filename}`);
    const target = path.join(runtime, filename);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(source, filename), target);
    if (await hashFile(target) !== hash) throw new Error(`Copied runtime hash mismatch: ${filename}`);
  }
} else {
  const esbuild = await import('esbuild');
  await fs.mkdir(path.join(runtime, 'assets'), { recursive: true });
  await fs.copyFile(path.join(root, 'vendor/sql.js/sql-wasm.wasm'), path.join(runtime, 'assets/sqlite3.wasm'));
  const hostServicePlugin = {
    name: 'large-database-vscode-services',
    setup(build) {
      build.onResolve({ filter: /^vscode$/ }, () => ({ path: path.join(root, 'tests/performance/helpers/large-database-vscode.cjs') }));
      build.onResolve({ filter: /^\.\/main$/ }, () => ({ path: 'large-db-log', namespace: 'qa' }));
      build.onLoad({ filter: /.*/, namespace: 'qa' }, () => ({
        contents: 'export const GlobalOutputChannel = { appendLine(message) { console.log("LARGE_DATABASE_LOG " + message); } };', loader: 'js'
      }));
    }
  };
  const buildOptions = { bundle: true, platform: 'node', format: 'cjs', target: 'es2022', minify: false, metafile: true,
    external: ['worker_threads', 'node:v8'], loader: { '.bin': 'file' },
    define: { 'import.meta.env.VSCODE_BROWSER_EXT': 'false', 'import.meta.env.DEV': 'false',
      'import.meta.env.VITE_VSCODE': 'true', 'import.meta.url': '"file:./assets/"' } };
  const workerBuild = await esbuild.build({ ...buildOptions, entryPoints: [path.join(root, 'src/databaseWorker.ts')], outfile: path.join(runtime, 'worker.cjs') });
  const helperBuild = await esbuild.build({ ...buildOptions, entryPoints: [path.join(root, 'tests/performance/helpers/large-database-runtime.ts')],
    outfile: path.join(runtime, 'large-database.cjs'), plugins: [hostServicePlugin] });
  const sourceHashes = {};
  const inputs = new Set([...Object.keys(workerBuild.metafile.inputs), ...Object.keys(helperBuild.metafile.inputs),
    'vendor/sql.js/sql-wasm.wasm', 'tests/performance/large_database_characterization.mjs']);
  for (const filename of [...inputs].sort()) {
    if (filename.startsWith('qa:')) continue; // This virtual logging shim is defined in the hashed runner.
    sourceHashes[toPortablePath(filename)] = await hashFile(path.resolve(root, filename));
  }
  const nativeAssetHashes = {};
  for (const filename of (await fs.readdir(path.join(root, 'natives'), { recursive: true })).sort()) {
    if (/(?:^|[/\\])(?:native-worker\.js|tjs(?:\.exe)?|query-plan\.(?:dll|dylib|so))$/.test(filename)) {
      nativeAssetHashes[`natives/${toPortablePath(filename)}`] = await hashFile(path.join(root, 'natives', filename));
    }
  }
  const artifactHashes = {};
  for (const filename of (await fs.readdir(runtime, { recursive: true })).sort()) {
    if ((await fs.stat(path.join(runtime, filename))).isFile()) artifactHashes[toPortablePath(filename)] = await hashFile(path.join(runtime, filename));
  }
  runtimeManifest = { schema: 'large-database-runtime/v1', builtAt: new Date().toISOString(),
    build: { root, node: process.version, platform: process.platform, arch: process.arch, esbuild: esbuild.version },
    sourceHashes, nativeAssetHashes, artifactHashes };
}
await fs.writeFile(path.join(runtime, 'runtime-manifest.json'), JSON.stringify(runtimeManifest, null, 2) + '\n');
if (buildRuntimeOnly) {
  console.log(`Portable runtime: ${runtime}`);
  process.exit(0);
}

const nativePlatform = { darwin: 'macos', linux: 'linux-gnu', win32: 'windows' }[process.platform];
const nativeArch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch];
if (!nativePlatform || !nativeArch) throw new Error('Unsupported native platform for characterization');
const nativeDirectory = `natives/${nativeArch}-${nativePlatform}`;
const liveNativeAssetHashes = {};
for (const filename of ['natives/native-worker.js', `${nativeDirectory}/${process.platform === 'win32' ? 'tjs.exe' : 'tjs'}`,
  `${nativeDirectory}/query-plan.${process.platform === 'darwin' ? 'dylib' : process.platform === 'win32' ? 'dll' : 'so'}`]) {
  const hash = await hashFile(path.join(root, filename));
  if (runtimeManifest.nativeAssetHashes[filename] !== hash) throw new Error(`Native asset differs from frozen runtime build: ${filename}`);
  liveNativeAssetHashes[filename] = hash;
}

const runFile = promisify(execFile);
const processRuns = [];
async function run(mode) {
  const started = performance.now();
  const logfile = `${fixture}.${mode}.log`;
  const output = await fs.open(logfile, 'w');
  const config = { mode, root, runtime, fixture, payloadBytes, generationTimeoutMs: 15 * 60 * 1000 };
  const child = spawn(process.execPath, [path.join(runtime, 'large-database.cjs'), JSON.stringify(config)], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe']
  });
  let collected = '';
  let writeTail = Promise.resolve();
  const sampled = new Map();
  let sampling = false;
  async function sample() {
    if (sampling || process.platform === 'win32' || !child.pid) return;
    sampling = true;
    try {
      const { stdout } = await runFile('ps', ['-axo', 'pid=,ppid=,rss='], { timeout: 4000 });
      const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
      const descendants = new Set([child.pid]);
      for (let pass = 0; pass < 4; pass++) for (const [pid, parent] of rows) if (descendants.has(parent)) descendants.add(pid);
      for (const [pid, parent, rssKiB] of rows) if (descendants.has(pid)) {
        const prior = sampled.get(pid);
        sampled.set(pid, { pid, parentPid: parent, role: pid === child.pid ? 'node-host-including-WASM-thread' : 'native-child-or-descendant',
          sampledPeakRssBytes: Math.max(prior?.sampledPeakRssBytes ?? 0, rssKiB * 1024) });
      }
    } catch (error) {
      sampled.set('sampler-error', { error: error.message });
    } finally { sampling = false; }
  }
  const samplingIntervalMs = mode === 'generate' ? 1000 : 100;
  const interval = setInterval(() => { void sample(); }, samplingIntervalMs);
  await sample();
  const handle = data => {
    const text = data.toString();
    collected += text;
    writeTail = writeTail.then(() => output.write(text));
    process.stdout.write(text);
  };
  child.stdout.on('data', handle); child.stderr.on('data', handle);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }, 20 * 60 * 1000);
  const outcome = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearInterval(interval); clearTimeout(timer);
  await writeTail;
  await output.close();
  const run = { mode, ...outcome, timedOut, elapsedMs: performance.now() - started, logfile,
    memorySampling: process.platform === 'win32' ? 'native-child sampling unavailable; Node resourceUsage remains recorded' : `${samplingIntervalMs} ms process-specific RSS samples, not an exact peak`,
    sampledProcesses: [...sampled.values()], finalPassMarker: collected.includes(mode === 'generate' ? '"event":"fixture-ready"' : '"event":"characterization-pass"') };
  processRuns.push(run);
  await fs.writeFile(`${fixture}.runs.json`, JSON.stringify(processRuns, null, 2) + '\n');
  if (outcome.code !== 0 || timedOut || !run.finalPassMarker) throw new Error(`${mode} failed; see ${logfile}`);
}

await fs.writeFile(`${fixture}.environment.json`, JSON.stringify({ root, runtime, fixture, payloadBytes,
  node: process.version, platform: process.platform, arch: process.arch, totalPhysicalMemoryBytes: os.totalmem(),
  timeCaps: { generationMs: 15 * 60 * 1000, eachProcessMs: 20 * 60 * 1000 },
  config: { maxFileSize: 0, queryTimeoutMs: 60000, wasmTestPagingThresholdBytes: 8 * 1024 * 1024, requiredFreeBytes },
  runtimeMode: prebuiltRuntime ? 'prebuilt' : 'source-built', runtimeManifest,
  hashes: runtimeManifest.sourceHashes, liveNativeAssetHashes,
  runnerSha256: await hashFile(fileURLToPath(import.meta.url)),
  caveat: 'Production native adapter and source-built production workerFactory/worker. VS Code services are adapted to real host I/O. No VS Code UI or cold-cache claim.' }, null, 2) + '\n');

if (!args.includes('--reuse')) await run('generate');
else {
  const metadata = JSON.parse(await fs.readFile(`${fixture}.meta.json`, 'utf8'));
  if (metadata.livePayloadBytes !== payloadBytes) throw new Error('Reused fixture payload does not match --payload-mib');
}
if (!args.includes('--generate-only')) for (const mode of backend === 'both' ? ['native', 'wasm'] : [backend]) await run(mode);
console.log(`Large database artifacts: ${fixture}.*`);
