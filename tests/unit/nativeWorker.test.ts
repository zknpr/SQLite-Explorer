import './vscode_mock_setup';
import { describe, it, mock, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isNativeAvailable, NativeWorkerProcess } from '../../src/nativeWorker';

describe('isNativeAvailable', () => {
    let originalPlatform: string;
    let originalArch: string;

    beforeEach(() => {
        originalPlatform = process.platform;
        originalArch = process.arch;
        Object.defineProperty(vscode.env, 'uiKind', { value: 2, writable: true, configurable: true }); // Desktop
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
        Object.defineProperty(process, 'arch', { value: originalArch });
        Object.defineProperty(vscode.env, 'uiKind', { value: 2, writable: true, configurable: true }); // Desktop
        mock.restoreAll();
    });

    it('should return false when UI kind is web', async () => {
        Object.defineProperty(vscode.env, 'uiKind', { value: 1, writable: true, configurable: true }); // Web

        const result = await isNativeAvailable('/ext/path');
        assert.strictEqual(result, false);
    });

    it('should return false when platform is unsupported', async () => {
        Object.defineProperty(process, 'platform', { value: 'freebsd' });

        const result = await isNativeAvailable('/ext/path');
        assert.strictEqual(result, false);
    });

    it('should return false when binary does not exist', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        Object.defineProperty(process, 'arch', { value: 'x64' });

        mock.method(fs.promises, 'access', async () => {
            throw new Error('ENOENT');
        });

        const result = await isNativeAvailable('/ext/path');
        assert.strictEqual(result, false);
    });

    it('should return true when binary exists on linux x64', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        Object.defineProperty(process, 'arch', { value: 'x64' });

        const accessMock = mock.method(fs.promises, 'access', async () => {});

        const result = await isNativeAvailable('/ext/path');
        assert.strictEqual(result, true);

        const expectedPath = path.join('/ext/path', 'natives', 'x86_64-linux-gnu', 'tjs');
        assert.strictEqual(accessMock.mock.calls[0].arguments[0], expectedPath);
    });

    it('should return true when binary exists on linux arm64', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        Object.defineProperty(process, 'arch', { value: 'arm64' });

        const accessMock = mock.method(fs.promises, 'access', async () => {});

        const result = await isNativeAvailable('/ext/path');
        assert.strictEqual(result, true);

        const expectedPath = path.join('/ext/path', 'natives', 'aarch64-linux-gnu', 'tjs');
        assert.strictEqual(accessMock.mock.calls[0].arguments[0], expectedPath);
    });

    it('should return true when binary exists on darwin arm64', async () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        Object.defineProperty(process, 'arch', { value: 'arm64' });

        const accessMock = mock.method(fs.promises, 'access', async () => {});

        const result = await isNativeAvailable('/ext/path');
        assert.strictEqual(result, true);

        const expectedPath = path.join('/ext/path', 'natives', 'aarch64-macos', 'tjs');
        assert.strictEqual(accessMock.mock.calls[0].arguments[0], expectedPath);
    });

    it('should return true when binary exists on win32', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        Object.defineProperty(process, 'arch', { value: 'x64' });

        const accessMock = mock.method(fs.promises, 'access', async () => {});

        const result = await isNativeAvailable('/ext/path');
        assert.strictEqual(result, true);

        const expectedPath = path.join('/ext/path', 'natives', 'x86_64-windows', 'tjs.exe');
        assert.strictEqual(accessMock.mock.calls[0].arguments[0], expectedPath);
    });
});

describe('NativeWorkerProcess', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('should catch deserialization errors on invalid data', () => {
        // Instantiate the worker directly to test internal handleData method
        const worker = new NativeWorkerProcess('/fake/bin', '/fake/script');

        let errorLogged = false;
        mock.method(console, 'error', (msg: string, err: any) => {
            if (msg && typeof msg === 'string' && msg.includes('Failed to deserialize message')) {
                errorLogged = true;
            }
        });

        const badMsg = Buffer.from('this is not valid v8 data');
        const header = Buffer.alloc(4);
        header.writeUInt32BE(badMsg.length, 0);
        const payload = Buffer.concat([header, badMsg]);

        // Using any to access private handleData
        (worker as any).handleData(payload);

        assert.strictEqual(errorLogged, true, 'Should log error on bad deserialization');
    });
});
