import { escapeIdentifier } from './sql-utils';
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
const METADATA_CHUNK_COLUMNS = 400;
const MAX_UTF8_BYTES_PER_CODE_POINT = 4;
// Both bundled SQLite builds use SQLite's default SQLITE_MAX_COLUMN. Private
// raw-TEXT companions must never turn an otherwise valid grid projection into
// a statement that exceeds this result-column ceiling.
export const SQLITE_MAX_RESULT_COLUMNS = 2000;

export interface CellContainmentQuery {
  sql: string;
  /** Separate one-column metadata read when the value projection fills SQLite's width. */
  metadataSql?: string;
  /** Columns returned by sql before separately fetched metadata is inserted. */
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
  /** Source-column indices actually represented by private raw-TEXT slots. */
  rawTextColumnIndices: readonly number[];
  /** Requested raw validation was omitted to stay within SQLite's width cap. */
  rawTextValidationUnavailable: boolean;
  effectiveInlineCellBytes: number;
}

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

/** Keep metadata in one packed column so wide grids do not triple result width. */
function buildPackedMetadataExpression(columns: string[], byteLimit: number): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < columns.length; offset += METADATA_CHUNK_COLUMNS) {
    const tokens = columns.slice(offset, offset + METADATA_CHUNK_COLUMNS)
      .map(column => metadataToken(column, byteLimit));
    const compound = tokens.map((token, index) => (
      `${index === 0 ? 'SELECT' : 'UNION ALL SELECT'} ${token} AS "cell"`
    )).join('\n');
    chunks.push(`(SELECT group_concat("cell", '|') FROM (\n${compound}\n))`);
  }
  return chunks.join(` || '|' || `);
}

/**
 * Wrap a filtered/ordered/paginated SELECT and project only bounded TEXT/BLOB
 * windows. The inner SELECT continues to own WHERE and ORDER BY semantics.
 */
export function buildCellContainmentQuery(
  sourceSql: string,
  columnCount: number,
  options: Pick<TableQueryOptions, 'limit' | 'maxInlineCellBytes' | 'maxPageResponseBytes'>,
  rawTextColumnIndices: readonly number[] = []
): CellContainmentQuery {
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
  const projectedValues = quotedValues.map((column, index) => (
    `CASE ` +
    `WHEN typeof(${column}) = 'text' AND octet_length(${column}) > ${effectiveInlineCellBytes} ` +
    `THEN substr(${column}, 1, ${textCharacterWindow}) ` +
    `WHEN typeof(${column}) = 'blob' AND octet_length(${column}) > ${effectiveInlineCellBytes} ` +
    `THEN substr(${column}, 1, ${effectiveInlineCellBytes}) ` +
    `ELSE ${column} END AS ${escapeIdentifier(valueNames[index])}`
  ));
  const quotedSource = escapeIdentifier(CELL_SOURCE_ALIAS);
  const metadataExpression = buildPackedMetadataExpression(
    quotedValues,
    effectiveInlineCellBytes
  );
  const rawTextExpressions = projectedRawTextColumnIndices.map((columnIndex, keyIndex) => {
    const column = quotedValues[columnIndex];
    return (
      `CASE WHEN typeof(${column}) = 'text' ` +
      `AND octet_length(${column}) <= ${effectiveInlineCellBytes} ` +
      `THEN CAST(${column} AS BLOB) END AS ` +
      `${escapeIdentifier(`${CELL_RAW_TEXT_PREFIX}${keyIndex}`)}`
    );
  });
  const privateProjection = rawTextExpressions.length > 0
    ? `, ${rawTextExpressions.join(', ')}`
    : '';
  const sourceCte =
    `WITH ${quotedSource} (${quotedValues.join(', ')}) AS (\n` +
    `SELECT * FROM (\n${sourceSql}\n) LIMIT -1 OFFSET 0\n)\n`;
  const metadataMustBeFetchedSeparately = columnCount + 1 > SQLITE_MAX_RESULT_COLUMNS;
  const primaryMetadataProjection = metadataMustBeFetchedSeparately
    ? ''
    : `, ${metadataExpression} AS ${escapeIdentifier(CELL_METADATA_ALIAS)}`;

  return {
    // OFFSET prevents query flattening so volatile view expressions are
    // evaluated once before their value, typeof, and octet_length are reused.
    sql:
      sourceCte +
      `SELECT ${projectedValues.join(', ')}` +
      `${primaryMetadataProjection}${privateProjection} ` +
      `FROM ${quotedSource}`,
    ...(metadataMustBeFetchedSeparately ? {
      // Grid callers execute this before releasing the same serialized read
      // (and, for native files, the same WAL snapshot) as the value query.
      metadataSql:
        sourceCte +
        `SELECT ${metadataExpression} AS ${escapeIdentifier(CELL_METADATA_ALIAS)} ` +
        `FROM ${quotedSource}`
    } : {}),
    primaryTransportColumnCount:
      columnCount + (metadataMustBeFetchedSeparately ? 0 : 1) + projectedRawTextColumnIndices.length,
    valueColumnCount: columnCount,
    metadataColumnIndex: columnCount,
    transportColumnCount: columnCount + 1 + projectedRawTextColumnIndices.length,
    rawTextColumnStart: columnCount + 1,
    rawTextColumnCount: projectedRawTextColumnIndices.length,
    rawTextColumnIndices: projectedRawTextColumnIndices,
    rawTextValidationUnavailable,
    effectiveInlineCellBytes
  };
}

