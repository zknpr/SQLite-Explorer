import { escapeIdentifier } from './sql-utils';
import type { ExactNumericTextQuery } from './integer-utils';
import type {
  CellValue,
  CellTextEncoding,
  ExactIntegerTextMap,
  OversizedCellMap,
  ReadOnlyRowReasonMap,
  RecordId,
  TableIdentity,
  TableQueryOptions
} from './types';
import {
  encodePrimaryKeyRecordId,
  encodeReadOnlyPrimaryKeyRecordId
} from './row-identity';

export const DEFAULT_MAX_INLINE_CELL_BYTES = 1024 * 1024;
export const DEFAULT_MAX_PAGE_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MIN_SQL_INLINE_CELL_BYTES = 256;
export const DEFAULT_MAX_WEBVIEW_AGGREGATE_PAYLOAD_BYTES =
  2 * DEFAULT_MAX_PAGE_RESPONSE_BYTES;
export const MAX_UNREPRESENTABLE_TEXT_PREVIEW_BYTES = 64 * 1024;
export const WEBVIEW_BINARY_MARKER_OVERHEAD_BYTES = 40;

// Reserve space outside the per-cell model for response/header keys, row-map
// keys, and future DTO fields. The exact 500x560 worst case retains more than
// this margin when measured by Stage C's estimator.
const WEBVIEW_GRID_RESPONSE_HEADROOM_BYTES = 512 * 1024;
const OVERSIZED_CELL_METADATA_VALUE_BYTES = 45;
const PER_CELL_COLLECTION_FRAMING_BYTES = 2;

const CELL_SOURCE_ALIAS = '__sqlite_explorer_cell_source';
const CELL_VALUE_PREFIX = '__sqlite_explorer_cell_value_';
const CELL_METADATA_ALIAS = '__sqlite_explorer_cell_metadata';
const CELL_RAW_TEXT_PREFIX = '__sqlite_explorer_cell_raw_text_';
const CELL_REAL_TEXT_PREFIX = '__sqlite_explorer_cell_real_text_';
const CELL_REAL_TEXTS_PREFIX = '__sqlite_explorer_cell_real_texts_';
const RAW_TEXT_DECODE_SLAB_BYTES = 64 * 1024;
const METADATA_CHUNK_COLUMNS = 400;
// Arguments per sqlite_explorer_cell_metadata() call, far below SQLite's
// function-argument limit.
const HELPER_METADATA_CHUNK_COLUMNS = 100;
const MAX_UTF8_BYTES_PER_CODE_POINT = 4;
// Both bundled SQLite builds use SQLite's default SQLITE_MAX_COLUMN. Private
// raw-TEXT companions must never turn an otherwise valid grid projection into
// a statement that exceeds this result-column ceiling.
export const SQLITE_MAX_RESULT_COLUMNS = 2000;

export interface CellContainmentQuery {
  sql: string;
  /** The final transport row packs metadata when values fill SQLite's width. */
  metadataTrailer: boolean;
  /** Columns returned by sql before packed metadata is inserted. */
  primaryTransportColumnCount: number;
  /** Original value columns, excluding the packed metadata transport column. */
  valueColumnCount: number;
  /** Value-column index occupied by the packed metadata transport column. */
  metadataColumnIndex: number;
  /** Count including values, packed metadata, and private raw-TEXT columns. */
  transportColumnCount: number;
  /** First private raw-TEXT byte slot, aligned with rawTextColumnIndices. */
  rawTextColumnStart: number;
  rawTextColumnCount: number;
  /**
   * Hex avoids one sql.js backing-store allocation per private TEXT cell.
   * 'checked' uses the runtime's grid cell helpers for previews, metadata and
   * raw TEXT; engines choose it only for UTF-8 databases that registered them.
   */
  rawTextTransport: RawTextTransport;
  /** Source-column indices actually represented by private raw-TEXT slots. */
  rawTextColumnIndices: readonly number[];
  /** Requested raw validation was omitted to stay within SQLite's width cap. */
  rawTextValidationUnavailable: boolean;
  effectiveInlineCellBytes: number;
  /** Packed metadata is NULL for a row with no oversized cell. */
  metadataMayBeNull: boolean;
  /**
   * The statement as an exact-numeric transport. With a REAL text sidecar it
   * covers the value columns only, after every primary transport column.
   */
  numericTransport: ExactNumericTextQuery;
}

export type RawTextTransport = 'blob' | 'hex' | 'checked';

/**
 * Raw TEXT slot of a cell that SQLite found to be plain UTF-8 (no NUL, no
 * leading BOM, neither U+FFFE nor U+FFFF), which the engine's string
 * reproduces byte for byte. 'checked' transport also gives non-TEXT cells
 * this slot; consumers read a slot only for a TEXT source value.
 */
export const VERIFIED_TEXT_BYTES: unique symbol = Symbol('verified TEXT bytes');
export type RawTextSlot = Uint8Array | null | typeof VERIFIED_TEXT_BYTES;

export interface DecodedCellContainment {
  rows: CellValue[][];
  oversizedCells?: OversizedCellMap;
  exactIntegerTexts?: ExactIntegerTextMap;
}

function positiveIntegerOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

/**
 * Derive the speculative SQL-side preview window. The 256-byte display floor
 * may relax the wire estimate only while the raw page budget can afford it;
 * the shared decoder still applies the actual returned-byte budget in
 * deterministic row order.
 */
export function deriveEffectiveInlineCellBytes(
  options: Pick<TableQueryOptions, 'limit' | 'maxInlineCellBytes' | 'maxPageResponseBytes'>,
  projectedColumnCount: number
): number {
  if (!Number.isSafeInteger(projectedColumnCount) || projectedColumnCount < 1) {
    throw new Error(`Cell containment requires a positive column count, got ${projectedColumnCount}`);
  }
  const maxInlineCellBytes = positiveIntegerOr(
    options.maxInlineCellBytes,
    DEFAULT_MAX_INLINE_CELL_BYTES
  );
  const maxPageResponseBytes = positiveIntegerOr(
    options.maxPageResponseBytes,
    DEFAULT_MAX_PAGE_RESPONSE_BYTES
  );
  const requestedRows = positiveIntegerOr(options.limit, 1);
  const pageSlots = requestedRows * projectedColumnCount;
  const rawPageWindow = Number.isSafeInteger(pageSlots)
    ? Math.floor(maxPageResponseBytes / pageSlots)
    : 0;
  if (!Number.isSafeInteger(pageSlots)) {
    return 0;
  }

  // Model the worst transported slot: a clipped BLOB becomes a Base64 marker
  // in rows and also gains a sparse oversizedCells entry. Round the remaining
  // Base64 body down to complete four-byte quanta before converting it back to
  // source bytes.
  const columnKeyBytes = String(projectedColumnCount - 1).length + 3;
  const nonBase64WireBytes =
    WEBVIEW_BINARY_MARKER_OVERHEAD_BYTES +
    OVERSIZED_CELL_METADATA_VALUE_BYTES +
    columnKeyBytes +
    PER_CELL_COLLECTION_FRAMING_BYTES;
  const modeledWireBudget =
    DEFAULT_MAX_WEBVIEW_AGGREGATE_PAYLOAD_BYTES -
    WEBVIEW_GRID_RESPONSE_HEADROOM_BYTES;
  const wireBytesPerSlot = Math.floor(modeledWireBudget / pageSlots);
  const base64BytesPerSlot = Math.max(
    0,
    Math.floor((wireBytesPerSlot - nonBase64WireBytes) / 4) * 4
  );
  const wirePageWindow = Math.floor(base64BytesPerSlot / 4) * 3;

  return Math.min(
    maxInlineCellBytes,
    rawPageWindow,
    Math.max(MIN_SQL_INLINE_CELL_BYTES, wirePageWindow)
  );
}

function oversizedPredicate(column: string, byteLimit: number): string {
  return `typeof(${column}) IN ('text', 'blob') AND octet_length(${column}) > ${byteLimit}`;
}

function metadataToken(column: string, byteLimit: number): string {
  return (
    `CASE WHEN ${oversizedPredicate(column, byteLimit)} THEN ` +
    `CASE typeof(${column}) WHEN 'text' THEN 't' ELSE 'b' END || ` +
    `CAST(octet_length(${column}) AS TEXT) ELSE '' END`
  );
}

