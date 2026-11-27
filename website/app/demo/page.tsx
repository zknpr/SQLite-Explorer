/**
 * Web Demo Page
 *
 * Standalone SQLite database viewer that runs entirely in the browser.
 * Users can upload their own .db files or load sample databases.
 *
 * Architecture:
 * - Uses sql.js (SQLite compiled to WebAssembly) running in a Web Worker
 * - Communicates with worker via postMessage/onmessage
 * - Renders the database using an iframe containing the viewer UI
 *
 * Performance:
 * - This page is statically generated (no server-side rendering needed)
 * - Served from Vercel's edge CDN for fast global delivery
 * - All database operations happen client-side in WebAssembly
 */

import type { Metadata } from 'next';
import DemoClient from './DemoClient';

// Force static generation - this page has no server-side data requirements
// and can be pre-rendered at build time for optimal performance.
// This eliminates serverless function cold starts, improving TTFB globally.
export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: 'Demo',
  description: 'Open a SQLite database in your browser. SQLite runs in the page as WebAssembly, so the file is never uploaded.'
};

export default function DemoPage() {
  return <DemoClient />;
}
