import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function loadModule(relativePath: string, label: string): Promise<any> {
  try {
    return await import(relativePath);
  } catch (error) {
    assert.fail(`${label} must load: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const assetNames = [
  'sqlite-explorer-darwin-x64-1.6.0.vsix',
  'sqlite-explorer-darwin-arm64-1.6.0.vsix',
  'sqlite-explorer-linux-x64-1.6.0.vsix',
  'sqlite-explorer-linux-arm64-1.6.0.vsix',
  'sqlite-explorer-win32-x64-1.6.0.vsix',
  'sqlite-explorer-1.6.0.vsix'
];

describe('release asset selection', () => {
  it('requires the exact five target packages plus universal in canonical order', async () => {
    const { selectReleaseAssets } = await loadModule(
      '../../scripts/publish-common.mjs',
      'publish common module'
    );
    const release = {
      tagName: 'v1.6.0',
      assets: [
        { name: 'checksums.txt' },
        ...assetNames.slice().reverse().map((name) => ({ name }))
      ]
    };

    const selected = selectReleaseAssets(release, '1.6.0', 'sqlite-explorer');

    assert.deepStrictEqual(selected.map((asset: any) => asset.name), assetNames);
    assert.deepStrictEqual(
      selected.map((asset: any) => asset.variant.target),
      ['darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64', null]
    );
  });

  it('recognizes VSCE target-before-version names in a local release directory', async () => {
    const { selectLocalVsixNames } = await loadModule(
      '../../scripts/publish-common.mjs',
      'publish common module'
    );

    assert.deepStrictEqual(
      selectLocalVsixNames([
        ...assetNames,
        'sqlite-explorer-darwin-x64-1.5.3.vsix',
        'unrelated-1.6.0.vsix'
      ], '1.6.0', 'sqlite-explorer').sort(),
      assetNames.slice().sort()
    );
  });

  it('rejects a missing or foreign VSIX instead of publishing a partial release', async () => {
    const { selectReleaseAssets } = await loadModule(
      '../../scripts/publish-common.mjs',
      'publish common module'
    );

    assert.throws(
      () => selectReleaseAssets({
        tagName: 'v1.6.0',
        assets: [
          ...assetNames.slice(1).map((name) => ({ name })),
          { name: 'sqlite-explorer-win32-arm64-1.6.0.vsix' }
        ]
      }, '1.6.0', 'sqlite-explorer'),
      /exactly the six expected VSIX assets/
    );
  });
});

describe('Open VSX platform publishing', () => {
  it('passes each native asset with its target and keeps the token out of argv', async () => {
    const { publishVsix } = await loadModule(
      '../../scripts/publish-openvsx.mjs',
      'Open VSX publisher'
    );
    const calls: any[] = [];
    const token = 'open-vsx-secret';

    await publishVsix('/tmp/sqlite-explorer-1.6.0-darwin-arm64.vsix', 'darwin-arm64', token, {
      ovsxPath: '/repo/node_modules/.bin/ovsx',
      env: { SAFE: '1' },
      runCommand: async (...args: any[]) => {
        calls.push(args);
        return { code: 0, signal: null, stdout: '', stderr: '' };
      }
    });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], '/repo/node_modules/.bin/ovsx');
    assert.deepStrictEqual(calls[0][1], [
      'publish',
      '--packagePath',
      '/tmp/sqlite-explorer-1.6.0-darwin-arm64.vsix',
      '--target',
      'darwin-arm64'
    ]);
    assert.ok(!calls[0][1].includes(token));
    assert.strictEqual(calls[0][2].env.OVSX_PAT, token);
  });

  it('publishes the universal Open VSX asset without assigning a native target', async () => {
    const { publishVsix } = await loadModule(
      '../../scripts/publish-openvsx.mjs',
      'Open VSX publisher'
    );
    let publishedArgs: string[] = [];

    await publishVsix('/tmp/sqlite-explorer-1.6.0.vsix', null, 'secret', {
      runCommand: async (_command: string, args: string[]) => {
        publishedArgs = args;
        return { code: 0, signal: null, stdout: '', stderr: '' };
      }
    });

    assert.deepStrictEqual(publishedArgs, [
      'publish',
      '--packagePath',
      '/tmp/sqlite-explorer-1.6.0.vsix'
    ]);
  });

  it('preserves the existing Keychain-first Open VSX token lookup', async () => {
    const { resolveToken } = await loadModule(
      '../../scripts/publish-openvsx.mjs',
      'Open VSX publisher'
    );
    const calls: any[] = [];

    const token = await resolveToken({
      env: { OVSX_PAT: 'fallback-token' },
      runCommand: async (...args: any[]) => {
        calls.push(args);
        return { code: 0, signal: null, stdout: 'keychain-token\n', stderr: '' };
      }
    });

    assert.strictEqual(token, 'keychain-token');
    assert.deepStrictEqual(calls[0].slice(0, 2), [
      'security',
      ['find-generic-password', '-s', 'open-vsx', '-a', 'zknpr', '-w']
    ]);
  });

  it('verifies the published artifact through target-specific Open VSX metadata', async () => {
    const { verifyPublishedAsset } = await loadModule(
      '../../scripts/publish-openvsx.mjs',
      'Open VSX publisher'
    );
    const tmpParent = join(process.cwd(), '.tmp');
    await mkdir(tmpParent, { recursive: true });
    const tempDir = await mkdtemp(join(tmpParent, 'openvsx-target-test-'));
    const payload = Buffer.from('target-specific-vsix');
    const releasePath = join(tempDir, 'github.vsix');
    await writeFile(releasePath, payload);
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const requests: string[] = [];

    try {
      const result = await verifyPublishedAsset({
        name: 'sqlite-explorer-darwin-arm64-1.6.0.vsix',
        path: releasePath,
        sha256,
        variant: { target: 'darwin-arm64' }
      }, '1.6.0', {
        tempDir,
        log: () => {},
        fetchImpl: async (url: string) => {
          requests.push(String(url));
          if (requests.length === 1) {
            return new Response(JSON.stringify({
              version: '1.6.0',
              targetPlatform: 'darwin-arm64',
              files: { download: 'https://open-vsx.org/files/darwin-arm64.vsix' }
            }), { status: 200, headers: { 'content-type': 'application/json' } });
          }
          return new Response(payload, { status: 200 });
        }
      });

      assert.deepStrictEqual(requests, [
        'https://open-vsx.org/api/zknpr/sqlite-explorer/darwin-arm64',
        'https://open-vsx.org/files/darwin-arm64.vsix'
      ]);
      assert.deepStrictEqual(result, { githubHash: sha256, openVsxHash: sha256 });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('Marketplace platform publishing', () => {
  it('gives a valid account-scoped Keychain setup command when the PAT is absent', async () => {
    const { resolveMarketplaceToken } = await loadModule(
      '../../scripts/publish-marketplace.mjs',
      'Marketplace publisher'
    );

    await assert.rejects(
      resolveMarketplaceToken({
        runCommand: async () => ({ code: 44, signal: null, stdout: '', stderr: '' })
      }),
      /security add-generic-password -U -s vsce\.k -a zknpr -w/
    );
  });

  it('reads the PAT from service vsce.k and never places it in argv', async () => {
    const { publishVsix, resolveMarketplaceToken } = await loadModule(
      '../../scripts/publish-marketplace.mjs',
      'Marketplace publisher'
    );
    const securityCalls: any[] = [];
    const token = await resolveMarketplaceToken({
      runCommand: async (...args: any[]) => {
        securityCalls.push(args);
        return { code: 0, signal: null, stdout: 'marketplace-secret\n', stderr: '' };
      }
    });
    const publishCalls: any[] = [];

    await publishVsix('/tmp/sqlite-explorer-1.6.0-linux-x64.vsix', token, {
      vscePath: '/repo/node_modules/.bin/vsce',
      env: { SAFE: '1' },
      runCommand: async (...args: any[]) => {
        publishCalls.push(args);
        return { code: 0, signal: null, stdout: '', stderr: '' };
      }
    });

    assert.deepStrictEqual(securityCalls[0].slice(0, 2), [
      'security',
      ['find-generic-password', '-s', 'vsce.k', '-w']
    ]);
    assert.deepStrictEqual(publishCalls[0][1], [
      'publish',
      '--packagePath',
      '/tmp/sqlite-explorer-1.6.0-linux-x64.vsix'
    ]);
    assert.ok(!publishCalls[0][1].includes(token));
    assert.strictEqual(publishCalls[0][2].env.VSCE_PAT, token);
  });

  it('redacts a Marketplace PAT from failed child output', async () => {
    const { publishVsix } = await loadModule(
      '../../scripts/publish-marketplace.mjs',
      'Marketplace publisher'
    );
    const token = 'do-not-leak-this';

    await assert.rejects(
      publishVsix('/tmp/sqlite-explorer-1.6.0.vsix', token, {
        runCommand: async () => ({
          code: 1,
          signal: null,
          stdout: '',
          stderr: `authentication failed for ${token}`
        })
      }),
      (error: Error) => {
        assert.doesNotMatch(error.message, new RegExp(token));
        assert.match(error.message, /\[REDACTED\]/);
        return true;
      }
    );
  });
});