/**
 * Keep metadata in one packed column so wide grids do not triple result width.
 * A chunk with no oversized cell is its constant run of empty tokens, so most
 * rows skip the per-row compound select.
 */
function buildPackedMetadataExpression(columns: string[], byteLimit: number): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < columns.length; offset += METADATA_CHUNK_COLUMNS) {
    const chunkColumns = columns.slice(offset, offset + METADATA_CHUNK_COLUMNS);
    const compound = chunkColumns.map((column, index) => (
      `${index === 0 ? 'SELECT' : 'UNION ALL SELECT'} ${metadataToken(column, byteLimit)} AS "cell"`
    )).join('\n');
    const anyOversized = chunkColumns
      .map(column => `(${oversizedPredicate(column, byteLimit)})`)
      .join(' OR ');
    chunks.push(
      `CASE WHEN ${anyOversized} ` +
      `THEN (SELECT group_concat("cell", '|') FROM (\n${compound}\n)) ` +
      `ELSE '${'|'.repeat(chunkColumns.length - 1)}' END`
    );
  }
  return chunks.join(` || '|' || `);
}

/** The helper form of the packed metadata, NULL when no cell is oversized. */
function buildHelperMetadataExpression(columns: string[], byteLimit: number): string {
  const chunks: Array<{ sql: string; emptyTokens: string }> = [];
  for (let offset = 0; offset < columns.length; offset += HELPER_METADATA_CHUNK_COLUMNS) {
    const chunkColumns = columns.slice(offset, offset + HELPER_METADATA_CHUNK_COLUMNS);
    chunks.push({
      sql: `sqlite_explorer_cell_metadata(${byteLimit}, ${chunkColumns.join(', ')})`,
      emptyTokens: `'${'|'.repeat(chunkColumns.length - 1)}'`
    });
  }
  if (chunks.length === 1) return chunks[0].sql;
  const joined = chunks
    .map(chunk => `COALESCE(${chunk.sql}, ${chunk.emptyTokens})`)
    .join(` || '|' || `);
  return `NULLIF(${joined}, '${'|'.repeat(columns.length - 1)}')`;
}

/**
 * Wrap a filtered/ordered/paginated SELECT and project only bounded TEXT/BLOB
 * windows. The inner SELECT continues to own WHERE and ORDER BY semantics.
 *
 * sourceEndsWithOffset: the caller built sourceSql and its outermost SELECT
 * ends with an OFFSET clause. SQLite never flattens such a subquery, so it
 * needs no wrapper of its own, which would copy every value through a second
 * co-routine.
 */
export function buildCellContainmentQuery(
  sourceSql: string,
  columnCount: number,
  options: Pick<TableQueryOptions, 'limit' | 'maxInlineCellBytes' | 'maxPageResponseBytes'>,
  rawTextColumnIndices: readonly number[] = [],
  rawTextTransport: RawTextTransport = 'blob',
  includeRealTextSidecar = false,
  sourceEndsWithOffset = false
): CellContainmentQuery {
  if (sourceEndsWithOffset && !/ OFFSET \d+$/.test(sourceSql)) {
    throw new Error('Cell containment source does not end with an OFFSET clause');
  }
  const effectiveInlineCellBytes = deriveEffectiveInlineCellBytes(options, columnCount);
  const textCharacterWindow = Math.floor(
    effectiveInlineCellBytes / MAX_UTF8_BYTES_PER_CODE_POINT
  );
  const valueNames = Array.from({ length: columnCount }, (_, index) => (
    `${CELL_VALUE_PREFIX}${index}`
  ));
  const quotedValues = valueNames.map(escapeIdentifier);
  if (
    new Set(rawTextColumnIndices).size !== rawTextColumnIndices.length
    || rawTextColumnIndices.some(index => !Number.isInteger(index) || index < 0 || index >= columnCount)
  ) {
    throw new Error('Cell containment raw-TEXT columns must be unique in-range indices');
  }
  const rawTextValidationUnavailable = rawTextColumnIndices.length > 0
    && columnCount + 1 + rawTextColumnIndices.length > SQLITE_MAX_RESULT_COLUMNS;
  const projectedRawTextColumnIndices = rawTextValidationUnavailable
    ? []
    : rawTextColumnIndices;
  const usesCellHelpers = rawTextTransport === 'checked';
  const metadataUsesTrailer = columnCount + 1 > SQLITE_MAX_RESULT_COLUMNS;
  const projectedValues = quotedValues.map((column, index) => (
    usesCellHelpers
      ? `sqlite_explorer_cell_preview(${column}, ${effectiveInlineCellBytes}, ${textCharacterWindow}) ` +
        `AS ${escapeIdentifier(valueNames[index])}`
      : `CASE ` +
        `WHEN typeof(${column}) = 'text' AND octet_length(${column}) > ${effectiveInlineCellBytes} ` +
        `THEN substr(${column}, 1, ${textCharacterWindow}) ` +
        `WHEN typeof(${column}) = 'blob' AND octet_length(${column}) > ${effectiveInlineCellBytes} ` +
        `THEN substr(${column}, 1, ${effectiveInlineCellBytes}) ` +
        `ELSE ${column} END AS ${escapeIdentifier(valueNames[index])}`
  ));
  const quotedSource = escapeIdentifier(CELL_SOURCE_ALIAS);
  // The trailer concatenates one metadata value per row, so it keeps the form
  // that is never NULL.
  const metadataMayBeNull = usesCellHelpers && !metadataUsesTrailer;
  const metadataExpression = metadataMayBeNull
    ? buildHelperMetadataExpression(quotedValues, effectiveInlineCellBytes)
    : buildPackedMetadataExpression(quotedValues, effectiveInlineCellBytes);
  const rawTextExpressions = projectedRawTextColumnIndices.map((columnIndex, keyIndex) => {
    const column = quotedValues[columnIndex];
    const name = escapeIdentifier(`${CELL_RAW_TEXT_PREFIX}${keyIndex}`);
    if (usesCellHelpers) {
      return `sqlite_explorer_cell_text_check(${column}, ${effectiveInlineCellBytes}) AS ${name}`;
    }
    return (
      `CASE WHEN typeof(${column}) = 'text' ` +
      `AND octet_length(${column}) <= ${effectiveInlineCellBytes} ` +
      `THEN ${rawTextTransport === 'hex' ? `hex(CAST(${column} AS BLOB))` : `CAST(${column} AS BLOB)`} END AS ` +
      name
    );
  });
  const privateProjection = rawTextExpressions.length > 0
    ? `, ${rawTextExpressions.join(', ')}`
    : '';
  const sourceCte =
    `WITH ${quotedSource} (${quotedValues.join(', ')}) AS` +
    `${metadataUsesTrailer ? ' MATERIALIZED' : ''} (\n` +
    (sourceEndsWithOffset
      ? `${sourceSql}\n)\n`
      : `SELECT * FROM (\n${sourceSql}\n) LIMIT -1 OFFSET 0\n)\n`);
  const primaryMetadataProjection = metadataUsesTrailer
    ? ''
    : `, ${metadataExpression} AS ${escapeIdentifier(CELL_METADATA_ALIAS)}`;
  const metadataTrailerProjection = metadataUsesTrailer
    ? (
        `\nUNION ALL\nSELECT ` +
        `(SELECT COALESCE(group_concat(${metadataExpression}, char(10)), '') ` +
        `FROM ${quotedSource})` +
        `${columnCount > 1 ? `, ${Array(columnCount - 1).fill('NULL').join(', ')}` : ''}`
      )
    : '';

  const primaryTransportColumnCount =
    columnCount + (metadataUsesTrailer ? 0 : 1) + projectedRawTextColumnIndices.length;
  // Clipping never changes a REAL, so the source value's SQLite text is the
  // transported value's. Only value columns can hold one: metadata and raw
  // TEXT companions are always TEXT or NULL.
  // The helper packs a row's REAL text into one column per argument chunk; a
  // native row object pays for every column, even NULL ones.
  const packedChunkCount = Math.ceil(columnCount / HELPER_METADATA_CHUNK_COLUMNS);
  const packedRealTextColumnCount = usesCellHelpers && includeRealTextSidecar && !metadataUsesTrailer
    && primaryTransportColumnCount + packedChunkCount <= SQLITE_MAX_RESULT_COLUMNS
    ? packedChunkCount
    : 0;
  const realTextColumnCount = includeRealTextSidecar
    && !usesCellHelpers
    && !metadataUsesTrailer
    && primaryTransportColumnCount + columnCount <= SQLITE_MAX_RESULT_COLUMNS
    ? columnCount
    : 0;
  const realTextNames = packedRealTextColumnCount > 0
    ? Array.from({ length: packedRealTextColumnCount }, (_, index) => `${CELL_REAL_TEXTS_PREFIX}${index}`)
    : Array.from({ length: realTextColumnCount }, (_, index) => `${CELL_REAL_TEXT_PREFIX}${index}`);
  const realTextProjection = packedRealTextColumnCount > 0
    ? realTextNames.map((name, index) => {
        const offset = index * HELPER_METADATA_CHUNK_COLUMNS;
        const chunk = quotedValues.slice(offset, offset + HELPER_METADATA_CHUNK_COLUMNS);
        return `, sqlite_explorer_real_texts(${offset}, ${chunk.join(', ')}) AS ${escapeIdentifier(name)}`;
      }).join('')
    : realTextNames.map((name, index) => (
        `, CASE WHEN typeof(${quotedValues[index]}) = 'real' ` +
        `THEN CAST(${quotedValues[index]} AS TEXT) END AS ${escapeIdentifier(name)}`
      )).join('');
  const sql =
    sourceCte +
    `SELECT ${projectedValues.join(', ')}` +
    `${primaryMetadataProjection}${privateProjection}${realTextProjection} ` +
    `FROM ${quotedSource}` +
    metadataTrailerProjection;
  const transportColumns = [
    ...valueNames,
    ...(metadataUsesTrailer ? [] : [CELL_METADATA_ALIAS]),
    ...projectedRawTextColumnIndices.map((_, keyIndex) => `${CELL_RAW_TEXT_PREFIX}${keyIndex}`),
    ...realTextNames
  ];

  return {
    // An OFFSET, the source's own or the wrapper's, prevents query
    // flattening. At the width ceiling, MATERIALIZED
    // lets the value rows and their one-row metadata trailer scan the same
    // ephemeral result instead of evaluating a volatile source twice.
    sql,
    metadataTrailer: metadataUsesTrailer,
    primaryTransportColumnCount,
    valueColumnCount: columnCount,
    metadataColumnIndex: columnCount,
    transportColumnCount: columnCount + 1 + projectedRawTextColumnIndices.length,
    rawTextColumnStart: columnCount + 1,
    rawTextColumnCount: projectedRawTextColumnIndices.length,
    rawTextTransport,
    rawTextColumnIndices: projectedRawTextColumnIndices,
    rawTextValidationUnavailable,
    effectiveInlineCellBytes,
    metadataMayBeNull,
    numericTransport: packedRealTextColumnCount > 0
      ? {
          sql,
          transportColumns,
          valueColumnCount: primaryTransportColumnCount,
          packedRealTextColumnCount
        }
      : realTextColumnCount > 0
        ? {
            sql,
            transportColumns,
            valueColumnCount: primaryTransportColumnCount,
            realTextColumnCount
          }
        : { sql, transportColumns }
  };
}

