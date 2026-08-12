/**
 * Refresh the exact sql.js security-fix workflow artifacts.
 *
 * Default usage re-validates the pinned GitHub Actions run before download:
 *   node scripts/refresh-sqljs.mjs
 *
 * An already-downloaded artifact can be verified without network access only
 * when its complete pinned provenance is supplied explicitly:
 *   node scripts/refresh-sqljs.mjs --from /path/to/run-artifacts \
 *     --run 31639875548 --branch agent/paged-vfs-attach-isolation \
 *     --commit 653366ed214563ea95a57b34c92986b6ff584c23
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
const SOURCE_BRANCH = 'agent/paged-vfs-attach-isolation';
const SOURCE_COMMIT = '653366ed214563ea95a57b34c92986b6ff584c23';
const PINNED_RUN_ID = '31639875548';
const PINNED_SHA256 = Object.freeze({
  'sql-wasm.js': 'd1eb9397c3e0cc22c0eae5d017274ea45f3f56b89acc77671d943fc4538b9a5f',
  'sql-wasm.wasm': 'bd2d54f78e35d1428ec640633c7c7677cb92b88e08ead911818016750e966fc4'
});
const EXPECTED_ARTIFACT_PATHS = Object.freeze({
  'dist/sql-wasm.js': PINNED_SHA256['sql-wasm.js'],
  'dist/sql-wasm.wasm': PINNED_SHA256['sql-wasm.wasm']
});
const PAYLOAD_FILENAMES = new Set(Object.keys(PINNED_SHA256));

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function portableRelative(root, entryPath) {
  return path.relative(root, entryPath).split(path.sep).join('/');
}

function listPayloadPaths(root) {
  const matches = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (PAYLOAD_FILENAMES.has(entry.name)) {
        if (!entry.isFile()) {
          throw new Error(
            `Artifact manifest contains a non-regular payload: ${portableRelative(root, entryPath)}`
          );
        }
        matches.push(portableRelative(root, entryPath));
      }
    }
  };
  visit(root);
  return matches.sort();
}

function readPinnedArtifacts(root) {
  const expectedPaths = Object.keys(EXPECTED_ARTIFACT_PATHS).sort();
  const observedPaths = listPayloadPaths(root);
  if (
    expectedPaths.length !== observedPaths.length ||
    expectedPaths.some((expectedPath, index) => expectedPath !== observedPaths[index])
  ) {
    throw new Error(
      `Artifact manifest mismatch: expected exactly ${expectedPaths.join(', ')}; ` +
      `received ${observedPaths.length > 0 ? observedPaths.join(', ') : '(none)'}`
    );
  }

  const artifacts = new Map();
  for (const [artifactPath, expectedHash] of Object.entries(EXPECTED_ARTIFACT_PATHS)) {
    const contents = readFileSync(path.join(root, ...artifactPath.split('/')));
    const actualHash = sha256(contents);
    if (actualHash !== expectedHash) {
      throw new Error(
        `SHA-256 mismatch for ${artifactPath}: expected ${expectedHash}, received ${actualHash}`
      );
    }
    artifacts.set(artifactPath, contents);
  }
  return artifacts;
}

function atomicWrite(destination, contents, expectedHash) {
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, contents);
    const actualHash = sha256(readFileSync(temporary));
    if (actualHash !== expectedHash) {
      throw new Error(
        `Refusing to install ${destination}: expected ${expectedHash}, received ${actualHash}`
      );
    }
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function refreshCopies(artifacts) {
  const destinations = {
    'dist/sql-wasm.js': [
      path.join(repositoryRoot, 'vendor', 'sql.js', 'sql-wasm.js'),
      path.join(repositoryRoot, 'website', 'public', 'sqlite-viewer', 'sql-wasm.js')
    ],
    'dist/sql-wasm.wasm': [
      path.join(repositoryRoot, 'vendor', 'sql.js', 'sql-wasm.wasm'),
      path.join(repositoryRoot, 'assets', 'sqlite3.wasm'),
      path.join(repositoryRoot, 'website', 'public', 'sqlite-viewer', 'sql-wasm.wasm')
    ]
  };

  for (const [artifactPath, artifactDestinations] of Object.entries(destinations)) {
    const contents = artifacts.get(artifactPath);
    const expectedHash = EXPECTED_ARTIFACT_PATHS[artifactPath];
    for (const destination of artifactDestinations) {
      atomicWrite(destination, contents, expectedHash);
    }
  }
}

function readValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function parseArguments() {
  const args = process.argv.slice(2);
  if (args.length === 0) return { suppliedSource: undefined };

  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!['--from', '--run', '--branch', '--commit'].includes(option)) {
      throw new Error(
        'Usage: node scripts/refresh-sqljs.mjs [--from path --run run-id ' +
        '--branch branch --commit 40-character-sha]'
      );
    }
    if (values.has(option)) throw new Error(`${option} may be specified only once`);
    values.set(option, readValue(args, index, option));
    index += 1;
  }

  if (!values.has('--from')) {
    throw new Error('--run, --branch, and --commit are accepted only with --from');
  }
  if (!values.has('--run') || !values.has('--branch') || !values.has('--commit')) {
    throw new Error('--run, --branch, and --commit are required with --from');
  }

  const runId = values.get('--run');
  const branch = values.get('--branch');
  const commit = values.get('--commit');
  if (!/^\d+$/.test(runId)) throw new Error(`Invalid workflow run id: ${runId}`);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Invalid source commit: ${commit}`);
  if (runId !== PINNED_RUN_ID) {
    throw new Error(`Refusing local artifacts: expected run ${PINNED_RUN_ID}, received ${runId}`);
  }
  if (branch !== SOURCE_BRANCH) {
    throw new Error(`Refusing local artifacts: expected branch ${SOURCE_BRANCH}, received ${branch}`);
  }
  if (commit !== SOURCE_COMMIT) {
    throw new Error(`Refusing local artifacts: expected commit ${SOURCE_COMMIT}, received ${commit}`);
  }

  return { suppliedSource: path.resolve(values.get('--from')) };
}

function readPinnedRunMetadata() {
  const output = execFileSync(
    'gh',
    [
      'run',
      'view',
      PINNED_RUN_ID,
      '--repo',
      REPOSITORY,
      '--json',
      'headBranch,headSha,conclusion'
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
  );
  let metadata;
  try {
    metadata = JSON.parse(output);
  } catch (error) {
    throw new Error(`Run ${PINNED_RUN_ID} returned invalid metadata JSON`, { cause: error });
  }

  const commit = String(metadata.headSha ?? '').toLowerCase();
  if (metadata.headBranch !== SOURCE_BRANCH) {
    throw new Error(
      `Refusing run ${PINNED_RUN_ID}: expected branch ${SOURCE_BRANCH}, ` +
      `received ${metadata.headBranch ?? '(missing)'}`
    );
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`Run ${PINNED_RUN_ID} did not report a valid headSha`);
  }
  if (commit !== SOURCE_COMMIT) {
    throw new Error(
      `Refusing run ${PINNED_RUN_ID}: expected commit ${SOURCE_COMMIT}, received ${commit}`
    );
  }
  if (metadata.conclusion !== 'success') {
    throw new Error(
      `Refusing run ${PINNED_RUN_ID}: expected conclusion success, ` +
      `received ${metadata.conclusion ?? '(missing)'}`
    );
  }
}

function main() {
  const { suppliedSource } = parseArguments();
  let temporaryDownload;
  try {
    let artifactRoot = suppliedSource;
    if (!artifactRoot) {
      readPinnedRunMetadata();
      temporaryDownload = mkdtempSync(path.join(tmpdir(), 'sqlite-explorer-sqljs-'));
      execFileSync(
        'gh',
        [
          'run',
          'download',
          PINNED_RUN_ID,
          '--repo',
          REPOSITORY,
          '--dir',
          temporaryDownload
        ],
        { stdio: 'inherit' }
      );
      artifactRoot = temporaryDownload;
    }

    // Every provenance, manifest, and hash check completes before the first
    // destination write, so malformed inputs cannot produce partial installs.
    const artifacts = readPinnedArtifacts(artifactRoot);
    refreshCopies(artifacts);
    console.log(
      `Refreshed pinned sql.js artifacts from ${REPOSITORY} Actions run ${PINNED_RUN_ID} ` +
      `(${SOURCE_BRANCH}@${SOURCE_COMMIT}).`
    );
  } finally {
    if (temporaryDownload) {
      rmSync(temporaryDownload, { recursive: true, force: true });
    }
  }
}

main();
