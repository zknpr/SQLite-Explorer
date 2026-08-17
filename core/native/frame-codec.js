/**
 * Length-prefixed JSON framing for the desktop native sidecar.
 *
 * WIRE CONTRACT — this is a CROSS-LANGUAGE format. The Rust parent in
 * `SQLite-Explorer-App/src-tauri` encodes and decodes exactly these bytes, so
 * every rule below is a contract, not an implementation detail:
 *
 *   frame := u32 big-endian payload length  ||  UTF-8 JSON payload
 *
 * - The length prefix counts the PAYLOAD only; the 4 header bytes are not
 *   included in it and not counted against the cap.
 * - `MAX_FRAME_BYTES` (16 MiB) caps the payload in BOTH directions.
 * - The payload is UTF-8 and is decoded FATALLY: a malformed sequence is an
 *   error frame, never a silent U+FFFD substitution.
 *
 * Values are tagged because JSON alone loses three things SQLite produces:
 * int64 beyond 2^53 (BigInt — `JSON.stringify` throws on it), BLOBs
 * (`Uint8Array` — JSON-serialises as `{"0":1,…}`), and non-finite REALs
 * (`JSON.stringify` coerces them to `null`). The markers are the ones the rest
 * of the repo already uses — `{__type:'Uint8Array', base64}` with the
 * exact-two-key defence from `src/core/serialization.ts`, and the `~`-escaped
 * scalar sentinels from `src/core/json-safe-numbers.ts`, which is IMPORTED
 * rather than restated so the two encoders cannot drift.
 *
 * Errors are tagged too: `JSON.stringify(new Error('x'))` is `{}`, and the
 * fork puts the SQLite primary result code on a NON-ENUMERABLE `err.errno`
 * (probe §2g), so `errno` has to be copied by explicit property access.
 *
 * The module deliberately does NO I/O — `stdio-transport.js` owns the pipes —
 * so the whole codec is exercised synchronously in `tests/unit/native_frame_codec.test.ts`
 * and byte-pinned by `tests/fixtures/native-frames.bin`.
 */

import {
    decodeJsonSafeNumberString,
    encodeJsonSafeNonFiniteNumber,
    escapeJsonSafeNumberString
} from '../../src/core/json-safe-numbers.ts';

/** Bytes in the big-endian length prefix. */
export const FRAME_HEADER_BYTES = 4;

/**
 * 16 MiB, matching the page budget the worker method layer already enforces
 * (`DEFAULT_MAX_PAGE_RESPONSE_BYTES`). Anything larger is a bug or an attack,
 * not a legitimate result page.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Largest value a u32 length prefix can express. */
const MAX_HEADER_VALUE = 0xffffffff;

/** Stable machine-readable identities carried on both sides of the pipe. */
export const NATIVE_FRAME_TOO_LARGE = 'ERR_NATIVE_FRAME_TOO_LARGE';
export const NATIVE_FRAME_MALFORMED = 'ERR_NATIVE_FRAME_MALFORMED';

const TEXT_ENCODER = new TextEncoder();
// Fatal: a truncated or invalid UTF-8 payload must surface as an error frame.
// The lenient default would hand the method layer silently corrupted SQL.
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });

/** Only a canonical decimal integer is accepted back as a BigInt. */
const DECIMAL_INTEGER = /^-?(?:0|[1-9][0-9]*)$/;

/** btoa/atob take chunked arguments; 32 KiB matches core/ui/modules/transport.js. */
const BASE64_CHUNK = 32768;

/**
 * Error messages are bounded so an error frame is always small enough to send.
 * Without this a hostile payload could produce a parse-error message large
 * enough that the in-band answer ALSO exceeds the cap, which would leave the
 * reader with no way to reply. SQLite's own messages are a few dozen bytes.
 */
const MAX_ERROR_MESSAGE_CHARS = 512;

export class NativeFrameError extends Error {
    /**
     * @param {object} options
     * @param {string} options.code
     * @param {'incoming'|'outgoing'} options.direction
     * @param {string} options.message
     * @param {number} [options.actualBytes]
     * @param {number} [options.limitBytes]
     * @param {unknown} [options.cause]
     */
    constructor(options) {
        super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'NativeFrameError';
        this.code = options.code;
        this.direction = options.direction;
        this.actualBytes = options.actualBytes;
        this.limitBytes = options.limitBytes;
    }
}

