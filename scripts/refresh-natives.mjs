/**
 * Refresh the exact txiki.js runtime workflow artifacts.
 *
 * Default usage re-validates the pinned GitHub Actions run before download:
 *   node scripts/refresh-natives.mjs
 *
 * An already-downloaded artifact can be verified without network access only
 * when its complete pinned provenance is supplied explicitly:
 *   node scripts/refresh-natives.mjs --from /path/to/run-artifacts \
 *     --run 40021160289 --branch master \
 *     --commit 9875455640b8ae62f52200a9fa7fa2a66d079dc7
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPinnedArtifactPolicy } from './lib/pinned-artifacts.mjs';

const REPOSITORY = 'zknpr/txiki.js';
const SOURCE_BRANCH = 'master';
const SOURCE_COMMIT = '9875455640b8ae62f52200a9fa7fa2a66d079dc7';
const PINNED_RUN_ID = '40021160289';
const PINNED_SHA256 = Object.freeze({
  'aarch64-linux-gnu/tjs': '56fef15b6365a39fc771ea088823ade05a09297f188fcc7714f72f8d5decbe2e',
  'aarch64-macos/tjs': '833325341cd47a1887fadc69cf637a26c0b120fcaa1b52ce486537bab2bc3325',
  'x86_64-linux-gnu/tjs': 'b8d1c7cd34efa507bf7138ca0b8ae3ee2ff19b80a07f346fe1a75a764fe21393',
  'x86_64-macos/tjs': '6ecd5601ad01629f1e0f6bdc159c708061dca5add4acc4f8d1f8f0a000c59e07',
  'x86_64-windows/tjs.exe': '8bb9eb334b5b1128262c965956f4d50fa75243b1fdb6b878d948af73f8ac66be'
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
