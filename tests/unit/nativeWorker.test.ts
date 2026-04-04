import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as v8 from 'node:v8';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';

describe('createNativeDatabaseConnection', () => {
    let tempDir: string;
    let extensionUri: any;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-worker-test-'));
        extensionUri = { fsPath: tempDir };
    });

    after(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should throw if native binary is not available', async () => {
        await assert.rejects(
            createNativeDatabaseConnection(extensionUri),
            /Native SQLite not available on this platform/
        );
    });

    it('should throw if native worker script is not found', async () => {
        const platformDir = process.platform === 'linux' ? (process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu') :
                            process.platform === 'darwin' ? (process.arch === 'arm64' ? 'aarch64-macos' : 'x86_64-macos') :
                            'x86_64-windows';
        const binaryName = process.platform === 'win32' ? 'tjs.exe' : 'tjs';
        const binPath = path.join(tempDir, 'natives', platformDir, binaryName);

        fs.mkdirSync(path.dirname(binPath), { recursive: true });
        // To mock Windows .exe for child_process spawn, we can just copy current node executable
        if (process.platform === 'win32') {
             fs.copyFileSync(process.execPath, binPath);
        } else {
             fs.writeFileSync(binPath, '');
        }

        await assert.rejects(
            createNativeDatabaseConnection(extensionUri),
            /Native worker script not found/
        );
    });

    it('should start worker and return connection bundle', async () => {
        const platformDir = process.platform === 'linux' ? (process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu') :
                            process.platform === 'darwin' ? (process.arch === 'arm64' ? 'aarch64-macos' : 'x86_64-macos') :
                            'x86_64-windows';
        const binaryName = process.platform === 'win32' ? 'tjs.exe' : 'tjs';
        const binPath = path.join(tempDir, 'natives', platformDir, binaryName);

        fs.mkdirSync(path.dirname(binPath), { recursive: true });

        // Serialize using v8 as NativeWorker uses v8.deserialize
        const dummyScriptPath = path.join(tempDir, 'dummy.js');
        fs.writeFileSync(dummyScriptPath, `
            const v8 = require('node:v8');
            const payload = v8.serialize({"ready":true});
            const header = Buffer.alloc(4);
            header.writeUInt32BE(payload.length, 0);
            process.stdout.write(header);
            process.stdout.write(payload);
            setTimeout(() => process.exit(0), 1000);
        `);

        if (process.platform === 'win32') {
             // Create a dummy js file that node runs
             // Copy current node executable to act as tjs.exe
             fs.copyFileSync(process.execPath, binPath);
             // When tjs is spawned, it gets 'run', '<workerScriptPath>'
             // We can mock the workerScriptPath to be a file that just loads dummyScriptPath
        } else {
            const scriptContent = '#!/bin/sh\nnode ' + dummyScriptPath;
            fs.writeFileSync(binPath, scriptContent);
            fs.chmodSync(binPath, 0o755);
        }

        const scriptPath = path.join(tempDir, 'natives', 'native-worker.js');

        if (process.platform === 'win32') {
             fs.writeFileSync(scriptPath, `require(${JSON.stringify(dummyScriptPath)});`);
        } else {
             fs.writeFileSync(scriptPath, '');
        }

        const bundle = await createNativeDatabaseConnection(extensionUri);
        assert.ok(bundle.workerMethods);
        assert.strictEqual(typeof bundle.workerMethods.initializeDatabase, 'function');
        assert.strictEqual(typeof bundle.workerMethods.runQuery, 'function');
        assert.strictEqual(typeof bundle.establishConnection, 'function');

        bundle.workerMethods[Symbol.dispose]();
    });
});
