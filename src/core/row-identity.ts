import type {
  CellValue,
  PrimaryKeyColumn,
  RecordId,
  TableIdentity
} from './types';
import { SQLITE_MAX_VARIABLE_NUMBER } from './integer-utils';
import { escapeIdentifier, validateRowId } from './sql-utils';

const PRIMARY_KEY_RECORD_ID_PREFIX = 'pk:';
const PRIMARY_KEY_RECORD_ID_VERSION = 1;
const READ_ONLY_PRIMARY_KEY_RECORD_ID_PREFIX = 'readonly-pk:';
const READ_ONLY_PRIMARY_KEY_RECORD_ID_VERSION = 1;

/** Set-based identity metadata used by every schema-loading backend. */
export const TABLE_IDENTITY_METADATA_SQL = `
SELECT
  tl."name" AS table_name,
  tl."type" AS object_type,
  tl."wr" AS without_rowid,
  ti."cid" AS column_ordinal,
  ti."name" AS column_name,
  ti."type" AS declared_type,
  ti."pk" AS primary_key_position
FROM pragma_table_list AS tl
LEFT JOIN pragma_table_info(tl."name", tl."schema") AS ti
  ON tl."type" = 'table' AND tl."wr" = 1
WHERE tl."schema" = 'main' AND tl."name" NOT LIKE 'sqlite_%'
ORDER BY tl."name", ti."cid"`;

export type EncodedPrimaryKeyValue =
  | ['integer', string]
  | ['real', number | 'positive-infinity' | 'negative-infinity']
  | ['text', string]
  | ['blob', string];

interface PrimaryKeyRecordIdPayload {
  v: 1;
  c: Array<[string, EncodedPrimaryKeyValue]>;
}

interface ReadOnlyPrimaryKeyRecordIdPayload {
  v: 1;
  r: number;
  m: string;
}

export interface DecodedPrimaryKeyRecordId {
  columns: string[];
  values: CellValue[];
}

interface DecodedPrimaryKeyRecordIdInternal extends DecodedPrimaryKeyRecordId {
  storageClasses: EncodedPrimaryKeyValue[0][];
  encodedValues: EncodedPrimaryKeyValue[];
}

