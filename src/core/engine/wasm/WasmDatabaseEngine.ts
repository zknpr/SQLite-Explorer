/**
 * WebAssembly-based SQLite database engine (sql.js).
 *
 * Extracted from src/core/sqlite-db.ts as a standalone module so the
 * factory and worker entry point in sqlite-db can stay slim and so a
 * future native engine can sit alongside under src/core/engine/.
 *
 * Imports getNodeFs from src/core/platform/fs to avoid a circular
 * dependency back into sqlite-db.
 */

import type {
  CellValue,
  RecordId,
  QueryResultSet,
  ModificationEntry,
  DatabaseOperations,
  CellUpdate,
  CellUpdateResult,
  TableQueryOptions,
  TableCountOptions,
  SchemaSnapshot,
  ColumnMetadata,
  ColumnDefinition,
  ViewDefinition,
  ViewDefinitionIntent,
  ViewEditResult,
  ViewTriggerDefinition,
  TableIdentity,
  DeletedRow
} from '../../types';
import { escapeIdentifier, validateSqlType, validateRowId, validateRowIds } from '../../sql-utils';
import { crypto } from '../../../platform/cryptoShim';
import { buildSelectQuery, buildCountQuery } from '../../query-builder';
import {
  applyMergePatch,
  computeJsonPatchUndo,
  parseJsonValueForPatching,
  prepareCellUpdateForStorage
} from '../../json-utils';
import {
  buildExactNumericTextQuery,
  buildRowIdExactRealTextQueries,
  collectRowIdExactRealTexts,
  hasUnsafeBigIntAtColumn,
  normalizeIntegerRowsForTransport,
  ROWID_TABLE_AUTHORITY_SQL
} from '../../integer-utils';
import { getNodeFs } from '../../platform/fs';
import {
  buildRecordIdentitiesPredicate,
  buildRecordIdentityPredicate,
  buildTableIdentityMap,
  classifyTableIdentity,
  decodePrimaryKeyRecordId,
  encodePrimaryKeyRecordId,
  isPrimaryKeyRecordId,
  primaryKeyColumnsFromTableInfo,
  TABLE_IDENTITY_METADATA_SQL
} from '../../row-identity';
import {
  assertViewDefinitionSnapshotCurrent,
  assertViewDefinitionStateCurrent,
  assertViewDefinitionIntent,
  assertViewTriggerSnapshotIsMutationSafe,
  assertViewTriggersCompatibleWithColumns,
  buildCreateViewTriggerSql,
  buildCreateViewSql,
  extractViewColumnListSql,
  extractViewSelectSql,
  escapeMainViewIdentifier,
  mapViewTriggerRows,
  VIEW_TRIGGER_SCHEMA_QUERIES,
  normalizeViewSelectSql
} from '../../view-utils';

// ============================================================================
// Internal sql.js Types
// ============================================================================

type WasmBindValue = Exclude<CellValue, bigint>;

interface WasmPreparedStatement {
  run(params?: WasmBindValue[]): void;
  bind(params?: WasmBindValue[]): boolean;
  get(params?: WasmBindValue[]): CellValue[] | undefined;
  get(
    params: WasmBindValue[] | null | undefined,
    config: { useBigInt: true }
  ): Array<CellValue | bigint> | undefined;
  step(): boolean;
  reset(): void;
  free(): boolean;
  getColumnNames(): string[];
  getSQL(): string;
}

export interface WasmDatabaseInstance {
  exec(sql: string, params?: WasmBindValue[]): Array<{ columns: string[]; values: CellValue[][] }>;
  prepare(sql: string, params?: WasmBindValue[]): WasmPreparedStatement;
  iterateStatements(sql: string): Iterable<WasmPreparedStatement>;
  export(): Uint8Array;
  close(): void;
}

export interface WasmEngineModule {
  Database: new (data?: ArrayLike<number>) => WasmDatabaseInstance;
}

export type WasmEngineLogHandler = (
  level: 'log' | 'warn' | 'error',
  ...args: unknown[]
) => void;

interface ExistingViewForIntent {
  storedSql: CellValue | undefined;
  columnListSql: string | undefined;
}

/**
 * sql.js does not expose a native int64 bind; its current BigInt branch binds
 * decimal text internally. Perform that conversion at our boundary so history
 * replay remains exact without depending on an undocumented binder detail.
 */
function normalizeWasmBindParams(
  params?: readonly CellValue[]
): WasmBindValue[] | undefined {
  return params?.map(value => typeof value === 'bigint' ? value.toString() : value);
}

// ============================================================================
// Database Engine Implementation
// ============================================================================

/**
 * Default query timeout in milliseconds (30 seconds).
 */
const DEFAULT_QUERY_TIMEOUT_MS = 30000;

export class WasmDatabaseEngine implements DatabaseOperations {
  private readonly instance: WasmDatabaseInstance;
  private readonly queryTimeout: number;
  private readonly readOnlyMode: boolean;
  private readonly logger: WasmEngineLogHandler;
  /** Whether SQLite's json_patch() function is available (JSON1 extension). */
  private readonly hasJsonPatch: boolean;
  readonly engineKind = Promise.resolve('wasm' as const);

  constructor(
    instance: WasmDatabaseInstance,
    timeoutMs: number = DEFAULT_QUERY_TIMEOUT_MS,
    readOnlyMode: boolean = false,
    logger?: WasmEngineLogHandler
  ) {
    this.instance = instance;
    this.queryTimeout = timeoutMs;
    this.readOnlyMode = readOnlyMode;
    this.logger = logger ?? ((level, ...args) => console[level](...args));

    if (this.readOnlyMode) {
      // Public mutation methods fail early with operation-specific messages,
      // while SQLite itself blocks any overlooked or newly added write path.
      instance.exec('PRAGMA query_only = ON');
    }

    // Probe for json_patch() availability at construction time.
    // json_patch() is part of the JSON1 extension, which is included in most
    // sql.js WASM builds but not guaranteed in all environments.
    try {
      instance.exec("SELECT json_patch('{}', '{}')");
      this.hasJsonPatch = true;
    } catch {
      this.hasJsonPatch = false;
    }
  }

  /**
   * Attempt a ROLLBACK and log failures instead of throwing.
   * Used in catch blocks where the original error should propagate,
   * not a secondary rollback failure.
   */
  private async safeRollback(context: string): Promise<void> {
    try {
      await this.executeQuery('ROLLBACK');
    } catch (rollbackErr) {
      this.logger('warn', `Failed to rollback (${context}):`, rollbackErr);
    }
  }

  /**
   * Build a quoted SAVEPOINT name that is unique enough for nested engine work.
   */
  private createSavepointName(prefix: string): string {
    return escapeIdentifier(`${prefix}_${crypto.randomUUID().replace(/-/g, '')}`);
  }

  /**
   * Roll back and release a SAVEPOINT without masking the original failure.
   */
  private async safeRollbackSavepoint(savepointName: string, context: string): Promise<void> {
    try {
      await this.executeQuery(`ROLLBACK TO ${savepointName}`);
      await this.executeQuery(`RELEASE ${savepointName}`);
    } catch (rollbackErr) {
      this.logger('warn', `Failed to rollback savepoint (${context}):`, rollbackErr);
    }
  }

  /** Prepare only when SQLite proves the statement consumed our generated suffix. */
  private prepareSingleStatement(sql: string): WasmPreparedStatement {
    const boundary = `/*sqlite_explorer_boundary_${crypto.randomUUID().replace(/-/g, '')}*/`;
    const statement = this.instance.prepare(`${sql}\n${boundary}`);
    if (!statement.getSQL().trimEnd().endsWith(boundary)) {
      statement.free();
      throw new Error('Exactly one SQL statement is required');
    }
    return statement;
  }

  /** Execute exactly the checked prepared statement, never a trailing statement. */
  private runSingleStatement(sql: string): void {
    // Validate with the boundary comment, then execute the original SQL so a
    // CREATE statement does not persist our private marker in sqlite_schema.
    this.compileSingleStatement(sql);
    const statement = this.instance.prepare(sql);
    try {
      statement.run();
    } finally {
      statement.free();
    }
  }

  /** Compile a statement through SQLite without retaining or executing it. */
  private compileSingleStatement(sql: string): void {
    const statement = this.prepareSingleStatement(sql);
    statement.free();
  }

  /** Compile the body in a SELECT-only context and reject trailing statements. */
  private compileViewSelect(selectSql: string): void {
    this.compileSingleStatement(`EXPLAIN SELECT * FROM (${selectSql}\n) LIMIT 0`);
  }

