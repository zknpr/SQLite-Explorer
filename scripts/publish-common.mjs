import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectVsixArchive } from './package-vsix.mjs';
import { PACKAGE_VARIANTS, getVsixFileName } from './vsix-targets.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(scriptDirectory, '..');
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function normalizeVersion(value) {
  const normalized = value?.startsWith('v') ? value.slice(1) : value;
  if (!normalized || !versionPattern.test(normalized)) {
    throw new Error(`Invalid version ${JSON.stringify(value ?? '')}; expected X.Y.Z or vX.Y.Z`);
  }
  return normalized;
}

export function parsePublishArguments(argv, options = {}) {
  let dryRun = false;
  let verifyOnly = false;
  let assetsDir;
  const positional = [];

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      dryRun = true;
    } else if (argument === '--verify-only' && options.allowVerifyOnly === true) {
      verifyOnly = true;
    } else if (argument === '--assets-dir') {
      const value = argv[++index];
      if (!value || value.startsWith('-')) {
        throw new Error('--assets-dir requires a directory path');
      }
      assetsDir = resolve(projectRoot, value);
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      positional.push(argument);
    }
  }

  if (dryRun && verifyOnly) {
    throw new Error('--dry-run and --verify-only cannot be used together');
  }
  if (assetsDir && !dryRun) {
    throw new Error('--assets-dir is allowed only with --dry-run');
  }
  if (positional.length > 1) {
    throw new Error('Expected at most one version argument');
  }

  return {
    mode: dryRun ? 'dry-run' : verifyOnly ? 'verify-only' : 'publish',
    version: positional.length === 1 ? normalizeVersion(positional[0]) : undefined,
    assetsDir
  };
}

/** Run without a shell so asset names and paths never become shell input. */
export function executeCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      const wrapped = new Error(`Failed to start ${command}: ${error.message}`);
      wrapped.code = error.code;
      rejectCommand(wrapped);
    });
    child.once('close', (code, signal) => {
      resolveCommand({ code: code ?? 1, signal, stdout, stderr });
    });
  });
}

export function commandFailure(context, result, secret) {
  const detail = redact((result.stderr || result.stdout).trim(), secret);
  const signal = result.signal ? ` (signal ${result.signal})` : '';
  return new Error(
    `${context} failed with exit code ${result.code}${signal}${detail ? `: ${detail}` : ''}`
  );
}

export function redact(value, secret) {
  if (!value || !secret) {
    return value;
  }
  return value.split(secret).join('[REDACTED]');
}

export function selectReleaseAssets(release, requestedVersion, extensionName) {
  if (!release || typeof release.tagName !== 'string' || !Array.isArray(release.assets)) {
    throw new Error('GitHub release metadata is missing tagName or assets');
  }
  const releaseVersion = normalizeVersion(release.tagName);
  if (requestedVersion && releaseVersion !== requestedVersion) {
    throw new Error(
      `GitHub returned release ${release.tagName}, not requested version ${requestedVersion}`
    );
  }

  const expected = PACKAGE_VARIANTS.map((variant) => ({
    variant,
    name: getVsixFileName(extensionName, releaseVersion, variant.target)
  }));
  const vsixAssets = release.assets.filter(
    (asset) => typeof asset?.name === 'string' && asset.name.toLowerCase().endsWith('.vsix')
  );
  const byName = new Map();
  for (const asset of vsixAssets) {
    if (basename(asset.name) !== asset.name || byName.has(asset.name)) {
      throw new Error(`Unsafe or duplicate GitHub release asset name: ${asset.name}`);
    }
    byName.set(asset.name, asset);
  }

  const expectedNames = new Set(expected.map((asset) => asset.name));
  const missing = expected.filter((asset) => !byName.has(asset.name)).map((asset) => asset.name);
  const foreign = vsixAssets.map((asset) => asset.name).filter((name) => !expectedNames.has(name));
  if (missing.length > 0 || foreign.length > 0 || vsixAssets.length !== expected.length) {
    throw new Error(
      `Release ${release.tagName} must contain exactly the six expected VSIX assets` +
      `${missing.length ? `; missing: ${missing.join(', ')}` : ''}` +
      `${foreign.length ? `; foreign: ${foreign.join(', ')}` : ''}`
    );
  }

  return expected.map(({ variant, name }) => ({
    ...byName.get(name),
    name,
    variant
  }));
}

async function getProjectManifest() {
  const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error('package.json must contain string name and version fields');
  }
  return manifest;
}