export function isNativeFrameError(error) {
    return error instanceof NativeFrameError
        || (
            !!error
            && typeof error === 'object'
            && error.name === 'NativeFrameError'
            && (error.code === NATIVE_FRAME_TOO_LARGE || error.code === NATIVE_FRAME_MALFORMED)
        );
}

function tooLarge(direction, actualBytes, limitBytes) {
    return new NativeFrameError({
        code: NATIVE_FRAME_TOO_LARGE,
        direction,
        actualBytes,
        limitBytes,
        message: `Native frame rejected: ${direction} payload is ${actualBytes} bytes `
            + `and exceeds the ${limitBytes}-byte frame limit.`
    });
}

function malformed(message, cause) {
    return new NativeFrameError({
        code: NATIVE_FRAME_MALFORMED,
        direction: 'incoming',
        message: `Native frame rejected: ${message}`,
        cause
    });
}

function resolveMaxFrameBytes(value) {
    if (value === undefined) return MAX_FRAME_BYTES;
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_HEADER_VALUE) {
        throw new RangeError('Native frame limit must be an integer in [1, 4294967295]');
    }
    return value;
}

// --- base64 (no Buffer: this module also runs inside tjs) -------------------

function bytesToBase64(bytes) {
    if (bytes.length === 0) return '';
    const parts = [];
    for (let index = 0; index < bytes.length; index += BASE64_CHUNK) {
        parts.push(String.fromCharCode.apply(
            null,
            bytes.subarray(index, Math.min(index + BASE64_CHUNK, bytes.length))
        ));
    }
    return btoa(parts.join(''));
}

function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

// --- header ----------------------------------------------------------------

/**
 * @param {number} payloadBytes
 * @returns {Uint8Array} the 4-byte big-endian prefix
 */
export function encodeFrameHeader(payloadBytes) {
    if (!Number.isInteger(payloadBytes) || payloadBytes < 0 || payloadBytes > MAX_HEADER_VALUE) {
        throw new RangeError(
            `Native frame header must be an integer in [0, ${MAX_HEADER_VALUE}], got ${payloadBytes}`
        );
    }
    return new Uint8Array([
        (payloadBytes >>> 24) & 0xff,
        (payloadBytes >>> 16) & 0xff,
        (payloadBytes >>> 8) & 0xff,
        payloadBytes & 0xff
    ]);
}

/**
 * Read the big-endian prefix as UNSIGNED. A signed read would turn a declared
 * length at or above 0x80000000 into a negative number, which slips past the
 * cap check and leaves the reader waiting for a body that never ends.
 *
 * @param {ArrayLike<number>} bytes
 * @param {number} [offset]
 * @returns {number}
 */
export function readFrameHeader(bytes, offset = 0) {
    return (
        (bytes[offset] << 24)
        | (bytes[offset + 1] << 16)
        | (bytes[offset + 2] << 8)
        | bytes[offset + 3]
    ) >>> 0;
}

// --- value codec -----------------------------------------------------------

function boundMessage(message) {
    return message.length <= MAX_ERROR_MESSAGE_CHARS
        ? message
        : `${message.slice(0, MAX_ERROR_MESSAGE_CHARS)}… [truncated]`;
}

/**
 * Copy an error onto the wire.
 *
 * `errno` is read by explicit property access because the fork defines it
 * NON-ENUMERABLE, so `{...err}` / `JSON.stringify(err)` drop it and every
 * SQLite failure would reach the parent unclassifiable (probe §2g).
 *
 * @param {unknown} error
 * @returns {{name: string, message: string, code?: string, errno?: number}}
 */
export function toFrameErrorData(error) {
    if (!error || typeof error !== 'object') {
        return {
            name: 'Error',
            message: boundMessage(typeof error === 'string' ? error : String(error))
        };
    }
    const data = {
        name: typeof error.name === 'string' ? error.name : 'Error',
        message: boundMessage(typeof error.message === 'string' ? error.message : String(error))
    };
    if (typeof error.code === 'string') data.code = error.code;
    if (Number.isSafeInteger(error.errno)) data.errno = error.errno;
    return data;
}

