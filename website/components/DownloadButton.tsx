'use client';

/**
 * Desktop download links that point at the package for the visitor's system
 * once the browser has said what that is. The server render and the first
 * client render always show the generic link, so hydration never sees a
 * mismatch; the guess replaces it afterwards.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import {
  PACKAGE_INFO,
  formatMegabytes,
  type DesktopAsset,
  type DesktopPlatform,
  type DesktopRelease
} from '@/lib/desktop-release';
import { guessPlatform, type PlatformGuess } from '@/lib/platform';

/** One sentence about the first launch, for the guessed system. */
export const FIRST_LAUNCH_HINT: Record<DesktopPlatform, string> = {
  macos: 'The app is not notarized yet, so macOS asks you to allow its first launch.',
  windows: 'The installer is unsigned, so SmartScreen asks you to confirm it.',
  linux: 'The package needs Ubuntu 24.04, Debian 13 or a newer glibc-based system.'
};

export function usePlatformGuess(): PlatformGuess | null {
  const [guess, setGuess] = useState<PlatformGuess | null>(null);
  useEffect(() => {
    let live = true;
    void guessPlatform(navigator).then(result => {
      if (live) setGuess(result);
    });
    return () => {
      live = false;
    };
  }, []);
  return guess;
}

/** The package that fits this machine, or null until (or unless) one does. */
export function useDesktopAsset(release: DesktopRelease | null): DesktopAsset | null {
  const guess = usePlatformGuess();
  const platform = guess && !guess.unsupported ? guess.platform : null;
  return release && platform ? release.assets[platform] : null;
}

const variants = {
  primary: 'bg-accent text-accent-foreground hover:opacity-90',
  dark: 'bg-foreground text-background hover:opacity-90',
  outline: 'border border-edge bg-background hover:bg-subtle'
} as const;

export default function DownloadButton({
  release,
  variant = 'dark',
  fallbackHref = '/download'
}: {
  release: DesktopRelease | null;
  variant?: keyof typeof variants;
  /** Where the button goes when no package fits or the release is unknown. */
  fallbackHref?: string;
}) {
  const asset = useDesktopAsset(release);
  const base = `inline-flex h-12 items-center justify-center gap-2.5 rounded-lg px-6 font-medium transition ${variants[variant]}`;
  const icon = <Download className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden="true" />;

  if (!asset) {
    // next/link ignores a click on a fragment the URL already has, so a
    // same-page fragment (and an external page) gets a plain link.
    const Anchor = fallbackHref.startsWith('/') ? Link : 'a';
    return (
      <Anchor href={fallbackHref} className={base} data-download-platform="none">
        {icon}
        Get the desktop app
      </Anchor>
    );
  }
  return (
    <a href={asset.url} className={base} data-download-platform={asset.platform}>
      {icon}
      Download for {PACKAGE_INFO[asset.platform].os}
    </a>
  );
}

/** A quiet line about the package the button above it downloads. */
export function DownloadMeta({ release, className = '' }: { release: DesktopRelease | null; className?: string }) {
  const asset = useDesktopAsset(release);
  if (!release) return null;
  return (
    <p className={className}>
      {asset ? (
        <>
          Desktop app {release.version} for {PACKAGE_INFO[asset.platform].build}, {formatMegabytes(asset.bytes)}.{' '}
          <Link href={`/download#${asset.platform}`} className="underline underline-offset-4 hover:text-foreground">
            Install steps
          </Link>
        </>
      ) : (
        <>Desktop app {release.version} for macOS, Windows and Linux.</>
      )}
    </p>
  );
}
