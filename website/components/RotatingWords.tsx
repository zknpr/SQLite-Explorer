'use client';

/**
 * The hero's second line: where SQLite Explorer runs. The places take turns
 * for as long as the line is on screen and the tab is visible, each sliding
 * up out of a box that clips it. With reduced motion the first place stays.
 *
 * At the headline's line height Inter's glyphs are taller than the line box,
 * so the box reaches CLIP_PAD past it above and below (a negative margin
 * keeps the layout as it was), and every word is as tall as the box: a word
 * moved up by its own height clears it, descenders included.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

const STEP_MS = 2000;
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function subscribeToMotionPreference(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

const prefersReducedMotion = () => window.matchMedia(REDUCED_MOTION).matches;

export default function RotatingWords({ words, className = '' }: { words: readonly string[]; className?: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const [index, setIndex] = useState(0);
  const [onScreen, setOnScreen] = useState(false);
  // The server cannot know the preference, so it renders the still line.
  const reduceMotion = useSyncExternalStore(subscribeToMotionPreference, prefersReducedMotion, () => true);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (reduceMotion || !onScreen) return;
    const timer = setInterval(() => {
      if (!document.hidden) setIndex(i => (i + 1) % words.length);
    }, STEP_MS);
    return () => clearInterval(timer);
  }, [reduceMotion, onScreen, words.length]);

  const current = reduceMotion ? 0 : index;
  const previous = (current + words.length - 1) % words.length;
  const slide = 'transition-[translate,opacity] duration-500 ease-out motion-reduce:transition-none';

  return (
    // CLIP_PAD is the 0.15em in -my and py below.
    <span ref={box} className={`relative -my-[0.15em] inline-grid justify-items-center overflow-hidden align-bottom ${className}`}>
      {words.map((word, i) => (
        <span
          key={word}
          className={`col-start-1 row-start-1 whitespace-nowrap py-[0.15em] ${
            i === current
              ? `translate-y-0 opacity-100 ${slide}`
              : i === previous
                ? `-translate-y-full opacity-0 ${slide}`
                : // Waiting below; it jumps there without a transition.
                  'translate-y-full opacity-0'
          }`}
        >
          {word}
        </span>
      ))}
    </span>
  );
}
