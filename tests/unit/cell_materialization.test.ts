import './vscode_mock_setup';

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';

import {
    CellMaterializationService,
    type CellMaterializationOwner
} from '../../src/cellMaterialization';
import { serializeOperations } from '../../src/core/operation-serializer';
import type {
    CellMetadata,
    CellReadTarget,
    DatabaseOperations
} from '../../src/core/types';

function makeChunkedOperations(
    source: Uint8Array,
    metadata: CellMetadata,
    options: { onRead?: (readCount: number) => void } = {}
): DatabaseOperations & { closeCount: number; readSizes: number[] } {
    let readCount = 0;
    const operations = {
        closeCount: 0,
        readSizes: [] as number[],
        async executeQuery() {
            return [];
        },
        async openCellReadSession() {
            return { sessionId: 'session-1', metadata, expiresAt: Date.now() + 60_000 };
        },
        async readCellChunk(_sessionId: string, byteOffset: number, maxBytes: number) {
            readCount++;
            operations.readSizes.push(maxBytes);
            options.onRead?.(readCount);
            const bytes = source.slice(byteOffset, byteOffset + maxBytes);
            return {
                byteOffset,
                bytes,
                done: byteOffset + bytes.byteLength >= source.byteLength
            };
        },
        async closeCellReadSession() {
            operations.closeCount++;
        }
    };
    return operations as unknown as DatabaseOperations & {
        closeCount: number;
        readSizes: number[];
    };
}

