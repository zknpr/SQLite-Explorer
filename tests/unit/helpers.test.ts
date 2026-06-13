import './vscode_mock_setup';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { getUriParts, doTry, themeToCss, uiKindToString } from '../../src/helpers';
import * as vsc from 'vscode';

describe('getUriParts', () => {
  it('should parse simple file path string', () => {
    const parts = getUriParts('/home/user/test.txt');
    assert.strictEqual(parts.dirname, '/home/user/');
    assert.strictEqual(parts.filename, 'test.txt');
    assert.strictEqual(parts.basename, 'test');
    assert.strictEqual(parts.extname, '.txt');
  });

  it('should parse simple file path URI', () => {
    const uri = vsc.Uri.file('/home/user/test.txt');
    const parts = getUriParts(uri);
    assert.strictEqual(parts.dirname, 'file:///home/user/'); // Regex matches from uri.toString() which returns file://...
    assert.strictEqual(parts.filename, 'test.txt');
    assert.strictEqual(parts.basename, 'test');
    assert.strictEqual(parts.extname, '.txt');
  });

  it('should parse file without extension', () => {
    const parts = getUriParts('/home/user/makefile');
    assert.strictEqual(parts.dirname, '/home/user/');
    assert.strictEqual(parts.filename, 'makefile');
    assert.strictEqual(parts.basename, 'makefile');
    assert.strictEqual(parts.extname, '');
  });

  it('should parse file in root', () => {
    const parts = getUriParts('/config.json');
    assert.strictEqual(parts.dirname, '/');
    assert.strictEqual(parts.filename, 'config.json');
    assert.strictEqual(parts.basename, 'config');
    assert.strictEqual(parts.extname, '.json');
  });

  it('should parse just filename', () => {
      const parts = getUriParts('notes.md');
      assert.strictEqual(parts.dirname, '');
      assert.strictEqual(parts.filename, 'notes.md');
      assert.strictEqual(parts.basename, 'notes');
      assert.strictEqual(parts.extname, '.md');
  });

  it('should handle special characters and decoding', () => {
    // We use string input to test decodeURIComponent logic independently of vsc.Uri mock
    const parts = getUriParts('/path/to/file%20name.txt');
    assert.strictEqual(parts.dirname, '/path/to/');
    assert.strictEqual(parts.filename, 'file name.txt');
    assert.strictEqual(parts.basename, 'file name');
    assert.strictEqual(parts.extname, '.txt');
  });
});

describe('themeToCss', () => {
  it('should return "dark" for Dark theme', () => {
    const theme = { kind: vsc.ColorThemeKind.Dark } as vsc.ColorTheme;
    assert.strictEqual(themeToCss(theme), 'dark');
  });

  it('should return "dark" for HighContrast theme', () => {
    const theme = { kind: vsc.ColorThemeKind.HighContrast } as vsc.ColorTheme;
    assert.strictEqual(themeToCss(theme), 'dark');
  });

  it('should return "light" for Light theme', () => {
    const theme = { kind: vsc.ColorThemeKind.Light } as vsc.ColorTheme;
    assert.strictEqual(themeToCss(theme), 'light');
  });

  it('should return "light" for HighContrastLight theme', () => {
    const theme = { kind: vsc.ColorThemeKind.HighContrastLight } as vsc.ColorTheme;
    assert.strictEqual(themeToCss(theme), 'light');
  });

  it('should return undefined for an unknown theme kind', () => {
    const theme = { kind: 999 } as unknown as vsc.ColorTheme;
    assert.strictEqual(themeToCss(theme), undefined);
  });
});

