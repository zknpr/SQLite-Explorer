#!/usr/bin/env node

/**
 * Publish the six GitHub-release VSIX assets to the Microsoft Marketplace.
 *
 * The PAT is read from macOS Keychain service `vsce.k` and passed only in the
 * child process environment expected by VSCE. It is never placed in argv, an
 * environment file, or logs. If automation is unavailable, the Microsoft web
 * portal remains the manual fallback: drag all six VSIX files into one release.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cleanupPreparedAssets,
  commandFailure,
  executeCommand,
  parsePublishArguments,
  prepareReleaseAssets,
  projectRoot
} from './publish-common.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultVscePath = resolve(projectRoot, 'node_modules', '.bin', 'vsce');

export function parseArguments(argv) {
  return parsePublishArguments(argv);
}

export async function resolveMarketplaceToken(options = {}) {
  const runCommand = options.runCommand ?? executeCommand;
  let result;
  try {
    result = await runCommand('security', [
      'find-generic-password',
      '-s',
      'vsce.k',
      '-w'
    ]);
  } catch (error) {
    throw new Error(
      `Could not read the Marketplace PAT from macOS Keychain service vsce.k: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const token = result.code === 0 ? result.stdout.trim() : '';
  if (!token) {
    throw new Error(
      'No Marketplace PAT found in macOS Keychain service vsce.k. One-time setup: ' +
      'security add-generic-password -U -s vsce.k -a zknpr -w'
    );
  }
  return token;
}

export async function publishVsix(vsixPath, token, options = {}) {
  const env = options.env ?? process.env;
  const vscePath = options.vscePath ?? defaultVscePath;
  const runCommand = options.runCommand ?? executeCommand;
  const args = ['publish', '--packagePath', vsixPath];
  let result;
  try {
    result = await runCommand(vscePath, args, {
      env: { ...env, VSCE_PAT: token }
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Pinned VSCE CLI not found at ${vscePath}; run npm ci first`);
    }
    throw error;
  }
  if (result.code !== 0) {
    throw commandFailure('vsce publish', result, token);
  }
}

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
        log(`Would run: vsce publish --packagePath ${asset.name}`);
      }
      log('Dry run complete; all six assets passed content and SHA-256 gates; nothing was published.');
      return;
    }

    const token = await resolveMarketplaceToken({
      runCommand: options.runCommand ?? executeCommand
    });
    for (const asset of prepared.assets) {
      await publishVsix(asset.path, token, {
        env: options.env ?? process.env,
        vscePath: options.vscePath ?? defaultVscePath,
        runCommand: options.runCommand ?? executeCommand
      });
      log(`Published ${asset.name} to the Microsoft Marketplace.`);
    }
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
