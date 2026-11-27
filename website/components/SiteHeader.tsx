import Image from 'next/image';
import HomeLink from './HomeLink';
import MainNav from './MainNav';

/**
 * The site's top bar. Its content column is the one every page uses (side
 * padding outside a max-w-6xl box), so the logo lines up with the page.
 * Children sit between the logo and the links; the demo puts its database
 * controls there.
 */
export default function SiteHeader({ children }: { children?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-40 border-b border-edge bg-background/80 px-5 backdrop-blur-md sm:px-6">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-2 sm:gap-4">
        <HomeLink className="flex shrink-0 items-center gap-2 rounded-md font-semibold tracking-tight sm:gap-2.5">
          <Image src="/icon.png" alt="" width={28} height={28} className="h-7 w-7" />
          <span>SQLite Explorer</span>
        </HomeLink>
        {children}
        <MainNav />
      </div>
    </header>
  );
}
