/**
 * Extension Constants
 *
 * Centralized configuration for extension identity and settings.
 */

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
export const FistInstallMs = 'fistInstallMs';
export const SidebarLeft = 'sidebarLeft';
export const SidebarRight = 'sidebarRight';

// Synced settings keys
export const SyncedKeys = [
  FullExtensionId,
  FileNestingPatternsAdded,
  FistInstallMs,
];

// Display names
export const Title = 'SQLite Explorer';
export const ProcessTitle = 'SQLite Explorer Helper';

// Copilot integration
export const CopilotChatId = 'github.copilot-chat';
