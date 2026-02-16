/**
 * Demos — Video showcase with editorial heading
 *
 * Autoplay-on-hover video cards. Left-aligned section heading
 * with mono label pattern. Varied spacing from other sections.
 */

'use client';

import { useRef, useState } from 'react';

interface Demo {
  id: string;
  title: string;
  description: string;
  mp4: string;
  gif: string;
}

const demos: Demo[] = [
  {
    id: 'edit-cells',
    title: 'Inline Editing',
    description: 'Double-click any cell to edit. Add new rows and delete existing ones with ease.',
    mp4: '/edit_cells_add_delete_rows.mp4',
    gif: '/edit_cells_add_delete_rows.gif',
  },
  {
    id: 'pin-columns',
    title: 'Pin Columns',
    description: 'Keep important columns visible while scrolling horizontally through wide tables.',
    mp4: '/pin_colums.mp4',
    gif: '/pin_colums.gif',
  },
  {
    id: 'pin-rows',
    title: 'Pin Rows',
    description: 'Pin rows to the top for easy reference while navigating through data.',
    mp4: '/pin_rows.mp4',
    gif: '/pin_rows.gif',
  },
  {
    id: 'large-tables',
    title: 'Large Tables',
    description: 'Handle tables with thousands of rows smoothly with virtualized scrolling.',
    mp4: '/large_tables.mp4',
    gif: '/large_tables.gif',
  },
];

function DemoCard({ demo }: { demo: Demo }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [useGif, setUseGif] = useState(false);

  const handleMouseEnter = () => {
    if (videoRef.current && !useGif) {
      videoRef.current.play().catch(() => setUseGif(true));
      setIsPlaying(true);
    }
  };

  const handleMouseLeave = () => {
    if (videoRef.current && !useGif) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
      setIsPlaying(false);
    }
  };

  return (
    <div
      className="group rounded-2xl border border-[var(--ui-edge)]/60 bg-[var(--ui-bg)] overflow-hidden hover:shadow-lg hover:shadow-black/[0.04] dark:hover:shadow-black/20 hover:-translate-y-0.5 transition-all duration-300"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="relative aspect-video bg-[var(--ui-subtle)] overflow-hidden">
        {useGif ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={demo.gif}
            alt={demo.title}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <video
            ref={videoRef}
            src={demo.mp4}
            muted
            loop
            playsInline
            preload="metadata"
            className="w-full h-full object-cover"
            onError={() => setUseGif(true)}
          >
            <track kind="descriptions" label={demo.title} />
          </video>
        )}

        {!isPlaying && !useGif && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/10 group-hover:bg-transparent transition-colors duration-300">
            <div className="w-14 h-14 rounded-full bg-white/90 dark:bg-black/60 flex items-center justify-center group-hover:scale-110 transition-transform duration-300 shadow-lg">
              <svg className="w-5 h-5 text-[var(--ui-accent)] ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </div>
        )}
      </div>

      <div className="p-6">
        <h3 className="text-xl mb-2">{demo.title}</h3>
        <p className="text-sm text-[var(--ui-subtle-fg)] leading-relaxed font-sans">
          {demo.description}
        </p>
      </div>
    </div>
  );
}

export default function Demos() {
  return (
    <section className="py-24 px-6 bg-[var(--ui-subtle)]">
      <div className="max-w-6xl mx-auto">
        <div className="mb-20">
          <span className="font-mono text-xs tracking-widest uppercase text-[var(--ui-accent)] block mb-3">
            Demos
          </span>
          <h2 className="text-4xl sm:text-5xl tracking-tight max-w-md leading-[1.15]">
            See it in action
          </h2>
          <p className="text-lg text-[var(--ui-subtle-fg)] max-w-md mt-5 leading-relaxed font-sans">
            Hover over each demo to preview the feature.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {demos.map((demo) => (
            <DemoCard key={demo.id} demo={demo} />
          ))}
        </div>
      </div>
    </section>
  );
}
