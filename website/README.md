# SQLite Explorer Website

The site for SQLite Explorer: the VS Code extension, the desktop app and the
browser demo.

## Pages

- `/` opens with a live viewer: the real viewer iframe and sql.js worker,
  running `public/samples/chinook.db` in the tab (`components/LivePreview.tsx`).
  It starts after the page has loaded and the browser is idle; on screens
  narrower than 768 px, or with Save-Data, it waits for a click. It opens the
  Track table by clicking the viewer's own "Open table Track" button, so a
  change to that accessible name in `core/ui/modules/sidebar.js` leaves the
  preview on the table list (`tests/landing.test.mjs` fails).
- `/demo` opens a file from the visitor's disk, or a sample, with the SQL editor.
  It and the preview share `app/demo/useViewerSession.ts`: one worker, one
  viewer iframe, and the transport guards between them.
- `/download` lists the desktop app's packages with sizes and SHA-256, the
  first-launch steps for each system, and how to check a download.

## Desktop app downloads

`lib/desktop-release.ts` reads the app's
`releases/latest/download/release-manifest.json` at build time and again at
most once an hour (`revalidate = 3600` on `/` and `/download`), so a new app
release shows up without a redeploy. Download URLs are built from the checked
tag and file names, never taken from the manifest. If the manifest cannot be
read or does not match the expected shape, the build logs
`[desktop-release]` and the pages link to the GitHub releases page instead.

`components/DownloadButton.tsx` picks the package for the visitor's system
after hydration (`lib/platform.ts`). Chromium reports the CPU architecture, so
an Intel Mac or an ARM Linux machine gets the generic link; Safari and Firefox
do not, so every Mac is offered the Apple Silicon build.

## Development

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Build for production
npm run build

# Preview production build
npm run start
```

## Demo runtime assets

The demo's **SQL Query** button opens a browser editor on the current database,
including read-only files. Run one SELECT or WITH query with optional positional
parameters (a JSON array). Cmd/Ctrl+Enter runs the query; Escape closes the editor.
Drafts and results survive closing it, but reset when the database is reloaded or
replaced. Database writes remain in the table viewer.

Queries use the extension's read-only SQL helpers: a 30-second SQLite deadline,
1,000 displayed rows, 128 columns, and a 4 MiB raw result budget. Large cells are
marked as previews; long display values are also shortened. Exact large integers
are preserved. Results render 50 rows per page. No database content leaves the
browser.

The website build hashes the generated worker, viewer, sql.js glue, and WASM
binary together. All four are served under one content-versioned URL prefix.
Only the current prefix is rewritten to the public assets, and only those URLs
receive immutable caching. Unversioned files retain revalidation so a returning
browser cannot mix cached JavaScript with a newly deployed WASM binary.

Regenerate shared demo assets from the repository root with
`node scripts/build.mjs` before building the website. Do not edit generated
files. Restart the website development server after regenerating them.

Run the warm-cache browser regression after a production build:

```bash
# From website/, with root and website dependencies installed
npm run build
npm run test:demo-cache
npm run test:demo-sql
npm run test:landing
npm run test:desktop-release   # no build needed
```

The test starts an isolated local server and headless Chromium, warms the old
unversioned runtime URLs, then opens both sample databases through the real demo.
It checks the versioned asset responses and rejects unknown revision URLs. Install
the Chromium version required by the root `playwright-core` dependency, or set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an existing Chrome executable. No user
browser profile or production deployment is used.

The SQL regression exercises the actual sidebar button, reads on both samples,
parameters, errors and recovery, exact values, row limits, pagination, keyboard
controls, reload isolation, and the mobile dialog layout.

## Deployment

This website is configured for Vercel deployment.

### Option 1: Vercel CLI

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy from website directory
cd website
vercel
```

### Option 2: GitHub Integration

1. Push to GitHub
2. Import project in Vercel dashboard
3. Set **Root Directory** to `website`
4. Deploy

## Structure

```
website/
├── app/
│   ├── page.tsx              # Landing page
│   ├── download/page.tsx     # Desktop app downloads
│   ├── demo/                 # Browser demo and the shared viewer session
│   ├── opengraph-image.tsx   # Social preview image, rendered at build time
│   ├── layout.tsx            # Fonts, metadata, theme detection
│   └── globals.css           # Colour and type tokens
├── components/               # Page sections, header, footer, download button
├── lib/                      # Release manifest, platform guess, links
├── public/samples/           # Chinook and Northwind sample databases
└── tests/                    # Browser and unit tests
```

## License

MIT