/** Rebuild an Error from `toFrameErrorData` output, restoring `errno`. */
export function fromFrameErrorData(data) {
    if (!data || typeof data !== 'object' || typeof data.message !== 'string') return undefined;
    const error = new Error(data.message);
    if (typeof data.name === 'string') error.name = data.name;
    if (typeof data.code === 'string') error.code = data.code;
    if (Number.isSafeInteger(data.errno)) error.errno = data.errno;
    return error;
}

function isPlainObject(value) {
    return !!value
        && typeof value === 'object'
        && Object.prototype.toString.call(value) === '[object Object]';
}

/**
 * Tag the values JSON cannot carry. Marker objects always have EXACTLY two
 * keys so `decodeFrameValue`'s collision defence can be a key-count check.
 *
 * Known inherited limitation: a genuine two-key `{__type:'Uint8Array', base64}`
 * object arriving as user data re-decodes as a blob. This is the same hole
 * `src/core/serialization.ts` has had since the marker was introduced, and it
 * is inherited deliberately — diverging would break wire compatibility with
 * the webview codec. It is unreachable from SQLite results, whose values are
 * scalars, never nested objects.
 */
export function encodeFrameValue(value) {
    return encodeInner(value, new WeakSet());
}

function encodeInner(value, ancestors) {
    if (typeof value === 'bigint') {
        return { __type: 'BigInt', decimal: value.toString() };
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : encodeJsonSafeNonFiniteNumber(value);
    }
    if (typeof value === 'string') {
        return escapeJsonSafeNumberString(value);
    }
    if (value instanceof Uint8Array) {
        return { __type: 'Uint8Array', base64: bytesToBase64(value) };
    }
    if (ArrayBuffer.isView(value)) {
        return {
            __type: 'Uint8Array',
            base64: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
        };
    }
    if (value instanceof ArrayBuffer) {
        return { __type: 'Uint8Array', base64: bytesToBase64(new Uint8Array(value)) };
    }
    if (value instanceof Error) {
        return { __type: 'Error', error: toFrameErrorData(value) };
    }
    if (value === null || typeof value !== 'object') return value;

    // A cycle would spin here forever; a sidecar that hangs is strictly worse
    // than one that answers with an error envelope.
    if (ancestors.has(value)) {
        throw new TypeError('Native frame value: circular reference');
    }
    ancestors.add(value);
    try {
        if (Array.isArray(value)) return value.map((item) => encodeInner(item, ancestors));
        if (!isPlainObject(value)) return value;
        const result = {};
        for (const key of Object.keys(value)) assignOwn(result, key, encodeInner(value[key], ancestors));
        return result;
    } finally {
        ancestors.delete(value);
    }
}

function isMarker(value, keys, payloadKey) {
    return keys.length === 2 && keys.includes('__type') && keys.includes(payloadKey);
}

/**
 * Copy one property WITHOUT letting `__proto__` retarget the object.
 *
 * `JSON.parse('{"__proto__":{…}}')` creates `__proto__` as an ordinary own
 * data property, but `target.__proto__ = value` runs Object.prototype's
 * setter: the assignment would silently drop the value AND make every decoded
 * envelope inherit attacker-chosen properties. Envelopes reach this codec from
 * the webview through the shell's `native_rpc`, so the JSON here is untrusted.
 * `defineProperty` keeps the data as a plain own property instead.
 */
function assignOwn(target, key, value) {
    if (key === '__proto__') {
        Object.defineProperty(target, key, {
            value,
            enumerable: true,
            writable: true,
            configurable: true
        });
        return;
    }
    target[key] = value;
}