export interface RecordIdentityPredicate {
  sql: string;
  params: CellValue[];
  primaryKey?: DecodedPrimaryKeyRecordId;
  /** Per-member CAST flags for structured native locators; never raw SQL. */
  primaryKeyIntegerCasts?: boolean[];
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Canonical per-storage-class value codec, shared with keyset anchor tokens. */
export function encodePrimaryKeyValue(value: CellValue | bigint): EncodedPrimaryKeyValue {
  if (typeof value === 'bigint') return ['integer', value.toString()];
  if (typeof value === 'number') {
    if (Number.isNaN(value)) throw new Error('Primary-key REAL identity cannot be NaN');
    if (value === Number.POSITIVE_INFINITY) return ['real', 'positive-infinity'];
    if (value === Number.NEGATIVE_INFINITY) return ['real', 'negative-infinity'];
    return ['real', value];
  }
  if (typeof value === 'string') return ['text', value];
  if (value instanceof Uint8Array) return ['blob', bytesToHex(value)];
  throw new Error('WITHOUT ROWID primary-key identity cannot contain NULL');
}

function decodePrimaryKeyValueWithClass(encoded: unknown): {
  value: CellValue;
  storageClass: EncodedPrimaryKeyValue[0];
} {
  if (!Array.isArray(encoded) || encoded.length !== 2 || typeof encoded[0] !== 'string') {
    throw new Error('Invalid primary-key identity value');
  }
  const [storageClass, value] = encoded;
  switch (storageClass) {
    case 'integer':
      if (typeof value !== 'string') throw new Error('Invalid primary-key INTEGER identity');
      let canonicalInteger: string;
      try {
        canonicalInteger = BigInt(value).toString();
      } catch {
        throw new Error('Invalid primary-key INTEGER identity');
      }
      if (value !== canonicalInteger) {
        throw new Error('Primary-key INTEGER identity is not canonical');
      }
      return { value: validateRowId(value), storageClass };
    case 'real':
      if (value === 'positive-infinity') {
        return { value: Number.POSITIVE_INFINITY, storageClass };
      }
      if (value === 'negative-infinity') {
        return { value: Number.NEGATIVE_INFINITY, storageClass };
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error('Invalid primary-key REAL identity');
      }
      return { value, storageClass };
    case 'text':
      if (typeof value !== 'string') throw new Error('Invalid primary-key TEXT identity');
      return { value, storageClass };
    case 'blob':
      if (typeof value !== 'string' || value.length % 2 !== 0 || !/^[0-9a-f]*$/.test(value)) {
        throw new Error('Invalid primary-key BLOB identity');
      }
      return { value: hexToBytes(value), storageClass };
    default:
      throw new Error(`Unsupported primary-key identity storage class: ${storageClass}`);
  }
}

export function decodePrimaryKeyValue(encoded: unknown): CellValue {
  return decodePrimaryKeyValueWithClass(encoded).value;
}

export function isPrimaryKeyRecordId(recordId: unknown): recordId is string {
  return typeof recordId === 'string' && recordId.startsWith(PRIMARY_KEY_RECORD_ID_PREFIX);
}

export function isReadOnlyPrimaryKeyRecordId(recordId: unknown): recordId is string {
  return typeof recordId === 'string'
    && recordId.startsWith(READ_ONLY_PRIMARY_KEY_RECORD_ID_PREFIX);
}

/** Create a non-mutable row token without embedding any truncated key bytes. */
export function encodeReadOnlyPrimaryKeyRecordId(
  reason: string,
  rowOrdinal: number
): RecordId {
  if (!reason || reason.length > 4096) {
    throw new Error('Read-only primary-key reason must contain 1 through 4096 characters');
  }
  if (!Number.isSafeInteger(rowOrdinal) || rowOrdinal < 0) {
    throw new Error(`Invalid read-only primary-key row ordinal: ${rowOrdinal}`);
  }
  const payload: ReadOnlyPrimaryKeyRecordIdPayload = {
    v: READ_ONLY_PRIMARY_KEY_RECORD_ID_VERSION,
    r: rowOrdinal,
    m: reason
  };
  return READ_ONLY_PRIMARY_KEY_RECORD_ID_PREFIX
    + encodeURIComponent(JSON.stringify(payload));
}

function decodeReadOnlyPrimaryKeyRecordId(recordId: string): ReadOnlyPrimaryKeyRecordIdPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(decodeURIComponent(
      recordId.slice(READ_ONLY_PRIMARY_KEY_RECORD_ID_PREFIX.length)
    ));
  } catch {
    throw new Error('Invalid read-only primary-key identity encoding');
  }
  if (
    !payload
    || typeof payload !== 'object'
    || Array.isArray(payload)
    || Object.keys(payload).length !== 3
    || (payload as { v?: unknown }).v !== READ_ONLY_PRIMARY_KEY_RECORD_ID_VERSION
    || !Number.isSafeInteger((payload as { r?: unknown }).r)
    || Number((payload as { r?: unknown }).r) < 0
    || typeof (payload as { m?: unknown }).m !== 'string'
    || String((payload as { m?: unknown }).m).length < 1
    || String((payload as { m?: unknown }).m).length > 4096
  ) {
    throw new Error('Invalid read-only primary-key identity payload');
  }
  const decoded = payload as ReadOnlyPrimaryKeyRecordIdPayload;
  const canonical = READ_ONLY_PRIMARY_KEY_RECORD_ID_PREFIX
    + encodeURIComponent(JSON.stringify(decoded));
  if (canonical !== recordId) {
    throw new Error('Read-only primary-key identity is not canonical');
  }
  return decoded;
}

/** Fail every mutation path with the exact reason transported by the grid. */
export function assertMutableRecordId(recordId: RecordId): void {
  if (!isReadOnlyPrimaryKeyRecordId(recordId)) return;
  throw new Error(decodeReadOnlyPrimaryKeyRecordId(recordId).m);
}

