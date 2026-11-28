import type {
  CellUpdate,
  CellValue,
  PrimaryKeyColumn,
  RecordId,
  TableIdentity
} from './types';
import { SQLITE_MAX_VARIABLE_NUMBER } from './integer-utils';
import { escapeIdentifier, escapeMainIdentifier, validateRowId } from './sql-utils';

const PRIMARY_KEY_RECORD_ID_PREFIX = 'pk:';
const PRIMARY_KEY_RECORD_ID_VERSION = 1;
const READ_ONLY_PRIMARY_KEY_RECORD_ID_PREFIX = 'readonly-pk:';
const READ_ONLY_PRIMARY_KEY_RECORD_ID_VERSION = 1;

/**
 * Set-based identity metadata used by every schema-loading backend. SQLite's
 * special `pragma` schema is required here: unqualified or `main` names can
 * resolve to ordinary user tables that shadow the PRAGMA virtual tables.
 * Key members also report their primary key's collation, as
 * TABLE_XINFO_WITH_ROWID_ALIAS_SQL does. They match the key index by name:
 * table_info leaves generated columns out of its cid numbering.
 * table_info is asked only about the WITHOUT ROWID tables whose columns are
 * read (a NULL name returns no row). SQLite runs it for every joined row
 * before the ON clause, and for a virtual table whose module the build lacks
 * it fails with "no such module", which failed the whole schema load.
 */
