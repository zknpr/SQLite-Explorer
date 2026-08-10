#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Canonical native-triple to VSCE-target mapping.
 *
 * Packaging, publishing, and local installation all consume this table. Keep
 * host detection here as well so unsupported architectures and musl hosts
 * consistently select the natives-free universal package.
 */
export const NATIVE_VARIANTS = Object.freeze([
  Object.freeze({
    target: 'darwin-x64',
    triple: 'x86_64-macos',
    binary: 'tjs',
    platform: 'darwin',
    arch: 'x64'
  }),
  Object.freeze({
    target: 'darwin-arm64',
    triple: 'aarch64-macos',
    binary: 'tjs',
    platform: 'darwin',
    arch: 'arm64'
  }),
  Object.freeze({
    target: 'linux-x64',
    triple: 'x86_64-linux-gnu',
    binary: 'tjs',
    platform: 'linux',
    arch: 'x64'
  }),
  Object.freeze({
    target: 'linux-arm64',
    triple: 'aarch64-linux-gnu',
    binary: 'tjs',
    platform: 'linux',
    arch: 'arm64'
  }),
  Object.freeze({
    target: 'win32-x64',
    triple: 'x86_64-windows',
    binary: 'tjs.exe',
    platform: 'win32',
    arch: 'x64'
  })
]);

export const UNIVERSAL_VARIANT = Object.freeze({
  target: null,
  triple: null,
  binary: null,
  platform: null,
  arch: null
});

export const PACKAGE_VARIANTS = Object.freeze([
  ...NATIVE_VARIANTS,
  UNIVERSAL_VARIANT
]);

export function getVsixFileName(extensionName, version, target) {
  const targetSuffix = target ? `-${target}` : '';
  return `${extensionName}${targetSuffix}-${version}.vsix`;
}

export function getVariantByTarget(target) {
  if (target === null || target === 'universal') {
    return UNIVERSAL_VARIANT;
  }
  return NATIVE_VARIANTS.find((variant) => variant.target === target) ?? null;
}

export function detectLocalTarget({ platform, arch, glibcVersionRuntime } = {}) {
  // The bundled Linux executables are GNU libc builds. An absent glibc runtime
  // marker is treated as musl/unknown and must take the safe universal path.
  if (platform === 'linux' && !glibcVersionRuntime) {
    return null;
  }

  return NATIVE_VARIANTS.find(
    (variant) => variant.platform === platform && variant.arch === arch
  )?.target ?? null;
}

export function detectCurrentTarget() {
  let glibcVersionRuntime;
  if (process.platform === 'linux') {
    try {
      glibcVersionRuntime = process.report?.getReport?.().header?.glibcVersionRuntime;
    } catch {
      // A failed or unavailable runtime report cannot prove GNU compatibility.
      glibcVersionRuntime = undefined;
    }
  }

  return detectLocalTarget({
    platform: process.platform,
    arch: process.arch,
    glibcVersionRuntime
  });
}

function printUsage() {
  console.log('Usage: node scripts/vsix-targets.mjs --current-target');
  console.log('       node scripts/vsix-targets.mjs --current-vsix <extension-name> <version>');
}

export function run(argv = process.argv.slice(2)) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    printUsage();
    return;
  }
  if (argv.length === 1 && argv[0] === '--current-target') {
    console.log(detectCurrentTarget() ?? 'universal');
    return;
  }
  if (argv.length === 3 && argv[0] === '--current-vsix') {
    console.log(getVsixFileName(argv[1], argv[2], detectCurrentTarget()));
    return;
  }
  throw new Error('Expected --current-target or --current-vsix <extension-name> <version>');
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    run();
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
