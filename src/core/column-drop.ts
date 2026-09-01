import type {
  CellValue,
  ColumnDropSnapshot,
  ColumnDropTableState,
  TableIdentity
} from './types';
import { encodePrimaryKeyRecordId } from './row-identity';
import { qualifyMainCreateIndexSql } from './schema-ddl';
import { escapeIdentifier, escapeMainIdentifier, validateSqlType } from './sql-utils';
import { qualifyMainCreateTriggerSql } from './view-utils';

/** Read the table DDL plus every persistent index/trigger owned by it. */
export const COLUMN_DROP_TABLE_STATE_SQL = `
SELECT type, name, sql
FROM main.sqlite_schema
WHERE (type = 'table' AND name = ? COLLATE NOCASE)
   OR (tbl_name = ? COLLATE NOCASE
       AND type IN ('index', 'trigger')
       AND sql IS NOT NULL)
ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`;

/** Bound host memory while comparing the pre/post rebuild violation multiset. */
export const COLUMN_DROP_FOREIGN_KEY_VIOLATION_LIMIT = 4096;
export const COLUMN_DROP_FOREIGN_KEY_VIOLATION_BYTES_LIMIT = 2 * 1024 * 1024;
export const COLUMN_DROP_FOREIGN_KEY_FIELD_BYTES_LIMIT = 64 * 1024;

const COLUMN_DROP_HISTORY_COLUMN_CHUNK_SIZE = 64;
const COLUMN_DROP_VALUE_ENTRY_STRUCTURAL_BYTES = 28;

export interface ColumnDropHistorySizeQuery {
  kind: 'values' | 'identity';
  sql: string;
  params: CellValue[];
}

export interface ColumnDropHistorySizePreflight {
  queries: ColumnDropHistorySizeQuery[];
  primaryKeyStaticIdentityBytes: number;
}

function columnDropValueBytes(column: string): string {
  const escaped = escapeIdentifier(column);
  return (
    `CASE typeof(${escaped}) ` +
    `WHEN 'text' THEN 2 * octet_length(${escaped}) ` +
    `WHEN 'blob' THEN octet_length(${escaped}) ` +
    `WHEN 'integer' THEN 8 WHEN 'real' THEN 8 ELSE 0 END`
  );
}

function primaryKeyDynamicIdentityBytes(column: string): string {
  const escaped = escapeIdentifier(column);
  // The static identity uses an empty TEXT member. These terms conservatively
  // reserve the extra URI-safe JS-string memory for the actual storage class.
  // A TEXT source byte can become three UTF-8 percent triplets after invalid
  // UTF-8 replacement, and every JS character costs two tracker bytes.
  return (
    `CASE typeof(${escaped}) ` +
    `WHEN 'text' THEN 18 * octet_length(${escaped}) ` +
    `WHEN 'blob' THEN 4 * octet_length(${escaped}) ` +
    `WHEN 'integer' THEN 46 WHEN 'real' THEN 48 ELSE 0 END`
  );
}

function aggregateColumnDropHistoryQuery(
  table: string,
  expressions: readonly string[],
  kind: ColumnDropHistorySizeQuery['kind']
): ColumnDropHistorySizeQuery {
  return {
    kind,
    sql:
      `SELECT COUNT(*), COALESCE(SUM(${expressions.join(' + ') || '0'}), 0) ` +
      `FROM ${escapeMainIdentifier(table)}`,
    params: []
  };
}