export const TABLE_IDENTITY_METADATA_SQL = `
SELECT
  tl."name" AS table_name,
  tl."type" AS object_type,
  tl."wr" AS without_rowid,
  ti."cid" AS column_ordinal,
  ti."name" AS column_name,
  ti."type" AS declared_type,
  ti."pk" AS primary_key_position,
  CASE WHEN ti."pk" > 0 THEN (
    SELECT key."coll" FROM pragma.pragma_index_list(tl."name", tl."schema") AS pk_index
    JOIN pragma.pragma_index_xinfo(pk_index."name", tl."schema") AS key
    WHERE pk_index."origin" = 'pk' AND key."name" = ti."name" AND key."key" = 1 LIMIT 1
  ) END AS primary_key_collation
FROM pragma.pragma_table_list AS tl
LEFT JOIN pragma.pragma_table_info(
  CASE WHEN tl."type" IN ('table', 'shadow') AND tl."wr" = 1 THEN tl."name" END, tl."schema"
) AS ti
  ON tl."type" IN ('table', 'shadow') AND tl."wr" = 1
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
  /** Per-member storage classes, for joins that apply buildStorageClassGuards. */
  primaryKeyStorageClasses?: EncodedPrimaryKeyValue[0][];
}

/**
 * SQLite exposes no final row handle when an UPDATE trigger moves or removes a
 * WITHOUT ROWID key. RETURNING observes pre-AFTER-trigger values, so callers
 * must roll back instead of presenting a guessed identity as successful.
 */
export function unresolvableTriggeredPrimaryKeyUpdateError(table: string): Error {
  return new Error(
    `An UPDATE trigger changed or removed the primary-key identity in ${table}; ` +
    'the edit was rolled back because SQLite Explorer cannot safely identify the resulting row.'
  );
}

/**
 * A rowid table has no second stable handle after a trigger moves its row.
 * Roll the whole savepoint back instead of returning a stale identity that
 * would make undo or a subsequent edit target the wrong row.
 */
export function unresolvableTriggeredRowIdUpdateError(table: string): Error {
  return new Error(
    `An UPDATE trigger changed or removed the rowid identity in ${table}; ` +
    'the edit was rolled back because SQLite Explorer cannot safely identify the resulting row.'
  );
}

/** Let SQLite itself decide which UPDATE/UPDATE OF triggers apply. */
export function buildUpdateTriggerProbeSql(
  table: string,
  columns: readonly string[],
  hasIntrinsicRowId: boolean = true
): string {
  const uniqueColumns = [...new Set(columns)];
  if (uniqueColumns.length === 0) {
    throw new Error('UPDATE trigger probe requires at least one column');
  }
  const assignments = uniqueColumns.map(column => {
    const quoted = escapeIdentifier(column);
    return `${quoted} = ${quoted}`;
  });
  const predicate = hasIntrinsicRowId ? 'rowid = ?' : '0';
  return `EXPLAIN UPDATE OR ABORT ${escapeMainIdentifier(table)} SET ${assignments.join(', ')} WHERE ${predicate}`;
}

/**
 * Compile the exact INSERT trigger set without executing constraints or user
 * code. Probes carry the OR ABORT the engines' history writes use.
 */
export function buildInsertTriggerProbeSql(
  table: string,
  columns: readonly string[]
): string {
  const insert = columns.length === 0
    ? `INSERT OR ABORT INTO ${escapeMainIdentifier(table)} DEFAULT VALUES`
    : `INSERT OR ABORT INTO ${escapeMainIdentifier(table)} ` +
      `(${columns.map(escapeIdentifier).join(', ')}) VALUES ` +
      `(${columns.map(() => 'NULL').join(', ')})`;
  return `EXPLAIN ${insert}`;
}

/** Compile DELETE triggers and active FK actions independently of row identity. */
export function buildDeleteTriggerProbeSql(table: string): string {
  return `EXPLAIN DELETE FROM ${escapeMainIdentifier(table)} WHERE 0`;
}

/** Main-schema btree identity used to distinguish target writes in EXPLAIN. */
export const MAIN_TABLE_ROOT_PAGE_SQL =
  `SELECT "rootpage" FROM main.sqlite_schema ` +
  `WHERE "type" = 'table' AND "name" = ? LIMIT 2`;

/** Validate the singleton root page before trusting it as a bytecode authority. */
export function parseMainTableRootPage(
  rows: readonly (readonly unknown[])[],
  table: string
): number {
  if (rows.length !== 1 || rows[0].length < 1) {
    throw new Error(`SQLite returned invalid table root-page metadata for ${table}`);
  }
  const rawRootPage = rows[0][0];
  const rootPage = typeof rawRootPage === 'bigint'
    ? Number(rawRootPage)
    : rawRootPage;
  if (!Number.isSafeInteger(rootPage) || Number(rootPage) < 0) {
    throw new Error(`SQLite returned invalid table root-page metadata for ${table}`);
  }
  return Number(rootPage);
}

function readExplainInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'bigint' ? Number(value) : value;
  return Number.isSafeInteger(parsed) ? Number(parsed) : undefined;
}

/**
 * Reject applicable user-trigger programs that can write this table's btree.
 *
 * SQLite exposes neither an AFTER-trigger row handle nor enough stable register
 * semantics to prove that an arbitrary self-write preserved the edited row.
 * We therefore use OpenWrite/Clear against the target table to select the
 * stronger identity error; every applicable user-trigger program is rejected
 * because its side effects are outside history. For foreign-key UPDATE programs,
 * only CASCADE is reversible through the existing parent-row history; SET
 * NULL/DEFAULT sever the reference and must be rejected before mutation.
 * Returns whether such a CASCADE compiled: it can change rows other than the
 * one updated.
 */
export function assertNoApplicableUpdateTriggerTargetWrites(
  table: string,
  targetRootPage: number,
  rows: readonly (readonly unknown[])[],
  identityKind: 'rowid' | 'primary-key' = 'rowid'
): boolean {
  if (!Number.isSafeInteger(targetRootPage) || targetRootPage < 0) {
    throw new Error(`SQLite returned invalid table root-page metadata for ${table}`);
  }

  let hasApplicableUserTrigger = false;
  let subprogramStart = -1;
  let programCount = 0;
  let hasUntrackedForeignKeyUpdate = false;
  let foreignKeyProgram: {
    isUserTrigger: boolean;
    hasWrite: boolean;
    prologueParameters: number[];
    parametersAfterWrite: Set<number>;
    prologueComplete: boolean;
  } | undefined;

  const finishForeignKeyProgram = () => {
    if (!foreignKeyProgram || foreignKeyProgram.isUserTrigger || !foreignKeyProgram.hasWrite) {
      return;
    }

    // SQLite's FK UPDATE subprogram starts with old/new parent parameter
    // pairs. CASCADE later reads every new-parent parameter while constructing
    // the child row; SET NULL/DEFAULT instead emit literal/default opcodes.
    // Treat any unfamiliar shape as unsafe rather than guessing from Program.
    const parameters = foreignKeyProgram.prologueParameters;
    const parametersAfterWrite = foreignKeyProgram.parametersAfterWrite;
    const newParentParameters = parameters.filter((_, index) => index % 2 === 1);
    const provesCascade = parameters.length > 0
      && parameters.length % 2 === 0
      && newParentParameters.every(parameter => parametersAfterWrite.has(parameter));
    if (!provesCascade) hasUntrackedForeignKeyUpdate = true;
  };

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.length < 6 || typeof row[1] !== 'string') {
      throw new Error(`SQLite returned invalid UPDATE trigger metadata for ${table}`);
    }
    const address = readExplainInteger(row[0]);
    if (address === undefined) {
      throw new Error(`SQLite returned invalid UPDATE trigger metadata for ${table}`);
    }
    if (row[1] === 'Init' && address === 0) {
      finishForeignKeyProgram();
      programCount += 1;
      if (programCount === 2) subprogramStart = index;
      const isUserTrigger = typeof row[5] === 'string'
        && row[5].startsWith('-- TRIGGER ');
      if (isUserTrigger) {
        hasApplicableUserTrigger = true;
      }
      foreignKeyProgram = programCount > 1
        ? {
            isUserTrigger,
            hasWrite: false,
            prologueParameters: [],
            parametersAfterWrite: new Set<number>(),
            prologueComplete: false
          }
        : undefined;
      continue;
    }

    if (!foreignKeyProgram) continue;
    if (row[1] === 'Param') {
      const parameter = readExplainInteger(row[2]);
      if (parameter === undefined) {
        throw new Error(`SQLite returned invalid UPDATE trigger metadata for ${table}`);
      }
      if (foreignKeyProgram.hasWrite) {
        foreignKeyProgram.parametersAfterWrite.add(parameter);
      } else if (!foreignKeyProgram.prologueComplete) {
        foreignKeyProgram.prologueParameters.push(parameter);
      }
      continue;
    }
    if (row[1] === 'OpenWrite' || row[1] === 'Clear') {
      foreignKeyProgram.prologueComplete = true;
      foreignKeyProgram.hasWrite = true;
    } else if (row[1].startsWith('Open')) {
      foreignKeyProgram.prologueComplete = true;
    }
  }
  finishForeignKeyProgram();

  if (hasApplicableUserTrigger) {
    if (subprogramStart < 0) {
      throw new Error(`SQLite returned invalid UPDATE trigger metadata for ${table}`);
    }

    const writesTarget = rows.slice(subprogramStart).some(row => {
      if (row[1] === 'OpenWrite') {
        const rootPage = readExplainInteger(row[3]);
        const databaseIndex = readExplainInteger(row[4]);
        if (rootPage === undefined || databaseIndex === undefined) {
          throw new Error(`SQLite returned invalid UPDATE trigger metadata for ${table}`);
        }
        return rootPage === targetRootPage && databaseIndex === 0;
      }
      if (row[1] === 'Clear') {
        const rootPage = readExplainInteger(row[2]);
        const databaseIndex = readExplainInteger(row[3]);
        if (rootPage === undefined || databaseIndex === undefined) {
          throw new Error(`SQLite returned invalid UPDATE trigger metadata for ${table}`);
        }
        return rootPage === targetRootPage && databaseIndex === 0;
      }
      return false;
    });
    if (writesTarget) {
      throw new Error(
        'SQLite Explorer cannot prove whether an applicable UPDATE trigger changed or removed ' +
        `the ${identityKind} identity in ${table}; the trigger can write the target table, so the edit ` +
        `was rolled back because SQLite cannot expose a trustworthy post-trigger ${identityKind} identity.`
      );
    }
    throw new Error(
      `Cannot update ${table} while an applicable UPDATE trigger can run; ` +
      'the operation was rolled back because trigger side effects cannot be represented safely ' +
      'in undo history.'
    );
  }

  if (hasUntrackedForeignKeyUpdate) {
    throw new Error(
      `Cannot update ${table} while a mutating foreign-key UPDATE action can run; ` +
      'the operation was rolled back because affected child rows are not represented in undo history.'
    );
  }
  // What is left is an allowed ON UPDATE CASCADE, which can change other rows.
  return programCount > 1;
}

/**
 * Reject INSERT/DELETE programs whose side effects are not captured by the
 * row-level history payload. User triggers are always unsafe: even a program
 * with no btree write can RAISE(IGNORE), making history claim a mutation that
 * never happened. For DELETE, FK CASCADE/SET actions appear as non-trigger
 * subprograms with a write cursor; RESTRICT/NO ACTION remain allowed.
 */
export function assertNoUntrackedMutationPrograms(
  operation: 'INSERT' | 'DELETE',
  table: string,
  rows: readonly (readonly unknown[])[]
): void {
  let programCount = 0;
  let mutatingForeignKeyProgram = false;

  for (const row of rows) {
    if (row.length < 6 || typeof row[1] !== 'string') {
      throw new Error(`SQLite returned invalid ${operation} trigger metadata for ${table}`);
    }
    const address = readExplainInteger(row[0]);
    if (address === undefined) {
      throw new Error(`SQLite returned invalid ${operation} trigger metadata for ${table}`);
    }

    if (row[1] === 'Init' && address === 0) {
      programCount += 1;
      if (typeof row[5] === 'string' && row[5].startsWith('-- TRIGGER ')) {
        throw new Error(
          `Cannot ${operation.toLowerCase()} ${table} while an applicable ${operation} trigger can run; ` +
          'the operation was rolled back because trigger side effects cannot be represented safely ' +
          'in undo history.'
        );
      }
      continue;
    }

    if (
      operation === 'DELETE'
      && programCount > 1
      && (row[1] === 'OpenWrite' || row[1] === 'Clear')
    ) {
      mutatingForeignKeyProgram = true;
    }
  }

  if (mutatingForeignKeyProgram) {
    throw new Error(
      `Cannot delete from ${table} while a mutating foreign-key DELETE action can run; ` +
      'the operation was rolled back because affected child rows are not represented in undo history.'
    );
  }
}

/**
 * Rowid-changing updates cannot authenticate the resulting row after an AFTER
 * trigger runs. Applicable trigger subprograms carry an Init p4 marker; this
 * deliberately excludes foreign-key action subprograms such as ON UPDATE
 * CASCADE, which also use the generic Program opcode.
 */
export function assertNoApplicableUpdateTriggerPrograms(
  table: string,
  rows: readonly (readonly unknown[])[]
): void {
  for (const row of rows) {
    if (row.length < 6 || typeof row[1] !== 'string') {
      throw new Error(`SQLite returned invalid UPDATE trigger metadata for ${table}`);
    }
    if (
      row[1] === 'Init'
      && typeof row[5] === 'string'
      && row[5].startsWith('-- TRIGGER ')
    ) {
      throw new Error(
        `Cannot change the rowid identity in ${table} while an UPDATE trigger can run; ` +
        'the edit was rolled back because SQLite cannot expose a trustworthy post-trigger row identity.'
      );
    }
  }
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

function foldSqliteIdentifier(identifier: string): string {
  return identifier.replace(/[A-Z]/g, character => (
    String.fromCharCode(character.charCodeAt(0) + 0x20)
  ));
}

/**
 * Reject aliases of the same batch target before any savepoint or write.
 *
 * Rowids are canonicalized through the same exact-int64 validator used by the
 * statements, while PK identities are decoded against the declared key (which
 * also proves that their opaque transport encoding is canonical). SQLite folds
 * ASCII identifier case, so `value` and `VALUE` are the same target column.
 */
export function assertUniqueCellUpdateTargets(
  updates: readonly CellUpdate[],
  identity: TableIdentity
): void {
  const columnsByRow = new Map<string, Set<string>>();
  for (const update of updates) {
    const canonicalRowId = identity.kind === 'rowid'
      ? `rowid:${String(validateRowId(update.rowId))}`
      : (() => {
          decodeDeclaredPrimaryKeyRecordId(update.rowId, identity);
          return `primary-key:${String(update.rowId)}`;
        })();
    const canonicalColumn = foldSqliteIdentifier(update.column);
    let columns = columnsByRow.get(canonicalRowId);
    if (!columns) {
      columns = new Set<string>();
      columnsByRow.set(canonicalRowId, columns);
    }
    if (columns.has(canonicalColumn)) {
      throw new Error(
        `Duplicate batch update target for row ${String(update.rowId)}, column ${update.column}`
      );
    }
    columns.add(canonicalColumn);
  }
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
 * The unary plus drops the CAST's INTEGER affinity, which would compare a
 * typeless key under NUMERIC affinity: INTEGER 1 would also match TEXT '1',
 * and the one-row guards would refuse both rows.
 */
function primaryKeyBindPlaceholder(
  storageClass: EncodedPrimaryKeyValue[0]
): string {
  return storageClass === 'integer'
    ? '+CAST(? AS INTEGER)'
    : '?';
}

/**
 * An identity names storage of its own class only. Its placeholder carries no
 * affinity, so the column applies its own: a column declared TEXT compares a
 * number as text, and one declared INTEGER or REAL compares numeric-looking
 * text as a number. The class check keeps an identity to storage of its
 * own class.
 * A REAL identity also accepts INTEGER: the native engine reports an integer
 * key up to 2^53 as a number, which does not say whether it is stored INTEGER
 * or REAL. BLOB is never converted for a comparison and is not checked.
 */
function storageClassGuard(
  escapedColumn: string,
  storageClass: EncodedPrimaryKeyValue[0]
): string | undefined {
  if (storageClass === 'integer') return `typeof(${escapedColumn}) = 'integer'`;
  if (storageClass === 'real') return `typeof(${escapedColumn}) IN ('integer', 'real')`;
  if (storageClass === 'text') return `typeof(${escapedColumn}) = 'text'`;
  return undefined;
}

/** The storage-class guards an identity's members need, over the given column expressions. */
export function buildStorageClassGuards(
  columnSql: readonly string[],
  storageClasses: readonly EncodedPrimaryKeyValue[0][]
): string[] {
  return columnSql.flatMap((column, index) => (
    storageClassGuard(column, storageClasses[index]) ?? []
  ));
}

/**
 * A key member as a comparison or ORDER BY operand, under the collation its
 * primary key compares it with. The column's own collation can be looser,
 * such as NOCASE on a column whose key is BINARY: a bare comparison then names
 * every row that differs only in case, and cannot search the key's index.
 */
export function primaryKeyColumnSql(column: PrimaryKeyColumn, qualifier = ''): string {
  const escaped = qualifier + escapeIdentifier(column.identifier);
  return column.collation === undefined
    ? escaped
    : `${escaped} COLLATE ${escapeIdentifier(column.collation)}`;
}

/** A balanced OR keeps the expression depth logarithmic in the term count. */
function joinWithOr(terms: readonly string[]): string {
  if (terms.length === 1) return terms[0];
  const middle = Math.ceil(terms.length / 2);
  return `(${joinWithOr(terms.slice(0, middle))} OR ${joinWithOr(terms.slice(middle))})`;
}

/**
 * `writtenColumns` names key members just written, whose identity value has
 * the class of the value written rather than the class the column's affinity
 * stored, such as a number written to a TEXT key. Re-reading the row after
 * that write compares those members without the storage-class check.
 */
export function buildRecordIdentityPredicate(
  recordId: RecordId,
  identity: TableIdentity,
  writtenColumns: readonly string[] = []
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
    sql: expectedColumns.map((column, index) => {
      const escaped = escapeIdentifier(column);
      const guard = writtenColumns.includes(column)
        ? undefined
        : storageClassGuard(escaped, decoded.storageClasses[index]);
      return `${primaryKeyColumnSql(identity.columns[index])} = ${placeholders[index]}` +
        (guard ? ` AND ${guard}` : '');
    }).join(' AND '),
    params: decoded.values,
    primaryKey: { columns: decoded.columns, values: decoded.values },
    primaryKeyIntegerCasts: placeholders.map(placeholder => placeholder !== '?'),
    primaryKeyStorageClasses: decoded.storageClasses
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
  // Each identity needs the storage-class guards of buildRecordIdentityPredicate.
  // Identities that need the same guards share one IN, so an ordinary table,
  // whose keys usually share their classes, keeps a single IN that seeks.
  const groups = new Map<string, { guards: string[]; identities: DecodedPrimaryKeyRecordIdInternal[] }>();
  for (const decoded of decodedIdentities) {
    const guards = buildStorageClassGuards(escapedColumns, decoded.storageClasses);
    const key = guards.join(' AND ');
    const group = groups.get(key);
    if (group) group.identities.push(decoded);
    else groups.set(key, { guards, identities: [decoded] });
  }

  // With key collations, a row-value IN, or an IN joined by OR, compares under
  // the collations of a subquery's columns: on the left side they keep it from
  // searching the key's index. A lone single-column IN searches with them on
  // the left, also when they differ from the column's own.
  const subqueryCollations = identity.columns.some(column => column.collation !== undefined)
    && (escapedColumns.length > 1 || groups.size > 1);
  const valueColumns = identity.columns.map((column, index) => (
    column.collation === undefined
      ? `column${index + 1}`
      : `column${index + 1} COLLATE ${escapeIdentifier(column.collation)}`
  ));
  const keyColumns = escapedColumns.length === 1 ? escapedColumns[0] : `(${escapedColumns.join(', ')})`;
  const terms = [...groups.values()].map(({ guards, identities }) => {
    const rows = identities.map(decoded => (
      `(${decoded.storageClasses.map(primaryKeyBindPlaceholder).join(', ')})`
    ));
    let membership: string;
    if (subqueryCollations) {
      membership = `${keyColumns} IN (SELECT ${valueColumns.join(', ')} FROM (VALUES ${rows.join(', ')}))`;
    } else if (escapedColumns.length === 1) {
      membership = `${primaryKeyColumnSql(identity.columns[0])} IN (${identities.map(decoded => (
        primaryKeyBindPlaceholder(decoded.storageClasses[0])
      )).join(', ')})`;
    } else {
      membership = `${keyColumns} IN (VALUES ${rows.join(', ')})`;
    }
    return [membership, ...guards].join(' AND ');
  });
  return {
    sql: terms.length === 1
      ? terms[0]
      : joinWithOr(terms.map(term => `(${term})`)),
    params: [...groups.values()].flatMap(({ identities }) => (
      identities.flatMap(decoded => decoded.values)
    ))
  };
}

/**
 * An identity's members as its predicate matches them: numbers by value,
 * whatever their class, since a REAL member also matches INTEGER storage.
 */
function identityMatchKey(recordId: RecordId): string {
  return JSON.stringify(decodePrimaryKeyRecordIdInternal(recordId).encodedValues.map(
    ([storageClass, value]) => {
      if (storageClass === 'integer') return ['number', value];
      if (storageClass === 'real') {
        return ['number', typeof value === 'number' && Number.isInteger(value)
          ? BigInt(value).toString()
          : String(value)];
      }
      return [storageClass, value];
    }
  ));
}

/**
 * Require one matched row per requested primary-key identity. `matched` are
 * the identities of the rows the requested predicates selected. Each
 * identity is counted on its own.
 */
export function assertOneRowPerIdentity(
  table: string,
  requested: readonly RecordId[],
  matched: readonly RecordId[]
): void {
  const counts = new Map<string, number>();
  for (const recordId of matched) {
    const key = identityMatchKey(recordId);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const recordId of requested) {
    const key = identityMatchKey(recordId);
    const count = counts.get(key) ?? 0;
    if (count === 0) {
      throw new Error(`Cannot delete from ${table}: one or more row identities no longer exist`);
    }
    if (count > 1) {
      throw new Error(`Cannot delete from ${table}: a row identity matched more than one row`);
    }
    counts.delete(key);
  }
  if (counts.size > 0) {
    throw new Error(`Cannot delete from ${table}: a row identity matched a row it does not name`);
  }
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
  if (objectType === 'virtual') return 'rowid';
  // FTS5's _idx and _config shadow tables use WITHOUT ROWID storage.
  if (objectType !== 'table' && objectType !== 'shadow') return undefined;
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
      primaryKeyCollation?: string;
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
        primaryKeyPosition: Number(row[6]),
        ...(typeof row[7] === 'string' ? { primaryKeyCollation: row[7] } : {})
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
    primaryKeyCollation?: string;
  }[]
): PrimaryKeyColumn[] {
  return columns
    .filter(column => column.primaryKeyPosition > 0)
    .map(column => ({
      identifier: column.identifier,
      declaredType: column.declaredType,
      position: column.primaryKeyPosition,
      ...(column.primaryKeyCollation !== undefined ? { collation: column.primaryKeyCollation } : {})
    }))
    .sort((left, right) => left.position - right.position);
}