/** Insert packed metadata at its logical transport slot. */
export function mergeCellContainmentMetadataRows(
  primaryRows: readonly (readonly unknown[])[],
  metadataRows: readonly (readonly unknown[])[] | undefined,
  query: Pick<
    CellContainmentQuery,
    'metadataTrailer' | 'metadataColumnIndex' | 'primaryTransportColumnCount'
  >
): Array<Array<unknown>> {
  if (!query.metadataTrailer) {
    if (metadataRows !== undefined) {
      throw new Error('Cell containment received unexpected separate metadata rows');
    }
    return primaryRows as Array<Array<unknown>>;
  }
  if (metadataRows !== undefined) {
    throw new Error('Cell containment metadata must come from the value statement');
  }
  const trailer = primaryRows.at(-1);
  if (!trailer || trailer.length !== query.primaryTransportColumnCount) {
    throw new Error('Cell containment metadata trailer is missing or malformed');
  }
  if (typeof trailer[0] !== 'string' || trailer.slice(1).some(value => value !== null)) {
    throw new Error('Cell containment metadata trailer is not one packed text value');
  }
  const valueRows = primaryRows.slice(0, -1);
  const packedMetadataRows = trailer[0] === '' ? [] : trailer[0].split('\n');
  if (packedMetadataRows.length !== valueRows.length) {
    throw new Error('Cell containment metadata row count does not match the value page');
  }

  return valueRows.map((row, rowIndex) => {
    if (row.length < query.primaryTransportColumnCount) {
      throw new Error(`Cell containment value row ${rowIndex} is missing transport columns`);
    }
    return [
      ...row.slice(0, query.metadataColumnIndex),
      packedMetadataRows[rowIndex],
      ...row.slice(query.metadataColumnIndex)
    ];
  });
}

/** Prepend one synthetic value while preserving positionally indexed sidecars. */
export function prependCellContainmentColumn(
  leadingValues: readonly CellValue[],
  contained: DecodedCellContainment,
  fallbackExactIntegerTexts?: ExactIntegerTextMap
): DecodedCellContainment {
  if (leadingValues.length !== contained.rows.length) {
    throw new Error('Synthetic containment column row count does not match the value page');
  }

  const shiftColumns = <T>(
    source: Record<number, Record<number, T>> | undefined
  ): Record<number, Record<number, T>> | undefined => {
    if (!source) return undefined;
    const shifted: Record<number, Record<number, T>> = {};
    for (const [rowIndexText, row] of Object.entries(source)) {
      const rowIndex = Number(rowIndexText);
      shifted[rowIndex] = {};
      for (const [columnIndexText, value] of Object.entries(row)) {
        shifted[rowIndex][Number(columnIndexText) + 1] = value;
      }
    }
    return shifted;
  };

  const shiftedExactIntegerTexts = shiftColumns(contained.exactIntegerTexts);
  let exactIntegerTexts: ExactIntegerTextMap | undefined;
  for (const source of [fallbackExactIntegerTexts, shiftedExactIntegerTexts]) {
    if (!source) continue;
    exactIntegerTexts ??= {};
    for (const [rowIndexText, row] of Object.entries(source)) {
      const rowIndex = Number(rowIndexText);
      exactIntegerTexts[rowIndex] ??= {};
      Object.assign(exactIntegerTexts[rowIndex], row);
    }
  }

  const oversizedCells = shiftColumns(contained.oversizedCells);
  return {
    rows: contained.rows.map((row, rowIndex) => [leadingValues[rowIndex], ...row]),
    ...(oversizedCells ? { oversizedCells } : {}),
    ...(exactIntegerTexts ? { exactIntegerTexts } : {})
  };
}

