'use client';

/**
 * Every desktop package as a card with its own download link. After
 * hydration the card for the visitor's system is marked and its button
 * becomes the primary one; the server render shows all three alike.
 */

import { Download } from 'lucide-react';
import {
  DESKTOP_PLATFORMS,
  PACKAGE_INFO,
  formatMegabytes,
  type DesktopRelease
} from '@/lib/desktop-release';
import { useDesktopAsset } from './DownloadButton';

export default function PlatformRows({ release }: { release: DesktopRelease }) {
  const mine = useDesktopAsset(release);
  return (
    <ul className="grid gap-3">
      {DESKTOP_PLATFORMS.map(platform => {
        const asset = release.assets[platform];
        const info = PACKAGE_INFO[platform];
        const isMine = mine?.platform === platform;
        return (
          <li
            key={platform}
            className={`flex items-center gap-4 rounded-xl border bg-background p-4 transition-colors sm:p-5 ${
              isMine ? 'border-accent/60 shadow-[0_0_0_4px] shadow-accent/10' : 'border-edge'
            }`}
          >
            <div className="min-w-0 flex-1">
              <p className="font-semibold">
                {info.os}
                {isMine && (
                  <span className="ml-2 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
                    This computer
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-sm text-subtle-foreground">
                {info.build}, {formatMegabytes(asset.bytes)}
              </p>
            </div>
            <a
              href={asset.url}
              className={`inline-flex h-10 shrink-0 items-center gap-2 rounded-lg px-4 text-sm font-medium transition ${
                isMine ? 'bg-accent text-accent-foreground hover:opacity-90' : 'border border-edge hover:bg-subtle'
              }`}
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Download<span className="sr-only"> for {info.os}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