/** Encode ordered PK values into a canonical, RPC- and URI-safe opaque RecordId. */
export function encodePrimaryKeyRecordId(
  columns: readonly PrimaryKeyColumn[],
  values: readonly (CellValue | bigint)[]
): RecordId {
  if (columns.length === 0 || columns.length !== values.length) {
    throw new Error('Primary-key identity column/value count mismatch');
  }
  const payload: PrimaryKeyRecordIdPayload = {
    v: PRIMARY_KEY_RECORD_ID_VERSION,
    c: columns.map((column, index) => [
      column.identifier,
      encodePrimaryKeyValue(values[index])
    ])
  };
  return PRIMARY_KEY_RECORD_ID_PREFIX + encodeURIComponent(JSON.stringify(payload));
}

function decodePrimaryKeyRecordIdInternal(
  recordId: unknown
): DecodedPrimaryKeyRecordIdInternal {
  if (!isPrimaryKeyRecordId(recordId)) {
    throw new Error(`Invalid primary-key identity: ${String(recordId)}`);
  }

  let raw: string;
  let payload: unknown;
  try {
    raw = decodeURIComponent(recordId.slice(PRIMARY_KEY_RECORD_ID_PREFIX.length));
    payload = JSON.parse(raw);
  } catch {
    throw new Error('Invalid primary-key identity encoding');
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 2 ||
    (payload as { v?: unknown }).v !== PRIMARY_KEY_RECORD_ID_VERSION ||
    !Array.isArray((payload as { c?: unknown }).c)
  ) {
    throw new Error('Invalid primary-key identity payload');
  }

  const encodedColumns = (payload as PrimaryKeyRecordIdPayload).c;
  if (encodedColumns.length === 0) throw new Error('Primary-key identity has no columns');
  const seen = new Set<string>();
  const columns: string[] = [];
  const values: CellValue[] = [];
  const storageClasses: EncodedPrimaryKeyValue[0][] = [];
  const encodedValues: EncodedPrimaryKeyValue[] = [];
  for (const member of encodedColumns) {
    if (!Array.isArray(member) || member.length !== 2 || typeof member[0] !== 'string') {
      throw new Error('Invalid primary-key identity member');
    }
    if (seen.has(member[0])) throw new Error(`Duplicate primary-key identity column: ${member[0]}`);
    seen.add(member[0]);
    columns.push(member[0]);
    const decoded = decodePrimaryKeyValueWithClass(member[1]);
    values.push(decoded.value);
    storageClasses.push(decoded.storageClass);
    encodedValues.push(member[1] as EncodedPrimaryKeyValue);
  }

  const canonical = PRIMARY_KEY_RECORD_ID_PREFIX + encodeURIComponent(JSON.stringify(payload));
  if (canonical !== recordId) throw new Error('Primary-key identity is not canonical');
  return { columns, values, storageClasses, encodedValues };
}

/** Decode and strictly validate an opaque PK RecordId received over RPC/history/URI. */
export function decodePrimaryKeyRecordId(recordId: unknown): DecodedPrimaryKeyRecordId {
  const { columns, values } = decodePrimaryKeyRecordIdInternal(recordId);
  return { columns, values };
}

function decodeDeclaredPrimaryKeyRecordId(
  recordId: RecordId,
  identity: Extract<TableIdentity, { kind: 'primaryKey' }>
): DecodedPrimaryKeyRecordIdInternal {
  assertMutableRecordId(recordId);
  const decoded = decodePrimaryKeyRecordIdInternal(recordId);
  const expectedColumns = identity.columns.map(column => column.identifier);
  if (
    decoded.columns.length !== expectedColumns.length ||
    decoded.columns.some((column, index) => column !== expectedColumns[index])
  ) {
    throw new Error(
      `Primary-key identity columns do not match the declared key (${expectedColumns.join(', ')})`
    );
  }
  return decoded;
}

/**
 * Replace selected PK members without reclassifying untouched encoded values.
 * This matters for unsafe INTEGERs, whose decoded transport value is a string.
 */
