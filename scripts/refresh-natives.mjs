/**
 * Refresh the exact txiki.js runtime workflow artifacts.
 *
 * Default usage re-validates the pinned GitHub Actions run before download:
 *   node scripts/refresh-natives.mjs
 *
 * An already-downloaded artifact can be verified without network access only
 * when its complete pinned provenance is supplied explicitly:
 *   node scripts/refresh-natives.mjs --from /path/to/run-artifacts \
 *     --run 43520538528 --branch master \
 *     --commit 172b8310c5e7304ca72083f12164c95c44eb171f
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPinnedArtifactPolicy } from './lib/pinned-artifacts.mjs';

const REPOSITORY = 'zknpr/txiki.js';
const SOURCE_BRANCH = 'master';
const SOURCE_COMMIT = '172b8310c5e7304ca72083f12164c95c44eb171f';
const PINNED_RUN_ID = '43520538528';
const PINNED_SHA256 = Object.freeze({
  'aarch64-linux-gnu/tjs': '95d13f5471fd03beb8fd47046f0e428658cf653e51d06757a5e2a20bef620b98',
  'aarch64-macos/tjs': '90c2e074938be5142193d7419791f924a7a63ade5783ad2f63ad43120b8846b5',
  'x86_64-linux-gnu/tjs': '870810d42f7e7e02343d0ba1e2c0b49114116d44e77be21c4437ad1e40d1ae29',
  'x86_64-macos/tjs': 'bd012455821e07d82ad402d92a87f47ffad40b6d148b66a3be62c00c19dd6a1a',
  'x86_64-windows/tjs.exe': '2c49ab220a6d282a85c413ad14ecc68e3eaaab2f0d3ad6d62b521bdb57f9ed08'
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
