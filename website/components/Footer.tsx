import Image from 'next/image';
import Link from 'next/link';
import { APP_REPO_URL } from '@/lib/desktop-release';
import {
  CHANGELOG_URL,
  EXTENSION_REPO_URL,
  ISSUES_URL,
  LICENSE_URL,
  MARKETPLACE_URL,
  BUY_ME_A_COFFEE_URL,
  GITHUB_SPONSORS_URL,
  KOFI_URL,
  OPEN_VSX_URL
} from '@/lib/links';

const groups = [
  {
    heading: 'Get it',
    links: [
      { label: 'Visual Studio Marketplace', href: MARKETPLACE_URL },
      { label: 'Open VSX', href: OPEN_VSX_URL },
      { label: 'Desktop app', href: '/download' },
      { label: 'Browser demo', href: '/demo' }
    ]
  },
  {
    heading: 'Source',
    links: [
      { label: 'Extension on GitHub', href: EXTENSION_REPO_URL },
      { label: 'Desktop app on GitHub', href: APP_REPO_URL },
      { label: 'Changelog', href: CHANGELOG_URL },
      { label: 'Report a bug', href: ISSUES_URL }
    ]
  },
  {
    heading: 'Project',
    links: [
      { label: 'MIT License', href: LICENSE_URL },
      { label: 'GitHub Sponsors', href: GITHUB_SPONSORS_URL },
      { label: 'Ko-fi', href: KOFI_URL },
      { label: 'Buy Me a Coffee', href: BUY_ME_A_COFFEE_URL }
    ]
  }
];

export default function Footer() {
  return (
    <footer className="border-t border-edge bg-subtle px-5 sm:px-6">
      <div className="mx-auto grid max-w-6xl gap-10 py-14 md:grid-cols-12">
        <div className="md:col-span-5">
          <Link href="/" className="inline-flex items-center gap-2.5 font-semibold">
            <Image src="/icon.png" alt="" width={28} height={28} className="h-7 w-7" />
            SQLite Explorer
          </Link>
          <p className="mt-3 max-w-xs text-sm text-subtle-foreground">
            An open source SQLite viewer and editor for VS&nbsp;Code, the desktop and the browser.
          </p>
          <p className="mt-6 text-xs text-subtle-foreground">&copy; {new Date().getFullYear()} zknpr</p>
        </div>
        {groups.map(group => (
          <nav key={group.heading} aria-label={group.heading} className="md:col-span-2">
            <h2 className="text-sm font-semibold">{group.heading}</h2>
            <ul className="mt-4 space-y-2.5 text-sm">
              {group.links.map(link => (
                <li key={link.label}>
                  {link.href.startsWith('/') ? (
                    <Link href={link.href} className="text-subtle-foreground transition-colors hover:text-accent">
                      {link.label}
                    </Link>
                  ) : (
                    <a href={link.href} className="text-subtle-foreground transition-colors hover:text-accent">
                      {link.label}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
    </footer>
  );
}
