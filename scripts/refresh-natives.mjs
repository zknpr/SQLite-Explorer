/**
 * Refresh the pinned txiki.js native runtime artifacts.
 *
 * Default usage downloads all five artifacts from the pinned GitHub Actions run:
 *   node scripts/refresh-natives.mjs
 *
 * A different workflow run can be checked against the same pinned hashes:
 *   node scripts/refresh-natives.mjs 31205719703
 *
 * Maintainers can verify already-downloaded artifacts without network access.
 * The commit is explicit because an extracted artifact has no trustworthy run metadata:
 *   node scripts/refresh-natives.mjs --from /path/to/extracted/artifacts \
 *     --run 31205719703 --commit <40-character-sha>
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
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

const REPOSITORY = 'zknpr/txiki.js';
// The fork's master IS the shipped source; the sqlite-explorer/* branches are
// frozen history. Artifact runs are dispatched from master.
const SOURCE_BRANCH = 'master';
const PINNED_RUN_ID = '31205719703';
const PINNED_SHA256 = Object.freeze({
  'aarch64-linux-gnu/tjs': 'e1fa8d5ecb2c74d233c01ebf6a84c122acf8341bd079c8e11948f9938febcd1d',
  'aarch64-macos/tjs': '15e5e7579580afa84776fbc456e0bd24fa97756dc646ced6f74df07e8b1779a5',
  'x86_64-linux-gnu/tjs': '1ecf1dfa70c3ff4481b895b4f5bf04d23ed5551a552274e84a3d43d588548dce',
  'x86_64-macos/tjs': 'f99f57baa602a5f76664b3e7b30fdbdae4d99e6d7359b371da6c8ea614829cca',
  'x86_64-windows/tjs.exe': 'bb6dacece251549148987bc7cd5947f00550c5919792f253892e0d554aa345e0'
});

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function findNativeCandidates(root) {
  const matches = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && (entry.name === 'tjs' || entry.name === 'tjs.exe')) {
        matches.push(entryPath);
      }
    }
  };
  visit(root);
  return matches;
}

function findPinnedArtifacts(root) {
  const targetByHash = new Map(
    Object.entries(PINNED_SHA256).map(([target, expectedHash]) => [expectedHash, target])
  );
  const artifacts = new Map();
  const observed = [];

  for (const candidate of findNativeCandidates(root)) {
    const contents = readFileSync(candidate);
    const actualHash = sha256(contents);
    observed.push(`${candidate} (${actualHash})`);
    const target = targetByHash.get(actualHash);
    if (target && !artifacts.has(target)) artifacts.set(target, contents);
  }

  const missing = Object.keys(PINNED_SHA256).filter(target => !artifacts.has(target));
  if (missing.length > 0) {
    const detail = observed.length > 0
      ? ` Candidates: ${observed.join('; ')}`
      : ' No tjs or tjs.exe candidates were found.';
    throw new Error(`Pinned txiki.js artifacts were not found for: ${missing.join(', ')}.${detail}`);
  }

  return artifacts;
}

function atomicWrite(destination, contents, expectedHash) {
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, contents);
    chmodSync(temporary, 0o755);
    const actualHash = sha256(readFileSync(temporary));
    if (actualHash !== expectedHash) {
      throw new Error(`Refusing to install ${destination}: expected ${expectedHash}, received ${actualHash}`);
    }
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function refreshCopies(artifacts) {
  for (const [target, expectedHash] of Object.entries(PINNED_SHA256)) {
    atomicWrite(
      path.join(repositoryRoot, 'natives', target),
      artifacts.get(target),
      expectedHash
    );
  }
}

function readValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function parseArguments() {
  const args = process.argv.slice(2);
  let runId = PINNED_RUN_ID;
  let runIdWasSet = false;
  let suppliedSource;
  let suppliedCommit;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--from') {
      suppliedSource = path.resolve(readValue(args, index, '--from'));
      index += 1;
    } else if (argument === '--run') {
      if (runIdWasSet) throw new Error('Specify the workflow run id only once');
      runId = readValue(args, index, '--run');
      runIdWasSet = true;
      index += 1;
    } else if (argument === '--commit') {
      suppliedCommit = readValue(args, index, '--commit').toLowerCase();
      index += 1;
    } else if (/^\d+$/.test(argument) && !runIdWasSet) {
      runId = argument;
      runIdWasSet = true;
    } else {
      throw new Error(
        'Usage: node scripts/refresh-natives.mjs [run-id] [--run run-id] ' +
        '[--commit 40-character-sha] [--from /path/to/extracted/artifacts]'
      );
    }
  }

  if (!/^\d+$/.test(runId)) throw new Error(`Invalid workflow run id: ${runId}`);
  if (suppliedCommit && !/^[0-9a-f]{40}$/.test(suppliedCommit)) {
    throw new Error(`Invalid fork commit: ${suppliedCommit}`);
  }
  if (suppliedSource && !suppliedCommit) {
    throw new Error('--commit is required with --from because extracted artifacts lack run metadata');
  }

  return { runId, suppliedSource, suppliedCommit };
}

function readRunMetadata(runId, expectedCommit) {
  const output = execFileSync(
    'gh',
    [
      'run',
      'view',
      runId,
      '--repo',
      REPOSITORY,
      '--json',
      'headBranch,headSha'
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const metadata = JSON.parse(output);
  const commit = String(metadata.headSha ?? '').toLowerCase();
  if (metadata.headBranch !== SOURCE_BRANCH) {
    throw new Error(
      `Refusing run ${runId}: expected branch ${SOURCE_BRANCH}, received ${metadata.headBranch}`
    );
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`Run ${runId} did not report a valid headSha`);
  }
  if (expectedCommit && expectedCommit !== commit) {
    throw new Error(`Refusing run ${runId}: expected commit ${expectedCommit}, received ${commit}`);
  }
  return commit;
}

function main() {
  const { runId, suppliedSource, suppliedCommit } = parseArguments();
  let temporaryDownload;
  try {
    let artifactRoot = suppliedSource;
    let sourceCommit = suppliedCommit;
    if (!artifactRoot) {
      sourceCommit = readRunMetadata(runId, suppliedCommit);
      temporaryDownload = mkdtempSync(path.join(tmpdir(), 'sqlite-explorer-natives-'));
      execFileSync(
        'gh',
        [
          'run',
          'download',
          runId,
          '--repo',
          REPOSITORY,
          '--dir',
          temporaryDownload
        ],
        { stdio: 'inherit' }
      );
      artifactRoot = temporaryDownload;
    }

    const artifacts = findPinnedArtifacts(artifactRoot);
    refreshCopies(artifacts);
    console.log(
      `Refreshed five pinned txiki.js binaries from ${REPOSITORY} Actions run ${runId} ` +
      `(${SOURCE_BRANCH}@${sourceCommit}).`
    );
  } finally {
    if (temporaryDownload) {
      rmSync(temporaryDownload, { recursive: true, force: true });
    }
  }
}

main();
