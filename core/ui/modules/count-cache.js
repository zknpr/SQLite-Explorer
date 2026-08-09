/**
 * Per-identity cache of grid row counts.
 *
 * Keyset pagination made page turns cheap, which left the COUNT(*) that
 * loadTableData ran before every data fetch as the dominant per-load cost
 * (hundreds of ms on huge tables, seconds under filters). This cache makes
 * repeat loads of the same count identity count-free and lets a miss fetch
 * count and data in parallel.
 *
 * An identity is "which COUNT(*) query would run": table + active column
 * filters + active global filter, plus the displayed column set — but only
 * while a global filter is active, because that predicate scans every
 * displayed column, so adding/dropping a column changes its result. Schema
 * changes therefore re-key global-filter identities automatically. Page size
 * and sort order never change a count and are deliberately not part of the
 * identity.
 *
 * Soundness model (within one webview session):
 * - VS Code webview row inserts/deletes adjust the UNFILTERED identity by their
 *   known delta and drop the table's filtered identities — a mutation's effect
 *   on a filtered count is unknowable webview-side. The demo drops every
 *   identity because it has no refresh echo and uploaded triggers can ignore a
 *   mutation or change cardinality by more than the requested row count.
 * - VS Code webview cell edits keep the unfiltered identity and drop the
 *   filtered ones; the host's post-edit refreshContent echo invalidates any
 *   trigger/cascade side effects. The demo has no echo, so it also drops the
 *   unfiltered identity: an uploaded database can already contain an UPDATE
 *   trigger that inserts or deletes rows.
 * - Anything that reloads because of external/unknown changes — table switch,
 *   refreshContent broadcasts (VS Code also echoes one after every local
 *   edit), reload-from-disk, view redefinition — invalidates wholesale.
 *   Table switches drop ALL tables, not just the target: views project other
 *   tables and triggers/cascades can fan a mutation out, so another object's
 *   cached count is only trusted while the selection cannot have observed
 *   such a change.
 * - In-flight fetches are epoch-gated: prepareCountStore() captures the cache
 *   epoch when the RPC is issued and refuses the store if any mutation or
 *   invalidation bumped it meanwhile — an ambiguous pre/post-mutation count
 *   must never be recorded as current truth.
 *
 * Module state only; deliberately NOT persisted with webview state. A
 * restored webview re-fetches counts (in parallel with its first data query).
 *
 * Residual staleness (accepted): on the native backend an external writer can
 * change the file at any time, but without file watching the whole grid is
 * equally stale until a reload and every reload path invalidates — the cache
 * adds no new staleness class there. A self-referential trigger or cascade
 * that inserts/deletes EXTRA rows in the mutated table itself skews a known
 * insert/delete delta until the next invalidation in VS Code; its post-edit
 * refreshContent echo corrects it almost immediately. Demo row mutations
 * never retain that delta.
 */

const UNFILTERED_SUB_KEY = '';

// Filtered identities accumulate as the user types (each debounced draft is
// its own identity), so bound them per table. The unfiltered identity is
// exempt: it is the high-value entry that keeps page turns count-free.
const MAX_FILTERED_IDENTITIES_PER_TABLE = 32;

// table name -> (identity sub-key -> count). Sub-key '' is the unfiltered
// identity; every other sub-key is the canonical JSON of its predicates.
const countsByTable = new Map();

// Bumped by every mutation/invalidation; gates stores of in-flight fetches.
let cacheEpoch = 0;

// The demo and VS Code webviews are separate bundles, so this module-local
// switch cannot leak between surfaces or alter the host cache contract.
let demoMode = false;

export function setCountCacheDemoMode(enabled) {
    demoMode = enabled === true;
}

/**
 * Build the cache identity for the exact inputs a fetchTableCount call would
 * carry, so a cached value is interchangeable with a fetch. `filters` must be
 * the active column filters ([{ column, value }]) and `globalFilter` the
 * active global filter (undefined when inactive), i.e. post-
 * getActiveFilterValue values — padded filter text stays significant, exactly
 * as the engine receives it.
 */
