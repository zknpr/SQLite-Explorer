import * as vsc from 'vscode';

import { crypto as webCrypto } from './platform/cryptoShim';
import { MAX_CELL_READ_CHUNK_BYTES } from './core/cell-read';
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
        if (this.disposed) throw new Error('Cell materialization service is disposed');
        assertNotCancelled(options.signal);

        const session = await operations.openCellReadSession(target);
        let filePath: string | undefined;
        let fileHandle: import('node:fs/promises').FileHandle | undefined;
        let primaryError: unknown;
        try {
            const { metadata } = session;
            if (metadata.byteLength > this.maxBytes) {
                throw new Error(
                    `${metadata.byteLength} bytes exceeds the ${this.maxBytes}-byte ` +
                    'temporary-file quota; export the cell with an explicit destination instead'
                );
            }

            assertNotCancelled(options.signal);
            const { fs, crypto } = requireNodeModules();
            const runDirectory = this.ensureRunDirectory(fs);
            const extension = safeExtension(options.fileExtension, metadata);
            filePath = (require('path') as typeof import('node:path')).join(
                runDirectory,
                `${webCrypto.randomUUID()}.${extension}`
            );
            fileHandle = await fs.promises.open(filePath, 'wx', 0o600);
            await fileHandle.chmod(0o600);

            const outputHash = crypto.createHash('sha256');
            const decoder = metadata.storageClass === 'text'
                ? new TextDecoder(this.requireTextEncoding(metadata), { fatal: true })
                : undefined;
            const encoder = decoder ? new TextEncoder() : undefined;
            let sourceOffset = 0;
            let outputBytes = 0;

            while (sourceOffset < metadata.byteLength) {
                assertNotCancelled(options.signal);
                const requestedBytes = Math.min(
                    this.chunkBytes,
                    metadata.byteLength - sourceOffset
                );
                const chunk = await operations.readCellChunk(
                    session.sessionId,
                    sourceOffset,
                    requestedBytes
                );
                assertNotCancelled(options.signal);
                this.validateChunk(chunk, sourceOffset, requestedBytes, metadata.byteLength);

                const output = decoder && encoder
                    ? encoder.encode(decoder.decode(chunk.bytes, { stream: true }))
                    : chunk.bytes;
                outputBytes = this.checkedOutputSize(outputBytes, output.byteLength);
                await this.writeFully(fileHandle, output);
                outputHash.update(output);
                sourceOffset += chunk.bytes.byteLength;
            }

            if (decoder && encoder) {
                const finalBytes = encoder.encode(decoder.decode());
                outputBytes = this.checkedOutputSize(outputBytes, finalBytes.byteLength);
                await this.writeFully(fileHandle, finalBytes);
                outputHash.update(finalBytes);
            }
            assertNotCancelled(options.signal);
            await fileHandle.sync();
            await fileHandle.close();
            fileHandle = undefined;

            const assembledChecksum = outputHash.digest('hex');
            const verified = await this.verifyFile(fs, crypto, filePath, options.signal);
            if (verified.byteLength !== outputBytes || verified.checksum !== assembledChecksum) {
                throw new Error('Materialized cell checksum verification failed');
            }

            await operations.closeCellReadSession(session.sessionId);
            const materialized: MaterializedCell = {
                uri: vsc.Uri.file(filePath),
                metadata,
                byteLength: outputBytes,
                checksumSha256: assembledChecksum
            };
            this.track(materialized, options.owner);
            return materialized;
        } catch (error) {
            primaryError = error;
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
                } catch (cleanupError) {
                    primaryError = new AggregateError(
                        [primaryError, cleanupError],
                        'Cell materialization failed and its partial temp file could not be removed'
                    );
                }
            }
            this.pruneEmptyRunDirectory();
            try {
                await operations.closeCellReadSession(session.sessionId);
            } catch (sessionError) {
                primaryError = new AggregateError(
                    [primaryError, sessionError],
                    'Cell materialization failed and its read session could not be closed'
                );
            }
            throw primaryError;
        }
    }

    /** Remove a tracked materialization. Unknown URIs are intentionally ignored. */
    release(uri: vsc.Uri): void {
        const filePath = uri.fsPath;
        if (!this.trackedFiles.has(filePath)) return;
        const { fs } = requireNodeModules();
        fs.rmSync(filePath, { force: true });
        this.trackedFiles.delete(filePath);
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

        if (this.runDirectory) {
            const { fs } = requireNodeModules();
            fs.rmSync(this.runDirectory, { recursive: true, force: true });
            this.runDirectory = undefined;
        }
        this.trackedFiles.clear();
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

    private async writeFully(
        file: import('node:fs/promises').FileHandle,
        bytes: Uint8Array
    ): Promise<void> {
        let offset = 0;
        while (offset < bytes.byteLength) {
            const { bytesWritten } = await file.write(
                bytes,
                offset,
                bytes.byteLength - offset,
                null
            );
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
                assertNotCancelled(signal);
                const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
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
