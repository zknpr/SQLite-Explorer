import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as config from '../../src/config';

describe('Config Constants', () => {
  it('should have correct extension identity constants', () => {
    assert.strictEqual(config.Ns, 'zknpr');
    assert.strictEqual(config.ExtensionId, 'sqlite-explorer');
    assert.strictEqual(config.FullExtensionId, 'zknpr.sqlite-explorer');
  });

  it('should have correct URI scheme', () => {
    assert.strictEqual(config.UriScheme, 'sqlite-explorer');
  });

  it('should have correct configuration section', () => {
    assert.strictEqual(config.ConfigurationSection, 'sqliteExplorer');
  });

  it('should have empty telemetry connection string', () => {
    assert.strictEqual(config.TelemetryConnectionString, '');
  });

  it('should have correct file nesting patterns', () => {
    assert.strictEqual(config.NestingPattern, '${capture}.${extname}-*');
    assert.strictEqual(config.FileNestingPatternsAdded, 'fileNestingPatternsAdded');
  });

  it('should have correct storage keys', () => {
    assert.strictEqual(config.FirstInstallMs, 'firstInstallMs');
    assert.strictEqual(config.SidebarLeft, 'sidebarLeft');
    assert.strictEqual(config.SidebarRight, 'sidebarRight');
  });

  it('should have correct synced settings keys', () => {
    assert.deepStrictEqual(config.SyncedKeys, [
      'zknpr.sqlite-explorer',
      'fileNestingPatternsAdded',
      'firstInstallMs',
    ]);
  });

  it('should have correct display names', () => {
    assert.strictEqual(config.Title, 'SQLite Explorer');
  });

  it('should have correct copilot integration chat id', () => {
    assert.strictEqual(config.CopilotChatId, 'github.copilot-chat');
  });
});
