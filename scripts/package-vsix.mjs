#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PACKAGE_VARIANTS,
  getVsixFileName
} from './vsix-targets.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');
const defaultVscePath = join(projectRoot, 'node_modules', '.bin', 'vsce');
const archivePrefix = 'extension/';

function executeCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const capture = options.capture === true;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    });
    let stdout = '';
    let stderr = '';

    if (capture) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
    }

    child.once('error', rejectCommand);
    child.once('close', (code, signal) => {
      resolveCommand({ code: code ?? 1, signal, stdout, stderr });
    });
  });
}

function commandFailure(context, result) {
  const detail = (result.stderr || result.stdout).trim();
  const signal = result.signal ? ` (signal ${result.signal})` : '';
  return new Error(
    `${context} failed with exit code ${result.code}${signal}${detail ? `: ${detail}` : ''}`
  );
}

async function runChecked(command, args, options = {}) {
  let result;
  try {
    result = await executeCommand(command, args, options);
  } catch (error) {
    throw new Error(
      `${options.context ?? basename(command)} could not start: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (result.code !== 0) {
    throw commandFailure(options.context ?? basename(command), result);
  }
  return result;
}

export function getNativeStageFiles(variant) {
  if (!variant.target) {
    return [];
  }
  return [
    'natives/native-worker.js',
    `natives/${variant.triple}/${variant.binary}`
  ];
}

export function validatePackageEntries(entries, variant) {
  const browserEntry = `${archivePrefix}out/extension-browser.js`;
  if (entries.filter((entry) => entry === browserEntry).length !== 1) {
    throw new Error(`VSIX gate failed: expected exactly one browser entry point (${browserEntry})`);
  }

  const nativeEntries = entries.filter((entry) => entry.startsWith(`${archivePrefix}natives/`));
  if (!variant.target) {
    if (nativeEntries.length > 0) {
      throw new Error(
        `VSIX gate failed: universal package contains native content: ${nativeEntries.join(', ')}`
      );
    }
    return;
  }

  const expectedNativeEntries = getNativeStageFiles(variant)
    .map((entry) => `${archivePrefix}${entry}`)
    .sort();
  const actualNativeEntries = [...nativeEntries].sort();
  const exactMatch = actualNativeEntries.length === expectedNativeEntries.length
    && actualNativeEntries.every((entry, index) => entry === expectedNativeEntries[index]);
  if (!exactMatch) {
    const foreignEntries = actualNativeEntries.filter(
      (entry) => !expectedNativeEntries.includes(entry)
    );
    const missingEntries = expectedNativeEntries.filter(
      (entry) => !actualNativeEntries.includes(entry)
    );
    throw new Error(
      `VSIX gate failed: ${variant.target} contains a foreign or unexpected native set` +
      `${foreignEntries.length ? `; foreign: ${foreignEntries.join(', ')}` : ''}` +
      `${missingEntries.length ? `; missing: ${missingEntries.join(', ')}` : ''}`
    );
  }
}

export function validateVsixTargetManifest(vsixManifest, variant) {
  const targetMatches = [
    ...vsixManifest.matchAll(/\bTargetPlatform\s*=\s*(["'])([^"']+)\1/g)
  ];
  if (!variant.target) {
    if (targetMatches.length > 0) {
      throw new Error('VSIX gate failed: universal package must not declare a target platform');
    }
    return;
  }
  if (targetMatches.length !== 1 || targetMatches[0][2] !== variant.target) {
    throw new Error(
      `VSIX gate failed: target platform does not equal ${variant.target}`
    );
  }
}

async function listArchive(vsixPath, runCommand = runChecked) {
  const result = await runCommand('unzip', ['-Z1', vsixPath], {
    capture: true,
    context: `VSIX archive listing (${basename(vsixPath)})`
  });
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

async function readArchiveEntry(vsixPath, entry, runCommand = runChecked) {
  const result = await runCommand('unzip', ['-p', vsixPath, entry], {
    capture: true,
    context: `VSIX archive read (${entry})`
  });
  return result.stdout;
}

export async function inspectVsixArchive(vsixPath, expectedVersion, variant, options = {}) {
  const runCommand = options.runCommand ?? runChecked;
  const entries = await listArchive(vsixPath, runCommand);
  validatePackageEntries(entries, variant);

  const vsixManifestEntry = 'extension.vsixmanifest';
  if (entries.filter((entry) => entry === vsixManifestEntry).length !== 1) {
    throw new Error(`VSIX gate failed: expected exactly one ${vsixManifestEntry}`);
  }
  validateVsixTargetManifest(
    await readArchiveEntry(vsixPath, vsixManifestEntry, runCommand),
    variant
  );

  const sourceMapEntries = entries.filter((entry) => entry.toLowerCase().endsWith('.map'));
  if (sourceMapEntries.length > 0) {
    throw new Error(
      `VSIX gate failed: archive contains source map entry ${sourceMapEntries[0]}`
    );
  }

  const manifestEntry = 'extension/package.json';
  if (entries.filter((entry) => entry === manifestEntry).length !== 1) {
    throw new Error(`VSIX gate failed: expected exactly one ${manifestEntry}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(await readArchiveEntry(vsixPath, manifestEntry, runCommand));
  } catch (error) {
    throw new Error(
      `VSIX gate failed: ${manifestEntry} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `VSIX gate failed: ${manifestEntry} version ${JSON.stringify(manifest.version)} does not equal ${JSON.stringify(expectedVersion)}`
    );
  }
  if (manifest.browser !== './out/extension-browser.js') {
    throw new Error(`VSIX gate failed: ${manifestEntry} does not retain the browser entry point`);
  }
  if (typeof manifest.engines?.vscode !== 'string' || manifest.engines.vscode.trim() === '') {
    throw new Error(`VSIX gate failed: ${manifestEntry} is missing engines.vscode`);
  }

  return { entries, manifest, sourceMapEntries };
}

function assertSafeRelativeFile(entry) {
  if (!entry || isAbsolute(entry)) {
    throw new Error(`VSCE listed an unsafe package path: ${JSON.stringify(entry)}`);
  }
  const normalized = normalize(entry);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new Error(`VSCE listed a package path outside the project: ${entry}`);
  }
  return normalized;
}

async function listPublishableFiles(vscePath) {
  const result = await runChecked(vscePath, ['ls', '--no-dependencies'], {
    cwd: projectRoot,
    capture: true,
    context: 'VSCE package file listing'
  });
  const entries = result.stdout.split(/\r?\n/).filter(Boolean).map(assertSafeRelativeFile);
  if (!entries.includes('out/extension-browser.js')) {
    throw new Error('VSCE package file listing omitted out/extension-browser.js');
  }
  return entries;
}

async function copyIntoStage(relativePath, stageRoot) {
  const source = join(projectRoot, relativePath);
  const destination = join(stageRoot, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function createStage(baseEntries, variant, stagingRoot) {
  const label = variant.target ?? 'universal';
  const stageRoot = join(stagingRoot, label);
  await mkdir(stageRoot, { recursive: true });

  // VSCE's own file list incorporates .vscodeignore. Native paths are removed
  // before any copy occurs, so ignore-rule quirks cannot reintroduce a foreign
  // executable into the isolated staging tree.
  for (const entry of baseEntries) {
    if (!entry.startsWith(`natives${sep}`) && !entry.startsWith('natives/')) {
      await copyIntoStage(entry, stageRoot);
    }
  }
  await copyIntoStage('.vscodeignore', stageRoot);
  for (const nativeFile of getNativeStageFiles(variant)) {
    await copyIntoStage(nativeFile, stageRoot);
  }
  return stageRoot;
}

async function publishValidatedArtifacts(artifacts, releaseDir) {
  await mkdir(releaseDir, { recursive: true });
  for (const artifact of artifacts) {
    const destination = join(releaseDir, artifact.fileName);
    const pendingDestination = join(
      releaseDir,
      `.${artifact.fileName}.${process.pid}.pending`
    );
    await copyFile(artifact.quarantinedPath, pendingDestination);
    await rm(destination, { force: true });
    await rename(pendingDestination, destination);
    artifact.path = destination;
  }
}

function formatMiB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export async function run(argv = process.argv.slice(2), options = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node scripts/package-vsix.mjs');
    return [];
  }
  if (argv.length > 0) {
    throw new Error(`Unknown option: ${argv[0]}`);
  }

  const vscePath = options.vscePath ?? defaultVscePath;
  const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error('package.json must contain string name and version fields');
  }

  console.log(`Building SQLite Explorer ${manifest.version} once for six VSIX packages...`);
  await runChecked(process.execPath, [join(projectRoot, 'scripts', 'build.mjs')], {
    cwd: projectRoot,
    context: 'Extension build'
  });

  const packageFiles = await listPublishableFiles(vscePath);
  const baseEntries = packageFiles.filter(
    (entry) => entry !== 'natives' && !entry.startsWith(`natives${sep}`) && !entry.startsWith('natives/')
  );
  const tempParent = join(projectRoot, '.tmp');
  await mkdir(tempParent, { recursive: true });
  const tempRoot = await mkdtemp(join(tempParent, 'vsix-packages-'));
  const stagingRoot = join(tempRoot, 'staging');
  const quarantineDir = join(tempRoot, 'quarantine');
  const artifacts = [];

  try {
    await mkdir(quarantineDir, { recursive: true });
    for (const variant of PACKAGE_VARIANTS) {
      const label = variant.target ?? 'universal';
      const stageRoot = await createStage(baseEntries, variant, stagingRoot);
      const fileName = getVsixFileName(manifest.name, manifest.version, variant.target);
      const quarantinedPath = join(quarantineDir, fileName);
      const args = [
        'package',
        '--no-dependencies',
        '--skip-license',
        '--out',
        quarantineDir
      ];
      if (variant.target) {
        args.push('--target', variant.target);
      }

      console.log(`Packaging ${label}...`);
      await runChecked(vscePath, args, {
        cwd: stageRoot,
        context: `VSCE package (${label})`
      });

      const inspection = await inspectVsixArchive(
        quarantinedPath,
        manifest.version,
        variant
      );
      const packageStat = await stat(quarantinedPath);
      console.log(`Contents of ${fileName}:`);
      for (const entry of inspection.entries) {
        console.log(`  ${entry}`);
      }
      console.log(
        `Content verification passed for ${fileName}: ${inspection.entries.length} files, ${formatMiB(packageStat.size)}`
      );
      artifacts.push({
        variant,
        fileName,
        quarantinedPath,
        size: packageStat.size,
        fileCount: inspection.entries.length
      });
    }

    await publishValidatedArtifacts(
      artifacts,
      options.releaseDir ?? join(projectRoot, 'release')
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  console.log('Package summary:');
  for (const artifact of artifacts) {
    console.log(
      `${artifact.fileName}\t${artifact.size} bytes\t${artifact.fileCount} files`
    );
  }
  return artifacts;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  run().catch((error) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
