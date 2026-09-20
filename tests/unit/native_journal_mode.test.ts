import './vscode_mock_setup';

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { it, type TestContext } from 'node:test';
import * as vscode from 'vscode';
import { createNativeDatabaseConnection } from '../../src/nativeWorker';

async function fixture(t: TestContext) {
    const platform = process.platform === 'darwin'
        ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-macos`
        : process.platform === 'linux'
            ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-linux-gnu`
            : 'x86_64-windows';
    const root = process.cwd();
    const binary = path.join(root, 'natives', platform, process.platform === 'win32' ? 'tjs.exe' : 'tjs');
    if (!fs.existsSync(binary)) {
        t.skip(`no bundled native runtime for ${process.platform}-${process.arch}`);
        return;
    }
    fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
    const directory = fs.mkdtempSync(path.join(root, '.tmp', 'native-journal-mode-'));
    const file = path.join(directory, 'test.db');
    const seed = new DatabaseSync(file);
    try {
        seed.exec('CREATE TABLE entries(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO entries VALUES(1, \'kept\');');
    } finally {
        seed.close();
    }
    const bundles: Awaited<ReturnType<typeof createNativeDatabaseConnection>>[] = [];
    t.after(() => {
        for (const bundle of bundles) bundle.workerMethods[Symbol.dispose]();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const open = async () => {
        const bundle = await createNativeDatabaseConnection(vscode.Uri.file(root));
        bundles.push(bundle);
        const { databaseOps: engine } = await bundle.establishConnection(vscode.Uri.file(file), 'test.db');
        return { engine, close: () => bundle.workerMethods[Symbol.dispose]() };
    };
    return { file, open };
}

it('restores WAL to DELETE after native bounded reads and after a normal reopen', async t => {
    const f = await fixture(t); if (!f) return;
    let connection = await f.open();
    for (let reopen = 0; reopen < 2; reopen++) {
        await connection.engine.setPragma('journal_mode', 'WAL');
        assert.equal((await connection.engine.getPragmas()).journal_mode, 'wal');
        const page = await connection.engine.fetchTableData('entries', { columns: ['id', 'value'], limit: 100, offset: 0 });
        assert.deepEqual(page.rows, [[1, 'kept']]);
        assert.deepEqual((await connection.engine.executeReadQuery('SELECT id, value FROM entries')).rows, [[1, 'kept']]);
        await connection.engine.setPragma('journal_mode', 'DELETE');
        assert.equal((await connection.engine.getPragmas()).journal_mode, 'delete');
        assert.deepEqual((await connection.engine.fetchTableData('entries', { columns: ['id', 'value'], limit: 100, offset: 0 })).rows, [[1, 'kept']]);
        connection.close();
        connection = await f.open();
        assert.equal((await connection.engine.getPragmas()).journal_mode, 'delete');
    }
    const independent = new DatabaseSync(f.file, { readOnly: true });
    try {
        assert.equal(independent.prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete');
        assert.equal(independent.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
    } finally {
        independent.close();
    }
});

it('preserves an external WAL reader and permits retry after the reader closes', async t => {
    const f = await fixture(t); if (!f) return;
    const { engine } = await f.open();
    await engine.setPragma('journal_mode', 'WAL');
    await engine.fetchTableData('entries', { columns: ['id', 'value'], limit: 100, offset: 0 });
    await engine.executeReadQuery('SELECT id, value FROM entries');
    const reader = new DatabaseSync(f.file, { readOnly: true });
    try {
        reader.exec('BEGIN');
        assert.equal(reader.prepare('SELECT value FROM entries').get()?.value, 'kept');
        await assert.rejects(engine.setPragma('journal_mode', 'DELETE'), /database is locked/);
        assert.equal(reader.prepare('SELECT value FROM entries').get()?.value, 'kept');
        assert.equal((await engine.getPragmas()).journal_mode, 'wal');
        assert.deepEqual((await engine.fetchTableData('entries', { columns: ['id', 'value'], limit: 100, offset: 0 })).rows, [[1, 'kept']]);
        assert.deepEqual((await engine.executeReadQuery('SELECT id, value FROM entries')).rows, [[1, 'kept']]);
    } finally {
        reader.close();
    }
    await engine.setPragma('journal_mode', 'DELETE');
    assert.equal((await engine.getPragmas()).journal_mode, 'delete');
});

it('refuses a journal change while an export spool owns the private reader', async t => {
    const f = await fixture(t); if (!f) return;
    const { engine } = await f.open();
    await engine.setPragma('journal_mode', 'WAL');
    const spool = '__sqlite_explorer_export_0123456789abcdef0123456789abcdef';
    await engine.executeQuery(`CREATE TEMP TABLE "${spool}" AS SELECT value FROM entries`);
    await assert.rejects(engine.setPragma('journal_mode', 'DELETE'), /export.*active|active.*export/i);
    assert.equal((await engine.getPragmas()).journal_mode, 'wal');
    assert.deepEqual((await engine.executeQuery(`SELECT CAST(rowid AS TEXT), * FROM "${spool}" WHERE rowid > ? ORDER BY rowid LIMIT 1`, [0]))[0].rows, [['1', 'kept']]);
    await engine.executeQuery(`DROP TABLE IF EXISTS temp."${spool}"`);
    await engine.setPragma('journal_mode', 'DELETE');
    assert.equal((await engine.getPragmas()).journal_mode, 'delete');
});
