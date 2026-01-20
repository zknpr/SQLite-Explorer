/**
 * Installation Component
 *
 * Provides clear installation instructions with copy-paste commands.
 * Two methods: VS Code Marketplace and CLI installation.
 *
 * Design: Code blocks with copy buttons, clean and scannable.
 */

'use client';

import { useState } from 'react';
import { Check, Copy, ExternalLink, Terminal } from 'lucide-react';

/**
 * CopyButton provides a button that copies text to clipboard.
 * Shows a checkmark briefly after successful copy.
 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      // Clipboard API may fail in some environments
      console.error('Failed to copy:', err);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="p-2 rounded-md hover:bg-[var(--muted)] transition-colors"
      aria-label={copied ? 'Copied' : 'Copy to clipboard'}
    >
      {copied ? (
        <Check className="w-4 h-4 text-green-500" />
      ) : (
        <Copy className="w-4 h-4 text-[var(--muted-foreground)]" />
      )}
    </button>
  );
}

/**
 * CodeBlock renders a styled code snippet with copy functionality.
 */
function CodeBlock({ code, label }: { code: string; label: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] overflow-hidden">
      {/* Label */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] bg-[var(--muted)]">
        <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
          <Terminal className="w-4 h-4" />
          {label}
        </div>
        <CopyButton text={code} />
      </div>

      {/* Code content */}
      <div className="p-4 overflow-x-auto">
        <pre className="text-sm font-mono">
          <code>{code}</code>
        </pre>
      </div>
    </div>
  );
}

/**
 * Installation section with multiple install methods.
 */
export default function Installation() {
  return (
    <section id="install" className="py-24 px-6">
      <div className="max-w-4xl mx-auto">
        {/* Section header */}
        <div className="text-center mb-12">
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            Get started in seconds
          </h2>
          <p className="text-lg text-[var(--muted-foreground)]">
            Install from the VS Code Marketplace or use the command line.
          </p>
        </div>

        {/* Installation methods */}
        <div className="space-y-8">
          {/* Method 1: Marketplace */}
          <div className="space-y-4">
            <h3 className="text-xl font-semibold flex items-center gap-2">
              <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-[var(--accent)] text-white text-sm font-bold">
                1
              </span>
              VS Code Marketplace
            </h3>
            <p className="text-[var(--muted-foreground)] ml-9">
              The easiest way. Click the button below or search{' '}
              <code>SQLite Explorer</code> in VS Code Extensions.
            </p>
            <div className="ml-9">
              <a
                href="https://marketplace.visualstudio.com/items?itemName=zknpr.sqlite-explorer"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[var(--accent)] text-white font-medium hover:opacity-90 transition-opacity"
              >
                Open in Marketplace
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>
          </div>

          {/* Method 2: CLI */}
          <div className="space-y-4">
            <h3 className="text-xl font-semibold flex items-center gap-2">
              <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-[var(--accent)] text-white text-sm font-bold">
                2
              </span>
              Command Line
            </h3>
            <p className="text-[var(--muted-foreground)] ml-9">
              Install directly from your terminal using the VS Code CLI.
            </p>
            <div className="ml-9">
              <CodeBlock
                code="code --install-extension zknpr.sqlite-explorer"
                label="Terminal"
              />
            </div>
          </div>

          {/* Quick start */}
          <div className="mt-12 p-6 rounded-xl border border-[var(--border)] bg-[var(--muted)]">
            <h3 className="text-lg font-semibold mb-4">Quick Start</h3>
            <ol className="space-y-3 text-[var(--muted-foreground)]">
              <li className="flex items-start gap-3">
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-[var(--background)] border border-[var(--border)] text-sm font-medium flex-shrink-0">
                  1
                </span>
                <span>
                  Open any <code>.sqlite</code>, <code>.db</code>, or <code>.sqlite3</code>{' '}
                  file in VS Code
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-[var(--background)] border border-[var(--border)] text-sm font-medium flex-shrink-0">
                  2
                </span>
                <span>Browse tables in the sidebar and click to view data</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-[var(--background)] border border-[var(--border)] text-sm font-medium flex-shrink-0">
                  3
                </span>
                <span>Double-click any cell to edit, press Enter to save</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-[var(--background)] border border-[var(--border)] text-sm font-medium flex-shrink-0">
                  4
                </span>
                <span>
                  Press <code>Ctrl+S</code> to save changes to disk
                </span>
              </li>
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}
