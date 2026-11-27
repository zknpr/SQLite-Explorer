'use client';

/**
 * The landing page's live viewer: the real viewer iframe and sql.js worker,
 * running the Chinook sample in this tab.
 *
 * Loading costs about 1.5 MB on the wire (measured locally with gzip: the
 * WebAssembly engine 0.4 MB, viewer and worker 0.14 MB, and the 1 MB sample,
 * which next start serves uncompressed), so the preview starts only after the page itself has loaded
 * and the browser is idle. On narrow screens and with Save-Data it waits for
 * a click instead: the viewer is built for a wide window, and a phone on
 * mobile data should not pay for it unasked.
 */

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Database, RotateCcw } from 'lucide-react';
import DemoSqlEditor from '@/app/demo/DemoSqlEditor';
import { PREVIEW_SAMPLE } from '@/app/demo/samples';
import { VIEWER_SRC, useViewerSession } from '@/app/demo/useViewerSession';

const PREVIEW_FILENAME = 'chinook.db';
/** The table the preview opens first: the widest one, with names people know. */
const PREVIEW_TABLE = 'Track';
const OPEN_TABLE_TIMEOUT_MS = 10_000;
const WIDE_ENOUGH = '(min-width: 768px)';

function subscribeToWidth(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE_ENOUGH);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** Narrow screens and Save-Data load the preview only when asked. */
function shouldWaitForClick(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true || !window.matchMedia(WIDE_ENOUGH).matches;
}

/**
 * Click the viewer's own "Open table" button once the schema has loaded.
 * The viewer is same-origin, so its document is reachable; the accessible
 * name is the one the demo's browser tests also rely on. If the button never
 * appears, the preview stays on the viewer's own table list.
 */
function openTableWhenListed(iframe: HTMLIFrameElement, table: string): () => void {
  let stopped = false;
  const deadline = Date.now() + OPEN_TABLE_TIMEOUT_MS;
  const selector = `button[aria-label="Open table ${table}"]`;
  const tick = () => {
    if (stopped) return;
    const button = iframe.contentDocument?.querySelector<HTMLButtonElement>(selector);
    if (button) {
      button.click();
      return;
    }
    if (Date.now() < deadline) setTimeout(tick, 100);
  };
  tick();
  return () => {
    stopped = true;
  };
}

/**
 * Until the visitor clicks or types inside the viewer, hand wheel scrolling
 * to the page. Without this, a wheel turn over the 600 px frame scrolls the
 * Track table's 3,503 rows and the page stops moving; maps embedded in pages
 * wait for a click for the same reason. Ctrl+wheel (pinch zoom) is left alone.
 */
function passWheelToPageUntilUsed(iframe: HTMLIFrameElement, onUse: () => void): () => void {
  const viewerDocument = iframe.contentDocument;
  if (!viewerDocument) return () => {};
  let used = false;
  const onWheel = (event: WheelEvent) => {
    if (used || event.ctrlKey) return;
    event.preventDefault();
    const unit =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 :
      event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? window.innerHeight : 1;
    window.scrollBy({ top: event.deltaY * unit, left: 0, behavior: 'instant' });
  };
  const markUsed = () => {
    if (used) return;
    used = true;
    onUse();
  };
  viewerDocument.addEventListener('wheel', onWheel, { capture: true, passive: false });
  viewerDocument.addEventListener('pointerdown', markUsed, { capture: true });
  viewerDocument.addEventListener('keydown', markUsed, { capture: true });
  return () => {
    viewerDocument.removeEventListener('wheel', onWheel, { capture: true });
    viewerDocument.removeEventListener('pointerdown', markUsed, { capture: true });
    viewerDocument.removeEventListener('keydown', markUsed, { capture: true });
  };
}

function ViewerPlaceholder({ children }: { children: React.ReactNode }) {
  // A plain sketch of the viewer's layout in its own colours, so the box does
  // not change shape or colour when the real viewer replaces it.
  return (
    <div className="relative flex h-full bg-[#1e1e1e] text-[#cccccc]">
      <div aria-hidden="true" className="hidden w-[220px] shrink-0 border-r border-[#2b2b2b] bg-[#252526] p-3 sm:block">
        {Array.from({ length: 11 }, (_, i) => (
          <div key={i} className="mb-3 h-2.5 rounded-sm bg-[#3a3a3a]" style={{ width: `${45 + ((i * 37) % 40)}%` }} />
        ))}
      </div>
      <div aria-hidden="true" className="flex-1 overflow-hidden">
        {Array.from({ length: 22 }, (_, i) => (
          <div key={i} className="h-[26px] border-b border-[#2b2b2b]" />
        ))}
      </div>
      <div className="absolute inset-0 flex items-center justify-center p-6 text-center">{children}</div>
    </div>
  );
}

