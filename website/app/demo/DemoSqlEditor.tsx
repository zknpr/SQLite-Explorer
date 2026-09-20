'use client';

import { useEffect, useRef, useState } from 'react';
import { Play, X, ChevronLeft, ChevronRight } from 'lucide-react';
import type { CellValue, QueryResultSet } from '../../../src/core/types';
import { SQL_MAX_TEXT, SQL_RESULT_ROWS } from '../../../src/core/sql-workspace';

const PAGE_ROWS = 50;
const buttonClass = 'rounded-md px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-accent) disabled:opacity-40 disabled:cursor-not-allowed';

function displayCell(value: CellValue, exact?: string): string {
  if (exact !== undefined) return exact;
  if (value === null) return 'NULL';
  if (value instanceof Uint8Array) {
    const hex = '0x' + Array.from(value.subarray(0, 64), byte => byte.toString(16).padStart(2, '0')).join('');
    return value.length > 64 ? `${hex}… [display shortened]` : hex;
  }
  const text = String(value);
  return text.length > 512 ? `${text.slice(0, 512)}… [display shortened]` : text;
}

interface DemoSqlEditorProps {
  open: boolean;
  databaseName: string;
  onClose: () => void;
  executeQuery: (sql: string, parameters: string) => Promise<QueryResultSet>;
}