/** Extract bounded raw bytes which never leave the engine-side fetch path. */
export function decodeRawTextColumns(
  rows: readonly (readonly unknown[])[],
  query: Pick<CellContainmentQuery,
    'rawTextColumnStart' | 'rawTextColumnCount' | 'transportColumnCount'
    | 'rawTextTransport' | 'effectiveInlineCellBytes'>
): Array<readonly RawTextSlot[]> {
  // Keep ownership per page, but allocate only small slabs as bytes arrive.
  // Hundreds of thousands of tiny sql.js BLOB ArrayBuffers otherwise trigger
  // long backing-store GC pauses in the Windows Electron worker. Large cells
  // retain an individually bounded buffer; ordinary native BLOBs stay intact.
  let slab: Uint8Array | undefined;
  let slabOffset = 0;
  let emptyBytes: Uint8Array | undefined;
  const hexDigit = (code: number): number => {
    if (code >= 48 && code <= 57) return code - 48;
    const lowerCase = code | 32;
    return lowerCase >= 97 && lowerCase <= 102 ? lowerCase - 87 : -1;
  };
  const decodeHex = (value: unknown, rowIndex: number, keyIndex: number): Uint8Array => {
    const byteLength = typeof value === 'string' ? value.length / 2 : NaN;
    if (
      typeof value !== 'string'
      || !Number.isSafeInteger(byteLength)
      || !Number.isSafeInteger(query.effectiveInlineCellBytes)
      || query.effectiveInlineCellBytes < 0
      || byteLength > query.effectiveInlineCellBytes
    ) {
      throw new Error(`Raw TEXT value at row ${rowIndex}, key ${keyIndex} is not bounded hexadecimal text`);
    }
    if (byteLength === 0) return emptyBytes ??= new Uint8Array(0);
    let bytes: Uint8Array;
    if (byteLength > RAW_TEXT_DECODE_SLAB_BYTES) {
      bytes = new Uint8Array(byteLength);
    } else {
      if (!slab || slab.byteLength - slabOffset < byteLength) {
        slab = new Uint8Array(RAW_TEXT_DECODE_SLAB_BYTES);
        slabOffset = 0;
      }
      bytes = slab.subarray(slabOffset, slabOffset + byteLength);
      slabOffset += byteLength;
    }
    for (let index = 0; index < byteLength; index++) {
      const high = hexDigit(value.charCodeAt(index * 2));
      const low = hexDigit(value.charCodeAt(index * 2 + 1));
      if (high < 0 || low < 0) {
        throw new Error(`Raw TEXT value at row ${rowIndex}, key ${keyIndex} contains invalid hexadecimal text`);
      }
      bytes[index] = high * 16 + low;
    }
    return bytes;
  };
  // In checked transport most rows hold only plain or non-TEXT cells; they
  // share one read-only row of verified slots.
  let verifiedRow: readonly RawTextSlot[] | undefined;
  return rows.map((row, rowIndex) => {
    if (row.length < query.transportColumnCount) {
      throw new Error(`Raw TEXT row ${rowIndex} is missing private transport columns`);
    }
    if (query.rawTextTransport === 'checked') {
      let keyIndex = 0;
      while (keyIndex < query.rawTextColumnCount && row[query.rawTextColumnStart + keyIndex] === null) keyIndex++;
      if (keyIndex === query.rawTextColumnCount) {
        return verifiedRow ??= Object.freeze(Array<RawTextSlot>(query.rawTextColumnCount).fill(VERIFIED_TEXT_BYTES));
      }
    }
    return Array.from({ length: query.rawTextColumnCount }, (_, keyIndex) => {
      const value = row[query.rawTextColumnStart + keyIndex];
      if (query.rawTextTransport === 'checked') {
        // NULL: plain UTF-8 TEXT or not TEXT. 0: TEXT longer than the window,
        // which carries no bytes, as in the other transports.
        if (value === null) return VERIFIED_TEXT_BYTES;
        if (value === 0 || value === 0n) return null;
        if (
          !(value instanceof Uint8Array)
          || value.byteLength > query.effectiveInlineCellBytes
        ) {
          throw new Error(`Checked raw TEXT value at row ${rowIndex}, key ${keyIndex} is not bounded bytes`);
        }
        return value;
      }
      if (value !== null && query.rawTextTransport === 'hex') {
        return decodeHex(value, rowIndex, keyIndex);
      }
      if (value !== null && !(value instanceof Uint8Array)) {
        throw new Error(`Raw TEXT value at row ${rowIndex}, key ${keyIndex} is not a BLOB`);
      }
      return value;
    });
  });
}

/**
 * Whether an engine's string, given the string decoded from SQLite's stored
 * TEXT bytes, can stand for those bytes as text. TEXT containing NUL never
 * counts: some engines and connections truncate it at NUL and others return it
 * whole, and VS Code guesses UTF-16 from the NUL bytes of a file, so it stays
 * bytes everywhere.
 */
export function decodedTextReproduces(decoded: string, value: string): boolean {
  return decoded === value && !value.includes('\0');
}

/** decodedTextReproduces for raw bytes; bytes that do not decode never count. */
function decodedTextReproducesBytes(
  decoder: { decode(bytes: Uint8Array): string },
  rawBytes: Uint8Array,
  value: string
): boolean {
  try {
    return decodedTextReproduces(decoder.decode(rawBytes), value);
  } catch {
    return false;
  }
}

/** Identify rows whose decoded TEXT cells cannot reproduce SQLite's bytes. */
export function findUnrepresentableTextRows(input: {
  sourceRows: readonly (readonly unknown[])[];
  sourceColumnIndices: readonly number[];
  rawTextRows: readonly (readonly RawTextSlot[])[];
  rawTextColumnIndices: readonly number[];
  textEncoding: CellTextEncoding;
  rawTextValidationUnavailable?: boolean;
}): ReadonlySet<number> | undefined {
  if (input.sourceRows.length === 0 || input.sourceColumnIndices.length === 0) {
    return undefined;
  }
  if (input.rawTextValidationUnavailable) {
    return new Set(input.sourceRows.map((_, rowIndex) => rowIndex));
  }
  if (input.rawTextRows.length !== input.sourceRows.length) {
    throw new Error('Raw TEXT validation row count does not match the source page');
  }
  const rawSlots = input.sourceColumnIndices.map(columnIndex => {
    const slot = input.rawTextColumnIndices.indexOf(columnIndex);
    if (slot < 0) {
      throw new Error(`Raw TEXT validation column ${columnIndex} was not projected`);
    }
    return slot;
  });
  // The default decoder strips a leading BOM, which would collapse BOM+A and
  // plain A into the same identity. Retain it so byte-distinct valid TEXT is
  // rejected whenever the ordinary engine string cannot represent it.
  const decoder = new TextDecoder(input.textEncoding, { fatal: true, ignoreBOM: true });
  let unrepresentableRows: Set<number> | undefined;
  input.sourceRows.forEach((row, rowIndex) => {
    const rawRow = input.rawTextRows[rowIndex];
    if (!rawRow || rawRow.length !== input.rawTextColumnIndices.length) {
      throw new Error(`Raw TEXT validation row ${rowIndex} has the wrong width`);
    }
    for (let slot = 0; slot < input.sourceColumnIndices.length; slot++) {
      const value = row[input.sourceColumnIndices[slot]];
      if (typeof value !== 'string') continue;
      const rawBytes = rawRow[rawSlots[slot]];
      const representable = rawBytes === VERIFIED_TEXT_BYTES
        || (rawBytes instanceof Uint8Array && decodedTextReproducesBytes(decoder, rawBytes, value));
      if (!representable) {
        unrepresentableRows ??= new Set();
        unrepresentableRows.add(rowIndex);
        break;
      }
    }
  });
  return unrepresentableRows;
}

/**
 * Replace decoded TEXT cells whose JavaScript string cannot reproduce the
 * stored SQLite bytes with a bounded authoritative byte prefix. The sparse
 * sidecar still blocks lossy inline edits, while identityless view rows retain
 * useful Hex data instead of depending on a table-only streaming locator.
 */
