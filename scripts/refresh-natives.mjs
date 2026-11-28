/**
 * Refresh the exact txiki.js runtime workflow artifacts.
 *
 * Default usage re-validates the pinned GitHub Actions run before download:
 *   node scripts/refresh-natives.mjs
 *
 * An already-downloaded artifact can be verified without network access only
 * when its complete pinned provenance is supplied explicitly:
 *   node scripts/refresh-natives.mjs --from /path/to/run-artifacts \
 *     --run 46083982945 --branch master \
 *     --commit bb489f886d96922f96df854b65a7d573ace5b690
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPinnedArtifactPolicy } from './lib/pinned-artifacts.mjs';

const REPOSITORY = 'zknpr/txiki.js';
const SOURCE_BRANCH = 'master';
const SOURCE_COMMIT = 'bb489f886d96922f96df854b65a7d573ace5b690';
const PINNED_RUN_ID = '46083982945';
const PINNED_SHA256 = Object.freeze({
  'aarch64-linux-gnu/tjs': 'c6cef0035b21835dc5dcd565bd1ed8182303889554bf2979f7ff4d601b210c25',
  'aarch64-macos/tjs': '8715dffc48aeece0f7a2f4b48f238d3f2f1a0e28921f37a4d1d65093269f4e1f',
  'x86_64-linux-gnu/tjs': '452f08e08c0441746882d836e3ee1c5a4ef717a5d13f3570cc4cffd0dca469f8',
  'x86_64-macos/tjs': '75ba8253f797faf50b5385fb80813b12f50c3d23b676360280aa5826441fa2af',
  'x86_64-windows/tjs.exe': 'b7d21625663667fc3fbbdb18afd9ff08b4b4e3a23581faa2e6519e38eac0dba8'
});

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const {
  installArtifacts,
  parseArguments,
  readPinnedArtifacts,
  readPinnedRunMetadata
} = createPinnedArtifactPolicy({
  scriptName: 'refresh-natives.mjs',
  repository: REPOSITORY,
  sourceBranch: SOURCE_BRANCH,
  sourceCommit: SOURCE_COMMIT,
  pinnedRunId: PINNED_RUN_ID,
  expectedArtifactPaths: PINNED_SHA256,
  executable: true
});

function refreshCopies(artifacts) {
  installArtifacts(
    Object.entries(PINNED_SHA256).map(([target, expectedHash]) => ({
      destination: path.join(repositoryRoot, 'natives', ...target.split('/')),
      contents: artifacts.get(target),
      expectedHash
    }))
  );
}

function main() {
  const { suppliedSource } = parseArguments();
  let temporaryDownload;
  try {
    let artifactRoot = suppliedSource;
    if (!artifactRoot) {
      readPinnedRunMetadata();
      temporaryDownload = mkdtempSync(path.join(tmpdir(), 'sqlite-explorer-natives-'));
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

    // Provenance and artifact hashes are checked before the rollback-protected
    // destination batch begins.
    const artifacts = readPinnedArtifacts(artifactRoot);
    refreshCopies(artifacts);
    console.log(
      `Refreshed five pinned txiki.js binaries from ${REPOSITORY} Actions run ${PINNED_RUN_ID} ` +
      `(${SOURCE_BRANCH}@${SOURCE_COMMIT}).`
    );
  } finally {
    if (temporaryDownload) {
      rmSync(temporaryDownload, { recursive: true, force: true });
    }
  }
}

main();
