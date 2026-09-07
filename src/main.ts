import "./shims"
import * as vsc from 'vscode';
import { TelemetryReporter } from '@vscode/extension-telemetry';
import { exportTableCommand } from './tableExporter';
import { ExtensionId, FullExtensionId, FileNestingPatternsAdded, FirstInstallMs, NestingPattern, SyncedKeys, TelemetryConnectionString, Title, UriScheme } from './config';
import type { DbParams, ExportOptions } from './core/types';
import { registerEditorProvider } from './editorController';
import { SQLiteFileSystemProvider } from './virtualFileSystem';
import { CellMaterializationService } from './cellMaterialization';
import { createDesktopTestApi, type DesktopTestApi } from './desktopTestApi';
import { DocumentRegistry } from './documentRegistry';
import { generateDatabaseDocumentKey } from './helpers';

export let GlobalOutputChannel: vsc.OutputChannel|null = null;

/**
 * Extension deactivation hook.
 * VS Code calls this when the extension is deactivated.
 */
export function deactivate(): void {
  // Cleanup is handled by context.subscriptions via dispose pattern
}

/**
 * Extension activation entry point.
 * Registers custom editors for SQLite files and sets up commands.
 */
export async function activate(
  context: vsc.ExtensionContext
): Promise<{ desktopTest: DesktopTestApi } | undefined> {
  // Only create TelemetryReporter if connection string is provided.
  // An empty string causes the reporter to throw errors on every event.
  let reporter: TelemetryReporter | undefined;
  if (TelemetryConnectionString) {
    reporter = new TelemetryReporter(TelemetryConnectionString);
    context.subscriptions.push(reporter);
  }

  await activateProviders(context, reporter);

  // Register refresh command
  context.subscriptions.push(
    vsc.commands.registerCommand(`${ExtensionId}.refresh`, refreshActiveDatabase),
  );

  // Register export table command
  context.subscriptions.push(
    vsc.commands.registerCommand(`${ExtensionId}.exportTable`, (dbParams: DbParams, columns: string[], dbOptions?: unknown, tableStore?: unknown, exportOptions?: ExportOptions, extras?: unknown) =>
      exportTableCommand(context, reporter, dbParams, columns, dbOptions, tableStore, exportOptions, extras)),
  );

  context.globalState.setKeysForSync(SyncedKeys);

  // Add file nesting patterns for SQLite files
  addFileNestingPatternsOnce(context);

  // Track first install time
  const firstInstall = context.globalState.get<number>(FirstInstallMs);
  if (firstInstall === undefined) {
    context.globalState.update(FirstInstallMs, Date.now());
  }

  // Store current version
  const currVersion = vsc.extensions.getExtension(FullExtensionId)?.packageJSON?.version as string;
  if (currVersion) {
    context.globalState.update(FullExtensionId, currVersion);
  }

  // Extension-host integration tests cannot share bundled module state by
  // importing src/. Expose the narrow controller only in non-production
  // development/test hosts; marketplace and VSIX installations export nothing.
  if (context.extensionMode === vsc.ExtensionMode.Development
    || context.extensionMode === vsc.ExtensionMode.Test) {
    const desktopTest = createDesktopTestApi(context);
    context.subscriptions.push(desktopTest);
    return { desktopTest };
  }
}

/** Reload the database backing the active SQLite custom editor. */
export async function refreshActiveDatabase(): Promise<void> {
  const input = vsc.window.tabGroups.activeTabGroup.activeTab?.input as {
    readonly uri?: vsc.Uri;
    readonly viewType?: string;
  } | undefined;
  if (!input?.uri || (input.viewType !== `${ExtensionId}.view`
    && input.viewType !== `${ExtensionId}.option`)) {
    await vsc.window.showInformationMessage(vsc.l10n.t('No active SQLite database to refresh.'));
    return;
  }

  const documentKey = await generateDatabaseDocumentKey(input.uri);
  const document = DocumentRegistry.get(documentKey);
  if (!document) {
    throw new Error(vsc.l10n.t('The active SQLite document is no longer available.'));
  }
  await document.reloadFromDisk();
}

/**
 * Activate the custom editor providers for SQLite files.
 * Creates both the default view and optional view providers.
 */
export async function activateProviders(context: vsc.ExtensionContext, reporter?: TelemetryReporter) {
  const subs = [];

  // Create output channel before startup cleanup so a non-fatal sweep failure
  // remains visible without preventing the editor providers from activating.
  const channel = GlobalOutputChannel = vsc.window.createOutputChannel(Title, 'sql');
  subs.push(channel);

  const cellMaterializer = !import.meta.env?.VSCODE_BROWSER_EXT && context.globalStorageUri
    ? new CellMaterializationService(
        vsc.Uri.joinPath(context.globalStorageUri, 'cell-materializations'),
        {
          onCleanupWarning: (message, error) => channel.appendLine(
            `[Cell materialization cleanup] ${message}: ` +
            (error instanceof Error ? (error.stack ?? error.message) : String(error))
          )
        }
      )
    : undefined;
  if (cellMaterializer) subs.push(cellMaterializer);

  // Register file system provider
  subs.push(vsc.workspace.registerFileSystemProvider(UriScheme, new SQLiteFileSystemProvider(), { isCaseSensitive: true }));

  // Register the main editor provider (default for .sqlite, .db, etc.)
  subs.push(registerEditorProvider(
    `${ExtensionId}.view`,
    context,
    reporter,
    channel,
    { verified: true },
    cellMaterializer
  ));

  // Register optional provider (can be selected from "Open With" menu)
  subs.push(registerEditorProvider(
    `${ExtensionId}.option`,
    context,
    reporter,
    channel,
    { verified: true },
    cellMaterializer
  ));

  context.subscriptions.push(...subs);
}

/**
 * Add file nesting patterns for SQLite files on first install.
 * This helps group related files (like .db-wal, .db-shm) in the explorer.
 */
async function addFileNestingPatternsOnce(context: vsc.ExtensionContext) {
  const patternsAdded = context.globalState.get<boolean>(FileNestingPatternsAdded, false);
  if (!patternsAdded) {
    await addFileNestingPatterns();
    await context.globalState.update(FileNestingPatternsAdded, true);
  }
}

/**
 * Add file nesting patterns for all SQLite file extensions.
 */
async function addFileNestingPatterns() {
  const config = vsc.workspace.getConfiguration('explorer.fileNesting');
  const currPatterns = config.get<{ [key: string]: string }>('patterns', {});

  const newPatterns = {
    ...!currPatterns["*.sqlite"] ? { "*.sqlite": NestingPattern } : {},
    ...!currPatterns["*.db"] ? { "*.db": NestingPattern } : {},
    ...!currPatterns["*.sqlite3"] ? { "*.sqlite3": NestingPattern } : {},
    ...!currPatterns["*.db3"] ? { "*.db3": NestingPattern } : {},
    ...!currPatterns["*.sdb"] ? { "*.sdb": NestingPattern } : {},
    ...!currPatterns["*.s3db"] ? { "*.s3db": NestingPattern } : {},
  };

  const updatedPatterns = {
    ...currPatterns,
    ...newPatterns,
  };

  await config.update('patterns', updatedPatterns, vsc.ConfigurationTarget.Global);
}
