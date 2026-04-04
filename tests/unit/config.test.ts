import './vscode_mock_setup';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  getMaximumFileSizeBytes,
  getQueryTimeout,
  Ns,
  ExtensionId,
  FullExtensionId,
  UriScheme,
  ConfigurationSection,
  TelemetryConnectionString,
  NestingPattern,
  FileNestingPatternsAdded,
  FirstInstallMs,
  SidebarLeft,
  SidebarRight,
  SyncedKeys,
  Title,
  CopilotChatId
} from '../../src/config';
import * as vsc from 'vscode';

// Access the mock's config store
const configStore = (vsc.workspace as any)._config as Map<string, unknown>;

describe('Constants', () => {
  it('should have correct extension identity constants', () => {
    assert.strictEqual(Ns, 'zknpr');
    assert.strictEqual(ExtensionId, 'sqlite-explorer');
    assert.strictEqual(FullExtensionId, 'zknpr.sqlite-explorer');
  });

  it('should have correct URI scheme', () => {
    assert.strictEqual(UriScheme, 'sqlite-explorer');
  });

  it('should have correct configuration section', () => {
    assert.strictEqual(ConfigurationSection, 'sqliteExplorer');
  });

  it('should have disabled telemetry connection string', () => {
    assert.strictEqual(TelemetryConnectionString, '');
  });

  it('should have correct file nesting constants', () => {
    assert.strictEqual(NestingPattern, '${capture}.${extname}-*');
    assert.strictEqual(FileNestingPatternsAdded, 'fileNestingPatternsAdded');
  });

  it('should have correct storage keys', () => {
    assert.strictEqual(FirstInstallMs, 'firstInstallMs');
    assert.strictEqual(SidebarLeft, 'sidebarLeft');
    assert.strictEqual(SidebarRight, 'sidebarRight');
  });

  it('should have correct synced settings keys', () => {
    assert.deepStrictEqual(SyncedKeys, [
      'zknpr.sqlite-explorer',
      'fileNestingPatternsAdded',
      'firstInstallMs',
    ]);
  });

  it('should have correct display names', () => {
    assert.strictEqual(Title, 'SQLite Explorer');
  });

  it('should have correct Copilot integration ID', () => {
    assert.strictEqual(CopilotChatId, 'github.copilot-chat');
  });
});

describe('getMaximumFileSizeBytes', () => {
  beforeEach(() => {
    configStore.clear();
  });

  it('should return default 200MB when no config set', () => {
    assert.strictEqual(getMaximumFileSizeBytes(), 200 * (2 ** 20));
  });

  it('should return configured value in bytes', () => {
    configStore.set('maxFileSize', 50);
    assert.strictEqual(getMaximumFileSizeBytes(), 50 * (2 ** 20));
  });

  it('should return 0 when configured as unlimited', () => {
    configStore.set('maxFileSize', 0);
    assert.strictEqual(getMaximumFileSizeBytes(), 0);
  });
});

describe('getQueryTimeout', () => {
  beforeEach(() => {
    configStore.clear();
  });

  it('should return default 30000ms when no config set', () => {
    assert.strictEqual(getQueryTimeout(), 30000);
  });

  it('should return configured value', () => {
    configStore.set('queryTimeout', 60000);
    assert.strictEqual(getQueryTimeout(), 60000);
  });
});
