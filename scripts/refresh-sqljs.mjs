/**
 * Refresh the pinned sql.js progress-interrupt fork artifacts.
 *
 * Default usage downloads every artifact from the pinned GitHub Actions run,
 * then selects the pair whose hashes match below:
 *   node scripts/refresh-sqljs.mjs
 *
 * Maintainers can verify an already-downloaded artifact without network access:
 *   node scripts/refresh-sqljs.mjs --from /path/to/extracted/artifact
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'zknpr/sql.js';
const RUN_ID = 31250407828;
const PINNED_SHA256 = Object.freeze({
  'sql-wasm.js': '30df84f792be9c294db6c5dde68b377f4d76d258c0ee954fd14a0f4ef60687b6',
  'sql-wasm.wasm': 'a99d3385b30415a99475fdeb6251a89127a3b4c4260604d811e5c91b4e9dc231'
});

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function findFiles(root, filename) {
  const matches = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && entry.name === filename) matches.push(entryPath);
    }
  };
  visit(root);
  return matches;
}

function findPinnedArtifactPair(root) {
  const observed = [];
  for (const gluePath of findFiles(root, 'sql-wasm.js')) {
    const wasmPath = path.join(path.dirname(gluePath), 'sql-wasm.wasm');
    let wasmContents;
    try {
      wasmContents = readFileSync(wasmPath);
    } catch {
      continue;
    }
    const glueContents = readFileSync(gluePath);
    const glueHash = sha256(glueContents);
    const wasmHash = sha256(wasmContents);
    observed.push(`${path.dirname(gluePath)} (${glueHash}, ${wasmHash})`);
    if (
      glueHash === PINNED_SHA256['sql-wasm.js'] &&
      wasmHash === PINNED_SHA256['sql-wasm.wasm']
    ) {
      return { glueContents, wasmContents };
    }
  }

  const detail = observed.length > 0
    ? ` Candidates: ${observed.join('; ')}`
    : ' No directory contained both sql-wasm.js and sql-wasm.wasm.';
  throw new Error(`Pinned sql.js artifact pair was not found.${detail}`);
}

function atomicWrite(destination, contents, expectedHash) {
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, contents);
    const actualHash = sha256(readFileSync(temporary));
    if (actualHash !== expectedHash) {
      throw new Error(`Refusing to install ${destination}: expected ${expectedHash}, received ${actualHash}`);
    }
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function refreshCopies(pair) {
  const destinations = {
    'sql-wasm.js': [
      path.join(repositoryRoot, 'vendor', 'sql.js', 'sql-wasm.js'),
      path.join(repositoryRoot, 'website', 'public', 'sqlite-viewer', 'sql-wasm.js')
    ],
    'sql-wasm.wasm': [
      path.join(repositoryRoot, 'vendor', 'sql.js', 'sql-wasm.wasm'),
      path.join(repositoryRoot, 'assets', 'sqlite3.wasm'),
      path.join(repositoryRoot, 'website', 'public', 'sqlite-viewer', 'sql-wasm.wasm')
    ]
  };

  for (const destination of destinations['sql-wasm.js']) {
    atomicWrite(destination, pair.glueContents, PINNED_SHA256['sql-wasm.js']);
  }
  for (const destination of destinations['sql-wasm.wasm']) {
    atomicWrite(destination, pair.wasmContents, PINNED_SHA256['sql-wasm.wasm']);
  }
}

function parseSourceArgument() {
  const args = process.argv.slice(2);
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === '--from') return path.resolve(args[1]);
  throw new Error('Usage: node scripts/refresh-sqljs.mjs [--from /path/to/extracted/artifact]');
}

function main() {
  const suppliedSource = parseSourceArgument();
  let temporaryDownload;
  try {
    let artifactRoot = suppliedSource;
    if (!artifactRoot) {
      temporaryDownload = mkdtempSync(path.join(tmpdir(), 'sqlite-explorer-sqljs-'));
      execFileSync(
        'gh',
        [
          'run',
          'download',
          String(RUN_ID),
          '--repo',
          REPOSITORY,
          '--dir',
          temporaryDownload
        ],
        { stdio: 'inherit' }
      );
      artifactRoot = temporaryDownload;
    }

    const pair = findPinnedArtifactPair(artifactRoot);
    refreshCopies(pair);
    console.log(`Refreshed pinned sql.js artifacts from ${REPOSITORY} Actions run ${RUN_ID}.`);
  } finally {
    if (temporaryDownload) {
      rmSync(temporaryDownload, { recursive: true, force: true });
    }
  }
}

main();
