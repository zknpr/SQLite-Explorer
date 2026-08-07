import { state } from './state.js';
import { backendApi } from './api.js';
import { updateStatus, showLoading, showErrorState, updateToolbarButtons } from './ui.js';
import { updatePagination, renderDataGrid } from './grid-render.js';
// Closes a module cycle (grid-selection → sidebar → grid.js → here), which is
// safe because the binding is a hoisted function declaration only called at
// runtime — the same shape grid-actions.js already relies on.
import { clearCellSelection } from './grid-selection.js';
import { resetMatchNav } from './match-nav.js';
import { getActiveFilterValue } from '../../../src/core/filter-utils.ts';

export async function loadTableColumns() {
    if (!state.selectedTable) return;

    try {
        const columns = await backendApi.getTableInfo(state.selectedTable);
        state.tableColumns = columns.map(r => ({
            cid: r.ordinal,
            name: r.identifier,
            type: r.declaredType,
            notnull: r.isRequired,
            dflt_value: r.defaultExpression,
            isPrimaryKey: r.primaryKeyPosition > 0
        })).sort((a, b) => a.cid - b.cid);

        // Sanitize state based on new columns
        const colNames = new Set(state.tableColumns.map(c => c.name));

        // 1. Reset sort if column is gone
        if (state.sortedColumn && !colNames.has(state.sortedColumn)) {
            state.sortedColumn = null;
            state.sortAscending = true;
        }

        // 2. Clear filters for deleted columns
        for (const col of Object.keys(state.columnFilters)) {
            if (!colNames.has(col)) {
                delete state.columnFilters[col];
            }
        }

        // 3. Drop shift-range anchors: they index the previous column set (and
        // the page rendered against it), so they must not seed a range here even
        // if the follow-up data reload fails before its own anchor reset.
        state.lastSelectedCell = null;
        state.lastSelectedColumnIndex = null;
        state.lastSelectedRowIndex = null;

        // 4. Drop the staged cell selection for the same reason: its colIdx
        // indexes the previous column set, so a batch Apply after this commit
        // would write whichever column now sits at that index. Table switches
        // clear it upstream, but same-table schema reloads (undo/redo
        // broadcasts, reload-from-disk) reach here with it still staged.
        clearCellSelection();
    } catch (err) {
        console.error('Error loading columns:', err);
        updateStatus('Error loading columns');
    }
}

// Monotonic token identifying the most recent loadTableData() call. Concurrent
// loads (e.g. a slow fetch followed by a filter/sort/page change or a table
// switch, triggered via toolbar controls the grid guard doesn't cover) compare
// this after each await and bail if a newer load has started — so a superseded
// request never writes state, renders stale rows, shows a stale error, or clears
// the loading flag out from under the in-flight one.
let activeLoadToken = 0;
let activeLoadStartedAt = 0;

/**
 * Identify the request that currently owns the interaction guard. Filter input
 * retries use this to give each superseding load its own wait deadline.
 */
export function getGridReloadOwner() {
    if (!state.isGridReloading) return null;
    return { token: activeLoadToken, startedAt: activeLoadStartedAt };
}

/**
 * Build the keyset (seek) request for this load, or undefined for the plain
 * OFFSET query. `nav` is the page's relationship to the committed grid
 * ('first'/'next'/'prev'/'last' from the nav buttons, 'refetch' otherwise).
 * Anchors are only usable when they describe the exact page the intent
 * expects for this table — a clamped index after a shrunken count, a table
 * switch, or a rapid double-click whose first load never committed all fail
 * these checks and fall back to OFFSET. The engine independently re-validates
 * the anchor's embedded query tag, so sort/filter/page-size staleness needs no
 * tracking here.
 */
