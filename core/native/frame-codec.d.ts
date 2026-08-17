/**
 * Types for frame-codec.js — the length-prefixed JSON wire format shared with
 * the Rust parent. See the module docstring for the byte contract.
 */

export const FRAME_HEADER_BYTES: 4;
export const MAX_FRAME_BYTES: number;
/**
 * Largest declared length the reader will still DRAIN and resynchronise from
 * (4 x `MAX_FRAME_BYTES`). Past it the header is not a length at all and the
 * reader stops permanently instead of eating every frame behind it.
 */
export const MAX_DRAIN_BYTES: number;

export const NATIVE_FRAME_TOO_LARGE: 'ERR_NATIVE_FRAME_TOO_LARGE';
export const NATIVE_FRAME_MALFORMED: 'ERR_NATIVE_FRAME_MALFORMED';
export const NATIVE_FRAME_DESYNC: 'ERR_NATIVE_FRAME_DESYNC';

export type NativeFrameErrorCode =
    | typeof NATIVE_FRAME_TOO_LARGE
    | typeof NATIVE_FRAME_MALFORMED
    | typeof NATIVE_FRAME_DESYNC;

export class NativeFrameError extends Error {
    readonly name: 'NativeFrameError';
    readonly code: NativeFrameErrorCode;
    /** Which side of the pipe the offending frame was on. */
    readonly direction: 'incoming' | 'outgoing';
    /** Present on cap violations only. */
    readonly actualBytes?: number;
    readonly limitBytes?: number;
    /**
     * True only for `NATIVE_FRAME_DESYNC`: the reader has stopped for good and
     * the embedder must shut down. Every other frame error is recoverable and
     * the stream continues.
     */
    readonly fatal: boolean;
}

export function isNativeFrameError(error: unknown): error is NativeFrameError;

/** Wire form of an error. `errno` is the SQLite primary result code. */
export interface FrameErrorData {
    name: string;
    message: string;
    code?: string;
    errno?: number;
}

export function toFrameErrorData(error: unknown): FrameErrorData;
export function fromFrameErrorData(data: unknown): Error | undefined;

export function encodeFrameHeader(payloadBytes: number): Uint8Array;
/** @throws {RangeError} when fewer than 4 bytes are available at `offset`. */
export function readFrameHeader(bytes: ArrayLike<number>, offset?: number): number;

/** Tag the values JSON cannot carry (BigInt, binary, non-finite REALs, Errors). */
export function encodeFrameValue(value: unknown): unknown;
/** Inverse of `encodeFrameValue`; throws on a marker with an invalid payload. */
export function decodeFrameValue(value: unknown): unknown;

export interface FrameLimitOptions {
    /** Defaults to `MAX_FRAME_BYTES`. Lower values exist for tests. */
    maxFrameBytes?: number;
}

export interface FrameReaderOptions extends FrameLimitOptions {
    /**
     * Declared lengths above this are treated as a desync rather than drained.
     * Defaults to 4 x the frame cap, so a test running a small `maxFrameBytes`
     * still exercises both tiers.
     */
    maxDrainBytes?: number;
}

/** @throws {NativeFrameError} when the encoded payload exceeds the cap. */
export function encodeFrame(message: unknown, options?: FrameLimitOptions): Uint8Array;

export interface FrameReader {
    /** Feed one pipe chunk. Invokes the callbacks synchronously. Ignored once `fatal`. */
    push(chunk: Uint8Array): void;
    /** Stdin EOF. Reports a partially received frame rather than dropping it. */
    end(): void;
    /** Bytes held for the frame currently being assembled. */
    readonly bufferedBytes: number;
    /** Bytes of a doomed oversize frame still to be discarded. */
    readonly skipRemainingBytes: number;
    /**
     * True once a desync stopped the reader permanently. The embedder must
     * stop reading and shut down; nothing later in the stream is framed.
     */
    readonly fatal: boolean;
}

/**
 * @param onError receives every frame-level failure. Check `error.fatal`:
 *   false means the stream recovered and continues, true means the reader has
 *   stopped for good and the embedder must exit.
 */
export function createFrameReader(
    onMessage: (message: unknown) => void,
    onError: (error: NativeFrameError) => void,
    options?: FrameReaderOptions
): FrameReader;

export interface FrameErrorResponse {
    channel: 'rpc';
    content: {
        kind: 'response';
        messageId: string | number | null;
        success: false;
        errorMessage: string;
        error: FrameErrorData;
    };
}

export function frameErrorResponse(
    error: unknown,
    messageId?: string | number | null
): FrameErrorResponse;