/** Build bounded-width metadata aggregates; no dropped value or PK value crosses RPC. */
export function buildColumnDropHistorySizePreflight(
  table: string,
  droppedColumns: readonly string[],
  identity: TableIdentity
): ColumnDropHistorySizePreflight {
  const queries: ColumnDropHistorySizeQuery[] = [];
  for (let offset = 0; offset < droppedColumns.length; offset += COLUMN_DROP_HISTORY_COLUMN_CHUNK_SIZE) {
    queries.push(aggregateColumnDropHistoryQuery(
      table,
      droppedColumns
        .slice(offset, offset + COLUMN_DROP_HISTORY_COLUMN_CHUNK_SIZE)
        .map(columnDropValueBytes),
      'values'
    ));
  }

  let primaryKeyStaticIdentityBytes = 0;
  if (identity.kind === 'rowid') {
    queries.push(aggregateColumnDropHistoryQuery(
      table,
      [
        'CASE WHEN rowid BETWEEN -9007199254740991 AND 9007199254740991 ' +
        'THEN 8 ELSE 40 END'
      ],
      'identity'
    ));
  } else {
    const emptyPrimaryKeyIdentity = encodePrimaryKeyRecordId(
      identity.columns,
      identity.columns.map(() => '')
    );
    if (typeof emptyPrimaryKeyIdentity !== 'string') {
      throw new Error('Primary-key identity encoder returned a non-string record ID');
    }
    primaryKeyStaticIdentityBytes = emptyPrimaryKeyIdentity.length * 2;
    for (let offset = 0; offset < identity.columns.length; offset += COLUMN_DROP_HISTORY_COLUMN_CHUNK_SIZE) {
      queries.push(aggregateColumnDropHistoryQuery(
        table,
        identity.columns
          .slice(offset, offset + COLUMN_DROP_HISTORY_COLUMN_CHUNK_SIZE)
          .map(column => primaryKeyDynamicIdentityBytes(column.identifier)),
        'identity'
      ));
    }
  }
  return { queries, primaryKeyStaticIdentityBytes };
}

function safeColumnDropAggregateInteger(value: unknown, label: string): number {
  const normalized = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || Number(normalized) < 0) {
    throw new Error(`SQLite returned an unsafe ${label} during column-drop undo preflight`);
  }
  return Number(normalized);
}

function checkedColumnDropTotal(values: readonly number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}

/** Refuse before the full snapshot SELECT when retained positional undo cannot fit. */
export function assertColumnDropHistoryFitsUndoBudget(input: {
  table: string;
  droppedColumnCount: number;
  preflight: ColumnDropHistorySizePreflight;
  resultRows: readonly (readonly unknown[] | undefined)[];
  maxSnapshotBytes: number;
}): void {
  if (!Number.isSafeInteger(input.maxSnapshotBytes) || input.maxSnapshotBytes < 0) {
    throw new Error('Column-drop undo snapshot budget must be a non-negative safe integer');
  }
  if (input.resultRows.length !== input.preflight.queries.length) {
    throw new Error('SQLite returned incomplete column-drop undo preflight metadata');
  }

  let rowCount: number | undefined;
  let valueBytes = 0;
  let dynamicIdentityBytes = 0;
  let aggregateOverflow = false;
  input.resultRows.forEach((row, index) => {
    if (!row || row.length < 2) {
      throw new Error('SQLite omitted column-drop undo preflight metadata');
    }
    const queryRowCount = safeColumnDropAggregateInteger(row[0], 'row count');
    const bytes = safeColumnDropAggregateInteger(row[1], 'byte count');
    if (rowCount === undefined) rowCount = queryRowCount;
    else if (rowCount !== queryRowCount) {
      throw new Error('SQLite returned inconsistent row counts during column-drop undo preflight');
    }
    if (input.preflight.queries[index].kind === 'values') valueBytes += bytes;
    else dynamicIdentityBytes += bytes;
    if (!Number.isSafeInteger(valueBytes) || !Number.isSafeInteger(dynamicIdentityBytes)) {
      aggregateOverflow = true;
    }
  });

  const rows = rowCount ?? 0;
  const staticIdentityBytes = rows * input.preflight.primaryKeyStaticIdentityBytes;
  const identityBytes = checkedColumnDropTotal([
    staticIdentityBytes,
    dynamicIdentityBytes
  ]);
  const structuralBytes = rows
    * input.droppedColumnCount
    * COLUMN_DROP_VALUE_ENTRY_STRUCTURAL_BYTES;
  const repeatedIdentityBytes = identityBytes === undefined
    ? undefined
    : identityBytes * input.droppedColumnCount;
  const projectedBytes = repeatedIdentityBytes === undefined
    ? undefined
    : checkedColumnDropTotal([valueBytes, repeatedIdentityBytes, structuralBytes]);
  if (
    !Number.isSafeInteger(staticIdentityBytes)
    || !Number.isSafeInteger(structuralBytes)
    || !Number.isSafeInteger(repeatedIdentityBytes)
    || aggregateOverflow
    || projectedBytes === undefined
    || projectedBytes > input.maxSnapshotBytes
  ) {
    throw new Error(
      `Column-drop undo snapshot exceeds the ${input.maxSnapshotBytes}-byte memory budget; ` +
      'drop fewer columns or rows, or increase sqliteExplorer.maxUndoMemory.'
    );
  }
}

