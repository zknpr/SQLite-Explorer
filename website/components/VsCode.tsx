import { ExternalLink, Package, Puzzle, Terminal } from 'lucide-react';
import { INSTALL_COMMAND, MARKETPLACE_URL, OPEN_VSX_URL } from '@/lib/links';
import CopyCommand from './CopyCommand';

const steps = [
  <>Open a <code>.db</code>, <code>.sqlite</code>, <code>.sqlite3</code> or <code>.gpkg</code> file from the Explorer.</>,
  'Pick a table or view in the sidebar.',
  'Double-click a cell to edit it, and press Enter to keep the change.'
];

const card = 'flex min-w-0 flex-col rounded-2xl border border-edge bg-background p-6';
const icon = 'inline-flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent';

export default function VsCode() {
  return (
    <section id="vscode" className="scroll-mt-16 border-t border-edge px-5 py-24 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-[-0.025em] sm:text-4xl">Get started in seconds</h2>
          <p className="mt-4 text-lg text-subtle-foreground">
            The extension works in VS&nbsp;Code on the desktop, over Remote SSH, in WSL and dev containers,
            and in VS&nbsp;Code for the Web.
          </p>
        </div>

        <div className="mt-14 grid gap-5 md:grid-cols-3">
          <div className={card}>
            <span className={icon}><Puzzle className="h-5 w-5" aria-hidden="true" /></span>
            <h3 className="mt-5 text-lg font-semibold">Visual Studio Marketplace</h3>
            <p className="mt-2 flex-1 text-[0.9375rem] text-subtle-foreground">
              Search for <strong className="font-medium text-foreground">SQLite Explorer</strong> in the
              Extensions view, or install it from the Marketplace page.
            </p>
            <a
              href={MARKETPLACE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-6 inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-accent-foreground transition hover:opacity-90"
            >
              Open in Marketplace
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
            </a>
          </div>

          <div className={card}>
            <span className={icon}><Package className="h-5 w-5" aria-hidden="true" /></span>
            <h3 className="mt-5 text-lg font-semibold">Open VSX</h3>
            <p className="mt-2 flex-1 text-[0.9375rem] text-subtle-foreground">
              For VSCodium and other editors that install extensions from the Open VSX registry.
            </p>
            <a
              href={OPEN_VSX_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-6 inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-edge px-4 text-sm font-medium transition hover:bg-subtle"
            >
              Open in Open VSX
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
            </a>
          </div>

          <div className={card}>
            <span className={icon}><Terminal className="h-5 w-5" aria-hidden="true" /></span>
            <h3 className="mt-5 text-lg font-semibold">Command line</h3>
            <p className="mt-2 flex-1 text-[0.9375rem] text-subtle-foreground">
              Install it with the VS&nbsp;Code command line tool.
            </p>
            <CopyCommand command={INSTALL_COMMAND} className="mt-6" />
          </div>
        </div>

        <div className="mt-5 rounded-2xl border border-edge bg-subtle p-6 sm:p-8">
          <h3 className="font-semibold">Then</h3>
          <ol className="mt-4 grid gap-4 md:grid-cols-3">
            {steps.map((step, i) => (
              <li key={i} className="flex items-start gap-3 text-[0.9375rem] text-subtle-foreground">
                <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-edge bg-background text-xs font-semibold text-foreground">
                  {i + 1}
                </span>
                <span className="pt-0.5">{step}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
