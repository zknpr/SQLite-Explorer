import * as vsc from 'vscode';

import { crypto as webCrypto } from './platform/cryptoShim';
import { MAX_CELL_READ_CHUNK_BYTES } from './core/cell-read';
import { runReadSnapshot } from './core/operation-serializer';
import type {
    CellMetadata,
    CellReadTarget,
    DatabaseOperations
} from './core/types';

type NodeFs = typeof import('node:fs');
type NodeCrypto = typeof import('node:crypto');

/**
 * The quota is intentionally above the 256 MiB containment lane while still
 * preventing an accidental multi-gigabyte cell from consuming the extension's
 * storage. It is a Stage B constant, not a user-facing setting.
 */
export const DEFAULT_CELL_MATERIALIZATION_QUOTA_BYTES = 512 * 1024 * 1024;
export const DEFAULT_CELL_MATERIALIZATION_CHUNK_BYTES = MAX_CELL_READ_CHUNK_BYTES;

export interface CellMaterializationOwner {
    onDidDispose(listener: () => void): vsc.Disposable;
}

export interface MaterializedCell {
    uri: vsc.Uri;
    metadata: CellMetadata;
    /** Bytes in the materialized file; TEXT is normalized to UTF-8. */
    byteLength: number;
    checksumSha256: string;
}

export interface CellMaterializationServiceOptions {
    maxBytes?: number;
    chunkBytes?: number;
}

export interface MaterializeCellOptions {
    signal?: AbortSignal;
    fileExtension?: string;
    owner?: CellMaterializationOwner;
}

function requireNodeModules(): { fs: NodeFs; crypto: NodeCrypto } {
    if (import.meta.env?.VSCODE_BROWSER_EXT) {
        throw new Error('Full oversized-cell materialization is available only in VS Code Desktop');
    }
    return {
        fs: require('fs') as NodeFs,
        crypto: require('crypto') as NodeCrypto
    };
}

function abortError(): Error {
    const error = new Error('Cell materialization cancelled');
    error.name = 'AbortError';
    return error;
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw abortError();
}

function checkedPositiveInteger(value: number | undefined, fallback: number, label: string): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < 1) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return resolved;
}

function safeExtension(extension: string | undefined, metadata: CellMetadata): string {
    const fallback = metadata.storageClass === 'text' ? 'txt' : 'bin';
    if (!extension) return fallback;
    const normalized = extension.replace(/^\./, '');
    return /^[a-z0-9]{1,12}$/i.test(normalized) ? normalized.toLowerCase() : fallback;
}

/**
 * Pulls one snapshot session into a private file without ever assembling the
 * complete cell in JavaScript memory.
 */
export class CellMaterializationService implements vsc.Disposable {
    private readonly maxBytes: number;
    private readonly chunkBytes: number;
    private readonly trackedFiles = new Map<string, MaterializedCell>();
    private readonly ownerFiles = new Map<CellMaterializationOwner, Set<string>>();
    private readonly ownerSubscriptions = new Map<CellMaterializationOwner, vsc.Disposable>();
    private readonly closeDocumentSubscription: vsc.Disposable | undefined;
    /** Disk bytes held by live files plus reservations for in-progress writes. */
    private allocatedBytes = 0;
    private runDirectory: string | undefined;
    private disposed = false;

    constructor(
        private readonly storageRoot: vsc.Uri,
        options: CellMaterializationServiceOptions = {}
    ) {
        this.maxBytes = checkedPositiveInteger(
            options.maxBytes,
            DEFAULT_CELL_MATERIALIZATION_QUOTA_BYTES,
            'Cell materialization quota'
        );
        this.chunkBytes = checkedPositiveInteger(
            options.chunkBytes,
            DEFAULT_CELL_MATERIALIZATION_CHUNK_BYTES,
            'Cell materialization chunk size'
        );
        if (this.chunkBytes > MAX_CELL_READ_CHUNK_BYTES) {
            throw new Error(
                `Cell materialization chunk size cannot exceed ${MAX_CELL_READ_CHUNK_BYTES}`
            );
        }

        const onDidCloseTextDocument = vsc.workspace.onDidCloseTextDocument;
        this.closeDocumentSubscription = typeof onDidCloseTextDocument === 'function'
            ? onDidCloseTextDocument(document => this.release(document.uri))
            : undefined;
    }