  /**
   * Read a generated preview SELECT with a best-effort elapsed-time bound. The
   * bundled sql.js API and WebAssembly exports expose neither sqlite3_interrupt
   * nor sqlite3_progress_handler. Because statement.step() synchronously owns
   * this worker thread, a queued host message cannot preempt an expensive first
   * row. The checks below reject after a step returns, while the worker RPC
   * deadline only bounds how long the host waits. True in-worker interruption is
   * deferred until sql.js exposes an interrupt or progress-handler hook.
   */
  private executeSingleQuery(sql: string): QueryResultSet {
    const sourceStatement = this.prepareSingleStatement(sql);
    const headers = sourceStatement.getColumnNames();
    sourceStatement.free();
    const transportQuery = buildExactNumericTextQuery(sql, headers.length);
    const statement = this.prepareSingleStatement(transportQuery.sql);
    const sourceRows: Array<Array<CellValue | bigint>> = [];
    const startedAt = Date.now();
    try {
      while (statement.step()) {
        if (Date.now() - startedAt > this.queryTimeout) {
          throw new Error(`Query execution timed out after ${this.queryTimeout}ms`);
        }
        const row = statement.get(null, { useBigInt: true });
        if (!row) {
          throw new Error('SQLite returned no row after a successful statement step');
        }
        sourceRows.push(row);
      }
      const { rows, exactIntegerTexts } = normalizeIntegerRowsForTransport(
        sourceRows,
        transportQuery.valueColumnCount
      );
      return { headers, rows, columns: headers, values: rows, exactIntegerTexts };
    } finally {
      statement.free();
    }
  }

  /**
   * Normalize serialized cell replay operations for old and malformed history.
   */
  private normalizeReplayCellOperation(
    operation: unknown,
    strict: boolean,
    context: string
  ): 'set' | 'json_patch' {
    if (operation === undefined || operation === null) return 'set';
    if (operation === 'set' || operation === 'json_patch') return operation;
    if (strict) throw new Error(`Cannot apply ${context}: unsupported cell operation ${String(operation)}`);
    return 'set';
  }

  /**
   * Execute a SQL query and return structured results.
   *
   * Returns results in sql.js compatible format for webview compatibility.
   * The webview expects { columns, values } format from the original sql.js.
   * Implements query timeout to prevent runaway queries.
   *
   * @param sql - SQL statement to execute
   * @param params - Optional bound parameters
   * @returns Array of result sets in sql.js format
   */
  async executeQuery(sql: string, params?: CellValue[]): Promise<QueryResultSet[]> {
    const startTime = Date.now();
    const results: QueryResultSet[] = [];
    let currentStmt: WasmPreparedStatement | null = null;

    try {
      const iterator = this.instance.iterateStatements(sql);
      let isFirstStatement = true;

      for (const stmt of iterator) {
        currentStmt = stmt;

        // Bind parameters only to the first statement to match exec behavior
        if (isFirstStatement && params && params.length > 0) {
          stmt.bind(normalizeWasmBindParams(params));
        }
        isFirstStatement = false;

        const rows: CellValue[][] = [];

        while (stmt.step()) {
          // Check timeout during row iteration
          if (Date.now() - startTime > this.queryTimeout) {
            stmt.free();
            currentStmt = null; // Prevent double-free in catch block
            throw new Error(`Query execution timed out after ${this.queryTimeout}ms`);
          }
          const row = stmt.get();
          if (row) {
            rows.push(row);
          }
        }

        const columns = stmt.getColumnNames();
        // Only include results that have columns (matching exec behavior)
        if (columns.length > 0) {
          results.push({
            columns,
            values: rows,
            headers: columns,
            rows
          });
        }

        // iterateStatements handles freeing - clear reference
        currentStmt = null;
      }
    } catch (err) {
      // Ensure current statement is freed if iteration was interrupted
      if (currentStmt) {
        try {
          currentStmt.free();
        } catch (freeErr) {
          this.logger('warn', 'Failed to free statement on error:', freeErr);
        }
      }
      const errorDetail = err instanceof Error ? err.message : String(err);
      throw new Error(`Query failed: ${errorDetail}`);
    }

    return results;
  }

  /**
   * Serialize the database to binary format.
   *
   * @param _name - Identifier (unused, for interface compatibility)
   * @returns Database binary content
   */
  async serializeDatabase(): Promise<Uint8Array> {
    return this.instance.export();
  }