/** Inverse of `encodeFrameValue`. Throws on a marker whose payload is invalid. */
export function decodeFrameValue(value) {
    if (typeof value === 'string') return decodeJsonSafeNumberString(value);
    if (Array.isArray(value)) return value.map(decodeFrameValue);
    if (!isPlainObject(value)) return value;

    const keys = Object.keys(value);
    if (value.__type === 'BigInt' && typeof value.decimal === 'string' && isMarker(value, keys, 'decimal')) {
        if (!DECIMAL_INTEGER.test(value.decimal)) {
            throw new TypeError(`Native frame value: invalid BigInt marker payload ${JSON.stringify(value.decimal)}`);
        }
        return BigInt(value.decimal);
    }
    if (value.__type === 'Uint8Array' && typeof value.base64 === 'string' && isMarker(value, keys, 'base64')) {
        return base64ToBytes(value.base64);
    }
    // Legacy array form, still produced by older webview payloads.
    if (value.__type === 'Uint8Array' && Array.isArray(value.data) && isMarker(value, keys, 'data')) {
        return new Uint8Array(value.data);
    }
    if (value.__type === 'Error' && isPlainObject(value.error) && isMarker(value, keys, 'error')) {
        const restored = fromFrameErrorData(value.error);
        if (!restored) throw new TypeError('Native frame value: invalid Error marker payload');
        return restored;
    }

    const result = {};
    for (const key of keys) assignOwn(result, key, decodeFrameValue(value[key]));
    return result;
}

// --- frames ----------------------------------------------------------------

/**
 * UTF-8 byte length without allocating the encoded buffer. Used only to report
 * the exact size of a frame that is about to be REJECTED, so an oversize
 * message never allocates its own encoding first.
 */
function utf8ByteLength(text) {
    let bytes = 0;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code < 0x80) bytes += 1;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
            const next = text.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index++; } else bytes += 3;
        } else bytes += 3;
    }
    return bytes;
}

/**
 * @param {unknown} message
 * @param {{maxFrameBytes?: number}} [options]
 * @returns {Uint8Array} header + payload, ready to write
 * @throws {NativeFrameError} when the payload exceeds the cap — the caller
 *   turns that into an error envelope; the stream is never desynchronised
 *   because nothing was written.
 */
export function encodeFrame(message, options) {
    const limit = resolveMaxFrameBytes(options?.maxFrameBytes);
    const json = JSON.stringify(encodeFrameValue(message));
    if (typeof json !== 'string') {
        throw new TypeError('Native frame: message is not JSON-serialisable');
    }

    // UTF-8 costs 1–3 bytes per UTF-16 code unit (a surrogate pair is 2 units
    // for 4 bytes), so these bounds settle almost every frame without a scan.
    if (json.length * 3 > limit) {
        const byteLength = utf8ByteLength(json);
        if (byteLength > limit) throw tooLarge('outgoing', byteLength, limit);
    }

    const payload = TEXT_ENCODER.encode(json);
    const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
    frame.set(encodeFrameHeader(payload.length), 0);
    frame.set(payload, FRAME_HEADER_BYTES);
    return frame;
}

/**
 * Streaming reader. Feed it whatever the pipe delivers — the probe proved
 * chunks honour neither frame boundaries nor sizes (partial headers, coalesced
 * frames, and frame-plus-prefix-of-next all occur).
 *
 * OVERSIZE-INCOMING POLICY: an oversize declared length reports once through
 * `onError` and then DRAINS exactly that many bytes, discarding them without
 * buffering, before resuming at the next frame boundary. The alternatives are
 * both worse: stopping the read loop deadlocks the peer as soon as the pipe
 * buffer fills, and resuming at the next byte instead of the next frame
 * desynchronises framing permanently (payload bytes get read as headers, which
 * an attacker chooses). Draining costs read bandwidth — at most 4 GiB, the
 * ceiling of a u32 prefix — but O(1) memory, and it resynchronises exactly.
 *
 * Callbacks are invoked AFTER the reader's own state has advanced, so a
 * throwing callback cannot leave the framing misaligned.
 *
 * @param {(message: unknown) => void} onMessage
 * @param {(error: NativeFrameError) => void} onError
 * @param {{maxFrameBytes?: number}} [options]
 */
