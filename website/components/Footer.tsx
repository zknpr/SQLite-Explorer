/**
 * Footer — Refined, minimal
 *
 * Warm background with subtle top border. Serif branding name,
 * mono-styled links. Distinctive from the template pattern.
 */

const links = [
  { label: 'GitHub', href: 'https://github.com/zknpr/sqlite-explorer' },
  { label: 'Marketplace', href: 'https://marketplace.visualstudio.com/items?itemName=zknpr.sqlite-explorer' },
  { label: 'MIT License', href: 'https://github.com/zknpr/sqlite-explorer/blob/main/LICENSE.md' },
  { label: 'Buy Me a Coffee', href: 'https://buymeacoffee.com/zknpr' },
];

export default function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="border-t border-[var(--ui-edge)] bg-[var(--ui-subtle)]">
      <div className="max-w-6xl mx-auto px-6 py-16">
        <div className="flex flex-col md:flex-row items-start justify-between gap-12">
          {/* Branding — serif name, sans description */}
          <div className="flex flex-col gap-2">
            <span className="text-2xl font-display">SQLite Explorer</span>
            <p className="text-sm text-[var(--ui-subtle-fg)] font-sans max-w-xs">
              A powerful SQLite viewer and editor for VS Code. Open source, zero dependencies.
            </p>
          </div>

          {/* Links — mono style */}
          <nav className="flex flex-wrap gap-x-8 gap-y-3">
            {links.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-[var(--ui-subtle-fg)] hover:text-[var(--ui-accent)] transition-colors font-mono"
              >
                {link.label}
              </a>
            ))}
          </nav>
        </div>

        <div className="mt-12 pt-8 border-t border-[var(--ui-edge)]/50 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-[var(--ui-subtle-fg)] font-mono">
          <p>&copy; {currentYear} zknpr</p>
          <p>
            Built with{" "}
            <a
              href="https://claude.com/product/claude-code"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--ui-accent)] hover:underline"
            >
              Claude Code
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
