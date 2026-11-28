import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  fetchDesktopRelease,
  formatMegabytes,
  linuxInstallCommand,
  parseReleaseManifest,
  windowsChecksumCommand
} from '../lib/desktop-release.ts';
import { guessPlatform, platformFromUserAgent } from '../lib/platform.ts';

// The shape of the app's real 0.4.0 release-manifest.json.
const manifest = () => ({
  product: 'SQLite Explorer',
  version: '0.4.0',
  tag: 'v0.4.0',
  prerelease: false,
  repository: 'zknpr/SQLite-Explorer-App',
  assets: [
    { name: 'SQLite-Explorer-0.4.0-linux-amd64.deb', bytes: 6292308, sha256: 'c8f7cd3f685582adcdf247696cb6f57d98f322f2907f80c75b70e5a6b6016b46' },
    { name: 'SQLite-Explorer-0.4.0-macos-aarch64.app.tar.gz', bytes: 8668931, sha256: '656b04592eaeac353bc64463729b4f257fe445813e29fdda0bda79ce1ddb0dd3' },
    { name: 'SQLite-Explorer-0.4.0-macos-aarch64.dmg', bytes: 9541073, sha256: 'c44a47c96c843ef361cddb2183bfb3e3de93d73cac6f19abb63e13b2d09339bb' },
    { name: 'SQLite-Explorer-0.4.0-windows-x64-setup.exe', bytes: 5979778, sha256: 'ccbbdfb7fb7bf52d503a43eedaf0bdab2601e809919b74535b09c55cc6bcc548' }
  ]
});

describe('parseReleaseManifest', () => {
  test('builds every download URL from the checked tag and file name', () => {
    const release = parseReleaseManifest(manifest());
    assert.equal(release.version, '0.4.0');
    assert.equal(
      release.assets.macos.url,
      'https://github.com/zknpr/SQLite-Explorer-App/releases/download/v0.4.0/SQLite-Explorer-0.4.0-macos-aarch64.dmg'
    );
    assert.equal(release.assets.windows.name, 'SQLite-Explorer-0.4.0-windows-x64-setup.exe');
    assert.equal(release.assets.linux.bytes, 6292308);
    assert.equal(release.checksumsUrl, 'https://github.com/zknpr/SQLite-Explorer-App/releases/download/v0.4.0/SHA256SUMS');
    for (const asset of Object.values(release.assets)) {
      assert.ok(asset.url.startsWith('https://github.com/zknpr/SQLite-Explorer-App/releases/download/v0.4.0/'));
    }
  });

  test('ignores any URL the manifest carries', () => {
    const value = manifest();
    value.assets[2].url = 'https://attacker.example/SQLite-Explorer.dmg';
    assert.ok(parseReleaseManifest(value).assets.macos.url.startsWith('https://github.com/zknpr/'));
  });

  const rejects = {
    'another repository': value => { value.repository = 'someone/fork'; },
    'a prerelease': value => { value.prerelease = true; },
    'a missing prerelease flag': value => { delete value.prerelease; },
    'a version with a path in it': value => { value.version = '0.4.0/../../x'; value.tag = 'v0.4.0/../../x'; },
    'a tag that is not the version': value => { value.tag = 'v0.3.9'; },
    'a missing package': value => { value.assets = value.assets.filter(a => !a.name.endsWith('.exe')); },
    'a package listed twice': value => { value.assets.push({ ...value.assets[0] }); },
    'an upper-case hash': value => { value.assets[0].sha256 = value.assets[0].sha256.toUpperCase(); },
    'a short hash': value => { value.assets[0].sha256 = 'abc'; },
    'a fractional size': value => { value.assets[0].bytes = 1.5; },
    'a size given as text': value => { value.assets[0].bytes = '6292308'; },
    'a zero size': value => { value.assets[0].bytes = 0; },
    'too many assets': value => { value.assets = [...value.assets, ...Array.from({ length: 64 }, (_, i) => ({ name: `x${i}` }))]; },
    'an array': () => [],
    'null': () => null
  };
  for (const [name, mutate] of Object.entries(rejects)) {
    test(`refuses ${name}`, () => {
      const value = manifest();
      const replaced = mutate(value);
      assert.throws(() => parseReleaseManifest(replaced === undefined ? value : replaced));
    });
  }
});

