#!/usr/bin/env node

import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import {
  cleanupPreparedAssets,
  commandFailure,
  executeCommand,
  parsePublishArguments,
  prepareReleaseAssets,
  projectRoot,
  redact,
  sha256File
} from './publish-common.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultOvsxPath = resolve(projectRoot, 'node_modules', '.bin', 'ovsx');

export function parseArguments(argv) {
  return parsePublishArguments(argv, { allowVerifyOnly: true });
}

/** Keep the established Keychain-first lookup and environment fallback. */
export async function resolveToken(options = {}) {
  const env = options.env ?? process.env;
  const runCommand = options.runCommand ?? executeCommand;
  let keychainResult;
  try {
    keychainResult = await runCommand('security', [
      'find-generic-password',
      '-s',
      'open-vsx',
      '-a',
      'zknpr',
      '-w'
    ]);
  } catch {
    keychainResult = undefined;
  }

  const keychainToken = keychainResult?.code === 0 ? keychainResult.stdout.trim() : '';
  if (keychainToken) {
    return keychainToken;
  }
  const environmentToken = env.OVSX_PAT?.trim();
  if (environmentToken) {
    return environmentToken;
  }
  throw new Error(
    'No Open VSX token found in macOS Keychain or OVSX_PAT. One-time setup: ' +
    'security add-generic-password -s open-vsx -a zknpr -w'
  );
}

export async function publishVsix(vsixPath, target, token, options = {}) {
  const env = options.env ?? process.env;
  const ovsxPath = options.ovsxPath ?? defaultOvsxPath;
  const runCommand = options.runCommand ?? executeCommand;
  const args = ['publish', '--packagePath', vsixPath];
  if (target) {
    args.push('--target', target);
  }

  let result;
  try {
    result = await runCommand(ovsxPath, args, {
      env: { ...env, OVSX_PAT: token }
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Pinned ovsx CLI not found at ${ovsxPath}; run npm ci first`);
    }
    throw error;
  }
  if (result.code === 0) {
    return;
  }

  const output = redact(`${result.stderr}\n${result.stdout}`.trim(), token);
  if (/already (?:been )?published|already exists|version[^\n]*already published/i.test(output)) {
    throw new Error(
      'Open VSX reports this package is already published; use --verify-only to audit it'
    );
  }
  throw commandFailure('ovsx publish', { ...result, stderr: output, stdout: '' });
}

async function fetchChecked(fetchImpl, url, purpose) {
  let response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new Error(`${purpose} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`${purpose} failed: HTTP ${response.status} ${response.statusText}`.trim());
  }
  return response;
}

function requireHttpsUrl(value, purpose) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`${purpose} is not a valid URL: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${purpose} must use HTTPS, received ${url.protocol}`);
  }
  return url;
}

