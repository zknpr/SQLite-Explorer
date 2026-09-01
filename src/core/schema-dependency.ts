import { escapeIdentifier } from './sql-utils';
import type { CellValue } from './types';
import {
  buildStoredTriggerValidationSql,
  readStoredTriggerValidationHeader
} from './view-utils';

export const MAX_SCHEMA_DEPENDENCY_SCHEMAS = 32;
export const MAX_SCHEMA_DEPENDENCY_PROBES = 1024;

export type SchemaDependencyObjectKind = 'view' | 'trigger';

export interface SchemaDependencyProbeResult {
  key: string;
  kind: SchemaDependencyObjectKind;
  schema: string;
  identifier: string;
  targetSchema?: string;
  targetIdentifier?: string;
  valid: boolean;
  error?: string;
}

export type SchemaDependencySnapshot = Map<string, SchemaDependencyProbeResult>;

export interface SchemaDependencyProbeAdapter {
  queryRows(sql: string, params?: CellValue[]): Promise<readonly (readonly CellValue[])[]>;
  compileStatements(sql: readonly string[]): Promise<readonly (string | undefined)[]>;
}

interface CatalogObject {
  schema: string;
  kind: SchemaDependencyObjectKind;
  identifier: string;
  targetIdentifier?: string;
  sql: string;
}

interface PendingProbe extends Omit<SchemaDependencyProbeResult, 'valid' | 'error'> {
  sql: string;
}

function foldIdentifier(identifier: string): string {
  return identifier.replace(/[A-Z]/g, character => character.toLowerCase());
}

function schemaObjectKey(
  kind: SchemaDependencyObjectKind,
  schema: string,
  identifier: string,
  targetSchema?: string,
  targetIdentifier?: string
): string {
  const base = `${kind}:${foldIdentifier(schema)}:${foldIdentifier(identifier)}`;
  return targetSchema === undefined || targetIdentifier === undefined
    ? base
    : `${base}:${foldIdentifier(targetSchema)}:${foldIdentifier(targetIdentifier)}`;
}

function errorText(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.length > 500 ? `${detail.slice(0, 500)}...` : detail;
}

function assertBound(value: number, maximum: number, label: string): void {
  if (value <= maximum) return;
  throw new Error(
    `View dependency validation refused to inspect ${value} ${label}; ` +
    `the fail-closed limit is ${maximum}`
  );
}

async function readSchemaNames(
  adapter: SchemaDependencyProbeAdapter
): Promise<string[]> {
  const rows = await adapter.queryRows('PRAGMA database_list');
  const schemas: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row[1] !== 'string') {
      throw new Error('SQLite returned invalid database-list metadata during view validation');
    }
    const folded = foldIdentifier(row[1]);
    if (!seen.has(folded)) {
      seen.add(folded);
      schemas.push(row[1]);
    }
  }
  if (!seen.has('temp')) schemas.unshift('temp');
  assertBound(schemas.length, MAX_SCHEMA_DEPENDENCY_SCHEMAS, 'database schemas');
  return schemas;
}

async function readCatalogObjects(
  adapter: SchemaDependencyProbeAdapter,
  schemas: readonly string[]
): Promise<CatalogObject[]> {
  const objects: CatalogObject[] = [];
  for (const schema of schemas) {
    const remaining = MAX_SCHEMA_DEPENDENCY_PROBES - objects.length;
    if (remaining < 0) {
      assertBound(objects.length, MAX_SCHEMA_DEPENDENCY_PROBES, 'schema objects');
    }
    const rows = await adapter.queryRows(
      `SELECT type, name, tbl_name, sql FROM ${escapeIdentifier(schema)}.sqlite_schema ` +
      `WHERE type IN ('view', 'trigger') ORDER BY type, name LIMIT ${remaining + 1}`
    );
    for (const row of rows) {
      const [kind, identifier, targetIdentifier, sql] = row;
      if ((kind !== 'view' && kind !== 'trigger')
          || typeof identifier !== 'string'
          || typeof sql !== 'string'
          || (kind === 'trigger' && typeof targetIdentifier !== 'string')) {
        throw new Error(
          `SQLite returned invalid ${schema} schema metadata during view validation`
        );
      }
      objects.push({
        schema,
        kind,
        identifier,
        targetIdentifier: kind === 'trigger' ? targetIdentifier as string : undefined,
        sql
      });
    }
    assertBound(objects.length, MAX_SCHEMA_DEPENDENCY_PROBES, 'schema objects');
  }
  return objects;
}

async function objectExists(
  adapter: SchemaDependencyProbeAdapter,
  schema: string,
  identifier: string
): Promise<boolean> {
  const rows = await adapter.queryRows(
    `SELECT 1 FROM ${escapeIdentifier(schema)}.sqlite_schema ` +
    "WHERE type IN ('table', 'view') AND name = ? COLLATE NOCASE LIMIT 1",
    [identifier]
  );
  return rows.length > 0;
}