export function buildCountIdentity(table, filters, globalFilter, columnNames) {
    if (filters.length === 0 && globalFilter === undefined) {
        return { table, subKey: UNFILTERED_SUB_KEY };
    }
    // Canonical form: sort column filters by column name so the identity does
    // not depend on the order the user focused the inputs in.
    const sortedFilters = [...filters]
        .sort((a, b) => (a.column < b.column ? -1 : a.column > b.column ? 1 : 0))
        .map(filter => [filter.column, filter.value]);
    return {
        table,
        subKey: JSON.stringify({
            f: sortedFilters,
            g: globalFilter ?? null,
            c: globalFilter !== undefined ? columnNames : null
        })
    };
}

/** Cached count for the identity, or undefined. Refreshes LRU recency. */
export function getCachedCount(identity) {
    const tableCounts = countsByTable.get(identity.table);
    if (!tableCounts) return undefined;
    const count = tableCounts.get(identity.subKey);
    if (count !== undefined && identity.subKey !== UNFILTERED_SUB_KEY) {
        // Re-insert so Map order tracks recency and the cap evicts LRU-first.
        tableCounts.delete(identity.subKey);
        tableCounts.set(identity.subKey, count);
    }
    return count;
}

/**
 * Capture the cache epoch before a count RPC is issued. The returned function
 * stores the fetched value only if no mutation/invalidation happened while
 * the fetch was in flight; otherwise the value is ambiguous (it may or may
 * not include the concurrent change) and is dropped, leaving the next load to
 * fetch again.
 */
export function prepareCountStore(identity) {
    const epochAtRequest = cacheEpoch;
    return count => {
        if (cacheEpoch !== epochAtRequest) return false;
        let tableCounts = countsByTable.get(identity.table);
        if (!tableCounts) {
            tableCounts = new Map();
            countsByTable.set(identity.table, tableCounts);
        }
        if (identity.subKey !== UNFILTERED_SUB_KEY && !tableCounts.has(identity.subKey)) {
            const filteredEntries = tableCounts.size
                - (tableCounts.has(UNFILTERED_SUB_KEY) ? 1 : 0);
            if (filteredEntries >= MAX_FILTERED_IDENTITIES_PER_TABLE) {
                for (const key of tableCounts.keys()) {
                    if (key !== UNFILTERED_SUB_KEY) {
                        tableCounts.delete(key);
                        break;
                    }
                }
            }
        }
        tableCounts.set(identity.subKey, count);
        return true;
    };
}

/**
 * A webview-initiated insert/delete changed `table`'s row count by a known
 * signed `delta`. Call it only after the engine confirmed the mutation.
 */
export function noteRowCountChanged(table, delta) {
    cacheEpoch++;
    const tableCounts = countsByTable.get(table);
    if (!tableCounts) return;
    const unfiltered = tableCounts.get(UNFILTERED_SUB_KEY);
    // The delta only holds for the unfiltered identity — how many of the
    // affected rows each filter matches is unknowable here — so filtered
    // identities are dropped rather than adjusted.
    tableCounts.clear();
    if (!demoMode && unfiltered !== undefined) {
        tableCounts.set(UNFILTERED_SUB_KEY, Math.max(0, unfiltered + delta));
    }
}

/**
 * A webview-initiated cell edit in `table`: the row count is unchanged, but
 * the edited value may have entered or left a filter's match set.
 */
export function noteCellValuesChanged(table) {
    cacheEpoch++;
    const tableCounts = countsByTable.get(table);
    if (!tableCounts) return;
    const unfiltered = tableCounts.get(UNFILTERED_SUB_KEY);
    tableCounts.clear();
    if (!demoMode && unfiltered !== undefined) {
        tableCounts.set(UNFILTERED_SUB_KEY, unfiltered);
    }
}

/** Drop every identity of one table/view (e.g. its definition changed). */
export function invalidateTableCounts(table) {
    cacheEpoch++;
    countsByTable.delete(table);
}

/**
 * Drop everything: table switch, refreshContent broadcast, reload-from-disk —
 * any reload prompted by changes this webview cannot account for.
 */
export function invalidateAllCounts() {
    cacheEpoch++;
    countsByTable.clear();
}