function buildKeysetRequest(nav, pageIndex, pageCount, recordCount, table) {
    // Page 0 needs no anchor and no OFFSET scan; covers 'first', 'prev' to 0,
    // any refetch at 0, and single-page tables.
    if (pageIndex === 0) return { mode: 'first' };
    const anchors = state.keysetAnchors;
    const usable = anchors && anchors.table === table;
    if (nav === 'next' && usable && anchors.pageIndex === pageIndex - 1 && anchors.last) {
        return { mode: 'after', anchor: anchors.last };
    }
    if (nav === 'prev' && usable && anchors.pageIndex === pageIndex + 1 && anchors.first) {
        return { mode: 'before', anchor: anchors.first };
    }
    if (nav === 'last' && pageIndex === pageCount - 1) {
        // The reversed query must return the same short remainder page as
        // OFFSET so the page phase never shifts; computed from the count
        // fetched moments ago in this same load.
        return { mode: 'last', lastPageRowCount: recordCount - pageIndex * state.rowsPerPage };
    }
    if (nav === 'refetch' && usable && anchors.pageIndex === pageIndex && anchors.first) {
        return { mode: 'atOrAfter', anchor: anchors.first };
    }
    return undefined;
}

/**
 * True when a keyset page disagrees with the count fetched in the same load —
 * rows past the anchor were deleted (or filtered away) since it was minted.
 * The caller re-runs the load once with the OFFSET query, which both restores
 * today's exact behavior for the race and re-anchors from its result. 'first'
 * and 'last' are self-consistent and never retried.
 */
function keysetResultNeedsOffsetRetry(keyset, dataResult, recordCount, pageIndex) {
    if (keyset.mode === 'first' || keyset.mode === 'last') return false;
    const rowCount = (dataResult.rows || []).length;
    const expectedRows = recordCount - pageIndex * state.rowsPerPage;
    if (rowCount === 0) return expectedRows > 0;
    // 'before' targets an interior page, which the fresh count says is full; a
    // short result would shift the page phase, so prefer the OFFSET truth.
    if (keyset.mode === 'before') return rowCount < Math.min(state.rowsPerPage, expectedRows);
    return false;
}

