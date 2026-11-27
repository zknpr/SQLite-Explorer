import Link from 'next/link';
import { AppWindow, FolderOpen, Layers, RefreshCw, Terminal, Undo2 } from 'lucide-react';
import { APP_RELEASES_URL, APP_REPO_URL, type DesktopRelease } from '@/lib/desktop-release';
import DownloadButton, { DownloadMeta } from './DownloadButton';
import PlatformRows from './PlatformRows';

const appFacts = [
  { icon: Layers, text: 'Several databases open at once, each in its own tab' },
  { icon: FolderOpen, text: 'Your system\'s own menus and file dialogs' },
  { icon: Undo2, text: 'Undo and Redo, and nothing is written until you save' },
  { icon: Terminal, text: 'SQL with parameters, query plans, CSV and JSON import' },
  { icon: RefreshCw, text: 'Updates when you agree, signed with the project\'s key' }
];

export default function DesktopApp({ release }: { release: DesktopRelease | null }) {
  return (
    <section id="desktop" className="scroll-mt-16 border-t border-edge bg-subtle px-5 py-24 sm:px-6">
      <div className="mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-2 lg:gap-20">
        <div>
          <p className="inline-flex items-center gap-2 text-sm font-semibold text-accent">
            <AppWindow className="h-4 w-4" aria-hidden="true" />
            Desktop app
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-[-0.025em] sm:text-4xl">
            No VS&nbsp;Code? Get the desktop app.
          </h2>
          <p className="mt-4 max-w-xl text-lg text-subtle-foreground">
            The same viewer in an app of its own, for macOS, Windows and Linux. It carries both of the
            extension&apos;s SQLite engines, native and WebAssembly.
          </p>
          <ul className="mt-8 grid gap-3.5 sm:grid-cols-2 sm:gap-x-6">
            {appFacts.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3 text-[0.9375rem]">
                <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-edge bg-background text-accent">
                  <Icon className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                </span>
                <span className="pt-0.5">{text}</span>
              </li>
            ))}
          </ul>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <DownloadButton release={release} variant="primary" />
            <Link
              href="/download"
              className="inline-flex h-12 items-center justify-center rounded-lg border border-edge bg-background px-6 font-medium transition hover:bg-subtle"
            >
              Other platforms
            </Link>
          </div>
          <DownloadMeta release={release} className="mt-3 text-sm text-subtle-foreground" />
        </div>

        <div>
          {release ? (
            <>
              <PlatformRows release={release} />
              <p className="mt-4 text-sm text-subtle-foreground">
                <a href={release.releaseUrl} className="underline underline-offset-4 hover:text-foreground">
                  Release notes for {release.version}
                </a>
                <span aria-hidden="true"> &nbsp;/&nbsp; </span>
                <a href={APP_REPO_URL} className="underline underline-offset-4 hover:text-foreground">
                  Source code
                </a>
              </p>
            </>
          ) : (
            <p className="rounded-xl border border-edge bg-background p-6 text-subtle-foreground">
              The packages are on the{' '}
              <a href={APP_RELEASES_URL} className="text-accent underline underline-offset-4">releases page</a>.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
