/**
 * CSV/JSON bulk import into an existing table.
 *
 * DESKTOP ONLY — like the SQL console and the database tabs, this module may be
 * imported by `desktop-viewer.js` and nothing else (pinned by
 * tests/unit/import_data.test.ts). Its one piece of shared markup, the toolbar
 * button `#btnImportData`, ships `hidden` in the template; this module unhides
 * it, so the VS Code webview and the web demo carry an inert element and none
 * of this code. (The extension has its own import: a VS Code command driven by
 * quick picks, `src/bulkImport.ts` upstream.)
 *
 * The flow, and who owns each step:
 *
 *   shell open dialog (.csv/.json)  →  shell reads ≤ 64 MiB as UTF-8 text
 *   →  parseImport() here, in the page  →  this modal: target table, per-column
 *   mapping (auto-matched by name, any column skippable), a five-row preview of
 *   the MAPPED rows, the destination columns nothing feeds  →  mapImportRows()
 *   →  ONE `importRows` worker call  →  count cache + grid refresh.
 *
 * The page never names a file. It receives what the user picked and hands that
 * exact path back for the read; the shell's import allowlist accepts nothing
 * else, and that allowlist is read-only — an import source never becomes a
 * database the page could write in place. Parsing runs here because the parser
 * is the shared pure module (src/core/bulk-import.ts) the extension uses too:
 * same limits (64 MiB / 100,000 rows / 256 columns), same CSV/JSON semantics.
 *
 * One edit, honestly reported: the worker inserts the whole batch inside one
 * savepoint and answers with the post-images the host records as ONE history
 * entry, so ⌘Z removes the entire import and a constraint failure on row N
 * leaves nothing behind. Like every other edit here the import is pending until
 * Save on both engines (the native session transaction, the WASM image).
 */
import { state } from './state.js';
import { backendApi } from './api.js';
import { updateStatus } from './ui.js';
import { closeModal, openModal, registerModalCloseHandler } from './modals.js';
import { loadTableData } from './grid.js';
import { noteRowCountChanged } from './count-cache.js';
import { saveHint } from './platform.js';
import { getErrorMessage } from './utils.js';
import {
    IMPORT_LIMIT_DESCRIPTION,
    mapImportRows,
    parseImport
} from '../../../src/core/bulk-import.ts';

export const IMPORT_MODAL_ID = 'importDataModal';
/** Mapped rows shown in the preview pane. */
export const IMPORT_PREVIEW_ROWS = 5;
/** Longest text shown per preview cell; the rest is elided, never imported differently. */
export const IMPORT_PREVIEW_MAX_CHARS = 256;

/**
 * The desktop entry's error surfacer (`(label) => (err) => …`); the fallback
 * only runs if a click arrives before initImportData, so it is never silent.
 */
let surface = (label) => (err) => console.error(label, err);

/**
 * The import in progress: source, parsed data, target table and column
 * metadata, the current mapping, and the connection it was opened against.
 * `null` while the modal is closed. Module-level rather than on `state`: the
 * desktop swaps `state` per database and this import belongs to exactly the
 * connection it captured — a switch or reload cancels it.
 */
let session = null;
let dialog = null;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** The parser format for a picked file name: `.json` is JSON, everything else CSV. */
export function importFormatOf(fileName) {
    return /\.json$/i.test(String(fileName ?? '')) ? 'json' : 'csv';
}

/**
 * Propose a mapping from source columns to target columns: an exact name match
 * first, then a case-insensitive match, each target used at most once, and
 * Skip (`undefined`) for everything else. Deterministic in source order so two
 * source columns cannot both claim one target.
 *
 * @param {string[]} sourceColumns
 * @param {string[]} targetColumns
 * @returns {Array<string | undefined>}
 */
export function autoMapColumns(sourceColumns, targetColumns) {
    const taken = new Set();
    const targets = sourceColumns.map(source => {
        const exact = targetColumns.find(target => target === source && !taken.has(target));
        if (exact !== undefined) taken.add(exact);
        return exact;
    });
    sourceColumns.forEach((source, index) => {
        if (targets[index] !== undefined) return;
        const lowered = source.toLowerCase();
        const candidates = targetColumns.filter(
            target => target.toLowerCase() === lowered && !taken.has(target)
        );
        // Ambiguous case-insensitive matches (`Id` vs `ID`, `id`) stay unmapped
        // rather than guessing between them.
        if (candidates.length === 1) {
            targets[index] = candidates[0];
            taken.add(candidates[0]);
        }
    });
    return targets;
}

