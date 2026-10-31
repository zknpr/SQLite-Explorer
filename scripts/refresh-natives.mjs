/**
 * Refresh the exact txiki.js runtime workflow artifacts.
 *
 * Default usage re-validates the pinned GitHub Actions run before download:
 *   node scripts/refresh-natives.mjs
 *
 * An already-downloaded artifact can be verified without network access only
 * when its complete pinned provenance is supplied explicitly:
 *   node scripts/refresh-natives.mjs --from /path/to/run-artifacts \
 *     --run 41183550205 --branch master \
 *     --commit e0211b66af5e35521929a5727065f0235ad3f8ce
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPinnedArtifactPolicy } from './lib/pinned-artifacts.mjs';

const REPOSITORY = 'zknpr/txiki.js';
const SOURCE_BRANCH = 'master';
const SOURCE_COMMIT = 'e0211b66af5e35521929a5727065f0235ad3f8ce';
const PINNED_RUN_ID = '41183550205';
const PINNED_SHA256 = Object.freeze({
  'aarch64-linux-gnu/tjs': '61835be731cc3eaf2ed5040d718f6e52e725a9dd402e59e8bc8b963e8e3364c7',
  'aarch64-macos/tjs': '9865b1caa4b4580e9179086843630d220e3dad1d61e4f425207dc193c35f59e5',
  'x86_64-linux-gnu/tjs': '204a177e59e88a781fd54c0b443de0a95c688807bc60b8ff39458a5826b908c6',
  'x86_64-macos/tjs': '13ea631298d7fa039d39a505d9bbfee4800fcb3673690c11604f07e9ad7cf8ba',
  'x86_64-windows/tjs.exe': '674dfeb63bf6da94d3ec887ee4da389e9451ef681100738ff5e9ace787fc5175'
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
