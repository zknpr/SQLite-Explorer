import './vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { it } from 'node:test';

import { captureDatabaseFileGeneration, writeDatabaseSnapshotAtomically } from '../../src/atomicDatabaseWrite';
import type { AccessListHost } from '../../src/windowsAccessList';

/**
 * After a copy into its target, a save takes the file for its own only when
 * it holds what the snapshot held (`hashFileDescriptor` in
 * `atomicDatabaseWrite.ts`). SQLite never writes the page that holds its lock
 * bytes, at 1 GiB, so in a file that large the copy leaves there whatever the
 * file had: that page is left out of the comparison. This needs two databases
 * past 1 GiB and several seconds, so it runs only when asked:
 * SQLITE_EXPLORER_BIG_TESTS=1.
 */
const LOCK_BYTES_OFFSET = 0x40000000;

function large(file: string, table: string): void {
    const database = new DatabaseSync(file);
    try {
        database.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; CREATE TABLE filler(id INTEGER PRIMARY KEY, v BLOB); BEGIN');
        const insert = database.prepare('INSERT INTO filler(v) VALUES (zeroblob(1048000))');
        for (let row = 0; row < 1100; row++) insert.run();
        database.exec(`COMMIT; CREATE TABLE ${table}(x)`);
    } finally {
        database.close();
    }
}

it('takes a file past 1 GiB for its own although its lock-byte page is not the snapshot\'s', {
    skip: process.env.SQLITE_EXPLORER_BIG_TESTS ? false : 'set SQLITE_EXPLORER_BIG_TESTS=1: two databases past 1 GiB',
    timeout: 600_000
}, async () => {
    fs.mkdirSync('.tmp', { recursive: true });
    const directory = fs.realpathSync(fs.mkdtempSync(path.resolve('.tmp/save-lock-page-')));
    try {
        const target = path.join(directory, 'target.db');
        const prepared = path.join(directory, 'prepared.db');
        large(target, 'old');
        large(prepared, 'fresh');
        assert.ok(fs.statSync(target).size > LOCK_BYTES_OFFSET + 65536);
        // Bytes nothing reads, in the target only.
        const descriptor = fs.openSync(target, 'r+');
        try {
            fs.writeSync(descriptor, Buffer.alloc(4096, 0x5a), 0, 4096, LOCK_BYTES_OFFSET);
        } finally {
            fs.closeSync(descriptor);
        }
        // As Windows would answer for a file that keeps a list of its own: the save copies into it.
        let saved = '';
        const host: AccessListHost = {
            platform: 'win32',
            run(_program, args) {
                saved = `name\r\n${args[0] === target ? 'D:PAI(A;;FA;;;BA)' : 'D:AI(A;ID;FA;;;BA)'}\r\n`;
                return { status: 0 };
            },
            withScratchFile: use => use('scratch'),
            readSavedList: () => saved,
            hold: () => () => undefined
        };
        const opened = captureDatabaseFileGeneration(fs, target, fs.statSync(target, { bigint: true }), fs.readFileSync(target));
        const warnings: string[] = [];

        await writeDatabaseSnapshotAtomically(fs, target, target, async temporary => { fs.copyFileSync(prepared, temporary); },
            undefined, (_level, message) => { warnings.push(message); }, opened, host);

        const page = Buffer.alloc(4096);
        const after = fs.openSync(target, 'r');
        try {
            fs.readSync(after, page, 0, 4096, LOCK_BYTES_OFFSET);
        } finally {
            fs.closeSync(after);
        }
        assert.ok(page.every(byte => byte === 0x5a), 'the copy left the lock-byte page as the target had it');
        assert.deepEqual(warnings.filter(message => !/durability/.test(message)), []);
        assert.notEqual(opened.fingerprint, undefined);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
