/**
 * The desktop app's latest release, read from the release-manifest.json that
 * the app's release workflow attaches to every release.
 *
 * The manifest is treated as untrusted input: every field the site uses is
 * checked against a fixed shape, and download URLs are built here from the
 * checked tag and file names rather than taken from the manifest. A manifest
 * that does not match the shape gives no release at all, and the pages fall
 * back to the GitHub releases page.
 */

export const APP_REPO = 'zknpr/SQLite-Explorer-App';
export const APP_REPO_URL = `https://github.com/${APP_REPO}`;
export const APP_RELEASES_URL = `${APP_REPO_URL}/releases/latest`;
export const APP_INSTALL_NOTES_URL = `${APP_REPO_URL}#install`;
export const APP_SIGNING_POLICY_URL = `${APP_REPO_URL}/blob/main/docs/code-signing-policy.md`;

const MANIFEST_URL = `${APP_REPO_URL}/releases/latest/download/release-manifest.json`;
const MANIFEST_MAX_CHARS = 64 * 1024;
const MANIFEST_MAX_ASSETS = 64;
const ASSET_MAX_BYTES = 2 ** 31;

export const DESKTOP_PLATFORMS = ['macos', 'windows', 'linux'] as const;
export type DesktopPlatform = typeof DESKTOP_PLATFORMS[number];

export interface DesktopAsset {
  platform: DesktopPlatform;
  name: string;
  url: string;
  bytes: number;
  sha256: string;
}

export interface DesktopRelease {
  version: string;
  tag: string;
  releaseUrl: string;
  checksumsUrl: string;
  assets: Record<DesktopPlatform, DesktopAsset>;
}

/** What each package is, in the words the download buttons use. */
export const PACKAGE_INFO: Record<DesktopPlatform, { suffix: string; os: string; build: string }> = {
  macos: { suffix: 'macos-aarch64.dmg', os: 'macOS', build: 'Apple Silicon' },
  windows: { suffix: 'windows-x64-setup.exe', os: 'Windows', build: 'x86-64' },
  linux: { suffix: 'linux-amd64.deb', os: 'Linux', build: 'x86-64 .deb' }
};

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Check a parsed manifest and build the release from it. Throws on any mismatch. */
export function parseReleaseManifest(value: unknown): DesktopRelease {
  if (!isRecord(value)) throw new Error('manifest is not an object');
  if (value.repository !== APP_REPO) throw new Error('manifest names another repository');
  if (value.prerelease !== false) throw new Error('manifest is not for a final release');
  const { version, tag } = value;
  if (typeof version !== 'string' || !VERSION.test(version)) throw new Error('manifest version is malformed');
  if (tag !== `v${version}`) throw new Error('manifest tag does not match its version');
  const list = value.assets;
  if (!Array.isArray(list) || list.length > MANIFEST_MAX_ASSETS) throw new Error('manifest assets are malformed');

  const base = `${APP_REPO_URL}/releases/download/${tag}`;
  const assets = {} as Record<DesktopPlatform, DesktopAsset>;
  for (const platform of DESKTOP_PLATFORMS) {
    const name = `SQLite-Explorer-${version}-${PACKAGE_INFO[platform].suffix}`;
    const matches = list.filter(entry => isRecord(entry) && entry.name === name);
    if (matches.length !== 1) throw new Error(`manifest lists ${matches.length} copies of ${name}`);
    const { bytes, sha256 } = matches[0] as Record<string, unknown>;
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > ASSET_MAX_BYTES) {
      throw new Error(`manifest size of ${name} is malformed`);
    }
    if (typeof sha256 !== 'string' || !SHA256.test(sha256)) throw new Error(`manifest hash of ${name} is malformed`);
    assets[platform] = { platform, name, url: `${base}/${name}`, bytes, sha256 };
  }

  return {
    version,
    tag,
    releaseUrl: `${APP_REPO_URL}/releases/tag/${tag}`,
    checksumsUrl: `${base}/SHA256SUMS`,
    assets
  };
}

/**
 * Read the latest release at build time and again at most once an hour
 * (the fetch's revalidate). Returns null, and logs why, when the manifest
 * cannot be read or does not check out.
 */
export async function fetchDesktopRelease(): Promise<DesktopRelease | null> {
  try {
    const response = await fetch(MANIFEST_URL, {
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > MANIFEST_MAX_CHARS) throw new Error('manifest is too large');
    return parseReleaseManifest(JSON.parse(text));
  } catch (error) {
    console.error(`[desktop-release] Showing the releases page instead of direct downloads: ${
      error instanceof Error ? error.message : String(error)
    }`);
    return null;
  }
}

/** 9541073 -> "9.5 MB" (decimal megabytes, as most download pages show). */
export function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
