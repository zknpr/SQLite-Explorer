import './vscode_mock_setup';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import { MAX_CELL_READ_CHUNK_BYTES } from '../../src/core/cell-read';
import type { DatabaseOperations } from '../../src/core/types';

const activeEngines: WasmDatabaseEngine[] = [];

async function createEngine(options: {
    idleTimeoutMs?: number;
    absoluteTimeoutMs?: number;
} = {}): Promise<DatabaseOperations> {
    const result = await createDatabaseEngine({
        content: null,
        maxSize: 0,
        readOnlyMode: false,
        cellReadSessionIdleTimeoutMs: options.idleTimeoutMs,
        cellReadSessionAbsoluteTimeoutMs: options.absoluteTimeoutMs
    });
    const engine = result.operations as WasmDatabaseEngine;
    activeEngines.push(engine);
    return engine;
}

afterEach(() => {
    while (activeEngines.length > 0) activeEngines.pop()!.shutdown();
});

describe('bounded cell read sessions', () => {
    it('reassembles UTF-8 text from byte windows split inside multibyte code points', async () => {
        const engine = await createEngine();
        const text = 'A😀Bé𝄞Z';
        const expectedBytes = new TextEncoder().encode(text);
        await engine.executeQuery('CREATE TABLE cells (payload TEXT)');
        await engine.executeQuery('INSERT INTO cells VALUES (?)', [text]);

        const target = { table: 'cells', rowId: 1, column: 'payload' };
        assert.deepStrictEqual(await engine.getCellMetadata(target), {
            storageClass: 'text',
            byteLength: expectedBytes.byteLength,
            textEncoding: 'utf-8'
        });

        const session = await engine.openCellReadSession(target);
        const pieces: Uint8Array[] = [];
        let byteOffset = 0;
        while (byteOffset < session.metadata.byteLength) {
            const chunk = await engine.readCellChunk(session.sessionId, byteOffset, 2);
            assert.strictEqual(chunk.byteOffset, byteOffset);
            assert.ok(chunk.bytes.byteLength <= 2);
            pieces.push(chunk.bytes);
            byteOffset += chunk.bytes.byteLength;
            assert.strictEqual(chunk.done, byteOffset === session.metadata.byteLength);
        }
        await engine.closeCellReadSession(session.sessionId);

        const assembled = new Uint8Array(expectedBytes.byteLength);
        let writeOffset = 0;
        for (const piece of pieces) {
            assembled.set(piece, writeOffset);
            writeOffset += piece.byteLength;
        }
        assert.deepStrictEqual(assembled, expectedBytes);
        assert.strictEqual(new TextDecoder('utf-8', { fatal: true }).decode(assembled), text);
    });

    it('keeps one snapshot and refuses a same-connection update until close', async () => {
        const engine = await createEngine();
        await engine.executeQuery('CREATE TABLE cells (payload BLOB)');
        await engine.executeQuery("INSERT INTO cells VALUES (x'4141414142424242')");

        const target = { table: 'cells', rowId: 1, column: 'payload' };
        const session = await engine.openCellReadSession(target);
        await assert.rejects(
            engine.openCellReadSession(target),
            /cell read session is active/i
        );
        const first = await engine.readCellChunk(session.sessionId, 0, 4);
        assert.deepStrictEqual(first.bytes, new Uint8Array([65, 65, 65, 65]));

        await assert.rejects(
            engine.updateCell(
                'cells',
                1,
                'payload',
                new Uint8Array([67, 67, 67, 67, 68, 68, 68, 68])
            ),
            /cell read session is active/i
        );
        const second = await engine.readCellChunk(session.sessionId, 4, 4);
        assert.deepStrictEqual(second.bytes, new Uint8Array([66, 66, 66, 66]));

        await engine.closeCellReadSession(session.sessionId);
        await engine.updateCell(
            'cells',
            1,
            'payload',
            new Uint8Array([67, 67, 67, 67, 68, 68, 68, 68])
        );
        const current = await engine.executeQuery('SELECT payload FROM cells');
        assert.deepStrictEqual(
            current[0].rows[0][0],
            new Uint8Array([67, 67, 67, 67, 68, 68, 68, 68])
        );
    });

    it('rejects missing cells and unbounded or invalid chunk windows', async () => {
        const engine = await createEngine();
        await engine.executeQuery('CREATE TABLE cells (payload BLOB)');
        await engine.executeQuery("INSERT INTO cells VALUES (x'00010203')");

        await assert.rejects(
            engine.getCellMetadata({ table: 'cells', rowId: 2, column: 'payload' }),
            /no longer exists/i
        );
        const session = await engine.openCellReadSession({
            table: 'cells',
            rowId: 1,
            column: 'payload'
        });
        await assert.rejects(
            engine.readCellChunk(session.sessionId, -1, 1),
            /byte offset/i
        );
        await assert.rejects(
            engine.readCellChunk(session.sessionId, 0, MAX_CELL_READ_CHUNK_BYTES + 1),
            /chunk size/i
        );
        await engine.closeCellReadSession(session.sessionId);
    });

    it('auto-expires a leaked session and releases its savepoint bracket', async () => {
        const engine = await createEngine({ idleTimeoutMs: 20, absoluteTimeoutMs: 100 });
        await engine.executeQuery('CREATE TABLE cells (payload TEXT)');
        await engine.executeQuery("INSERT INTO cells VALUES ('before')");
        const session = await engine.openCellReadSession({
            table: 'cells',
            rowId: 1,
            column: 'payload'
        });

        await new Promise(resolve => setTimeout(resolve, 50));
        await assert.rejects(
            engine.readCellChunk(session.sessionId, 0, 1),
            /expired|not found/i
        );
        await engine.updateCell('cells', 1, 'payload', 'after');
        const current = await engine.executeQuery('SELECT payload FROM cells');
        assert.strictEqual(current[0].rows[0][0], 'after');
    });
});
