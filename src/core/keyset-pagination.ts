/**
 * Keyset (Seek) Pagination
 *
 * Replaces deep LIMIT/OFFSET page fetches with anchor predicates that seek the
 * rowid/PRIMARY KEY B-tree directly, so a page turn near the end of a 100M-row
 * table costs the same as the first page.
 *
 * Trust model: anchors are minted by an engine, stored opaquely by the
 * (untrusted, post-XSS containment stance) webview, and returned verbatim.
 * Every received anchor is strictly decoded with a canonical re-encode check
 * (the decodePrimaryKeyRecordId pattern), its embedded query-identity tag is
 * compared against the live request, and all key values are bound as SQL
 * parameters. A stale-but-well-formed anchor degrades to the unchanged
 * LIMIT/OFFSET query; a malformed one is rejected loudly.
 */
import { escapeIdentifier } from './sql-utils';
import { getActiveFilterValue } from './filter-utils';
import {
  encodePrimaryKeyValue,
  decodePrimaryKeyValue,
  type EncodedPrimaryKeyValue
} from './row-identity';
import type {
  CellValue,
  KeysetAnchorSet,
  KeysetNavigationMode,
  KeysetPaginationRequest,
  OversizedCellMap,
  TableIdentity,
  TableQueryOptions
} from './types';

const KEYSET_ANCHOR_PREFIX = 'ksa:';
const KEYSET_ANCHOR_VERSION = 1;
const KEYSET_MODES: readonly KeysetNavigationMode[] =
  ['first', 'after', 'atOrAfter', 'before', 'last'];

/** NULL is representable only in the sort slot; identity columns are never NULL. */
type EncodedKeysetValue = EncodedPrimaryKeyValue | ['null'];

/** SQLite storage class of one decoded anchor value slot. */
export type KeysetAnchorValueClass = 'integer' | 'real' | 'text' | 'blob' | 'null';

interface KeysetAnchorPayload {
  v: 1;
  /** Query-identity tag the anchor was minted under. */
  t: string;
  /** Key values aligned with the key columns of that query identity. */
  k: EncodedKeysetValue[];
}

/** The total order a keyset session pages over: optional sort column + identity. */
export interface KeysetKey {
  /** Full ORDER BY key; when sorted, the sort column first, then identity columns. */
  keyColumns: string[];
  /**
   * True when keyColumns[0] is a plain (nullable, non-unique) sort column, so
   * seek predicates must decompose around SQLite's NULLS-first-ASC/last-DESC
   * placement; identity-only keys are NOT NULL and unique by construction.
   */
  nullableSortKey: boolean;
  direction: 'ASC' | 'DESC';
}

/** Validated, engine-resolved plan consumed by the SQL assembly. */
export interface ResolvedKeysetPlan extends KeysetKey {
  mode: KeysetNavigationMode;
  /** Anchor key values (after/atOrAfter/before); bound as parameters. */
  values?: CellValue[];
  /**
   * Storage class per anchor value slot, aligned with `values`. INTEGER slots
   * bind through CAST(? AS INTEGER): int64 values beyond 2^53 decode to
   * decimal strings (validateRowId), and a raw TEXT bind would rely on column
   * affinity — absent on a NONE-affinity sort column, where TEXT never
   * compares equal-class with INTEGER storage and the seek silently misses.
   * Absent (all-plain '?') only for hand-built plans without decoded anchors.
   */
  valueClasses?: KeysetAnchorValueClass[];
  /** Effective LIMIT: the page size, or the remainder row count for 'last'. */
  limit: number;
}

/**
 * Canonical identity of a grid query for anchor validity: everything that
 * determines row membership and order, and the page size that phases pages.
 * Projection and byte-budget fields are deliberately excluded. Compared only
 * within one engine instance, so it just has to be internally deterministic.
 */
