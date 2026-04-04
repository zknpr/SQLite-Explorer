/**
 * Root Layout Component
 *
 * Provides the HTML structure, metadata, fonts, and analytics wrapper
 * for the entire application. All pages inherit from this layout.
 */

import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/next';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

/**
 * Theme detection — runs before paint to prevent flash.
 * Hardcoded string literal, no user input.
 */
const themeScript = `
  (function() {
    try {
      if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        document.documentElement.classList.add('dark');
      }
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
  metadataBase: new URL("https://sqlite-explorer.zknpr.xyz/"),
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
    other: [
      { rel: 'android-chrome-192x192', url: '/android-chrome-192x192.png' },
      { rel: 'android-chrome-512x512', url: '/android-chrome-512x512.png' },
    ],
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://sqlite-explorer.zknpr.xyz/",
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

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        {/* Hardcoded theme detection script — safe, no user input involved */}
        <script>{themeScript}</script>
      </head>
      <body>
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