    async materialize(
        operations: DatabaseOperations,
        target: CellReadTarget,
        options: MaterializeCellOptions = {}
    ): Promise<MaterializedCell> {
        this.assertActive(options.signal);
        let completed: MaterializedCell | undefined;
        try {
            return await runReadSnapshot(operations, async leasedOperations => {
                completed = await this.materializeWithinLease(
                    leasedOperations,
                    target,
                    options
                );
                return completed;
            });
        } catch (primaryError) {
            if (completed) {
                try {
                    this.release(completed.uri);
                } catch (cleanupError) {
                    throw new AggregateError(
                        [primaryError, cleanupError],
                        'Cell materialization failed and its completed temp file could not be removed'
                    );
                }
            }
            throw primaryError;
        }
    }

    private async materializeWithinLease(
        operations: DatabaseOperations,
        target: CellReadTarget,
        options: MaterializeCellOptions
    ): Promise<MaterializedCell> {
        this.assertActive(options.signal);

        let session: Awaited<ReturnType<DatabaseOperations['openCellReadSession']>> | undefined;
        let filePath: string | undefined;
        let fileHandle: import('node:fs/promises').FileHandle | undefined;
        let reservedBytes = 0;
        let sessionClosed = false;
        let primaryError: unknown;
        try {
            session = await operations.openCellReadSession(target);
            this.assertActive(options.signal);
            const { metadata } = session;
            if (metadata.byteLength > this.maxBytes) {
                throw new Error(
                    `${metadata.byteLength} bytes exceeds the ${this.maxBytes}-byte ` +
                    'temporary-file quota; export the cell with an explicit destination instead'
                );
            }
            this.reserveBytes(metadata.byteLength);
            reservedBytes = metadata.byteLength;

            this.assertActive(options.signal);
            const { fs, crypto } = requireNodeModules();
            const runDirectory = this.ensureRunDirectory(fs);
            const extension = safeExtension(options.fileExtension, metadata);
            filePath = (require('path') as typeof import('node:path')).join(
                runDirectory,
                `${webCrypto.randomUUID()}.${extension}`
            );
            fileHandle = await fs.promises.open(filePath, 'wx', 0o600);
            this.assertActive(options.signal);
            await fileHandle.chmod(0o600);
            this.assertActive(options.signal);

            const outputHash = crypto.createHash('sha256');
            const decoder = metadata.storageClass === 'text'
                ? new TextDecoder(this.requireTextEncoding(metadata), { fatal: true })
                : undefined;
            const encoder = decoder ? new TextEncoder() : undefined;
            let sourceOffset = 0;
            let outputBytes = 0;

            while (sourceOffset < metadata.byteLength) {
                this.assertActive(options.signal);
                const requestedBytes = Math.min(
                    this.chunkBytes,
                    metadata.byteLength - sourceOffset
                );
                const chunk = await operations.readCellChunk(
                    session.sessionId,
                    sourceOffset,
                    requestedBytes
                );
                this.assertActive(options.signal);
                this.validateChunk(chunk, sourceOffset, requestedBytes, metadata.byteLength);

                const output = decoder && encoder
                    ? encoder.encode(decoder.decode(chunk.bytes, { stream: true }))
                    : chunk.bytes;
                outputBytes = this.checkedOutputSize(outputBytes, output.byteLength);
                reservedBytes = this.ensureOutputReservation(reservedBytes, outputBytes);
                await this.writeFully(fileHandle, output, options.signal);
                outputHash.update(output);
                sourceOffset += chunk.bytes.byteLength;
            }

            if (decoder && encoder) {
                const finalBytes = encoder.encode(decoder.decode());
                outputBytes = this.checkedOutputSize(outputBytes, finalBytes.byteLength);
                reservedBytes = this.ensureOutputReservation(reservedBytes, outputBytes);
                await this.writeFully(fileHandle, finalBytes, options.signal);
                outputHash.update(finalBytes);
            }
            this.assertActive(options.signal);
            await fileHandle.sync();
            this.assertActive(options.signal);
            await fileHandle.close();
            fileHandle = undefined;
            this.assertActive(options.signal);

            const assembledChecksum = outputHash.digest('hex');
            const verified = await this.verifyFile(fs, crypto, filePath, options.signal);
            if (verified.byteLength !== outputBytes || verified.checksum !== assembledChecksum) {
                throw new Error('Materialized cell checksum verification failed');
            }

            await operations.closeCellReadSession(session.sessionId);
            sessionClosed = true;
            this.assertActive(options.signal);
            const materialized: MaterializedCell = {
                uri: vsc.Uri.file(filePath),
                metadata,
                byteLength: outputBytes,
                checksumSha256: assembledChecksum
            };
            this.releaseReservedBytes(reservedBytes - outputBytes);
            reservedBytes = outputBytes;
            this.track(materialized, options.owner);
            // The reservation is now owned by the tracked file and released
            // only after release() removes that file from disk.
            reservedBytes = 0;
            return materialized;
        } catch (error) {
            primaryError = this.disposed
                ? new Error('Cell materialization service is disposed', { cause: error })
                : error;
            if (fileHandle) {
                try {
                    await fileHandle.close();
                } catch (closeError) {
                    primaryError = new AggregateError(
                        [primaryError, closeError],
                        'Cell materialization and temp-file close both failed'
                    );
                }
            }
            if (filePath) {
                try {
                    requireNodeModules().fs.rmSync(filePath, { force: true });
                    this.releaseReservedBytes(reservedBytes);
                    reservedBytes = 0;
                } catch (cleanupError) {
                    primaryError = new AggregateError(
                        [primaryError, cleanupError],
                        'Cell materialization failed and its partial temp file could not be removed'
                    );
                }
            } else {
                this.releaseReservedBytes(reservedBytes);
                reservedBytes = 0;
            }
            this.pruneEmptyRunDirectory();
            if (session && !sessionClosed) {
                try {
                    await operations.closeCellReadSession(session.sessionId);
                } catch (sessionError) {
                    primaryError = new AggregateError(
                        [primaryError, sessionError],
                        'Cell materialization failed and its read session could not be closed'
                    );
                }
            }
            throw primaryError;
        }
    }

