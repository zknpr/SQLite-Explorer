'use client';

/**
 * Demo Page Client Component
 *
 * Standalone SQLite database viewer that runs entirely in the browser.
 * Users can upload their own .db files or load sample databases. The worker,
 * the viewer iframe and the RPC bridge between them live in useViewerSession.
 */

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { Upload, Database, FileUp, Download, RefreshCw, AlertCircle } from 'lucide-react';
import SiteHeader from '@/components/SiteHeader';
import DemoSqlEditor from './DemoSqlEditor';
import { SAMPLE_DATABASES } from './samples';
import { VIEWER_SRC, useViewerSession } from './useViewerSession';

export default function DemoClient() {
  const {
    iframeRef,
    status,
    errorMessage,
    downloadError,
    readOnlyNotice,
    databaseName,
    canDownload,
    queryEditorOpen,
    querySession,
    closeQueryEditor,
    executeReadQuery,
    loadDatabaseFile,
    loadSampleDatabase,
    handleDownload,
    handleReload,
    handleClose
  } = useViewerSession();

  /**
   * Whether the drop zone is currently being hovered over.
   */
  const [isDragOver, setIsDragOver] = useState(false);

  // -------------------------------------------------------------------------
  // Drag and Drop Handlers
  // -------------------------------------------------------------------------

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      loadDatabaseFile(files[0]);
    }
  }, [loadDatabaseFile]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const iconButton = 'rounded-md p-2 text-subtle-foreground transition-colors hover:bg-subtle hover:text-foreground';

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <SiteHeader>
        {status === 'ready' && (
          <div className="flex min-w-0 items-center gap-1 border-l border-edge pl-4">
            <span className="mr-1 hidden truncate text-[0.9375rem] font-semibold sm:inline">{databaseName}</span>
            <button onClick={handleReload} className={iconButton} title="Reload database">
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            </button>
            {canDownload && (
              <button onClick={handleDownload} className={iconButton} title="Download database">
                <Download className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
            <button
              onClick={handleClose}
              className="ml-1 rounded-md border border-edge px-3 py-1.5 text-sm font-medium transition-colors hover:bg-subtle"
            >
              Close
            </button>
          </div>
        )}
      </SiteHeader>

      <main className="flex flex-1">
        {status === 'idle' && (
          <div className="w-full px-5 py-12 sm:px-6 md:py-20">
            <div className="mx-auto max-w-6xl">
              <h1 className="max-w-[18ch] text-[2.5rem] font-bold leading-[1.05] tracking-[-0.035em] sm:text-5xl">
                Open a database in your browser
              </h1>
              <p className="mt-5 max-w-[60ch] text-lg leading-relaxed text-subtle-foreground">
                SQLite runs inside this page as WebAssembly. Your file is read from your disk and never
                uploaded. Edits stay in memory until you download the changed copy.
              </p>

              <div className="mt-12 grid gap-10 lg:grid-cols-12">
                <div
                  className={`relative flex cursor-pointer flex-col items-start justify-center rounded-xl border-2 border-dashed p-8 transition-colors sm:p-12 lg:col-span-7 ${
                    isDragOver ? 'border-accent bg-accent/10' : 'border-edge hover:border-subtle-foreground hover:bg-subtle/60'
                  }`}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={() => document.getElementById('file-input')?.click()}
                >
                  <input
                    id="file-input"
                    type="file"
                    accept=".db,.sqlite,.sqlite3,.db3"
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files?.[0]) {
                        loadDatabaseFile(e.target.files[0]);
                      }
                    }}
                  />
                  <Upload className="h-8 w-8 text-accent" strokeWidth={1.75} aria-hidden="true" />
                  <h2 className="mt-4 text-2xl font-bold">Drop a SQLite file here</h2>
                  <p className="mt-1 text-subtle-foreground">.db, .sqlite, .sqlite3 or .db3</p>
                  <span className="mt-6 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 font-semibold text-accent-foreground">
                    <FileUp className="h-4 w-4" aria-hidden="true" />
                    Choose a file
                  </span>
                </div>

                <div className="lg:col-span-5">
                  <h2 className="text-lg font-bold">Or open a sample</h2>
                  <div className="mt-4 grid gap-3">
                    {SAMPLE_DATABASES.map((db) => (
                      <button
                        key={db.name}
                        onClick={() => loadSampleDatabase(db.url, `${db.name.toLowerCase()}.db`)}
                        className="flex items-center gap-4 rounded-lg border border-edge p-4 text-left transition-colors hover:border-subtle-foreground hover:bg-subtle"
                      >
                        <Database className="h-7 w-7 shrink-0 text-accent" strokeWidth={1.75} aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="block font-semibold">{db.name}</span>
                          <span className="block text-sm text-subtle-foreground">{db.description}</span>
                        </span>
                        <span className="text-sm text-subtle-foreground">{db.size}</span>
                      </button>
                    ))}
                  </div>
                  <p className="mt-6 text-[0.9375rem] leading-relaxed text-subtle-foreground">
                    The <strong className="font-semibold text-foreground">SQL Query</strong> entry in the viewer&apos;s
                    sidebar opens a SQL editor for SELECT queries. For files you keep editing, the{' '}
                    <Link href="/#vscode" className="text-accent underline-offset-2 hover:underline">VS&nbsp;Code extension</Link>{' '}
                    and the{' '}
                    <Link href="/download" className="text-accent underline-offset-2 hover:underline">desktop app</Link>{' '}
                    save straight to the file.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {status === 'loading' && (
          <div className="flex flex-1 flex-col items-center justify-center">
            <div className="mb-4 h-12 w-12 animate-spin rounded-full border-b-2 border-accent motion-reduce:animate-none" />
            <p role="status" className="text-subtle-foreground">Loading database…</p>
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-1 flex-col items-center justify-center p-8">
            <AlertCircle className="mb-4 h-10 w-10 text-red-600 dark:text-red-400" aria-hidden="true" />
            <h1 className="mb-2 text-xl font-semibold">The database did not open</h1>
            <p role="alert" className="mb-6 max-w-md text-center text-subtle-foreground">
              {errorMessage || 'The database worker stopped without saying why.'}
            </p>
            <button
              onClick={handleClose}
              className="rounded-lg border border-edge px-4 py-2 font-medium transition-colors hover:bg-subtle"
            >
              Choose another file
            </button>
          </div>
        )}

        {status === 'ready' && (
          <div className="flex min-w-0 flex-1 flex-col">
            {readOnlyNotice && (
              <div
                role="status"
                className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
              >
                {readOnlyNotice}
              </div>
            )}
            {downloadError && (
              <div
                role="alert"
                className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
              >
                {downloadError}
              </div>
            )}
            <iframe
              ref={iframeRef}
              src={VIEWER_SRC}
              className="flex-1 border-0"
              title="SQLite Viewer"
            />
            <DemoSqlEditor
              key={querySession}
              open={queryEditorOpen}
              databaseName={databaseName ?? 'Database'}
              onClose={closeQueryEditor}
              executeQuery={executeReadQuery}
            />
          </div>
        )}
      </main>
    </div>
  );
}
