import Link from 'next/link';
import { FileUp, Lock } from 'lucide-react';

export default function TryYourFile() {
  return (
    <section className="border-t border-edge px-5 py-24 sm:px-6">
      <div className="relative mx-auto max-w-6xl overflow-hidden rounded-3xl border border-edge bg-subtle px-6 py-14 text-center sm:px-12">
        <div aria-hidden="true" className="hero-grid pointer-events-none absolute inset-0 opacity-70" />
        <div className="relative mx-auto max-w-2xl">
          <span className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-2xl border-2 border-dashed border-accent/40 bg-background text-accent">
            <FileUp className="h-6 w-6" aria-hidden="true" />
          </span>
          <h2 className="mt-6 text-3xl font-bold tracking-[-0.025em] sm:text-4xl">Try it on your own database</h2>
          <p className="mt-4 text-lg text-subtle-foreground">
            The demo opens a file from your disk in this browser. Edit it, run SQL against it, then
            download the changed copy. No file handy? The Northwind sample is there too.
          </p>
          <div className="mt-8 flex flex-col items-center gap-4">
            <Link
              href="/demo"
              className="inline-flex h-12 items-center justify-center rounded-lg bg-accent px-7 font-medium text-accent-foreground transition hover:opacity-90"
            >
              Open the demo
            </Link>
            <p className="flex items-center gap-1.5 text-sm text-subtle-foreground">
              <Lock className="h-3.5 w-3.5" aria-hidden="true" />
              SQLite runs in the page as WebAssembly. Your file is never uploaded.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