export function containUnrepresentableTextCells(input: {
  sourceRows: readonly (readonly unknown[])[];
  rawTextRows: readonly (readonly RawTextSlot[])[];
  rawTextColumnIndices: readonly number[];
  textEncoding: CellTextEncoding;
  contained: DecodedCellContainment;
  /** contained is decodeCellContainment's result unchanged, so its budget check holds. */
  decodedWithinBudget?: boolean;
}): DecodedCellContainment {
  if (
    input.sourceRows.length !== input.contained.rows.length
    || input.rawTextRows.length !== input.sourceRows.length
  ) {
    throw new Error('Raw TEXT containment row count does not match the source page');
  }
  // With every TEXT slot verified or size-contained there is nothing to
  // replace, and decodeCellContainment already bounded this page.
  const needsReplacementPass = !input.decodedWithinBudget || input.rawTextRows.some((rawRow, rowIndex) => {
    if (!rawRow || rawRow.length !== input.rawTextColumnIndices.length) return true;
    return input.rawTextColumnIndices.some((columnIndex, rawIndex) => (
      rawRow[rawIndex] !== VERIFIED_TEXT_BYTES
      && typeof input.sourceRows[rowIndex][columnIndex] === 'string'
      && !input.contained.oversizedCells?.[rowIndex]?.[columnIndex]
    ));
  });
  if (!needsReplacementPass) return input.contained;
  const rows = input.contained.rows.map(row => Array.from(row));
  let oversizedCells: OversizedCellMap | undefined;
  if (input.contained.oversizedCells) {
    oversizedCells = {};
    for (const [rowIndexText, row] of Object.entries(input.contained.oversizedCells)) {
      oversizedCells[Number(rowIndexText)] = { ...row };
    }
  }
  let exactIntegerTexts: ExactIntegerTextMap | undefined;
  if (input.contained.exactIntegerTexts) {
    exactIntegerTexts = {};
    for (const [rowIndexText, row] of Object.entries(input.contained.exactIntegerTexts)) {
      exactIntegerTexts[Number(rowIndexText)] = { ...row };
    }
  }
  const aggregateBudget =
    DEFAULT_MAX_WEBVIEW_AGGREGATE_PAYLOAD_BYTES - WEBVIEW_GRID_RESPONSE_HEADROOM_BYTES;
  let aggregateBytes = estimateRowsWireBytes(rows)
    + estimateOversizedCellsWireBytes(oversizedCells)
    + estimateExactIntegerTextsWireBytes(exactIntegerTexts);
  const decoder = new TextDecoder(input.textEncoding, { fatal: true, ignoreBOM: true });
  input.sourceRows.forEach((sourceRow, rowIndex) => {
    const rawRow = input.rawTextRows[rowIndex];
    if (!rawRow || rawRow.length !== input.rawTextColumnIndices.length) {
      throw new Error(`Raw TEXT containment row ${rowIndex} has the wrong width`);
    }
    input.rawTextColumnIndices.forEach((columnIndex, rawIndex) => {
      const sourceValue = sourceRow[columnIndex];
      if (typeof sourceValue !== 'string') return;
      // A size/page-contained cell is already routed through the raw reader.
      if (oversizedCells?.[rowIndex]?.[columnIndex]) return;
      const rawBytes = rawRow[rawIndex];
      if (rawBytes === VERIFIED_TEXT_BYTES) return;
      if (!(rawBytes instanceof Uint8Array)) {
        throw new Error(
          `Raw TEXT containment bytes are missing at row ${rowIndex}, column ${columnIndex}`
        );
      }
      if (decodedTextReproducesBytes(decoder, rawBytes, sourceValue)) return;
      const previousValue = rows[rowIndex][columnIndex];
      const metadataInsertionBytes = oversizedMetadataInsertionWireBytes(
        oversizedCells,
        rowIndex,
        columnIndex
      );
      oversizedCells ??= {};
      oversizedCells[rowIndex] ??= {};
      oversizedCells[rowIndex][columnIndex] = {
        storageClass: 'text',
        byteLength: rawBytes.byteLength
      };
      const replacementBudget = Math.max(
        0,
        aggregateBudget
          - aggregateBytes
          - metadataInsertionBytes
          + transportedCellWireBytes(previousValue)
      );
      const maxRawBytesByWire = replacementBudget > WEBVIEW_BINARY_MARKER_OVERHEAD_BYTES
        ? Math.floor(
            (replacementBudget - WEBVIEW_BINARY_MARKER_OVERHEAD_BYTES) / 4
          ) * 3
        : 0;
      const retainedByteLength = Math.min(
        rawBytes.byteLength,
        MAX_UNREPRESENTABLE_TEXT_PREVIEW_BYTES,
        maxRawBytesByWire
      );
      if (retainedByteLength === 0) {
        throw new Error(
          `Raw TEXT containment cannot retain an authoritative byte prefix ` +
          `for row ${rowIndex}, column ${columnIndex} within the webview transport limit`
        );
      }
      const replacementValue = rawBytes.slice(0, retainedByteLength);
      rows[rowIndex][columnIndex] = replacementValue;
      aggregateBytes += transportedCellWireBytes(replacementValue)
        - transportedCellWireBytes(previousValue)
        + metadataInsertionBytes;
      if (exactIntegerTexts?.[rowIndex]) {
        delete exactIntegerTexts[rowIndex][columnIndex];
        if (Object.keys(exactIntegerTexts[rowIndex]).length === 0) {
          delete exactIntegerTexts[rowIndex];
        }
      }
    });
  });
  if (aggregateBytes > aggregateBudget) {
    throw new Error(
      `Raw TEXT containment cannot fit this page within the ` +
      `${DEFAULT_MAX_WEBVIEW_AGGREGATE_PAYLOAD_BYTES}-byte transport limit`
    );
  }
  return {
    rows,
    ...(oversizedCells ? { oversizedCells } : {}),
    ...(exactIntegerTexts && Object.keys(exactIntegerTexts).length > 0
      ? { exactIntegerTexts }
      : {})
  };
}

function parseMetadataToken(token: string, rowIndex: number, columnIndex: number) {
  if (token === '') return undefined;
  const match = /^([tb])([1-9]\d*)$/.exec(token);
  if (!match) {
    throw new Error(
      `Invalid oversized-cell metadata at row ${rowIndex}, column ${columnIndex}`
    );
  }
  const byteLength = Number(match[2]);
  if (!Number.isSafeInteger(byteLength)) {
    throw new Error(
      `Oversized-cell byte length is unsafe at row ${rowIndex}, column ${columnIndex}`
    );
  }
  return {
    storageClass: match[1] === 't' ? 'text' as const : 'blob' as const,
    byteLength
  };
}

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xD800 && code <= 0xDBFF && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        bytes += 4;
        index++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function inlineCellByteLength(value: CellValue): number | undefined {
  if (typeof value === 'string') return utf8ByteLength(value);
  if (value instanceof Uint8Array) return value.byteLength;
  return undefined;
}

function emptyInlinePreview(storageClass: 'text' | 'blob'): CellValue {
  return storageClass === 'text' ? '' : new Uint8Array(0);
}

function encodedBase64Bytes(byteLength: number): number {
  return 4 * Math.ceil(byteLength / 3);
}

/** Match the webview transport estimator for one already-decoded cell value. */
function transportedCellWireBytes(value: CellValue): number {
  if (value instanceof Uint8Array) {
    return encodedBase64Bytes(value.byteLength) + WEBVIEW_BINARY_MARKER_OVERHEAD_BYTES;
  }
  if (typeof value === 'string') return utf8ByteLength(value) + 2;
  return 8;
}

function objectKeyWireBytes(key: string): number {
  return utf8ByteLength(key) + 3;
}

function estimateRowsWireBytes(rows: readonly (readonly CellValue[])[]): number {
  let bytes = 2 + Math.max(0, rows.length - 1);
  for (const row of rows) {
    bytes += 2 + Math.max(0, row.length - 1);
    for (const value of row) bytes += transportedCellWireBytes(value);
  }
  return bytes;
}

function estimateOversizedCellsWireBytes(oversizedCells: OversizedCellMap | undefined): number {
  if (!oversizedCells) return 0;
  const rows = Object.entries(oversizedCells);
  let bytes = 2 + Math.max(0, rows.length - 1);
  for (const [rowIndex, row] of rows) {
    bytes += objectKeyWireBytes(rowIndex);
    const cells = Object.entries(row);
    bytes += 2 + Math.max(0, cells.length - 1);
    for (const [columnIndex] of cells) {
      bytes += objectKeyWireBytes(columnIndex) + OVERSIZED_CELL_METADATA_VALUE_BYTES;
    }
  }
  return bytes;
}

function oversizedMetadataInsertionWireBytes(
  oversizedCells: OversizedCellMap | undefined,
  rowIndex: number,
  columnIndex: number
): number {
  if (oversizedCells?.[rowIndex]?.[columnIndex]) return 0;
  const columnBytes = objectKeyWireBytes(String(columnIndex))
    + OVERSIZED_CELL_METADATA_VALUE_BYTES;
  const existingRow = oversizedCells?.[rowIndex];
  if (existingRow) return 1 + columnBytes;
  const rowBytes = objectKeyWireBytes(String(rowIndex)) + 2 + columnBytes;
  if (oversizedCells) return 1 + rowBytes;
  return 2 + rowBytes;
}

function estimateExactIntegerTextsWireBytes(exactIntegerTexts: ExactIntegerTextMap | undefined): number {
  if (!exactIntegerTexts) return 0;
  const rows = Object.entries(exactIntegerTexts);
  let bytes = 2 + Math.max(0, rows.length - 1);
  for (const [rowIndex, row] of rows) {
    bytes += objectKeyWireBytes(rowIndex);
    const cells = Object.entries(row);
    bytes += 2 + Math.max(0, cells.length - 1);
    for (const [columnIndex, exactText] of cells) {
      bytes += objectKeyWireBytes(columnIndex) + utf8ByteLength(exactText) + 2;
    }
  }
  return bytes;
}

function estimateReadOnlyRowReasonsWireBytes(
  readOnlyRowReasons: ReadOnlyRowReasonMap | undefined
): number {
  if (!readOnlyRowReasons) return 0;
  const rows = Object.entries(readOnlyRowReasons);
  let bytes = 2 + Math.max(0, rows.length - 1);
  for (const [rowIndex, reason] of rows) {
    bytes += objectKeyWireBytes(rowIndex) + transportedCellWireBytes(reason);
  }
  return bytes;
}