/**
 * The reason a mapping cannot be imported yet, or null. Mirrors the three
 * refusals mapImportRows() throws, without throwing, so the modal can show
 * them live while the user edits the selects.
 *
 * @param {Array<string | undefined>} targets
 * @returns {string | null}
 */
export function describeMappingProblem(targets) {
    const used = targets.filter(target => target !== undefined);
    if (used.length === 0) return 'Map at least one source column.';
    const seen = new Set();
    for (const target of used) {
        if (seen.has(target)) return `Target column "${target}" is mapped more than once.`;
        seen.add(target);
    }
    return null;
}

/**
 * Destination columns the mapping leaves untouched (SQLite applies their
 * DEFAULT, or NULL), split by whether the insert can succeed without them:
 * a NOT NULL column with no default and no source value will make SQLite
 * refuse every row, and the whole import rolls back.
 *
 * @param {Array<{ identifier: string, isRequired: unknown, defaultExpression: unknown,
 *                 primaryKeyPosition: unknown, isRowidAlias?: unknown }>} targetColumns
 * @param {Array<string | undefined>} targets
 */
export function describeOmittedColumns(targetColumns, targets) {
    const mapped = new Set(targets.filter(target => target !== undefined));
    const omitted = targetColumns.filter(column => !mapped.has(column.identifier));
    const blocking = omitted.filter(column => (
        Number(column.isRequired) === 1
        && (column.defaultExpression === null || column.defaultExpression === undefined)
        // An INTEGER PRIMARY KEY is the rowid: SQLite assigns it.
        && column.isRowidAlias !== true
    ));
    return {
        omitted: omitted.map(column => column.identifier),
        blocking: blocking.map(column => column.identifier)
    };
}

/**
 * Display strings for the first rows of the MAPPED data. Text past
 * `maxChars` is shortened for the preview only — the import stores the full
 * value — and the marker says so.
 *
 * @param {Array<Record<string, unknown>>} rows
 * @param {string[]} columns the mapped target columns, in display order
 */
export function previewRows(rows, columns, {
    limit = IMPORT_PREVIEW_ROWS,
    maxChars = IMPORT_PREVIEW_MAX_CHARS,
    columnMetadata = []
} = {}) {
    const metadata = new Map(columnMetadata.map(column => [column.identifier, column]));
    return rows.slice(0, limit).map(row => columns.map(column => {
        if (!Object.hasOwn(row, column)) {
            const target = metadata.get(column);
            if (!target) return { text: 'DEFAULT', kind: 'default' };
            if (target.defaultExpression != null) {
                const expression = String(target.defaultExpression);
                return {
                    text: `DEFAULT ${expression.length > maxChars
                        ? expression.slice(0, maxChars) + '… [default preview shortened]' : expression}`,
                    kind: 'default'
                };
            }
            if (target.isRowidAlias === true) return { text: 'AUTO', kind: 'default' };
            return { text: 'NULL', kind: 'null' };
        }
        const value = row[column];
        if (value === null) return { text: 'NULL', kind: 'null' };
        const text = String(value);
        return text.length > maxChars
            ? { text: `${text.slice(0, maxChars)}… [preview shortened]`, kind: 'text' }
            : { text, kind: 'text' };
    }));
}

/**
 * A user-facing reason for a failed import. The two transport refusals are
 * named by code and would otherwise read as internals: the native sidecar's
 * request frame (`ERR_NATIVE_FRAME_TOO_LARGE`, 16 MiB) and the worker
 * transport's aggregate payload cap (`ERR_WEBVIEW_PAYLOAD_LIMIT`). Both mean
 * the same thing to the user — this file is too big to import in one edit —
 * and both leave the database untouched (the request never ran).
 */
