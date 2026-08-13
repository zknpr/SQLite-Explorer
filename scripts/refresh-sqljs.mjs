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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPinnedArtifactPolicy } from './lib/pinned-artifacts.mjs';

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
const {
  atomicWrite,
  parseArguments,
  readPinnedArtifacts,
  readPinnedRunMetadata
} = createPinnedArtifactPolicy({
  scriptName: 'refresh-sqljs.mjs',
  repository: REPOSITORY,
  sourceBranch: SOURCE_BRANCH,
  sourceCommit: SOURCE_COMMIT,
  pinnedRunId: PINNED_RUN_ID,
  expectedArtifactPaths: EXPECTED_ARTIFACT_PATHS,
  payloadFilenames: PAYLOAD_FILENAMES
});

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
