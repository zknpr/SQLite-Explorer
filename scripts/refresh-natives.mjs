/**
 * Refresh the exact txiki.js security-fix workflow artifacts.
 *
 * Default usage re-validates the pinned GitHub Actions run before download:
 *   node scripts/refresh-natives.mjs
 *
 * An already-downloaded artifact can be verified without network access only
 * when its complete pinned provenance is supplied explicitly:
 *   node scripts/refresh-natives.mjs --from /path/to/run-artifacts \
 *     --run 31648639100 --branch agent/v8-bounded-host-views \
 *     --commit acef1d0de4f16321bc24b81261aebcea064f5923
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPinnedArtifactPolicy } from './lib/pinned-artifacts.mjs';

const REPOSITORY = 'zknpr/txiki.js';
const SOURCE_BRANCH = 'agent/v8-bounded-host-views';
const SOURCE_COMMIT = 'acef1d0de4f16321bc24b81261aebcea064f5923';
const PINNED_RUN_ID = '31648639100';
const PINNED_SHA256 = Object.freeze({
  'aarch64-linux-gnu/tjs': '0a3654ad7436c46d39add000e44ac169992b48d9ac2e0b47e86591636eb504d8',
  'aarch64-macos/tjs': '9e8610bedbbec8130fdafe7456c22e63b5f4bee1fdde90993e56dc3204b0b1a1',
  'x86_64-linux-gnu/tjs': '5ae6724ddffd888ad6d15ea097c5382d8a8c64703934200b1924a33c02570592',
  'x86_64-macos/tjs': '57645ccb7bcfec8a220a05a37b2fae204c667ac703de7a6be7ce121b5ef8883a',
  'x86_64-windows/tjs.exe': '78768640f59cd413bc0a6ed28709d9161d4d7fe3682c6d4276489f532399c5d9'
});
const PAYLOAD_FILENAMES = new Set(['tjs', 'tjs.exe']);

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const {
  atomicWrite,
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
  payloadFilenames: PAYLOAD_FILENAMES,
  executable: true
});

function refreshCopies(artifacts) {
  for (const [target, expectedHash] of Object.entries(PINNED_SHA256)) {
    atomicWrite(
      path.join(repositoryRoot, 'natives', ...target.split('/')),
      artifacts.get(target),
      expectedHash
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

    // Every provenance, manifest, and hash check completes before the first
    // destination write, so malformed inputs cannot produce partial installs.
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
