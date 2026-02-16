/**
 * Features — Editorial card grid
 *
 * Left-accent bar cards with varied sizing. Dot-grid background.
 * Section heading uses serif display font with a small mono label above.
 */

import {
  Database,
  Edit3,
  Globe,
  Keyboard,
  Palette,
  Zap,
  History,
  FileCode,
} from 'lucide-react';

interface Feature {
  icon: React.ReactNode;
  title: string;
  description: string;
  accentColor: string;
}

const features: Feature[] = [
  {
    icon: <Database className="w-6 h-6" strokeWidth={1.5} />,
    title: 'Schema Browser',
    description:
      'Explore tables, views, and indexes in a collapsible sidebar tree. Jump to any table in two clicks.',
    accentColor: 'var(--ui-accent)',
  },
  {
    icon: <Edit3 className="w-6 h-6" strokeWidth={1.5} />,
    title: 'Inline Editing',
    description:
      'Double-click any cell to edit. Insert rows, delete records, and modify data directly in the table view.',
    accentColor: '#d97706',
  },
  {
    icon: <History className="w-5 h-5" strokeWidth={2} />,
    title: 'Undo / Redo',
    description:
      'Full edit history with Ctrl+Z and Ctrl+Y. Never worry about accidental changes again.',
    accentColor: '#6366f1',
  },
  {
    icon: <Zap className="w-5 h-5" strokeWidth={2.25} />,
    title: 'Virtualized Scrolling',
    description:
      'Handle tables with thousands of rows smoothly. Pagination keeps large datasets manageable.',
    accentColor: '#ec4899',
  },
  {
    icon: <Globe className="w-5 h-5" strokeWidth={1.75} />,
    title: 'Cross-Platform',
    description:
      'WebAssembly-powered for universal compatibility. Works in VS Code for Web, SSH, WSL, and containers.',
    accentColor: 'var(--ui-accent)',
  },
  {
    icon: <Palette className="w-5 h-5" strokeWidth={2} />,
    title: 'Theme Integration',
    description:
      'Automatically matches your VS Code color theme. Looks native in any environment.',
    accentColor: '#8b5cf6',
  },
  {
    icon: <Keyboard className="w-5 h-5" strokeWidth={1.75} />,
    title: 'Keyboard Navigation',
    description:
      'Full keyboard support for power users. Navigate, edit, and manage data without touching your mouse.',
    accentColor: '#f59e0b',
  },
  {
    icon: <FileCode className="w-5 h-5" strokeWidth={2} />,
    title: 'Multiple Formats',
    description:
      'Supports .sqlite, .db, .sqlite3, .db3, .sdb, .s3db, and GeoPackage (.gpkg) files.',
    accentColor: '#10b981',
  },
];

function FeatureCard({ feature, featured }: { feature: Feature; featured?: boolean }) {
  return (
    <div
      className={`
        group relative p-6 rounded-2xl bg-[var(--ui-bg)]
        border border-[var(--ui-edge)]/60
        hover:shadow-lg hover:shadow-black/[0.04] dark:hover:shadow-black/20
        hover:-translate-y-0.5 transition-all duration-300
        ${featured ? 'sm:col-span-2 lg:col-span-2' : ''}
      `}
    >
      {/* Left accent bar */}
      <div
        className="absolute left-0 top-6 bottom-6 w-[3px] rounded-full opacity-40 group-hover:opacity-100 transition-opacity"
        style={{ backgroundColor: feature.accentColor }}
      />

      <div className="pl-4">
        {/* Icon */}
        <div
          className={`inline-flex items-center justify-center rounded-xl mb-4 transition-colors ${featured ? 'w-12 h-12' : 'w-10 h-10'}`}
          style={{ backgroundColor: `color-mix(in srgb, ${feature.accentColor} 12%, transparent)`, color: feature.accentColor }}
        >
          {feature.icon}
        </div>

        <h3 className={`mb-2 ${featured ? 'text-2xl' : 'text-xl'}`}>{feature.title}</h3>

        <p className="text-[var(--ui-subtle-fg)] text-sm leading-relaxed font-sans">
          {feature.description}
        </p>
      </div>
    </div>
  );
}

export default function Features() {
  return (
    <section className="relative py-28 px-6 dot-grid">
      <div className="max-w-6xl mx-auto">
        {/* Section heading — mono label + serif title */}
        <div className="mb-20">
          <span className="font-mono text-xs tracking-widest uppercase text-[var(--ui-accent)] block mb-3">
            Features
          </span>
          <h2 className="text-4xl sm:text-5xl tracking-tight max-w-lg leading-[1.15]">
            Browse, edit, and export — right from your editor
          </h2>
          <p className="text-lg text-[var(--ui-subtle-fg)] max-w-xl mt-5 leading-relaxed font-sans">
            A complete database management experience built into VS Code.
            No external tools required.
          </p>
        </div>

        {/* Feature grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {features.map((feature, i) => (
            <FeatureCard key={feature.title} feature={feature} featured={i < 2} />
          ))}
        </div>
      </div>
    </section>
  );
}