export type ColumnDropForeignKeyBaseline = ReadonlyMap<string, number>;

type NormalizedForeignKeyViolation = readonly [string, string | null, string, string];

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
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function exactIntegerText(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && /^-?(?:0|[1-9]\d*)$/.test(value)) return value;
  return undefined;
}

/** Normalize an actual PRAGMA row without lossy unsafe-integer conversion. */
export function normalizeColumnDropForeignKeyViolation(
  table: string,
  row: readonly unknown[]
): NormalizedForeignKeyViolation {
  const rowid = exactIntegerText(row[1]);
  const fkid = exactIntegerText(row[3]);
  if (
    row.length !== 4
    || typeof row[0] !== 'string'
    || rowid === undefined
    || typeof row[2] !== 'string'
    || fkid === undefined
    || fkid === null
  ) {
    throw new Error(`Invalid foreign-key check row while undoing column drop on ${table}`);
  }
  return [row[0], rowid, row[2], fkid];
}

/** Measure before retaining/serializing a tuple so the count cap is also byte-bounded. */
export function columnDropForeignKeyViolationBytes(
  table: string,
  row: readonly unknown[]
): number {
  const normalized = normalizeColumnDropForeignKeyViolation(table, row);
  const fields = normalized.filter((value): value is string => value !== null);
  const fieldBytes = fields.map(utf8ByteLength);
  if (fieldBytes.some(bytes => bytes > COLUMN_DROP_FOREIGN_KEY_FIELD_BYTES_LIMIT)) {
    throw new Error(
      `Cannot undo column drop on ${table}: a foreign-key violation field exceeds the safety bound`
    );
  }
  return fieldBytes.reduce((total, bytes) => total + bytes, 0) + 32;
}

function foreignKeyViolationKey(table: string, row: readonly unknown[]): string {
  return JSON.stringify(normalizeColumnDropForeignKeyViolation(table, row));
}