async function fetchJson(fetchImpl, url, purpose) {
  const response = await fetchChecked(fetchImpl, url, purpose);
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${purpose} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function getPublishedMetadata(version, target, fetchImpl) {
  const targetLabel = target ?? 'universal';
  const targetUrl = `https://open-vsx.org/api/zknpr/sqlite-explorer/${encodeURIComponent(targetLabel)}`;
  let metadata = await fetchJson(
    fetchImpl,
    targetUrl,
    `Open VSX metadata request for ${version}@${targetLabel}`
  );

  if (metadata?.version !== version) {
    const versionUrlValue = metadata?.allVersions?.[version];
    if (typeof versionUrlValue !== 'string' || versionUrlValue.length === 0) {
      throw new Error(`Open VSX has no ${version}@${targetLabel} metadata entry`);
    }
    const versionUrl = requireHttpsUrl(versionUrlValue, 'Open VSX version metadata URL');
    metadata = await fetchJson(
      fetchImpl,
      versionUrl.href,
      `Open VSX version metadata request for ${version}@${targetLabel}`
    );
  }

  if (metadata?.version !== version) {
    throw new Error(`Open VSX metadata did not resolve version ${version}@${targetLabel}`);
  }
  if (metadata?.targetPlatform !== targetLabel) {
    throw new Error(
      `Open VSX metadata target ${JSON.stringify(metadata?.targetPlatform)} does not equal ${targetLabel}`
    );
  }
  if (typeof metadata?.files?.download !== 'string' || metadata.files.download.length === 0) {
    throw new Error(`Open VSX metadata for ${version}@${targetLabel} is missing files.download`);
  }
  return metadata;
}

export async function verifyPublishedAsset(releaseAsset, version, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const tempDir = options.tempDir;
  const log = options.log ?? console.log;
  const targetLabel = releaseAsset.variant.target ?? 'universal';
  if (typeof fetchImpl !== 'function') {
    throw new Error('This script requires Node.js 20+ with global fetch support');
  }
  if (!tempDir) {
    throw new Error('Internal error: verification temp directory was not provided');
  }

  const metadata = await getPublishedMetadata(
    version,
    releaseAsset.variant.target,
    fetchImpl
  );
  const downloadUrl = requireHttpsUrl(
    metadata.files.download,
    'Open VSX files.download'
  );
  const response = await fetchChecked(
    fetchImpl,
    downloadUrl.href,
    `Open VSX artifact download for ${version}@${targetLabel}`
  );
  if (!response.body) {
    throw new Error(`Open VSX artifact download for ${version}@${targetLabel} returned an empty body`);
  }

  const openVsxPath = join(tempDir, `open-vsx-${version}-${targetLabel}.vsix`);
  await pipeline(response.body, createWriteStream(openVsxPath));
  const openVsxHash = await sha256File(openVsxPath);
  log(`Open VSX SHA-256 ${targetLabel}: ${openVsxHash}`);
  if (releaseAsset.sha256 !== openVsxHash) {
    throw new Error(
      `SHA-256 mismatch: Open VSX ${version}@${targetLabel} does not match GitHub release asset ${releaseAsset.name}`
    );
  }
  return { githubHash: releaseAsset.sha256, openVsxHash };
}

// Compatibility name retained for callers of the original single-asset script.
export const verifyPublished = verifyPublishedAsset;

export async function run(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArguments(argv);
  const log = options.log ?? console.log;
  const prepared = await prepareReleaseAssets(parsed, {
    runCommand: options.runCommand ?? executeCommand,
    log
  });

  try {
    log(`GitHub release: ${prepared.tagName}`);
    if (parsed.mode === 'dry-run') {
      for (const asset of prepared.assets) {
        const targetSuffix = asset.variant.target ? ` --target ${asset.variant.target}` : '';
        log(`Would run: ovsx publish --packagePath ${asset.name}${targetSuffix}`);
      }
      log('Dry run complete; all six assets passed content and SHA-256 gates; nothing was published.');
      return;
    }

    if (parsed.mode === 'verify-only') {
      for (const asset of prepared.assets) {
        await verifyPublishedAsset(asset, prepared.version, {
          fetchImpl: options.fetchImpl ?? globalThis.fetch,
          tempDir: prepared.tempDir,
          log
        });
      }
      log(`Verified all six Open VSX ${prepared.version} packages against GitHub release assets.`);
      return;
    }

    const token = await resolveToken({
      env: options.env ?? process.env,
      runCommand: options.runCommand ?? executeCommand
    });
    for (const asset of prepared.assets) {
      await publishVsix(asset.path, asset.variant.target, token, {
        env: options.env ?? process.env,
        ovsxPath: options.ovsxPath ?? defaultOvsxPath,
        runCommand: options.runCommand ?? executeCommand
      });
      log(`Published ${asset.name} to Open VSX.`);
    }
    for (const asset of prepared.assets) {
      await verifyPublishedAsset(asset, prepared.version, {
        fetchImpl: options.fetchImpl ?? globalThis.fetch,
        tempDir: prepared.tempDir,
        log
      });
    }
    log(`Verified all six Open VSX ${prepared.version} packages against GitHub release assets.`);
  } finally {
    await cleanupPreparedAssets(prepared);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  run().catch((error) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