export function replacePrimaryKeyRecordIdValues(
  recordId: RecordId,
  identity: Extract<TableIdentity, { kind: 'primaryKey' }>,
  replacements: readonly { column: string; value: CellValue | bigint }[]
): RecordId {
  const decoded = decodeDeclaredPrimaryKeyRecordId(recordId, identity);
  const replacementValues = new Map<string, CellValue | bigint>();
  const declaredColumns = new Set(identity.columns.map(column => column.identifier));
  for (const replacement of replacements) {
    if (!declaredColumns.has(replacement.column)) {
      throw new Error(`Primary-key replacement column is not declared: ${replacement.column}`);
    }
    if (replacementValues.has(replacement.column)) {
      throw new Error(`Duplicate primary-key replacement column: ${replacement.column}`);
    }
    replacementValues.set(replacement.column, replacement.value);
  }

  const payload: PrimaryKeyRecordIdPayload = {
    v: PRIMARY_KEY_RECORD_ID_VERSION,
    c: identity.columns.map((column, index) => [
      column.identifier,
      replacementValues.has(column.identifier)
        ? encodePrimaryKeyValue(replacementValues.get(column.identifier)!)
        : decoded.encodedValues[index]
    ])
  };
  return PRIMARY_KEY_RECORD_ID_PREFIX + encodeURIComponent(JSON.stringify(payload));
}

/**
 * Unsafe INTEGER identities decode to decimal strings. Match the keyset seek
 * discipline and restore the encoded storage class explicitly at every bind;
 * this also covers affinity-less STRICT ANY columns without extra metadata.
 */
function primaryKeyBindPlaceholder(
  storageClass: EncodedPrimaryKeyValue[0]
): string {
  return storageClass === 'integer'
    ? 'CAST(? AS INTEGER)'
    : '?';
}

export function buildRecordIdentityPredicate(
  recordId: RecordId,
  identity: TableIdentity
): RecordIdentityPredicate {
  assertMutableRecordId(recordId);
  if (identity.kind === 'rowid') {
    return { sql: 'rowid = ?', params: [validateRowId(recordId)] };
  }

  const decoded = decodeDeclaredPrimaryKeyRecordId(recordId, identity);
  const expectedColumns = identity.columns.map(column => column.identifier);
  const placeholders = expectedColumns.map((_, index) => primaryKeyBindPlaceholder(
    decoded.storageClasses[index]
  ));
  return {
    sql: expectedColumns.map((column, index) => (
      `${escapeIdentifier(column)} = ${placeholders[index]}`
    )).join(' AND '),
    params: decoded.values,
    primaryKey: { columns: decoded.columns, values: decoded.values },
    primaryKeyIntegerCasts: placeholders.map(placeholder => placeholder !== '?')
  };
}

export function buildRecordIdentitiesPredicate(
  recordIds: readonly RecordId[],
  identity: TableIdentity
): RecordIdentityPredicate {
  if (recordIds.length === 0) throw new Error('At least one row identity is required');

  if (identity.kind === 'rowid') {
    const predicates = recordIds.map(recordId => buildRecordIdentityPredicate(recordId, identity));
    return {
      sql: `rowid IN (${predicates.map(() => '?').join(', ')})`,
      params: predicates.flatMap(predicate => predicate.params)
    };
  }

  const decodedIdentities = recordIds.map(
    recordId => decodeDeclaredPrimaryKeyRecordId(recordId, identity)
  );
  const escapedColumns = identity.columns.map(column => escapeIdentifier(column.identifier));
  const params = decodedIdentities.flatMap(decoded => decoded.values);
  if (escapedColumns.length === 1) {
    return {
      sql: `${escapedColumns[0]} IN (${decodedIdentities.map(decoded => (
        primaryKeyBindPlaceholder(
          decoded.storageClasses[0]
        )
      )).join(', ')})`,
      params
    };
  }

  const tuplePlaceholders = decodedIdentities.map(decoded => (
    `(${decoded.storageClasses.map(storageClass => (
      primaryKeyBindPlaceholder(storageClass)
    )).join(', ')})`
  ));
  return {
    sql: `(${escapedColumns.join(', ')}) IN (VALUES ${tuplePlaceholders.join(', ')})`,
    params
  };
}

/**
 * Split identity groups before SQL construction so every statement remains
 * below the bundled SQLite variable ceiling. One slot stays reserved to match
 * the established batch-update discipline and leave callers room for an
 * operation-specific bind without silently crossing the limit.
 */
