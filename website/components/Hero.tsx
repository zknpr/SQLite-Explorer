/**
 * Hero Component
 *
 * The main above-the-fold section featuring:
 * - Headline and value proposition
 * - Call-to-action buttons (Install + GitHub)
 * - Main screenshot of the extension UI
 *
 * Design: Minimal, centered layout with subtle animations.
 */

import Image from 'next/image';
import { Database, ExternalLink, Play } from 'lucide-react';

/**
 * MainScreenshot displays the actual extension screenshot.
 * Uses Next.js Image component for optimization.
 */
function MainScreenshot() {
  return (
    <div className="relative w-full max-w-5xl mx-auto mt-12 animate-fade-in">
      {/* Screenshot with shadow and border */}
      <div className="rounded-xl border border-[var(--border)] overflow-hidden shadow-2xl">
        <Image
          src="/main.png"
          alt="SQLite Explorer - Database viewer and editor for VS Code"
          width={1920}
          height={1080}
          className="w-full h-auto"
          priority
        />
      </div>

      {/* Decorative gradient blur behind screenshot */}
      <div className="absolute -z-10 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] bg-[var(--accent)]/20 blur-[100px] rounded-full" />
    </div>
  );
}

/**
 * Hero section with headline, description, CTAs, and screenshot.
 */
export default function Hero() {
  return (
    <section className="relative pt-24 pb-16 px-6 overflow-hidden">
      <div className="max-w-6xl mx-auto text-center">
        {/* Badge */}
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[var(--border)] bg-[var(--muted)] text-sm text-[var(--muted-foreground)] mb-6 animate-fade-in">
          <Database className="w-4 h-4" />
          <span>Open Source VS Code Extension</span>
        </div>

        {/* Headline */}
        <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight mb-6 animate-slide-up">
          View and Edit SQLite
          <br />
          <span className="text-[var(--accent)]">Directly in VS Code</span>
        </h1>

        {/* Description */}
        <p className="text-lg sm:text-xl text-[var(--muted-foreground)] max-w-2xl mx-auto mb-8 animate-slide-up">
          A powerful, WebAssembly-powered database viewer and editor. No external
          dependencies. Works everywhere — including VS Code for Web.
        </p>

        {/* CTAs */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 animate-slide-up">
          {/* Primary CTA - Install */}
          <a
            href="https://marketplace.visualstudio.com/items?itemName=zknpr.sqlite-explorer"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-[var(--accent)] text-white font-medium hover:opacity-90 transition-opacity"
          >
            Install Extension
            <ExternalLink className="w-4 h-4" />
          </a>

          {/* Try Demo CTA */}
          <a
            href="/demo"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-lg border border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10 font-medium hover:bg-[var(--accent)]/20 transition-colors"
          >
            <Play className="w-4 h-4" />
            Try in Browser
          </a>

          {/* Secondary CTA - GitHub */}
          <a
            href="https://github.com/zknpr/sqlite-explorer"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-lg border border-[var(--border)] bg-[var(--background)] font-medium hover:bg-[var(--muted)] transition-colors"
          >
            <svg
              className="w-5 h-5"
              fill="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                clipRule="evenodd"
              />
            </svg>
            View on GitHub
          </a>
        </div>

        {/* Main screenshot */}
        <MainScreenshot />
      </div>
    </section>
  );
}
