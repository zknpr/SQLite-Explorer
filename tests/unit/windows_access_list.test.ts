import './vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { captureDatabaseFileGeneration, writeDatabaseSnapshotAtomically } from '../../src/atomicDatabaseWrite';
import { createDatabaseEngine, type WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { writePagedWritableOverlayToFile } from '../../src/pagedWritableSave';
import {
    parseAccessList,
    ReplacedFileAccessList,
    sameAccessList,
    type AccessListHost
} from '../../src/windowsAccessList';

/**
 * A save that replaces a file by rename leaves a new file under the old name,
 * and Windows gives a new file the access list of its folder. So a save
 * replaces only a file that is known to have exactly that list. Any other is
 * written into where it is, and stays the same file with the list it had. No
 * program that changes a list is ever started.
 */

const FOLDER = 'D:AI(A;ID;0x1301bf;;;S-1-5-21-1-2-3-1002)(A;ID;FA;;;BA)(A;ID;0x1200a9;;;BU)';
const CUT_OFF = 'D:PAI(A;;FA;;;BA)(A;;FA;;;SY)';
const WITH_OWN_ENTRY = 'D:AI(A;;FR;;;BG)(A;ID;0x1301bf;;;S-1-5-21-1-2-3-1002)(A;ID;FA;;;BA)(A;ID;0x1200a9;;;BU)';
// What a file keeps when it is moved here from a folder only its owner and
// SYSTEM may use: that folder's entries, still marked inherited.
const MOVED_HERE = 'D:AI(A;ID;FA;;;OW)(A;ID;FA;;;SY)';
// A shared folder: whoever makes a file there gets full access to it.
const SHARED_FOLDER = 'D:AI(A;OICIIO;GA;;;CO)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)';
const MADE_BY_ANOTHER = 'D:AI(A;ID;FA;;;S-1-5-21-9-9-9-1001)(A;ID;FA;;;BA)(A;ID;0x1200a9;;;BU)';
const GIVEN_TO_SAVER = 'D:AI(A;ID;FA;;;S-1-5-21-9-9-9-1002)(A;ID;FA;;;BA)(A;ID;0x1200a9;;;BU)';

describe('reading access lists', () => {
    it('compares lists by their entries in their order, by whether they are cut off, and by what follows the entries', () => {
        assert.equal(sameAccessList(FOLDER, FOLDER.replace('D:AI', 'D:ARAI')), true);
        assert.equal(sameAccessList(FOLDER, WITH_OWN_ENTRY), false);
        assert.equal(sameAccessList('D:AI(A;;FA;;;BA)', 'D:PAI(A;;FA;;;BA)'), false);
        assert.equal(sameAccessList('D:AI(A;ID;FA;;;BA)', 'D:AI(A;;FA;;;BA)'), false);
        assert.equal(sameAccessList('D:AI', 'D:'), true);
        // Windows reads a list from its first entry on: the same entries in another order are another list.
        assert.equal(sameAccessList(FOLDER, 'D:AI(A;ID;0x1200a9;;;BU)(A;ID;FA;;;BA)(A;ID;0x1301bf;;;S-1-5-21-1-2-3-1002)'), false);
        assert.equal(sameAccessList('D:AI(D;ID;FA;;;BG)(A;ID;FA;;;WD)', 'D:AI(A;ID;FA;;;WD)(D;ID;FA;;;BG)'), false);
        assert.equal(sameAccessList('D:PAI(D;;FA;;;BG)(A;;FA;;;WD)', 'D:PAI(A;;FA;;;WD)(D;;FA;;;BG)'), false);
        // What follows the entries holds a file's integrity label.
        assert.equal(sameAccessList('D:AI(A;ID;FA;;;BA)S:AI(ML;;NW;;;LW)', 'D:AI(A;ID;FA;;;BA)'), false);
        assert.equal(sameAccessList('D:AI(A;ID;FA;;;BA)S:AI(ML;;NW;;;LW)', 'D:AI(A;ID;FA;;;BA)S:AI(ML;;NW;;;HI)'), false);
        assert.equal(sameAccessList('D:AI(A;ID;FA;;;BA)S:AI(ML;;NW;;;LW)', 'D:AI(A;ID;FA;;;BA)S:AI(ML;;NW;;;LW)'), true);
        // A conditional entry is not taken apart: such lists are the same only as text.
        const conditional = 'D:AI(XA;ID;FA;;;WD;(@User.Level == 1))';
        assert.equal(parseAccessList(conditional), undefined);
        assert.equal(sameAccessList(conditional, conditional), true);
        assert.equal(sameAccessList(conditional, FOLDER), false);
    });

    it('takes a list for the one its folder gives only when it is the whole list a new file got', () => {
        // The decision a save makes: a file is replaced only when this says yes.
        const same = sameAccessList;
        assert.equal(same(FOLDER, FOLDER), true);
        assert.equal(same(CUT_OFF, FOLDER), false);
        assert.equal(same(WITH_OWN_ENTRY, FOLDER), false);
        assert.equal(same(MOVED_HERE, FOLDER), false);
        // A folder that hands nothing down: each new file has the default list of the account that makes it.
        const fromAccount = 'D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;S-1-5-21-1-2-3-1001)';
        assert.equal(same(fromAccount, fromAccount.replace('D:P', 'D:PAI')), true);
        assert.equal(same(fromAccount, 'D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;S-1-5-21-1-2-3-1002)'), false);
        assert.equal(same(fromAccount, 'D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;S-1-5-21-1-2-3-1001)'), false);
        // A file with no entries at all is not one whose entries are all its own.
        assert.equal(same('D:AI', 'D:(A;;FA;;;SY)(A;;FA;;;BA)'), false);
    });
});

/** Windows as the module sees it: the list each path has, read through `icacls /save`. */
function fakeWindows(options: {
    platform?: NodeJS.Platform;
    folderList?: string;
    /** Paths whose list cannot be read. */
    unreadable?: string[];
} = {}) {
    const folderList = options.folderList ?? FOLDER;
    const lists = new Map<string, string>();
    const calls: Array<{ program: string; args: string[] }> = [];
    const created: string[] = [];
    /** What was held, read and let go, in order. */
    const events: string[] = [];
    const held = new Set<string>();
    let saved = '';
    const host: AccessListHost = {
        platform: options.platform ?? 'win32',
        run(program, args) {
            calls.push({ program, args: [...args] });
            assert.equal(program, 'icacls');
            assert.equal(args[1], '/save', 'the only thing ever asked of a program is to read a list');
            assert.ok(held.has(args[0]), `${args[0]} is held while a program reads its list`);
            events.push(`read ${path.win32.basename(args[0])}`);
            if (options.unreadable?.includes(args[0])) return { status: 5 };
            saved = `${path.win32.basename(args[0])}\r\n${lists.get(args[0]) ?? folderList}\r\n`;
            return { status: 0 };
        },
        withScratchFile: use => use('scratch-list'),
        readSavedList: () => saved,
        hold(file) {
            events.push(`hold ${path.win32.basename(file)}`);
            held.add(file);
            return () => { events.push(`let go of ${path.win32.basename(file)}`); held.delete(file); };
        }
    };
    return {
        host, calls, lists, created, events, held,
        read: () => calls.map(call => path.win32.basename(call.args[0])),
        /** The file found under the probe's name once it is held: the one made, unless a test says otherwise. */
        underProbeName: { dev: 1n, ino: 7n },
        /** Why the last decision could not find out, if that is why it keeps the file. */
        unknown: undefined as unknown,
        files: {
            openSync: (file: string) => { created.push(file); return 3; },
            closeSync: () => undefined,
            rmSync: (file: string) => { created.splice(created.indexOf(file), 1); lists.delete(file); },
            fstatSync: () => ({ dev: 1n, ino: 7n }),
            lstatSync(): { dev: bigint; ino: bigint } { throw new Error('replaced below'); }
        }
    };
}

const TARGET = 'C:\\data\\a.db';
const PROBE = 'C:\\data\\.a.db.sqlite-explorer-x.new';

/** What a save asks before it writes anything. */
function decide(windows: ReturnType<typeof fakeWindows>, existing = true, assertStillTarget: () => void = () => { windows.events.push('target checked'); }, left: string[] = []) {
    windows.files.lstatSync = () => windows.underProbeName;
    const access = ReplacedFileAccessList.read(existing ? TARGET : undefined, windows.files, PROBE, assertStillTarget, windows.host);
    assert.deepEqual(windows.created, left, 'the empty file beside the target is removed, and nothing else under its name');
    assert.deepEqual([...windows.held], [], 'nothing stays held');
    windows.unknown = access.unknown;
    return access.keepsOwnList;
}

describe('whether a save replaces its target or writes into it', () => {
    it('replaces a file that has what its folder gives a new file', () => {
        const windows = fakeWindows();
        assert.equal(decide(windows), false);
        assert.deepEqual(windows.read(), ['a.db', '.a.db.sqlite-explorer-x.new']);
    });

    it('replaces a new destination, and reads nothing for it', () => {
        const windows = fakeWindows();
        assert.equal(decide(windows, false), false);
        assert.deepEqual(windows.calls, []);
    });

    for (const [label, list] of [
        ['a list cut off from the folder', CUT_OFF],
        ['an entry of its own beside the folder\'s', WITH_OWN_ENTRY],
        ['the entries of the folder it was moved from', MOVED_HERE],
        ['an entry Windows writes relative to the machine', 'D:PAI(A;;FA;;;LA)(A;;FA;;;SY)'],
        ['a conditional entry, which is not taken apart', 'D:AI(XA;ID;FA;;;WD;(@User.Level == 1))']
    ] as const) {
        it(`writes into a file with ${label}`, () => {
            const windows = fakeWindows();
            windows.lists.set(TARGET, list);
            assert.equal(decide(windows), true);
        });
    }

    it('writes into a file another account made in a shared folder, and reads no third list for it', () => {
        const windows = fakeWindows({ folderList: GIVEN_TO_SAVER });
        windows.lists.set('C:\\data', SHARED_FOLDER);
        windows.lists.set(TARGET, MADE_BY_ANOTHER);
        assert.equal(decide(windows), true);
        assert.deepEqual(windows.read(), ['a.db', '.a.db.sqlite-explorer-x.new']);
    });

    // A shared folder gives each file an entry for the account that made it, so a file another account
    // made differs from a new one by that entry. Which entry is an owner's cannot be told from two lists:
    // the entry of any account or group looks the same.
    const deniedSaver = GIVEN_TO_SAVER.replace('(A;ID;FA;;;S-1-5-21-9-9-9-1002)', '(D;ID;FW;;;S-1-5-21-9-9-9-1002)');
    for (const [label, list, given, folder] of [
        ['Everyone\'s entry, from the folder it was moved from', 'D:AI(A;ID;FA;;;WD)(A;ID;FA;;;BA)(A;ID;0x1200a9;;;BU)', GIVEN_TO_SAVER, SHARED_FOLDER],
        ['the entry of every user, from the folder it was moved from', 'D:AI(A;ID;FA;;;BU)(A;ID;FA;;;BA)(A;ID;0x1200a9;;;BU)', GIVEN_TO_SAVER, SHARED_FOLDER],
        ['one entry more than a new file gets', GIVEN_TO_SAVER.replace('D:AI', 'D:AI(A;ID;FA;;;WD)'), GIVEN_TO_SAVER, SHARED_FOLDER],
        ['one entry fewer than a new file gets', 'D:AI(A;ID;FA;;;BA)(A;ID;0x1200a9;;;BU)', GIVEN_TO_SAVER, SHARED_FOLDER],
        ['a refusal for another account where the saver\'s would be', deniedSaver.replace('9-1002)', '9-1001)'), deniedSaver, SHARED_FOLDER.replace('(A;OICIIO;GA;;;CO)', '(D;OICIIO;FW;;;CO)')],
        ['no entries, where a new file gets entries of its own', 'D:AI', 'D:(A;;FA;;;SY)(A;;FA;;;BA)', FOLDER]
    ] as const) {
        it(`writes into a file with ${label}`, () => {
            const windows = fakeWindows({ folderList: given });
            windows.lists.set('C:\\data', folder);
            windows.lists.set(TARGET, list);
            assert.equal(decide(windows), true);
        });
    }

    it('holds each file under its name while a program reads its list by that name', () => {
        const windows = fakeWindows();
        assert.equal(decide(windows), false);
        assert.deepEqual(windows.events, [
            'hold a.db', 'target checked', 'read a.db',
            'hold .a.db.sqlite-explorer-x.new', 'read .a.db.sqlite-explorer-x.new',
            'let go of .a.db.sqlite-explorer-x.new', 'let go of a.db'
        ]);
    });

    it('writes into a file when the empty file it made is no longer the one under its name', () => {
        // Its list is the folder's, and so is the list read under the empty file's name: but that name
        // was given to another file between the moment it was made and the moment it was held.
        const windows = fakeWindows();
        windows.underProbeName = { dev: 1n, ino: 8n };
        // What is under the name now is not this save's to remove: it is left there.
        assert.equal(decide(windows, true, undefined, [PROBE]), true);
        assert.deepEqual(windows.read(), ['a.db'], 'the other file\'s list is not even read');
    });

    for (const [label, list, given] of [
        ['the same entries in another order', 'D:AI(D;ID;FA;;;BG)(A;ID;FA;;;WD)', 'D:AI(A;ID;FA;;;WD)(D;ID;FA;;;BG)'],
        ['a label a new file does not get', `${FOLDER}S:AI(ML;;NW;;;HI)`, FOLDER],
        ['no label where a new file gets one', FOLDER, `${FOLDER}S:AI(ML;ID;NW;;;LW)`]
    ] as const) {
        it(`writes into a file with ${label}`, () => {
            const windows = fakeWindows({ folderList: given });
            windows.lists.set(TARGET, list);
            assert.equal(decide(windows), true);
            assert.equal(windows.unknown, undefined);
        });
    }

    it('writes into a file when the file held under the target\'s name is not the one the save resolved', () => {
        const windows = fakeWindows();
        assert.equal(decide(windows, true, () => { throw new Error('Database save target changed during the save; retry.'); }), true);
        assert.deepEqual(windows.read(), []);
    });

    it('writes into a file that cannot be held, and says why', () => {
        const windows = fakeWindows();
        windows.host.hold = () => { throw new Error('sharing violation'); };
        assert.equal(decide(windows), true);
        assert.deepEqual(windows.read(), []);
        assert.match(String(windows.unknown), /sharing violation/);
        // A file known to keep a list of its own has nothing to say.
        const own = fakeWindows();
        own.lists.set(TARGET, CUT_OFF);
        assert.equal(decide(own), true);
        assert.equal(own.unknown, undefined);
    });

    it('writes into a file when it cannot learn what the folder gives a new one', () => {
        // The empty file beside the target cannot be made.
        const noProbe = fakeWindows();
        noProbe.files.openSync = () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); };
        assert.equal(decide(noProbe), true);
        // Its list cannot be read.
        assert.equal(decide(fakeWindows({ unreadable: [PROBE] })), true);
        // Even a plain file's own list could not be read: what it has is not known.
        assert.equal(decide(fakeWindows({ unreadable: [TARGET] })), true);
    });

    it('replaces a file on a volume without access lists', () => {
        const windows = fakeWindows();
        windows.lists.set(TARGET, 'D:NO_ACCESS_CONTROL');
        assert.equal(decide(windows), false);
        assert.deepEqual(windows.read(), ['a.db']);
    });

    it('asks nothing on another platform', () => {
        const windows = fakeWindows({ platform: 'linux' });
        windows.lists.set(TARGET, CUT_OFF);
        assert.equal(decide(windows), false);
        assert.deepEqual(windows.calls, []);
    });
});