/** Strip the private metadata column and return sparse, positionally exact sidecars. */
export function decodeCellContainment(
  transportedRows: readonly (readonly unknown[])[],
  valueColumnCount: number,
  exactIntegerTexts?: ExactIntegerTextMap,
  maxPageResponseBytes: number = DEFAULT_MAX_PAGE_RESPONSE_BYTES,
  metadataMayBeNull = false
): DecodedCellContainment {
  const pageByteBudget = positiveIntegerOr(
    maxPageResponseBytes,
    DEFAULT_MAX_PAGE_RESPONSE_BYTES
  );
  let oversizedCells: OversizedCellMap | undefined;
  let inlineBytes = 0;
  let pageBudgetExhausted = false;
  // Row and column index pairs of the previews kept inline, in page order.
  const retainedInlineCells: number[] = [];
  // estimateRowsWireBytes(rows), summed from each cell's final value so
  // every string is measured once.
  let rowsWireBytes = 2 + Math.max(0, transportedRows.length - 1);

  const recordOversizedCell = (
    rowIndex: number,
    columnIndex: number,
    metadata: { storageClass: 'text' | 'blob'; byteLength: number }
  ): void => {
    oversizedCells ??= {};
    oversizedCells[rowIndex] ??= {};
    oversizedCells[rowIndex][columnIndex] ??= metadata;
  };

  let noOversizedTokens: string[] | undefined;

  const rows = transportedRows.map((row, rowIndex) => {
    if (row.length < valueColumnCount + 1) {
      throw new Error(
        `Cell containment row ${rowIndex} has ${row.length} values; ` +
        `expected at least ${valueColumnCount + 1}`
      );
    }
    const packed = row[valueColumnCount];
    if (typeof packed !== 'string' && !(packed === null && metadataMayBeNull)) {
      throw new Error(`Cell containment metadata at row ${rowIndex} is not text`);
    }
    const tokens = packed === null
      ? (noOversizedTokens ??= Array<string>(valueColumnCount).fill(''))
      : packed.split('|');
    if (tokens.length !== valueColumnCount) {
      throw new Error(
        `Cell containment metadata at row ${rowIndex} has ${tokens.length} entries; ` +
        `expected ${valueColumnCount}`
      );
    }
    const values = row.slice(0, valueColumnCount) as CellValue[];
    rowsWireBytes += 2 + Math.max(0, values.length - 1);
    for (let columnIndex = 0; columnIndex < valueColumnCount; columnIndex++) {
      const sqlMetadata = parseMetadataToken(tokens[columnIndex], rowIndex, columnIndex);
      if (sqlMetadata) recordOversizedCell(rowIndex, columnIndex, sqlMetadata);

      const value = values[columnIndex];
      const byteLength = inlineCellByteLength(value);
      if (byteLength === undefined || byteLength === 0) {
        rowsWireBytes += transportedCellWireBytes(value);
        continue;
      }

      if (
        pageBudgetExhausted
        || byteLength > pageByteBudget - inlineBytes
      ) {
        pageBudgetExhausted = true;
        const metadata = sqlMetadata ?? {
          storageClass: typeof value === 'string' ? 'text' as const : 'blob' as const,
          byteLength
        };
        recordOversizedCell(rowIndex, columnIndex, metadata);
        const preview = emptyInlinePreview(metadata.storageClass);
        values[columnIndex] = preview;
        rowsWireBytes += transportedCellWireBytes(preview);
        continue;
      }

      inlineBytes += byteLength;
      retainedInlineCells.push(rowIndex, columnIndex);
      rowsWireBytes += typeof value === 'string' ? byteLength + 2 : transportedCellWireBytes(value);
    }
    return values;
  });

  let retainedExactIntegerTexts: ExactIntegerTextMap | undefined;
  if (exactIntegerTexts) {
    for (const [rowIndexText, exactRow] of Object.entries(exactIntegerTexts)) {
      for (const [columnIndexText, exactText] of Object.entries(exactRow)) {
        const columnIndex = Number(columnIndexText);
        if (columnIndex >= valueColumnCount) continue;
        retainedExactIntegerTexts ??= {};
        retainedExactIntegerTexts[Number(rowIndexText)] ??= {};
        retainedExactIntegerTexts[Number(rowIndexText)][columnIndex] = exactText;
      }
    }
  }

  // The page budget limits source bytes; this second bound models the actual
  // Base64/string representation plus sparse sidecars. It is deliberately
  // below the 32 MiB transport guard so headers and the RPC envelope retain
  // fixed headroom. If needed, remove previews from the retained prefix's tail
  // while preserving its earliest cells.
  const aggregateBudget =
    DEFAULT_MAX_WEBVIEW_AGGREGATE_PAYLOAD_BYTES - WEBVIEW_GRID_RESPONSE_HEADROOM_BYTES;
  let aggregateBytes = rowsWireBytes
    + estimateOversizedCellsWireBytes(oversizedCells)
    + estimateExactIntegerTextsWireBytes(retainedExactIntegerTexts);

  for (
    let index = retainedInlineCells.length - 2;
    index >= 0 && aggregateBytes > aggregateBudget;
    index -= 2
  ) {
    const rowIndex = retainedInlineCells[index];
    const columnIndex = retainedInlineCells[index + 1];
    const currentValue = rows[rowIndex][columnIndex];
    // A clipped preview's SQL metadata was recorded first; any other kept
    // preview is still its whole value.
    const metadata = oversizedCells?.[rowIndex]?.[columnIndex] ?? {
      storageClass: typeof currentValue === 'string' ? 'text' as const : 'blob' as const,
      byteLength: inlineCellByteLength(currentValue)!
    };
    const emptyValue = emptyInlinePreview(metadata.storageClass);
    const delta = transportedCellWireBytes(emptyValue)
      - transportedCellWireBytes(currentValue)
      + oversizedMetadataInsertionWireBytes(oversizedCells, rowIndex, columnIndex);
    if (delta >= 0) continue;
    recordOversizedCell(rowIndex, columnIndex, metadata);
    rows[rowIndex][columnIndex] = emptyValue;
    aggregateBytes += delta;
  }

  if (aggregateBytes > aggregateBudget) {
    throw new Error(
      `Cell containment cannot fit this page within the ` +
      `${DEFAULT_MAX_WEBVIEW_AGGREGATE_PAYLOAD_BYTES}-byte transport limit`
    );
  }

  return {
    rows,
    ...(oversizedCells ? { oversizedCells } : {}),
    ...(retainedExactIntegerTexts ? { exactIntegerTexts: retainedExactIntegerTexts } : {})
  };
}

export interface PrimaryKeyContainmentInput {
  identity: Extract<TableIdentity, { kind: 'primaryKey' }>;
  sourceColumns: readonly string[];
  visibleColumnCount: number;
  identityRows: readonly (readonly (CellValue | bigint)[])[];
  rawTextBytes: readonly (readonly RawTextSlot[])[];
  /** Source indices aligned with each rawTextBytes row. */
  rawTextColumnIndices: readonly number[];
  rawTextValidationUnavailable?: boolean;
  textEncoding: CellTextEncoding;
  rows: CellValue[][];
  oversizedCells?: OversizedCellMap;
  exactIntegerTexts?: ExactIntegerTextMap;
  effectiveInlineCellBytes: number;
  rowOffset?: number;
}

export interface PrimaryKeyContainmentResult {
  rows: CellValue[][];
  oversizedCells?: OversizedCellMap;
  exactIntegerTexts?: ExactIntegerTextMap;
  readOnlyRowReasons?: ReadOnlyRowReasonMap;
  /** Engine-internal only: these source rows cannot safely mint seek anchors. */
  unrepresentableTextKeyRows?: ReadonlySet<number>;
}

function remapSparseColumns<T>(
  source: Record<number, Record<number, T>> | undefined,
  visibleColumnCount: number
): Record<number, Record<number, T>> | undefined {
  if (!source) return undefined;
  let remapped: Record<number, Record<number, T>> | undefined;
  for (const [rowIndexText, sourceRow] of Object.entries(source)) {
    for (const [columnIndexText, value] of Object.entries(sourceRow)) {
      const columnIndex = Number(columnIndexText);
      if (columnIndex >= visibleColumnCount) continue;
      remapped ??= {};
      remapped[Number(rowIndexText)] ??= {};
      remapped[Number(rowIndexText)][columnIndex + 1] = value;
    }
  }
  return remapped;
}