    /** Remove a tracked materialization. Unknown URIs are intentionally ignored. */
    release(uri: vsc.Uri): void {
        const filePath = uri.fsPath;
        const materialized = this.trackedFiles.get(filePath);
        if (!materialized) return;
        const { fs } = requireNodeModules();
        fs.rmSync(filePath, { force: true });
        this.trackedFiles.delete(filePath);
        this.releaseReservedBytes(materialized.byteLength);
        for (const [owner, files] of this.ownerFiles) {
            files.delete(filePath);
            if (files.size === 0) this.removeOwner(owner);
        }
        this.pruneEmptyRunDirectory();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.closeDocumentSubscription?.dispose();
        for (const subscription of this.ownerSubscriptions.values()) subscription.dispose();
        this.ownerSubscriptions.clear();
        this.ownerFiles.clear();

        let trackedBytes = 0;
        for (const materialized of this.trackedFiles.values()) {
            trackedBytes += materialized.byteLength;
        }

        if (this.runDirectory) {
            const { fs } = requireNodeModules();
            fs.rmSync(this.runDirectory, { recursive: true, force: true });
            this.runDirectory = undefined;
        }
        this.trackedFiles.clear();
        // Reservations belonging to in-flight materializations remain charged
        // until those operations observe disposal and finish their own cleanup.
        this.releaseReservedBytes(trackedBytes);
    }

    private assertActive(signal: AbortSignal | undefined): void {
        if (this.disposed) throw new Error('Cell materialization service is disposed');
        assertNotCancelled(signal);
    }

    private ensureRunDirectory(fs: NodeFs): string {
        if (this.runDirectory) return this.runDirectory;
        const path = require('path') as typeof import('node:path');
        fs.mkdirSync(this.storageRoot.fsPath, { recursive: true, mode: 0o700 });
        const runDirectory = path.join(
            this.storageRoot.fsPath,
            `sqlite-explorer-cell-materializations-${webCrypto.randomUUID()}`
        );
        fs.mkdirSync(runDirectory, { mode: 0o700 });
        fs.chmodSync(runDirectory, 0o700);
        this.runDirectory = runDirectory;
        return runDirectory;
    }

    private requireTextEncoding(metadata: CellMetadata): 'utf-8' | 'utf-16le' | 'utf-16be' {
        if (!metadata.textEncoding) {
            throw new Error('SQLite omitted the encoding for a TEXT cell read session');
        }
        return metadata.textEncoding;
    }

