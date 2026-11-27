/**
 * What the viewer does. Each claim here is taken from the extension's README
 * and CHANGELOG or the desktop app's README; check them there before editing.
 */
import { Binary, Download, Hash, ListFilter, PencilLine, SquareTerminal } from 'lucide-react';

const capabilities = [
  {
    icon: ListFilter,
    term: 'Browse tables and views',
    detail:
      'Sort by any column, filter one column or the whole table, and pin rows and columns while you scroll. Pages seek by key, so the last page of a big table opens as fast as the first.'
  },
  {
    icon: PencilLine,
    term: 'Edit with undo',
    detail:
      'Double-click a cell to change it. Add and delete rows and columns, create tables, or set one column across many rows at once. In VS\u00a0Code and the desktop app, Undo and Redo cover every kind of edit.'
  },
  {
    icon: SquareTerminal,
    term: 'Run SQL',
    detail:
      'Write a SELECT with ? parameters and page through up to 1,000 result rows. In VS\u00a0Code and the desktop app, Explain Query Plan shows how SQLite will run it.'
  },
  {
    icon: Download,
    term: 'Import and export',
    detail:
      'Export a table, or just the selected rows, as CSV, JSON or SQL INSERT statements. In VS\u00a0Code and the desktop app you can import CSV or JSON into a table and undo the whole import in one step.'
  },
  {
    icon: Binary,
    term: 'Look inside BLOBs',
    detail:
      'Images, audio and video stored in a cell show or play in place. Other bytes open in a hex view, 16 KiB at a time, and any value can be saved to a file.'
  },
  {
    icon: Hash,
    term: 'Keep values exact',
    detail:
      'Integers beyond 2^53 keep every digit when you view, edit, filter or export them, and text containing NUL characters stays whole.'
  }
];

export default function Capabilities() {
  return (
    <section className="border-t border-edge px-5 py-24 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-[-0.025em] sm:text-4xl">
            Browse, edit and query, right where you are
          </h2>
          <p className="mt-4 text-lg text-subtle-foreground">
            One viewer in VS&nbsp;Code, the desktop app and the browser, with the same features in each
            except where noted.
          </p>
        </div>
        <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-edge bg-edge sm:grid-cols-2 lg:grid-cols-3">
          {capabilities.map(({ icon: Icon, term, detail }) => (
            <div key={term} className="bg-background p-7 transition-colors hover:bg-subtle/60">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <Icon className="h-5 w-5" strokeWidth={2} aria-hidden="true" />
              </span>
              <h3 className="mt-5 text-lg font-semibold">{term}</h3>
              <p className="mt-2 text-[0.9375rem] leading-relaxed text-subtle-foreground">{detail}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
