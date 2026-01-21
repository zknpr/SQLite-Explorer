/**
 * Demos Component
 *
 * Showcases video demonstrations of key extension features.
 * Uses MP4 with GIF fallback for maximum browser compatibility.
 *
 * Design: Grid layout with autoplay videos on hover/intersection.
 */

'use client';

import { useRef, useState } from 'react';

/**
 * Demo data structure for type safety.
 */
interface Demo {
  id: string;
  title: string;
  description: string;
  mp4: string;
  gif: string;
}

/**
 * List of feature demos with video sources.
 */
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

/**
 * DemoCard renders a single demo with video player.
 * Autoplays on hover and loops continuously.
 */
function DemoCard({ demo }: { demo: Demo }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [useGif, setUseGif] = useState(false);

  /**
   * Handle mouse enter - start playing video
   */
  const handleMouseEnter = () => {
    if (videoRef.current && !useGif) {
      videoRef.current.play().catch(() => {
        // If video fails to play, fall back to GIF
        setUseGif(true);
      });
      setIsPlaying(true);
    }
  };

  /**
   * Handle mouse leave - pause and reset video
   */
  const handleMouseLeave = () => {
    if (videoRef.current && !useGif) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
      setIsPlaying(false);
    }
  };

  return (
    <div
      className="group rounded-xl border border-[var(--border)] bg-[var(--background)] overflow-hidden hover:border-[var(--accent)]/50 transition-colors"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Video container */}
      <div className="relative aspect-video bg-[var(--muted)] overflow-hidden">
        {useGif ? (
          /* GIF fallback for browsers that don't support autoplay */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={demo.gif}
            alt={demo.title}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          /* MP4 video - preferred format */
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
            {/* Fallback text for screen readers */}
            <track kind="descriptions" label={demo.title} />
          </video>
        )}

        {/* Play indicator overlay (hidden when playing) */}
        {!isPlaying && !useGif && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-transparent transition-colors">
            <div className="w-16 h-16 rounded-full bg-white/90 flex items-center justify-center group-hover:scale-110 transition-transform">
              <svg
                className="w-6 h-6 text-[var(--accent)] ml-1"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </div>
        )}
      </div>

      {/* Text content */}
      <div className="p-5">
        <h3 className="text-lg font-semibold mb-2">{demo.title}</h3>
        <p className="text-sm text-[var(--muted-foreground)] leading-relaxed">
          {demo.description}
        </p>
      </div>
    </div>
  );
}

/**
 * Demos section displaying all feature videos in a grid.
 */
export default function Demos() {
  return (
    <section className="py-24 px-6">
      <div className="max-w-6xl mx-auto">
        {/* Section header */}
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            See it in action
          </h2>
          <p className="text-lg text-[var(--muted-foreground)] max-w-2xl mx-auto">
            Hover over each demo to see the feature in action.
          </p>
        </div>

        {/* Demo grid - 2 columns on larger screens */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {demos.map((demo) => (
            <DemoCard key={demo.id} demo={demo} />
          ))}
        </div>
      </div>
    </section>
  );
}
