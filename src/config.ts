/**
 * Extension Constants
 *
 * Centralized configuration for extension identity and settings.
 * Also provides typed accessors for user-facing VS Code configuration values.
 */

import * as vsc from 'vscode';

// Extension identity
export const Ns = 'zknpr';
export const ExtensionId = 'sqlite-explorer';
export const FullExtensionId = `${Ns}.${ExtensionId}`;

// URI scheme for virtual documents
export const UriScheme = 'sqlite-explorer';

// Configuration section in settings.json
export const ConfigurationSection = 'sqliteExplorer';

// Telemetry disabled for this extension
export const TelemetryConnectionString = "";

// File nesting patterns
export const NestingPattern = "${capture}.${extname}-*";
export const FileNestingPatternsAdded = 'fileNestingPatternsAdded';

// Storage keys
export const FirstInstallMs = 'firstInstallMs';
export const SidebarLeft = 'sidebarLeft';
export const SidebarRight = 'sidebarRight';

// Synced settings keys
export const SyncedKeys = [
  FullExtensionId,
  FileNestingPatternsAdded,
  FirstInstallMs,
];

// Display names
export const Title = 'SQLite Explorer';

// Copilot integration
export const CopilotChatId = 'github.copilot-chat';

// ============================================================================
// Configuration Accessors
// ============================================================================

/** Default query timeout in milliseconds (30 seconds) */
const DEFAULT_QUERY_TIMEOUT_MS = 30000;

/**
 * Retrieve maximum file size from user configuration.
 *
 * @returns Maximum size in bytes (0 = unlimited)
 */
export function getMaximumFileSizeBytes(): number {
  const config = vsc.workspace.getConfiguration(ConfigurationSection);
  const sizeMB = config.get<number>('maxFileSize', 200);
  return sizeMB * (2 ** 20);
}

/**
 * Retrieve query timeout from user configuration.
 *
 * @returns Query timeout in milliseconds
 */
export function getQueryTimeout(): number {
  const config = vsc.workspace.getConfiguration(ConfigurationSection);
  return config.get<number>('queryTimeout', DEFAULT_QUERY_TIMEOUT_MS);
}