export function computeKeysetQueryTag(table: string, options: TableQueryOptions): string {
  const activeFilters = (options.filters ?? []).flatMap(filter => {
    const value = getActiveFilterValue(filter.value);
    return value === undefined ? [] : [[filter.column, value]];
  });
  const globalFilter = getActiveFilterValue(options.globalFilter) ?? null;
  // The searched column set only matters while a global filter is active;
  // including it otherwise would force spurious OFFSET fallbacks on unrelated
  // schema changes.
  const globalFilterColumns = globalFilter === null
    ? null
    : options.globalFilterColumns ?? options.columns ?? null;
  const orderBy = typeof options.orderBy === 'string' && options.orderBy !== ''
    ? options.orderBy
    : null;
  const direction = orderBy !== null && options.orderDir === 'DESC' ? 'DESC' : 'ASC';
  const limit = typeof options.limit === 'number' && Number.isSafeInteger(options.limit)
    ? options.limit
    : null;
  return JSON.stringify([
    KEYSET_ANCHOR_VERSION,
    table,
    orderBy,
    direction,
    limit,
    activeFilters,
    globalFilter,
    globalFilterColumns
  ]);
}

/**
 * Derive the seek key for a query, or undefined when no total order can be
 * guaranteed. `identity` must already be authoritative for seeking: callers
 * pass a rowid identity only after ROWID_TABLE_AUTHORITY_SQL confirmed the
 * intrinsic rowid is not shadowed by a declared column (a shadowed "rowid"
 * would be nullable, non-unique table data — silently wrong pagination).
 */
export function computeKeysetKey(
  options: TableQueryOptions,
  identity: TableIdentity | undefined
): KeysetKey | undefined {
  if (!identity) return undefined;
  // An external caller supplying its own multi-column ordering contract is not
  // a grid query; its display order is unknown here.
  if (options.orderByColumns?.length) return undefined;

  const identityColumns = identity.kind === 'rowid'
    ? ['rowid']
    : identity.columns.map(column => column.identifier);
  if (identityColumns.length === 0) return undefined;

  const orderBy = typeof options.orderBy === 'string' && options.orderBy !== ''
    ? options.orderBy
    : undefined;
  // Unsorted grids display B-tree scan order, which equals rowid/PK order;
  // orderDir is meaningless without a sort column.
  if (orderBy === undefined) {
    return { keyColumns: identityColumns, nullableSortKey: false, direction: 'ASC' };
  }

  const direction = options.orderDir === 'DESC' ? 'DESC' : 'ASC';
  // ORDER BY rowid is identity order on rowid tables, and the engines rewrite
  // it to full PK order on WITHOUT ROWID tables.
  if (orderBy.toLowerCase() === 'rowid') {
    return { keyColumns: identityColumns, nullableSortKey: false, direction };
  }
  // Sorting by an identity member keeps the key NOT NULL and unique; dedupe so
  // ORDER BY stays satisfiable by the PK index without repeated terms.
  if (identityColumns.includes(orderBy)) {
    return {
      keyColumns: [orderBy, ...identityColumns.filter(column => column !== orderBy)],
      nullableSortKey: false,
      direction
    };
  }
  return {
    keyColumns: [orderBy, ...identityColumns],
    nullableSortKey: true,
    direction
  };
}

/**
 * Deterministic ORDER BY for the OFFSET/fallback page of an anchorable query.
 *
 * Keyset SQL orders by the full key (sort column, then identity) in one
 * uniform direction; a bare `ORDER BY sortColumn` leaves SQLite's tie order
 * plan-dependent (the unindexed sorter emits ties identity-ASC even under
 * DESC, an index scan emits identity-DESC), and an unsorted fetch is
 * scan-ordered. The grid treats OFFSET and keyset pages as one
 * phase-continuous sequence and re-anchors from OFFSET pages, so both paths
 * must produce the SAME total order: whenever a key was derived and no seek
 * plan consumed it, the fallback SELECT adopts the full key columns in the
 * key direction through the ordinary orderByColumns machinery.
 *
 * Undefined when no key exists (views, keyless objects, shadowed rowid,
 * external orderByColumns callers — their SQL stays byte-identical to the
 * pre-keyset shape) and when a plan exists (keyset SQL owns its ORDER BY).
 * Callers must derive `key` from the same authority answer that gates
 * minting, so a shadowed rowid never reaches this ordering.
 */
export function keysetFallbackOrder(
  key: KeysetKey | undefined,
  plan: ResolvedKeysetPlan | undefined
): { orderByColumns: string[]; orderDir: 'ASC' | 'DESC' } | undefined {
  if (!key || plan) return undefined;
  return { orderByColumns: key.keyColumns, orderDir: key.direction };
}

