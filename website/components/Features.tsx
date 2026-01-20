/**
 * Features Component
 *
 * Displays the key features of SQLite Explorer in a grid layout.
 * Each feature has an icon, title, and description.
 *
 * Design: Clean grid with subtle hover effects, consistent with minimal aesthetic.
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

/**
 * Feature data structure for type safety.
 */
interface Feature {
  icon: React.ReactNode;
  title: string;
  description: string;
}

/**
 * List of features extracted from the extension's README.
 * Each feature highlights a unique capability.
 */
const features: Feature[] = [
  {
    icon: <Database className="w-6 h-6" />,
    title: 'Schema Browser',
    description:
      'Explore tables, views, and indexes in a clean sidebar. Navigate your database structure effortlessly.',
  },
  {
    icon: <Edit3 className="w-6 h-6" />,
    title: 'Inline Editing',
    description:
      'Double-click any cell to edit. Insert rows, delete records, and modify data directly in the table view.',
  },
  {
    icon: <History className="w-6 h-6" />,
    title: 'Undo / Redo',
    description:
      'Full edit history with Ctrl+Z and Ctrl+Y. Never worry about accidental changes again.',
  },
  {
    icon: <Zap className="w-6 h-6" />,
    title: 'Virtualized Scrolling',
    description:
      'Handle tables with thousands of rows smoothly. Pagination keeps large datasets manageable.',
  },
  {
    icon: <Globe className="w-6 h-6" />,
    title: 'Cross-Platform',
    description:
      'WebAssembly-powered for universal compatibility. Works in VS Code for Web, SSH, WSL, and containers.',
  },
  {
    icon: <Palette className="w-6 h-6" />,
    title: 'Theme Integration',
    description:
      'Automatically matches your VS Code color theme. Looks native in any environment.',
  },
  {
    icon: <Keyboard className="w-6 h-6" />,
    title: 'Keyboard Navigation',
    description:
      'Full keyboard support for power users. Navigate, edit, and manage data without touching your mouse.',
  },
  {
    icon: <FileCode className="w-6 h-6" />,
    title: 'Multiple Formats',
    description:
      'Supports .sqlite, .db, .sqlite3, .db3, .sdb, .s3db, and GeoPackage (.gpkg) files.',
  },
];

/**
 * FeatureCard renders a single feature with icon, title, and description.
 */
function FeatureCard({ feature }: { feature: Feature }) {
  return (
    <div className="group p-6 rounded-xl border border-[var(--border)] bg-[var(--background)] hover:border-[var(--accent)]/50 transition-colors">
      {/* Icon container */}
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-lg bg-[var(--muted)] text-[var(--accent)] mb-4 group-hover:bg-[var(--accent)]/10 transition-colors">
        {feature.icon}
      </div>

      {/* Title */}
      <h3 className="text-lg font-semibold mb-2">{feature.title}</h3>

      {/* Description */}
      <p className="text-[var(--muted-foreground)] text-sm leading-relaxed">
        {feature.description}
      </p>
    </div>
  );
}

/**
 * Features section displaying all capabilities in a responsive grid.
 */
export default function Features() {
  return (
    <section className="py-24 px-6 bg-[var(--muted)]">
      <div className="max-w-6xl mx-auto">
        {/* Section header */}
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            Everything you need to work with SQLite
          </h2>
          <p className="text-lg text-[var(--muted-foreground)] max-w-2xl mx-auto">
            A complete database management experience built directly into your editor.
            No external tools required.
          </p>
        </div>

        {/* Feature grid - responsive 1/2/3/4 column layout */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {features.map((feature) => (
            <FeatureCard key={feature.title} feature={feature} />
          ))}
        </div>
      </div>
    </section>
  );
}
