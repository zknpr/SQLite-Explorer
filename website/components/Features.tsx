/**
 * Features Component
 *
 * Displays the key features of SQLite Explorer in a varied grid layout.
 * First two features span wider as "featured" cards; the rest are standard.
 * Icon sizes and stroke widths vary to avoid the default Lucide look.
 */

import {
  Database,
  Download,
  Edit3,
  Eye,
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
}

const features: Feature[] = [
  {
    icon: <Database className="w-7 h-7" strokeWidth={1.5} />,
    title: 'Schema Browser',
    description:
      'Explore tables, views, and indexes in a collapsible sidebar tree. Jump to any table in two clicks.',
  },
  {
    icon: <Edit3 className="w-7 h-7" strokeWidth={1.5} />,
    title: 'Inline Editing',
    description:
      'Double-click any cell to edit. Insert rows, delete records, and modify data directly in the table view.',
  },
  {
    icon: <History className="w-5 h-5" strokeWidth={2.25} />,
    title: 'Undo / Redo',
    description:
      'Full edit history with Ctrl+Z and Ctrl+Y. Never worry about accidental changes again.',
  },
  {
    icon: <Zap className="w-5 h-5" strokeWidth={2.5} />,
    title: 'Virtualized Scrolling',
    description:
      'Handle tables with thousands of rows smoothly. Pagination keeps large datasets manageable.',
  },
  {
    icon: <Globe className="w-6 h-6" strokeWidth={1.75} />,
    title: 'Cross-Platform',
    description:
      'WebAssembly-powered for universal compatibility. Works in VS Code for Web, SSH, WSL, and containers.',
  },
  {
    icon: <Palette className="w-5 h-5" strokeWidth={2} />,
    title: 'Theme Integration',
    description:
      'Automatically matches your VS Code color theme. Looks native in any environment.',
  },
  {
    icon: <Keyboard className="w-6 h-6" strokeWidth={1.75} />,
    title: 'Keyboard Navigation',
    description:
      'Full keyboard support for power users. Navigate, edit, and manage data without touching your mouse.',
  },
  {
    icon: <FileCode className="w-5 h-5" strokeWidth={2.25} />,
    title: 'Multiple Formats',
    description:
      'Supports .sqlite, .db, .sqlite3, .db3, .sdb, .s3db, and GeoPackage (.gpkg) files.',
  },
  {
    icon: <Download className="w-6 h-6" strokeWidth={1.75} />,
    title: 'Export Data',
    description:
      'Export tables to CSV, JSON, or SQL. Stream large datasets directly to disk without memory limits.',
  },
  {
    icon: <Eye className="w-5 h-5" strokeWidth={2} />,
    title: 'Blob Inspector',
    description:
      'Preview images, audio, video, and PDFs stored as BLOBs. Hex view for raw binary inspection.',
  },
];

function FeatureCard({ feature, featured }: { feature: Feature; featured?: boolean }) {
  return (
    <div className={`group p-6 rounded-xl border border-(--ui-edge) bg-(--ui-bg) hover:border-(--ui-accent)/50 transition-colors ${featured ? 'sm:col-span-2 lg:col-span-2' : ''}`}>
      <div className={`inline-flex items-center justify-center rounded-lg text-(--ui-accent) mb-4 group-hover:bg-(--ui-accent)/10 transition-colors ${featured ? 'w-14 h-14 bg-(--ui-accent)/5' : 'w-12 h-12 bg-(--ui-subtle)'}`}>
        {feature.icon}
      </div>

      <h3 className={`font-semibold mb-2 ${featured ? 'text-xl' : 'text-lg'}`}>{feature.title}</h3>

      <p className="text-(--ui-subtle-fg) text-sm leading-relaxed">
        {feature.description}
      </p>
    </div>
  );
}

export default function Features() {
  return (
    <section className="py-24 px-6 bg-(--ui-subtle)">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            Browse, edit, and export — right from your editor
          </h2>
          <p className="text-lg text-(--ui-subtle-fg) max-w-2xl mx-auto">
            A complete database management experience built directly into your editor.
            No external tools required.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {features.map((feature, i) => (
            <FeatureCard key={feature.title} feature={feature} featured={i < 2} />
          ))}
        </div>
      </div>
    </section>
  );
}
