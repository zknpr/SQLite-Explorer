import './vscode_mock_setup';

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { it } from 'node:test';
import * as vscode from 'vscode';

import { HostBridge } from '../../src/hostBridge';
import { WebviewMessageHandler } from '../../src/webviewMessageHandler';
import { createNativeDatabaseConnection, isNativeAvailable } from '../../src/nativeWorker';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import type { DatabaseOperations, ModificationEntry } from '../../src/core/types';

for (const backend of ['native', 'wasm'] as const) {
    it(`${backend} mixed batch completes the JSON webview reply without exposing exact history`, { timeout: 30_000 }, async t => {
        const root = process.cwd();
        if (backend === 'native' && !(await isNativeAvailable(root))) {
            t.skip(`no bundled native runtime for ${process.platform}-${process.arch}`);
            return;
        }
        fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
        const directory = fs.mkdtempSync(path.join(root, '.tmp', 'batch-webview-transport-'));
        const uri = vscode.Uri.file(path.join(directory, 'batch.db'));
        let bundle: Awaited<ReturnType<typeof createNativeDatabaseConnection>> | undefined;
        let wasm: WasmDatabaseEngine | undefined;
        try {
            let operations: DatabaseOperations;
            if (backend === 'native') {
                fs.closeSync(fs.openSync(uri.fsPath, 'w'));
                bundle = await createNativeDatabaseConnection(vscode.Uri.file(root));
                operations = (await bundle.establishConnection(uri, 'batch.db')).databaseOps;
            } else {
                wasm = (await createDatabaseEngine({ content: null, maxSize: 0 })).operations as WasmDatabaseEngine;
                operations = wasm;
            }
            await operations.executeQuery(
                'CREATE TABLE reply_values(id INTEGER PRIMARY KEY, value INTEGER, label TEXT); ' +
                "INSERT INTO reply_values VALUES(1, 9223372036854775807, 'before'), (2, 7, 'other')"
            );
            const history: ModificationEntry[] = [];
            const bridge = new HostBridge(
                { webviews: new Map(), context: {} } as unknown as ConstructorParameters<typeof HostBridge>[0],
                {
                    uri,
                    documentKey: Promise.resolve('batch-wire'),
                    databaseOperations: operations,
                    isReadOnlyMode: false,
                    connectionGeneration: 1,
                    recordExternalModification: (entry: ModificationEntry) => history.push(entry)
                } as unknown as ConstructorParameters<typeof HostBridge>[1]
            );
            let delivered!: (message: unknown) => void;
            const response = new Promise<unknown>(resolve => { delivered = resolve; });
            const handler = new WebviewMessageHandler(async message => {
                // VS Code's webview channel serializes JSON, unlike the worker's
                // structured-clone channel. Exercise that final boundary too.
                delivered(JSON.parse(JSON.stringify(message)));
                return true;
            }, bridge);
            handler.handleMessage({
                channel: 'rpc',
                content: {
                    kind: 'invoke', messageId: 'mixed-batch', targetMethod: 'updateCellBatch',
                    payload: ['reply_values', [
                        { rowId: 1, column: 'value', value: 9 },
                        { rowId: 1, column: 'label', value: 'after' },
                        { rowId: 2, column: 'value', value: null }
                    ], 'Mixed batch']
                }
            });
            const message = await response as {
                content: { success: boolean; data: unknown[]; errorMessage?: string };
            };
            assert.equal(message.content.success, true, message.content.errorMessage ?? 'batch reply must succeed');
            assert.deepEqual(message.content.data, [
                { rowId: 1, columnName: 'value' },
                { rowId: 1, columnName: 'label' },
                { rowId: 2, columnName: 'value' }
            ]);
            assert.equal(history.length, 1);
            assert.equal(history[0].affectedCells?.[0].priorValue, 9223372036854775807n);
            const rows = async () => (await operations.executeQuery(
                'SELECT id, CAST(value AS TEXT), label FROM reply_values ORDER BY id'
            ))[0].rows;
            assert.deepEqual(await rows(), [[1, '9', 'after'], [2, null, 'other']]);
            await operations.undoModification(history[0]);
            assert.deepEqual(await rows(), [[1, '9223372036854775807', 'before'], [2, '7', 'other']]);
            await operations.redoModification(history[0]);
            assert.deepEqual(await rows(), [[1, '9', 'after'], [2, null, 'other']]);
        } finally {
            bundle?.workerMethods[Symbol.dispose]();
            wasm?.shutdown();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
}