/** Insert a separately fetched metadata column at its logical transport slot. */
export function mergeCellContainmentMetadataRows(
  primaryRows: readonly (readonly unknown[])[],
  metadataRows: readonly (readonly unknown[])[] | undefined,
  query: Pick<
    CellContainmentQuery,
    'metadataSql' | 'metadataColumnIndex' | 'primaryTransportColumnCount'
  >
): Array<Array<unknown>> {
  if (!query.metadataSql) {
    if (metadataRows !== undefined) {
      throw new Error('Cell containment received unexpected separate metadata rows');
    }
    return primaryRows as Array<Array<unknown>>;
  }
  if (metadataRows === undefined) {
    if (primaryRows.length === 0) return [];
    throw new Error('Cell containment metadata row count does not match the value page');
  }
  if (metadataRows.length !== primaryRows.length) {
    throw new Error('Cell containment metadata row count does not match the value page');
  }

  return primaryRows.map((row, rowIndex) => {
    if (row.length < query.primaryTransportColumnCount) {
      throw new Error(`Cell containment value row ${rowIndex} is missing transport columns`);
    }
    const metadataRow = metadataRows[rowIndex];
    if (!metadataRow || metadataRow.length !== 1 || typeof metadataRow[0] !== 'string') {
      throw new Error(`Cell containment metadata row ${rowIndex} is not one packed text value`);
    }
    return [
      ...row.slice(0, query.metadataColumnIndex),
      metadataRow[0],
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
  query: Pick<CellContainmentQuery, 'rawTextColumnStart' | 'rawTextColumnCount' | 'transportColumnCount'>
): Array<Array<Uint8Array | null>> {
  return rows.map((row, rowIndex) => {
    if (row.length < query.transportColumnCount) {
      throw new Error(`Raw TEXT row ${rowIndex} is missing private transport columns`);
    }
    return Array.from({ length: query.rawTextColumnCount }, (_, keyIndex) => {
      const value = row[query.rawTextColumnStart + keyIndex];
      if (value !== null && !(value instanceof Uint8Array)) {
        throw new Error(`Raw TEXT value at row ${rowIndex}, key ${keyIndex} is not a BLOB`);
      }
      return value;
    });
  });
}

/** Identify rows whose decoded TEXT cells cannot reproduce SQLite's bytes. */
export function findUnrepresentableTextRows(input: {
  sourceRows: readonly (readonly unknown[])[];
  sourceColumnIndices: readonly number[];
  rawTextRows: readonly (readonly (Uint8Array | null)[])[];
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
      let representable = false;
      if (rawBytes instanceof Uint8Array) {
        try {
          representable = decoder.decode(rawBytes) === value;
        } catch {
          representable = false;
        }
      }
      if (!representable) {
        unrepresentableRows ??= new Set();
        unrepresentableRows.add(rowIndex);
        break;
      }
    }
  });
  return unrepresentableRows;
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

function utf8ByteLength(value: string): number {
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
  maxPageResponseBytes: number = DEFAULT_MAX_PAGE_RESPONSE_BYTES
): DecodedCellContainment {
  const pageByteBudget = positiveIntegerOr(
    maxPageResponseBytes,
    DEFAULT_MAX_PAGE_RESPONSE_BYTES
  );
  let oversizedCells: OversizedCellMap | undefined;
  let inlineBytes = 0;
  let pageBudgetExhausted = false;
  const retainedInlineCells: Array<{
    rowIndex: number;
    columnIndex: number;
    metadata: { storageClass: 'text' | 'blob'; byteLength: number };
  }> = [];

  const recordOversizedCell = (
    rowIndex: number,
    columnIndex: number,
    metadata: { storageClass: 'text' | 'blob'; byteLength: number }
  ): void => {
    oversizedCells ??= {};
    oversizedCells[rowIndex] ??= {};
    oversizedCells[rowIndex][columnIndex] ??= metadata;
  };

  const rows = transportedRows.map((row, rowIndex) => {
    if (row.length < valueColumnCount + 1) {
      throw new Error(
        `Cell containment row ${rowIndex} has ${row.length} values; ` +
        `expected at least ${valueColumnCount + 1}`
      );
    }
    const packed = row[valueColumnCount];
    if (typeof packed !== 'string') {
      throw new Error(`Cell containment metadata at row ${rowIndex} is not text`);
    }
    const tokens = packed.split('|');
    if (tokens.length !== valueColumnCount) {
      throw new Error(
        `Cell containment metadata at row ${rowIndex} has ${tokens.length} entries; ` +
        `expected ${valueColumnCount}`
      );
    }
    const values = Array.from(row.slice(0, valueColumnCount)) as CellValue[];
    tokens.forEach((token, columnIndex) => {
      const sqlMetadata = parseMetadataToken(token, rowIndex, columnIndex);
      if (sqlMetadata) recordOversizedCell(rowIndex, columnIndex, sqlMetadata);

      const value = values[columnIndex];
      const byteLength = inlineCellByteLength(value);
      if (byteLength === undefined || byteLength === 0) return;
      const metadata = sqlMetadata ?? {
        storageClass: typeof value === 'string' ? 'text' as const : 'blob' as const,
        byteLength
      };

      if (
        pageBudgetExhausted
        || byteLength > pageByteBudget - inlineBytes
      ) {
        pageBudgetExhausted = true;
        recordOversizedCell(rowIndex, columnIndex, metadata);
        values[columnIndex] = emptyInlinePreview(metadata.storageClass);
        return;
      }

      inlineBytes += byteLength;
      retainedInlineCells.push({ rowIndex, columnIndex, metadata });
    });
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
  let aggregateBytes = estimateRowsWireBytes(rows)
    + estimateOversizedCellsWireBytes(oversizedCells)
    + estimateExactIntegerTextsWireBytes(retainedExactIntegerTexts);

  const metadataInsertionBytes = (rowIndex: number, columnIndex: number): number => {
    if (oversizedCells?.[rowIndex]?.[columnIndex]) return 0;
    const columnBytes = objectKeyWireBytes(String(columnIndex))
      + OVERSIZED_CELL_METADATA_VALUE_BYTES;
    const existingRow = oversizedCells?.[rowIndex];
    if (existingRow) return 1 + columnBytes;
    const rowBytes = objectKeyWireBytes(String(rowIndex)) + 2 + columnBytes;
    if (oversizedCells) return 1 + rowBytes;
    return 2 + rowBytes;
  };

  for (
    let index = retainedInlineCells.length - 1;
    index >= 0 && aggregateBytes > aggregateBudget;
    index--
  ) {
    const candidate = retainedInlineCells[index];
    const currentValue = rows[candidate.rowIndex][candidate.columnIndex];
    const emptyValue = emptyInlinePreview(candidate.metadata.storageClass);
    const delta = transportedCellWireBytes(emptyValue)
      - transportedCellWireBytes(currentValue)
      + metadataInsertionBytes(candidate.rowIndex, candidate.columnIndex);
    if (delta >= 0) continue;
    recordOversizedCell(candidate.rowIndex, candidate.columnIndex, candidate.metadata);
    rows[candidate.rowIndex][candidate.columnIndex] = emptyValue;
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
  rawTextBytes: readonly (readonly (Uint8Array | null)[])[];
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
    let representable = false;
    if (rawBytes instanceof Uint8Array) {
      try {
        representable = decoder.decode(rawBytes) === value;
      } catch {
        representable = false;
      }
    }
    if (!representable) {
      throw new Error(
        `${context}: WITHOUT ROWID primary-key column ` +
        `"${identity.columns[index].identifier}" contains text that is not valid ` +
        `${textEncodingLabel(textEncoding)} without changing its stored bytes; ` +
        `a byte-faithful editable identity cannot be minted`
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
    `${textEncodingLabel(encoding)} without changing its stored bytes; ` +
    `a byte-faithful editable identity cannot be minted.`
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
    const unrepresentableTextMembers = oversizedMembers.length > 0
      ? []
      : input.rawTextValidationUnavailable
        ? input.identity.columns.map(column => column.identifier)
        : input.identity.columns.flatMap((column, keyIndex) => {
          const value = identityRow[primaryKeyIndices[keyIndex]];
          if (typeof value !== 'string') return [];
          const rawBytes = rawTextRow[rawTextSlots[keyIndex]];
          if (!(rawBytes instanceof Uint8Array)) return [column.identifier];
          try {
            return textDecoder.decode(rawBytes) === value ? [] : [column.identifier];
          } catch {
            return [column.identifier];
          }
          });
    let recordId;
    if (input.rawTextValidationUnavailable) {
      unrepresentableTextKeyRows ??= new Set();
      unrepresentableTextKeyRows.add(rowIndex);
    }
    if (oversizedMembers.length > 0) {
      const reason = readOnlyPrimaryKeyReason(
        oversizedMembers,
        input.effectiveInlineCellBytes
      );
      readOnlyRowReasons ??= {};
      readOnlyRowReasons[rowIndex] = reason;
      recordId = encodeReadOnlyPrimaryKeyRecordId(reason, rowOffset + rowIndex);
    } else if (unrepresentableTextMembers.length > 0) {
      const reason = input.rawTextValidationUnavailable
        ? readOnlyPrimaryKeyValidationReason(unrepresentableTextMembers)
        : readOnlyPrimaryKeyTextReason(unrepresentableTextMembers, input.textEncoding);
      readOnlyRowReasons ??= {};
      readOnlyRowReasons[rowIndex] = reason;
      unrepresentableTextKeyRows ??= new Set();
      unrepresentableTextKeyRows.add(rowIndex);
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
