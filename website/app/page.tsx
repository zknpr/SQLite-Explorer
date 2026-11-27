/**
 * Landing page.
 *
 * Static, regenerated at most once an hour so the desktop download buttons
 * follow the app's latest release and the install count stays current,
 * without a redeploy.
 */

import { fetchDesktopRelease } from '@/lib/desktop-release';
import { fetchExtensionStats } from '@/lib/extension-stats';
import Capabilities from '@/components/Capabilities';
import DesktopApp from '@/components/DesktopApp';
import Footer from '@/components/Footer';
import Hero from '@/components/Hero';
import SiteHeader from '@/components/SiteHeader';
import TryYourFile from '@/components/TryYourFile';
import VsCode from '@/components/VsCode';

export const revalidate = 3600;

export default async function Home() {
  const [release, stats] = await Promise.all([fetchDesktopRelease(), fetchExtensionStats()]);
  return (
    <>
      <SiteHeader />
      <main>
        <Hero release={release} stats={stats} />
        <DesktopApp release={release} />
        <VsCode />
        <Capabilities />
        <TryYourFile />
      </main>
      <Footer />
    </>
  );
}
