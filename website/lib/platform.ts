/**
 * Which desktop package fits the visitor's machine, as far as the browser
 * says. Chromium reports the CPU architecture through User-Agent Client
 * Hints; Safari and Firefox do not, and every Mac reports "Intel" in its
 * user agent string, so an unknown architecture is not a reason to hide a
 * package. The download buttons always list every package; this only picks
 * the one to show first.
 */
import type { DesktopPlatform } from './desktop-release';

export interface PlatformGuess {
  platform: DesktopPlatform | null;
  /** True when the browser says this machine cannot run that platform's package. */
  unsupported: boolean;
}

interface UADataLike {
  platform?: string;
  mobile?: boolean;
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string; bitness?: string }>;
}

export function platformFromUserAgent(userAgent: string, maxTouchPoints = 0): DesktopPlatform | null {
  if (/Android|iPhone|iPad|iPod|CrOS/i.test(userAgent)) return null;
  // iPadOS asks for desktop sites with a Mac user agent; a touch screen gives it away.
  if (/Macintosh|Mac OS X/.test(userAgent)) return maxTouchPoints > 1 ? null : 'macos';
  if (/Windows/.test(userAgent)) return 'windows';
  if (/Linux/.test(userAgent)) return 'linux';
  return null;
}

export async function guessPlatform(nav: Navigator): Promise<PlatformGuess> {
  const uaData = (nav as Navigator & { userAgentData?: UADataLike }).userAgentData;
  const platform = platformFromUserAgent(nav.userAgent, nav.maxTouchPoints);
  if (!platform || uaData?.mobile) return { platform: null, unsupported: false };

  let hints: { architecture?: string; bitness?: string } | undefined;
  try {
    hints = await uaData?.getHighEntropyValues?.(['architecture', 'bitness']);
  } catch {
    // The hints are optional; without them the guess rests on the platform alone.
  }
  const unsupported =
    (platform === 'macos' && hints?.architecture === 'x86') ||
    (platform === 'linux' && hints?.architecture === 'arm') ||
    // The Windows and Linux packages are x86-64 builds.
    ((platform === 'windows' || platform === 'linux') && hints?.bitness === '32');
  return { platform, unsupported };
}