/** Capture an exact, bounded multiset before the rebuild mutates any schema. */
export function captureColumnDropForeignKeyBaseline(
  table: string,
  rows: readonly (readonly unknown[])[]
): ColumnDropForeignKeyBaseline {
  if (rows.length > COLUMN_DROP_FOREIGN_KEY_VIOLATION_LIMIT) {
    throw new Error(
      `Cannot undo column drop on ${table}: more than ` +
      `${COLUMN_DROP_FOREIGN_KEY_VIOLATION_LIMIT} pre-existing foreign-key violations ` +
      `cannot be compared within the safety bound`
    );
  }
  const counts = new Map<string, number>();
  let aggregateBytes = 0;
  for (const row of rows) {
    aggregateBytes += columnDropForeignKeyViolationBytes(table, row);
    if (aggregateBytes > COLUMN_DROP_FOREIGN_KEY_VIOLATION_BYTES_LIMIT) {
      throw new Error(
        `Cannot undo column drop on ${table}: pre-existing foreign-key violations ` +
        `exceed the byte safety bound`
      );
    }
    const key = foreignKeyViolationKey(table, row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Reject only tuples whose post-rebuild multiplicity exceeds the baseline. */
export function assertNoNewColumnDropForeignKeyViolations(
  table: string,
  baseline: ColumnDropForeignKeyBaseline,
  rows: readonly (readonly unknown[])[]
): void {
  if (rows.length > COLUMN_DROP_FOREIGN_KEY_VIOLATION_LIMIT) {
    throw new Error(`Foreign-key check found new violations while undoing column drop on ${table}`);
  }
  const remaining = new Map(baseline);
  let aggregateBytes = 0;
  for (const row of rows) {
    aggregateBytes += columnDropForeignKeyViolationBytes(table, row);
    if (aggregateBytes > COLUMN_DROP_FOREIGN_KEY_VIOLATION_BYTES_LIMIT) {
      throw new Error(`Foreign-key check found new violations while undoing column drop on ${table}`);
    }
    const key = foreignKeyViolationKey(table, row);
    const count = remaining.get(key) ?? 0;
    if (count === 0) {
      throw new Error(`Foreign-key check found new violations while undoing column drop on ${table}`);
    }
    if (count === 1) remaining.delete(key);
    else remaining.set(key, count - 1);
  }
}

export type ColumnDropStatementExecutor = (
  sql: string
) => void | Promise<void>;

/**
 * Run SQLite's schema-aware DROP COLUMN statements in dependency-first order.
 * The caller owns the surrounding savepoint because rollback APIs differ by
 * engine; keeping statement construction here prevents demo/desktop drift.
 */
export async function executeSchemaPreservingColumnDrop(
  table: string,
  columns: readonly string[],
  dropDependentIndexes: readonly string[] | undefined,
  execute: ColumnDropStatementExecutor
): Promise<void> {
  const escapedMainTable = `main.${escapeIdentifier(table)}`;
  for (const indexName of dropDependentIndexes ?? []) {
    await execute(`DROP INDEX IF EXISTS main.${escapeIdentifier(indexName)}`);
  }

  for (const column of columns) {
    await execute(
      `ALTER TABLE ${escapedMainTable} DROP COLUMN ${escapeIdentifier(column)}`
    );
  }
}

/** Map SQLite catalog rows into the serializable state kept in undo history. */
export function mapColumnDropTableState(
  table: string,
  columns: readonly string[],
  identity: TableIdentity,
  rows: readonly (readonly unknown[])[],
  generatedColumns: readonly string[] = [],
  dataVersion?: number
): ColumnDropTableState {
  if (dataVersion !== undefined && (!Number.isSafeInteger(dataVersion) || dataVersion < 0)) {
    throw new Error(`Unable to capture the data version for ${table}`);
  }
  const tableRows = rows.filter(row => row[0] === 'table');
  if (
    tableRows.length !== 1
    || tableRows[0][1] !== table
    || typeof tableRows[0][2] !== 'string'
  ) {
    throw new Error(`Unable to capture the table definition for ${table}`);
  }

  const schemaObjects = rows
    .filter(row => row[0] === 'index' || row[0] === 'trigger')
    .map(row => {
      if (typeof row[1] !== 'string' || typeof row[2] !== 'string') {
        throw new Error(`Unable to capture a schema object for ${table}`);
      }
      return {
        type: row[0] as 'index' | 'trigger',
        identifier: row[1],
        sql: row[2]
      };
    });

  return {
    tableSql: tableRows[0][2],
    columns: [...columns],
    ...(generatedColumns.length > 0
      ? { generatedColumns: [...generatedColumns] }
      : {}),
    ...(dataVersion !== undefined ? { dataVersion } : {}),
    identity,
    schemaObjects
  };
}

function sameIdentity(left: TableIdentity, right: TableIdentity): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'rowid' || right.kind === 'rowid') return true;
  return left.columns.length === right.columns.length
    && left.columns.every((column, index) => {
      const other = right.columns[index];
      return column.identifier === other.identifier
        && column.declaredType === other.declaredType
        && column.position === other.position;
    });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameSchemaObjects(
  left: ColumnDropTableState['schemaObjects'],
  right: ColumnDropTableState['schemaObjects']
): boolean {
  return left.length === right.length
    && left.every((object, index) => {
      const other = right[index];
      return object.type === other.type
        && object.identifier === other.identifier
        && object.sql === other.sql;
    });
}

/** Refuse a destructive history transition when its recorded schema is stale. */
export function assertTableSchemaStateCurrent(
  table: string,
  expected: ColumnDropTableState,
  current: ColumnDropTableState,
  action: string,
  changedWhen: string
): void {
  if (expected.dataVersion !== undefined && expected.dataVersion !== current.dataVersion) {
    throw new Error(
      `Cannot ${action} on ${table}: database content changed ${changedWhen}`
    );
  }
  if (
    expected.tableSql !== current.tableSql
    || !sameStrings(expected.columns, current.columns)
    || !sameStrings(expected.generatedColumns ?? [], current.generatedColumns ?? [])
    || !sameIdentity(expected.identity, current.identity)
    || !sameSchemaObjects(expected.schemaObjects, current.schemaObjects)
  ) {
    throw new Error(
      `Cannot ${action} on ${table}: the table schema changed ${changedWhen}`
    );
  }
}

/** Refuse to overwrite schema that no longer matches the recorded post-drop state. */
export function assertColumnDropTableStateCurrent(
  table: string,
  expected: ColumnDropTableState,
  current: ColumnDropTableState
): void {
  assertTableSchemaStateCurrent(
    table,
    expected,
    current,
    'undo column drop',
    'after the column was dropped'
  );
}

export interface ColumnDropRestorePlan {
  stageColumns: string[];
  dropCurrentSchemaObjects: string[];
  renameCurrentTable: string;
  createOriginalTable: string;
  copyRows: string;
  dropStagingTable: string;
  restoreSchemaObjects: string[];
}

function validateState(state: ColumnDropTableState, label: string): void {
  if (typeof state.tableSql !== 'string' || state.tableSql.trim() === '') {
    throw new Error(`Invalid ${label} column-drop table SQL`);
  }
  if (!Array.isArray(state.columns) || state.columns.length === 0) {
    throw new Error(`Invalid ${label} column-drop columns`);
  }
  if (state.dataVersion !== undefined
      && (!Number.isSafeInteger(state.dataVersion) || state.dataVersion < 0)) {
    throw new Error(`Invalid ${label} column-drop data version`);
  }
  const columnNames = new Set<string>();
  for (const column of state.columns) {
    if (typeof column !== 'string' || column === '' || columnNames.has(column)) {
      throw new Error(`Invalid ${label} column-drop column: ${String(column)}`);
    }
    columnNames.add(column);
  }
  const generatedNames = new Set<string>();
  for (const column of state.generatedColumns ?? []) {
    if (
      typeof column !== 'string'
      || !columnNames.has(column)
      || generatedNames.has(column)
    ) {
      throw new Error(`Invalid ${label} generated column: ${String(column)}`);
    }
    generatedNames.add(column);
  }
  if (!state.identity || (state.identity.kind !== 'rowid' && state.identity.kind !== 'primaryKey')) {
    throw new Error(`Invalid ${label} column-drop identity`);
  }
  if (state.identity.kind === 'primaryKey' && state.identity.columns.length === 0) {
    throw new Error(`Invalid ${label} column-drop primary key`);
  }
  const objectNames = new Set<string>();
  for (const object of state.schemaObjects) {
    const key = `${object.type}\0${object.identifier}`;
    if (
      (object.type !== 'index' && object.type !== 'trigger')
      || typeof object.identifier !== 'string'
      || object.identifier === ''
      || typeof object.sql !== 'string'
      || object.sql.trim() === ''
      || objectNames.has(key)
    ) {
      throw new Error(`Invalid ${label} column-drop schema object`);
    }
    objectNames.add(key);
  }
}

/**
 * Build the shared DDL portion of positional column restoration.
 *
 * Restored values are staged by the engine before this plan runs. The table is
 * then rebuilt from SQLite's exact original CREATE statement, which restores
 * ordinal position and every captured table constraint without trying to parse
 * or synthesize DDL in JavaScript.
 */
export function buildColumnDropRestorePlan(
  table: string,
  stagingTable: string,
  deletedColumns: readonly { name: string; type: string }[],
  snapshot: ColumnDropSnapshot
): ColumnDropRestorePlan {
  validateState(snapshot.before, 'pre-drop');
  validateState(snapshot.after, 'post-drop');
  if (!sameIdentity(snapshot.before.identity, snapshot.after.identity)) {
    throw new Error(`Invalid column-drop identity transition for ${table}`);
  }
  if (!stagingTable || stagingTable.toLowerCase() === table.toLowerCase()) {
    throw new Error(`Invalid staging table for column-drop undo on ${table}`);
  }

  const deletedNames = new Set<string>();
  for (const column of deletedColumns) {
    if (!column || typeof column.name !== 'string' || column.name === '' || deletedNames.has(column.name)) {
      throw new Error(`Invalid deleted column history for ${table}`);
    }
    if (column.type !== '') validateSqlType(column.type);
    deletedNames.add(column.name);
  }
  const expectedAfterColumns = snapshot.before.columns.filter(column => !deletedNames.has(column));
  const expectedAfterGeneratedColumns = (snapshot.before.generatedColumns ?? [])
    .filter(column => !deletedNames.has(column));
  if (
    deletedNames.size === 0
    || !sameStrings(snapshot.after.columns, expectedAfterColumns)
    || !sameStrings(snapshot.after.generatedColumns ?? [], expectedAfterGeneratedColumns)
    || [...deletedNames].some(column => !snapshot.before.columns.includes(column))
  ) {
    throw new Error(`Invalid column-drop ordinal snapshot for ${table}`);
  }

  for (const currentObject of snapshot.after.schemaObjects) {
    if (!snapshot.before.schemaObjects.some(original => (
      original.type === currentObject.type
      && original.identifier === currentObject.identifier
      && original.sql === currentObject.sql
    ))) {
      throw new Error(`Invalid post-drop schema object snapshot for ${table}`);
    }
  }

  const escapedTable = `main.${escapeIdentifier(table)}`;
  const escapedStagingTable = `main.${escapeIdentifier(stagingTable)}`;
  const escapedRenameTarget = escapeIdentifier(stagingTable);
  const generatedColumns = new Set(snapshot.before.generatedColumns ?? []);
  const escapedColumns = snapshot.before.columns
    .filter(column => !generatedColumns.has(column))
    .map(escapeIdentifier);
  const copyColumns = snapshot.before.identity.kind === 'rowid'
    ? ['rowid', ...escapedColumns]
    : escapedColumns;

  return {
    stageColumns: deletedColumns.map(column => {
      const declaredType = column.type === '' ? '' : ` ${column.type}`;
      return `ALTER TABLE ${escapedTable} ADD COLUMN ${escapeIdentifier(column.name)}${declaredType}`;
    }),
    dropCurrentSchemaObjects: snapshot.after.schemaObjects.map(object => (
      `DROP ${object.type.toUpperCase()} main.${escapeIdentifier(object.identifier)}`
    )),
    renameCurrentTable: `ALTER TABLE ${escapedTable} RENAME TO ${escapedRenameTarget}`,
    createOriginalTable: snapshot.before.tableSql,
    copyRows:
      `INSERT INTO ${escapedTable} (${copyColumns.join(', ')}) ` +
      `SELECT ${copyColumns.join(', ')} FROM ${escapedStagingTable}`,
    dropStagingTable: `DROP TABLE ${escapedStagingTable}`,
    restoreSchemaObjects: snapshot.before.schemaObjects.map(object => (
      object.type === 'index'
        ? qualifyMainCreateIndexSql(object.sql, object.identifier)
        : qualifyMainCreateTriggerSql(object.sql, object.identifier)
    ))
  };
}
