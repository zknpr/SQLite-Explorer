/**
 * Footer Component
 *
 * Minimal footer with project links and copyright.
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
    <footer className="border-t border-(--ui-edge) bg-(--ui-subtle)">
      <div className="max-w-6xl mx-auto px-6 py-12">
        <div className="flex flex-col md:flex-row items-start justify-between gap-8">
          <div className="flex flex-col gap-1">
            <span className="text-lg font-semibold">SQLite Explorer</span>
            <p className="text-sm text-(--ui-subtle-fg) max-w-xs">
              A powerful SQLite viewer and editor for VS Code. Open source, zero dependencies.
            </p>
          </div>

          <nav className="flex flex-wrap gap-x-6 gap-y-2">
            {links.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-(--ui-subtle-fg) hover:text-(--ui-accent) transition-colors"
              >
                {link.label}
              </a>
            ))}
          </nav>
        </div>

        <div className="mt-8 pt-6 border-t border-(--ui-edge) flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-(--ui-subtle-fg)">
          <p>&copy; {currentYear} zknpr</p>
          <p>
            Built with{" "}
            <a
              href="https://claude.com/product/claude-code"
              target="_blank"
              rel="noopener noreferrer"
              className="text-(--ui-accent) hover:underline"
            >
              Claude Code
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