export function describeImportFailure(error) {
    const message = getErrorMessage(error);
    if (/ERR_NATIVE_FRAME_TOO_LARGE/.test(message)) {
        return 'the row data exceeds the 16 MiB the native engine accepts in one edit. '
            + 'Split the file into smaller imports. No rows were imported.';
    }
    if (/ERR_WEBVIEW_PAYLOAD_LIMIT|aggregate-payload/.test(message)) {
        return 'the row data exceeds what the engine accepts in one edit. '
            + 'Split the file into smaller imports. No rows were imported.';
    }
    return message;
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/** Build the dialog once; every open re-renders its sections from `session`. */
function ensureDialog() {
    if (dialog) return dialog;
    const overlay = el('div', 'modal-overlay hidden');
    overlay.id = IMPORT_MODAL_ID;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'importDataModalTitle');
    // The grid's document-level click handler clears the selection on any
    // "outside" click; the modal is not one.
    overlay.setAttribute('data-preserve-grid-selection', '');

    const box = el('div', 'modal-dialog modal-dialog-lg import-dialog');
    const header = el('div', 'modal-header');
    const title = el('span', 'modal-title', 'Import CSV/JSON');
    title.id = 'importDataModalTitle';
    const close = el('button', 'modal-close', '×');
    close.type = 'button';
    close.dataset.modal = IMPORT_MODAL_ID;
    close.setAttribute('aria-label', 'Close import');
    header.append(title, close);

    const body = el('div', 'modal-body');
    const sourceLine = el('p', 'import-source-line');
    sourceLine.id = 'importSourceLine';

    const tableField = el('div', 'form-field');
    const tableLabel = el('label', undefined, 'Into table');
    tableLabel.setAttribute('for', 'importTargetTable');
    const tableSelect = el('select');
    tableSelect.id = 'importTargetTable';
    tableSelect.addEventListener('change', () => {
        selectTargetTable(tableSelect.value).catch(surface('Import target failed'));
    });
    tableField.append(tableLabel, tableSelect);

    const mappingField = el('div', 'form-field');
    const mappingLabel = el('span', 'form-group-label', 'Column mapping (source → table column)');
    mappingLabel.id = 'importMappingLabel';
    const mapping = el('div', 'import-mapping');
    mapping.id = 'importMapping';
    mapping.setAttribute('role', 'group');
    mapping.setAttribute('aria-labelledby', 'importMappingLabel');
    mappingField.append(mappingLabel, mapping);

    const previewField = el('div', 'form-field');
    const previewLabel = el('span', 'form-group-label');
    previewLabel.id = 'importPreviewLabel';
    const previewPane = el('div', 'import-preview-pane');
    const preview = el('table', 'sql-console-results-table import-preview-table');
    preview.id = 'importPreview';
    preview.setAttribute('aria-labelledby', 'importPreviewLabel');
    previewPane.appendChild(preview);
    previewField.append(previewLabel, previewPane);

    const notice = el('p', 'import-notice');
    notice.id = 'importNotice';
    notice.setAttribute('role', 'status');
    body.append(sourceLine, tableField, mappingField, previewField, notice);

    const footer = el('div', 'modal-footer');
    const cancel = el('button', 'btn-secondary modal-cancel', 'Cancel');
    cancel.type = 'button';
    cancel.dataset.modal = IMPORT_MODAL_ID;
    const submit = el('button', 'btn-primary', 'Import');
    submit.type = 'button';
    submit.id = 'btnSubmitImport';
    submit.addEventListener('click', () => {
        submitImport().catch(surface('Import failed'));
    });
    footer.append(cancel, submit);

    box.append(header, body, footer);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Every dismissal route (✕, Cancel, overlay click, Escape, closeAllModals on
    // a database switch) ends here; a running import keeps its session so its
    // completion still reconciles the grid it was aimed at.
    registerModalCloseHandler(IMPORT_MODAL_ID, () => {
        if (session && !session.submitting) session = null;
    });

    dialog = {
        overlay, sourceLine, tableSelect, mapping, previewLabel, preview, notice, submit,
        cancel, close
    };
    return dialog;
}

function renderSourceLine() {
    const { source, parsed, format } = session;
    dialog.sourceLine.textContent = `${source.name} · ${format.toUpperCase()} · `
        + `${parsed.rows.length.toLocaleString('en-US')} row${parsed.rows.length === 1 ? '' : 's'} · `
        + `${parsed.columns.length} source column${parsed.columns.length === 1 ? '' : 's'}`;
}

function renderTableSelect() {
    const select = dialog.tableSelect;
    select.replaceChildren();
    for (const name of session.tables) {
        const option = el('option', undefined, name);
        option.value = name;
        select.appendChild(option);
    }
    select.value = session.table;
}

function renderMapping() {
    const current = session;
    const { parsed, columns, targets, tableRequest } = current;
    const container = dialog.mapping;
    container.replaceChildren();
    parsed.columns.forEach((sourceColumn, index) => {
        const name = el('span', 'import-mapping-source', sourceColumn);
        name.title = sourceColumn;
        const arrow = el('span', 'import-mapping-arrow', '→');
        arrow.setAttribute('aria-hidden', 'true');
        const select = el('select');
        select.dataset.index = String(index);
        select.setAttribute('aria-label', `Target column for ${sourceColumn}`);
        const skip = el('option', undefined, 'Skip this column');
        skip.value = '';
        select.appendChild(skip);
        for (const column of columns) {
            const option = el('option', undefined,
                column.declaredType ? `${column.identifier} (${column.declaredType})` : column.identifier);
            option.value = column.identifier;
            select.appendChild(option);
        }
        select.value = targets[index] ?? '';
        select.addEventListener('change', () => {
            if (session !== current || current.tableRequest !== tableRequest
                || current.loadingTarget || current.submitting) return;
            current.targets[index] = select.value === '' ? undefined : select.value;
            renderPreviewAndNotice();
        });
        container.append(name, arrow, select);
    });
}

function renderPreviewAndNotice() {
    const { parsed, columns, targets } = session;
    const problem = describeMappingProblem(targets);
    const previewColumns = columns.map(column => column.identifier);
    const table = dialog.preview;
    table.replaceChildren();
    if (!problem) {
        const rows = previewRows(mapImportRows(parsed, targets), previewColumns, { columnMetadata: columns });
        const head = el('thead');
        const headRow = el('tr');
        for (const column of columns) {
            const heading = el('th', undefined, column.identifier);
            heading.title = column.declaredType || 'No declared type';
            headRow.appendChild(heading);
        }
        head.appendChild(headRow);
        const bodyNode = el('tbody');
        for (const row of rows) {
            const tr = el('tr');
            for (const cell of row) {
                const td = el('td', cell.kind === 'text' ? undefined : 'null-value', cell.text);
                tr.appendChild(td);
            }
            bodyNode.appendChild(tr);
        }
        table.append(head, bodyNode);
    }
    const shown = Math.min(IMPORT_PREVIEW_ROWS, parsed.rows.length);
    dialog.previewLabel.textContent = problem
        ? 'Preview'
        : `Preview — first ${shown} of ${parsed.rows.length.toLocaleString('en-US')} rows as they will be inserted`;

    const lines = [];
    let isError = false;
    if (problem) {
        lines.push(problem);
        isError = true;
    }
    const { omitted, blocking } = describeOmittedColumns(columns, targets);
    if (blocking.length > 0) {
        lines.push(
            `NOT NULL column${blocking.length === 1 ? '' : 's'} with no default and no source: `
            + `${blocking.join(', ')} — SQLite will refuse the import unless mapped.`
        );
    }
    const defaulted = omitted.filter(column => !blocking.includes(column));
    if (defaulted.length > 0) {
        lines.push(`Table columns without a source (their defaults apply): ${defaulted.join(', ')}.`);
    }
    lines.push('Defaults apply to omitted values, not explicit NULL or empty strings. SQLite evaluates SQL default expressions when inserting each row.');
    lines.push(`The import is one undoable edit; ${saveHint()} afterwards.`);
    dialog.notice.textContent = lines.join('\n');
    dialog.notice.classList.toggle('import-notice-error', isError);
    dialog.submit.disabled = problem !== null || session.submitting || session.loadingTarget || !session.schemaVersion;
    dialog.submit.textContent = `Import ${parsed.rows.length.toLocaleString('en-US')} row${parsed.rows.length === 1 ? '' : 's'}`;
}

function setBusy(busy) {
    dialog.submit.disabled = busy || session.loadingTarget || !session.schemaVersion
        || describeMappingProblem(session.targets) !== null;
    dialog.tableSelect.disabled = busy;
    for (const select of dialog.mapping.querySelectorAll('select')) select.disabled = busy || session.loadingTarget;
}

let tableRequestSequence = 0;
let openRequestSequence = 0;

function isCurrentConnection(current) {
    return state.isDbConnected && !state.isReadOnly && !state.isRefreshingContent
        && state.dbId === current.dbId && state.connectionGeneration === current.connectionGeneration;
}

async function selectTargetTable(name) {
    const current = session;
    if (!current || current.submitting) return;
    // Two quick select changes race their metadata fetches; only the latest
    // request may render, or a slow earlier answer would describe the wrong table.
    const request = ++tableRequestSequence;
    current.tableRequest = request;
    current.table = name;
    // Retire the reviewed schema before awaiting metadata. A queued submit or
    // failed target change must never reuse the previous table's preview.
    current.schemaVersion = null;
    current.loadingTarget = true;
    current.columns = [];
    current.targets = current.parsed.columns.map(() => undefined);
    renderMapping();
    renderPreviewAndNotice();
    dialog.notice.textContent = 'Loading destination columns…';
    setBusy(false);
    try {
        const info = await backendApi.getImportTarget(name);
        if (session !== current || current.tableRequest !== request) return;
        if (!isCurrentConnection(current)) {
            closeModal(IMPORT_MODAL_ID, dialog.overlay);
            session = null;
            return;
        }
        if (!Array.isArray(info?.columns) || typeof info.schemaVersion !== 'string' || !info.schemaVersion) {
            throw new Error('Unable to read the destination database schema.');
        }
        // Generated columns cannot be inserted into; SQLite computes them.
        current.columns = info.columns.filter(column => column.isGenerated !== true);
        current.schemaVersion = info.schemaVersion;
        current.targets = autoMapColumns(current.parsed.columns, current.columns.map(column => column.identifier));
        renderMapping();
        renderPreviewAndNotice();
    } catch (error) {
        if (session !== current || current.tableRequest !== request || !isCurrentConnection(current)) return;
        dialog.notice.textContent = `Unable to load import target: ${getErrorMessage(error)}`;
        dialog.notice.classList.add('import-notice-error');
        throw error;
    } finally {
        if (session === current && current.tableRequest === request) {
            current.loadingTarget = false;
            setBusy(false);
        }
    }
}

/** Small yield so a status line paints before a long synchronous parse. */
function nextFrame() {
    return new Promise(resolve => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0));
        else setTimeout(resolve, 0);
    });
}

