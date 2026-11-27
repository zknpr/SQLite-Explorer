'use client';

/**
 * The header's logo link. On the home page it scrolls back to the top:
 * next/link does nothing for a link to the URL the page already has.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function HomeLink({ className, children }: { className?: string; children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <Link
      href="/"
      className={className}
      onClick={event => {
        if (pathname !== '/' || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        // Smooth or instant per the page's scroll-behavior, which follows reduced motion.
        window.scrollTo({ top: 0 });
      }}
    >
      {children}
    </Link>
  );
}
