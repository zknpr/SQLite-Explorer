import './vscode_mock_setup'; // Must be first

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import * as vscode from 'vscode';

import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { createNativeDatabaseConnection, isNativeAvailable } from '../../src/nativeWorker';
import { streamTableExport } from '../../src/tableExportStreaming';
import type { DatabaseOperations, ExportOptions } from '../../src/core/types';

// Opening a view in the grid, counting it or exporting it must leave the
// file's bytes unchanged. The views cover a scalar subquery (not evaluated
// by a count) and a join (evaluated by one).
const FIXTURE = [
    'CREATE TABLE analyzed (id INTEGER PRIMARY KEY, label TEXT)',
    'CREATE INDEX analyzed_label ON analyzed(label)',
    'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 200) ' +
        "INSERT INTO analyzed(label) SELECT 'label' || (x % 7) FROM n",
    'CREATE VIEW in_subquery AS SELECT id, label, (SELECT count(*) FROM pragma_optimize(0x10002)) AS n FROM analyzed',
    'CREATE VIEW in_join AS SELECT a.id, a.label FROM analyzed a LEFT JOIN pragma_optimize(0x10002) ON 1'
];
const VIEWS: Array<[string, string[]]> = [['in_subquery', ['id', 'label', 'n']], ['in_join', ['id', 'label']]];

type Read = [string, (ops: DatabaseOperations, view: string, columns: string[]) => Promise<unknown>];
const READS: Read[] = [
    ['grid page', (ops, view) => ops.fetchTableData(view, { limit: 100, offset: 0 })],
    ['filtered grid page', (ops, view) => ops.fetchTableData(view, { limit: 100, offset: 0, globalFilter: 'label1' })],
    ['sorted grid page', (ops, view) => ops.fetchTableData(view, { limit: 100, offset: 0, orderBy: 'label', orderDir: 'DESC' })],
    ['count', (ops, view) => ops.fetchTableCount(view, {})],
    ['filtered count', (ops, view) => ops.fetchTableCount(view, { globalFilter: 'label1' })],
    ['generic SELECT', (ops, view) => ops.executeQuery(`SELECT * FROM "${view}"`)],
    ['generic WITH', (ops, view) => ops.executeQuery(`WITH w AS (SELECT * FROM "${view}") SELECT * FROM w`)],
    ['view preview', (ops, view) => ops.previewViewDefinition('preview', `SELECT * FROM "${view}"`, 10, 'create')],
    ['export', async (ops, view, columns) => {
        await streamTableExport(
            ops, view, columns,
            { format: 'csv', includeTableName: false, header: true } as ExportOptions,
            { write: async () => {} }
        );
    }],
    ['query read session', async (ops, view) => {
        if (!ops.openQueryReadSession) return;
        const session = await ops.openQueryReadSession(`SELECT * FROM "${view}"`);
        try {
            await ops.readQueryRows!(session.sessionId, 100);
        } finally {
            await ops.closeQueryReadSession!(session.sessionId);
        }
    }]
];

const directories: string[] = [];
after(() => {
    for (const directory of directories) {
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

const analyzed = async (ops: DatabaseOperations) => Number(
    (await ops.executeQuery("SELECT count(*) FROM sqlite_schema WHERE name = 'sqlite_stat1'"))[0].rows[0][0]
);

async function fixtureImage(): Promise<Uint8Array> {
    const seed = (await createDatabaseEngine({ content: null, maxSize: 0, readOnlyMode: false })).operations as WasmDatabaseEngine;
    try {
        for (const sql of FIXTURE) await seed.executeQuery(sql);
        return await seed.serializeDatabase();
    } finally {
        seed.shutdown();
    }
}

describe('reading a view leaves the database unchanged', () => {
    it('on the WebAssembly engine', async () => {
        const image = await fixtureImage();
        const open = async () => (await createDatabaseEngine({
            content: new Uint8Array(image), maxSize: 0, readOnlyMode: false
        })).operations as WasmDatabaseEngine;

        // Control: the oracle sees the write these views would make.
        const control = await open();
        try {
            await control.executeQuery('PRAGMA optimize = 0x10002');
            assert.equal(await analyzed(control), 1);
            assert.notDeepEqual(await control.serializeDatabase(), image);
        } finally {
            control.shutdown();
        }

        for (const [view, columns] of VIEWS) {
            for (const [name, read] of READS) {
                // A fresh connection: it has no analysis state from earlier reads.
                const engine = await open();
                try {
                    await read(engine, view, columns).catch(error => {
                        assert.match(String(error), /readonly database/, `${view}: ${name}`);
                    });
                    assert.equal(await analyzed(engine), 0, `${view}: ${name}`);
                    // A preview commits its own schema check on this engine, which
                    // moves the header's change counter for any view body.
                    if (name !== 'view preview') {
                        assert.deepEqual(await engine.serializeDatabase(), image, `${view}: ${name}`);
                    }
                    await engine.updateCell('analyzed', 1, 'label', 'edited');
                } finally {
                    engine.shutdown();
                }
            }
        }
    });

    it('through the bundled native worker', async (context) => {
        if (!await isNativeAvailable(process.cwd())) {
            if (process.env.FUZZ_EXPECT_TARGET) throw new Error(`Missing native runtime for ${process.env.FUZZ_EXPECT_TARGET}`);
            return context.skip('Bundled native runtime unavailable');
        }
        const image = Buffer.from(await fixtureImage());
        fs.mkdirSync('.tmp', { recursive: true });
        const directory = fs.mkdtempSync(path.resolve('.tmp/view-read-bytes-'));
        directories.push(directory);
        const file = path.join(directory, 'views.db');
        const onDisk = () => Buffer.concat([file, `${file}-wal`, `${file}-journal`].map(name => (
            fs.existsSync(name) ? fs.readFileSync(name) : Buffer.alloc(0)
        )));
        const native = await createNativeDatabaseConnection(vscode.Uri.file(process.cwd()));
        context.after(() => native.workerMethods[Symbol.dispose]());
        // Reopening forgets the connection's analysis state.
        const open = async () => {
            fs.writeFileSync(file, image);
            return (await native.establishConnection(vscode.Uri.file(file), 'views.db', false)).databaseOps;
        };

        const control = await open();
        await control.executeQuery('PRAGMA optimize = 0x10002');
        assert.equal(await analyzed(control), 1);
        assert.equal(onDisk().equals(image), false);

        for (const [view, columns] of VIEWS) {
            for (const [name, read] of READS) {
                const ops = await open();
                await read(ops, view, columns).catch(error => {
                    assert.match(String(error), /readonly database/, `${view}: ${name}`);
                });
                assert.equal(await analyzed(ops), 0, `${view}: ${name}`);
                assert.equal(onDisk().equals(image), true, `${view}: ${name}`);
            }
        }
        const ops = await open();
        await ops.fetchTableData('in_join', { limit: 10, offset: 0 }).catch(() => undefined);
        await ops.updateCell('analyzed', 1, 'label', 'edited');
        assert.equal((await ops.executeQuery('SELECT label FROM analyzed WHERE id = 1'))[0].rows[0][0], 'edited');
    });
});
