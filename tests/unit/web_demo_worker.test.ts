import './vscode_mock_setup';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import initSqlJs from 'sql.js';

interface WorkerHarness {
    invoke(method: string, ...payload: unknown[]): Promise<any>;
}

async function createWorkerHarness(): Promise<WorkerHarness> {
    const source = readFileSync(
        path.resolve(process.cwd(), 'website/public/sqlite-viewer/worker.js'),
        'utf8'
    );
    const responses: any[] = [];
    const workerGlobal: any = {
        initSqlJs,
        postMessage(message: unknown) {
            responses.push(message);
        }
    };
    const context = vm.createContext({
        self: workerGlobal,
        importScripts() {},
        console: { log() {}, warn() {}, error() {} },
        Uint8Array,
        ArrayBuffer,
        DataView,
        crypto: webcrypto,
        TextEncoder,
        TextDecoder,
        setTimeout,
        clearTimeout
    });
    new vm.Script(source, { filename: 'website/public/sqlite-viewer/worker.js' })
        .runInContext(context);

    let messageId = 0;
    const invoke = async (method: string, ...payload: unknown[]) => {
        const id = `test_${++messageId}`;
        await workerGlobal.onmessage({
            data: {
                channel: 'rpc',
                content: {
                    kind: 'invoke',
                    messageId: id,
                    targetMethod: method,
                    payload
                }
            }
        });
        const responseIndex = responses.findIndex(message => message.content?.messageId === id);
        assert.notStrictEqual(responseIndex, -1, `worker did not respond to ${method}`);
        const [response] = responses.splice(responseIndex, 1);
        if (!response.content.success) {
            throw new Error(response.content.errorMessage);
        }
        return response.content.data;
    };

    const wasmBinary = new Uint8Array(readFileSync(
        path.resolve(process.cwd(), 'assets/sqlite3.wasm')
    ));
    await invoke('initializeDatabase', 'test.db', { content: null, wasmBinary });
    return { invoke };
}

async function workerScalar(worker: WorkerHarness, sql: string): Promise<unknown> {
    const result = await worker.invoke('runQuery', sql);
    return result[0]?.rows?.[0]?.[0];
}

describe('web demo view worker', () => {
    it('does not execute a trailing statement smuggled through preview', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE TABLE preview_sentinel (id INTEGER)');

        await assert.rejects(() => worker.invoke(
            'previewViewDefinition',
            'unsafe_preview',
            'SELECT 1) LIMIT 1; DROP TABLE preview_sentinel; --',
            10
        ));

        assert.strictEqual(await workerScalar(
            worker,
            "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = 'preview_sentinel'"
        ), 1);
    });

    it('preserves duplicate explicit columns through an edit', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE VIEW duplicate_names (a, a) AS SELECT 1, 2');

        await worker.invoke('editView', 'duplicate_names', 'SELECT 3, 4', true);

        const storedSql = await workerScalar(
            worker,
            "SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = 'duplicate_names'"
        );
        assert.match(String(storedSql), /\(a, a\)/);
        assert.doesNotMatch(String(storedSql), /a:1/);
    });

    it('recreates same-event triggers in schema order', async () => {
        const worker = await createWorkerHarness();
        await worker.invoke('runQuery', 'CREATE TABLE trigger_log (label TEXT)');
        await worker.invoke('runQuery', 'CREATE VIEW trigger_order AS SELECT 1 AS value');
        await worker.invoke(
            'runQuery',
            "CREATE TRIGGER z_created_first INSTEAD OF INSERT ON trigger_order BEGIN INSERT INTO trigger_log VALUES ('z'); END"
        );
        await worker.invoke(
            'runQuery',
            "CREATE TRIGGER a_created_second INSTEAD OF INSERT ON trigger_order BEGIN INSERT INTO trigger_log VALUES ('a'); END"
        );

        const before = await worker.invoke('getViewDefinition', 'trigger_order');
        assert.deepStrictEqual(
            Array.from(before.triggers, (trigger: any) => trigger.identifier),
            ['z_created_first', 'a_created_second']
        );

        await worker.invoke('runQuery', 'INSERT INTO trigger_order VALUES (1)');
        const originalOrder = await worker.invoke('runQuery', 'SELECT label FROM trigger_log ORDER BY rowid');
        await worker.invoke('runQuery', 'DELETE FROM trigger_log');
        await worker.invoke('editView', 'trigger_order', 'SELECT 2 AS value', true);
        await worker.invoke('runQuery', 'INSERT INTO trigger_order VALUES (2)');
        const recreatedOrder = await worker.invoke('runQuery', 'SELECT label FROM trigger_log ORDER BY rowid');

        assert.deepStrictEqual(
            Array.from(recreatedOrder[0].rows, (row: unknown[]) => Array.from(row)),
            Array.from(originalOrder[0].rows, (row: unknown[]) => Array.from(row))
        );
    });
});
