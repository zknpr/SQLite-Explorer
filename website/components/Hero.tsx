import Link from 'next/link';
import { ChevronRight, Download, Scale, Star } from 'lucide-react';
import type { DesktopRelease } from '@/lib/desktop-release';
import type { ExtensionStats } from '@/lib/extension-stats';
import { MARKETPLACE_URL } from '@/lib/links';
import DownloadButton from './DownloadButton';
import LivePreview from './LivePreview';
import RotatingWords from './RotatingWords';

const PLACES = ['in VS Code', 'on your desktop', 'in your browser'] as const;

export default function Hero({ release, stats }: { release: DesktopRelease | null; stats: ExtensionStats | null }) {
  return (
    <section className="relative overflow-hidden px-5 pb-20 sm:px-6 pt-16 md:pt-24">
      <div aria-hidden="true" className="hero-grid pointer-events-none absolute inset-x-0 top-0 h-[560px]" />

      <div className="relative mx-auto max-w-4xl text-center">
        {release && (
          <Link
            href="/download"
            className="inline-flex items-center gap-2 rounded-full border border-edge bg-background py-1 pl-1 pr-3 text-sm text-subtle-foreground shadow-sm transition-colors hover:border-subtle-foreground/40 hover:text-foreground"
          >
            <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-accent-foreground">New</span>
            <span>
              Desktop app {release.version}
              <span className="hidden sm:inline"> for macOS, Windows and Linux</span>
            </span>
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        )}

        <h1 className="mt-7 text-[2.75rem] font-bold leading-[1.06] tracking-[-0.035em] sm:text-6xl md:text-7xl">
          <span className="sr-only">View and edit SQLite in VS Code, on your desktop or in your browser</span>
          <span aria-hidden="true">
            View and Edit SQLite
            <br />
            <RotatingWords words={PLACES} className="text-accent" />
          </span>
        </h1>

        <p className="mx-auto mt-6 max-w-2xl text-lg text-subtle-foreground sm:text-xl">
          An open source viewer and editor for SQLite databases. Browse tables, edit cells, run SQL and
          export your data.
        </p>

        <div className="mx-auto mt-9 flex max-w-xs flex-col gap-3 sm:max-w-none sm:flex-row sm:justify-center">
          <a
            href={MARKETPLACE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-12 items-center justify-center rounded-lg bg-accent px-6 font-medium text-accent-foreground transition hover:opacity-90"
          >
            Install for VS&nbsp;Code
          </a>
          <DownloadButton release={release} variant="dark" />
        </div>

        <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-subtle-foreground">
          {stats && (
            <li className="flex items-center gap-1.5">
              <Download className="h-4 w-4" aria-hidden="true" />
              {stats.installs.toLocaleString('en-US')}+ installs
            </li>
          )}
          {stats?.rating != null && (
            <li className="flex items-center gap-1.5">
              <Star className="h-4 w-4 fill-amber-400 text-amber-400" aria-hidden="true" />
              {stats.rating.toFixed(1)} on the Marketplace
            </li>
          )}
          <li className="flex items-center gap-1.5">
            <Scale className="h-4 w-4" aria-hidden="true" />
            Free and open source
          </li>
        </ul>
      </div>

      <div className="relative mx-auto mt-16 max-w-6xl">
        <div
          aria-hidden="true"
          className="absolute left-1/2 top-1/3 -z-10 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-accent/20 blur-[110px]"
        />
        <a
          href="#desktop"
          className="sr-only rounded-md bg-accent px-3 py-2 font-medium text-accent-foreground focus:not-sr-only focus:absolute focus:z-10 focus:-translate-y-12"
        >
          Skip the live preview
        </a>
        <div className="rounded-2xl border border-edge bg-subtle/70 p-1.5 shadow-2xl shadow-black/10 backdrop-blur sm:p-2">
          <LivePreview />
        </div>
        <p className="mx-auto mt-5 max-w-2xl text-center text-sm text-subtle-foreground">
          This is the real viewer, running the Chinook sample on SQLite compiled to WebAssembly. Click
          around and edit anything. The database never leaves your browser.
        </p>
      </div>
    </section>
  );
}
