/**
 * Demos Component
 *
 * Autoplay-on-hover video cards showcasing key features.
 * Falls back to GIF if video playback fails.
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
      className="group rounded-xl border border-[var(--ui-edge)] bg-[var(--ui-bg)] overflow-hidden hover:border-[var(--ui-accent)]/50 transition-colors"
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
          <div className="absolute inset-0 flex items-center justify-center bg-black/10 group-hover:bg-transparent transition-colors">
            <div className="w-12 h-12 rounded-full bg-white/90 dark:bg-black/60 flex items-center justify-center group-hover:scale-110 transition-transform shadow-lg">
              <svg className="w-5 h-5 text-[var(--ui-accent)] ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </div>
        )}
      </div>

      <div className="p-5">
        <h3 className="font-semibold text-lg mb-1">{demo.title}</h3>
        <p className="text-sm text-[var(--ui-subtle-fg)] leading-relaxed">
          {demo.description}
        </p>
      </div>
    </div>
  );
}

export default function Demos() {
  return (
    <section className="py-24 px-6">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            See it in action
          </h2>
          <p className="text-lg text-[var(--ui-subtle-fg)] max-w-2xl mx-auto">
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
