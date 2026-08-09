import { describe, it } from 'node:test';
import assert from 'node:assert';

async function loadTargets(): Promise<any> {
  try {
    const modulePath = '../../scripts/vsix-targets.mjs';
    return await import(modulePath);
  } catch (error) {
    assert.fail(`VSIX target module must load: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadPackager(): Promise<any> {
  try {
    const modulePath = '../../scripts/package-vsix.mjs';
    return await import(modulePath);
  } catch (error) {
    assert.fail(`VSIX packaging module must load: ${error instanceof Error ? error.message : String(error)}`);
  }
}

describe('VSIX platform definitions', () => {
  it('defines the complete native triple to VSCE target mapping once', async () => {
    const { NATIVE_VARIANTS } = await loadTargets();

    assert.deepStrictEqual(
      NATIVE_VARIANTS.map((variant: any) => ({
        target: variant.target,
        triple: variant.triple,
        binary: variant.binary
      })),
      [
        { target: 'darwin-x64', triple: 'x86_64-macos', binary: 'tjs' },
        { target: 'darwin-arm64', triple: 'aarch64-macos', binary: 'tjs' },
        { target: 'linux-x64', triple: 'x86_64-linux-gnu', binary: 'tjs' },
        { target: 'linux-arm64', triple: 'aarch64-linux-gnu', binary: 'tjs' },
        { target: 'win32-x64', triple: 'x86_64-windows', binary: 'tjs.exe' }
      ]
    );
  });

  it('selects native packages only for supported host and libc combinations', async () => {
    const { detectLocalTarget } = await loadTargets();

    assert.strictEqual(detectLocalTarget({ platform: 'darwin', arch: 'x64' }), 'darwin-x64');
    assert.strictEqual(detectLocalTarget({ platform: 'darwin', arch: 'arm64' }), 'darwin-arm64');
    assert.strictEqual(
      detectLocalTarget({ platform: 'linux', arch: 'x64', glibcVersionRuntime: '2.39' }),
      'linux-x64'
    );
    assert.strictEqual(
      detectLocalTarget({ platform: 'linux', arch: 'arm64', glibcVersionRuntime: '2.39' }),
      'linux-arm64'
    );
    assert.strictEqual(detectLocalTarget({ platform: 'win32', arch: 'x64' }), 'win32-x64');
    assert.strictEqual(detectLocalTarget({ platform: 'win32', arch: 'arm64' }), null);
    assert.strictEqual(detectLocalTarget({ platform: 'linux', arch: 'x64' }), null);
    assert.strictEqual(detectLocalTarget({ platform: 'freebsd', arch: 'x64' }), null);
  });

  it('derives VSCE default package names for target and universal variants', async () => {
    const { getVsixFileName } = await loadTargets();

    assert.strictEqual(
      getVsixFileName('sqlite-explorer', '1.6.0', 'darwin-arm64'),
      'sqlite-explorer-darwin-arm64-1.6.0.vsix'
    );
    assert.strictEqual(
      getVsixFileName('sqlite-explorer', '1.6.0', null),
      'sqlite-explorer-1.6.0.vsix'
    );
  });
});

describe('VSIX content gate', () => {
  const commonEntries = [
    '[Content_Types].xml',
    'extension.vsixmanifest',
    'extension/package.json',
    'extension/out/extension.js',
    'extension/out/extension-browser.js',
    'extension/assets/sqlite3.wasm'
  ];

  it('allows only the selected native binary and shared native worker', async () => {
    const { NATIVE_VARIANTS } = await loadTargets();
    const { getNativeStageFiles, validatePackageEntries } = await loadPackager();
    const variant = NATIVE_VARIANTS.find((candidate: any) => candidate.target === 'darwin-arm64');

    assert.deepStrictEqual(getNativeStageFiles(variant), [
      'natives/native-worker.js',
      'natives/aarch64-macos/tjs'
    ]);
    assert.doesNotThrow(() => validatePackageEntries([
      ...commonEntries,
      'extension/natives/native-worker.js',
      'extension/natives/aarch64-macos/tjs'
    ], variant));
  });

  it('rejects a foreign native from a target package', async () => {
    const { NATIVE_VARIANTS } = await loadTargets();
    const { validatePackageEntries } = await loadPackager();
    const variant = NATIVE_VARIANTS.find((candidate: any) => candidate.target === 'darwin-arm64');

    assert.throws(
      () => validatePackageEntries([
        ...commonEntries,
        'extension/natives/native-worker.js',
        'extension/natives/aarch64-macos/tjs',
        'extension/natives/x86_64-linux-gnu/tjs'
      ], variant),
      /foreign or unexpected native/
    );
  });

  it('rejects every native path from the universal package', async () => {
    const { UNIVERSAL_VARIANT } = await loadTargets();
    const { getNativeStageFiles, validatePackageEntries } = await loadPackager();

    assert.deepStrictEqual(getNativeStageFiles(UNIVERSAL_VARIANT), []);
    assert.throws(
      () => validatePackageEntries([
        ...commonEntries,
        'extension/natives/native-worker.js'
      ], UNIVERSAL_VARIANT),
      /universal package contains native content/
    );
  });

  it('rejects a package that drops the browser entry point', async () => {
    const { UNIVERSAL_VARIANT } = await loadTargets();
    const { validatePackageEntries } = await loadPackager();

    assert.throws(
      () => validatePackageEntries(
        commonEntries.filter((entry) => entry !== 'extension/out/extension-browser.js'),
        UNIVERSAL_VARIANT
      ),
      /browser entry point/
    );
  });

  it('pins the VSIX manifest target and leaves universal untargeted', async () => {
    const { NATIVE_VARIANTS, UNIVERSAL_VARIANT } = await loadTargets();
    const { validateVsixTargetManifest } = await loadPackager();
    const variant = NATIVE_VARIANTS.find((candidate: any) => candidate.target === 'linux-x64');

    assert.doesNotThrow(() => validateVsixTargetManifest(
      '<Identity Id="sqlite-explorer" TargetPlatform="linux-x64"/>',
      variant
    ));
    assert.throws(
      () => validateVsixTargetManifest(
        '<Identity Id="sqlite-explorer" TargetPlatform="linux-arm64"/>',
        variant
      ),
      /target platform/
    );
    assert.doesNotThrow(() => validateVsixTargetManifest(
      '<Identity Id="sqlite-explorer"/>',
      UNIVERSAL_VARIANT
    ));
    assert.throws(
      () => validateVsixTargetManifest(
        '<Identity Id="sqlite-explorer" TargetPlatform="web"/>',
        UNIVERSAL_VARIANT
      ),
      /must not declare a target platform/
    );
  });
});
