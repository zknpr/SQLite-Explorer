import Image from 'next/image';
import HomeLink from './HomeLink';
import MainNav from './MainNav';

/**
 * The site's top bar. Its content column is the one every page uses (side
 * padding outside a max-w-6xl box), so the logo lines up with the page.
 * Children sit between the logo and the links; the demo puts its database
 * controls there. Below md a child can take a row of its own (order-last
 * basis-full): logo, controls and links do not fit in one row there. Below
 * 375 px the logo is the icon alone, so the links fit beside it.
 */
export default function SiteHeader({ children }: { children?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-40 border-b border-edge bg-background/80 px-5 backdrop-blur-md sm:px-6">
      <div className="mx-auto flex min-h-16 max-w-6xl flex-wrap items-center gap-x-2 sm:gap-x-4 md:h-16 md:flex-nowrap">
        <HomeLink className="flex h-16 shrink-0 items-center gap-2 rounded-md font-semibold tracking-tight sm:gap-2.5 md:h-auto">
          <Image src="/icon.png" alt="" width={28} height={28} className="h-7 w-7" />
          <span className="max-[374px]:sr-only">SQLite Explorer</span>
        </HomeLink>
        {children}
        <MainNav />
      </div>
    </header>
  );
}