function omitSparseColumn<T>(
  source: Record<number, Record<number, T>> | undefined,
  omittedColumn: number
): Record<number, Record<number, T>> | undefined {
  if (!source) return undefined;
  let retained: Record<number, Record<number, T>> | undefined;
  for (const [rowIndexText, sourceRow] of Object.entries(source)) {
    for (const [columnIndexText, value] of Object.entries(sourceRow)) {
      const columnIndex = Number(columnIndexText);
      if (columnIndex === omittedColumn) continue;
      retained ??= {};
      retained[Number(rowIndexText)] ??= {};
      retained[Number(rowIndexText)][columnIndex] = value;
    }
  }
  return retained;
}

export interface ShadowedRowIdContainmentInput {
  rows: CellValue[][];
  oversizedCells?: OversizedCellMap;
  exactIntegerTexts?: ExactIntegerTextMap;
  rowOffset?: number;
}

/**
 * A declared `rowid` column makes every literal-rowid locator in the current
 * identity contract resolve to user data instead of SQLite's intrinsic row.
 * Keep the values viewable, but replace the synthetic leading identity with a
 * non-mutable token. The duplicate visible `rowid` column remains untouched.
 */
export function remapShadowedRowIdContainment(
  input: ShadowedRowIdContainmentInput
): PrimaryKeyContainmentResult {
  const reason =
    'Row is read-only because a declared "rowid" column shadows SQLite\'s intrinsic row identity.';
  const rowOffset = Number.isSafeInteger(input.rowOffset) && (input.rowOffset ?? 0) >= 0
    ? input.rowOffset!
    : 0;
  let readOnlyRowReasons: ReadOnlyRowReasonMap | undefined;
  const rows = input.rows.map((row, rowIndex) => {
    if (row.length === 0) {
      throw new Error(`Shadowed rowid result row ${rowIndex} has no identity slot`);
    }
    const rowOrdinal = rowOffset + rowIndex;
    if (!Number.isSafeInteger(rowOrdinal)) {
      throw new Error('Shadowed rowid result ordinal exceeds the safe integer range');
    }
    readOnlyRowReasons ??= {};
    readOnlyRowReasons[rowIndex] = reason;
    return [
      encodeReadOnlyPrimaryKeyRecordId(reason, rowOrdinal),
      ...row.slice(1)
    ];
  });
  // The replaced identity value no longer has numeric/oversized sidecar data.
  // A second, visible declared `rowid` column retains its own metadata slot.
  const oversizedCells = omitSparseColumn(input.oversizedCells, 0) as OversizedCellMap | undefined;
  const exactIntegerTexts = omitSparseColumn(
    input.exactIntegerTexts,
    0
  ) as ExactIntegerTextMap | undefined;

  const aggregateBudget =
    DEFAULT_MAX_WEBVIEW_AGGREGATE_PAYLOAD_BYTES - WEBVIEW_GRID_RESPONSE_HEADROOM_BYTES;
  const aggregateBytes = estimateRowsWireBytes(rows)
    + estimateOversizedCellsWireBytes(oversizedCells)
    + estimateExactIntegerTextsWireBytes(exactIntegerTexts)
    + estimateReadOnlyRowReasonsWireBytes(readOnlyRowReasons);
  if (aggregateBytes > aggregateBudget) {
    throw new Error(
      `Cell containment cannot fit this page within the ` +
      `${DEFAULT_MAX_WEBVIEW_AGGREGATE_PAYLOAD_BYTES}-byte transport limit`
    );
  }

  return {
    rows,
    ...(oversizedCells ? { oversizedCells } : {}),
    ...(exactIntegerTexts ? { exactIntegerTexts } : {}),
    ...(readOnlyRowReasons ? { readOnlyRowReasons } : {})
  };
}

function boundedReasonIdentifier(identifier: string): string {
  const retained = identifier.length <= 128
    ? identifier
    : `${identifier.slice(0, 125)}...`;
  return `"${retained}"`;
}

function boundedReasonColumnList(columns: readonly string[]): string {
  const retained = columns.slice(0, 8).map(boundedReasonIdentifier);
  return columns.length > retained.length
    ? `${retained.join(', ')}, and ${columns.length - retained.length} more`
    : retained.join(', ');
}

function readOnlyPrimaryKeyReason(
  members: Array<{ identifier: string; byteLength: number }>,
  inlineLimit: number
): string {
  if (members.length === 1) {
    const member = members[0];
    return (
      `Row is read-only because WITHOUT ROWID primary-key column ` +
      `${boundedReasonIdentifier(member.identifier)} is ${member.byteLength} bytes and exceeds the ` +
      `${inlineLimit}-byte inline limit; its identity was not transported.`
    );
  }
  const descriptions = members.slice(0, 8)
    .map(member => `${boundedReasonIdentifier(member.identifier)} (${member.byteLength} bytes)`);
  if (members.length > descriptions.length) {
    descriptions.push(`and ${members.length - descriptions.length} more`);
  }
  return (
    `Row is read-only because WITHOUT ROWID primary-key columns ${descriptions.join(', ')} ` +
    `exceed the ${inlineLimit}-byte inline limit; their identity was not transported.`
  );
}

function textEncodingLabel(encoding: CellTextEncoding): string {
  if (encoding === 'utf-8') return 'UTF-8';
  if (encoding === 'utf-16le') return 'UTF-16LE';
  return 'UTF-16BE';
}

/**
 * Project decoded PK values beside byte-exact TEXT companions. Mutation paths
 * use this inside their savepoint before minting an editable identity.
 */
export function buildByteFaithfulPrimaryKeyProjection(
  identity: Extract<TableIdentity, { kind: 'primaryKey' }>
): string {
  if (identity.columns.length * 2 > SQLITE_MAX_RESULT_COLUMNS) {
    throw new Error(
      `Cannot mint a byte-faithful WITHOUT ROWID identity with ` +
      `${identity.columns.length} primary-key columns within SQLite's result-column limit`
    );
  }
  const columns = identity.columns.map(column => escapeIdentifier(column.identifier));
  const rawColumns = columns.map((column, index) => (
    `CASE WHEN typeof(${column}) = 'text' THEN CAST(${column} AS BLOB) END AS ` +
    escapeIdentifier(`${CELL_RAW_TEXT_PREFIX}${index}`)
  ));
  return [...columns, ...rawColumns].join(', ');
}

/** Refuse a mutable identity whenever the engine's TEXT value lost bytes. */
export function encodeByteFaithfulPrimaryKeyRecordId(
  identity: Extract<TableIdentity, { kind: 'primaryKey' }>,
  projectedRow: readonly unknown[],
  textEncoding: CellTextEncoding,
  context: string
): RecordId {
  const keyCount = identity.columns.length;
  if (projectedRow.length !== keyCount * 2) {
    throw new Error(`${context}: SQLite returned an invalid primary-key validation row`);
  }
  const values = projectedRow.slice(0, keyCount) as Array<CellValue | bigint>;
  const decoder = new TextDecoder(textEncoding, { fatal: true, ignoreBOM: true });
  for (let index = 0; index < keyCount; index++) {
    const value = values[index];
    if (typeof value !== 'string') continue;
    const rawBytes = projectedRow[keyCount + index];
    const representable = rawBytes instanceof Uint8Array
      && decodedTextReproducesBytes(decoder, rawBytes, value);
    if (!representable) {
      throw new Error(
        `${context}: WITHOUT ROWID primary-key column ` +
        `"${identity.columns[index].identifier}" contains text that is not valid ` +
        `${textEncodingLabel(textEncoding)} without changing its stored bytes, ` +
        `or that contains a NUL character; a byte-faithful editable identity cannot be minted`
      );
    }
  }
  return encodePrimaryKeyRecordId(identity.columns, values);
}

function readOnlyPrimaryKeyTextReason(
  columns: readonly string[],
  encoding: CellTextEncoding
): string {
  const names = boundedReasonColumnList(columns);
  return (
    `Row is read-only because WITHOUT ROWID primary-key ` +
    `${columns.length === 1 ? 'column' : 'columns'} ${names} contain text that is not valid ` +
    `${textEncodingLabel(encoding)} without changing its stored bytes, or that contains a NUL ` +
    `character; a byte-faithful editable identity cannot be minted.`
  );
}

