'use client';

/**
 * The header's links. The current page's link says so to assistive technology
 * and takes the text colour; only the colour changes, so the links never move
 * between pages. On the home page the VS Code link is a plain fragment link:
 * next/link does nothing when the URL already ends in that fragment, so after
 * scrolling away a second click would not scroll back.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import GitHubMark from './GitHubMark';
import { EXTENSION_REPO_URL } from '@/lib/links';

const pages = [
  { href: '/demo', label: 'Demo' },
  { href: '/download', label: 'Desktop app' }
];

const item = 'rounded-md px-1.5 py-2 transition-colors hover:text-foreground sm:px-3';

export default function MainNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="ml-auto">
      <ul className="flex items-center gap-0.5 whitespace-nowrap text-sm sm:gap-1">
        {pages.map(page => {
          const current = pathname === page.href;
          return (
            <li key={page.href}>
              <Link
                href={page.href}
                aria-current={current ? 'page' : undefined}
                className={`${item} ${current ? 'text-foreground' : 'text-subtle-foreground'}`}
              >
                {page.label}
              </Link>
            </li>
          );
        })}
        <li className="hidden sm:block">
          {pathname === '/' ? (
            <a href="#vscode" className={`${item} text-subtle-foreground`}>
              VS Code
            </a>
          ) : (
            <Link href="/#vscode" className={`${item} text-subtle-foreground`}>
              VS Code
            </Link>
          )}
        </li>
        <li>
          <a
            href={EXTENSION_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-1 hidden h-9 items-center gap-2 rounded-lg border border-edge px-3 text-subtle-foreground transition-colors hover:text-foreground sm:flex"
          >
            <GitHubMark className="h-4 w-4" />
            GitHub
          </a>
          <a
            href={EXTENSION_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="-mr-2 flex rounded-md p-2 text-subtle-foreground hover:text-foreground sm:hidden"
          >
            <GitHubMark className="h-[18px] w-[18px]" />
            <span className="sr-only">Source code on GitHub</span>
          </a>
        </li>
      </ul>
    </nav>
  );
}
