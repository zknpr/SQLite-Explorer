/**
 * Root Layout Component
 *
 * Provides the HTML structure, metadata, fonts, and analytics wrapper
 * for the entire application. All pages inherit from this layout.
 */

import type { Metadata, Viewport } from 'next';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/next';
import './globals.css';

/**
 * Inline script to detect system color scheme preference.
 * Runs before React hydration to prevent flash of wrong theme.
 * Adds 'dark' class to <html> if user prefers dark mode.
 */
const themeScript = `
  (function() {
    try {
      if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        document.documentElement.classList.add('dark');
      }
      // Listen for changes in system preference
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
        if (e.matches) {
          document.documentElement.classList.add('dark');
        } else {
          document.documentElement.classList.remove('dark');
        }
      });
    } catch (e) {}
  })();
`;

/**
 * Site metadata for SEO and social sharing.
 * Open Graph tags ensure proper previews on Twitter, LinkedIn, etc.
 */
export const metadata: Metadata = {
  title: "SQLite Explorer - VS Code Extension",
  description:
    "A powerful, open-source SQLite database viewer and editor for Visual Studio Code. View, edit, and manage SQLite databases directly in your editor.",
  keywords: [
    "SQLite",
    "VS Code",
    "extension",
    "database",
    "viewer",
    "editor",
    "SQL",
    "WebAssembly",
  ],
  authors: [{ name: "zknpr" }],
  creator: "zknpr",
  publisher: "zknpr",
  metadataBase: new URL("https://vscode-sqlite-explorer.vercel.app/"),
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://vscode-sqlite-explorer.vercel.app/",
    siteName: "SQLite Explorer",
    title: "SQLite Explorer - VS Code Extension",
    description:
      "A powerful, open-source SQLite database viewer and editor for Visual Studio Code.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "SQLite Explorer - VS Code Extension",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "SQLite Explorer - VS Code Extension",
    description:
      "A powerful, open-source SQLite database viewer and editor for Visual Studio Code.",
    images: ["/og-image.png"],
  },
  robots: {
    index: true,
    follow: true,
  },
};

/**
 * Viewport configuration for responsive design and theme color.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
  width: 'device-width',
  initialScale: 1,
};

/**
 * RootLayout wraps all pages with common HTML structure.
 * Includes Vercel Analytics for traffic monitoring and Speed Insights for Core Web Vitals.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Inline script for theme detection - runs before paint to prevent flash */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        {children}
        {/* Vercel Analytics - automatically tracks page views and web vitals */}
        <Analytics />
        {/* Vercel Speed Insights - Core Web Vitals monitoring */}
        <SpeedInsights />
      </body>
    </html>
  );
}