function encodeKeysetValue(value: CellValue | bigint): EncodedKeysetValue {
  return value === null ? ['null'] : encodePrimaryKeyValue(value);
}

function decodeKeysetValue(
  encoded: unknown
): { value: CellValue; storageClass: KeysetAnchorValueClass } {
  if (Array.isArray(encoded) && encoded.length === 1 && encoded[0] === 'null') {
    return { value: null, storageClass: 'null' };
  }
  const value = decodePrimaryKeyValue(encoded);
  // decodePrimaryKeyValue accepted the pair, so encoded[0] is a known class.
  return { value, storageClass: (encoded as EncodedPrimaryKeyValue)[0] };
}

/** Encode a canonical, RPC-safe opaque anchor token for one boundary row. */
export function encodeKeysetAnchor(
  tag: string,
  values: readonly (CellValue | bigint)[]
): string {
  if (values.length === 0) throw new Error('Keyset anchor requires at least one key value');
  const payload: KeysetAnchorPayload = {
    v: KEYSET_ANCHOR_VERSION,
    t: tag,
    k: values.map(encodeKeysetValue)
  };
  return KEYSET_ANCHOR_PREFIX + encodeURIComponent(JSON.stringify(payload));
}

/** Decode and strictly validate an anchor token received from the webview. */
export function decodeKeysetAnchor(anchor: unknown): {
  tag: string;
  values: CellValue[];
  valueClasses: KeysetAnchorValueClass[];
} {
  if (typeof anchor !== 'string' || !anchor.startsWith(KEYSET_ANCHOR_PREFIX)) {
    throw new Error('Invalid keyset anchor');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(decodeURIComponent(anchor.slice(KEYSET_ANCHOR_PREFIX.length)));
  } catch {
    throw new Error('Invalid keyset anchor encoding');
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 3 ||
    (payload as { v?: unknown }).v !== KEYSET_ANCHOR_VERSION ||
    typeof (payload as { t?: unknown }).t !== 'string' ||
    !Array.isArray((payload as { k?: unknown }).k)
  ) {
    throw new Error('Invalid keyset anchor payload');
  }
  const encodedValues = (payload as KeysetAnchorPayload).k;
  if (encodedValues.length === 0) throw new Error('Keyset anchor has no key values');
  let values: CellValue[];
  let valueClasses: KeysetAnchorValueClass[];
  try {
    const decodedValues = encodedValues.map(decodeKeysetValue);
    values = decodedValues.map(decoded => decoded.value);
    valueClasses = decodedValues.map(decoded => decoded.storageClass);
  } catch (err) {
    throw new Error(`Invalid keyset anchor value: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Rebuild the payload in mint order rather than re-serializing the parsed
  // object, so key-permuted alternates of one logical anchor are rejected too.
  const canonical = KEYSET_ANCHOR_PREFIX + encodeURIComponent(JSON.stringify({
    v: KEYSET_ANCHOR_VERSION,
    t: (payload as KeysetAnchorPayload).t,
    k: encodedValues
  }));
  if (canonical !== anchor) throw new Error('Keyset anchor is not canonical');
  return { tag: (payload as KeysetAnchorPayload).t, values, valueClasses };
}

/**
 * Validate a webview keyset request against the live query identity and
 * resolve it into an executable plan.
 *
 * Returns undefined — the caller falls back to the unchanged LIMIT/OFFSET
 * query — for every legitimate staleness signal: no request, non-anchorable
 * object, missing/invalid page size, tag mismatch (sort/filter/table/page-size
 * changed since minting), key arity mismatch (schema changed under a matching
 * tag), or an out-of-range 'last' remainder. Structurally malformed or
 * unmintable tokens (bad encoding, NULL in an identity slot) throw instead:
 * engines never mint them, so they signal tampering, not staleness.
 */
export function resolveKeysetPlan(
  table: string,
  options: TableQueryOptions,
  identity: TableIdentity | undefined
): ResolvedKeysetPlan | undefined {
  const request: KeysetPaginationRequest | undefined = options.keyset;
  if (!request || typeof request !== 'object' || Array.isArray(request)) return undefined;
  if (!KEYSET_MODES.includes(request.mode)) return undefined;

  const key = computeKeysetKey(options, identity);
  if (!key) return undefined;
  const limit = typeof options.limit === 'number'
    && Number.isSafeInteger(options.limit) && options.limit > 0
    ? options.limit
    : undefined;
  if (limit === undefined) return undefined;

  if (request.mode === 'first') {
    return { ...key, mode: 'first', limit };
  }
  if (request.mode === 'last') {
    const remainder = request.lastPageRowCount;
    if (
      typeof remainder !== 'number' || !Number.isSafeInteger(remainder)
      || remainder < 1 || remainder > limit
    ) {
      return undefined;
    }
    return { ...key, mode: 'last', limit: remainder };
  }

  if (request.anchor === undefined) return undefined;
  const decoded = decodeKeysetAnchor(request.anchor);
  if (decoded.tag !== computeKeysetQueryTag(table, options)) return undefined;
  if (decoded.values.length !== key.keyColumns.length) return undefined;
  const firstIdentitySlot = key.nullableSortKey ? 1 : 0;
  if (decoded.values.some((value, index) => value === null && index >= firstIdentitySlot)) {
    // Never minted: identity columns are NOT NULL, so a null here is forged.
    throw new Error('Keyset anchor has NULL in an identity slot');
  }
  return {
    ...key,
    mode: request.mode,
    values: decoded.values,
    valueClasses: decoded.valueClasses,
    limit
  };
}

function tupleCompare(
  escapedColumns: string[],
  operator: string,
  placeholders: string[]
): string {
  return escapedColumns.length === 1
    ? `${escapedColumns[0]} ${operator} ${placeholders[0]}`
    : `(${escapedColumns.join(', ')}) ${operator} (${placeholders.join(', ')})`;
}

/**
 * Build the seek predicate for a plan carrying anchor values.
 *
 * 'before' executes in the reversed direction (rows are re-reversed by the
 * outer SELECT), so its predicate is "after the anchor" along the reversed
 * order, exclusive. Row-value comparators evaluate to NULL when the sort cell
 * is NULL, so the NULL run — first in ASC, last in DESC — is handled by
 * explicit IS NULL / IS NOT NULL terms on both sides of the anchor.
 *
 * INTEGER-class slots bind through CAST(? AS INTEGER): SQLite parses a
 * decimal-string bind to its exact int64 (the decoder range-checked it), so
 * values beyond 2^53 seek correctly even on NONE-affinity columns where a
 * raw TEXT bind would never compare equal-class with INTEGER storage.
 */
function buildKeysetPredicate(plan: ResolvedKeysetPlan): { sql: string; params: CellValue[] } {
  const values = plan.values!;
  const reversed = plan.mode === 'before';
  const executionDirection = reversed
    ? (plan.direction === 'ASC' ? 'DESC' : 'ASC')
    : plan.direction;
  const operator = (executionDirection === 'ASC' ? '>' : '<')
    + (plan.mode === 'atOrAfter' ? '=' : '');
  const escapedColumns = plan.keyColumns.map(escapeIdentifier);
  const placeholders = plan.keyColumns.map((_, slot) =>
    plan.valueClasses?.[slot] === 'integer' ? 'CAST(? AS INTEGER)' : '?'
  );

  if (!plan.nullableSortKey) {
    return { sql: tupleCompare(escapedColumns, operator, placeholders), params: values };
  }

  const sortColumn = escapedColumns[0];
  const identityColumns = escapedColumns.slice(1);
  const sortValue = values[0];
  const identityValues = values.slice(1);
  if (sortValue === null) {
    const identityCompare = tupleCompare(identityColumns, operator, placeholders.slice(1));
    // Seeking forward from inside the NULL run: in ASC, every non-NULL row
    // still lies ahead; in DESC, only the rest of the NULL run does.
    return executionDirection === 'ASC'
      ? {
          sql: `((${sortColumn} IS NULL AND ${identityCompare}) OR ${sortColumn} IS NOT NULL)`,
          params: identityValues
        }
      : {
          sql: `(${sortColumn} IS NULL AND ${identityCompare})`,
          params: identityValues
        };
  }
  const rowValueCompare = tupleCompare(escapedColumns, operator, placeholders);
  // Seeking forward from a non-NULL anchor: the NULL run lies ahead only in
  // DESC execution (NULLs sort last there).
  return executionDirection === 'ASC'
    ? { sql: rowValueCompare, params: values }
    : { sql: `(${rowValueCompare} OR ${sortColumn} IS NULL)`, params: values };
}

/**
 * Assemble the complete keyset SELECT from the caller's projection and filter
 * clauses. The predicate lands inside this WHERE, so the containment and
 * exact-numeric wrappers compose around the result unchanged. 'before' and
 * 'last' run reversed with a bounded (≤ one page) outer re-sort back to
 * display order, keeping every row-indexed sidecar aligned downstream.
 */
export function assembleKeysetSelect(input: {
  selectListSql: string;
  escapedTable: string;
  whereClauses: readonly string[];
  filterParams: readonly CellValue[];
  plan: ResolvedKeysetPlan;
}): { sql: string; params: CellValue[] } {
  const { plan } = input;
  const reversedExecution = plan.mode === 'before' || plan.mode === 'last';
  const executionDirection = reversedExecution
    ? (plan.direction === 'ASC' ? 'DESC' : 'ASC')
    : plan.direction;

  const whereClauses = [...input.whereClauses];
  const params: CellValue[] = [...input.filterParams];
  if (plan.mode !== 'first' && plan.mode !== 'last') {
    const predicate = buildKeysetPredicate(plan);
    whereClauses.push(predicate.sql);
    params.push(...predicate.params);
  }

  const escapedKeyColumns = plan.keyColumns.map(escapeIdentifier);
  const orderBySql = (direction: 'ASC' | 'DESC') =>
    escapedKeyColumns.map(column => `${column} ${direction}`).join(', ');

  let sql = `SELECT ${input.selectListSql} FROM ${input.escapedTable}`;
  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(' AND ')}`;
  }
  sql += ` ORDER BY ${orderBySql(executionDirection)} LIMIT ${plan.limit}`;
  if (reversedExecution) {
    sql = `SELECT * FROM (${sql}) ORDER BY ${orderBySql(plan.direction)}`;
  }
  return { sql, params };
}

/**
 * Mint the first/last anchors for a fetched page from its source rows (exact,
 * BigInt-preserving values in display order). Rows whose key cells cannot be
 * reproduced faithfully — containment-clipped TEXT/BLOB previews, non-finite
 * REALs, NULL identity cells — yield no anchor for that side, so navigation
 * from them degrades to the OFFSET fallback instead of seeking a wrong key.
 */
export function mintKeysetAnchors(input: {
  tag: string;
  key: KeysetKey;
  /** Result projection naming each source-row slot, e.g. ['rowid', ...visible]. */
  projectionColumns: readonly string[];
  /** Source rows in display order, before transport normalization. */
  rows: readonly (readonly (CellValue | bigint)[])[];
  /** Source-column-indexed clipping metadata for this page, when any. */
  oversizedCells?: OversizedCellMap;
}): KeysetAnchorSet | undefined {
  if (input.rows.length === 0) return undefined;
  const keyIndices = input.key.keyColumns.map(column =>
    input.projectionColumns.indexOf(column)
  );
  if (keyIndices.some(index => index < 0)) return undefined;

  const mintRow = (rowIndex: number): string | undefined => {
    const row = input.rows[rowIndex];
    const values: (CellValue | bigint)[] = [];
    for (let slot = 0; slot < keyIndices.length; slot++) {
      const columnIndex = keyIndices[slot];
      if (input.oversizedCells?.[rowIndex]?.[columnIndex]) return undefined;
      const value = row[columnIndex];
      if (value === undefined) return undefined;
      if (value === null && !(slot === 0 && input.key.nullableSortKey)) return undefined;
      if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
      values.push(value);
    }
    return encodeKeysetAnchor(input.tag, values);
  };

  const first = mintRow(0);
  const last = mintRow(input.rows.length - 1);
  if (first === undefined && last === undefined) return undefined;
  return {
    ...(first !== undefined ? { first } : {}),
    ...(last !== undefined ? { last } : {})
  };
}