function scratch(): string {
    fs.mkdirSync('.tmp', { recursive: true });
    return fs.mkdtempSync(path.resolve('.tmp/windows-access-list-'));
}

function pagedSnapshot(basePath: string) {
    const stats = fs.statSync(basePath, { bigint: true });
    return {
        chunkSize: 4, logicalSize: 8, baseLimit: 8, dirtyBytes: 4,
        baseIdentity: { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs, mode: stats.mode },
        runs: [{ startChunkIndex: 0, data: new Uint8Array([9, 8, 7, 6]).buffer }]
    };
}

/** A database with one table that holds `rows` rows. */
function database(file: string, table: string, rows = 3): void {
    // In its extended form: SQLite does not open a path past 260 characters on Windows as it is given.
    const made = new DatabaseSync(path.toNamespacedPath(file));
    try {
        made.exec(`CREATE TABLE ${table}(x); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows}) INSERT INTO ${table} SELECT i FROM n;`);
    } finally {
        made.close();
    }
}

/** The tables of the database at `file`, read by a connection of its own. */
function tablesOf(file: string): string {
    const opened = new DatabaseSync(path.toNamespacedPath(file), { readOnly: true });
    try {
        return String(opened.prepare('SELECT group_concat(name) AS names FROM sqlite_schema').get()?.names);
    } finally {
        opened.close();
    }
}