async function resolveTriggerTargetSchemas(
  adapter: SchemaDependencyProbeAdapter,
  schemas: readonly string[],
  trigger: CatalogObject
): Promise<string[]> {
  const header = readStoredTriggerValidationHeader(trigger.sql);
  if (header.targetSchema !== undefined) return [header.targetSchema];
  if (foldIdentifier(trigger.schema) !== 'temp') return [trigger.schema];

  const candidates: string[] = [];
  for (const schema of schemas) {
    if (await objectExists(adapter, schema, trigger.targetIdentifier!)) {
      candidates.push(schema);
    }
  }
  // A missing target is itself an invalid trigger state. Keep one deterministic
  // probe so pre-existing damage can be compared with the proposed schema.
  return candidates.length > 0 ? candidates : ['main'];
}

async function readWritableColumns(
  adapter: SchemaDependencyProbeAdapter,
  schema: string,
  target: string
): Promise<string[]> {
  const rows = await adapter.queryRows(
    `PRAGMA ${escapeIdentifier(schema)}.table_xinfo(${escapeIdentifier(target)})`
  );
  const columns: string[] = [];
  for (const row of rows) {
    if (typeof row[1] !== 'string') {
      throw new Error(
        `SQLite returned invalid column metadata for ${schema}.${target}`
      );
    }
    const hidden = row[6];
    if (hidden !== 2 && hidden !== 2n && hidden !== 3 && hidden !== 3n) {
      columns.push(row[1]);
    }
  }
  return columns;
}

/**
 * Compile every stored view and every trigger event without executing user DML.
 * Callers capture before and after snapshots inside their mutation savepoint.
 */
export async function captureSchemaDependencySnapshot(
  adapter: SchemaDependencyProbeAdapter
): Promise<SchemaDependencySnapshot> {
  const schemas = await readSchemaNames(adapter);
  const objects = await readCatalogObjects(adapter, schemas);
  const snapshot: SchemaDependencySnapshot = new Map();
  const pending: PendingProbe[] = [];
  const columnCache = new Map<string, Promise<string[]>>();

  for (const object of objects) {
    if (object.kind === 'view') {
      pending.push({
        key: schemaObjectKey('view', object.schema, object.identifier),
        kind: 'view',
        schema: object.schema,
        identifier: object.identifier,
        sql:
          `EXPLAIN SELECT * FROM ${escapeIdentifier(object.schema)}.` +
          `${escapeIdentifier(object.identifier)}`
      });
      continue;
    }

    let targetSchemas: string[];
    try {
      targetSchemas = await resolveTriggerTargetSchemas(adapter, schemas, object);
    } catch (error) {
      const key = schemaObjectKey('trigger', object.schema, object.identifier);
      snapshot.set(key, {
        key,
        kind: 'trigger',
        schema: object.schema,
        identifier: object.identifier,
        valid: false,
        error: errorText(error)
      });
      continue;
    }

    for (const targetSchema of targetSchemas) {
      const targetIdentifier = object.targetIdentifier!;
      const key = schemaObjectKey(
        'trigger',
        object.schema,
        object.identifier,
        targetSchema,
        targetIdentifier
      );
      try {
        const cacheKey = `${foldIdentifier(targetSchema)}:${foldIdentifier(targetIdentifier)}`;
        let columns = columnCache.get(cacheKey);
        if (!columns) {
          columns = readWritableColumns(adapter, targetSchema, targetIdentifier);
          columnCache.set(cacheKey, columns);
        }
        pending.push({
          key,
          kind: 'trigger',
          schema: object.schema,
          identifier: object.identifier,
          targetSchema,
          targetIdentifier,
          sql: buildStoredTriggerValidationSql(
            object.sql,
            targetSchema,
            targetIdentifier,
            await columns
          )
        });
      } catch (error) {
        snapshot.set(key, {
          key,
          kind: 'trigger',
          schema: object.schema,
          identifier: object.identifier,
          targetSchema,
          targetIdentifier,
          valid: false,
          error: errorText(error)
        });
      }
    }
  }

  assertBound(
    pending.length + snapshot.size,
    MAX_SCHEMA_DEPENDENCY_PROBES,
    'view and trigger probes'
  );
  const errors = await adapter.compileStatements(pending.map(probe => probe.sql));
  if (errors.length !== pending.length) {
    throw new Error('View dependency validation returned an incomplete probe result set');
  }
  pending.forEach((probe, index) => {
    const error = errors[index];
    snapshot.set(probe.key, {
      key: probe.key,
      kind: probe.kind,
      schema: probe.schema,
      identifier: probe.identifier,
      targetSchema: probe.targetSchema,
      targetIdentifier: probe.targetIdentifier,
      valid: error === undefined,
      ...(error === undefined ? {} : { error })
    });
  });
  return snapshot;
}

/** Reject only valid-to-invalid transitions, leaving unrelated old damage untouched. */
export function assertNoNewBrokenSchemaDependencies(
  before: SchemaDependencySnapshot,
  after: SchemaDependencySnapshot
): void {
  for (const previous of before.values()) {
    if (!previous.valid) continue;
    const current = after.get(previous.key);
    if (!current || current.valid) continue;
    const target = current.targetSchema && current.targetIdentifier
      ? ` on ${current.targetSchema}.${current.targetIdentifier}`
      : '';
    throw new Error(
      `View change would break existing ${current.kind} ` +
      `"${current.schema}.${current.identifier}"${target}: ${current.error ?? 'SQLite rejected it'}`
    );
  }
}