export default function DemoSqlEditor({ open, databaseName, onClose, executeQuery }: DemoSqlEditorProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const pending = useRef(false);
  const requestId = useRef(0);
  const [sql, setSql] = useState('SELECT 1 AS value;');
  const [parameters, setParameters] = useState('[]');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QueryResultSet | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [page, setPage] = useState(0);

  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      input.current?.focus();
    } else {
      dialog.current?.close();
    }
  }, [open]);

  // The parent remounts this editor when replacing the worker, including reloads
  // of the same file. A retired connection must never repopulate the new editor.
  useEffect(() => () => { requestId.current++; }, []);

  const run = async () => {
    if (pending.current || !sql.trim()) return;
    pending.current = true;
    const id = ++requestId.current;
    setRunning(true);
    setError(null);
    setResult(null);
    setPage(0);
    const started = performance.now();
    try {
      const nextResult = await executeQuery(sql, parameters);
      if (requestId.current !== id) return;
      setResult(nextResult);
      setElapsed(Math.round(performance.now() - started));
    } catch (failure) {
      if (requestId.current !== id) return;
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (requestId.current === id) {
        pending.current = false;
        setRunning(false);
      }
    }
  };

  const count = Math.min(result?.rows.length ?? 0, SQL_RESULT_ROWS);
  const pages = Math.max(1, Math.ceil(count / PAGE_ROWS));
  const firstRow = page * PAGE_ROWS;

  return (
    <dialog
      ref={dialog}
      aria-labelledby="demo-sql-title"
      aria-describedby="demo-sql-help"
      onClose={onClose}
      onKeyDown={event => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          void run();
        }
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-6xl overflow-hidden rounded-xl border border-(--ui-edge) bg-(--ui-bg) text-(--ui-fg) shadow-2xl backdrop:bg-black/60"
    >
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <header className="flex items-start justify-between gap-4 border-b border-(--ui-edge) px-5 py-4">
          <div className="min-w-0">
            <p className="truncate text-xs text-(--ui-subtle-fg)">{databaseName}</p>
            <h2 id="demo-sql-title" className="mt-1 text-xl font-semibold">SQL Query</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close SQL editor" className={`${buttonClass} hover:bg-(--ui-subtle)`}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto p-5">
          <p id="demo-sql-help" className="mb-4 text-sm text-(--ui-subtle-fg)">
            Run one read-only SELECT or WITH query on this database. Edits stay in the table viewer.
          </p>
          <label htmlFor="demo-sql-input" className="mb-2 block text-sm font-medium">SQL statement</label>
          <textarea
            ref={input}
            id="demo-sql-input"
            value={sql}
            onChange={event => setSql(event.target.value)}
            maxLength={SQL_MAX_TEXT}
            rows={6}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="block w-full resize-y rounded-lg border border-(--ui-edge) bg-(--ui-subtle) p-3 font-mono text-sm leading-relaxed focus:outline-2 focus:outline-(--ui-accent)"
          />
          <details className="mt-3 text-sm">
            <summary className="w-fit cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-(--ui-accent)">Parameters (JSON array)</summary>
            <label htmlFor="demo-sql-parameters" className="mt-2 block text-xs text-(--ui-subtle-fg)">
              Parameter values — positional ? or ?NNN; strings, numbers, or null.
            </label>
            <textarea
              id="demo-sql-parameters"
              aria-label="Parameter values"
              value={parameters}
              onChange={event => setParameters(event.target.value)}
              maxLength={SQL_MAX_TEXT}
              rows={2}
              spellCheck={false}
              className="mt-2 block w-full rounded-md border border-(--ui-edge) bg-(--ui-subtle) p-2 font-mono text-sm focus:outline-2 focus:outline-(--ui-accent)"
            />
          </details>
          <div className="my-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-(--ui-subtle-fg)">1,000 rows · 128 columns · 4 MiB result limit · 30s timeout</p>
            <button type="button" disabled={running || !sql.trim()} onClick={() => void run()}
              className={`${buttonClass} flex items-center gap-2 bg-(--ui-accent) text-(--ui-accent-fg) hover:opacity-90`}>
              <Play size={14} aria-hidden="true" />
              {running ? 'Running…' : 'Run query'}
              <span className="text-xs opacity-80" aria-hidden="true">⌘/Ctrl ↵</span>
            </button>
          </div>
          {error && <p role="alert" className="mb-3 break-words rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
          <div role="status" className="text-sm text-(--ui-subtle-fg)">
            {running ? 'Running query…' : result ? `${count.toLocaleString('en-US')} ${count === 1 ? 'row' : 'rows'} · ${elapsed} ms` : 'Results will appear here.'}
          </div>
          {result && (
            <section aria-label="Query results" className="mt-3">
              {result.rows.length > SQL_RESULT_ROWS && (
                <p className="mb-3 text-sm text-amber-800 dark:text-amber-300">Showing the first 1,000 rows. Refine the query to see other rows.</p>
              )}
              {count === 0 ? <p className="py-4 text-sm">No rows returned.</p> : (
                <div tabIndex={0} role="region" aria-label="Scrollable query results"
                  className="max-h-80 overflow-auto rounded-lg border border-(--ui-edge) focus-visible:outline-2 focus-visible:outline-(--ui-accent)">
                  <table aria-label="SQL results" className="w-full border-collapse text-left font-mono text-xs">
                    <thead className="sticky top-0 bg-(--ui-subtle)">
                      <tr>{result.headers.map((header, column) => (
                        <th key={column} scope="col" className="border-b border-(--ui-edge) px-3 py-2 font-semibold">
                          <div className="max-w-80 break-words">{header}</div>
                        </th>
                      ))}</tr>
                    </thead>
                    <tbody>{result.rows.slice(firstRow, Math.min(firstRow + PAGE_ROWS, count)).map((row, offset) => (
                      <tr key={firstRow + offset} className="even:bg-(--ui-subtle)/50">
                        {row.map((value, column) => {
                          const clipped = result.oversizedCells?.[firstRow + offset]?.[column];
                          return (
                            <td key={column} className="border-b border-(--ui-edge) px-3 py-2 align-top">
                              <div className={`max-w-80 break-words whitespace-pre-wrap ${value === null ? 'italic text-(--ui-subtle-fg)' : ''}`}>
                                {displayCell(value, result.exactIntegerTexts?.[firstRow + offset]?.[column])}
                              </div>
                              {clipped && <p className="mt-1 text-(--ui-subtle-fg)">Preview; {clipped.byteLength.toLocaleString('en-US')} bytes total</p>}
                            </td>
                          );
                        })}
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
              {pages > 1 && <nav aria-label="Results pagination" className="mt-3 flex items-center justify-end gap-3 text-sm">
                <button type="button" aria-label="Previous results page" disabled={page === 0} onClick={() => setPage(page - 1)} className={`${buttonClass} hover:bg-(--ui-subtle)`}><ChevronLeft size={16} /></button>
                <span>Page {page + 1} of {pages}</span>
                <button type="button" aria-label="Next results page" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)} className={`${buttonClass} hover:bg-(--ui-subtle)`}><ChevronRight size={16} /></button>
              </nav>}
            </section>
          )}
        </div>
      </div>
    </dialog>
  );
}