export default function LivePreview() {
  const session = useViewerSession();
  const { status, loadSampleDatabase, iframeRef, querySession } = session;
  // The server render assumes a wide screen; the client corrects it before the
  // preview would start.
  const waitForClick = useSyncExternalStore(subscribeToWidth, shouldWaitForClick, () => false);
  const started = useRef(false);
  const [inUse, setInUse] = useState(false);

  const start = useCallback(() => {
    if (started.current) return;
    started.current = true;
    void loadSampleDatabase(PREVIEW_SAMPLE.url, PREVIEW_FILENAME);
  }, [loadSampleDatabase]);

  useEffect(() => {
    if (waitForClick) return;
    let idle: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const boot = () => {
      if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(start, { timeout: 2000 });
      else timer = setTimeout(start, 200);
    };
    if (document.readyState === 'complete') boot();
    else window.addEventListener('load', boot, { once: true });
    return () => {
      window.removeEventListener('load', boot);
      if (idle !== undefined) window.cancelIdleCallback(idle);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [start, waitForClick]);

  // Each (re)load mounts a fresh viewer document; open the table in each one.
  useEffect(() => {
    if (status !== 'ready') return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    let stop = () => {};
    const onLoad = () => {
      stop();
      const stopOpening = openTableWhenListed(iframe, PREVIEW_TABLE);
      const stopPassing = passWheelToPageUntilUsed(iframe, () => setInUse(true));
      stop = () => {
        stopOpening();
        stopPassing();
      };
    };
    iframe.addEventListener('load', onLoad);
    if (iframe.contentDocument?.readyState === 'complete' && iframe.contentDocument.URL !== 'about:blank') onLoad();
    return () => {
      iframe.removeEventListener('load', onLoad);
      stop();
    };
  }, [status, iframeRef, querySession]);

  const retry = () => {
    started.current = false;
    start();
  };

  // Start over from the sample file: a new worker and a new viewer document,
  // so no state from the edited copy survives.
  const reset = () => {
    session.handleClose();
    setInUse(false);
    retry();
  };

  return (
    <div className="overflow-hidden rounded-xl bg-[#1e1e1e] ring-1 ring-black/10">
      <div className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 border-b border-black/60 bg-[#16181c] px-4 py-2 text-[0.8125rem] text-[#a9b1ba]">
        <span className="flex items-center gap-2 font-medium text-[#e8edf2]">
          <Database className="h-3.5 w-3.5 text-[#4fa8f0]" aria-hidden="true" />
          {PREVIEW_FILENAME}
        </span>
        <span className="hidden text-[#7d8792] md:inline">
          {status !== 'ready'
            ? 'The Chinook sample database'
            : inUse
              ? 'Live in your browser. Your edits stay in this tab.'
              : 'Live in your browser. Click inside to scroll the table.'}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {status === 'ready' && (
            <button
              type="button"
              onClick={reset}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 hover:bg-white/10 hover:text-white"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Reset sample
            </button>
          )}
          <Link
            href="/demo"
            className="rounded-md px-2.5 py-1 hover:bg-white/10 hover:text-white"
          >
            Open your own file
          </Link>
        </span>
      </div>

      <div className="h-[440px] md:h-[600px]">
        {status === 'ready' ? (
          <iframe
            ref={iframeRef}
            src={VIEWER_SRC}
            title="SQLite Explorer viewer with the Chinook sample database"
            className="block h-full w-full border-0"
          />
        ) : status === 'error' ? (
          <ViewerPlaceholder>
            <div role="alert" className="max-w-md rounded-lg bg-[#252526] px-5 py-4 shadow-lg">
              <p className="font-semibold text-white">The preview did not load.</p>
              <p className="mt-1 text-sm text-[#b5b5b5]">{session.errorMessage ?? 'The database worker stopped.'}</p>
              <button
                type="button"
                onClick={retry}
                className="mt-3 rounded-md bg-[#0070f3] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
              >
                Try again
              </button>
            </div>
          </ViewerPlaceholder>
        ) : waitForClick && status === 'idle' ? (
          <ViewerPlaceholder>
            <button
              type="button"
              onClick={start}
              className="rounded-lg bg-[#0070f3] px-5 py-3 font-medium text-white shadow-lg hover:opacity-90"
            >
              Load the live preview
              <span className="block text-sm font-normal opacity-80">Downloads about 1.5 MB and runs in this tab</span>
            </button>
          </ViewerPlaceholder>
        ) : (
          <ViewerPlaceholder>
            <p role="status" className="text-sm text-[#9d9d9d]">Loading the Chinook sample…</p>
          </ViewerPlaceholder>
        )}
      </div>

      {status === 'ready' && (
        <DemoSqlEditor
          key={querySession}
          open={session.queryEditorOpen}
          databaseName={PREVIEW_FILENAME}
          onClose={session.closeQueryEditor}
          executeQuery={session.executeReadQuery}
        />
      )}
    </div>
  );
}