  /**
   * Apply a batch of modifications.
   *
   * Hot-exit restore opens the last saved database bytes first, then replays
   * the serialized uncommitted edit entries into that fresh in-memory database.
   * Each entry is applied through the same forward path used by redo so restore
   * and redo cannot drift apart.
   */
  async applyModifications(
    mods: ModificationEntry[],
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted();
    if (mods.length === 0) return;

    const savepointName = this.createSavepointName('sp_apply_modifications');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      for (const mod of mods) {
        // Check cancellation at the replay boundary so an aborted restore stops
        // before the next modification starts mutating the in-memory database.
        signal?.throwIfAborted();
        await this.forwardApply(mod, true);
        signal?.throwIfAborted();
      }
      signal?.throwIfAborted();
      await this.executeQuery(`RELEASE ${savepointName}`);
    } catch (err) {
      await this.safeRollbackSavepoint(savepointName, 'applyModifications');
      throw err;
    }
  }

  /**
   * Undo a modification.
   */
  async undoModification(mod: ModificationEntry): Promise<void> {
    const { modificationType, targetTable } = mod;
    if (!targetTable) return;

    switch (modificationType) {
      case 'cell_update':
        await this.undoCellUpdate(targetTable, mod);
        break;

      case 'row_insert':
        await this.undoRowInsert(targetTable, mod);
        break;

      case 'row_delete':
        await this.undoRowDelete(targetTable, mod);
        break;

      case 'column_add':
        await this.undoColumnAdd(targetTable, mod);
        break;

      case 'column_drop':
        await this.undoColumnDrop(targetTable, mod);
        break;

      case 'table_create':
        await this.undoTableCreate(targetTable);
        break;

      case 'view_create':
        if (mod.viewDefAfter) {
          await this.applyViewHistoryState(targetTable, mod.viewDefAfter, null);
        } else {
          this.logger(
            'warn',
            '[WasmDatabaseEngine] Skipping view undo: definition missing from history entry'
          );
        }
        break;

      case 'view_edit':
        if (mod.viewDefBefore && mod.viewDefAfter) {
          await this.applyViewHistoryState(targetTable, mod.viewDefAfter, mod.viewDefBefore);
        } else {
          this.logger(
            'warn',
            '[WasmDatabaseEngine] Skipping view undo: definition missing from history entry'
          );
        }
        break;

      case 'view_drop':
        if (mod.viewDefBefore) {
          await this.applyViewHistoryState(targetTable, null, mod.viewDefBefore);
        } else {
          this.logger(
            'warn',
            '[WasmDatabaseEngine] Skipping view undo: definition missing from history entry'
          );
        }
        break;
    }
  }

  private async undoCellUpdate(targetTable: string, mod: ModificationEntry): Promise<void> {
    const {
      affectedCells,
      targetRowId,
      newTargetRowId,
      targetColumn,
      priorValue,
      newValue,
      operation
    } = mod;
    if (affectedCells) {
      const updates: CellUpdate[] = await Promise.all(
        affectedCells.map(async (cell) => ({
          rowId: cell.newRowId ?? cell.rowId,
          column: cell.columnName,
          value: await this.computeUndoValue(
            targetTable,
            cell.newRowId ?? cell.rowId,
            cell.columnName,
            cell.priorValue,
            cell.newValue,
            cell.operation
          )
        }))
      );
      await this.updateCellBatch(targetTable, updates);
    } else if (targetRowId !== undefined && targetColumn) {
      await this.updateCell(
        targetTable,
        newTargetRowId ?? targetRowId,
        targetColumn,
        await this.computeUndoValue(
          targetTable,
          newTargetRowId ?? targetRowId,
          targetColumn,
          priorValue,
          newValue,
          operation
        )
      );
    }
  }

  /**
   * Compute the value to write for one undo cell. JSON-patch entries read the
   * current cell and surgically restore touched keys when that can be done
   * exactly; all other cases write the recorded prior value.
   */
  private async computeUndoValue(
    table: string,
    rowId: RecordId,
    column: string,
    priorValue: CellValue | undefined,
    newValue: CellValue | undefined,
    operation: ModificationEntry['operation']
  ): Promise<CellValue> {
    if (operation === 'json_patch') {
      const currentValue = await this.readCellValue(table, rowId, column);
      const plan = computeJsonPatchUndo(currentValue, newValue, priorValue);
      if (plan.kind === 'restore') {
        return plan.value;
      }
    }

    return priorValue ?? null;
  }

  /** Read the current value of one cell through the table's declared identity. */
  private async readCellValue(table: string, rowId: RecordId, column: string): Promise<CellValue> {
    const identity = isPrimaryKeyRecordId(rowId)
      ? await this.resolveTableIdentity(table)
      : { kind: 'rowid' } as const;
    const predicate = buildRecordIdentityPredicate(rowId, identity);
    const result = await this.executeQuery(
      `SELECT ${escapeIdentifier(column)} FROM ${escapeIdentifier(table)} WHERE ${predicate.sql}`,
      predicate.params
    );
    return (result[0]?.rows[0]?.[0] ?? null) as CellValue;
  }

  private async undoRowInsert(targetTable: string, mod: ModificationEntry): Promise<void> {
    const { targetRowId } = mod;
    // Undo insert = delete row
    if (targetRowId !== undefined) {
      await this.deleteRows(targetTable, [targetRowId]);
    }
  }

  private async undoRowDelete(targetTable: string, mod: ModificationEntry): Promise<void> {
    const { deletedRows } = mod;
    // Undo delete = re-insert rows
    if (deletedRows && deletedRows.length > 0) {
      await this.insertRowBatch(targetTable, deletedRows.map(dr => dr.row));
    }
  }

  private async undoColumnAdd(targetTable: string, mod: ModificationEntry): Promise<void> {
    const { targetColumn } = mod;
    // Undo add column = drop column
    if (targetColumn) {
      await this.deleteColumns(targetTable, [targetColumn]);
    }
  }

  private async undoColumnDrop(targetTable: string, mod: ModificationEntry): Promise<void> {
    const { deletedColumns } = mod;
    // Undo drop column = add column + restore values
    if (deletedColumns) {
      await this.executeQuery('BEGIN TRANSACTION');
      try {
        // Optimize column creation by batching all ADD COLUMN statements into a single executeQuery call.
        // This avoids N+1 query transaction overhead for multiple columns.
        const addColumnStatements = deletedColumns.map(col => {
          validateSqlType(col.type);
          return `ALTER TABLE ${escapeIdentifier(targetTable)} ADD COLUMN ${escapeIdentifier(col.name)} ${col.type};`;
        }).join('\n');

        if (addColumnStatements) {
          await this.executeQuery(addColumnStatements);
        }

        // Optimize restoration by grouping rows that have identical column sets
        // This is done effectively by doing one UPDATE per row for all restored columns
        // e.g. UPDATE table SET col1 = ?, col2 = ? WHERE rowid = ?

        // First, transform the data into a row-centric map
        const rowUpdates = new Map<RecordId, Record<string, CellValue | null>>();
        for (const col of deletedColumns) {
          for (const cell of col.data) {
            const rId = validateRowId(cell.rowId);
            let rowObj = rowUpdates.get(rId);
            if (!rowObj) {
              rowObj = {};
              rowUpdates.set(rId, rowObj);
            }
            rowObj[col.name] = cell.value ?? null;
          }
        }

        if (rowUpdates.size > 0) {
          const columnsToSet = deletedColumns.map(c => escapeIdentifier(c.name));
          const setClause = columnsToSet.map(c => `${c} = ?`).join(', ');
          const sql = `UPDATE ${escapeIdentifier(targetTable)} SET ${setClause} WHERE rowid = ?`;
          const stmt = this.instance.prepare(sql);
          try {
            for (const [rId, rowObj] of rowUpdates.entries()) {
              const params: CellValue[] = deletedColumns.map(c => rowObj[c.name] ?? null);
              params.push(rId);
              stmt.run(normalizeWasmBindParams(params));
            }
          } finally {
            stmt.free();
          }
        }

        await this.executeQuery('COMMIT');
      } catch (e) {
        await this.safeRollback('undoColumnDrop');
        throw e;
      }
    }
  }

  private async undoTableCreate(targetTable: string): Promise<void> {
    // Undo create table = drop table
    await this.executeQuery(`DROP TABLE IF EXISTS ${escapeIdentifier(targetTable)}`);
  }

  /**
   * Apply one modification in the forward direction.
   *
   * `strict` is enabled for hot-exit restore so malformed or unsupported
   * entries fail loudly instead of silently dropping recovered edits. Redo uses
   * the historical non-strict behavior so existing undo/redo semantics are not
   * changed for entries that lack enough data to replay.
   *
   * Keep the non-strict redo shape paired with nativeWorker.redoModification so
   * ModificationEntry fields keep one interpretation across web and desktop.
   */
  private async forwardApply(mod: ModificationEntry, strict: boolean): Promise<void> {
    const { modificationType, targetTable, targetRowId, targetColumn, newValue, operation, affectedCells, affectedRowIds, rowData, tableDef, columnDef, deletedColumns, droppedIndexes } = mod;
    if (!targetTable) {
      if (strict) throw new Error(`Cannot apply ${modificationType}: missing target table`);
      return;
    }

    switch (modificationType) {
        case 'cell_update':
            if (affectedCells) {
                // Batch cell updates preserve the original per-cell order and values.
                const updates = affectedCells.map(cell => ({
                    rowId: cell.rowId,
                    column: cell.columnName,
                    value: cell.newValue ?? null,
                    operation: this.normalizeReplayCellOperation(cell.operation, strict, 'cell_update')
                }));
                await this.updateCellBatch(targetTable, updates);
            } else if (targetRowId !== undefined && targetColumn) {
                const replayOperation = this.normalizeReplayCellOperation(operation, strict, 'cell_update');
                if (replayOperation === 'json_patch') {
                    const patch = typeof newValue === 'string' ? newValue : JSON.stringify(newValue ?? null);
                    await this.updateCell(targetTable, targetRowId, targetColumn, null, patch);
                } else {
                    await this.updateCell(targetTable, targetRowId, targetColumn, newValue ?? null);
                }
            } else if (strict) {
                throw new Error('Cannot apply cell_update: missing target cell or affected cells');
            }
            break;

        case 'row_insert':
            if (rowData) {
                // If the history captured a rowid, include it so restored rows
                // keep the same identity they had before shutdown.
                const dataToInsert = targetRowId !== undefined && !isPrimaryKeyRecordId(targetRowId)
                    ? { ...rowData, rowid: targetRowId }
                    : rowData;
                await this.insertRow(targetTable, dataToInsert);
            } else if (strict) {
                throw new Error('Cannot apply row_insert: missing row data');
            }
            break;

        case 'row_delete':
            if (affectedRowIds) {
                await this.deleteRows(targetTable, affectedRowIds);
            } else if (strict) {
                throw new Error('Cannot apply row_delete: missing affected row ids');
            }
            break;

        case 'column_add':
            if (targetColumn && columnDef) {
                await this.addColumn(targetTable, targetColumn, columnDef.type, columnDef.defaultValue);
            } else if (strict) {
                throw new Error('Cannot apply column_add: missing column definition');
            }
            break;

        case 'column_drop':
            if (deletedColumns) {
                const colNames = deletedColumns.map(c => c.name);
                await this.deleteColumns(targetTable, colNames, droppedIndexes ?? undefined);
            } else if (strict) {
                throw new Error('Cannot apply column_drop: missing deleted column data');
            }
            break;

        case 'table_create':
            if (tableDef && tableDef.columns) {
                await this.createTable(targetTable, tableDef.columns);
            } else if (strict) {
                throw new Error('Cannot apply table_create: missing table definition');
            }
            break;

        case 'table_drop':
            if (strict) {
                throw new Error('Cannot apply table_drop: forward replay is not supported');
            }
            break;

        case 'view_create':
            if (mod.viewDefAfter) {
                await this.applyViewHistoryState(targetTable, null, mod.viewDefAfter);
            } else if (strict) {
                throw new Error('Cannot apply view_create: missing view definition');
            } else {
                this.logger(
                  'warn',
                  '[WasmDatabaseEngine] Skipping view redo: definition missing from history entry'
                );
            }
            break;

        case 'view_edit':
            if (mod.viewDefBefore && mod.viewDefAfter) {
                await this.applyViewHistoryState(
                  targetTable,
                  mod.viewDefBefore,
                  mod.viewDefAfter
                );
            } else if (strict) {
                throw new Error('Cannot apply view_edit: missing view definition');
            } else {
                this.logger(
                  'warn',
                  '[WasmDatabaseEngine] Skipping view redo: definition missing from history entry'
                );
            }
            break;

        case 'view_drop':
            if (mod.viewDefBefore) {
                await this.applyViewHistoryState(targetTable, mod.viewDefBefore, null);
            } else if (strict) {
                throw new Error('Cannot apply view_drop: missing view definition');
            } else {
                this.logger(
                  'warn',
                  '[WasmDatabaseEngine] Skipping view redo: definition missing from history entry'
                );
            }
            break;

        default:
            if (strict) {
                throw new Error(`Cannot apply unsupported modification type: ${String(modificationType)}`);
            }
            break;
    }
  }

  /**
   * Redo a modification.
   */
  async redoModification(mod: ModificationEntry): Promise<void> {
    await this.forwardApply(mod, false);
  }

  /**
   * Flush changes to storage.
   * No-op for in-memory database; actual persistence via serializeDatabase.
   */
  async flushChanges(_signal?: AbortSignal): Promise<void> {
    // In-memory database - flush handled by exporting to file
  }

  /**
   * Discard pending modifications.
   * Reverts changes by undoing them in reverse order.
   */
  async discardModifications(
    mods: ModificationEntry[],
    _signal?: AbortSignal
  ): Promise<void> {
    // Apply undos in reverse order (LIFO)
    for (let i = mods.length - 1; i >= 0; i--) {
        await this.undoModification(mods[i]);
    }
  }

  /**
   * Update a single cell value.
   */
  async updateCell(
    table: string,
    rowId: RecordId,
    column: string,
    value: CellValue,
    patch?: string
  ): Promise<RecordId> {
    if (isPrimaryKeyRecordId(rowId)) {
      const identity = await this.resolveTableIdentity(table);
      if (identity.kind !== 'primaryKey') {
        throw new Error(`Primary-key identity cannot target rowid table ${table}`);
      }
      const result = await this.updatePrimaryKeyCellBatch(table, identity, [{
        rowId,
        column,
        value: patch ?? value,
        operation: patch === undefined ? 'set' : 'json_patch'
      }]);
      return result[0]?.newRowId ?? rowId;
    }

    // Validate rowId is a number
    const rowIdNum = validateRowId(rowId);

    let sql: string;
    let params: CellValue[];

    if (patch) {
        const escapedCol = escapeIdentifier(column);
        const escapedTbl = escapeIdentifier(table);

        if (this.hasJsonPatch) {
            // Use SQLite's native json_patch() — single UPDATE, no SELECT round-trip.
            // COALESCE handles NULL columns: json_patch(NULL, x) returns NULL per SQL semantics,
            // but the expected behavior is to treat NULL as empty object (matching JS fallback).
            sql = `UPDATE ${escapedTbl} SET ${escapedCol} = json_patch(COALESCE(${escapedCol}, '{}'), ?) WHERE rowid = ?`;
            params = [typeof patch === 'string' ? patch : JSON.stringify(patch), rowIdNum];
        } else {
            // Fallback: read current value, apply patch in JS, write back
            const currentResult = await this.executeQuery(`SELECT ${escapedCol} FROM ${escapedTbl} WHERE rowid = ?`, [rowIdNum]);
            let currentValue = currentResult[0]?.rows[0]?.[0];

            const currentObj = parseJsonValueForPatching(currentValue, 'updateCell');

            const patchObj = typeof patch === 'string' ? JSON.parse(patch) : patch;
            const newValueObj = applyMergePatch(currentObj, patchObj);
            const newValueStr = JSON.stringify(newValueObj);

            sql = `UPDATE ${escapedTbl} SET ${escapedCol} = ? WHERE rowid = ?`;
            params = [newValueStr, rowIdNum];
        }
    } else {
        sql = `UPDATE ${escapeIdentifier(table)} SET ${escapeIdentifier(column)} = ? WHERE rowid = ?`;
        params = [value, rowIdNum];
    }

    await this.executeQuery(sql, params);
    return rowIdNum;
  }

  /**
   * Insert a new row.
   */
  async insertRow(table: string, data: Record<string, CellValue>): Promise<RecordId | undefined> {
    const identity = await this.resolveTableIdentity(table);
    const columns = Object.keys(data);
    let sql: string;
    let params: CellValue[] = [];

    if (columns.length === 0) {
      sql = `INSERT INTO ${escapeIdentifier(table)} DEFAULT VALUES`;
    } else {
      const colNames = columns.map(escapeIdentifier).join(', ');
      const placeholders = columns.map(() => '?').join(', ');
      params = columns.map(col => data[col]);
      sql = `INSERT INTO ${escapeIdentifier(table)} (${colNames}) VALUES (${placeholders})`;
    }

    if (identity.kind === 'primaryKey') {
      const savepointName = this.createSavepointName('sp_insert_pk_row');
      await this.executeQuery(`SAVEPOINT ${savepointName}`);
      try {
        const returningSql =
          `${sql} RETURNING ${identity.columns.map(column => escapeIdentifier(column.identifier)).join(', ')}`;
        const result = this.queryRaw(returningSql, params);
        if (result.rows.length !== 1) {
          throw new Error(`Insert into ${table} did not return exactly one primary-key identity`);
        }
        const candidateId = encodePrimaryKeyRecordId(identity.columns, result.rows[0]);
        const rowId = this.readPrimaryKeyRecordId(
          table,
          identity,
          buildRecordIdentityPredicate(candidateId, identity)
        );
        await this.executeQuery(`RELEASE ${savepointName}`);
        return rowId;
      } catch (error) {
        await this.safeRollbackSavepoint(savepointName, 'insertPrimaryKeyRow');
        throw error;
      }
    }

    await this.executeQuery(sql, params);

    // Get last insert rowid
    const result = await this.executeQuery('SELECT last_insert_rowid() as id');
    if (result && result.length > 0 && result[0].rows.length > 0) {
      return result[0].rows[0][0] as RecordId;
    }
    return undefined;
  }

  /**
   * Insert multiple rows in a batch within a transaction.
   */
  async insertRowBatch(table: string, rows: Record<string, CellValue>[]): Promise<void> {
    if (rows.length === 0) return;

    await this.executeQuery('BEGIN TRANSACTION');
    try {
      const escapedTable = escapeIdentifier(table);
      const groups = new Map<string, { columns: string[], data: CellValue[][] }>();

      for (const row of rows) {
        const columns = Object.keys(row);
        const key = columns.join('\0');
        if (!groups.has(key)) {
          groups.set(key, { columns, data: [] });
        }
        groups.get(key)!.data.push(columns.map(col => row[col]));
      }

      for (const group of groups.values()) {
        const { columns, data } = group;
        let sql: string;
        if (columns.length === 0) {
          sql = `INSERT INTO ${escapedTable} DEFAULT VALUES`;
          const stmt = this.instance.prepare(sql);
          try {
            for (let i = 0; i < data.length; i++) {
              stmt.run();
            }
          } finally {
            stmt.free();
          }
        } else {
          const colNames = columns.map(escapeIdentifier).join(', ');
          const placeholders = columns.map(() => '?').join(', ');
          sql = `INSERT INTO ${escapedTable} (${colNames}) VALUES (${placeholders})`;
          const stmt = this.instance.prepare(sql);
          try {
            for (const params of data) {
              stmt.run(normalizeWasmBindParams(params));
            }
          } finally {
            stmt.free();
          }
        }
      }

      await this.executeQuery('COMMIT');
    } catch (e) {
      await this.safeRollback('insertRowBatch');
      throw e;
    }
  }

  /**
   * Delete rows by ID.
   */
  async deleteRows(table: string, rowIds: RecordId[]): Promise<DeletedRow[] | void> {
    if (rowIds.length === 0) return [];

    if (rowIds.some(isPrimaryKeyRecordId)) {
      if (!rowIds.every(isPrimaryKeyRecordId)) {
        throw new Error('Cannot mix rowid and primary-key row identities');
      }
      const identity = await this.resolveTableIdentity(table);
      if (identity.kind !== 'primaryKey') {
        throw new Error(`Primary-key identity cannot target rowid table ${table}`);
      }
      const predicate = buildRecordIdentitiesPredicate(rowIds, identity);
      const savepointName = this.createSavepointName('sp_delete_pk_rows');
      await this.executeQuery(`SAVEPOINT ${savepointName}`);
      try {
        const current = this.queryRaw(
          `SELECT * FROM ${escapeIdentifier(table)} WHERE ${predicate.sql}`,
          predicate.params
        );
        const primaryKeyIndices = identity.columns.map(column => {
          const index = current.headers.indexOf(column.identifier);
          if (index < 0) throw new Error(`Primary-key column missing from ${table}: ${column.identifier}`);
          return index;
        });
        const deletedRows = current.rows.map(row => {
          const rowId = encodePrimaryKeyRecordId(
            identity.columns,
            primaryKeyIndices.map(index => row[index])
          );
          const rowData = Object.fromEntries(
            current.headers.map((header, index) => [header, row[index] as CellValue])
          );
          return { rowId, row: rowData };
        });
        if (deletedRows.length !== rowIds.length) {
          throw new Error(`Cannot delete from ${table}: one or more row identities no longer exist`);
        }
        await this.executeQuery(
          `DELETE FROM ${escapeIdentifier(table)} WHERE ${predicate.sql}`,
          predicate.params
        );
        await this.executeQuery(`RELEASE ${savepointName}`);
        return deletedRows;
      } catch (error) {
        await this.safeRollbackSavepoint(savepointName, 'deletePrimaryKeyRows');
        throw error;
      }
    }

    // Validate all row IDs
    const validIds = validateRowIds(rowIds);

    const placeholders = validIds.map(() => '?').join(', ');
    const sql = `DELETE FROM ${escapeIdentifier(table)} WHERE rowid IN (${placeholders})`;
    await this.executeQuery(sql, validIds);
  }

  /**
   * Find indexes that depend on specific columns.
   *
   * @param table - Table name
   * @param columns - Column names to check
   * @returns Array of index names that reference any of the columns
   */
  async findDependentIndexes(table: string, columns: string[]): Promise<string[]> {
    const dependentIndexes: string[] = [];

    // Query sqlite_master for indexes on this table
    const indexQuery = `
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index'
        AND tbl_name = ?
        AND sql IS NOT NULL
    `;
    const indexResult = await this.executeQuery(indexQuery, [table]);

    if (indexResult.length > 0 && indexResult[0].rows) {
      for (const row of indexResult[0].rows) {
        const indexName = row[0] as string;
        const indexSql = row[1] as string;

        // Check if this index references any of the columns
        const referencesColumn = columns.some(col => {
          // Escape regex metacharacters in column name to prevent broken patterns
          // for names like "data[0]", "a+b", "user.name"
          const escaped = col.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // Match column name in index definition (quoted or unquoted)
          const patterns = [
            new RegExp(`[\\(,]\\s*${escaped}\\s*[\\),]`, 'i'),
            new RegExp(`[\\(,]\\s*"${escaped}"\\s*[\\),]`, 'i'),
            new RegExp(`[\\(,]\\s*\\[${escaped}\\]\\s*[\\),]`, 'i'),
            new RegExp(`[\\(,]\\s*\`${escaped}\`\\s*[\\),]`, 'i')
          ];
          return patterns.some(p => p.test(indexSql));
        });

        if (referencesColumn) {
          dependentIndexes.push(indexName);
        }
      }
    }

    return dependentIndexes;
  }

  /**
   * Delete columns by name.
   *
   * If dropDependentIndexes is provided, those indexes will be dropped first.
   * Otherwise, deletion may fail if indexes reference the columns.
   *
   * @param table - Table name
   * @param columns - Column names to delete
   * @param dropDependentIndexes - Optional list of indexes to drop first
   */
  async deleteColumns(table: string, columns: string[], dropDependentIndexes?: string[]): Promise<void> {
    if (columns.length === 0) return;

    const escapedTable = escapeIdentifier(table);

    // Use a SAVEPOINT so column drops remain atomic on their own and can also
    // participate in the outer hot-exit restore transaction.
    const savepointName = this.createSavepointName('sp_delete_columns');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      // Drop specified dependent indexes first inside the transaction
      if (dropDependentIndexes && dropDependentIndexes.length > 0) {
        const dropIndexStatements = dropDependentIndexes
          .map((indexName) => `DROP INDEX IF EXISTS ${escapeIdentifier(indexName)};`)
          .join('\n');
        await this.executeQuery(dropIndexStatements);
      }

      const dropColumnStatements = columns
        .map((col) => `ALTER TABLE ${escapedTable} DROP COLUMN ${escapeIdentifier(col)};`)
        .join('\n');
      await this.executeQuery(dropColumnStatements);
      await this.executeQuery(`RELEASE ${savepointName}`);
    } catch (e) {
      await this.safeRollbackSavepoint(savepointName, 'deleteColumns');
      throw e;
    }
  }

  /**
   * Helper to resolve wildcard columns to explicit column names when using global filter.
   */
  private async resolveQueryColumns(table: string, columns: string[] | undefined, globalFilter: string | undefined): Promise<string[] | undefined> {
    if (globalFilter && (!columns || (columns.length === 1 && columns[0] === '*'))) {
      const tableInfo = await this.getTableInfo(table);
      return tableInfo.map(c => c.identifier);
    }
    return columns;
  }

  /** Discover table identity while allowing callers that also read views. */
  private async findTableIdentity(table: string): Promise<TableIdentity | undefined> {
    const metadata = await this.executeQuery(
      `SELECT "type", "wr" FROM pragma_table_list ` +
      `WHERE "schema" = 'main' AND "name" = ? LIMIT 1`,
      [table]
    );
    if ((metadata[0]?.rows.length ?? 0) === 0) return undefined;
    const kind = classifyTableIdentity(metadata[0].rows[0][0], metadata[0].rows[0][1]);
    if (!kind) return undefined;
    if (kind === 'rowid') return { kind: 'rowid' };

    const columns = primaryKeyColumnsFromTableInfo(await this.getTableInfo(table));
    if (columns.length === 0) {
      throw new Error(`WITHOUT ROWID table ${table} has no declared primary key`);
    }
    return { kind: 'primaryKey', columns };
  }

  /** Resolve the declared identity without trusting a client-supplied PK token. */
  private async resolveTableIdentity(table: string): Promise<TableIdentity> {
    const identity = await this.findTableIdentity(table);
    if (!identity) throw new Error(`Table not found: ${table}`);
    return identity;
  }

  /** Read rows with sql.js BigInt transport retained for identity/history. */
  private queryRaw(sql: string, params: readonly CellValue[] = []): {
    headers: string[];
    rows: Array<Array<CellValue | bigint>>;
  } {
    const statement = this.instance.prepare(sql, normalizeWasmBindParams(params));
    try {
      const headers = statement.getColumnNames();
      const rows: Array<Array<CellValue | bigint>> = [];
      while (statement.step()) {
        const row = statement.get(null, { useBigInt: true });
        if (row) rows.push(row);
      }
      return { headers, rows };
    } finally {
      statement.free();
    }
  }

  private readPrimaryKeyRecordId(
    table: string,
    identity: Extract<TableIdentity, { kind: 'primaryKey' }>,
    predicate: { sql: string; params: CellValue[] }
  ): RecordId {
    const result = this.queryRaw(
      `SELECT ${identity.columns.map(column => escapeIdentifier(column.identifier)).join(', ')} ` +
      `FROM ${escapeIdentifier(table)} WHERE ${predicate.sql} LIMIT 2`,
      predicate.params
    );
    if (result.rows.length !== 1) {
      throw new Error(
        result.rows.length === 0
          ? `Updated row in ${table} no longer exists`
          : `Primary-key identity for ${table} matched more than one row`
      );
    }
    return encodePrimaryKeyRecordId(identity.columns, result.rows[0]);
  }

  private applyJsonPatchValue(currentValue: CellValue, patch: CellValue): string {
    const currentObject = parseJsonValueForPatching(currentValue, 'updateCellBatch');
    const patchObject = typeof patch === 'string' ? JSON.parse(patch) : patch;
    return JSON.stringify(applyMergePatch(currentObject, patchObject));
  }

  /** PK batches update each row once so changing any key member cannot stale later writes. */
  private async updatePrimaryKeyCellBatch(
    table: string,
    identity: Extract<TableIdentity, { kind: 'primaryKey' }>,
    updates: CellUpdate[]
  ): Promise<CellUpdateResult[]> {
    const savepointName = this.createSavepointName('sp_update_pk_batch');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      const updatesByRow = new Map<RecordId, CellUpdate[]>();
      for (const update of updates) {
        const rowUpdates = updatesByRow.get(update.rowId) ?? [];
        rowUpdates.push(update);
        updatesByRow.set(update.rowId, rowUpdates);
      }

      const results: CellUpdateResult[] = [];
      for (const [rowId, rowUpdates] of updatesByRow) {
        const oldPredicate = buildRecordIdentityPredicate(rowId, identity);
        const columns = [...new Set(rowUpdates.map(update => update.column))];
        if (columns.length !== rowUpdates.length) {
          throw new Error(`Batch update for ${table} contains the same column more than once`);
        }
        const current = this.queryRaw(
          `SELECT ${columns.map(escapeIdentifier).join(', ')} ` +
          `FROM ${escapeIdentifier(table)} WHERE ${oldPredicate.sql} LIMIT 2`,
          oldPredicate.params
        );
        if (current.rows.length !== 1) {
          throw new Error(`Cannot update ${table}: row identity no longer exists`);
        }

        const preparedUpdates = rowUpdates.map((update, index) => {
          const priorValue = current.rows[0][index] as CellValue;
          const prepared = prepareCellUpdateForStorage(
            update.value,
            priorValue,
            update.operation ?? 'set'
          );
          const storedValue = prepared.operation === 'json_patch'
            ? this.applyJsonPatchValue(priorValue, prepared.value)
            : prepared.value;
          return { update, priorValue, prepared, storedValue };
        });

        const setClause = preparedUpdates.map(({ update }) => (
          `${escapeIdentifier(update.column)} = ?`
        )).join(', ');
        await this.executeQuery(
          `UPDATE ${escapeIdentifier(table)} SET ${setClause} WHERE ${oldPredicate.sql}`,
          [
            ...preparedUpdates.map(update => update.storedValue),
            ...oldPredicate.params
          ]
        );

        const candidateValues = [...oldPredicate.primaryKey!.values];
        for (const preparedUpdate of preparedUpdates) {
          const keyIndex = identity.columns.findIndex(
            keyColumn => keyColumn.identifier === preparedUpdate.update.column
          );
          if (keyIndex >= 0) candidateValues[keyIndex] = preparedUpdate.storedValue;
        }
        const candidateId = encodePrimaryKeyRecordId(identity.columns, candidateValues);
        const newRowId = this.readPrimaryKeyRecordId(
          table,
          identity,
          buildRecordIdentityPredicate(candidateId, identity)
        );
        for (const preparedUpdate of preparedUpdates) {
          results.push({
            rowId,
            newRowId,
            columnName: preparedUpdate.update.column,
            priorValue: preparedUpdate.priorValue,
            newValue: preparedUpdate.prepared.value,
            operation: preparedUpdate.prepared.operation
          });
        }
      }

      await this.executeQuery(`RELEASE ${savepointName}`);
      return results;
    } catch (error) {
      await this.safeRollbackSavepoint(savepointName, 'updatePrimaryKeyCellBatch');
      throw error;
    }
  }

  /**
   * Create a new table.
   */
  async createTable(table: string, columns: ColumnDefinition[]): Promise<void> {
    if (columns.length === 0) throw new Error('At least one column is required');

    const colDefs = columns.map(col => {
      if (typeof col === 'string') {
         throw new Error('Legacy string column definitions not supported for security');
      }
      // Validate SQL type to prevent injection via malicious type definitions
      validateSqlType(col.type);
      let def = `${escapeIdentifier(col.name)} ${col.type}`;
      if (col.primaryKey) def += ' PRIMARY KEY';
      if (col.notNull && !col.primaryKey) def += ' NOT NULL';
      return def;
    });

    const sql = `CREATE TABLE ${escapeIdentifier(table)} (${colDefs.join(', ')})`;
    await this.executeQuery(sql);
  }

  /** Read a view and every INSTEAD OF trigger SQLite associates with it. */
  private async findViewDefinition(
    view: string,
    allowUnparsed: boolean
  ): Promise<ViewDefinition | null> {
    const viewResult = await this.executeQuery(
      "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = ?",
      [view]
    );
    const createSql = viewResult[0]?.rows[0]?.[0];
    if (typeof createSql !== 'string') {
      return null;
    }

    const triggerRows: CellValue[][][] = [];
    for (const source of VIEW_TRIGGER_SCHEMA_QUERIES) {
      const result = await this.executeQuery(source.sql, source.params(view));
      triggerRows.push(result[0]?.rows ?? []);
    }
    const { triggers, ambiguousTemporaryTriggerNames } = mapViewTriggerRows(
      view,
      triggerRows
    );

    let selectSql: string;
    let columnListSql: string | undefined;
    try {
      selectSql = extractViewSelectSql(createSql);
      columnListSql = extractViewColumnListSql(createSql);
    } catch (err) {
      if (!allowUnparsed) throw err;
      // Dropping depends only on the schema object name. Preserve opaque raw SQL
      // for history and let SQLite remain authoritative if it is replayed.
      selectSql = '';
    }
    return {
      identifier: view,
      sql: createSql,
      selectSql,
      columnListSql,
      triggers,
      ...(ambiguousTemporaryTriggerNames.length > 0
        ? { ambiguousTemporaryTriggerNames }
        : {})
    };
  }

  private async readViewDefinition(view: string, allowUnparsed: boolean): Promise<ViewDefinition> {
    const definition = await this.findViewDefinition(view, allowUnparsed);
    if (!definition) throw new Error(`View not found: ${view}`);
    return definition;
  }

  async getViewDefinition(view: string): Promise<ViewDefinition> {
    return this.readViewDefinition(view, false);
  }

  /** Resolve the installed view state once so validate and preview enforce identical intent rules. */
  private async resolveExistingViewForIntent(
    view: string,
    intent: ViewDefinitionIntent
  ): Promise<ExistingViewForIntent> {
    const result = await this.executeQuery(
      "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = ?",
      [view]
    );
    const row = result[0]?.rows[0];
    assertViewDefinitionIntent(view, row !== undefined, intent);
    const storedSql = row?.[0];
    return {
      storedSql,
      columnListSql: typeof storedSql === 'string'
        ? extractViewColumnListSql(storedSql)
        : undefined
    };
  }

  async validateViewDefinition(
    view: string,
    selectSql: string,
    intent: ViewDefinitionIntent = 'edit'
  ): Promise<void> {
    if (this.readOnlyMode) {
      throw new Error('View validation is unavailable because the database is read-only');
    }
    const body = normalizeViewSelectSql(selectSql);
    const { storedSql: existingSql, columnListSql } =
      await this.resolveExistingViewForIntent(view, intent);
    const savepointName = this.createSavepointName('sp_validate_view');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      if (typeof existingSql === 'string') {
        this.runSingleStatement(`DROP VIEW ${escapeMainViewIdentifier(view)}`);
      }
      this.runSingleStatement(buildCreateViewSql(view, body, columnListSql));
      this.compileSingleStatement(`EXPLAIN SELECT * FROM ${escapeMainViewIdentifier(view)}`);
      // Successful validation is deliberately non-mutating.
      await this.executeQuery(`ROLLBACK TO ${savepointName}`);
      await this.executeQuery(`RELEASE ${savepointName}`);
    } catch (err) {
      await this.safeRollbackSavepoint(savepointName, 'validateViewDefinition');
      throw err;
    }
  }

  async previewViewDefinition(
    view: string,
    selectSql: string,
    limit: number = 50,
    intent: ViewDefinitionIntent = 'edit'
  ): Promise<QueryResultSet> {
    const body = normalizeViewSelectSql(selectSql);
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 50));
    const { storedSql: existingSql, columnListSql } =
      await this.resolveExistingViewForIntent(view, intent);

    if (this.readOnlyMode) {
      // Read-only documents cannot run disposable schema DDL. A target-named
      // CTE still shadows ordinary unqualified references to the installed
      // view and preserves explicit output names; writable previews below use
      // the exact CREATE VIEW context and also catch schema-qualified cycles.
      const previewSource = escapeIdentifier(view);
      if (columnListSql) {
        return this.executeSingleQuery(
          `WITH ${previewSource} ${columnListSql} AS (${body}\n) ` +
          `SELECT * FROM ${previewSource} LIMIT ${boundedLimit}`
        );
      }
      return this.executeSingleQuery(
        `WITH ${previewSource} AS (${body}\n) ` +
        `SELECT * FROM ${previewSource} LIMIT ${boundedLimit}`
      );
    }

    const savepointName = this.createSavepointName('sp_preview_view');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      if (typeof existingSql === 'string') {
        this.runSingleStatement(`DROP VIEW ${escapeMainViewIdentifier(view)}`);
      }
      this.runSingleStatement(buildCreateViewSql(view, body, columnListSql));
      this.compileSingleStatement(`EXPLAIN SELECT * FROM ${escapeMainViewIdentifier(view)}`);
      const result = this.executeSingleQuery(
        `SELECT * FROM ${escapeMainViewIdentifier(view)} LIMIT ${boundedLimit}`
      );
      await this.executeQuery(`ROLLBACK TO ${savepointName}`);
      await this.executeQuery(`RELEASE ${savepointName}`);
      return result;
    } catch (err) {
      await this.safeRollbackSavepoint(savepointName, 'previewViewDefinition');
      throw err;
    }
  }

  async createView(view: string, selectSql: string): Promise<ViewDefinition> {
    this.assertWritableMutation('View creation');
    const body = normalizeViewSelectSql(selectSql);
    this.compileViewSelect(body);
    const savepointName = this.createSavepointName('sp_create_view');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      this.runSingleStatement(buildCreateViewSql(view, body));
      this.compileSingleStatement(`EXPLAIN SELECT * FROM ${escapeMainViewIdentifier(view)}`);
      const definition = await this.getViewDefinition(view);
      await this.executeQuery(`RELEASE ${savepointName}`);
      return definition;
    } catch (err) {
      await this.safeRollbackSavepoint(savepointName, 'createView');
      throw err;
    }
  }

  async editView(
    view: string,
    selectSql: string,
    preserveTriggers: boolean = true,
    expectedSql?: string,
    expectedTriggers?: readonly ViewTriggerDefinition[]
  ): Promise<ViewEditResult> {
    this.assertWritableMutation('View editing');
    const body = normalizeViewSelectSql(selectSql);
    this.compileViewSelect(body);
    const savepointName = this.createSavepointName('sp_edit_view');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      // Read and compare after opening the savepoint. That read transaction
      // prevents a stale editor snapshot from being silently overwritten even
      // when another connection races between the UI check and this mutation.
      const before = await this.getViewDefinition(view);
      assertViewTriggerSnapshotIsMutationSafe(before);
      assertViewDefinitionSnapshotCurrent(
        expectedSql,
        before.sql,
        expectedTriggers,
        before.triggers
      );
      this.runSingleStatement(`DROP VIEW ${escapeMainViewIdentifier(view)}`);
      this.runSingleStatement(buildCreateViewSql(view, body, before.columnListSql, before.columns));
      this.compileSingleStatement(`EXPLAIN SELECT * FROM ${escapeMainViewIdentifier(view)}`);
      if (preserveTriggers) {
        const columnResult = await this.executeQuery(
          `PRAGMA main.table_info(${escapeIdentifier(view)})`
        );
        const columns = (columnResult[0]?.rows ?? []).map(row => {
          if (typeof row[1] !== 'string') {
            throw new Error(`SQLite returned invalid column metadata for view ${view}`);
          }
          return row[1];
        });
        assertViewTriggersCompatibleWithColumns(before.triggers, columns);
        for (const trigger of before.triggers) {
          this.runSingleStatement(buildCreateViewTriggerSql(trigger));
        }
      }
      const after = await this.getViewDefinition(view);
      await this.executeQuery(`RELEASE ${savepointName}`);
      return { before, after };
    } catch (err) {
      await this.safeRollbackSavepoint(savepointName, 'editView');
      throw err;
    }
  }

  async dropView(
    view: string,
    expectedSql?: string,
    expectedTriggers?: readonly ViewTriggerDefinition[]
  ): Promise<ViewDefinition> {
    this.assertWritableMutation('View deletion');
    const savepointName = this.createSavepointName('sp_drop_view');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      const before = await this.readViewDefinition(view, true);
      assertViewTriggerSnapshotIsMutationSafe(before);
      assertViewDefinitionSnapshotCurrent(
        expectedSql,
        before.sql,
        expectedTriggers,
        before.triggers
      );
      this.runSingleStatement(`DROP VIEW ${escapeMainViewIdentifier(view)}`);
      await this.executeQuery(`RELEASE ${savepointName}`);
      return before;
    } catch (err) {
      await this.safeRollbackSavepoint(savepointName, 'dropView');
      throw err;
    }
  }

  private assertWritableMutation(operation: string): void {
    if (this.readOnlyMode) {
      throw new Error(`${operation} is unavailable because the database is read-only`);
    }
  }

  /** Atomically apply one tracked view-state transition for undo, redo, or hot exit. */
  private async applyViewHistoryState(
    view: string,
    expectedCurrent: ViewDefinition | null,
    replacement: ViewDefinition | null
  ): Promise<void> {
    const savepointName = this.createSavepointName('sp_restore_view');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      const current = await this.findViewDefinition(view, true);
      if (current) assertViewTriggerSnapshotIsMutationSafe(current);
      assertViewDefinitionStateCurrent(expectedCurrent, current);
      if (current) {
        this.runSingleStatement(`DROP VIEW ${escapeMainViewIdentifier(view)}`);
      }
      if (replacement) {
        this.runSingleStatement(replacement.sql);
        this.compileSingleStatement(
          `EXPLAIN SELECT * FROM ${escapeMainViewIdentifier(replacement.identifier)}`
        );
        for (const trigger of replacement.triggers) {
          this.runSingleStatement(buildCreateViewTriggerSql(trigger));
        }
      }
      await this.executeQuery(`RELEASE ${savepointName}`);
    } catch (err) {
      await this.safeRollbackSavepoint(savepointName, 'restoreViewDefinition');
      throw err;
    }
  }

  /**
   * Update multiple cells in a batch.
   */
  async updateCellBatch(table: string, updates: CellUpdate[]): Promise<CellUpdateResult[]> {
    if (updates.length === 0) return [];

    if (updates.some(update => isPrimaryKeyRecordId(update.rowId))) {
      if (!updates.every(update => isPrimaryKeyRecordId(update.rowId))) {
        throw new Error('Cannot mix rowid and primary-key row identities');
      }
      const identity = await this.resolveTableIdentity(table);
      if (identity.kind !== 'primaryKey') {
        throw new Error(`Primary-key identity cannot target rowid table ${table}`);
      }
      return this.updatePrimaryKeyCellBatch(table, identity, updates);
    }

    // Use SAVEPOINT instead of BEGIN TRANSACTION so this method can be called
    // safely from within an outer transaction (e.g., undoColumnDrop).
    // escapeIdentifier wraps in double quotes defensively — the generated name
    // is already [a-zA-Z0-9_] safe, but quoting prevents issues if the pattern changes.
    const savepointName = this.createSavepointName('sp_update_batch');
    await this.executeQuery(`SAVEPOINT ${savepointName}`);
    try {
      const escapedTable = escapeIdentifier(table);
      const rowIds = [...new Set(updates.map(update => validateRowId(update.rowId)))];
      const columns = [...new Set(updates.map(update => update.column))];
      const placeholders = rowIds.map(() => '?').join(', ');
      const current = await this.executeQuery(
        `SELECT CAST(rowid AS TEXT), ${columns.map(escapeIdentifier).join(', ')} ` +
        `FROM ${escapedTable} WHERE rowid IN (${placeholders})`,
        rowIds
      );
      const currentValues = new Map<string, Map<string, CellValue>>();
      for (const row of current[0]?.rows ?? []) {
        const values = new Map<string, CellValue>();
        columns.forEach((column, index) => values.set(column, row[index + 1]));
        currentValues.set(String(validateRowId(row[0] as RecordId)), values);
      }
      const results: CellUpdateResult[] = [];
      const processedUpdates = updates.map(update => {
        const rowId = validateRowId(update.rowId);
        const row = currentValues.get(String(rowId));
        if (!row) {
          throw new Error(`Cannot update ${table}.${update.column}: row ${update.rowId} no longer exists`);
        }
        const priorValue = row.get(update.column);
        const prepared = prepareCellUpdateForStorage(
          update.value,
          priorValue,
          update.operation ?? 'set'
        );
        results.push({
          rowId,
          columnName: update.column,
          priorValue,
          newValue: prepared.value,
          operation: prepared.operation
        });
        return { ...update, rowId, value: prepared.value, operation: prepared.operation };
      });
      // Group updates by column and operation type
      // Prepare statements one by one avoids full re-parse

      // Prepare per column.
      // Group by column.

      const updatesByColumn = new Map<string, CellUpdate[]>();
      for (const update of processedUpdates) {
          const key = `${update.column}|${update.operation || 'set'}`;
          if (!updatesByColumn.has(key)) {
              updatesByColumn.set(key, []);
          }
          updatesByColumn.get(key)!.push(update);
      }

      for (const [key, columnUpdates] of updatesByColumn.entries()) {
          const [column, op] = key.split('|');
          const escapedColumn = escapeIdentifier(column);

          // For json_patch operations, choose between native SQLite json_patch()
          // and JS fallback depending on runtime availability
          const useNativePatch = op === 'json_patch' && this.hasJsonPatch;

          // COALESCE handles NULL columns: json_patch(NULL, x) returns NULL per SQL semantics,
          // but the expected behavior is to treat NULL as empty object (matching JS fallback).
          const sql = useNativePatch
            ? `UPDATE ${escapedTable} SET ${escapedColumn} = json_patch(COALESCE(${escapedColumn}, '{}'), ?) WHERE rowid = ?`
            : `UPDATE ${escapedTable} SET ${escapedColumn} = ? WHERE rowid = ?`;

          const stmt = this.instance.prepare(sql);

          // Only need SELECT for JS fallback path
          let selectStmt: WasmPreparedStatement | null = null;

          try {
              if (op === 'json_patch' && !this.hasJsonPatch) {
                 selectStmt = this.instance.prepare(`SELECT ${escapedColumn} FROM ${escapedTable} WHERE rowid = ?`);
              }

              // Cache parsed patch objects to optimize JS fallback for batch updates
              const parsedPatchCache = new Map<string, unknown>();

              for (const update of columnUpdates) {
                  const rowIdNum = validateRowId(update.rowId);

                  if (useNativePatch) {
                     // Native json_patch(): single UPDATE, no SELECT needed
                     const patchStr = typeof update.value === 'string'
                       ? update.value
                       : JSON.stringify(update.value);
                     stmt.run(normalizeWasmBindParams([patchStr, rowIdNum]));

                  } else if (op === 'json_patch') {
                     // JS fallback: read current value, apply patch, write back
                     let currentValue = null;
                     if (selectStmt) {
                        const row = selectStmt.get([rowIdNum]);
                        if (row && row.length > 0) {
                            currentValue = row[0];
                        }
                        selectStmt.reset();
                     }

                     const currentObj = parseJsonValueForPatching(currentValue, 'updateCells');

                     let patchObj;
                     if (typeof update.value === 'string') {
                         if (parsedPatchCache.has(update.value)) {
                             patchObj = parsedPatchCache.get(update.value);
                         } else {
                             patchObj = JSON.parse(update.value);
                             parsedPatchCache.set(update.value, patchObj);
                         }
                     } else {
                         patchObj = update.value;
                     }

                     const newValueObj = applyMergePatch(currentObj, patchObj);
                     const newValueStr = JSON.stringify(newValueObj);

                     stmt.run(normalizeWasmBindParams([newValueStr, rowIdNum]));
                  } else {
                      // Standard update
                      stmt.run(normalizeWasmBindParams([update.value, rowIdNum]));
                  }
              }
          } finally {
              stmt.free();
              if (selectStmt) selectStmt.free();
          }
      }

      await this.executeQuery(`RELEASE ${savepointName}`);
      return results;
    } catch (err) {
      await this.safeRollbackSavepoint(savepointName, 'updateCellBatch');
      throw err;
    }
  }

  /**
   * Add a new column to a table.
   */
  async addColumn(table: string, column: string, type: string, defaultValue?: string): Promise<void> {
    // Validate SQL type to prevent injection via malicious type definitions
    validateSqlType(type);
    let sql = `ALTER TABLE ${escapeIdentifier(table)} ADD COLUMN ${escapeIdentifier(column)} ${type}`;

    if (defaultValue !== undefined && defaultValue !== null && defaultValue !== '') {
      // SQL safe default value handling with strict validation
      if (defaultValue.toLowerCase() === 'null') {
        sql += ' DEFAULT NULL';
      } else if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(defaultValue)) {
        // Strict numeric pattern: optional sign, digits with optional decimal, optional exponent
        // This prevents hex (0x), special values, and other edge cases
        sql += ` DEFAULT ${defaultValue}`;
      } else {
        sql += ` DEFAULT '${defaultValue.replace(/'/g, "''")}'`;
      }
    }

    await this.executeQuery(sql);
  }

  /**
   * Fetch table data using options.
   *
   * NOTE: This method intentionally bypasses the query timeout mechanism.
   * Unlike raw executeQuery(), fetchTableData() always includes pagination
   * (LIMIT/OFFSET) which naturally bounds the result size and execution time.
   * The query builder enforces these limits, making timeout unnecessary here.
   */
  async fetchTableData(table: string, options: TableQueryOptions): Promise<QueryResultSet> {
    const queryOptions = { ...options };
    queryOptions.columns = await this.resolveQueryColumns(table, queryOptions.columns, queryOptions.globalFilter);

    let primaryKeyContext: {
      identity: Extract<TableIdentity, { kind: 'primaryKey' }>;
      visibleColumns: string[];
    } | undefined;
    if (queryOptions.columns?.[0]?.toLowerCase() === 'rowid') {
      const identity = await this.findTableIdentity(table);
      if (identity?.kind === 'primaryKey') {
        const visibleColumns = queryOptions.columns.slice(1);
        const hiddenPrimaryKeyColumns = identity.columns
          .map(column => column.identifier)
          .filter(column => !visibleColumns.includes(column));
        queryOptions.columns = [...visibleColumns, ...hiddenPrimaryKeyColumns];
        primaryKeyContext = { identity, visibleColumns };
        if (queryOptions.orderBy?.toLowerCase() === 'rowid') {
          queryOptions.orderBy = undefined;
          queryOptions.orderByColumns = identity.columns.map(column => column.identifier);
        }
      }
    }

    const { sql, params } = buildSelectQuery(table, queryOptions);

    // Use prepare/step/get to avoid overhead of exec() which builds intermediate objects
    // and to allow for potentially better memory management in the future
    let headerStmt: WasmPreparedStatement | null = null;
    let stmt: WasmPreparedStatement | null = null;
    try {
        const bindParams = normalizeWasmBindParams(params);
        headerStmt = this.instance.prepare(sql, bindParams);
        const headers = headerStmt.getColumnNames();
        headerStmt.free();
        headerStmt = null;

        const transportQuery = buildExactNumericTextQuery(sql, headers.length);
        stmt = this.instance.prepare(transportQuery.sql, bindParams);
        const sourceRows: Array<Array<CellValue | bigint>> = [];

        while (stmt.step()) {
            // We know a row exists because step() returned true
            const row = stmt.get(null, { useBigInt: true });
            if (row) {
                sourceRows.push(row);
            }
        }

        const companionResults = [];
        let isRowIdTable = false;
        const hasRowIdShape = headers[0]?.toLowerCase() === 'rowid';
        const needsExactRowIdIdentity = hasRowIdShape
          && hasUnsafeBigIntAtColumn(sourceRows, 0);
        const needsRowIdCompanions = transportQuery.valueColumnCount === undefined
          && hasRowIdShape;
        // This engine owns a private in-memory copy, so no external process can
        // commit between the source read and this authority/companion work.
        if (
          (needsRowIdCompanions || needsExactRowIdIdentity)
          && sourceRows.length > 0
        ) {
          const authority = await this.executeQuery(ROWID_TABLE_AUTHORITY_SQL, [table]);
          isRowIdTable = (authority[0]?.rows.length ?? 0) > 0;
        }
        if (isRowIdTable && needsRowIdCompanions) {
          for (const query of buildRowIdExactRealTextQueries(
            table,
            headers,
            sourceRows.map(row => row[0])
          )) {
            let companionStmt: WasmPreparedStatement | null = null;
            try {
              companionStmt = this.instance.prepare(
                query.sql,
                normalizeWasmBindParams(query.params)
              );
              const companionRows: Array<Array<CellValue | bigint>> = [];
              while (companionStmt.step()) {
                const row = companionStmt.get(null, { useBigInt: true });
                if (row) companionRows.push(row);
              }
              companionResults.push({ query, rows: companionRows });
            } finally {
              if (companionStmt) companionStmt.free();
            }
          }
        }
        const companionExactTexts = collectRowIdExactRealTexts(
          sourceRows,
          companionResults
        );

        const { rows, exactIntegerTexts } = normalizeIntegerRowsForTransport(
          sourceRows,
          transportQuery.valueColumnCount,
          companionExactTexts,
          isRowIdTable && needsExactRowIdIdentity ? 0 : undefined
        );
        if (primaryKeyContext) {
          const primaryKeyIndices = primaryKeyContext.identity.columns.map(column => {
            const index = headers.indexOf(column.identifier);
            if (index < 0) {
              throw new Error(`Primary-key column missing from table fetch: ${column.identifier}`);
            }
            return index;
          });
          const visibleColumnCount = primaryKeyContext.visibleColumns.length;
          const identities = sourceRows.map(row => encodePrimaryKeyRecordId(
            primaryKeyContext!.identity.columns,
            primaryKeyIndices.map(index => row[index])
          ));
          let shiftedExactIntegerTexts: QueryResultSet['exactIntegerTexts'];
          if (exactIntegerTexts) {
            for (const [rowIndexText, exactRow] of Object.entries(exactIntegerTexts)) {
              for (const [columnIndexText, exactText] of Object.entries(exactRow)) {
                const columnIndex = Number(columnIndexText);
                if (columnIndex >= visibleColumnCount) continue;
                shiftedExactIntegerTexts ??= {};
                shiftedExactIntegerTexts[Number(rowIndexText)] ??= {};
                shiftedExactIntegerTexts[Number(rowIndexText)][columnIndex + 1] = exactText;
              }
            }
          }
          const resultRows = rows.map((row, index) => [
            identities[index],
            ...row.slice(0, visibleColumnCount)
          ]);
          const resultHeaders = ['rowid', ...primaryKeyContext.visibleColumns];
          return {
            headers: resultHeaders,
            rows: resultRows,
            columns: resultHeaders,
            values: resultRows,
            exactIntegerTexts: shiftedExactIntegerTexts
          };
        }
        return {
            headers,
            rows,
            columns: headers,
            values: rows,
            exactIntegerTexts
        };
    } catch (err) {
        const errorDetail = err instanceof Error ? err.message : String(err);
        throw new Error(`Fetch failed: ${errorDetail}`);
    } finally {
        if (headerStmt) headerStmt.free();
        if (stmt) stmt.free();
    }
  }

  /**
   * Fetch table row count using options.
   */
  async fetchTableCount(table: string, options: TableCountOptions): Promise<number> {
    const queryOptions = { ...options };
    queryOptions.columns = await this.resolveQueryColumns(table, queryOptions.columns, queryOptions.globalFilter);

    const { sql, params } = buildCountQuery(table, queryOptions);
    const result = await this.executeQuery(sql, params);
    if (result && result.length > 0 && result[0].rows.length > 0) {
      const count = result[0].rows[0][0];
      return typeof count === 'number' ? count : 0;
    }
    return 0;
  }

  /**
   * Fetch database schema.
   */
  async fetchSchema(): Promise<SchemaSnapshot> {
    const [schemaResult, identityResult] = await Promise.all([
      this.executeQuery(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name"
      ),
      this.executeQuery(TABLE_IDENTITY_METADATA_SQL)
    ]);

    const rows = schemaResult[0]?.rows || [];
    const identities = buildTableIdentityMap(identityResult[0]?.rows || []);

    const tables = rows
        .filter(r => r[0] === 'table')
        .map(r => {
          const identifier = r[1] as string;
          const identity = identities.get(identifier);
          if (!identity) throw new Error(`Table not found: ${identifier}`);
          return { identifier, identity };
        });

    const views = rows
        .filter(r => r[0] === 'view')
        .map(r => ({ identifier: r[1] as string }));

    const indexes = rows
        .filter(r => r[0] === 'index')
        .map(r => ({ identifier: r[1] as string, parentTable: r[2] as string }));

    return { tables, views, indexes };
  }

  /**
   * Get table metadata.
   */
  async getTableInfo(table: string): Promise<ColumnMetadata[]> {
    const result = await this.executeQuery(`PRAGMA table_info(${escapeIdentifier(table)})`);
    return (result[0]?.rows || []).map(row => ({
      ordinal: row[0] as number,
      identifier: row[1] as string,
      declaredType: row[2] as string,
      isRequired: row[3] as number,
      defaultExpression: row[4],
      primaryKeyPosition: row[5] as number
    }));
  }

  /**
   * Get PRAGMA settings.
   */
  async getPragmas(): Promise<Record<string, CellValue>> {
    const pragmasToFetch = [
      'foreign_keys',
      'journal_mode',
      'synchronous',
      'cache_size',
      'locking_mode',
      'temp_store',
      'encoding',
      'auto_vacuum'
    ];

    const result: Record<string, CellValue> = {};
    const query = pragmasToFetch.map(pragma => `PRAGMA ${pragma};`).join('\n');
    const res = await this.executeQuery(query);

    for (let i = 0; i < pragmasToFetch.length; i++) {
      if (res[i]?.rows?.[0]) {
        result[pragmasToFetch[i]] = res[i].rows[0][0];
      }
    }

    return result;
  }

  /**
   * Set PRAGMA value.
   */
  async setPragma(pragma: string, value: CellValue): Promise<void> {
    // Validate pragma name to prevent SQL injection
    const allowedPragmas = [
      'foreign_keys',
      'journal_mode',
      'synchronous',
      'cache_size',
      'locking_mode',
      'temp_store',
      'auto_vacuum'
    ];

    if (!allowedPragmas.includes(pragma)) {
      throw new Error(`Invalid or disallowed PRAGMA: ${pragma}`);
    }

    // Value sanitization depends on type.
    // String values use a strict whitelist to prevent injection — only
    // alphanumeric, underscores, and hyphens are allowed (covers all
    // valid PRAGMA string values like 'wal', 'delete', 'normal', etc.)
    let sql: string;
    if (typeof value === 'string') {
        if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
          throw new Error('Invalid PRAGMA string value: contains disallowed characters');
        }
        sql = `PRAGMA ${pragma} = '${value}'`;
    } else if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
          throw new Error('Invalid PRAGMA numeric value: must be finite');
        }
        sql = `PRAGMA ${pragma} = ${value}`;
    } else if (typeof value === 'boolean') {
        sql = `PRAGMA ${pragma} = ${value ? 'ON' : 'OFF'}`;
    } else {
        throw new Error(`Invalid PRAGMA value type: ${typeof value}`);
    }

    await this.executeQuery(sql);
  }

  /**
   * Test connection.
   */
  async ping(): Promise<boolean> {
    try {
      await this.executeQuery('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Release database resources.
   */
  shutdown(): void {
    this.instance.close();
  }

  /**
   * Write database directly to file system.
   */
  async writeToFile(path: string): Promise<void> {
    const data = this.instance.export();

    const fs = getNodeFs();
    if (fs) {
        await fs.promises.writeFile(path, data);
    } else {
        throw new Error('File system access not available');
    }
  }
}
