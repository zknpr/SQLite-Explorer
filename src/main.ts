import "./shims"
import * as vsc from 'vscode';
import { TelemetryReporter } from '@vscode/extension-telemetry';
import { exportTableCommand } from './commandHandlers';
import { ExtensionId, FullExtensionId, FileNestingPatternsAdded, FistInstallMs, NestingPattern, SyncedKeys, TelemetryConnectionString, Title, UriScheme } from './config';
import { disposeAll } from './lifecycle';
import { registerEditorProvider } from './editorController';
import { SQLiteFileSystemProvider } from './virtualFileSystem';

export type DbParams = {
  filename: string,
  table: string,
  name: string,
  uri?: string,
}

export let GlobalOutputChannel: vsc.OutputChannel|null = null;

/**
 * Extension activation entry point.
 * Registers custom editors for SQLite files and sets up commands.
 */
export async function activate(context: vsc.ExtensionContext) {
  // Only create TelemetryReporter if connection string is provided.
  // An empty string causes the reporter to throw errors on every event.
  let reporter: TelemetryReporter | undefined;
  if (TelemetryConnectionString) {
    reporter = new TelemetryReporter(TelemetryConnectionString);
    context.subscriptions.push(reporter);
  }

  console.log('[INFO]', new Date().toISOString(), '- Extension activated!');

  await activateProviders(context, reporter);

  // Register refresh command
  context.subscriptions.push(
    vsc.commands.registerCommand(`${ExtensionId}.refresh`, () => {
      vsc.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
    }),
  );

  // Register export table command
  context.subscriptions.push(
    vsc.commands.registerCommand(`${ExtensionId}.exportTable`, (dbParams: DbParams, columns: string[], dbOptions?: any, tableStore?: any, exportOptions?: any, extras?: any) =>
      exportTableCommand(context, reporter, dbParams, columns, dbOptions, tableStore, exportOptions, extras)),
  );

  context.globalState.setKeysForSync(SyncedKeys);

  // Add file nesting patterns for SQLite files
  addFileNestingPatternsOnce(context);

  // Track first install time
  const firstInstall = context.globalState.get<number>(FistInstallMs);
  if (firstInstall === undefined) {
    context.globalState.update(FistInstallMs, Date.now());
  }

  // Store current version
  const currVersion = vsc.extensions.getExtension(FullExtensionId)?.packageJSON?.version as string;
  if (currVersion) {
    context.globalState.update(FullExtensionId, currVersion);
  }
}

const globalProviderSubs = new WeakSet<vsc.Disposable>();

/**
 * Activate the custom editor providers for SQLite files.
 * Creates both the default view and optional view providers.
 */
export async function activateProviders(context: vsc.ExtensionContext, reporter?: TelemetryReporter) {
  // Clean up previous providers
  const prevSubs = context.subscriptions.filter(x => globalProviderSubs.has(x));
  for (const sub of prevSubs) context.subscriptions.splice(context.subscriptions.indexOf(sub), 1);
  disposeAll(prevSubs);

  const subs = [];

  // Create output channel for SQL logging
  const channel = GlobalOutputChannel = vsc.window.createOutputChannel(Title, 'sql');
  subs.push(channel);

  // Register file system provider
  subs.push(vsc.workspace.registerFileSystemProvider(UriScheme, new SQLiteFileSystemProvider(), { isCaseSensitive: true }));

  // Register the main editor provider (default for .sqlite, .db, etc.)
  subs.push(registerEditorProvider(`${ExtensionId}.view`, context, reporter, channel, { verified: true }));

  // Register optional provider (can be selected from "Open With" menu)
  subs.push(registerEditorProvider(`${ExtensionId}.option`, context, reporter, channel, { verified: true }));

  for (const sub of subs) globalProviderSubs.add(sub);
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
