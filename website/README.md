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
