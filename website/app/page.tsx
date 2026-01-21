/**
 * Landing Page
 *
 * The main entry point for the SQLite Explorer website.
 * Composes all sections: Hero, Features, Demos, Installation, and Footer.
 *
 * This is a static page (no dynamic data) for optimal performance.
 */

import { Hero, Features, Demos, Installation, Footer } from '@/components';

/**
 * Home page component.
 * Renders all landing page sections in order.
 */
export default function Home() {
  return (
    <main className="min-h-screen">
      {/* Above the fold: Hero with headline, CTAs, and screenshot */}
      <Hero />

      {/* Feature grid showcasing extension capabilities */}
      <Features />

      {/* Video demos showing features in action */}
      <Demos />

      {/* Installation instructions with copy-paste commands */}
      <Installation />

      {/* Footer with links and credits */}
      <Footer />
    </main>
  );
}