/** A snapshot save of the database at `target`, whose new content has the table `fresh`. */
async function snapshotSave(
    target: string,
    options: {
        host?: AccessListHost; log?: (message: string) => void; opened?: ReturnType<typeof captureDatabaseFileGeneration>; rows?: number;
        /** The file calls the save makes, when a test stands between it and the disk. */
        files?: typeof fs;
        /** The snapshot's bytes, when a test brings its own. */
        image?: Uint8Array;
    } = {}
): Promise<{ snapshotPath: string }> {
    let snapshotPath = '';
    await writeDatabaseSnapshotAtomically(options.files ?? fs, options.opened?.sourcePath, target, async temporary => {
        snapshotPath = temporary;
        if (options.image) fs.writeFileSync(temporary, options.image, { flag: 'wx' });
        else database(temporary, 'fresh', options.rows);
    }, undefined, (_level, message) => { options.log?.(message); }, options.opened, options.host);
    return { snapshotPath };
}

// The route is chosen by the list alone, so it can be taken on every platform:
// the model answers as Windows would, and the save's files are real.
describe('a save that writes into its target', () => {
    const setup = () => {
        const directory = scratch();
        const target = path.join(directory, 'a.db');
        database(target, 'old');
        return { directory, target: fs.realpathSync(target) };
    };
    const leftovers = (directory: string) => fs.readdirSync(directory).filter(name => name !== 'a.db');

    it('keeps the file, and writes the snapshot in the account\'s temporary folder', async () => {
        const { directory, target } = setup();
        try {
            const before = fs.statSync(target, { bigint: true });
            const windows = fakeWindows();
            windows.lists.set(target, CUT_OFF);
            const warnings: string[] = [];
            // Each look the save takes at its target, among what it holds and lets go.
            const files = new Proxy(fs, {
                get(real, key) {
                    if (key !== 'statSync' && key !== 'lstatSync') return Reflect.get(real, key);
                    return (file: fs.PathLike, options?: fs.StatSyncOptions) => {
                        if (file === target) windows.events.push('look at a.db');
                        return real[key](file, options);
                    };
                }
            });

            const { snapshotPath } = await snapshotSave(target, { host: windows.host, files, log: message => { warnings.push(message); } });

            assert.equal(tablesOf(target), 'fresh');
            const after = fs.statSync(target, { bigint: true });
            assert.equal(after.ino, before.ino, 'the same file, not a new one under its name');
            assert.equal(after.mode, before.mode);
            // In the account's temporary folder, in a directory of its own, and gone afterwards.
            assert.equal(path.dirname(path.dirname(snapshotPath)), fs.realpathSync.native(os.tmpdir()));
            assert.equal(fs.existsSync(path.dirname(snapshotPath)), false);
            assert.deepEqual(leftovers(directory), []);
            assert.deepEqual(warnings.filter(message => !/durability/.test(message)), []);
            // Nothing but reads was asked of a program.
            assert.ok(windows.calls.length > 0 && windows.calls.every(call => call.args[1] === '/save'));
            // The file was held twice: while its list was read, and again for the copy. That second hold
            // comes before the save's last look at the file and lasts until it has looked once more,
            // after the copy: a check made before the hold says nothing about the file that is held.
            const held = windows.events.filter(event => event.endsWith(' a.db') && event !== 'read a.db');
            assert.deepEqual(held.slice(held.lastIndexOf('hold a.db')), ['hold a.db', 'look at a.db', 'look at a.db', 'let go of a.db']);
            assert.equal(held.filter(event => event === 'hold a.db').length, 2);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('says so in its log when it writes into a file because it could not compare the lists', async () => {
        const { directory, target } = setup();
        try {
            const windows = fakeWindows({ unreadable: [target] });
            const warnings: string[] = [];

            await snapshotSave(target, { host: windows.host, log: message => { warnings.push(message); } });

            assert.equal(tablesOf(target), 'fresh');
            assert.deepEqual(warnings.filter(message => !/durability/.test(message)),
                ['Could not compare the database\'s permissions with a new file\'s, so it is written where it is.']);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('replaces a file with its folder\'s list, beside it, as before', async () => {
        const { directory, target } = setup();
        try {
            const before = fs.statSync(target, { bigint: true });
            const windows = fakeWindows();

            const { snapshotPath } = await snapshotSave(target, { host: windows.host });

            assert.equal(tablesOf(target), 'fresh');
            assert.notEqual(fs.statSync(target, { bigint: true }).ino, before.ino);
            assert.equal(fs.realpathSync(path.dirname(snapshotPath)), fs.realpathSync(directory));
            assert.deepEqual(leftovers(directory), []);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('saves twice in a row, and refuses after another program changed the file in between', async () => {
        const { directory, target } = setup();
        try {
            const windows = fakeWindows();
            windows.lists.set(target, CUT_OFF);
            const opened = captureDatabaseFileGeneration(fs, target, fs.statSync(target, { bigint: true }), fs.readFileSync(target));

            await snapshotSave(target, { host: windows.host, opened, rows: 5 });
            await snapshotSave(target, { host: windows.host, opened, rows: 7 });
            assert.equal(tablesOf(target), 'fresh');
            {
                const check = new DatabaseSync(target, { readOnly: true });
                try { assert.equal(check.prepare('SELECT count(*) AS n FROM fresh').get()?.n, 7); } finally { check.close(); }
            }

            // Another program writes to it.
            const other = new DatabaseSync(target);
            try { other.exec('CREATE TABLE theirs(x)'); } finally { other.close(); }
            await assert.rejects(snapshotSave(target, { host: windows.host, opened }), /changed|Reload/i);
            assert.equal(tablesOf(target), 'fresh,theirs');
            assert.deepEqual(leftovers(directory), []);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('does not take another program\'s write, made right after its copy, for its own', async () => {
        const { directory, target } = setup();
        try {
            const windows = fakeWindows();
            windows.lists.set(target, CUT_OFF);
            const opened = captureDatabaseFileGeneration(fs, target, fs.statSync(target, { bigint: true }), fs.readFileSync(target));
            // The other program commits at the moment the save first looks at the file it has just written.
            let theirs = false;
            const copied = (): boolean => {
                try { return fs.readFileSync(target).includes('CREATE TABLE fresh'); } catch { return false; }
            };
            const files = new Proxy(fs, {
                get(real, key) {
                    if (key !== 'statSync') return Reflect.get(real, key);
                    return (file: fs.PathLike, options?: fs.StatSyncOptions) => {
                        if (!theirs && file === target && copied()) {
                            theirs = true;
                            const other = new DatabaseSync(target);
                            try { other.exec('CREATE TABLE theirs(x)'); } finally { other.close(); }
                        }
                        return real.statSync(file, options);
                    };
                }
            });
            const warnings: string[] = [];

            await snapshotSave(target, { host: windows.host, opened, files, log: message => { warnings.push(message); } });

            assert.equal(theirs, true);
            assert.equal(tablesOf(target), 'fresh,theirs');
            // The save is done, and says it cannot vouch for what the file holds now.
            assert.ok(warnings.some(message => /new file generation could not be verified/.test(message)), warnings.join(' | '));
            assert.equal(opened.fingerprint, undefined);
            // So the next save does not write over what the other program added.
            await assert.rejects(snapshotSave(target, { host: windows.host, opened, rows: 9 }), /changed on disk/);
            assert.equal(tablesOf(target), 'fresh,theirs');
            assert.deepEqual(leftovers(directory), []);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('fails when the target\'s name was given to another file between its last check and the copy', async () => {
        const { directory, target } = setup();
        try {
            const theirs = path.join(directory, 'theirs.db');
            database(theirs, 'theirs');
            const windows = fakeWindows();
            windows.lists.set(target, CUT_OFF);
            // The model's hold keeps nothing in place, as a real one does: the name is re-pointed after
            // the save's last look at its snapshot, which follows its last look at the target.
            let looks = 0;
            const files = new Proxy(fs, {
                get(real, key) {
                    if (key !== 'lstatSync') return Reflect.get(real, key);
                    return (file: fs.PathLike, options?: fs.StatSyncOptions) => {
                        if (String(file).endsWith('snapshot.db') && ++looks === 2) {
                            real.renameSync(target, `${target}.moved`);
                            real.renameSync(theirs, target);
                        }
                        return real.lstatSync(file, options);
                    };
                }
            });

            await assert.rejects(snapshotSave(target, { host: windows.host, files }), /was replaced while it was written into\./);

            assert.equal(looks >= 2, true);
            assert.equal(tablesOf(`${target}.moved`), 'old', 'the file the save resolved was not written');
            assert.ok(windows.events.includes('hold a.db') && windows.events.at(-1) === 'let go of a.db', windows.events.join(', '));
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('does not copy into a target it cannot hold', async () => {
        const { directory, target } = setup();
        try {
            const windows = fakeWindows();
            windows.lists.set(target, CUT_OFF);
            const model = windows.host.hold;
            let holds = 0;
            // The two holds of the decision succeed; the one for the copy does not.
            windows.host.hold = held => {
                if (held === target && ++holds === 2) throw new Error('sharing violation');
                return model(held);
            };

            await assert.rejects(snapshotSave(target, { host: windows.host }), /Cannot write into '.*': sharing violation\. The file was not changed\./);

            assert.equal(tablesOf(target), 'old');
            assert.deepEqual(leftovers(directory), []);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('vouches for what it wrote from the WebAssembly engine\'s own snapshot, into a rollback and a WAL file', async () => {
        const { directory, target } = setup();
        // The engine's SQLite is not the one that copies: each writes its own version into the file's header.
        const source = path.join(directory, 'source.db');
        database(source, 'fresh', 400);
        const engine = (await createDatabaseEngine({ content: null, filePath: source, maxSize: 0, readOnlyMode: false }, () => undefined)).operations as WasmDatabaseEngine;
        try {
            const image = (engine as unknown as { exportDatabaseImage(): Uint8Array }).exportDatabaseImage();
            for (const journal of ['delete', 'wal']) {
                const file = path.join(path.dirname(target), `${journal}.db`);
                database(file, 'old');
                const mode = new DatabaseSync(file);
                try { mode.exec(`PRAGMA journal_mode=${journal}`); } finally { mode.close(); }
                const windows = fakeWindows();
                windows.lists.set(file, CUT_OFF);
                // Held as the product holds it, by a second connection that runs nothing: SQLite must
                // still fold a WAL back into the file when the copy's own connection closes.
                const model = windows.host.hold;
                windows.host.hold = held => {
                    const release = model(held);
                    const connection = new DatabaseSync(held, { readOnly: true });
                    return () => { connection.close(); release(); };
                };
                const opened = captureDatabaseFileGeneration(fs, file, fs.statSync(file, { bigint: true }), fs.readFileSync(file));
                const warnings: string[] = [];
                for (let save = 0; save < 2; save++) {
                    await snapshotSave(file, { host: windows.host, opened, image, log: message => { warnings.push(message); } });
                    assert.notEqual(opened.fingerprint, undefined, `${journal}, save ${save + 1}`);
                }
                assert.deepEqual(warnings.filter(message => !/durability/.test(message)), [], journal);
                assert.equal(tablesOf(file), 'fresh');
            }
        } finally {
            engine.shutdown();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('tries its copy again while a reader has the file, and says so when the reader stays', async () => {
        // An empty file has no lock a save could take first, so the copy is the first to meet the reader.
        const directory = scratch();
        try {
            const target = fs.realpathSync(directory) + path.sep + 'a.db';
            const windows = fakeWindows();
            windows.lists.set(target, CUT_OFF);
            const holding = (): DatabaseSync => {
                const reader = new DatabaseSync(target, { readOnly: true });
                reader.exec('BEGIN');
                reader.prepare('SELECT count(*) FROM sqlite_schema').get();
                return reader;
            };

            fs.writeFileSync(target, '');
            const brief = holding();
            setTimeout(() => { brief.exec('COMMIT'); brief.close(); }, 100);
            const started = performance.now();
            await snapshotSave(target, { host: windows.host });
            assert.ok(performance.now() - started >= 80, 'it waited for the reader');
            assert.equal(tablesOf(target), 'fresh');

            fs.writeFileSync(target, '');
            const lasting = holding();
            try {
                await assert.rejects(snapshotSave(target, { host: windows.host }), /Another program has '.*' open or locked: close the database there and save again\. The file was not changed\./);
                assert.equal(fs.statSync(target).size, 0);
            } finally {
                lasting.exec('COMMIT');
                lasting.close();
            }
            assert.deepEqual(leftovers(directory), []);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('waits for a reader that lets go, and gives up on one that does not', async () => {
        const { directory, target } = setup();
        try {
            const windows = fakeWindows();
            windows.lists.set(target, CUT_OFF);
            const holding = (): DatabaseSync => {
                const reader = new DatabaseSync(target, { readOnly: true });
                reader.exec('BEGIN');
                reader.prepare('SELECT count(*) FROM sqlite_schema').get();
                return reader;
            };

            const brief = holding();
            setTimeout(() => { brief.exec('COMMIT'); brief.close(); }, 100);
            await snapshotSave(target, { host: windows.host });
            assert.equal(tablesOf(target), 'fresh');

            const lasting = holding();
            try {
                const started = performance.now();
                await assert.rejects(snapshotSave(target, { host: windows.host, rows: 9 }), /exclusive SQLite lock|open or locked/);
                assert.ok(performance.now() - started >= 500, 'it tried again for a while first');
                // What the reader has is what was there.
                assert.equal(lasting.prepare('SELECT count(*) AS n FROM fresh').get()?.n, 3);
            } finally {
                lasting.exec('COMMIT');
                lasting.close();
            }
            assert.deepEqual(leftovers(directory), []);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('says what it can about a WAL file that cannot take the content\'s page size, and leaves it as it was', async () => {
        const directory = scratch();
        try {
            const target = fs.realpathSync(directory) + path.sep + 'a.db';
            const made = new DatabaseSync(target);
            try { made.exec('PRAGMA page_size=8192; PRAGMA journal_mode=WAL; CREATE TABLE old(x)'); } finally { made.close(); }
            const before = fs.readFileSync(target);
            const windows = fakeWindows();
            windows.lists.set(target, CUT_OFF);

            await assert.rejects(snapshotSave(target, { host: windows.host }),
                /Cannot write into '.*': attempt to write a readonly database\. The file was not changed\. It is read-only, or a WAL file with another page size/);

            assert.deepEqual(fs.readFileSync(target), before);
            assert.deepEqual(leftovers(directory).filter(name => !/-(wal|shm)$/.test(name)), []);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('refuses a target that is not a database, and leaves it as it was', async () => {
        const directory = scratch();
        try {
            const target = fs.realpathSync(directory) + path.sep + 'a.db';
            fs.writeFileSync(target, Buffer.alloc(20000, 0x41));
            const windows = fakeWindows();
            windows.lists.set(target, CUT_OFF);

            await assert.rejects(snapshotSave(target, { host: windows.host }), /is not a SQLite database, and its permissions are its own/);

            assert.deepEqual(fs.readFileSync(target), Buffer.alloc(20000, 0x41));
            assert.deepEqual(leftovers(directory), []);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('a paged save refuses a target with a list of its own before it writes anything', async () => {
        const directory = scratch();
        try {
            const target = fs.realpathSync(directory) + path.sep + 'a.db';
            fs.writeFileSync(target, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
            const windows = fakeWindows();
            windows.lists.set(target, CUT_OFF);

            await assert.rejects(
                writePagedWritableOverlayToFile(fs, target, target, pagedSnapshot(target), undefined, () => ({ release() {} }), undefined, windows.host),
                /has permissions of its own, and a database opened page by page is saved by replacing its file/
            );

            assert.deepEqual([...fs.readFileSync(target)], [1, 2, 3, 4, 5, 6, 7, 8]);
            assert.deepEqual(leftovers(directory), []);
            assert.ok(windows.calls.every(call => call.args[1] === '/save'));

            // When the lists could not be compared, it says that and why, not that the file has a list of its own.
            await assert.rejects(
                writePagedWritableOverlayToFile(fs, target, target, pagedSnapshot(target), undefined, () => ({ release() {} }), undefined, fakeWindows({ unreadable: [target] }).host),
                /The permissions of '.*' could not be compared with a new file's \(Reading the access list ended with code 5\), and a database opened page by page is saved by replacing its file, which could lose them/
            );
            assert.deepEqual([...fs.readFileSync(target)], [1, 2, 3, 4, 5, 6, 7, 8]);

            // With its folder's list it is replaced as before.
            const plain = fakeWindows();
            await writePagedWritableOverlayToFile(fs, target, target, pagedSnapshot(target), undefined, () => ({ release() {} }), undefined, plain.host);
            assert.deepEqual([...fs.readFileSync(target)], [9, 8, 7, 6, 5, 6, 7, 8]);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});

/** A file's list as Windows writes it. */
function listTextOf(file: string): string {
    const listFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'access-list-test-')), 'list');
    try {
        const saved = spawnSync('icacls', [file, '/save', listFile], { encoding: 'utf8' });
        assert.equal(saved.status, 0, `${saved.stdout}${saved.stderr}`);
        return fs.readFileSync(listFile, 'utf16le').split(/\r?\n/)[1].trim();
    } finally {
        fs.rmSync(path.dirname(listFile), { recursive: true, force: true });
    }
}

function icacls(...args: string[]): void {
    const result = spawnSync('icacls', args, { encoding: 'utf8' });
    assert.equal(result.status, 0, `icacls ${args.join(' ')}: ${result.stdout}${result.stderr}`);
}

/** The account that owns a file, which `icacls /save` does not write. */
function ownerOf(file: string): string {
    // Windows PowerShell finds its own modules when it inherits no module path. One inherited from
    // PowerShell 7, the shell of a CI step, lists that version's modules first, which it cannot load.
    const env: NodeJS.ProcessEnv = { ...process.env, ACL_TEST_FILE: file };
    for (const name of Object.keys(env)) {
        if (name.toLowerCase() === 'psmodulepath') delete env[name];
    }
    const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Acl -LiteralPath $env:ACL_TEST_FILE).Owner'], {
        env, encoding: 'utf8'
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    return result.stdout.trim();
}

const onWindows = { skip: process.platform === 'win32' ? false : 'Windows access lists' };

describe('a save on Windows', onWindows, () => {
    // SYSTEM and the owner only, cut off from the folder around it.
    const ownerOnly = (target: string) => icacls(target, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)(F)', '*S-1-3-4:(OI)(CI)(F)');
    /** Every program the save starts, while `run` runs. */
    const programsStartedBy = async (run: () => Promise<unknown>): Promise<string[]> => {
        const processes = require('node:child_process') as typeof childProcess;
        const real = processes.spawnSync;
        const started: string[] = [];
        (processes as { spawnSync: unknown }).spawnSync = (program: string, args: string[], options: object) => {
            started.push(`${path.basename(program).toLowerCase()} ${args.slice(1).filter(argument => argument.startsWith('/')).join(' ')}`);
            return (real as (...given: unknown[]) => unknown)(program, args, options);
        };
        try {
            await run();
        } finally {
            (processes as { spawnSync: unknown }).spawnSync = real;
        }
        return started;
    };
    const fixtures: Array<[string, (directory: string) => string]> = [
        ['a list cut off from the folder', directory => {
            const target = path.join(directory, 'own.db');
            database(target, 'old');
            icacls(target, '/inheritance:r', '/grant:r', '*S-1-5-18:(F)', '*S-1-3-4:(F)');
            return target;
        }],
        ['an entry added beside the folder\'s', directory => {
            const target = path.join(directory, 'extra.db');
            database(target, 'old');
            icacls(target, '/grant', '*S-1-5-32-546:(R)');
            return target;
        }],
        ['a refusal added beside the folder\'s', directory => {
            const target = path.join(directory, 'refused.db');
            database(target, 'old');
            icacls(target, '/deny', '*S-1-5-32-546:(R)');
            return target;
        }],
        ['the entries of the folder it was moved from', directory => {
            const closed = path.join(directory, 'closed');
            fs.mkdirSync(closed);
            ownerOnly(closed);
            database(path.join(closed, 'moved.db'), 'old');
            const target = path.join(directory, 'moved.db');
            fs.renameSync(path.join(closed, 'moved.db'), target);
            return target;
        }],
        ['a list cut off from the folder, on a path past 260 characters', directory => {
            let deep = directory;
            while (deep.length < 300) deep = path.join(deep, 'd'.repeat(40));
            fs.mkdirSync(deep, { recursive: true });
            const target = path.join(deep, 'own.db');
            database(target, 'old');
            icacls(path.toNamespacedPath(target), '/inheritance:r', '/grant:r', '*S-1-5-18:(F)', '*S-1-3-4:(F)');
            return target;
        }]
    ];

    for (const [label, fixture] of fixtures) {
        it(`a snapshot save writes into a file with ${label}, which stays as it was`, async () => {
            const directory = scratch();
            try {
                const target = fixture(directory);
                const extended = path.toNamespacedPath(target);
                const before = { list: listTextOf(extended), owner: ownerOf(target), file: fs.statSync(target, { bigint: true }).ino };
                const warnings: string[] = [];
                let snapshotPath = '';

                const started = await programsStartedBy(async () => {
                    ({ snapshotPath } = await snapshotSave(target, { log: message => { warnings.push(message); } }));
                });

                assert.equal(tablesOf(target), 'fresh');
                // The same file, with the list and the owner it had: nothing was put back, because nothing was lost.
                assert.equal(fs.statSync(target, { bigint: true }).ino, before.file);
                assert.equal(listTextOf(extended), before.list);
                assert.equal(ownerOf(target), before.owner);
                assert.deepEqual(warnings, []);
                // Two lists were read, the target's and a new file's, and no program was started that could change one.
                assert.deepEqual(started, ['icacls.exe /save /L', 'icacls.exe /save /L']);
                // The snapshot was written in this account's temporary folder and is gone.
                assert.equal(path.dirname(path.dirname(snapshotPath)).toLowerCase(), fs.realpathSync.native(os.tmpdir()).toLowerCase());
                assert.equal(fs.existsSync(path.dirname(snapshotPath)), false);
                assert.deepEqual(fs.readdirSync(path.dirname(target)).filter(name => name.includes('.sqlite-explorer-')), []);
            } finally {
                fs.rmSync(directory, { recursive: true, force: true });
            }
        });
    }

    it('a snapshot save writes into a moved file in a folder that gives each file an entry for its maker\'s group', async t => {
        const directory = scratch();
        try {
            // Two folders that differ by a CREATOR GROUP entry for their files.
            const withGroup = path.join(directory, 'with-group');
            const without = path.join(directory, 'without');
            for (const folder of [withGroup, without]) {
                fs.mkdirSync(folder);
                // OWNER RIGHTS keeps the folder usable by whoever runs this, on top of what its files get.
                icacls(folder, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)(F)', '*S-1-3-0:(OI)(CI)(IO)(F)', '*S-1-3-4:(OI)(CI)(F)');
            }
            icacls(withGroup, '/grant', '*S-1-3-1:(OI)(CI)(IO)(F)');
            database(path.join(withGroup, 'new.db'), 'unused');
            database(path.join(without, 'moved.db'), 'old');
            const given = listTextOf(path.join(withGroup, 'new.db'));
            const target = path.join(withGroup, 'moved.db');
            fs.renameSync(path.join(without, 'moved.db'), target);
            const before = listTextOf(target);
            if (parseAccessList(before)!.entries.length === parseAccessList(given)!.entries.length) {
                t.skip('for this account the group\'s entry is one the file has anyway');
                return;
            }
            const file = fs.statSync(target, { bigint: true }).ino;

            await snapshotSave(target);

            // Not replaced by a file with the group's entry: the same file and list.
            assert.equal(fs.statSync(target, { bigint: true }).ino, file);
            assert.equal(listTextOf(target), before);
            assert.equal(tablesOf(target), 'fresh');
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('a snapshot save writes into a file that has its folder\'s entries in another order', async () => {
        const directory = scratch();
        try {
            // Two folders that hand their files the same entries in two orders: a file gets what its
            // folder adds before what that folder inherited. `from` refuses Guests itself and inherits
            // Everyone's entry; `here` adds Everyone's entry itself and inherits the refusal.
            const cutOff = ['/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)(F)', '*S-1-3-4:(OI)(CI)(F)'];
            const above = { from: path.join(directory, 'above-from'), here: path.join(directory, 'above-here') };
            const from = path.join(above.from, 'from');
            const here = path.join(above.here, 'here');
            fs.mkdirSync(from, { recursive: true });
            fs.mkdirSync(here, { recursive: true });
            icacls(above.from, ...cutOff, '*S-1-1-0:(OI)(CI)(M)');
            icacls(from, '/deny', '*S-1-5-32-546:(OI)(CI)(R)');
            icacls(above.here, ...cutOff);
            icacls(above.here, '/deny', '*S-1-5-32-546:(OI)(CI)(R)');
            icacls(here, '/grant', '*S-1-1-0:(OI)(CI)(M)');
            database(path.join(from, 'moved.db'), 'old');
            database(path.join(here, 'new.db'), 'unused');
            const target = path.join(here, 'moved.db');
            fs.renameSync(path.join(from, 'moved.db'), target);
            const before = { list: listTextOf(target), file: fs.statSync(target, { bigint: true }).ino };
            const given = listTextOf(path.join(here, 'new.db'));
            const entries = (list: string): string[] => [...parseAccessList(list)!.entries].sort();
            assert.deepEqual(entries(before.list), entries(given), `the same entries: ${before.list} and ${given}`);
            assert.notEqual(parseAccessList(before.list)!.entries.join(), parseAccessList(given)!.entries.join(), 'in another order');
            // The moved file refuses Guests before it admits Everyone; a new file here admits Everyone first.
            assert.ok(before.list.indexOf(';;;BG)') < before.list.indexOf(';;;WD)'), before.list);
            assert.ok(given.indexOf(';;;WD)') < given.indexOf(';;;BG)'), given);

            await snapshotSave(target);

            assert.equal(tablesOf(target), 'fresh');
            assert.equal(fs.statSync(target, { bigint: true }).ino, before.file, 'the same file, not a new one with the other order');
            assert.equal(listTextOf(target), before.list);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('a snapshot save writes into a file when it cannot learn what the folder gives a new one', async () => {
        const directory = scratch();
        try {
            const target = path.join(directory, 'plain.db');
            database(target, 'old');
            const before = { list: listTextOf(target), file: fs.statSync(target, { bigint: true }).ino };
            const warnings: string[] = [];
            // The empty file beside the target cannot be made.
            const files = {
                ...fs,
                openSync: (file: fs.PathLike, ...rest: unknown[]) => {
                    if (String(file).endsWith('.new')) throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
                    return (fs.openSync as (...args: unknown[]) => number)(file, ...rest);
                }
            } as typeof fs;

            await writeDatabaseSnapshotAtomically(files, undefined, target, async temporary => { database(temporary, 'fresh'); },
                undefined, (_level, message) => { warnings.push(message); });

            assert.equal(tablesOf(target), 'fresh');
            assert.equal(fs.statSync(target, { bigint: true }).ino, before.file);
            assert.equal(listTextOf(target), before.list);
            // It says why this file, which has its folder's list, was not replaced.
            assert.deepEqual(warnings, ['Could not compare the database\'s permissions with a new file\'s, so it is written where it is.']);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('a snapshot save replaces a file with its folder\'s list and starts nothing but two reads', async () => {
        const directory = scratch();
        try {
            // One entry of this folder goes to the files in it and no further down.
            icacls(directory, '/grant', '*S-1-5-32-546:(OI)(NP)(R)');
            const target = path.join(directory, 'plain.db');
            database(target, 'old');
            const before = { list: listTextOf(target), file: fs.statSync(target, { bigint: true }).ino };
            assert.ok(before.list.includes('(A;ID;FR;;;BG)'), before.list);
            let snapshotPath = '';

            const started = await programsStartedBy(async () => { ({ snapshotPath } = await snapshotSave(target)); });

            assert.equal(tablesOf(target), 'fresh');
            assert.notEqual(fs.statSync(target, { bigint: true }).ino, before.file);
            // Written beside its target, the new file has what the folder gives, the files-only entry included.
            assert.equal(listTextOf(target), before.list);
            assert.equal(path.dirname(snapshotPath).toLowerCase(), fs.realpathSync(directory).toLowerCase());
            assert.deepEqual(started, ['icacls.exe /save /L', 'icacls.exe /save /L']);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('a snapshot save leaves a file in a folder that gives each file\'s owner an entry as it was', async () => {
        const directory = scratch();
        try {
            icacls(directory, '/grant', '*S-1-3-0:(OI)(CI)(IO)(F)');
            const target = path.join(directory, 'shared.db');
            database(target, 'old');
            const before = listTextOf(target);

            await snapshotSave(target);

            assert.equal(sameAccessList(listTextOf(target), before), true);
            assert.equal(tablesOf(target), 'fresh');
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('a save keeps each file whose list is read, and the folder around it, under its name meanwhile', async () => {
        const directory = scratch();
        try {
            const folder = path.join(directory, 'folder');
            fs.mkdirSync(folder);
            const target = path.join(folder, 'plain.db');
            database(target, 'old');
            // A rename of the file, and of the folder around it. Each is put back at once when it worked.
            const attempt = (from: string): string => {
                try {
                    fs.renameSync(from, `${from}.moved`);
                    fs.renameSync(`${from}.moved`, from);
                    return 'renamed';
                } catch (error) {
                    return String((error as NodeJS.ErrnoException).code);
                }
            };
            const processes = require('node:child_process') as typeof childProcess;
            const real = processes.spawnSync;
            const during: string[] = [];
            (processes as { spawnSync: unknown }).spawnSync = (program: string, args: string[], options: object) => {
                // args[0] is the path whose list this program is about to read.
                during.push(`${path.basename(args[0]).replace(/\.sqlite-explorer-.*\.new$/, '.new')}: file ${attempt(args[0])}, folder ${attempt(folder)}`);
                return (real as (...given: unknown[]) => unknown)(program, args, options);
            };
            try {
                await snapshotSave(target);
            } finally {
                (processes as { spawnSync: unknown }).spawnSync = real;
            }

            assert.equal(during.length, 2, during.join(' | '));
            for (const line of during) assert.match(line, /: file (EBUSY|EPERM|EACCES), folder (EBUSY|EPERM|EACCES)$/);
            assert.match(during[0], /^plain\.db:/);
            assert.match(during[1], /^\.plain\.db\.new:/);
            // With nothing held, the same moves are possible: that is what the hold is for.
            assert.equal(attempt(target), 'renamed');
            assert.equal(attempt(folder), 'renamed');
            assert.equal(tablesOf(target), 'fresh');
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('a snapshot save to a new file gives it the folder\'s list and starts no program', async () => {
        const directory = scratch();
        try {
            icacls(directory, '/grant', '*S-1-5-32-546:(OI)(NP)(R)');
            const sibling = path.join(directory, 'sibling.db');
            fs.writeFileSync(sibling, 'x');
            const target = path.join(directory, 'new.db');

            const started = await programsStartedBy(() => snapshotSave(target));

            assert.equal(listTextOf(target), listTextOf(sibling));
            assert.ok(listTextOf(target).includes('(A;ID;FR;;;BG)'));
            assert.deepEqual(started, []);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('a paged save replaces a file with its folder\'s list and refuses one with a list of its own', async () => {
        const directory = scratch();
        try {
            icacls(directory, '/grant', '*S-1-5-32-546:(OI)(NP)(R)');
            const plain = path.join(directory, 'plain.db');
            fs.writeFileSync(plain, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
            const plainList = listTextOf(plain);

            const started = await programsStartedBy(() => writePagedWritableOverlayToFile(fs, plain, plain, pagedSnapshot(plain), undefined, () => ({ release() {} })));

            assert.deepEqual([...fs.readFileSync(plain)], [9, 8, 7, 6, 5, 6, 7, 8]);
            assert.equal(listTextOf(plain), plainList);
            assert.deepEqual(started, ['icacls.exe /save /L', 'icacls.exe /save /L']);

            const own = path.join(directory, 'own.db');
            fs.writeFileSync(own, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
            icacls(own, '/inheritance:r', '/grant:r', '*S-1-5-18:(F)', '*S-1-3-4:(F)');
            const ownList = listTextOf(own);

            await assert.rejects(
                writePagedWritableOverlayToFile(fs, own, own, pagedSnapshot(own), undefined, () => ({ release() {} })),
                /has permissions of its own, and a database opened page by page is saved by replacing its file/
            );

            assert.deepEqual([...fs.readFileSync(own)], [1, 2, 3, 4, 5, 6, 7, 8]);
            assert.equal(listTextOf(own), ownList);
            assert.deepEqual(fs.readdirSync(directory).filter(name => name.includes('.sqlite-explorer-')), []);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});

