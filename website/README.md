# SQLite Explorer Website

Marketing website for the SQLite Explorer VS Code extension.

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
```

The test starts an isolated local server and headless Chromium, warms the old
unversioned runtime URLs, then opens both sample databases through the real demo.
It checks the versioned asset responses and rejects unknown revision URLs. Install
the Chromium version required by the root `playwright-core` dependency, or set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an existing Chrome executable. No user
browser profile or production deployment is used.

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
3. Set **Root Directory** to `prod/website`
4. Deploy

## Structure

```
website/
├── app/
│   ├── globals.css      # Global styles and CSS variables
│   ├── layout.tsx       # Root layout with metadata
│   └── page.tsx         # Landing page
├── components/
│   ├── Hero.tsx         # Hero section with mockup
│   ├── Features.tsx     # Feature grid
│   ├── Installation.tsx # Install instructions
│   └── Footer.tsx       # Footer links
├── public/
│   ├── icon.png         # Extension icon
│   └── og-image.svg     # Social sharing preview
├── next.config.js       # Next.js configuration
├── tailwind.config.js   # Tailwind design tokens
├── vercel.json          # Vercel deployment config
└── package.json         # Dependencies
```

## Updating Screenshots

Replace the placeholder mockup in `components/Hero.tsx` with actual screenshots:

1. Take screenshots of the extension in action
2. Save to `public/` directory
3. Update `Hero.tsx` to use `<Image>` component instead of `PlaceholderMockup`

## License

MIT