describe('fetchDesktopRelease', () => {
  const realFetch = globalThis.fetch;
  const realError = console.error;
  afterEach(() => {
    globalThis.fetch = realFetch;
    console.error = realError;
  });

  const respond = (body, init = {}) => async () => new Response(body, { status: 200, ...init });

  test('reads the latest release manifest', async () => {
    let requested;
    globalThis.fetch = async (url, options) => {
      requested = { url: String(url), options };
      return new Response(JSON.stringify(manifest()));
    };
    const release = await fetchDesktopRelease();
    assert.equal(release?.version, '0.4.0');
    assert.equal(requested.url, 'https://github.com/zknpr/SQLite-Explorer-App/releases/latest/download/release-manifest.json');
    assert.equal(requested.options.next.revalidate, 3600);
  });

  const fallbacks = {
    'the network fails': async () => { throw new TypeError('fetch failed'); },
    'GitHub answers 404': respond('Not Found', { status: 404 }),
    'the body is not JSON': respond('<html>'),
    'the body is too large': respond(JSON.stringify({ ...manifest(), padding: 'x'.repeat(70_000) })),
    'the manifest does not check out': respond(JSON.stringify({ ...manifest(), prerelease: true }))
  };
  for (const [name, fetchStub] of Object.entries(fallbacks)) {
    test(`returns null and logs why when ${name}`, async () => {
      const logged = [];
      console.error = (...args) => logged.push(args.join(' '));
      globalThis.fetch = fetchStub;
      assert.equal(await fetchDesktopRelease(), null);
      assert.equal(logged.length, 1);
      assert.match(logged[0], /\[desktop-release\]/);
    });
  }
});

test('formatMegabytes uses decimal megabytes', () => {
  assert.equal(formatMegabytes(9541073), '9.5 MB');
  assert.equal(formatMegabytes(5979778), '6.0 MB');
});

describe('platformFromUserAgent', () => {
  const cases = [
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 0, 'macos'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 5, null],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36', 0, 'windows'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', 0, 'linux'],
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36', 5, null],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148', 5, null],
    ['Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36', 0, null]
  ];
  for (const [ua, touch, expected] of cases) {
    test(`${expected ?? 'no package'} for ${ua.slice(13, 50)} (touch points ${touch})`, () => {
      assert.equal(platformFromUserAgent(ua, touch), expected);
    });
  }
});


describe('install and checksum commands', () => {
  test('name the release file when the manifest was read', () => {
    const release = parseReleaseManifest(manifest());
    assert.equal(linuxInstallCommand(release), 'sudo apt install ./SQLite-Explorer-0.4.0-linux-amd64.deb');
    assert.equal(
      windowsChecksumCommand(release),
      "(Get-FileHash .\\SQLite-Explorer-0.4.0-windows-x64-setup.exe).Hash -eq ((Select-String -Path SHA256SUMS -SimpleMatch 'SQLite-Explorer-0.4.0-windows-x64-setup.exe').Line -split ' ')[0]"
    );
  });

  test('without a manifest, find the downloaded file by a wildcard the shell expands', () => {
    // Angle brackets would be redirections in both shells.
    for (const command of [linuxInstallCommand(null), windowsChecksumCommand(null)]) assert.doesNotMatch(command, /[<>]/);
    assert.equal(linuxInstallCommand(null), 'sudo apt install ./SQLite-Explorer-*-linux-amd64.deb');
    assert.equal(
      windowsChecksumCommand(null),
      "$file = Get-Item .\\SQLite-Explorer-*-windows-x64-setup.exe; (Get-FileHash $file).Hash -eq ((Select-String -Path SHA256SUMS -SimpleMatch $file.Name).Line -split ' ')[0]"
    );
  });
});

describe('guessPlatform', () => {
  const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
  const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
  // A browser answers only the hints it is asked for.
  const navigatorWith = (userAgent, hints) => ({
    userAgent,
    maxTouchPoints: 0,
    userAgentData: {
      mobile: false,
      getHighEntropyValues: async requested => Object.fromEntries(Object.entries(hints).filter(([hint]) => requested.includes(hint)))
    }
  });

  test('a 32-bit Windows or Linux machine cannot run the x86-64 package', async () => {
    for (const [userAgent, platform] of [[WINDOWS, 'windows'], [LINUX, 'linux']]) {
      assert.deepEqual(await guessPlatform(navigatorWith(userAgent, { architecture: 'x86', bitness: '32' })), { platform, unsupported: true });
      assert.deepEqual(await guessPlatform(navigatorWith(userAgent, { architecture: 'x86', bitness: '64' })), { platform, unsupported: false });
      // Without the hint the guess rests on the platform alone.
      assert.deepEqual(await guessPlatform(navigatorWith(userAgent, { architecture: 'x86' })), { platform, unsupported: false });
    }
  });
});
