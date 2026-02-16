/**
 * Installation Component
 *
 * Two installation methods (Marketplace + CLI) with a quick start guide.
 * Code blocks include copy-to-clipboard functionality.
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
    <div className="rounded-xl border border-[var(--ui-edge)] bg-[var(--ui-subtle)] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--ui-edge)]">
        <div className="flex items-center gap-2 text-xs text-[var(--ui-subtle-fg)]">
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
    <section id="install" className="py-24 px-6">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            Get started in seconds
          </h2>
          <p className="text-lg text-[var(--ui-subtle-fg)] max-w-2xl mx-auto">
            Install from the VS Code Marketplace or use the command line.
          </p>
        </div>

        <div className="space-y-10">
          {/* Method 1: Marketplace */}
          <div className="space-y-4">
            <h3 className="text-xl font-semibold flex items-center gap-3">
              <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-[var(--ui-accent)] text-[var(--ui-accent-fg)] text-sm font-bold">
                1
              </span>
              VS Code Marketplace
            </h3>
            <p className="text-[var(--ui-subtle-fg)] ml-11">
              The easiest way. Click the button below or search{' '}
              <code>SQLite Explorer</code> in VS Code Extensions.
            </p>
            <div className="ml-11">
              <a
                href="https://marketplace.visualstudio.com/items?itemName=zknpr.sqlite-explorer"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[var(--ui-accent)] text-[var(--ui-accent-fg)] font-medium hover:opacity-90 transition-opacity"
              >
                Open in Marketplace
                <ExternalLink className="w-4 h-4" strokeWidth={2.25} />
              </a>
            </div>
          </div>

          {/* Method 2: CLI */}
          <div className="space-y-4">
            <h3 className="text-xl font-semibold flex items-center gap-3">
              <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-[var(--ui-accent)] text-[var(--ui-accent-fg)] text-sm font-bold">
                2
              </span>
              Command Line
            </h3>
            <p className="text-[var(--ui-subtle-fg)] ml-11">
              Install directly from your terminal using the VS Code CLI.
            </p>
            <div className="ml-11">
              <CodeBlock
                code="code --install-extension zknpr.sqlite-explorer"
                label="Terminal"
              />
            </div>
          </div>

          {/* Quick start */}
          <div className="mt-16 p-8 rounded-xl border border-[var(--ui-edge)] bg-[var(--ui-subtle)]">
            <h3 className="text-xl font-semibold mb-6">Quick Start</h3>
            <ol className="space-y-4 text-[var(--ui-subtle-fg)]">
              {[
                <>Open any <code>.sqlite</code>, <code>.db</code>, or <code>.sqlite3</code> file in VS Code</>,
                'Browse tables in the sidebar and click to view data',
                'Double-click any cell to edit, press Enter to save',
                <>Press <code>Ctrl+S</code> to save changes to disk</>,
              ].map((step, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-[var(--ui-bg)] border border-[var(--ui-edge)] text-xs font-medium flex-shrink-0 mt-0.5">
                    {i + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}
