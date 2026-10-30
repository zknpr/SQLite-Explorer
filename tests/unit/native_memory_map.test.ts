import './vscode_mock_setup'; // Must be first

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as vscode from 'vscode';

import {
    createNativeDatabaseConnection,
    NATIVE_MMAP_BYTES,
    nativeMemoryMapBytes
} from '../../src/nativeWorker';

type StatFs = typeof fs.promises.statfs;

/** A statfs double that reports one filesystem type per path. */
function statfsReporting(types: Record<string, bigint>, calls: string[] = []): StatFs {
    return (async (target: fs.PathLike) => {
        calls.push(String(target));
        const type = types[String(target)];
        if (type === undefined) throw Object.assign(new Error(`ENOENT: ${String(target)}`), { code: 'ENOENT' });
        return { type, bsize: 4096n, blocks: 1n, bfree: 1n, bavail: 1n, files: 1n, ffree: 1n };
    }) as unknown as StatFs;
}

describe('native memory-mapped reads', () => {
    const file = '/data/app.db';

    it('maps files on Linux local disk and memory filesystems', async () => {
        for (const [name, type] of [
            ['ext4', 0xEF53n], ['xfs', 0x58465342n], ['btrfs', 0x9123683En], ['f2fs', 0xF2F52010n],
            ['zfs', 0x2FC12FC1n], ['bcachefs', 0xCA451A4En], ['tmpfs', 0x01021994n], ['overlayfs', 0x794C7630n]
        ] as const) {
            assert.strictEqual(await nativeMemoryMapBytes(file, 'linux', statfsReporting({ [file]: type })), NATIVE_MMAP_BYTES, name);
        }
    });

    it('reads files on Linux network, FUSE, 9p and removable filesystems through read()', async () => {
        for (const [name, type] of [
            ['nfs', 0x6969n], ['cifs', 0xFF534D42n], ['smb2', 0xFE534D42n], ['fuse', 0x65735546n],
            ['v9fs', 0x01021997n], ['vfat', 0x4D44n], ['exfat', 0x2011BAB0n], ['ntfs3', 0x7366746En], ['ceph', 0x00C36400n]
        ] as const) {
            assert.strictEqual(await nativeMemoryMapBytes(file, 'linux', statfsReporting({ [file]: type })), 0, name);
        }
    });

    it('never maps on macOS, Windows or other platforms', async () => {
        // On APFS, unmapping a file changes its ctime even when it was only read.
        const calls: string[] = [];
        for (const platform of ['darwin', 'win32', 'freebsd', 'openbsd'] as const) {
            assert.strictEqual(await nativeMemoryMapBytes(file, platform, statfsReporting({ [file]: 0xEF53n, '/': 0xEF53n }, calls)), 0, platform);
        }
        assert.deepStrictEqual(calls, []);
    });

    it('asks about the directory of a database that does not exist yet', async () => {
        const calls: string[] = [];
        assert.strictEqual(
            await nativeMemoryMapBytes(file, 'linux', statfsReporting({ '/data': 0xEF53n }, calls)),
            NATIVE_MMAP_BYTES
        );
        assert.deepStrictEqual(calls, [file, '/data']);
    });

    it('propagates statfs failures other than a missing file', async () => {
        const failing = (async () => { throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }); }) as unknown as StatFs;
        await assert.rejects(nativeMemoryMapBytes(file, 'linux', failing), /EACCES/);
    });

    it('applies the decided size through the bundled worker', async (context) => {
        const platformDir = process.platform === 'darwin'
            ? (process.arch === 'arm64' ? 'aarch64-macos' : 'x86_64-macos')
            : process.platform === 'linux'
                ? (process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu')
                : process.platform === 'win32' && process.arch === 'x64' ? 'x86_64-windows' : undefined;
        if (!platformDir || !fs.existsSync(path.join('natives', platformDir, process.platform === 'win32' ? 'tjs.exe' : 'tjs'))) {
            return context.skip(`no bundled txiki worker for ${process.platform}-${process.arch}`);
        }
        fs.mkdirSync('.tmp', { recursive: true });
        const directory = fs.mkdtempSync(path.resolve('.tmp/native-memory-map-'));
        const file = path.join(directory, 'main.db');
        fs.closeSync(fs.openSync(file, 'w'));
        const logs: string[] = [];
        const outputChannel = { appendLine: (line: string) => { logs.push(line); } } as unknown as vscode.OutputChannel;
        const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()), undefined, outputChannel);
        let disposed = false;
        try {
            const { databaseOps } = await native.establishConnection(vscode.Uri.file(file), 'native-memory-map', false);
            await databaseOps.executeQuery('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
            await databaseOps.executeQuery("WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 1000) INSERT INTO t (v) SELECT 'v' || n FROM s");
            const expected = await nativeMemoryMapBytes(fs.realpathSync(file));
            if (process.platform !== 'linux') assert.strictEqual(expected, 0);
            const mainSize = await databaseOps.executeQuery('PRAGMA main.mmap_size');
            assert.strictEqual(Number(mainSize[0].rows[0][0]), expected);
            assert.deepStrictEqual((await databaseOps.executeQuery('SELECT COUNT(*) FROM t'))[0].rows, [[1000]]);
            assert.deepStrictEqual(logs.filter(line => /memory map/i.test(line)), []);
            console.log(`[native memory map] ${process.platform}-${process.arch}: main.mmap_size = ${expected}`);
            // Reading and closing must leave the file's metadata alone. A mapped
            // file on APFS gets a new ctime when its mapping goes away.
            const readCtime = fs.statSync(file, { bigint: true }).ctimeNs;
            native.workerMethods[Symbol.dispose]();
            disposed = true;
            await new Promise(resolve => setTimeout(resolve, 500));
            assert.strictEqual(fs.statSync(file, { bigint: true }).ctimeNs, readCtime);
        } finally {
            if (!disposed) native.workerMethods[Symbol.dispose]();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
