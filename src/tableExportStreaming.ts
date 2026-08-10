import type {
  CellMetadata,
  CellReadSession,
  CellStorageClass,
  CellTextEncoding,
  CellValue,
  DatabaseOperations,
  ExportOptions,
  RecordId,
  TableIdentity
} from './core/types';
import { crypto as webCrypto } from './platform/cryptoShim';
import { escapeIdentifier, validateRowId } from './core/sql-utils';
import { normalizeCellTextEncoding } from './core/cell-read';
import {
  encodeCsvExportCell,
  encodeJsonExportCell,
  encodeSqlExportCell,
  getUnrepresentableTextExportEnvelope
} from './core/export-encoding';
import {
  buildRecordIdentityPredicate,
  buildRecordIdentityPredicateChunks,
  buildRecordIdentitiesPredicate,
  isPrimaryKeyRecordId,
  isReadOnlyPrimaryKeyRecordId
} from './core/row-identity';
import { runReadSnapshot } from './core/operation-serializer';
import { ROWID_TABLE_AUTHORITY_SQL } from './core/integer-utils';

/**
 * Source window selected so even the worst JSON control-character expansion
 * stays below a 1 MiB write. It also deliberately is not divisible by three,
 * exercising the Base64 carry instead of relying on a lucky chunk size.
 */
export const EXPORT_CELL_CHUNK_BYTES = 128 * 1024;

const EXPORT_ROW_BATCH_SIZE = 128;
const EXPORT_INLINE_TEXT_BYTES = 64 * 1024;
const UNSTABLE_CELL_INLINE_BYTES = 1024 * 1024;
const SQLITE_MAX_RESULT_COLUMNS = 2000;

export interface AsyncExportSink {
  /** Resolves only after the sink has accepted this emission. */
  write(chunk: string): Promise<void>;
}

export interface ExportCancellation {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested?: (
    listener: () => void
  ) => { dispose(): void };
}

interface ExportCell {
  table: string;
  column: string;
  rowId?: RecordId;
  snapshotPosition?: {
    orderByColumns: readonly string[];
    rowOffset: number;
    textEncoding: CellTextEncoding;
  };
  storageClass: CellStorageClass;
  byteLength: number;
  value: CellValue;
  unrepresentableTextBytes?: Uint8Array;
  textEncoding?: CellTextEncoding;
}

interface ExportRow {
  cells: ExportCell[];
}

interface ExportCellSession {
  session: Pick<CellReadSession, 'metadata'>;
  cell: ExportCell;
  readChunk(byteOffset: number, maxBytes: number): ReturnType<DatabaseOperations['readCellChunk']>;
}

function cancellationError(): Error {
  const error = new Error('Export cancelled');
  error.name = 'CancellationError';
  return error;
}

function assertNotCancelled(cancellation?: ExportCancellation): void {
  if (cancellation?.isCancellationRequested) throw cancellationError();
}

function bindCancellationSignal(cancellation?: ExportCancellation): {
  signal: AbortSignal | undefined;
  dispose(): void;
} {
  if (!cancellation) return { signal: undefined, dispose() {} };

  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort(cancellationError());
  };
  const subscription = cancellation.onCancellationRequested?.(abort);
  // Close the subscribe/check race for token implementations whose callback
  // registration does not synchronously report an earlier cancellation.
  if (cancellation.isCancellationRequested) abort();
  return {
    signal: controller.signal,
    dispose() {
      subscription?.dispose();
    }
  };
}

async function emit(
  sink: AsyncExportSink,
  chunk: string,
  cancellation?: ExportCancellation
): Promise<void> {
  if (chunk.length === 0) return;
  assertNotCancelled(cancellation);
  await sink.write(chunk);
  assertNotCancelled(cancellation);
}

function byteLength(value: unknown, context: string): number {
  const normalized = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || Number(normalized) < 0) {
    throw new Error(`SQLite returned an unsafe byte length for ${context}`);
  }
  return Number(normalized);
}

function buildCellProjection(
  columns: readonly string[],
  inlineBytes: number,
  includeInlineBlobs: boolean,
  sourceAlias?: string
): string {
  const qualifier = sourceAlias ? `${escapeIdentifier(sourceAlias)}.` : '';
  return columns.map((column, index) => {
    const escaped = `${qualifier}${escapeIdentifier(column)}`;
    const storageClass = `typeof(${escaped})`;
    const byteLength = `octet_length(${escaped})`;
    // One ASCII envelope per source column keeps even SQLite's 2,000-column
    // maximum exportable. Hex protects raw TEXT bytes (including malformed
    // database encodings) without asking the JS transport to decode them.
    return (
      `CASE ${storageClass} ` +
      `WHEN 'null' THEN 'n:0:' ` +
      `WHEN 'integer' THEN 'i:0:' || CAST(${escaped} AS TEXT) ` +
      `WHEN 'real' THEN 'r:0:' || printf('%!.17g', ${escaped}) ` +
      `WHEN 'text' THEN 't:' || CAST(${byteLength} AS TEXT) || ':' || ` +
      `CASE WHEN ${byteLength} <= ${inlineBytes} ` +
      `THEN hex(CAST(${escaped} AS BLOB)) ELSE '' END ` +
      `WHEN 'blob' THEN 'b:' || CAST(${byteLength} AS TEXT) || ':' || ` +
      (includeInlineBlobs
        ? `CASE WHEN ${byteLength} <= ${inlineBytes} THEN hex(${escaped}) ELSE '' END `
        : `'' `) +
      `END AS ${escapeIdentifier(`__export_cell_${index}`)}`
    );
  }).join(', ');
}

