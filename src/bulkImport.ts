import * as vscode from 'vscode';
import { DocumentRegistry } from './documentRegistry';
import type { DatabaseDocument } from './databaseModel';
import { ExtensionId } from './config';
import { IMPORT_MAX_BYTES, IMPORT_LIMIT_DESCRIPTION, parseImport, mapImportRows, importRowsAtomically } from './core/bulk-import';

/** Read no more than the accepted source size, including when a file grows during preview. */
const readSource: (uri: vscode.Uri) => Promise<string> = import.meta.env?.VSCODE_BROWSER_EXT
    ? async () => { throw new Error('Import requires a desktop or remote extension host.'); }
    : async (uri) => {
    if (uri.scheme !== 'file') {
        throw new Error('Import requires a file on the desktop or remote extension host.');
    }
    const { open } = await import('node:fs/promises');
    const file = await open(uri.fsPath, 'r');
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > IMPORT_MAX_BYTES) throw new Error('Choose a regular CSV/JSON file of at most 64 MiB.');
        const buffer = new Uint8Array(stat.size + 1);
        let length = 0;
        while (length < buffer.length) {
            const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
            if (!bytesRead) break;
            length += bytesRead;
        }
        if (length > stat.size) throw new Error('The source file changed while reading. Retry the import.');
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    } finally { await file.close(); }
};

function assertCurrent(database: DatabaseDocument, generation: number): void {
    if (![...DocumentRegistry.values()].includes(database) || database.connectionGeneration !== generation) {
        throw new Error('The destination database was closed or reloaded. Start the import again.');
    }
    if (database.isReadOnlyMode) throw new Error('The destination database is read-only.');
}

export function registerBulkImport(): vscode.Disposable {
    return vscode.commands.registerCommand(`${ExtensionId}.importData`, async () => {
        try { await importData(); }
        catch (error) { await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
    });
}

async function importData(): Promise<void> {
    if (import.meta.env?.VSCODE_BROWSER_EXT) throw new Error('CSV/JSON import requires a desktop or remote extension host.');
    const databases = [...new Set(DocumentRegistry.values())].filter(database => !database.isReadOnlyMode);
    if (!databases.length) throw new Error('Open a writable SQLite database before importing.');
    const chosen = await vscode.window.showQuickPick(databases.map(database => ({
        label: database.uri.path.split('/').pop() || database.uri.toString(), description: database.uri.toString(), database
    })), { title: 'Import destination database', ignoreFocusOut: true });
    if (!chosen) return;
    const database = chosen.database, generation = database.connectionGeneration;
    assertCurrent(database, generation);
    const schema = await database.databaseOperations.fetchSchema();
    const table = await vscode.window.showQuickPick(schema.tables.map(item => item.identifier), { title: 'Import into existing table', ignoreFocusOut: true });
    if (!table) return;
    const metadata = await database.databaseOperations.getTableInfo(table);
    const columns = metadata.filter(column => !column.isGenerated);
    const files = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, canSelectFolders: false, filters: { 'CSV or JSON': ['csv', 'json'] }, title: `Choose import source (${IMPORT_LIMIT_DESCRIPTION} maximum)` });
    if (!files?.[0]) return;
    const source = files[0];
    const format = source.path.toLowerCase().endsWith('.json') ? 'json' : 'csv';
    const parsed = parseImport(await readSource(source), format);
    const mappings = parsed.columns.map(name => columns.find(column => column.identifier === name)?.identifier);
    const automatic = mappings.every(Boolean);
    const mappingMode = await vscode.window.showQuickPick(automatic ? [
        'Use matching column names', 'Map columns manually'
    ] : ['Map columns manually'], { title: 'Import column mapping', ignoreFocusOut: true });
    if (!mappingMode) return;
    if (mappingMode === 'Map columns manually') {
        for (let index = 0; index < parsed.columns.length; index++) {
            const options: Array<{ label: string; description?: string; target?: string }> = columns
                .filter(column => !mappings.some((mapping, other) => other < index && mapping === column.identifier))
                .map(column => ({ label: column.identifier, description: column.declaredType, target: column.identifier }));
            options.sort((a, b) => Number(b.target === parsed.columns[index]) - Number(a.target === parsed.columns[index]));
            options.push({ label: 'Skip source column' });
            const target = await vscode.window.showQuickPick(options, { title: `Map source column: ${parsed.columns[index]}`, ignoreFocusOut: true });
            if (!target) return;
            mappings[index] = target.target;
        }
    }
    const rows = mapImportRows(parsed, mappings);
    // Manual mapping can leave an entire second set of row objects alive
    // across a long import. Only columns are needed after the mapping step.
    if (rows !== parsed.rows) parsed.rows = [];
    const sample = rows.slice(0, 5).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
        typeof value === 'string' && value.length > 256 ? value.slice(0, 256) + '… [preview shortened]' : value
    ])));
    const preview = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify({
        source: source.toString(), database: database.uri.toString(), table,
        rows: rows.length, mapping: Object.fromEntries(parsed.columns.map((column, index) => [column, mappings[index] ?? '[skip]'])),
        destinationColumns: metadata.map(column => ({
            name: column.identifier,
            type: column.declaredType,
            notNull: !!column.isRequired,
            primaryKeyPosition: column.primaryKeyPosition,
            generated: !!column.isGenerated,
            defaultExpression: column.defaultExpression == null ? null
                : String(column.defaultExpression).length <= 256 ? String(column.defaultExpression)
                    : String(column.defaultExpression).slice(0, 256) + '… [default preview shortened]'
        })),
        omittedDestinationColumns: columns.filter(column => !mappings.includes(column.identifier)).map(column => column.identifier),
        sample
    }, null, 2) });
    await vscode.window.showTextDocument(preview, { preview: true });
    const native = await database.databaseOperations.engineKind === 'native';
    const rowLabel = rows.length === 1 ? 'row' : 'rows';
    const confirmed = await vscode.window.showWarningMessage(`Import ${rows.length} ${rowLabel} into ${table}?`, {
        modal: true,
        detail: 'The preview shows the first five mapped rows, destination column types, and declared SQL default expressions. Defaults apply to omitted columns, not explicit JSON null or CSV empty strings. SQLite evaluates expressions when inserting each row. Preview edits do not change the import.\n\n' +
            (native ? 'This writes to the database file immediately. ' : '') +
            'The import is one undoable edit. Errors or cancellation roll back the complete import.'
    }, 'Import');
    if (confirmed !== 'Import') return;
    assertCurrent(database, generation);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Importing into ${table}`, cancellable: true }, async (progress, token) => {
        const abort = new AbortController();
        const cancellation = token.onCancellationRequested(() => abort.abort());
        const closed = database.onDidDispose(() => abort.abort());
        if (token.isCancellationRequested) abort.abort();
        try {
            await database.runTrackedMutation(async () => {
                assertCurrent(database, generation);
                const modification = await importRowsAtomically(database.databaseOperations, table, rows, database.undoMemoryLimitBytes, abort.signal,
                    completed => { if (completed % 50 === 0 || completed === rows.length) progress.report({ message: `${completed} / ${rows.length} ${rowLabel}` }); });
                // Recording belongs to the same document mutation gate as commit.
                // Do not throw on cancellation after the transaction has committed.
                database.recordExternalModification(modification);
            }, true);
        } finally { cancellation.dispose(); closed.dispose(); }
    });
    await vscode.window.showInformationMessage(`Imported ${rows.length} ${rowLabel} into ${table}.`);
}