    private validateChunk(
        chunk: Awaited<ReturnType<DatabaseOperations['readCellChunk']>>,
        expectedOffset: number,
        requestedBytes: number,
        sourceByteLength: number
    ): void {
        if (chunk.byteOffset !== expectedOffset) {
            throw new Error(
                `Cell read chunk offset mismatch: expected ${expectedOffset}, received ${chunk.byteOffset}`
            );
        }
        if (!(chunk.bytes instanceof Uint8Array) || chunk.bytes.byteLength > requestedBytes) {
            throw new Error('Cell read session returned an invalid or oversized chunk');
        }
        if (chunk.bytes.byteLength === 0 && expectedOffset < sourceByteLength) {
            throw new Error('Cell read session ended before the advertised byte length');
        }
        const nextOffset = expectedOffset + chunk.bytes.byteLength;
        if (nextOffset > sourceByteLength || chunk.done !== (nextOffset >= sourceByteLength)) {
            throw new Error('Cell read session completion did not match its advertised byte length');
        }
    }

    private checkedOutputSize(current: number, added: number): number {
        const next = current + added;
        if (!Number.isSafeInteger(next) || next > this.maxBytes) {
            throw new Error(
                `Materialized output exceeds the ${this.maxBytes}-byte temporary-file quota`
            );
        }
        return next;
    }

    private reserveBytes(requestedBytes: number): void {
        const next = this.allocatedBytes + requestedBytes;
        if (!Number.isSafeInteger(next) || next > this.maxBytes) {
            throw new Error(
                `${requestedBytes}-byte materialization cannot fit the aggregate temporary-file ` +
                `quota: ${this.allocatedBytes} of ${this.maxBytes} bytes are already live or in progress`
            );
        }
        this.allocatedBytes = next;
    }

    private ensureOutputReservation(reservedBytes: number, outputBytes: number): number {
        if (outputBytes <= reservedBytes) return reservedBytes;
        const additionalBytes = outputBytes - reservedBytes;
        this.reserveBytes(additionalBytes);
        return outputBytes;
    }

    private releaseReservedBytes(byteLength: number): void {
        if (byteLength === 0) return;
        if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > this.allocatedBytes) {
            throw new Error('Cell materialization quota accounting became inconsistent');
        }
        this.allocatedBytes -= byteLength;
    }

    private async writeFully(
        file: import('node:fs/promises').FileHandle,
        bytes: Uint8Array,
        signal: AbortSignal | undefined
    ): Promise<void> {
        let offset = 0;
        while (offset < bytes.byteLength) {
            this.assertActive(signal);
            const { bytesWritten } = await file.write(
                bytes,
                offset,
                bytes.byteLength - offset,
                null
            );
            this.assertActive(signal);
            if (bytesWritten < 1) throw new Error('Temp-file write made no progress');
            offset += bytesWritten;
        }
    }

    private async verifyFile(
        fs: NodeFs,
        crypto: NodeCrypto,
        filePath: string,
        signal: AbortSignal | undefined
    ): Promise<{ byteLength: number; checksum: string }> {
        const handle = await fs.promises.open(filePath, 'r');
        const hash = crypto.createHash('sha256');
        const buffer = Buffer.allocUnsafe(this.chunkBytes);
        let byteLength = 0;
        try {
            while (true) {
                this.assertActive(signal);
                const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
                this.assertActive(signal);
                if (bytesRead === 0) break;
                hash.update(buffer.subarray(0, bytesRead));
                byteLength += bytesRead;
            }
        } finally {
            await handle.close();
        }
        return { byteLength, checksum: hash.digest('hex') };
    }

    private track(materialized: MaterializedCell, owner: CellMaterializationOwner | undefined): void {
        const filePath = materialized.uri.fsPath;
        this.trackedFiles.set(filePath, materialized);
        if (!owner) return;

        let files = this.ownerFiles.get(owner);
        if (!files) {
            files = new Set<string>();
            this.ownerFiles.set(owner, files);
            const subscription = owner.onDidDispose(() => {
                const ownedFiles = [...(this.ownerFiles.get(owner) ?? [])];
                for (const ownedFile of ownedFiles) {
                    const tracked = this.trackedFiles.get(ownedFile);
                    if (tracked) this.release(tracked.uri);
                }
                this.removeOwner(owner);
            });
            this.ownerSubscriptions.set(owner, subscription);
        }
        files.add(filePath);
    }

    private removeOwner(owner: CellMaterializationOwner): void {
        this.ownerFiles.delete(owner);
        this.ownerSubscriptions.get(owner)?.dispose();
        this.ownerSubscriptions.delete(owner);
    }

    private pruneEmptyRunDirectory(): void {
        if (!this.runDirectory || this.trackedFiles.size > 0) return;
        const { fs } = requireNodeModules();
        try {
            fs.rmdirSync(this.runDirectory);
            this.runDirectory = undefined;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error;
            if (code === 'ENOENT') this.runDirectory = undefined;
        }
    }
}
