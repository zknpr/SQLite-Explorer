/**
 * Logging Wrapper for Database Operations
 *
 * Intercepts calls to DatabaseOperations and logs SQL queries/actions
 * to the VS Code output channel.
 */

import * as vsc from 'vscode';
import type { DatabaseOperations } from './core/types';
import { escapeIdentifier } from './core/sql-utils';
import { buildSelectQuery, buildCountQuery } from './core/query-builder';

export function createLoggingDatabaseOperations(
    wrapped: DatabaseOperations,
    filename: string,
    outputChannel: vsc.OutputChannel
): DatabaseOperations {

    function sanitizeValue(value: any): string {
        if (value === null) return 'null';
        if (value === undefined) return 'undefined';
        if (typeof value === 'string') {
            if (value.length > 100) {
                return `"${value.substring(0, 100)}...[TRUNCATED]"`;
            }
            return `"${value}"`;
        }
        if (value instanceof Uint8Array || (typeof value === 'object' && value && 'buffer' in value)) {
            return `[BLOB ${value.byteLength} bytes]`;
        }
        if (typeof value === 'object') {
             try {
                 return JSON.stringify(value).substring(0, 100) + '...';
             } catch {
                 return '[Object]';
             }
        }
        return String(value);
    }

    function log(message: string, isWrite: boolean = false) {
        const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
        const type = isWrite ? '[WRITE]' : '[read] ';

        // Basic PII/Secret masking in the log message itself if it contains SQL values directly
        let safeMessage = message;

        safeMessage = safeMessage.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '***@***.***');
        safeMessage = safeMessage.replace(/(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, '***-***-****');
        safeMessage = safeMessage.replace(/\b(sk_live_|sk_test_|api_key_|token_|secret_|key_)[a-zA-Z0-9]{10,}\b/gi, '$1[REDACTED]');
        safeMessage = safeMessage.replace(/\b[a-fA-F0-9]{32,}\b/g, '[REDACTED_HEX]');
        safeMessage = safeMessage.replace(/\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, '****-****-****-****');
        safeMessage = safeMessage.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '***-**-****');

        outputChannel.appendLine(`${timestamp} ${type} [${filename}] ${safeMessage}`);
    }

    return new Proxy(wrapped, {
        get(target, prop, receiver) {
            const orig = Reflect.get(target, prop, receiver);
            if (typeof orig !== 'function') {
                return orig;
            }

            const propName = String(prop);

            if (propName === 'ping') {
                return orig.bind(target);
            }

            return async function (...args: any[]) {
                let message = '';
                let isWrite = false;

                switch (propName) {
                    case 'executeQuery': {
                        const [sql, params] = args;
                        isWrite = /^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|BEGIN|COMMIT|ROLLBACK)/i.test(sql?.trim() || '');
                        const paramStr = params && params.length > 0 ? ` -- params: [${params.map(sanitizeValue).join(', ')}]` : '';
                        message = `${sql}${paramStr}`;
                        break;
                    }
                    case 'serializeDatabase':
                        message = `Exporting database: ${args[0]}`;
                        break;
                    case 'applyModifications':
                        message = `Applying ${args[0]?.length || 0} modifications`;
                        isWrite = true;
                        break;
                    case 'undoModification':
                        message = `Undo: ${args[0]?.description || 'unknown'}`;
                        isWrite = true;
                        break;
                    case 'redoModification':
                        message = `Redo: ${args[0]?.description || 'unknown'}`;
                        isWrite = true;
                        break;
                    case 'flushChanges':
                        message = 'Flushing changes';
                        isWrite = true;
                        break;
                    case 'discardModifications':
                        message = `Discarding ${args[0]?.length || 0} modifications`;
                        isWrite = true;
                        break;
                    case 'updateCell': {
                        const [table, rowId, column, value, patch] = args;
                        if (patch) {
                            message = `UPDATE ${escapeIdentifier(table)} SET ${escapeIdentifier(column)} = json_patch(${escapeIdentifier(column)}, ${sanitizeValue(patch)}) WHERE rowid = ${rowId}`;
                        } else {
                            message = `UPDATE ${escapeIdentifier(table)} SET ${escapeIdentifier(column)} = ${sanitizeValue(value)} WHERE rowid = ${rowId}`;
                        }
                        isWrite = true;
                        break;
                    }
                    case 'insertRow': {
                        const [table, data] = args;
                        const columns = Object.keys(data || {});
                        if (columns.length === 0) {
                            message = `INSERT INTO ${escapeIdentifier(table)} DEFAULT VALUES`;
                        } else {
                            const colNames = columns.map(escapeIdentifier).join(', ');
                            const values = columns.map(c => sanitizeValue(data[c])).join(', ');
                            message = `INSERT INTO ${escapeIdentifier(table)} (${colNames}) VALUES (${values})`;
                        }
                        isWrite = true;
                        break;
                    }
                    case 'insertRowBatch':
                        message = `INSERT batch: ${args[1]?.length || 0} rows into ${escapeIdentifier(args[0])}`;
                        isWrite = true;
                        break;
                    case 'deleteRows':
                        message = `DELETE FROM ${escapeIdentifier(args[0])} WHERE rowid IN (${(args[1] || []).join(', ')})`;
                        isWrite = true;
                        break;
                    case 'deleteColumns': {
                        const [table, columns, dropDependentIndexes] = args;
                        if (dropDependentIndexes && dropDependentIndexes.length > 0) {
                            for (const indexName of dropDependentIndexes) {
                                log(`DROP INDEX IF EXISTS ${escapeIdentifier(indexName)}`, true);
                            }
                        }
                        for (const col of columns || []) {
                            log(`ALTER TABLE ${escapeIdentifier(table)} DROP COLUMN ${escapeIdentifier(col)}`, true);
                        }
                        return orig.apply(target, args);
                    }
                    case 'findDependentIndexes':
                        message = `Finding dependent indexes for ${escapeIdentifier(args[0])} columns: ${(args[1] || []).join(', ')}`;
                        break;
                    case 'createTable': {
                        const [table, columns] = args;
                        const columnDefs = (columns || []).map((c: any) => `${c.name} ${c.type}`).join(', ');
                        message = `CREATE TABLE ${escapeIdentifier(table)} (${columnDefs})`;
                        isWrite = true;
                        break;
                    }
                    case 'updateCellBatch':
                        message = `Batch update ${args[1]?.length || 0} cells in ${args[0]}`;
                        isWrite = true;
                        break;
                    case 'addColumn': {
                        const [table, column, type, defaultValue] = args;
                        message = `ALTER TABLE ${escapeIdentifier(table)} ADD COLUMN ${escapeIdentifier(column)} ${type}`;
                        if (defaultValue) {
                             message += ` DEFAULT ${defaultValue}`;
                        }
                        isWrite = true;
                        break;
                    }
                    case 'fetchTableData': {
                        const { sql, params } = buildSelectQuery(args[0], args[1]);
                        const paramStr = params && params.length > 0 ? ` -- params: [${params.map(sanitizeValue).join(', ')}]` : '';
                        message = `${sql}${paramStr}`;
                        break;
                    }
                    case 'fetchTableCount': {
                        const { sql, params } = buildCountQuery(args[0], args[1]);
                        const paramStr = params && params.length > 0 ? ` -- params: [${params.map(sanitizeValue).join(', ')}]` : '';
                        message = `${sql}${paramStr}`;
                        break;
                    }
                    case 'fetchSchema':
                        message = `Fetching schema`;
                        break;
                    case 'getTableInfo':
                        message = `PRAGMA table_info(${escapeIdentifier(args[0])})`;
                        break;
                    case 'getPragmas':
                        message = 'Fetching PRAGMAs';
                        break;
                    case 'setPragma':
                        message = `PRAGMA ${args[0]} = ${sanitizeValue(args[1])}`;
                        isWrite = true;
                        break;
                    case 'writeToFile':
                        message = `Writing to file: ${args[0]}`;
                        isWrite = true;
                        break;
                    default:
                        message = `Calling ${propName}`;
                        break;
                }

                if (message) {
                    log(message, isWrite);
                }

                return orig.apply(target, args);
            };
        }
    });
}