async function getGitHubRelease(requestedVersion, extensionName, runCommand) {
  const args = ['release', 'view'];
  if (requestedVersion) {
    args.push(`v${requestedVersion}`);
  }
  args.push('--json', 'tagName,assets');
  const result = await runCommand('gh', args, { cwd: projectRoot });
  if (result.code !== 0) {
    throw commandFailure('GitHub release lookup', result);
  }

  let release;
  try {
    release = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `GitHub release lookup returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const version = requestedVersion ?? normalizeVersion(release.tagName);
  return {
    tagName: release.tagName,
    version,
    assets: selectReleaseAssets(release, version, extensionName)
  };
}

export function selectLocalVsixNames(names, version, extensionName) {
  return names.filter(
    (name) => name.startsWith(`${extensionName}-`) && name.endsWith(`-${version}.vsix`)
  );
}

async function getLocalRelease(assetsDir, version, extensionName) {
  const names = selectLocalVsixNames(await readdir(assetsDir), version, extensionName);
  const release = {
    tagName: `v${version}`,
    assets: names.map((name) => ({ name }))
  };
  return {
    tagName: release.tagName,
    version,
    assets: selectReleaseAssets(release, version, extensionName).map((asset) => ({
      ...asset,
      path: join(assetsDir, asset.name)
    }))
  };
}

async function downloadReleaseAsset(release, asset, tempDir, runCommand) {
  const result = await runCommand('gh', [
    'release',
    'download',
    release.tagName,
    '--pattern',
    asset.name,
    '--dir',
    tempDir
  ], { cwd: projectRoot });
  if (result.code !== 0) {
    throw commandFailure(`GitHub release asset download (${asset.name})`, result);
  }

  const destination = join(tempDir, asset.name);
  let downloaded;
  try {
    downloaded = await stat(destination);
  } catch (error) {
    throw new Error(
      `GitHub reported a successful download but ${destination} is missing: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!downloaded.isFile()) {
    throw new Error(`GitHub release download is not a regular file: ${destination}`);
  }
  if (typeof asset.size === 'number' && downloaded.size !== asset.size) {
    throw new Error(
      `GitHub release asset size mismatch for ${asset.name}: expected ${asset.size}, received ${downloaded.size}`
    );
  }
  return { ...asset, path: destination };
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function expectedGitHubDigest(asset) {
  if (asset.digest === undefined || asset.digest === null || asset.digest === '') {
    return null;
  }
  const match = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest);
  if (!match) {
    throw new Error(`GitHub release asset ${asset.name} has an invalid SHA-256 digest`);
  }
  return match[1].toLowerCase();
}

async function verifyPreparedAsset(asset, version, requireReleaseDigest, log) {
  await inspectVsixArchive(asset.path, version, asset.variant);
  const sha256 = await sha256File(asset.path);
  const expectedDigest = expectedGitHubDigest(asset);
  if (requireReleaseDigest && !expectedDigest) {
    throw new Error(`GitHub release asset ${asset.name} is missing its SHA-256 digest`);
  }
  if (expectedDigest && sha256 !== expectedDigest) {
    throw new Error(
      `SHA-256 mismatch for GitHub release asset ${asset.name}: expected ${expectedDigest}, received ${sha256}`
    );
  }
  log(`SHA-256 ${asset.name}: ${sha256}`);
  return { ...asset, sha256 };
}

export async function prepareReleaseAssets(parsed, options = {}) {
  const runCommand = options.runCommand ?? executeCommand;
  const log = options.log ?? console.log;
  const manifest = await getProjectManifest();
  const tempParent = join(projectRoot, '.tmp');
  await mkdir(tempParent, { recursive: true });
  const tempDir = await mkdtemp(join(tempParent, 'publish-vsix-'));

  try {
    let release;
    let requireReleaseDigest = false;
    if (parsed.assetsDir) {
      const version = parsed.version ?? normalizeVersion(manifest.version);
      release = await getLocalRelease(parsed.assetsDir, version, manifest.name);
    } else {
      release = await getGitHubRelease(parsed.version, manifest.name, runCommand);
      release.assets = await Promise.all(
        release.assets.map((asset) => downloadReleaseAsset(release, asset, tempDir, runCommand))
      );
      requireReleaseDigest = parsed.mode === 'publish';
    }

    const assets = [];
    for (const asset of release.assets) {
      assets.push(await verifyPreparedAsset(
        asset,
        release.version,
        requireReleaseDigest,
        log
      ));
    }
    return { ...release, assets, tempDir };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export async function cleanupPreparedAssets(prepared) {
  if (prepared?.tempDir) {
    await rm(prepared.tempDir, { recursive: true, force: true });
  }
}