describe('doTry', () => {
  let originalConsoleWarn: typeof console.warn;
  let warnMessages: unknown[][] = [];

  beforeEach(() => {
    originalConsoleWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args);
    };
    warnMessages = [];
  });

  afterEach(() => {
    console.warn = originalConsoleWarn;
  });

  it('should return result on success', () => {
    assert.strictEqual(doTry(() => 42), 42);
    assert.strictEqual(warnMessages.length, 0);
  });

  it('should return result on success even if it is falsy', () => {
    assert.strictEqual(doTry(() => 0), 0);
    assert.strictEqual(doTry(() => ''), '');
    assert.strictEqual(doTry(() => false), false);
    assert.strictEqual(warnMessages.length, 0);
  });

  it('should return undefined and log warning on error', () => {
    const result = doTry(() => { throw new Error('test error'); });
    assert.strictEqual(result, undefined);
    assert.strictEqual(warnMessages.length, 1);
    assert.deepStrictEqual(warnMessages[0], ['[SQLite Explorer]', 'test error']);
  });

  it('should return undefined and log warning with context if onError is a string', () => {
    const result = doTry(() => { throw new Error('test error'); }, 'Context message');
    assert.strictEqual(result, undefined);
    assert.strictEqual(warnMessages.length, 1);
    assert.deepStrictEqual(warnMessages[0], ['[SQLite Explorer]', 'Context message: test error']);
  });

  it('should return undefined and use custom handler if onError is a function', () => {
    let handledError: unknown;
    const result = doTry(() => { throw new Error('test error'); }, (err) => { handledError = err; });
    assert.strictEqual(result, undefined);
    assert.strictEqual(warnMessages.length, 0);
    assert.ok(handledError instanceof Error);
    assert.strictEqual(handledError.message, 'test error');
  });

  it('should return undefined and log warning on string error', () => {
    const result = doTry(() => { throw 'string error'; });
    assert.strictEqual(result, undefined);
    assert.strictEqual(warnMessages.length, 1);
    assert.deepStrictEqual(warnMessages[0], ['[SQLite Explorer]', 'string error']);
  });

  it('should return undefined and log warning on null error', () => {
    const result = doTry(() => { throw null; });
    assert.strictEqual(result, undefined);
    assert.strictEqual(warnMessages.length, 1);
    assert.deepStrictEqual(warnMessages[0], ['[SQLite Explorer]', 'null']);
  });

  it('should return undefined and log warning on non-error object', () => {
    const result = doTry(() => { throw { toString: () => 'custom object error' }; });
    assert.strictEqual(result, undefined);
    assert.strictEqual(warnMessages.length, 1);
    assert.deepStrictEqual(warnMessages[0], ['[SQLite Explorer]', 'custom object error']);
  });
});

describe('uiKindToString', () => {
  it('should return "web" for Web UIKind', () => {
    assert.strictEqual(uiKindToString(vsc.UIKind.Web), 'web');
  });

  it('should return "desktop" for Desktop UIKind', () => {
    assert.strictEqual(uiKindToString(vsc.UIKind.Desktop), 'desktop');
  });
});

describe('maskSensitiveData', () => {
  const { maskSensitiveData } = require('../../src/helpers');

  it('should mask different formats of credit card numbers', () => {
    assert.strictEqual(maskSensitiveData("My CC is 1234-5678-9012-3456"), "My CC is ****-****-****-****");
    assert.strictEqual(maskSensitiveData("My CC is 1234567890123456"), "My CC is ****-****-****-****");
    assert.strictEqual(maskSensitiveData("My CC is 1234 5678 9012 3456"), "My CC is ****-****-****-****");
    assert.strictEqual(maskSensitiveData("Amex: 378282246310005"), "Amex: ****-****-****-****");
  });

  it('should mask different formats of SSN', () => {
    assert.strictEqual(maskSensitiveData("My SSN is 123-45-6789"), "My SSN is ***-**-****");
    assert.strictEqual(maskSensitiveData("My SSN is 123 45 6789"), "My SSN is ***-**-****");
    assert.strictEqual(maskSensitiveData("My SSN is 123456789"), "My SSN is ***-**-****");
  });
});