export async function loadTableData(showSpinner = true, saveScrollPosition = true, navIntent) {
    if (!state.selectedTable) return;

    const loadToken = ++activeLoadToken;
    activeLoadStartedAt = Date.now();
    // Snapshot the target table/type for the whole request so an in-flight load
    // can't pair this table's columns with a table the user switched to mid-fetch
    // (which would SELECT the old columns against the new table and error out).
    const requestedTable = state.selectedTable;
    const requestedTableType = state.selectedTableType;
    const requestedFilterQuery = state.filterQuery;
    const requestedColumnFilters = { ...state.columnFilters };
    let keepExistingGridOnError = false;
    state.lastGridLoadError = null;
    // This load is superseded if a newer load has started (token bumped) OR the
    // user has navigated to a different table. The selection check matters because
    // a table switch changes state.selectedTable synchronously but only starts its
    // own load (bumping the token) after awaiting loadTableColumns(); during that
    // gap the old load still owns the token, so a token-only check would let it
    // render the old table's rows under the new selection and clear the flag.
    const isSuperseded = () => loadToken !== activeLoadToken || requestedTable !== state.selectedTable;

    try {
        // The guard and every synchronous setup step it protects belong inside
        // this try: DOM access/rendering can throw before the first fetch, and the
        // finally below must still release both loading flags on that path.
        state.isGridReloading = true;
        // Same-table refreshes deliberately keep the old grid visible. Filter
        // input handlers synchronously copy every live draft to state, so the
        // eventual header rebuild preserves text typed during this fetch.

        const container = document.getElementById('gridContainer');
        // Whether a data grid is currently rendered (vs. a spinner/error/empty state),
        // AND whether it belongs to the table we're loading. The renderedTable check is
        // what separates a same-table refetch (filter/sort/page — keep the grid, no
        // flicker) from a table switch, where the previous table's grid is still in the
        // DOM and must not be left on screen. Cached once instead of re-querying below.
        const hasRenderedGrid = !!(container && container.querySelector('.data-grid'));
        const isSameTableGrid = hasRenderedGrid && state.renderedTable === state.selectedTable;
        keepExistingGridOnError = !showSpinner && isSameTableGrid;

        // Only capture scroll position if the current table's grid is visible (not a
        // loading/error state, and not a different table's grid mid-switch). This
        // prevents overwriting the saved position with 0 while a spinner is shown.
        if (saveScrollPosition && isSameTableGrid) {
            state.scrollPosition.left = container.scrollLeft;
            state.scrollPosition.top = container.scrollTop;
        }

        if (showSpinner) {
            state.isLoadingData = true;
            // Keep the existing grid visible during a same-table refetch (prevents
            // flicker); show the spinner on a true first load or a table switch, where
            // nothing valid for this table is on screen yet.
            if (!isSameTableGrid) {
                showLoading();
            }
        }

        updateToolbarButtons();

        // Build query options
        const filters = [];
        // Column filters
        for (const [colName, filterValue] of Object.entries(requestedColumnFilters)) {
            const activeFilterValue = getActiveFilterValue(filterValue);
            if (activeFilterValue !== undefined) {
                filters.push({ column: colName, value: activeFilterValue });
            }
        }

        const globalFilter = getActiveFilterValue(requestedFilterQuery);

        // Column names are needed both for the global-filter count and the data query.
        const columnNames = state.tableColumns.map(c => c.name);

        const countOptions = {
            filters,
            globalFilter,
            columns: columnNames,
            // Keep count predicates tied to the displayed schema even when
            // identity-only fields are added to a SELECT request.
            globalFilterColumns: columnNames
        };

        // Get total count
        const totalRecordCount = await backendApi.fetchTableCount(requestedTable, countOptions);
        if (isSuperseded()) return; // a newer load started, or the user switched tables
        const totalPageCount = Math.max(1, Math.ceil(totalRecordCount / state.rowsPerPage));
        let currentPageIndex = state.currentPageIndex;

        if (currentPageIndex >= totalPageCount) {
            currentPageIndex = Math.max(0, totalPageCount - 1);
        }

        // Get data
        const isTable = requestedTableType === 'table';

        // For tables, we need to explicitly request the 'rowid' column to handle row identification.
        // The frontend expects rowid at index 0 for tables (see `getRowId` and `getRowDataOffset`).
        // Query builder handles the construction: SELECT "rowid", "col1", ...
        const queryColumns = isTable ? ['rowid', ...columnNames] : columnNames;

        const queryOptions = {
            columns: queryColumns,
            // rowid stays in SELECT for table identity, but users filter only
            // the displayed schema columns scanned by match navigation.
            globalFilterColumns: columnNames,
            orderBy: state.sortedColumn,
            orderDir: state.sortAscending ? 'ASC' : 'DESC',
            limit: state.rowsPerPage,
            offset: currentPageIndex * state.rowsPerPage,
            filters,
            globalFilter
        };

        // OFFSET always stays in the request: it is the engine's validated
        // fallback whenever the keyset request does not hold up.
        const keyset = isTable
            ? buildKeysetRequest(
                navIntent ?? 'refetch',
                currentPageIndex,
                totalPageCount,
                totalRecordCount,
                requestedTable
              )
            : undefined;
        if (keyset) queryOptions.keyset = keyset;

        let dataResult = await backendApi.fetchTableData(requestedTable, queryOptions);
        if (isSuperseded()) return; // superseded (newer load or table switch) during the fetch
        if (keyset && keysetResultNeedsOffsetRetry(keyset, dataResult, totalRecordCount, currentPageIndex)) {
            // Concurrent writes invalidated the anchor's position. One retry
            // with the plain OFFSET query (identical to the pre-keyset SQL)
            // restores today's behavior and re-anchors from its result.
            delete queryOptions.keyset;
            dataResult = await backendApi.fetchTableData(requestedTable, queryOptions);
            if (isSuperseded()) return;
        }

        // Commit count, page, rows, and their filter identity together. A data
        // query failure therefore leaves the prior successful grid coherent.
        state.totalRecordCount = totalRecordCount;
        state.totalPageCount = totalPageCount;
        state.currentPageIndex = currentPageIndex;
        state.gridData = dataResult.rows || [];
        state.gridExactIntegerTexts = dataResult.exactIntegerTexts || {};
        state.gridOversizedCells = dataResult.oversizedCells || {};
        state.gridReadOnlyRowReasons = dataResult.readOnlyRowReasons || {};
        // Anchors commit atomically with the rows they describe; a superseded
        // load bailed above, so its anchors can never survive into state. On
        // error paths the previous grid stays mounted together with the
        // anchors that still describe it. Views/keyless objects store nulls.
        state.keysetAnchors = {
            table: requestedTable,
            pageIndex: currentPageIndex,
            first: dataResult.keysetAnchors?.first ?? null,
            last: dataResult.keysetAnchors?.last ?? null
        };
        state.lastSuccessfulFilterState = {
            table: requestedTable,
            filterQuery: requestedFilterQuery,
            columnFilters: requestedColumnFilters
        };
        state.lastGridLoadError = null;
        // Shift-range anchors are indices into the rows/columns just replaced;
        // a stale anchor would make the next shift-click select the wrong block
        // of rows, or read past the new page's bounds.
        state.lastSelectedCell = null;
        state.lastSelectedColumnIndex = null;
        state.lastSelectedRowIndex = null;
        // The staged cell selection is index-bearing in the same way, so it
        // must not survive the commit either. Flows that need a selection
        // across a reload rebuild it by identity afterwards (applyBatchUpdate).
        clearCellSelection();
        resetMatchNav();

        // When preserving scroll, re-capture the latest position right before
        // rendering. Covers the user scrolling during the fetch — including a
        // flicker-free refetch where the spinner was suppressed and the grid stayed
        // interactive — and edit operations that restored scroll while the fetch was
        // pending. Gated on saveScrollPosition (not !showSpinner) so callers that
        // intentionally reset scroll (page change, table switch) aren't clobbered.
        // Re-check the DOM here (not the cached flag): this runs after the await,
        // so the rendered state may differ from when the function started.
        if (saveScrollPosition && container && container.querySelector('.data-grid')) {
            state.scrollPosition.left = container.scrollLeft;
            state.scrollPosition.top = container.scrollTop;
        }

        // Optimization: If editing, skip render to avoid destroying the active editor
        if (!showSpinner && state.editingCellInfo) {
            // We updated gridData, so the data is fresh.
            // We skip the DOM update to keep the <textarea> alive.
            // updateCellDom in edit.js handles the visual update of the modified cell.
        } else {
            renderDataGrid(state.scrollPosition.top, state.scrollPosition.left);
            // The on-screen grid now reflects this table; remember it so the next
            // load can distinguish a same-table refetch from a table switch.
            state.renderedTable = requestedTable;
        }

        if (container) {
            container.scrollLeft = state.scrollPosition.left;
            container.scrollTop = state.scrollPosition.top;
        }

        updatePagination();
        updateStatus(`${state.totalRecordCount} records`);
        return true; // signals callers (e.g. filter submit) that the load applied

    } catch (err) {
        console.error('Error loading data:', err);
        // Don't let a superseded load's error replace the current table's view.
        if (!isSuperseded()) {
            const message = err instanceof Error ? err.message : String(err);
            state.lastGridLoadError = message;
            updateStatus(`Error: ${message}`);
            // Background filters retain the last successful grid so the UI can
            // roll back atomically instead of replacing it with an error panel.
            if (!keepExistingGridOnError) showErrorState(message);
            return false; // the current load genuinely failed (lets callers retry)
        }
        // Superseded failure: a newer load owns the outcome — return undefined.
    } finally {
        // Both flags belong to the latest request. In particular, a background
        // load may supersede a foreground spinner load; although it did not set
        // isLoadingData itself, it inherits responsibility for releasing that flag.
        // Clearing selection (for example after dropping the displayed view)
        // supersedes this request without starting another load. In that case the
        // latest token still owns the guards and must release them itself.
        const latestLoadHasNoTarget = loadToken === activeLoadToken && !state.selectedTable;
        if (!isSuperseded() || latestLoadHasNoTarget) {
            state.isLoadingData = false;
            state.isGridReloading = false;
            updateToolbarButtons();
        }
    }
}