/**
 * File > Import CSV/JSON… and the toolbar button. Refuses, by status line, the
 * states in which an import cannot run; otherwise picks, reads, parses and
 * opens the mapping modal. Resolves false when nothing was opened (a refusal or
 * a cancelled dialog); rejects on a real failure (the caller surfaces it).
 */
export async function openImportDialog() {
    if (!state.isDbConnected) {
        updateStatus('Import unavailable: no database is open');
        return false;
    }
    if (state.isReadOnly) {
        updateStatus('Import unavailable: the database is read-only');
        return false;
    }
    if (state.isRefreshingContent) {
        updateStatus('Import unavailable while the database is reloading');
        return false;
    }
    if (session?.submitting) {
        updateStatus('An import is already running');
        return false;
    }
    const tables = state.schemaCache.tables.map(table => table.name);
    if (tables.length === 0) {
        updateStatus('Import unavailable: this database has no tables to import into');
        return false;
    }
    const request = ++openRequestSequence;
    const targetConnection = { dbId: state.dbId, connectionGeneration: state.connectionGeneration };
    const ownsOpen = () => request === openRequestSequence && isCurrentConnection(targetConnection);
    const preferred = state.selectedTableType === 'table' && tables.includes(state.selectedTable)
        ? state.selectedTable
        : tables[0];
    const picked = await backendApi.pickImportSource();
    if (!ownsOpen()) return false;
    if (!picked) {
        updateStatus('Import cancelled');
        return false;
    }
    const format = importFormatOf(picked.name);
    updateStatus(`Reading ${picked.name}…`);
    const text = await backendApi.readImportSource(picked.path);
    if (!ownsOpen()) return false;
    updateStatus(`Parsing ${picked.name}…`);
    await nextFrame();
    if (!ownsOpen()) return false;
    let parsed;
    try {
        parsed = parseImport(text, format);
    } catch (error) {
        throw new Error(`${picked.name}: ${getErrorMessage(error)} (limits: ${IMPORT_LIMIT_DESCRIPTION})`);
    }
    const current = session = {
        source: { name: picked.name, size: picked.size },
        format,
        parsed,
        tables,
        table: preferred,
        columns: [],
        targets: parsed.columns.map(() => undefined),
        // The connection this import is for; a switch or reload cancels it.
        ...targetConnection,
        schemaVersion: null,
        loadingTarget: false,
        submitting: false
    };
    ensureDialog();
    renderSourceLine();
    renderTableSelect();
    await selectTargetTable(preferred);
    if (session !== current || !ownsOpen()) return false;
    updateStatus(`${picked.name}: ${parsed.rows.length.toLocaleString('en-US')} rows ready to import`);
    openModal(IMPORT_MODAL_ID, dialog.overlay);
    return true;
}