function decodePackedHex(
  payload: string,
  expectedBytes: number,
  context: string
): Uint8Array {
  if (payload.length !== expectedBytes * 2 || /[^0-9a-f]/i.test(payload)) {
    throw new Error(`SQLite returned invalid packed bytes for ${context}`);
  }
  const bytes = new Uint8Array(expectedBytes);
  for (let index = 0; index < expectedBytes; index++) {
    bytes[index] = Number.parseInt(payload.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function parsePackedCell(
  table: string,
  column: string,
  packed: CellValue,
  inlineBytes: number,
  includeInlineBlobs: boolean,
  textEncoding: CellTextEncoding,
  rowId?: RecordId,
  snapshotPosition?: ExportCell['snapshotPosition']
): ExportCell {
  const context = `${table}.${column}`;
  if (typeof packed !== 'string') {
    throw new Error(`SQLite returned an invalid packed export cell for ${context}`);
  }
  const firstSeparator = packed.indexOf(':');
  const secondSeparator = packed.indexOf(':', firstSeparator + 1);
  if (firstSeparator !== 1 || secondSeparator < 0) {
    throw new Error(`SQLite returned malformed packed export metadata for ${context}`);
  }
  const storageCode = packed[0];
  const lengthText = packed.slice(firstSeparator + 1, secondSeparator);
  if (!/^(?:0|[1-9][0-9]*)$/.test(lengthText)) {
    throw new Error(`SQLite returned an unsafe byte length for ${context}`);
  }
  const sourceBytes = byteLength(Number(lengthText), context);
  const payload = packed.slice(secondSeparator + 1);
  const storageClass: CellStorageClass = storageCode === 'n'
    ? 'null'
    : storageCode === 'i'
      ? 'integer'
      : storageCode === 'r'
        ? 'real'
        : storageCode === 't'
          ? 'text'
          : storageCode === 'b'
            ? 'blob'
            : (() => { throw new Error(`SQLite returned an invalid storage class for ${context}`); })();
  if ((storageClass === 'null' || storageClass === 'integer' || storageClass === 'real') && sourceBytes !== 0) {
    throw new Error(`SQLite returned invalid scalar byte metadata for ${context}`);
  }

  let value: CellValue;
  let unrepresentableTextBytes: Uint8Array | undefined;
  if (storageClass === 'null') {
    if (payload !== '') throw new Error(`SQLite returned a value for NULL cell ${context}`);
    value = null;
  } else if (storageClass === 'integer') {
    try {
      if (BigInt(payload).toString() !== payload) throw new Error();
    } catch {
      throw new Error(`SQLite returned non-canonical INTEGER text for ${context}`);
    }
    value = payload;
  } else if (storageClass === 'real') {
    value = payload === 'Inf'
      ? Number.POSITIVE_INFINITY
      : payload === '-Inf'
        ? Number.NEGATIVE_INFINITY
        : Number(payload);
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new Error(`SQLite returned invalid REAL text for ${context}`);
    }
  } else if (storageClass === 'text') {
    if (sourceBytes <= inlineBytes) {
      const bytes = decodePackedHex(payload, sourceBytes, context);
      try {
        value = new TextDecoder(textEncoding, { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        value = bytes;
        unrepresentableTextBytes = bytes;
      }
    } else {
      if (payload !== '') throw new Error(`SQLite returned oversized packed TEXT for ${context}`);
      value = null;
    }
  } else if (includeInlineBlobs && sourceBytes <= inlineBytes) {
    value = decodePackedHex(payload, sourceBytes, context);
  } else {
    if (payload !== '') throw new Error(`SQLite returned unexpected packed BLOB bytes for ${context}`);
    value = null;
  }

  return {
    table,
    column,
    rowId,
    ...(snapshotPosition ? { snapshotPosition } : {}),
    storageClass,
    byteLength: sourceBytes,
    value,
    ...(unrepresentableTextBytes === undefined
      ? {}
      : { unrepresentableTextBytes, textEncoding })
  };
}

function parseCells(
  table: string,
  columns: readonly string[],
  row: readonly CellValue[],
  startIndex: number,
  inlineBytes: number,
  includeInlineBlobs: boolean,
  textEncoding: CellTextEncoding,
  rowId?: RecordId,
  snapshotPosition?: ExportCell['snapshotPosition']
): ExportCell[] {
  const expectedLength = startIndex + columns.length;
  if (row.length !== expectedLength) {
    throw new Error(
      `Export row has ${row.length} values; expected ${expectedLength}`
    );
  }

  return columns.map((column, columnIndex) => parsePackedCell(
    table,
    column,
    row[startIndex + columnIndex],
    inlineBytes,
    includeInlineBlobs,
    textEncoding,
    rowId,
    snapshotPosition
  ));
}

async function resolveColumns(
  operations: DatabaseOperations,
  table: string,
  requestedColumns: readonly string[]
): Promise<string[]> {
  if (requestedColumns.length > 0) return [...requestedColumns];
  const result = await operations.executeQuery(
    `SELECT * FROM ${escapeIdentifier(table)} LIMIT 0`
  );
  const headers = result[0]?.headers;
  if (!headers) throw new Error(`Cannot resolve export columns for ${table}`);
  return [...headers];
}

async function resolveIdentity(
  operations: DatabaseOperations,
  table: string
): Promise<TableIdentity | undefined> {
  const schemaIdentity = typeof operations.fetchSchema === 'function'
    ? (await operations.fetchSchema()).tables
      .find(candidate => candidate.identifier === table)?.identity
    : undefined;
  if (schemaIdentity?.kind === 'primaryKey') return schemaIdentity;
  if (schemaIdentity === undefined && typeof operations.fetchSchema === 'function') {
    return undefined;
  }

  // Schema identity classifies ordinary rowid tables structurally, but export
  // seeks use the literal `rowid` alias. Reuse the canonical authority check so
  // a declared nullable/non-unique `rowid` column can never become a seek key.
  const authority = await operations.executeQuery(
    ROWID_TABLE_AUTHORITY_SQL,
    [table, table]
  );
  return (authority[0]?.rows.length ?? 0) > 0 ? { kind: 'rowid' } : undefined;
}

async function resolveTextEncoding(
  operations: DatabaseOperations
): Promise<CellTextEncoding> {
  const result = await operations.executeQuery('PRAGMA encoding');
  return normalizeCellTextEncoding(result[0]?.rows[0]?.[0]);
}

function recordIdKey(recordId: RecordId): string {
  return `${typeof recordId}:${String(recordId)}`;
}

function sortUniqueRowIdsForExport(recordIds: readonly RecordId[]): RecordId[] {
  const seen = new Set<string>();
  const unique: RecordId[] = [];
  for (const recordId of recordIds) {
    const normalized = validateRowId(recordId);
    const key = String(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(normalized);
  }
  unique.sort((left, right) => {
    const leftInteger = BigInt(left);
    const rightInteger = BigInt(right);
    return leftInteger < rightInteger ? -1 : leftInteger > rightInteger ? 1 : 0;
  });
  return unique;
}

async function* readRowIdTableRows(
  operations: DatabaseOperations,
  table: string,
  columns: readonly string[],
  selectedRowIds: readonly RecordId[],
  textEncoding: CellTextEncoding,
  cancellation?: ExportCancellation
): AsyncGenerator<ExportRow> {
  if (columns.length > SQLITE_MAX_RESULT_COLUMNS) {
    throw new Error(`Cannot export more than ${SQLITE_MAX_RESULT_COLUMNS} columns`);
  }
  const projection = buildCellProjection(columns, EXPORT_INLINE_TEXT_BYTES, false);
  const includeRowIdInProjection = columns.length < SQLITE_MAX_RESULT_COLUMNS;
  const selectedPredicates = selectedRowIds.length > 0
    ? buildRecordIdentityPredicateChunks(
      sortUniqueRowIdsForExport(selectedRowIds),
      { kind: 'rowid' }
    )
    : [undefined];

  for (const selected of selectedPredicates) {
    let lastId: RecordId | undefined;
    while (true) {
      assertNotCancelled(cancellation);
      const predicates: string[] = [];
      const params: CellValue[] = [];
      if (lastId !== undefined) {
        predicates.push('rowid > ?');
        params.push(lastId);
      }
      if (selected) {
        predicates.push(`(${selected.sql})`);
        params.push(...selected.params);
      }
      let sql =
        `SELECT CAST(rowid AS TEXT) AS ${escapeIdentifier('__export_rowid__')}` +
        (includeRowIdInProjection && projection ? `, ${projection}` : '') +
        ` FROM ${escapeIdentifier(table)}`;
      if (predicates.length > 0) sql += ` WHERE ${predicates.join(' AND ')}`;
      sql += ` ORDER BY rowid ASC LIMIT ${EXPORT_ROW_BATCH_SIZE}`;

      const result = await operations.executeQuery(sql, params);
      const identityRows = result[0]?.rows ?? [];
      if (identityRows.length === 0) break;
      const rowIds = identityRows.map(row => {
        const rowId = row[0];
        if (typeof rowId !== 'string' && typeof rowId !== 'number') {
          throw new Error(`SQLite returned an invalid rowid for ${table}`);
        }
        return rowId;
      });
      let valueRows = identityRows;
      if (!includeRowIdInProjection) {
        const batchPredicate = buildRecordIdentitiesPredicate(rowIds, { kind: 'rowid' });
        const valuesResult = await operations.executeQuery(
          `SELECT ${projection} FROM ${escapeIdentifier(table)} ` +
          `WHERE ${batchPredicate.sql} ORDER BY rowid ASC`,
          batchPredicate.params
        );
        valueRows = valuesResult[0]?.rows ?? [];
        if (valueRows.length !== rowIds.length) {
          throw new Error(`Table ${table} changed while export rowids were being enumerated`);
        }
      }
      for (let rowIndex = 0; rowIndex < rowIds.length; rowIndex++) {
        assertNotCancelled(cancellation);
        const rowId = rowIds[rowIndex];
        lastId = rowId;
        yield {
          cells: parseCells(
            table,
            columns,
            valueRows[rowIndex],
            includeRowIdInProjection ? 1 : 0,
            EXPORT_INLINE_TEXT_BYTES,
            false,
            textEncoding,
            rowId
          )
        };
      }
      if (identityRows.length < EXPORT_ROW_BATCH_SIZE) break;
    }
  }
}

const SELECTED_PK_SOURCE_ALIAS = '__sqlite_explorer_export_source';
const SELECTED_PK_CTE = '__sqlite_explorer_export_selected';
const SELECTED_PK_ORDER_COLUMN = '__sqlite_explorer_export_order';

function buildSelectedPrimaryKeyJoin(
  table: string,
  identity: Extract<TableIdentity, { kind: 'primaryKey' }>,
  recordIds: readonly RecordId[]
): { cte: string; from: string; orderBy: string; params: CellValue[] } {
  const keyAliases = identity.columns.map((_, index) => `__sqlite_explorer_export_key_${index}`);
  const params: CellValue[] = [];
  const valueRows = recordIds.map((rowId, order) => {
    const predicate = buildRecordIdentityPredicate(rowId, identity);
    if (
      !predicate.primaryKey
      || !predicate.primaryKeyIntegerCasts
      || predicate.primaryKeyIntegerCasts.length !== identity.columns.length
    ) {
      throw new Error(`Cannot bind selected primary-key identity for ${table}`);
    }
    params.push(...predicate.params);
    const placeholders = predicate.primaryKeyIntegerCasts.map(
      integerCast => integerCast ? 'CAST(? AS INTEGER)' : '?'
    );
    return `(${order}, ${placeholders.join(', ')})`;
  });
  const escapedCte = escapeIdentifier(SELECTED_PK_CTE);
  const escapedSource = escapeIdentifier(SELECTED_PK_SOURCE_ALIAS);
  const cteColumns = [SELECTED_PK_ORDER_COLUMN, ...keyAliases]
    .map(escapeIdentifier)
    .join(', ');
  const join = identity.columns.map((column, index) => (
    `${escapedSource}.${escapeIdentifier(column.identifier)} = ` +
    `${escapedCte}.${escapeIdentifier(keyAliases[index])}`
  )).join(' AND ');
  return {
    cte: `WITH ${escapedCte} (${cteColumns}) AS (VALUES ${valueRows.join(', ')})`,
    from:
      `FROM ${escapeIdentifier(table)} AS ${escapedSource} ` +
      `INNER JOIN ${escapedCte} ON ${join}`,
    orderBy: `ORDER BY ${escapedCte}.${escapeIdentifier(SELECTED_PK_ORDER_COLUMN)}`,
    params
  };
}

function parseSelectedPrimaryKeyOrder(
  value: CellValue,
  rowCount: number,
  table: string
): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= rowCount) {
    throw new Error(`SQLite returned an invalid selected-row order for ${table}`);
  }
  return Number(value);
}

async function* readPrimaryKeyTableRows(
  operations: DatabaseOperations,
  table: string,
  columns: readonly string[],
  identity: Extract<TableIdentity, { kind: 'primaryKey' }>,
  selectedRowIds: readonly RecordId[],
  textEncoding: CellTextEncoding,
  cancellation?: ExportCancellation
): AsyncGenerator<ExportRow> {
  if (columns.length > SQLITE_MAX_RESULT_COLUMNS) {
    throw new Error(`Cannot export more than ${SQLITE_MAX_RESULT_COLUMNS} columns`);
  }
  const projection = buildCellProjection(columns, EXPORT_INLINE_TEXT_BYTES, false);
  if (selectedRowIds.length > 0) {
    const seen = new Set<string>();
    const uniqueRowIds: RecordId[] = [];
    for (const rowId of selectedRowIds) {
      const key = recordIdKey(rowId);
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueRowIds.push(rowId);
    }

    const predicateChunks = buildRecordIdentityPredicateChunks(uniqueRowIds, identity);
    let chunkOffset = 0;
    for (const predicateChunk of predicateChunks) {
      assertNotCancelled(cancellation);
      const groupSize = predicateChunk.params.length / identity.columns.length;
      if (!Number.isSafeInteger(groupSize) || groupSize < 1) {
        throw new Error(`Invalid selected primary-key export chunk for ${table}`);
      }
      const groupIds = uniqueRowIds.slice(chunkOffset, chunkOffset + groupSize);
      chunkOffset += groupSize;

      if (columns.length < SQLITE_MAX_RESULT_COLUMNS) {
        const join = buildSelectedPrimaryKeyJoin(table, identity, groupIds);
        const selectedProjection = buildCellProjection(
          columns,
          EXPORT_INLINE_TEXT_BYTES,
          false,
          SELECTED_PK_SOURCE_ALIAS
        );
        const result = await operations.executeQuery(
          `${join.cte} SELECT ` +
          `${escapeIdentifier(SELECTED_PK_CTE)}.${escapeIdentifier(SELECTED_PK_ORDER_COLUMN)}` +
          (selectedProjection ? `, ${selectedProjection} ` : ' ') +
          `${join.from} ${join.orderBy}`,
          join.params
        );
        const yieldedOrders = new Set<number>();
        for (const row of result[0]?.rows ?? []) {
          const order = parseSelectedPrimaryKeyOrder(row[0], groupIds.length, table);
          if (yieldedOrders.has(order)) {
            throw new Error(`Primary-key identity matched multiple rows in ${table}`);
          }
          yieldedOrders.add(order);
          yield {
            cells: parseCells(
              table,
              columns,
              row,
              1,
              EXPORT_INLINE_TEXT_BYTES,
              false,
              textEncoding,
              groupIds[order]
            )
          };
        }
      } else {
        // The selected ordinal would become result column 2,001. Resolve only
        // the surviving ordinals first, then project the exact 2,000 columns in
        // the same savepoint and CTE order.
        const existenceJoin = buildSelectedPrimaryKeyJoin(table, identity, groupIds);
        const existence = await operations.executeQuery(
          `${existenceJoin.cte} SELECT ` +
          `${escapeIdentifier(SELECTED_PK_CTE)}.${escapeIdentifier(SELECTED_PK_ORDER_COLUMN)} ` +
          `${existenceJoin.from} ${existenceJoin.orderBy}`,
          existenceJoin.params
        );
        const existingIds = (existence[0]?.rows ?? []).map(row => (
          groupIds[parseSelectedPrimaryKeyOrder(row[0], groupIds.length, table)]
        ));
        if (existingIds.length === 0) continue;
        const valuesJoin = buildSelectedPrimaryKeyJoin(table, identity, existingIds);
        const selectedProjection = buildCellProjection(
          columns,
          EXPORT_INLINE_TEXT_BYTES,
          false,
          SELECTED_PK_SOURCE_ALIAS
        );
        const values = await operations.executeQuery(
          `${valuesJoin.cte} SELECT ${selectedProjection} ` +
          `${valuesJoin.from} ${valuesJoin.orderBy}`,
          valuesJoin.params
        );
        const rows = values[0]?.rows ?? [];
        if (rows.length !== existingIds.length) {
          throw new Error(`Table ${table} changed while selected identities were being exported`);
        }
        for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
          yield {
            cells: parseCells(
              table,
              columns,
              rows[rowIndex],
              0,
              EXPORT_INLINE_TEXT_BYTES,
              false,
              textEncoding,
              existingIds[rowIndex]
            )
          };
        }
      }
    }
    return;
  }

  const orderBy = identity.columns
    .map(column => `${escapeIdentifier(column.identifier)} ASC`)
    .join(', ');
  let offset = 0;
  let keyset: { mode: 'first' } | { mode: 'after'; anchor: string } | undefined = {
    mode: 'first'
  };

  while (true) {
    assertNotCancelled(cancellation);
    const identities = await operations.fetchTableData(table, {
      columns: ['rowid'],
      orderBy: 'rowid',
      orderDir: 'ASC',
      limit: EXPORT_ROW_BATCH_SIZE,
      offset,
      ...(keyset ? { keyset } : {}),
      maxInlineCellBytes: UNSTABLE_CELL_INLINE_BYTES,
      maxPageResponseBytes: 16 * 1024 * 1024
    });
    const identityRows = identities.rows;
    if (identityRows.length === 0) return;

    const recordIds = identityRows.map(identityRow => {
      const rowId = identityRow?.[0];
      if (typeof rowId !== 'string' && typeof rowId !== 'number') {
        throw new Error(`SQLite returned an invalid primary-key identity for ${table}`);
      }
      return rowId;
    });

    // SQLite guarantees at least 999 bind slots. Cap each stable-identity
    // projection group so even a wide composite key stays inside that floor.
    const maxBoundRows = Math.max(1, Math.floor(999 / identity.columns.length));
    let rowIndex = 0;
    while (rowIndex < recordIds.length) {
      assertNotCancelled(cancellation);
      const rowId = recordIds[rowIndex];

      if (isReadOnlyPrimaryKeyRecordId(rowId)) {
        // Oversized primary keys deliberately have no bindable identity. They
        // also cannot open an identity-bound cell-read session, so keep their
        // absolute position in the export's PK order. The export-wide savepoint
        // makes that position stable across the bounded cell-window queries.
        const rowOffset = offset + rowIndex;
        const result = await operations.executeQuery(
          `SELECT ${projection} FROM ${escapeIdentifier(table)} ` +
          `ORDER BY ${orderBy} LIMIT 1 OFFSET ${rowOffset}`
        );
        const row = result[0]?.rows?.[0];
        if (!row || (result[0]?.rows.length ?? 0) !== 1) {
          throw new Error(`Table ${table} changed while export identities were being enumerated`);
        }
        yield {
          cells: parseCells(
            table,
            columns,
            row,
            0,
            EXPORT_INLINE_TEXT_BYTES,
            false,
            textEncoding,
            rowId,
            {
              orderByColumns: identity.columns.map(column => column.identifier),
              rowOffset,
              textEncoding
            }
          )
        };
        rowIndex++;
        continue;
      }

      let groupEnd = rowIndex + 1;
      while (
        groupEnd < recordIds.length
        && groupEnd - rowIndex < maxBoundRows
        && !isReadOnlyPrimaryKeyRecordId(recordIds[groupEnd])
      ) {
        groupEnd++;
      }
      const groupIds = recordIds.slice(rowIndex, groupEnd);
      // Restrict the projection query to the exact identities fetched for
      // this page. ORDER BY can no longer pull in an unrelated replacement
      // row after a concurrent equal-cardinality delete+insert.
      const predicate = buildRecordIdentitiesPredicate(groupIds, identity);
      const result = await operations.executeQuery(
        `SELECT ${projection} FROM ${escapeIdentifier(table)} ` +
        `WHERE ${predicate.sql} ORDER BY ${orderBy}`,
        predicate.params
      );
      const rows = result[0]?.rows ?? [];
      if (rows.length !== groupIds.length) {
        throw new Error(`Table ${table} changed while export identities were being enumerated`);
      }
      for (let groupIndex = 0; groupIndex < rows.length; groupIndex++) {
        assertNotCancelled(cancellation);
        yield {
          cells: parseCells(
            table,
            columns,
            rows[groupIndex],
            0,
            EXPORT_INLINE_TEXT_BYTES,
            false,
            textEncoding,
            groupIds[groupIndex]
          )
        };
      }
      rowIndex = groupEnd;
    }

    offset += identityRows.length;
    keyset = identities.keysetAnchors?.last
      ? { mode: 'after', anchor: identities.keysetAnchors.last }
      : undefined;
    if (identityRows.length < EXPORT_ROW_BATCH_SIZE) return;
  }
}

async function* readUnstableCursorRows(
  operations: DatabaseOperations,
  table: string,
  columns: readonly string[],
  projection: string,
  textEncoding: CellTextEncoding,
  includeInlineBlobs: boolean,
  cancellation?: ExportCancellation
): AsyncGenerator<ExportRow> {
  const openQueryReadSession = operations.openQueryReadSession!;
  const readQueryRows = operations.readQueryRows!;
  const closeQueryReadSession = operations.closeQueryReadSession!;
  const session = await openQueryReadSession.call(
    operations,
    `SELECT ${projection} FROM ${escapeIdentifier(table)}`
  );
  let primaryError: unknown;
  try {
    while (true) {
      assertNotCancelled(cancellation);
      // A single row can already contain one bounded value per selected column;
      // keep the aggregate transport bound independent of column count.
      const chunk = await readQueryRows.call(operations, session.sessionId, 1);
      if (chunk.rows.length > 1) {
        throw new Error(`Query read session returned too many rows for ${table}`);
      }
      const row = chunk.rows[0];
      if (row) {
        yield {
          cells: parseCells(
            table,
            columns,
            row,
            0,
            UNSTABLE_CELL_INLINE_BYTES,
            includeInlineBlobs,
            textEncoding
          )
        };
      } else if (!chunk.done) {
        throw new Error(`Query read session made no progress for ${table}`);
      }
      if (chunk.done) return;
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await closeQueryReadSession.call(operations, session.sessionId);
    } catch (cleanupError) {
      if (primaryError !== undefined) {
        throw new AggregateError(
          [primaryError, cleanupError],
          `View export failed and its query read session could not be closed`
        );
      }
      throw cleanupError;
    }
  }
}

async function* readUnstableSpoolRows(
  operations: DatabaseOperations,
  table: string,
  columns: readonly string[],
  projection: string,
  textEncoding: CellTextEncoding,
  includeInlineBlobs: boolean,
  cancellation?: ExportCancellation
): AsyncGenerator<ExportRow> {
  const spoolTable = `__sqlite_explorer_export_${webCrypto.randomUUID().replace(/-/g, '')}`;
  const escapedSpool = escapeIdentifier(spoolTable);
  const cancellationBinding = bindCancellationSignal(cancellation);
  let spoolAttempted = false;
  let primaryError: unknown;
  try {
    assertNotCancelled(cancellation);
    // Views and keyless sources cannot be resumed safely: volatile expressions
    // and ORDER BY random() are re-evaluated by every LIMIT/OFFSET statement.
    // Evaluate once into SQLite-owned TEMP storage, then stream bounded rows
    // from its intrinsic rowid order without transporting the full result.
    spoolAttempted = true;
    await operations.executeQuery(
      `CREATE TEMP TABLE ${escapedSpool} AS ` +
      `SELECT ${projection} FROM ${escapeIdentifier(table)}`,
      undefined,
      cancellationBinding.signal
    );
    assertNotCancelled(cancellation);

    let lastSpoolRowId: RecordId = 0;
    while (true) {
      assertNotCancelled(cancellation);
      const includeRowIdInProjection = columns.length < SQLITE_MAX_RESULT_COLUMNS;
      const result = await operations.executeQuery(
        `SELECT CAST(rowid AS TEXT)` +
        (includeRowIdInProjection ? ', * ' : ' ') +
        `FROM ${escapedSpool} ` +
        `WHERE rowid > ? ORDER BY rowid LIMIT 1`,
        [lastSpoolRowId],
        cancellationBinding.signal
      );
      assertNotCancelled(cancellation);
      const row = result[0]?.rows[0];
      if (!row) return;
      if (typeof row[0] !== 'string' && typeof row[0] !== 'number') {
        throw new Error(`SQLite returned an invalid export spool rowid for ${table}`);
      }
      lastSpoolRowId = row[0];
      let valueRow = row;
      if (!includeRowIdInProjection) {
        const values = await operations.executeQuery(
          `SELECT * FROM ${escapedSpool} WHERE rowid = ? LIMIT 1`,
          [lastSpoolRowId],
          cancellationBinding.signal
        );
        valueRow = values[0]?.rows[0];
        if (!valueRow || (values[0]?.rows.length ?? 0) !== 1) {
          throw new Error(`Export spool ${spoolTable} changed while reading ${table}`);
        }
      }
      yield {
        cells: parseCells(
          table,
          columns,
          valueRow,
          includeRowIdInProjection ? 1 : 0,
          UNSTABLE_CELL_INLINE_BYTES,
          includeInlineBlobs,
          textEncoding
        )
      };
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    cancellationBinding.dispose();
    if (spoolAttempted) {
      try {
        // Do not forward an already-aborted signal to cleanup. CREATE may have
        // completed just before its cancelled response was observed.
        await operations.executeQuery(`DROP TABLE IF EXISTS temp.${escapedSpool}`);
      } catch (cleanupError) {
        if (primaryError !== undefined) {
          throw new AggregateError(
            [primaryError, cleanupError],
            `View export failed and temporary spool ${spoolTable} could not be removed`
          );
        }
        throw cleanupError;
      }
    }
  }
}

async function* readUnstableRows(
  operations: DatabaseOperations,
  table: string,
  columns: readonly string[],
  textEncoding: CellTextEncoding,
  includeInlineBlobs: boolean,
  cancellation?: ExportCancellation
): AsyncGenerator<ExportRow> {
  const projection = buildCellProjection(
    columns,
    UNSTABLE_CELL_INLINE_BYTES,
    includeInlineBlobs
  );
  if (
    operations.openQueryReadSession
    && operations.readQueryRows
    && operations.closeQueryReadSession
  ) {
    yield* readUnstableCursorRows(
      operations,
      table,
      columns,
      projection,
      textEncoding,
      includeInlineBlobs,
      cancellation
    );
    return;
  }
  yield* readUnstableSpoolRows(
    operations,
    table,
    columns,
    projection,
    textEncoding,
    includeInlineBlobs,
    cancellation
  );
}

function readRows(
  operations: DatabaseOperations,
  table: string,
  columns: readonly string[],
  identity: TableIdentity | undefined,
  selectedRowIds: readonly RecordId[],
  textEncoding: CellTextEncoding,
  includeUnstableInlineBlobs: boolean,
  cancellation?: ExportCancellation
): AsyncGenerator<ExportRow> {
  if (identity?.kind === 'rowid') {
    return readRowIdTableRows(
      operations,
      table,
      columns,
      selectedRowIds,
      textEncoding,
      cancellation
    );
  }
  if (identity?.kind === 'primaryKey') {
    return readPrimaryKeyTableRows(
      operations,
      table,
      columns,
      identity,
      selectedRowIds,
      textEncoding,
      cancellation
    );
  }
  return readUnstableRows(
    operations,
    table,
    columns,
    textEncoding,
    includeUnstableInlineBlobs,
    cancellation
  );
}

function validateChunk(
  chunk: Awaited<ReturnType<DatabaseOperations['readCellChunk']>>,
  expectedOffset: number,
  requestedBytes: number,
  sourceByteLength: number
): void {
  if (chunk.byteOffset !== expectedOffset) {
    throw new Error(
      `Cell read chunk offset mismatch: expected ${expectedOffset}, received ${chunk.byteOffset}`
    );
  }
  if (!(chunk.bytes instanceof Uint8Array) || chunk.bytes.byteLength > requestedBytes) {
    throw new Error('Cell read session returned an invalid or oversized chunk');
  }
  if (chunk.bytes.byteLength === 0 && expectedOffset < sourceByteLength) {
    throw new Error('Cell read session ended before the advertised byte length');
  }
  const nextOffset = expectedOffset + chunk.bytes.byteLength;
  if (nextOffset > sourceByteLength || chunk.done !== (nextOffset >= sourceByteLength)) {
    throw new Error('Cell read session completion did not match its advertised byte length');
  }
}

function assertSessionMetadata(cell: ExportCell, metadata: CellMetadata): void {
  if (
    metadata.storageClass !== cell.storageClass ||
    metadata.byteLength !== cell.byteLength
  ) {
    throw new Error(
      `Cell ${cell.table}.${cell.column} changed while the export was in progress`
    );
  }
}

function requireStableRowId(cell: ExportCell): RecordId {
  if (cell.rowId === undefined) {
    throw new Error(
      `Cannot stream ${cell.storageClass.toUpperCase()} cell ${cell.table}.${cell.column} ` +
      `(${cell.byteLength} bytes) because it has no stable table row identity; ` +
      `view exports are limited to ${UNSTABLE_CELL_INLINE_BYTES} bytes per TEXT/BLOB cell.`
    );
  }
  if (isReadOnlyPrimaryKeyRecordId(cell.rowId)) {
    throw new Error(
      `Cannot stream ${cell.table}.${cell.column}: its oversized primary-key identity ` +
      'was deliberately not transported'
    );
  }
  return cell.rowId;
}

async function readPositionedCellChunk(
  operations: DatabaseOperations,
  cell: ExportCell,
  byteOffset: number,
  maxBytes: number
): ReturnType<DatabaseOperations['readCellChunk']> {
  const position = cell.snapshotPosition;
  if (!position) throw new Error(`Cell ${cell.table}.${cell.column} has no snapshot position`);
  const orderBy = position.orderByColumns
    .map(column => `${escapeIdentifier(column)} ASC`)
    .join(', ');
  const result = await operations.executeQuery(
    `SELECT substr(CAST(${escapeIdentifier(cell.column)} AS BLOB), ?, ?) ` +
    `FROM ${escapeIdentifier(cell.table)} ORDER BY ${orderBy} LIMIT 1 OFFSET ?`,
    [byteOffset + 1, maxBytes, position.rowOffset]
  );
  const rows = result[0]?.rows ?? [];
  if (rows.length !== 1) {
    throw new Error(
      `Snapshot row for ${cell.table}.${cell.column} disappeared during export`
    );
  }
  const bytes = rows[0]?.[0];
  if (!(bytes instanceof Uint8Array)) {
    throw new Error(`SQLite returned a non-BLOB window for ${cell.table}.${cell.column}`);
  }
  if (bytes.byteLength > maxBytes) {
    throw new Error('SQLite returned a positioned cell window larger than requested');
  }
  return {
    byteOffset,
    bytes,
    done: byteOffset + bytes.byteLength >= cell.byteLength
  };
}

async function withCellSession<T>(
  operations: DatabaseOperations,
  cell: ExportCell,
  cancellation: ExportCancellation | undefined,
  body: (input: ExportCellSession) => Promise<T>
): Promise<T> {
  assertNotCancelled(cancellation);
  if (cell.snapshotPosition) {
    const metadata: CellMetadata = {
      storageClass: cell.storageClass,
      byteLength: cell.byteLength,
      ...(cell.storageClass === 'text'
        ? { textEncoding: cell.snapshotPosition.textEncoding }
        : {})
    };
    return body({
      session: { metadata },
      cell,
      readChunk: (byteOffset, maxBytes) => (
        readPositionedCellChunk(operations, cell, byteOffset, maxBytes)
      )
    });
  }
  const rowId = requireStableRowId(cell);
  const session = await operations.openCellReadSession({
    table: cell.table,
    rowId,
    column: cell.column
  });
  let primaryError: unknown;
  try {
    assertNotCancelled(cancellation);
    assertSessionMetadata(cell, session.metadata);
    return await body({
      session,
      cell,
      readChunk: (byteOffset, maxBytes) => operations.readCellChunk(
        session.sessionId,
        byteOffset,
        maxBytes
      )
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await operations.closeCellReadSession(session.sessionId);
    } catch (cleanupError) {
      if (primaryError !== undefined) {
        throw new AggregateError(
          [primaryError, cleanupError],
          `Export failed and the ${cell.table}.${cell.column} read session could not be closed`
        );
      }
      throw cleanupError;
    }
  }
}

async function forEachRawChunk(
  input: ExportCellSession,
  cancellation: ExportCancellation | undefined,
  consume: (bytes: Uint8Array) => Promise<void>
): Promise<void> {
  let sourceOffset = 0;
  while (sourceOffset < input.session.metadata.byteLength) {
    assertNotCancelled(cancellation);
    const requestedBytes = Math.min(
      EXPORT_CELL_CHUNK_BYTES,
      input.session.metadata.byteLength - sourceOffset
    );
    const chunk = await input.readChunk(sourceOffset, requestedBytes);
    assertNotCancelled(cancellation);
    validateChunk(
      chunk,
      sourceOffset,
      requestedBytes,
      input.session.metadata.byteLength
    );
    await consume(chunk.bytes);
    sourceOffset += chunk.bytes.byteLength;
  }
}

function requireTextEncoding(metadata: CellMetadata): 'utf-8' | 'utf-16le' | 'utf-16be' {
  if (!metadata.textEncoding) {
    throw new Error('SQLite omitted the encoding for a TEXT cell read session');
  }
  return metadata.textEncoding;
}

async function forEachDecodedText(
  operations: DatabaseOperations,
  input: ExportCellSession,
  cancellation: ExportCancellation | undefined,
  consume: (text: string) => Promise<void>
): Promise<void> {
  const representable = await inspectDecodedText(
    operations,
    input,
    cancellation,
    consume
  );
  if (!representable) {
    throw new Error('SQLite TEXT bytes are not representable in the database encoding');
  }
}

/** Decode a complete pass without allowing an invalid suffix to leak partial output. */
async function inspectDecodedText(
  operations: DatabaseOperations,
  input: ExportCellSession,
  cancellation: ExportCancellation | undefined,
  consume: (text: string) => Promise<void>
): Promise<boolean> {
  const decoder = new TextDecoder(
    requireTextEncoding(input.session.metadata),
    { fatal: true, ignoreBOM: true }
  );
  let representable = true;
  await forEachRawChunk(input, cancellation, async bytes => {
    if (!representable) return;
    let decoded: string;
    try {
      decoded = decoder.decode(bytes, { stream: true });
    } catch {
      representable = false;
      return;
    }
    if (decoded) await consume(decoded);
  });
  if (!representable) return false;
  try {
    const finalText = decoder.decode();
    if (finalText) await consume(finalText);
    return true;
  } catch {
    return false;
  }
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

async function writeBase64(
  operations: DatabaseOperations,
  input: ExportCellSession,
  sink: AsyncExportSink,
  cancellation?: ExportCancellation
): Promise<void> {
  let carry = new Uint8Array();
  await forEachRawChunk(input, cancellation, async bytes => {
    const combined = concatBytes(carry, bytes);
    const alignedLength = combined.byteLength - (combined.byteLength % 3);
    if (alignedLength > 0) {
      await emit(
        sink,
        Buffer.from(combined.subarray(0, alignedLength)).toString('base64'),
        cancellation
      );
    }
    carry = combined.slice(alignedLength);
  });
  if (carry.byteLength > 0) {
    await emit(sink, Buffer.from(carry).toString('base64'), cancellation);
  }
}

async function writeHexBytes(
  operations: DatabaseOperations,
  input: ExportCellSession,
  sink: AsyncExportSink,
  cancellation?: ExportCancellation
): Promise<void> {
  await forEachRawChunk(input, cancellation, async bytes => {
    await emit(sink, Buffer.from(bytes).toString('hex'), cancellation);
  });
}

async function writeUnrepresentableText(
  operations: DatabaseOperations,
  input: ExportCellSession,
  sink: AsyncExportSink,
  format: 'csv' | 'json' | 'sql',
  cancellation?: ExportCancellation
): Promise<void> {
  const envelope = getUnrepresentableTextExportEnvelope(
    format,
    requireTextEncoding(input.session.metadata)
  );
  await emit(sink, envelope.prefix, cancellation);
  if (envelope.byteEncoding === 'hex') {
    await writeHexBytes(operations, input, sink, cancellation);
  } else {
    await writeBase64(operations, input, sink, cancellation);
  }
  await emit(sink, envelope.suffix, cancellation);
}

class IncrementalJsonEscaper {
  private pendingHighSurrogate = '';

  push(text: string): string {
    let source = this.pendingHighSurrogate + text;
    this.pendingHighSurrogate = '';
    if (source.length > 0) {
      const finalCodeUnit = source.charCodeAt(source.length - 1);
      if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
        this.pendingHighSurrogate = source.slice(-1);
        source = source.slice(0, -1);
      }
    }
    return source ? JSON.stringify(source).slice(1, -1) : '';
  }

  finish(): string {
    if (!this.pendingHighSurrogate) return '';
    const escaped = JSON.stringify(this.pendingHighSurrogate).slice(1, -1);
    this.pendingHighSurrogate = '';
    return escaped;
  }
}

async function writeJsonText(
  operations: DatabaseOperations,
  input: ExportCellSession,
  sink: AsyncExportSink,
  cancellation?: ExportCancellation
): Promise<void> {
  const escaper = new IncrementalJsonEscaper();
  await forEachDecodedText(operations, input, cancellation, async text => {
    await emit(sink, escaper.push(text), cancellation);
  });
  await emit(sink, escaper.finish(), cancellation);
}

async function inspectSqlText(
  operations: DatabaseOperations,
  input: ExportCellSession,
  cancellation?: ExportCancellation
): Promise<{ representable: boolean; containsNul: boolean }> {
  let containsNul = false;
  const representable = await inspectDecodedText(operations, input, cancellation, async text => {
    if (text.includes('\0')) containsNul = true;
  });
  return { representable, containsNul };
}

async function writeUtf8TextHex(
  operations: DatabaseOperations,
  input: ExportCellSession,
  sink: AsyncExportSink,
  cancellation?: ExportCancellation
): Promise<void> {
  const encoder = new TextEncoder();
  await forEachDecodedText(operations, input, cancellation, async text => {
    await emit(sink, Buffer.from(encoder.encode(text)).toString('hex'), cancellation);
  });
}

async function writeSqlQuotedText(
  operations: DatabaseOperations,
  input: ExportCellSession,
  sink: AsyncExportSink,
  cancellation?: ExportCancellation
): Promise<void> {
  await forEachDecodedText(operations, input, cancellation, async text => {
    await emit(sink, text.replace(/'/g, "''"), cancellation);
  });
}

async function inspectCsvText(
  operations: DatabaseOperations,
  input: ExportCellSession,
  cancellation?: ExportCancellation
): Promise<{ representable: boolean; needsQuotes: boolean }> {
  let needsQuotes = false;
  const representable = await inspectDecodedText(operations, input, cancellation, async text => {
    if (text.includes(',') || text.includes('"') || text.includes('\n')) needsQuotes = true;
  });
  return { representable, needsQuotes };
}

function escapeCsvValue(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Uint8Array) return '[BLOB]';
  const text = String(value);
  return text.includes(',') || text.includes('"') || text.includes('\n')
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

function needsCellStream(cell: ExportCell): boolean {
  return (
    (cell.storageClass === 'text' || cell.storageClass === 'blob') &&
    cell.value === null
  );
}

async function writeCsvCell(
  operations: DatabaseOperations,
  cell: ExportCell,
  sink: AsyncExportSink,
  cancellation?: ExportCancellation
): Promise<void> {
  if (cell.storageClass === 'blob') {
    // CSV intentionally exposes only the established placeholder. No BLOB read
    // session is opened, including for small values.
    await emit(sink, '[BLOB]', cancellation);
    return;
  }
  if (!needsCellStream(cell)) {
    await emit(sink, encodeCsvExportCell(cell), cancellation);
    return;
  }
  await withCellSession(operations, cell, cancellation, async input => {
    const inspection = await inspectCsvText(operations, input, cancellation);
    if (!inspection.representable) {
      await writeUnrepresentableText(operations, input, sink, 'csv', cancellation);
      return;
    }
    if (inspection.needsQuotes) await emit(sink, '"', cancellation);
    await forEachDecodedText(operations, input, cancellation, async text => {
      await emit(
        sink,
        inspection.needsQuotes ? text.replace(/"/g, '""') : text,
        cancellation
      );
    });
    if (inspection.needsQuotes) await emit(sink, '"', cancellation);
  });
}

async function writeJsonCell(
  operations: DatabaseOperations,
  cell: ExportCell,
  sink: AsyncExportSink,
  cancellation?: ExportCancellation
): Promise<void> {
  if (!needsCellStream(cell)) {
    await emit(sink, encodeJsonExportCell(cell), cancellation);
    return;
  }

  await withCellSession(operations, cell, cancellation, async input => {
    if (cell.storageClass === 'blob') {
      await emit(sink, '"', cancellation);
      await writeBase64(operations, input, sink, cancellation);
      await emit(sink, '"', cancellation);
      return;
    }

    const representable = await inspectDecodedText(
      operations,
      input,
      cancellation,
      async () => {}
    );
    if (!representable) {
      await writeUnrepresentableText(operations, input, sink, 'json', cancellation);
      return;
    }
    await emit(sink, '"', cancellation);
    await writeJsonText(operations, input, sink, cancellation);
    await emit(sink, '"', cancellation);
  });
}

async function writeSqlCell(
  operations: DatabaseOperations,
  cell: ExportCell,
  sink: AsyncExportSink,
  cancellation?: ExportCancellation
): Promise<void> {
  if (!needsCellStream(cell)) {
    await emit(sink, encodeSqlExportCell(cell), cancellation);
    return;
  }

  await withCellSession(operations, cell, cancellation, async input => {
    if (cell.storageClass === 'blob') {
      await emit(sink, "X'", cancellation);
      await writeHexBytes(operations, input, sink, cancellation);
      await emit(sink, "'", cancellation);
      return;
    }

    // The output grammar changes when any NUL exists, so scan and then rewind
    // this same snapshot session. Buffering until the decision would re-create
    // the large-cell amplification Stage E is removing.
    const inspection = await inspectSqlText(operations, input, cancellation);
    if (!inspection.representable) {
      await writeUnrepresentableText(operations, input, sink, 'sql', cancellation);
    } else if (inspection.containsNul) {
      await emit(sink, "CAST(X'", cancellation);
      await writeUtf8TextHex(operations, input, sink, cancellation);
      await emit(sink, "' AS TEXT)", cancellation);
    } else {
      await emit(sink, "'", cancellation);
      await writeSqlQuotedText(operations, input, sink, cancellation);
      await emit(sink, "'", cancellation);
    }
  });
}

function jsonPropertyIndices(columns: readonly string[]): Array<{ name: string; index: number }> {
  const objectOrder: Record<string, number> = {};
  columns.forEach((column, index) => {
    objectOrder[column] = index;
  });
  // Object.keys reproduces JSON.stringify's integer-key ordering as well as its
  // duplicate-column overwrite and legacy __proto__ setter behavior.
  return Object.keys(objectOrder).map(name => ({ name, index: objectOrder[name] }));
}

async function writeCsvRows(
  operations: DatabaseOperations,
  rows: AsyncGenerator<ExportRow>,
  columns: readonly string[],
  sink: AsyncExportSink,
  includeHeader: boolean,
  excel: boolean,
  cancellation?: ExportCancellation
): Promise<number> {
  let rowCount = 0;
  if (excel) await emit(sink, '\uFEFF', cancellation);
  if (includeHeader) {
    await emit(sink, columns.map(escapeCsvValue).join(','), cancellation);
  }
  for await (const row of rows) {
    if (includeHeader || rowCount > 0) {
      await emit(sink, '\n', cancellation);
    }
    for (let index = 0; index < row.cells.length; index++) {
      if (index > 0) await emit(sink, ',', cancellation);
      await writeCsvCell(operations, row.cells[index], sink, cancellation);
    }
    rowCount++;
  }
  return rowCount;
}

async function writeJsonRows(
  operations: DatabaseOperations,
  rows: AsyncGenerator<ExportRow>,
  columns: readonly string[],
  sink: AsyncExportSink,
  cancellation?: ExportCancellation
): Promise<number> {
  const properties = jsonPropertyIndices(columns);
  let rowCount = 0;
  await emit(sink, '[', cancellation);
  for await (const row of rows) {
    await emit(sink, rowCount === 0 ? '\n  {\n' : ',\n  {\n', cancellation);
    for (let propertyIndex = 0; propertyIndex < properties.length; propertyIndex++) {
      const property = properties[propertyIndex];
      if (propertyIndex > 0) await emit(sink, ',\n', cancellation);
      await emit(sink, `    ${JSON.stringify(property.name)}: `, cancellation);
      await writeJsonCell(
        operations,
        row.cells[property.index],
        sink,
        cancellation
      );
    }
    await emit(sink, '\n  }', cancellation);
    rowCount++;
  }
  await emit(sink, rowCount === 0 ? ']' : '\n]', cancellation);
  return rowCount;
}

async function writeSqlRows(
  operations: DatabaseOperations,
  rows: AsyncGenerator<ExportRow>,
  table: string,
  columns: readonly string[],
  sink: AsyncExportSink,
  includeTableName: boolean,
  cancellation?: ExportCancellation
): Promise<number> {
  const targetTable = includeTableName ? escapeIdentifier(table) : 'table_name';
  const columnList = columns.map(escapeIdentifier).join(', ');
  let rowCount = 0;
  for await (const row of rows) {
    if (rowCount > 0) await emit(sink, '\n', cancellation);
    await emit(
      sink,
      `INSERT INTO ${targetTable} (${columnList}) VALUES (`,
      cancellation
    );
    for (let index = 0; index < row.cells.length; index++) {
      if (index > 0) await emit(sink, ', ', cancellation);
      await writeSqlCell(operations, row.cells[index], sink, cancellation);
    }
    await emit(sink, ');', cancellation);
    rowCount++;
  }
  return rowCount;
}

/**
 * Stream one table export through Stage B's snapshot cell windows. Row queries
 * carry only identities, scalar values, bounded TEXT, and TEXT/BLOB metadata;
 * complete large values never enter a row result.
 */
export async function streamTableExport(
  operations: DatabaseOperations,
  table: string,
  requestedColumns: readonly string[],
  options: ExportOptions,
  sink: AsyncExportSink,
  cancellation?: ExportCancellation
): Promise<number> {
  const format = options.format;
  if (!format || !['csv', 'excel', 'json', 'sql'].includes(format)) {
    throw new Error(`Unsupported export format: ${format || 'undefined'}`);
  }
  if (!table) throw new Error('No table specified for export');
  if (!sink || typeof sink.write !== 'function') throw new Error('Export sink is required');
  assertNotCancelled(cancellation);

  // The projection intentionally omits oversized values. Keep every later
  // cell session inside its projection's SQLite snapshot; metadata equality
  // alone cannot detect a same-class, same-length replacement.
  return runReadSnapshot(operations, async snapshotOperations => {
    const columns = await resolveColumns(snapshotOperations, table, requestedColumns);
    const identity = await resolveIdentity(snapshotOperations, table);
    const textEncoding = await resolveTextEncoding(snapshotOperations);
    const selectedRowIds = options.rowIds ?? [];
    const containsPrimaryKeyIds = selectedRowIds.some(isPrimaryKeyRecordId);
    if (containsPrimaryKeyIds && !selectedRowIds.every(isPrimaryKeyRecordId)) {
      throw new Error('Cannot mix rowid and primary-key row identities');
    }
    if (selectedRowIds.length > 0 && !identity) {
      throw new Error(`Cannot export selected rows: ${table} has no stable row identity`);
    }
    if (
      selectedRowIds.length > 0 &&
      identity?.kind === 'primaryKey' &&
      !selectedRowIds.every(isPrimaryKeyRecordId)
    ) {
      throw new Error(`Cannot export selected rows: ${table} requires primary-key identities`);
    }
    if (containsPrimaryKeyIds && identity?.kind !== 'primaryKey') {
      throw new Error(`Cannot export selected rows: ${table} has no declared primary-key identity`);
    }
    const rows = readRows(
      snapshotOperations,
      table,
      columns,
      identity,
      selectedRowIds,
      textEncoding,
      format !== 'csv' && format !== 'excel',
      cancellation
    );

    switch (format) {
      case 'csv':
        return writeCsvRows(
          snapshotOperations,
          rows,
          columns,
          sink,
          options.header ?? true,
          false,
          cancellation
        );
      case 'excel':
        return writeCsvRows(
          snapshotOperations,
          rows,
          columns,
          sink,
          options.header ?? true,
          true,
          cancellation
        );
      case 'json':
        return writeJsonRows(snapshotOperations, rows, columns, sink, cancellation);
      case 'sql':
        return writeSqlRows(
          snapshotOperations,
          rows,
          table,
          columns,
          sink,
          options.includeTableName ?? true,
          cancellation
        );
      default:
        throw new Error(`Unsupported export format: ${format}`);
    }
  });
}
