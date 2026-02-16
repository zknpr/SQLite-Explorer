/**
 * Installation — Styled code blocks with editorial heading
 *
 * JetBrains Mono in code blocks. Accent-colored step numbers.
 * Quick start uses a warm card with left accent.
 */

'use client';

import { useState } from 'react';
import { Check, Copy, ExternalLink, Terminal } from 'lucide-react';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="p-2 rounded-lg hover:bg-[var(--ui-edge)]/50 transition-colors"
      aria-label={copied ? 'Copied' : 'Copy to clipboard'}
    >
      {copied ? (
        <Check className="w-4 h-4 text-[var(--ui-accent)]" strokeWidth={2.5} />
      ) : (
        <Copy className="w-4 h-4 text-[var(--ui-subtle-fg)]" strokeWidth={1.75} />
      )}
    </button>
  );
}

function CodeBlock({ code, label }: { code: string; label: string }) {
  return (
    <div className="rounded-xl border border-[var(--ui-edge)]/60 bg-[var(--ui-subtle)] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--ui-edge)]/40">
        <div className="flex items-center gap-2 text-xs text-[var(--ui-subtle-fg)] font-mono uppercase tracking-wide">
          <Terminal className="w-3.5 h-3.5" strokeWidth={2} />
          {label}
        </div>
        <CopyButton text={code} />
      </div>

      <div className="p-4 overflow-x-auto">
        <pre className="text-sm font-mono">
          <code>{code}</code>
        </pre>
      </div>
    </div>
  );
}

export default function Installation() {
  return (
    <section id="install" className="py-32 px-6">
      <div className="max-w-4xl mx-auto">
        <div className="mb-16">
          <span className="font-mono text-xs tracking-widest uppercase text-[var(--ui-accent)] block mb-3">
            Install
          </span>
          <h2 className="text-4xl sm:text-5xl tracking-tight leading-[1.15]">
            Get started in seconds
          </h2>
          <p className="text-lg text-[var(--ui-subtle-fg)] mt-5 leading-relaxed font-sans">
            Install from the VS Code Marketplace or use the command line.
          </p>
        </div>

        <div className="space-y-10">
          {/* Method 1: Marketplace */}
          <div className="space-y-4">
            <h3 className="text-xl flex items-center gap-3">
              <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-[var(--ui-accent)] text-[var(--ui-accent-fg)] text-sm font-mono font-bold">
                1
              </span>
              <span className="font-sans font-semibold">VS Code Marketplace</span>
            </h3>
            <p className="text-[var(--ui-subtle-fg)] ml-11 font-sans">
              The easiest way. Click the button below or search{' '}
              <code>SQLite Explorer</code> in VS Code Extensions.
            </p>
            <div className="ml-11">
              <a
                href="https://marketplace.visualstudio.com/items?itemName=zknpr.sqlite-explorer"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[var(--ui-accent)] text-[var(--ui-accent-fg)] font-medium hover:brightness-110 transition-all hover:shadow-lg hover:shadow-[var(--ui-accent)]/20"
              >
                Open in Marketplace
                <ExternalLink className="w-4 h-4" strokeWidth={2.25} />
              </a>
            </div>
          </div>

          {/* Method 2: CLI */}
          <div className="space-y-4">
            <h3 className="text-xl flex items-center gap-3">
              <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-[var(--ui-accent)] text-[var(--ui-accent-fg)] text-sm font-mono font-bold">
                2
              </span>
              <span className="font-sans font-semibold">Command Line</span>
            </h3>
            <p className="text-[var(--ui-subtle-fg)] ml-11 font-sans">
              Install directly from your terminal using the VS Code CLI.
            </p>
            <div className="ml-11">
              <CodeBlock
                code="code --install-extension zknpr.sqlite-explorer"
                label="Terminal"
              />
            </div>
          </div>

          {/* Quick start — card with left accent */}
          <div className="relative mt-16 p-8 rounded-2xl border border-[var(--ui-edge)]/60 bg-[var(--ui-subtle)]">
            <div className="absolute left-0 top-8 bottom-8 w-[3px] rounded-full bg-[var(--ui-accent)]" />
            <div className="pl-4">
              <h3 className="text-xl mb-6">Quick Start</h3>
              <ol className="space-y-4 text-[var(--ui-subtle-fg)] font-sans">
                {[
                  <>Open any <code>.sqlite</code>, <code>.db</code>, or <code>.sqlite3</code> file in VS Code</>,
                  'Browse tables in the sidebar and click to view data',
                  'Double-click any cell to edit, press Enter to save',
                  <>Press <code>Ctrl+S</code> to save changes to disk</>,
                ].map((step, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-[var(--ui-bg)] border border-[var(--ui-edge)] text-xs font-mono font-medium flex-shrink-0 mt-0.5">
                      {i + 1}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
