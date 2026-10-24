/**
 * Refresh the exact txiki.js runtime workflow artifacts.
 *
 * Default usage re-validates the pinned GitHub Actions run before download:
 *   node scripts/refresh-natives.mjs
 *
 * An already-downloaded artifact can be verified without network access only
 * when its complete pinned provenance is supplied explicitly:
 *   node scripts/refresh-natives.mjs --from /path/to/run-artifacts \
 *     --run 40086152581 --branch master \
 *     --commit b45ac83ec0d7809c413afcf4091d7ecf12a46452
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPinnedArtifactPolicy } from './lib/pinned-artifacts.mjs';

const REPOSITORY = 'zknpr/txiki.js';
const SOURCE_BRANCH = 'master';
const SOURCE_COMMIT = 'b45ac83ec0d7809c413afcf4091d7ecf12a46452';
const PINNED_RUN_ID = '40086152581';
const PINNED_SHA256 = Object.freeze({
  'aarch64-linux-gnu/tjs': 'd316445ec08f39baf0bdcdf7624df73e17f9b166a1365283b396e6afd4ee778a',
  'aarch64-macos/tjs': 'eabb77e38e127d0cd6276f12195524981ac0a8362ce58b56757ce74d660175c8',
  'x86_64-linux-gnu/tjs': 'b437ea6321c5a1a281a9711990eb0c72cfba054cda9daff88145ee44d00a8d11',
  'x86_64-macos/tjs': 'f0daa1b39b6f081053f1a41cfb4c8ef28872d2c3512a837b5f1c0bbfced126a7',
  'x86_64-windows/tjs.exe': 'ae95f8c909a0b00fe5a35417ccae36541a5bea87b04f07dd203e59c77dd6150c'
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