describe('CellMaterializationService', () => {
    let testDir: string;
    let service: CellMaterializationService | undefined;
    const target: CellReadTarget = { table: 'cells', rowId: 1, column: 'payload' };

    beforeEach(() => {
        const parent = path.join(process.cwd(), '.tmp');
        fs.mkdirSync(parent, { recursive: true });
        testDir = fs.mkdtempSync(path.join(parent, 'cell-materialization-'));
    });

    afterEach(() => {
        service?.dispose();
        service = undefined;
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('streams split UTF-16 boundaries to a private UTF-8 file and verifies its checksum', async () => {
        const sourceText = 'A😀Bé𝄞Z';
        const source = Buffer.from(sourceText, 'utf16le');
        const operations = makeChunkedOperations(source, {
            storageClass: 'text',
            byteLength: source.byteLength,
            textEncoding: 'utf-16le'
        });
        service = new CellMaterializationService(vscode.Uri.file(testDir), {
            maxBytes: 1024,
            chunkBytes: 3
        });

        const materialized = await service.materialize(operations, target, {
            fileExtension: 'txt'
        });
        const actual = fs.readFileSync(materialized.uri.fsPath);

        assert.strictEqual(actual.toString('utf8'), sourceText);
        assert.strictEqual(materialized.byteLength, actual.byteLength);
        assert.match(materialized.checksumSha256, /^[a-f0-9]{64}$/);
        assert.strictEqual(
            materialized.checksumSha256,
            (await import('node:crypto')).createHash('sha256').update(actual).digest('hex')
        );
        assert.strictEqual(fs.statSync(materialized.uri.fsPath).mode & 0o777, 0o600);
        assert.ok(operations.readSizes.every(size => size <= 3));
        assert.strictEqual(operations.closeCount, 1);
    });

    it('removes a partial file and closes the read bracket when cancelled between chunks', async () => {
        const controller = new AbortController();
        const source = Uint8Array.from({ length: 32 }, (_, index) => index);
        const operations = makeChunkedOperations(
            source,
            { storageClass: 'blob', byteLength: source.byteLength },
            { onRead: readCount => { if (readCount === 1) controller.abort(); } }
        );
        service = new CellMaterializationService(vscode.Uri.file(testDir), {
            maxBytes: 1024,
            chunkBytes: 8
        });

        await assert.rejects(
            service.materialize(operations, target, { signal: controller.signal }),
            (error: Error) => error.name === 'AbortError'
        );
        assert.strictEqual(operations.closeCount, 1);
        assert.deepStrictEqual(fs.readdirSync(testDir), []);
    });

    it('refuses a cell above quota before creating a temp file and still closes the session', async () => {
        const source = Uint8Array.from({ length: 17 }, () => 0x42);
        const operations = makeChunkedOperations(
            source,
            { storageClass: 'blob', byteLength: source.byteLength }
        );
        service = new CellMaterializationService(vscode.Uri.file(testDir), {
            maxBytes: 16,
            chunkBytes: 4
        });

        await assert.rejects(
            service.materialize(operations, target),
            /17 bytes exceeds the 16-byte temporary-file quota/
        );
        assert.strictEqual(operations.closeCount, 1);
        assert.deepStrictEqual(fs.readdirSync(testDir), []);
    });

    it('refuses a second live materialization when the aggregate would exceed quota', async () => {
        const source = Uint8Array.from({ length: 12 }, () => 0x42);
        const firstOperations = makeChunkedOperations(
            source,
            { storageClass: 'blob', byteLength: source.byteLength }
        );
        const secondOperations = makeChunkedOperations(
            source,
            { storageClass: 'blob', byteLength: source.byteLength }
        );
        service = new CellMaterializationService(vscode.Uri.file(testDir), {
            maxBytes: 16,
            chunkBytes: 4
        });

        const first = await service.materialize(firstOperations, target);
        await assert.rejects(
            service.materialize(secondOperations, target),
            /12-byte materialization.*12 of 16 bytes.*live or in progress/i
        );

        assert.strictEqual(fs.existsSync(first.uri.fsPath), true);
        assert.strictEqual(firstOperations.closeCount, 1);
        assert.strictEqual(secondOperations.closeCount, 1);
        assert.strictEqual(
            fs.readdirSync(path.dirname(first.uri.fsPath)).length,
            1,
            'refusal must not evict or create another live file'
        );
    });

    it('releases aggregate quota when the materialized cell document closes', async () => {
        const source = Uint8Array.from({ length: 12 }, () => 0x24);
        const operations = makeChunkedOperations(
            source,
            { storageClass: 'blob', byteLength: source.byteLength }
        );
        service = new CellMaterializationService(vscode.Uri.file(testDir), {
            maxBytes: 16,
            chunkBytes: 4
        });

        const first = await service.materialize(operations, target);
        (vscode.workspace as any).__fireDidCloseTextDocument({ uri: first.uri });
        const replacement = await service.materialize(operations, target);

        assert.strictEqual(fs.existsSync(first.uri.fsPath), false);
        assert.strictEqual(fs.existsSync(replacement.uri.fsPath), true);
    });

    it('reserves aggregate quota across concurrent materializations', async () => {
        const source = Uint8Array.from({ length: 12 }, () => 0x7a);
        const firstOperations = makeChunkedOperations(
            source,
            { storageClass: 'blob', byteLength: source.byteLength }
        );
        const secondOperations = makeChunkedOperations(
            source,
            { storageClass: 'blob', byteLength: source.byteLength }
        );
        const originalRead = firstOperations.readCellChunk.bind(firstOperations);
        let markReadStarted!: () => void;
        let allowRead!: () => void;
        const readStarted = new Promise<void>(resolve => { markReadStarted = resolve; });
        const readAllowed = new Promise<void>(resolve => { allowRead = resolve; });
        firstOperations.readCellChunk = async (...args: Parameters<DatabaseOperations['readCellChunk']>) => {
            markReadStarted();
            await readAllowed;
            return originalRead(...args);
        };
        service = new CellMaterializationService(vscode.Uri.file(testDir), {
            maxBytes: 16,
            chunkBytes: 4
        });

        const firstPromise = service.materialize(firstOperations, target);
        await readStarted;
        try {
            await assert.rejects(
                service.materialize(secondOperations, target),
                /already live or in progress/i
            );
        } finally {
            allowRead();
        }
        const first = await firstPromise;
        assert.strictEqual(fs.existsSync(first.uri.fsPath), true);
    });

    it('holds one serializer lease until the materialization read session closes', async () => {
        const source = Uint8Array.from({ length: 8 }, (_, index) => index);
        const operations = makeChunkedOperations(
            source,
            { storageClass: 'blob', byteLength: source.byteLength }
        );
        const events: string[] = [];
        let sessionActive = false;
        const originalOpen = operations.openCellReadSession.bind(operations);
        operations.openCellReadSession = async target => {
            sessionActive = true;
            events.push('open');
            return originalOpen(target);
        };
        const originalClose = operations.closeCellReadSession.bind(operations);
        operations.closeCellReadSession = async sessionId => {
            events.push('close');
            sessionActive = false;
            return originalClose(sessionId);
        };

        let markReadStarted!: () => void;
        let allowRead!: () => void;
        const readStarted = new Promise<void>(resolve => { markReadStarted = resolve; });
        const readAllowed = new Promise<void>(resolve => { allowRead = resolve; });
        const originalRead = operations.readCellChunk.bind(operations);
        let firstRead = true;
        operations.readCellChunk = async (...args) => {
            if (firstRead) {
                firstRead = false;
                markReadStarted();
                await readAllowed;
            }
            return originalRead(...args);
        };
        operations.updateCell = async () => {
            events.push('update');
            if (sessionActive) throw new Error('active cell read session');
        };
        const serialized = serializeOperations(operations);
        service = new CellMaterializationService(vscode.Uri.file(testDir), {
            maxBytes: 32,
            chunkBytes: 4
        });

        const materialization = service.materialize(serialized, target);
        await readStarted;
        const update = serialized.updateCell('cells', 1, 'payload', 'changed').then(
            () => 'updated',
            error => `failed: ${String(error)}`
        );
        await new Promise(resolve => setImmediate(resolve));
        allowRead();

        const [materialized, updateStatus] = await Promise.all([materialization, update]);
        assert.strictEqual(fs.existsSync(materialized.uri.fsPath), true);
        assert.strictEqual(updateStatus, 'updated');
        assert.ok(events.indexOf('close') < events.indexOf('update'));
    });

    it('cancels an in-flight materialization cleanly when the service is disposed', async () => {
        const source = Uint8Array.from({ length: 12 }, () => 0x5a);
        const operations = makeChunkedOperations(
            source,
            { storageClass: 'blob', byteLength: source.byteLength }
        );
        const originalRead = operations.readCellChunk.bind(operations);
        let markReadStarted!: () => void;
        let allowRead!: () => void;
        const readStarted = new Promise<void>(resolve => { markReadStarted = resolve; });
        const readAllowed = new Promise<void>(resolve => { allowRead = resolve; });
        operations.readCellChunk = async (...args: Parameters<DatabaseOperations['readCellChunk']>) => {
            markReadStarted();
            await readAllowed;
            return originalRead(...args);
        };
        service = new CellMaterializationService(vscode.Uri.file(testDir), {
            maxBytes: 16,
            chunkBytes: 4
        });

        const materialization = service.materialize(operations, target);
        await readStarted;
        service.dispose();
        allowRead();

        await assert.rejects(
            materialization,
            (error: Error) => {
                assert.match(error.message, /Cell materialization service is disposed/);
                assert.doesNotMatch(error.message, /quota accounting became inconsistent/);
                return true;
            }
        );
        assert.strictEqual(operations.closeCount, 1);
        assert.deepStrictEqual(fs.readdirSync(testDir), []);
    });

    it('disposes files on editor close, database document close, and service disposal', async () => {
        const source = Uint8Array.from([1, 2, 3, 4]);
        const operations = makeChunkedOperations(
            source,
            { storageClass: 'blob', byteLength: source.byteLength }
        );
        service = new CellMaterializationService(vscode.Uri.file(testDir), { maxBytes: 1024 });

        const editorFile = await service.materialize(operations, target);
        (vscode.workspace as any).__fireDidCloseTextDocument({ uri: editorFile.uri });
        assert.strictEqual(fs.existsSync(editorFile.uri.fsPath), false, 'editor close cleanup');

        const disposeEmitter = new vscode.EventEmitter<void>();
        const owner: CellMaterializationOwner = { onDidDispose: disposeEmitter.event };
        const ownedFile = await service.materialize(operations, target, { owner });
        disposeEmitter.fire();
        assert.strictEqual(fs.existsSync(ownedFile.uri.fsPath), false, 'document close cleanup');

        const deactivationFile = await service.materialize(operations, target);
        service.dispose();
        assert.strictEqual(
            fs.existsSync(deactivationFile.uri.fsPath),
            false,
            'extension deactivation cleanup'
        );
    });
});