export function createFrameReader(onMessage, onError, options) {
    const limit = resolveMaxFrameBytes(options?.maxFrameBytes);
    /** @type {Uint8Array[]} */
    const chunks = [];
    let head = 0;          // read offset into chunks[0]
    let available = 0;     // bytes buffered across all chunks, minus `head`
    let pendingLength = -1; // payload length of the frame being assembled
    let skipRemaining = 0;  // bytes of a doomed oversize frame still to discard
    let ended = false;

    const advance = (count) => {
        available -= count;
        let left = count;
        while (left > 0) {
            const chunk = chunks[0];
            const inChunk = chunk.length - head;
            if (inChunk > left) {
                head += left;
                left = 0;
            } else {
                left -= inChunk;
                chunks.shift();
                head = 0;
            }
        }
    };

    const takeExact = (count) => {
        if (count === 0) return new Uint8Array(0);
        const first = chunks[0];
        if (first.length - head >= count) {
            // Contiguous: hand out a view, no copy. `advance` may drop the
            // chunk from the queue but the view keeps its buffer alive.
            const view = first.subarray(head, head + count);
            advance(count);
            return view;
        }
        const out = new Uint8Array(count);
        let filled = 0;
        while (filled < count) {
            const chunk = chunks[0];
            const take = Math.min(count - filled, chunk.length - head);
            out.set(chunk.subarray(head, head + take), filled);
            filled += take;
            advance(take);
        }
        return out;
    };

    const deliver = (payload) => {
        let text;
        try {
            text = TEXT_DECODER.decode(payload);
        } catch (cause) {
            onError(malformed(`payload is not valid UTF-8 (${payload.length} bytes)`, cause));
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (cause) {
            onError(malformed(`payload is not valid JSON (${payload.length} bytes)`, cause));
            return;
        }
        let decoded;
        try {
            decoded = decodeFrameValue(parsed);
        } catch (cause) {
            onError(malformed(`payload carries an invalid tagged value: ${cause?.message ?? cause}`, cause));
            return;
        }
        onMessage(decoded);
    };

    const drain = () => {
        for (;;) {
            if (skipRemaining > 0) {
                const take = Math.min(skipRemaining, available);
                if (take > 0) {
                    advance(take);
                    skipRemaining -= take;
                }
                if (skipRemaining > 0) return;
                continue;
            }
            if (pendingLength < 0) {
                if (available < FRAME_HEADER_BYTES) return;
                const declared = readFrameHeader(takeExact(FRAME_HEADER_BYTES));
                if (declared > limit) {
                    skipRemaining = declared;
                    onError(tooLarge('incoming', declared, limit));
                    continue;
                }
                pendingLength = declared;
            }
            if (available < pendingLength) return;
            const payload = takeExact(pendingLength);
            pendingLength = -1;
            deliver(payload);
        }
    };

    return {
        /** @param {Uint8Array} chunk */
        push(chunk) {
            if (ended) throw new Error('Native frame reader: push() after end()');
            if (!chunk || chunk.length === 0) return;
            chunks.push(chunk);
            available += chunk.length;
            drain();
        },
        /** Stdin EOF. Reports a partially received frame rather than dropping it. */
        end() {
            if (ended) return;
            ended = true;
            // A drain still in progress is NOT reported again: the oversize
            // frame it belongs to already produced its error, and the peer
            // dying mid-drain adds nothing.
            if (skipRemaining === 0 && (available > 0 || pendingLength >= 0)) {
                const missing = pendingLength >= 0 ? pendingLength - available : null;
                onError(malformed(
                    missing === null
                        ? `stream ended with a truncated frame header (${available} of ${FRAME_HEADER_BYTES} bytes)`
                        : `stream ended with a truncated frame payload (${missing} of ${pendingLength} bytes missing)`
                ));
            }
        },
        get bufferedBytes() { return available; },
        get skipRemainingBytes() { return skipRemaining; }
    };
}

/**
 * The in-band answer to a frame that could not be handled. Shape matches the
 * worker's own error response (`website/src/sqlite-viewer/worker.js`), so the
 * parent's pending-request map needs no special case. `messageId` is null when
 * the frame was never parseable enough to carry one — the parent logs those
 * rather than resolving a request.
 *
 * @param {unknown} error
 * @param {string|number|null} [messageId]
 */
export function frameErrorResponse(error, messageId = null) {
    const data = toFrameErrorData(error);
    return {
        channel: 'rpc',
        content: {
            kind: 'response',
            messageId,
            success: false,
            errorMessage: data.message,
            error: data
        }
    };
}