async function submitImport() {
    const current = session;
    if (!current || current.submitting || current.loadingTarget || !current.schemaVersion) return;
    if (!isCurrentConnection(current)) {
        closeModal(IMPORT_MODAL_ID, dialog.overlay);
        session = null;
        updateStatus('Import cancelled because the database changed');
        return;
    }
    const problem = describeMappingProblem(current.targets);
    if (problem) {
        renderPreviewAndNotice();
        return;
    }
    const rows = mapImportRows(current.parsed, current.targets);
    const count = rows.length;
    const table = current.table;
    current.submitting = true;
    setBusy(true);
    updateStatus(`Importing ${count.toLocaleString('en-US')} rows into ${table}…`);
    try {
        const result = await backendApi.importRows(table, rows, { expectedSchemaVersion: current.schemaVersion });
        const imported = Number.isSafeInteger(result?.rowCount) ? result.rowCount : count;
        // Same optimistic count discipline as Add Row: the delta is known, and
        // the demo-mode cache drops it again if triggers make it unreliable.
        if (isCurrentConnection(current)) noteRowCountChanged(table, imported);
        if (session === current) {
            closeModal(IMPORT_MODAL_ID, dialog.overlay);
            session = null;
        }
        const targetIsCurrent = isCurrentConnection(current)
            && state.selectedTable === table
            && state.selectedTableType === 'table';
        if (targetIsCurrent) await loadTableData();
        if (isCurrentConnection(current)) updateStatus(
            `Imported ${imported.toLocaleString('en-US')} row${imported === 1 ? '' : 's'} into ${table} `
            + `— one undoable edit, ${saveHint()}`
        );
    } catch (error) {
        console.error('Import failed:', error);
        // Nothing changed (the worker rolled every row back), so the modal
        // stays open for the user to adjust the mapping or pick another table.
        if (session === current && isCurrentConnection(current)) {
            updateStatus(`Import failed: ${describeImportFailure(error)}`);
            if (/schema changed.*preview/i.test(getErrorMessage(error))) {
                current.schemaVersion = null;
                dialog.notice.textContent = describeImportFailure(error);
                dialog.notice.classList.add('import-notice-error');
            }
        }
    } finally {
        current.submitting = false;
        if (session === current && dialog) setBusy(false);
    }
}

/**
 * Desktop entry wiring. `surface` is the host closure's error helper.
 */
export function initImportData(options = {}) {
    if (options.surface) surface = options.surface;
    const button = document.getElementById('btnImportData');
    if (button) {
        // Ships hidden in the shared template: VS Code and the web demo have no
        // shell to pick and read a file with, and neither runs this init.
        button.hidden = false;
        button.addEventListener('click', () => {
            openImportDialog().catch(surface('Import failed'));
        });
    }
}
