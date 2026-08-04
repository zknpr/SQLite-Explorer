import { escapeIdentifier } from './sql-utils';
import type {
  CellValue,
  ExactIntegerTextMap,
  OversizedCellMap,
  ReadOnlyRowReasonMap,
  TableIdentity,
  TableQueryOptions
} from './types';
import {
  encodePrimaryKeyRecordId,
  encodeReadOnlyPrimaryKeyRecordId
} from './row-identity';

export const DEFAULT_MAX_INLINE_CELL_BYTES = 1024 * 1024;
export const DEFAULT_MAX_PAGE_RESPONSE_BYTES = 16 * 1024 * 1024;

const CELL_SOURCE_ALIAS = '__sqlite_explorer_cell_source';
const CELL_VALUE_PREFIX = '__sqlite_explorer_cell_value_';
const CELL_METADATA_ALIAS = '__sqlite_explorer_cell_metadata';
const METADATA_CHUNK_COLUMNS = 400;
const MAX_UTF8_BYTES_PER_CODE_POINT = 4;

export interface CellContainmentQuery {
  sql: string;
  /** Original value columns, excluding the packed metadata transport column. */
  valueColumnCount: number;
  /** Value-column index occupied by the packed metadata transport column. */
  metadataColumnIndex: number;
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
 * Divide the page budget over every requested value slot, then apply the
 * configured per-cell ceiling. An omitted LIMIT retains legacy query behavior;
 * its per-cell cap still applies, but there is no claimed page cardinality to
 * divide across.
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
  const pageWindow = Number.isSafeInteger(pageSlots)
    ? Math.floor(maxPageResponseBytes / pageSlots)
    : 0;
  return Math.min(maxInlineCellBytes, pageWindow);
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
  options: Pick<TableQueryOptions, 'limit' | 'maxInlineCellBytes' | 'maxPageResponseBytes'>
): CellContainmentQuery {
  const effectiveInlineCellBytes = deriveEffectiveInlineCellBytes(options, columnCount);
  const textCharacterWindow = Math.floor(
    effectiveInlineCellBytes / MAX_UTF8_BYTES_PER_CODE_POINT
  );
  const valueNames = Array.from({ length: columnCount }, (_, index) => (
    `${CELL_VALUE_PREFIX}${index}`
  ));
  const quotedValues = valueNames.map(escapeIdentifier);
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

  return {
    // OFFSET prevents query flattening so volatile view expressions are
    // evaluated once before their value, typeof, and octet_length are reused.
    sql:
      `WITH ${quotedSource} (${quotedValues.join(', ')}) AS (\n` +
      `SELECT * FROM (\n${sourceSql}\n) LIMIT -1 OFFSET 0\n)\n` +
      `SELECT ${projectedValues.join(', ')}, ` +
      `${metadataExpression} AS ${escapeIdentifier(CELL_METADATA_ALIAS)} ` +
      `FROM ${quotedSource}`,
    valueColumnCount: columnCount,
    metadataColumnIndex: columnCount,
    effectiveInlineCellBytes
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

/** Strip the private metadata column and return sparse, positionally exact sidecars. */
export function decodeCellContainment(
  transportedRows: readonly (readonly unknown[])[],
  valueColumnCount: number,
  exactIntegerTexts?: ExactIntegerTextMap
): DecodedCellContainment {
  let oversizedCells: OversizedCellMap | undefined;
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
    tokens.forEach((token, columnIndex) => {
      const metadata = parseMetadataToken(token, rowIndex, columnIndex);
      if (!metadata) return;
      oversizedCells ??= {};
      oversizedCells[rowIndex] ??= {};
      oversizedCells[rowIndex][columnIndex] = metadata;
    });
    return Array.from(row.slice(0, valueColumnCount)) as CellValue[];
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

function readOnlyPrimaryKeyReason(
  members: Array<{ identifier: string; byteLength: number }>,
  inlineLimit: number
): string {
  if (members.length === 1) {
    const member = members[0];
    return (
      `Row is read-only because WITHOUT ROWID primary-key column ` +
      `"${member.identifier}" is ${member.byteLength} bytes and exceeds the ` +
      `${inlineLimit}-byte inline limit; its identity was not transported.`
    );
  }
  const descriptions = members
    .map(member => `"${member.identifier}" (${member.byteLength} bytes)`)
    .join(', ');
  return (
    `Row is read-only because WITHOUT ROWID primary-key columns ${descriptions} ` +
    `exceed the ${inlineLimit}-byte inline limit; their identity was not transported.`
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
  const rows = input.rows.map((row, rowIndex) => {
    const oversizedMembers = input.identity.columns.flatMap((column, keyIndex) => {
      const metadata = input.oversizedCells?.[rowIndex]?.[primaryKeyIndices[keyIndex]];
      return metadata ? [{ identifier: column.identifier, byteLength: metadata.byteLength }] : [];
    });
    let recordId;
    if (oversizedMembers.length > 0) {
      const reason = readOnlyPrimaryKeyReason(
        oversizedMembers,
        input.effectiveInlineCellBytes
      );
      readOnlyRowReasons ??= {};
      readOnlyRowReasons[rowIndex] = reason;
      recordId = encodeReadOnlyPrimaryKeyRecordId(reason, rowOffset + rowIndex);
    } else {
      const identityRow = input.identityRows[rowIndex];
      if (!identityRow) throw new Error(`Primary-key identity row missing at index ${rowIndex}`);
      recordId = encodePrimaryKeyRecordId(
        input.identity.columns,
        primaryKeyIndices.map(index => identityRow[index])
      );
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
  return {
    rows,
    ...(oversizedCells ? { oversizedCells } : {}),
    ...(exactIntegerTexts ? { exactIntegerTexts } : {}),
    ...(readOnlyRowReasons ? { readOnlyRowReasons } : {})
  };
}