export function buildRecordIdentityPredicateChunks(
  recordIds: readonly RecordId[],
  identity: TableIdentity
): RecordIdentityPredicate[] {
  if (recordIds.length === 0) throw new Error('At least one row identity is required');
  const seen = new Set<string>();
  for (const recordId of recordIds) {
    let canonical: string;
    if (identity.kind === 'rowid') {
      canonical = `rowid:${String(validateRowId(recordId))}`;
    } else {
      decodeDeclaredPrimaryKeyRecordId(recordId, identity);
      canonical = `primaryKey:${String(recordId)}`;
    }
    if (seen.has(canonical)) {
      // A duplicate split across chunks would otherwise be selected twice and
      // produce duplicate history rows even though SQLite deletes it only once.
      throw new Error('Duplicate row identities are not allowed');
    }
    seen.add(canonical);
  }
  const bindsPerIdentity = identity.kind === 'rowid' ? 1 : identity.columns.length;
  const maxRowsPerChunk = Math.max(
    1,
    Math.floor((SQLITE_MAX_VARIABLE_NUMBER - 1) / bindsPerIdentity)
  );
  const predicates: RecordIdentityPredicate[] = [];
  for (let offset = 0; offset < recordIds.length; offset += maxRowsPerChunk) {
    predicates.push(buildRecordIdentitiesPredicate(
      recordIds.slice(offset, offset + maxRowsPerChunk),
      identity
    ));
  }
  return predicates;
}

/** Map pragma_table_list's object kind to the row identity supported by SQLite Explorer. */
export function classifyTableIdentity(
  objectType: unknown,
  withoutRowId: unknown
): TableIdentity['kind'] | undefined {
  if (objectType === 'virtual' || objectType === 'shadow') return 'rowid';
  if (objectType !== 'table') return undefined;
  return Number(withoutRowId) === 1 ? 'primaryKey' : 'rowid';
}

/** Build table identities from TABLE_IDENTITY_METADATA_SQL's ordered result rows. */
export function buildTableIdentityMap(
  rows: readonly (readonly unknown[])[]
): Map<string, TableIdentity> {
  const metadata = new Map<string, {
    kind: TableIdentity['kind'];
    columns: Array<{
      identifier: string;
      declaredType: string;
      primaryKeyPosition: number;
    }>;
  }>();

  for (const row of rows) {
    const table = row[0];
    if (typeof table !== 'string') {
      throw new Error('SQLite returned invalid table identity metadata');
    }
    const kind = classifyTableIdentity(row[1], row[2]);
    if (!kind) continue;

    let entry = metadata.get(table);
    if (!entry) {
      entry = { kind, columns: [] };
      metadata.set(table, entry);
    } else if (entry.kind !== kind) {
      throw new Error(`SQLite returned inconsistent identity metadata for ${table}`);
    }

    if (kind === 'primaryKey' && row[4] !== null && row[4] !== undefined) {
      if (typeof row[4] !== 'string' || typeof row[5] !== 'string') {
        throw new Error(`SQLite returned invalid column identity metadata for ${table}`);
      }
      entry.columns.push({
        identifier: row[4],
        declaredType: row[5],
        primaryKeyPosition: Number(row[6])
      });
    }
  }

  const identities = new Map<string, TableIdentity>();
  for (const [table, entry] of metadata) {
    if (entry.kind === 'rowid') {
      identities.set(table, { kind: 'rowid' });
      continue;
    }
    const columns = primaryKeyColumnsFromTableInfo(entry.columns);
    if (columns.length === 0) {
      throw new Error(`WITHOUT ROWID table ${table} has no declared primary key`);
    }
    identities.set(table, { kind: 'primaryKey', columns });
  }
  return identities;
}

export function primaryKeyColumnsFromTableInfo(
  columns: readonly {
    identifier: string;
    declaredType: string;
    primaryKeyPosition: number;
  }[]
): PrimaryKeyColumn[] {
  return columns
    .filter(column => column.primaryKeyPosition > 0)
    .map(column => ({
      identifier: column.identifier,
      declaredType: column.declaredType,
      position: column.primaryKeyPosition
    }))
    .sort((left, right) => left.position - right.position);
}
