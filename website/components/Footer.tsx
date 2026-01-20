/**
 * Footer Component
 *
 * Simple footer with:
 * - Project name and description
 * - Links to GitHub, Marketplace, License
 * - Credits section
 *
 * Design: Minimal, dark background, clean typography.
 */

import { Database } from 'lucide-react';

/**
 * Footer navigation links.
 */
const links = [
  {
    label: 'GitHub',
    href: 'https://github.com/zknpr/sqlite-explorer',
  },
  {
    label: 'VS Code Marketplace',
    href: 'https://marketplace.visualstudio.com/items?itemName=zknpr.sqlite-explorer',
  },
  {
    label: 'MIT License',
    href: 'https://github.com/zknpr/sqlite-explorer/blob/main/LICENSE.md',
  },
];

/**
 * Footer section at the bottom of the page.
 */
export default function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="border-t border-[var(--border)] bg-[var(--background)]">
      <div className="max-w-6xl mx-auto px-6 py-12">
        <div className="flex flex-col md:flex-row items-center justify-between gap-8">
          {/* Branding */}
          <div className="flex flex-col items-center md:items-start gap-2">
            <div className="flex items-center gap-2">
              <Database className="w-5 h-5 text-[var(--accent)]" />
              <span className="font-semibold">SQLite Explorer</span>
            </div>
            <p className="text-sm text-[var(--muted-foreground)] text-center md:text-left">
              A powerful SQLite viewer and editor for VS Code.
            </p>
          </div>

          {/* Links */}
          <nav className="flex flex-wrap items-center justify-center gap-6">
            {links.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              >
                {link.label}
              </a>
            ))}
          </nav>
        </div>

        {/* Bottom bar */}
        <div className="mt-8 pt-8 border-t border-[var(--border)] flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-[var(--muted-foreground)]">
          <p>&copy; {currentYear} zknpr. All rights reserved.</p>
          <p>
            Built with{" "}
            <a
              href="https://claude.com/product/claude-code"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--accent)] hover:underline"
            >
              Claude Code
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