function readOnlyPrimaryKeyValidationReason(columns: readonly string[]): string {
  const names = columns.length === 1
    ? boundedReasonIdentifier(columns[0])
    : `${columns.length}-column key (${boundedReasonColumnList(columns)})`;
  return (
    `Row is read-only because WITHOUT ROWID primary-key ` +
    `${columns.length === 1 ? 'column' : 'columns'} ${names} could not be byte-validated ` +
    `without exceeding SQLite's result-column limit.`
  );
}

/** Synthesize only complete WITHOUT ROWID identities and shift visible sidecars. */
export function remapPrimaryKeyContainment(
  input: PrimaryKeyContainmentInput
): PrimaryKeyContainmentResult {
  const primaryKeyIndices = input.identity.columns.map(column => {
    const index = input.sourceColumns.indexOf(column.identifier);
    if (index < 0) {
      throw new Error(`Primary-key column missing from table fetch: ${column.identifier}`);
    }
    return index;
  });
  const rowOffset = Number.isSafeInteger(input.rowOffset) && (input.rowOffset ?? 0) >= 0
    ? input.rowOffset!
    : 0;
  let readOnlyRowReasons: ReadOnlyRowReasonMap | undefined;
  let unrepresentableTextKeyRows: Set<number> | undefined;
  const mutableRecordIdRows: number[] = [];
  const textDecoder = new TextDecoder(input.textEncoding, { fatal: true, ignoreBOM: true });
  const rawTextSlots = input.rawTextValidationUnavailable
    ? []
    : primaryKeyIndices.map(columnIndex => {
        const slot = input.rawTextColumnIndices.indexOf(columnIndex);
        if (slot < 0) {
          throw new Error(`Primary-key raw TEXT column ${columnIndex} was not projected`);
        }
        return slot;
      });
  const rows = input.rows.map((row, rowIndex) => {
    const oversizedMembers = input.identity.columns.flatMap((column, keyIndex) => {
      const metadata = input.oversizedCells?.[rowIndex]?.[primaryKeyIndices[keyIndex]];
      return metadata ? [{ identifier: column.identifier, byteLength: metadata.byteLength }] : [];
    });
    const identityRow = input.identityRows[rowIndex];
    if (!identityRow) throw new Error(`Primary-key identity row missing at index ${rowIndex}`);
    const rawTextRow = input.rawTextBytes[rowIndex];
    if (
      !input.rawTextValidationUnavailable
      && (!rawTextRow || rawTextRow.length !== input.rawTextColumnIndices.length)
    ) {
      throw new Error(`Primary-key raw TEXT row missing at index ${rowIndex}`);
    }
    // A byte-invalid TEXT key, or one containing NUL, also has a sparse
    // containment entry so the grid routes it to the raw inspector. Validate
    // its authoritative bytes before classifying that entry as merely
    // size-contained; otherwise a one-byte malformed key is mislabeled as
    // exceeding an 800+ KiB inline limit.
    const unrepresentableTextMembers = input.rawTextValidationUnavailable
      ? input.identity.columns.map(column => column.identifier)
      : input.identity.columns.flatMap((column, keyIndex) => {
          const value = identityRow[primaryKeyIndices[keyIndex]];
          if (typeof value !== 'string') return [];
          const containment = input.oversizedCells?.[rowIndex]?.[primaryKeyIndices[keyIndex]];
          if (containment && containment.byteLength > input.effectiveInlineCellBytes) {
            // SQL deliberately returned only a bounded prefix, so comparing it
            // with the complete raw companion would manufacture an encoding
            // mismatch. The size-containment reason is authoritative here.
            return [];
          }
          const rawBytes = rawTextRow[rawTextSlots[keyIndex]];
          if (rawBytes === VERIFIED_TEXT_BYTES) return [];
          if (!(rawBytes instanceof Uint8Array)) return [column.identifier];
          return decodedTextReproducesBytes(textDecoder, rawBytes, value) ? [] : [column.identifier];
        });
    let recordId;
    if (input.rawTextValidationUnavailable) {
      unrepresentableTextKeyRows ??= new Set();
      unrepresentableTextKeyRows.add(rowIndex);
    }
    if (unrepresentableTextMembers.length > 0) {
      const reason = input.rawTextValidationUnavailable
        ? readOnlyPrimaryKeyValidationReason(unrepresentableTextMembers)
        : readOnlyPrimaryKeyTextReason(unrepresentableTextMembers, input.textEncoding);
      readOnlyRowReasons ??= {};
      readOnlyRowReasons[rowIndex] = reason;
      unrepresentableTextKeyRows ??= new Set();
      unrepresentableTextKeyRows.add(rowIndex);
      recordId = encodeReadOnlyPrimaryKeyRecordId(reason, rowOffset + rowIndex);
    } else if (oversizedMembers.length > 0) {
      const reason = readOnlyPrimaryKeyReason(
        oversizedMembers,
        input.effectiveInlineCellBytes
      );
      readOnlyRowReasons ??= {};
      readOnlyRowReasons[rowIndex] = reason;
      recordId = encodeReadOnlyPrimaryKeyRecordId(reason, rowOffset + rowIndex);
    } else {
      recordId = encodePrimaryKeyRecordId(
        input.identity.columns,
        primaryKeyIndices.map(index => identityRow[index])
      );
      mutableRecordIdRows.push(rowIndex);
    }
    return [recordId, ...row.slice(0, input.visibleColumnCount)];
  });

  const oversizedCells = remapSparseColumns(
    input.oversizedCells,
    input.visibleColumnCount
  ) as OversizedCellMap | undefined;
  const exactIntegerTexts = remapSparseColumns(
    input.exactIntegerTexts,
    input.visibleColumnCount
  ) as ExactIntegerTextMap | undefined;

  // PK identities are URL-encoded after the source-cell budget has already
  // run. Account for that expansion against the same response headroom and
  // tail-downgrade identities to bounded read-only tokens when necessary.
  const aggregateBudget =
    DEFAULT_MAX_WEBVIEW_AGGREGATE_PAYLOAD_BYTES - WEBVIEW_GRID_RESPONSE_HEADROOM_BYTES;
  let aggregateBytes = estimateRowsWireBytes(rows)
    + estimateOversizedCellsWireBytes(oversizedCells)
    + estimateExactIntegerTextsWireBytes(exactIntegerTexts)
    + estimateReadOnlyRowReasonsWireBytes(readOnlyRowReasons);
  const transportBudgetReason =
    'Row is read-only because its encoded WITHOUT ROWID primary-key identity ' +
    'exceeds the page transport budget.';

  const reasonInsertionBytes = (rowIndex: number): number => {
    if (readOnlyRowReasons?.[rowIndex] !== undefined) return 0;
    const entryBytes = objectKeyWireBytes(String(rowIndex))
      + transportedCellWireBytes(transportBudgetReason);
    return readOnlyRowReasons ? 1 + entryBytes : 2 + entryBytes;
  };

  for (
    let index = mutableRecordIdRows.length - 1;
    index >= 0 && aggregateBytes > aggregateBudget;
    index--
  ) {
    const rowIndex = mutableRecordIdRows[index];
    const currentRecordId = rows[rowIndex][0];
    const readOnlyRecordId = encodeReadOnlyPrimaryKeyRecordId(
      transportBudgetReason,
      rowOffset + rowIndex
    );
    const delta = transportedCellWireBytes(readOnlyRecordId)
      - transportedCellWireBytes(currentRecordId)
      + reasonInsertionBytes(rowIndex);
    if (delta >= 0) continue;
    rows[rowIndex][0] = readOnlyRecordId;
    readOnlyRowReasons ??= {};
    readOnlyRowReasons[rowIndex] = transportBudgetReason;
    aggregateBytes += delta;
  }

  if (aggregateBytes > aggregateBudget) {
    throw new Error(
      `Cell containment cannot fit this page within the ` +
      `${DEFAULT_MAX_WEBVIEW_AGGREGATE_PAYLOAD_BYTES}-byte transport limit`
    );
  }

  return {
    rows,
    ...(oversizedCells ? { oversizedCells } : {}),
    ...(exactIntegerTexts ? { exactIntegerTexts } : {}),
    ...(readOnlyRowReasons ? { readOnlyRowReasons } : {}),
    ...(unrepresentableTextKeyRows ? { unrepresentableTextKeyRows } : {})
  };
}
