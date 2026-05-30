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

describe('createNativeDatabaseConnection', () => {
    let originalPlatform: string;
    let originalArch: string;
    let tempDir: string;
    const child_process = require('node:child_process');

    beforeEach(() => {
        originalPlatform = process.platform;
        originalArch = process.arch;
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
        Object.defineProperty(vscode.env, 'uiKind', { value: 2, writable: true, configurable: true }); // Desktop

        tempDir = fs.mkdtempSync(path.join(__dirname, 'test-native-'));
        const nativesDir = path.join(tempDir, 'natives', 'x86_64-linux-gnu');
        fs.mkdirSync(nativesDir, { recursive: true });
        fs.writeFileSync(path.join(nativesDir, 'tjs'), 'dummy');
        fs.writeFileSync(path.join(tempDir, 'natives', 'native-worker.js'), 'dummy');
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        Object.defineProperty(process, 'arch', { value: originalArch, configurable: true });
        fs.rmSync(tempDir, { recursive: true, force: true });
        Object.defineProperty(vscode.env, 'uiKind', { value: 2, writable: true, configurable: true });

        mock.restoreAll();
    });

    it('should throw an error with context when database opening fails', async () => {
        let mockProcess: any;
        const EventEmitter = require('node:events').EventEmitter;
        const v8 = require('v8');

        let writeChunks: Buffer[] = [];
        let writeChunksTotalLength = 0;

        let stdinWriteMock = mock.fn((buffer: Buffer) => {
            writeChunks.push(buffer);
            writeChunksTotalLength += buffer.length;

            if (writeChunksTotalLength >= 4) {
                const expectedLength = writeChunks[0].length >= 4 ? writeChunks[0].readUInt32BE(0) : Buffer.concat(writeChunks).readUInt32BE(0);
                const totalNeeded = 4 + expectedLength;

                if (writeChunksTotalLength >= totalNeeded) {
                    const fullBuffer = Buffer.concat(writeChunks);
                    const data = fullBuffer.subarray(4, totalNeeded);
                    const msg = v8.deserialize(data);

                    if (msg.method === 'open') {
                        setTimeout(() => {
                            const errorMsg = Buffer.from(v8.serialize({ id: msg.id, error: 'SQLITE_CANTOPEN: unable to open database file' }));
                            const header = Buffer.alloc(4);
                            header.writeUInt32BE(errorMsg.length, 0);
                            mockProcess.stdout.emit('data', Buffer.concat([header, errorMsg]));
                        }, 10);
                    }

                    const remaining = fullBuffer.subarray(totalNeeded);
                    writeChunks = remaining.length > 0 ? [remaining] : [];
                    writeChunksTotalLength = remaining.length;
                }
            }
            return true;
        });

        mock.method(child_process, 'spawn', () => {
            mockProcess = new EventEmitter() as any;
            mockProcess.stdout = new EventEmitter();
            mockProcess.stderr = new EventEmitter();
            mockProcess.stdin = { write: stdinWriteMock };
            mockProcess.kill = mock.fn();

            setTimeout(() => {
                const readyMsg = Buffer.from(v8.serialize({ id: -1, ready: true }));
                const header = Buffer.alloc(4);
                header.writeUInt32BE(readyMsg.length, 0);
                mockProcess.stdout.emit('data', Buffer.concat([header, readyMsg]));
            }, 10);

            return mockProcess;
        });

        const { createNativeDatabaseConnection } = require('../../src/nativeWorker');
        const extensionUri = { fsPath: tempDir } as any;
        const bundle = await createNativeDatabaseConnection(extensionUri);

        const fileUri = { fsPath: '/db/path.sqlite' } as any;
        await assert.rejects(
            bundle.establishConnection(fileUri, 'TestDB'),
            /Failed to open database "TestDB": SQLITE_CANTOPEN: unable to open database file\. Path: \/db\/path\.sqlite/
        );

        bundle.workerMethods[Symbol.dispose]();
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
