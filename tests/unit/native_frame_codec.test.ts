/**
 * Frame codec + stdio transport for the desktop native sidecar.
 *
 * The wire contract asserted here is CROSS-LANGUAGE: Task 5's Rust parent
 * decodes exactly these bytes. Anything in this file that pins a byte layout
 * (big-endian header, the `__type` markers, the 16 MiB cap) is a contract with
 * another codebase, not an implementation detail — `tests/fixtures/native-frames.bin`
 * is regenerated and byte-compared here so a codec change cannot silently
 * desynchronise the Rust side.
 *
 * The REAL binary runs the same codec over real pipes in
 * `scripts/native-lane.mjs` (`npm run native-lane`, macOS-local).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
    FRAME_HEADER_BYTES,
    MAX_FRAME_BYTES,
    NATIVE_FRAME_MALFORMED,
    NATIVE_FRAME_TOO_LARGE,
    createFrameReader,
    decodeFrameValue,
    encodeFrame,
    encodeFrameHeader,
    encodeFrameValue,
    frameErrorResponse,
    isNativeFrameError,
    readFrameHeader,
    toFrameErrorData
} from '../../core/native/frame-codec.js';
import type { NativeFrameError } from '../../core/native/frame-codec.js';
import { createStdioTransport } from '../../core/native/stdio-transport.js';
import { buildFrameFixture, FIXTURE_BASENAME } from '../../scripts/generate-native-frame-fixture';

// --- helpers ---------------------------------------------------------------

interface Collected {
    messages: unknown[];
    errors: NativeFrameError[];
}

function collect(options?: { maxFrameBytes?: number }) {
    const sink: Collected = { messages: [], errors: [] };
    const reader = createFrameReader(
        (message) => sink.messages.push(message),
        (error) => sink.errors.push(error),
        options
    );
    return { reader, sink };
}

function concat(...parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/** Frame a raw payload without going through the encoder's own cap check. */
function rawFrame(payload: Uint8Array, declaredLength = payload.length): Uint8Array {
    return concat(encodeFrameHeader(declaredLength), payload);
}

function utf8(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

function roundTrip(value: unknown): unknown {
    return decodeFrameValue(JSON.parse(JSON.stringify(encodeFrameValue(value))));
}

/** Decode a single self-contained frame back into its message. */
function decodeOneFrame(frame: Uint8Array): unknown {
    const { reader, sink } = collect();
    reader.push(frame);
    assert.deepStrictEqual(sink.errors.map((error) => error.message), []);
    assert.strictEqual(sink.messages.length, 1);
    return sink.messages[0];
}

const ENVELOPE = {
    channel: 'rpc',
    content: { kind: 'invoke', messageId: 'm-1', targetMethod: 'ping', payload: [] }
};

// --- header ----------------------------------------------------------------

describe('native frame header', () => {
    it('writes the length as 4 big-endian bytes', () => {
        assert.deepStrictEqual(Array.from(encodeFrameHeader(0x01020304)), [1, 2, 3, 4]);
        assert.deepStrictEqual(Array.from(encodeFrameHeader(0)), [0, 0, 0, 0]);
        assert.deepStrictEqual(Array.from(encodeFrameHeader(258)), [0, 0, 1, 2]);
        assert.deepStrictEqual(Array.from(encodeFrameHeader(0xffffffff)), [255, 255, 255, 255]);
    });

    it('reads the length back unsigned', () => {
        assert.strictEqual(readFrameHeader(new Uint8Array([0, 0, 1, 2])), 258);
        // 0x80000000 must not come back negative: a signed read would make the
        // cap check pass and the reader would then wait forever for the body.
        assert.strictEqual(readFrameHeader(new Uint8Array([0x80, 0, 0, 0])), 2147483648);
        assert.strictEqual(readFrameHeader(new Uint8Array([255, 255, 255, 255])), 4294967295);
    });

    it('reads at an offset', () => {
        assert.strictEqual(readFrameHeader(new Uint8Array([9, 9, 0, 0, 1, 2]), 2), 258);
    });

    it('rejects lengths that do not fit an unsigned 32-bit header', () => {
        assert.throws(() => encodeFrameHeader(-1), /header/i);
        assert.throws(() => encodeFrameHeader(4294967296), /header/i);
        assert.throws(() => encodeFrameHeader(1.5), /header/i);
    });

    it('prefixes an encoded frame with its own payload length', () => {
        const frame = encodeFrame(ENVELOPE);
        const declared = readFrameHeader(frame);
        assert.strictEqual(frame.length, FRAME_HEADER_BYTES + declared);
        const body = new TextDecoder().decode(frame.subarray(FRAME_HEADER_BYTES));
        assert.strictEqual(JSON.parse(body).content.targetMethod, 'ping');
    });
});

// --- value codec -----------------------------------------------------------

describe('native frame value codec', () => {
    it('round-trips int64 edges as BigInt and keeps safe integers as numbers', () => {
        assert.strictEqual(roundTrip(9007199254740991), 9007199254740991);
        assert.strictEqual(typeof roundTrip(9007199254740991), 'number');

        for (const value of [
            9007199254740992n,
            9007199254740993n,
            -9007199254740992n,
            9223372036854775807n,
            -9223372036854775808n,
            0n
        ]) {
            const decoded = roundTrip(value);
            assert.strictEqual(typeof decoded, 'bigint', `${value} lost its bigint type`);
            assert.strictEqual(decoded, value);
        }
    });

    it('tags BigInt with exactly two keys', () => {
        assert.deepStrictEqual(encodeFrameValue(7n), { __type: 'BigInt', decimal: '7' });
    });

    it('round-trips blobs, including empty and high bytes', () => {
        for (const bytes of [
            new Uint8Array([]),
            new Uint8Array([0, 1, 0x7f, 0x80, 0xff]),
            new Uint8Array(1024).fill(0xab)
        ]) {
            const decoded = roundTrip(bytes);
            assert.ok(decoded instanceof Uint8Array);
            assert.deepStrictEqual(Array.from(decoded), Array.from(bytes));
        }
    });

    it('uses the repo-wide Uint8Array marker', () => {
        assert.deepStrictEqual(
            encodeFrameValue(new Uint8Array([0, 1, 255])),
            { __type: 'Uint8Array', base64: 'AAH/' }
        );
    });

    it('accepts the legacy array-form Uint8Array marker on decode', () => {
        const decoded = decodeFrameValue({ __type: 'Uint8Array', data: [1, 2, 3] });
        assert.ok(decoded instanceof Uint8Array);
        assert.deepStrictEqual(Array.from(decoded), [1, 2, 3]);
    });

    it('holds the exact-two-key defence against marker-shaped user data', () => {
        const impostor = { __type: 'Uint8Array', base64: 'AAH/', extra: 1 };
        const decoded = decodeFrameValue(impostor) as Record<string, unknown>;
        assert.ok(!(decoded instanceof Uint8Array));
        assert.deepStrictEqual(decoded, impostor);

        const bigintImpostor = { __type: 'BigInt', decimal: '1', extra: 1 };
        assert.deepStrictEqual(decodeFrameValue(bigintImpostor), bigintImpostor);
    });

    it('never lets a __proto__ key retarget a decoded object', () => {
        // Envelopes reach the codec from the webview through the shell's
        // native_rpc, so this JSON is attacker-reachable. A plain
        // `result[key] = …` copy would run Object.prototype's setter.
        const parsed = JSON.parse('{"content":{"__proto__":{"polluted":1},"kind":"invoke"}}');
        const decoded = decodeFrameValue(parsed) as { content: Record<string, unknown> };

        assert.strictEqual(Object.getPrototypeOf(decoded.content), Object.prototype);
        assert.strictEqual((decoded.content as { polluted?: unknown }).polluted, undefined);
        assert.deepStrictEqual(decoded.content.__proto__, { polluted: 1 });
        assert.strictEqual(decoded.content.kind, 'invoke');
        assert.strictEqual(({} as { polluted?: unknown }).polluted, undefined);
    });

    it('never lets a __proto__ key retarget an encoded object', () => {
        const hostile = JSON.parse('{"__proto__":{"polluted":1},"a":2}');
        const encoded = encodeFrameValue(hostile) as Record<string, unknown>;
        assert.strictEqual(Object.getPrototypeOf(encoded), Object.prototype);
        assert.deepStrictEqual(encoded.__proto__, { polluted: 1 });
        assert.strictEqual(encoded.a, 2);
    });

    it('refuses a BigInt marker whose payload is not a decimal integer', () => {
        assert.throws(
            () => decodeFrameValue({ __type: 'BigInt', decimal: '1.5' }),
            /BigInt/
        );
        assert.throws(
            () => decodeFrameValue({ __type: 'BigInt', decimal: '0x10' }),
            /BigInt/
        );
    });

    it('round-trips non-finite REALs through the json-safe-numbers sentinels', () => {
        assert.strictEqual(roundTrip(Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
        assert.strictEqual(roundTrip(Number.NEGATIVE_INFINITY), Number.NEGATIVE_INFINITY);
        assert.ok(Number.isNaN(roundTrip(Number.NaN) as number));
    });

    it('escapes the sentinel namespace so user strings survive verbatim', () => {
        for (const text of [
            '~sqlite-explorer-non-finite:NaN',
            '~sqlite-explorer-non-finite:Infinity',
            '~',
            '~~',
            'plain',
            ''
        ]) {
            assert.strictEqual(roundTrip(text), text);
        }
    });

    it('round-trips nested rows/values matrices', () => {
        const payload = {
            columns: ['id', 'name', 'data', 'amount'],
            values: [
                [1, 'alpha', new Uint8Array([1, 2, 255]), 1.5],
                [9007199254740993n, null, new Uint8Array([]), Number.NEGATIVE_INFINITY],
                [true, '~tilde', null, -0.25]
            ]
        };
        const decoded = roundTrip(payload) as typeof payload;
        assert.deepStrictEqual(decoded.columns, payload.columns);
        assert.strictEqual(decoded.values[1][0], 9007199254740993n);
        assert.ok(decoded.values[0][2] instanceof Uint8Array);
        assert.deepStrictEqual(Array.from(decoded.values[0][2] as Uint8Array), [1, 2, 255]);
        assert.strictEqual(decoded.values[1][3], Number.NEGATIVE_INFINITY);
        assert.strictEqual(decoded.values[2][1], '~tilde');
    });

    it('carries a SQLite errno across even though it is NON-ENUMERABLE', () => {
        const error = new Error('constraint failed');
        Object.defineProperty(error, 'errno', { value: 19, enumerable: false });
        assert.deepStrictEqual(Object.keys(error), []);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(error)), {});

        assert.deepStrictEqual(toFrameErrorData(error), {
            name: 'Error',
            message: 'constraint failed',
            errno: 19
        });

        const decoded = roundTrip(error) as Error & { errno?: number };
        assert.ok(decoded instanceof Error);
        assert.strictEqual(decoded.message, 'constraint failed');
        assert.strictEqual(decoded.errno, 19);
    });

    it('omits errno when the error does not carry one', () => {
        assert.deepStrictEqual(toFrameErrorData(new TypeError('bad bind')), {
            name: 'TypeError',
            message: 'bad bind'
        });
    });

    it('serialises a non-Error rejection value without throwing', () => {
        assert.deepStrictEqual(toFrameErrorData('plain string'), {
            name: 'Error',
            message: 'plain string'
        });
    });

    it('bounds the message so an error frame is always small enough to send', () => {
        const data = toFrameErrorData(new Error('x'.repeat(10_000)));
        assert.ok(data.message.length < 600, `message was ${data.message.length} chars`);
        assert.match(data.message, /truncated/);
    });
});

// --- outgoing cap ----------------------------------------------------------

describe('native frame outgoing cap', () => {
    it('caps at 16 MiB', () => {
        assert.strictEqual(MAX_FRAME_BYTES, 16 * 1024 * 1024);
    });

    it('accepts a payload of exactly the cap and rejects one byte more', () => {
        // `{"p":"<pad>"}` — 8 bytes of punctuation around an ASCII string.
        const overhead = JSON.stringify({ p: '' }).length;
        const atCap = encodeFrame({ p: 'a'.repeat(MAX_FRAME_BYTES - overhead) });
        assert.strictEqual(readFrameHeader(atCap), MAX_FRAME_BYTES);

        assert.throws(
            () => encodeFrame({ p: 'a'.repeat(MAX_FRAME_BYTES - overhead + 1) }),
            (error: unknown) => {
                assert.ok(isNativeFrameError(error));
                const framed = error as NativeFrameError;
                assert.strictEqual(framed.code, NATIVE_FRAME_TOO_LARGE);
                assert.strictEqual(framed.direction, 'outgoing');
                assert.strictEqual(framed.limitBytes, MAX_FRAME_BYTES);
                assert.strictEqual(framed.actualBytes, MAX_FRAME_BYTES + 1);
                return true;
            }
        );
    });

    it('counts UTF-8 bytes, not code units', () => {
        // Each 'é' is one code unit but two UTF-8 bytes; a code-unit cap would
        // let a frame twice the limit through.
        const limit = 64;
        assert.throws(
            () => encodeFrame({ p: 'é'.repeat(40) }, { maxFrameBytes: limit }),
            (error: unknown) => isNativeFrameError(error)
                && (error as NativeFrameError).actualBytes! > limit
        );
    });
});

// --- reassembly ------------------------------------------------------------

describe('native frame reassembly', () => {
    const frames = [
        encodeFrame({ n: 1 }),
        encodeFrame({ n: 2, blob: new Uint8Array([1, 2, 3]) }),
        encodeFrame({ n: 3n })
    ];
    const expected = [
        { n: 1 },
        { n: 2, blob: new Uint8Array([1, 2, 3]) },
        { n: 3n }
    ];

    it('reassembles a 1-byte drip feed', () => {
        const { reader, sink } = collect();
        const stream = concat(...frames);
        for (const byte of stream) reader.push(new Uint8Array([byte]));
        reader.end();

        assert.deepStrictEqual(sink.errors, []);
        assert.deepStrictEqual(sink.messages, expected);
    });

    it('splits coalesced frames delivered in one chunk', () => {
        const { reader, sink } = collect();
        reader.push(concat(...frames));
        reader.end();

        assert.deepStrictEqual(sink.errors, []);
        assert.deepStrictEqual(sink.messages, expected);
    });

    it('retains a leftover tail when a chunk ends mid-frame', () => {
        const { reader, sink } = collect();
        const stream = concat(...frames);
        const cut = frames[0].length + 3;
        reader.push(stream.subarray(0, cut));
        assert.strictEqual(sink.messages.length, 1);
        reader.push(stream.subarray(cut));
        reader.end();

        assert.deepStrictEqual(sink.errors, []);
        assert.deepStrictEqual(sink.messages, expected);
    });

    it('reassembles a header split 2 + 2 across three chunks', () => {
        const { reader, sink } = collect();
        const frame = frames[1];
        reader.push(frame.subarray(0, 2));
        reader.push(frame.subarray(2, 4));
        reader.push(frame.subarray(4));
        reader.end();

        assert.deepStrictEqual(sink.errors, []);
        assert.deepStrictEqual(sink.messages, [expected[1]]);
    });

    it('ignores zero-length chunks without treating them as EOF', () => {
        const { reader, sink } = collect();
        reader.push(new Uint8Array(0));
        reader.push(frames[0]);
        reader.push(new Uint8Array(0));
        reader.end();

        assert.deepStrictEqual(sink.errors, []);
        assert.deepStrictEqual(sink.messages, [expected[0]]);
    });

    it('reassembles a 256 KiB payload across many chunks', () => {
        const { reader, sink } = collect();
        const big = { p: 'x'.repeat(256 * 1024) };
        const frame = encodeFrame(big);
        for (let offset = 0; offset < frame.length; offset += 4096) {
            reader.push(frame.subarray(offset, Math.min(offset + 4096, frame.length)));
        }
        reader.end();

        assert.deepStrictEqual(sink.errors, []);
        assert.deepStrictEqual(sink.messages, [big]);
    });

    it('reports a truncated trailing frame at EOF instead of dropping it', () => {
        const { reader, sink } = collect();
        reader.push(frames[0].subarray(0, frames[0].length - 1));
        assert.strictEqual(sink.errors.length, 0, 'a partial frame is not an error until EOF');
        reader.end();

        assert.strictEqual(sink.messages.length, 0);
        assert.strictEqual(sink.errors.length, 1);
        assert.strictEqual(sink.errors[0].code, NATIVE_FRAME_MALFORMED);
        assert.match(sink.errors[0].message, /truncated/i);
    });

    it('reports nothing at a clean EOF', () => {
        const { reader, sink } = collect();
        reader.push(frames[0]);
        reader.end();
        assert.deepStrictEqual(sink.errors, []);
    });
});

// --- incoming cap ----------------------------------------------------------

describe('native frame incoming cap', () => {
    it('drains an oversize frame and resynchronises on the next one', () => {
        const { reader, sink } = collect({ maxFrameBytes: 64 });
        const doomed = rawFrame(new Uint8Array(200).fill(0x41));
        const good = encodeFrame({ n: 'after' }, { maxFrameBytes: 64 });

        reader.push(concat(doomed, good));
        reader.end();

        assert.strictEqual(sink.errors.length, 1);
        assert.strictEqual(sink.errors[0].code, NATIVE_FRAME_TOO_LARGE);
        assert.strictEqual(sink.errors[0].direction, 'incoming');
        assert.strictEqual(sink.errors[0].actualBytes, 200);
        assert.strictEqual(sink.errors[0].limitBytes, 64);
        assert.deepStrictEqual(sink.messages, [{ n: 'after' }]);
    });

    it('drains in O(1) memory rather than buffering the doomed bytes', () => {
        const { reader, sink } = collect({ maxFrameBytes: 64 });
        reader.push(encodeFrameHeader(1_000_000));
        assert.strictEqual(sink.errors.length, 1);
        assert.strictEqual(reader.skipRemainingBytes, 1_000_000);

        for (let sent = 0; sent < 1_000_000; sent += 100_000) {
            reader.push(new Uint8Array(100_000));
            assert.strictEqual(reader.bufferedBytes, 0, 'doomed bytes must never be retained');
        }
        assert.strictEqual(reader.skipRemainingBytes, 0);

        reader.push(encodeFrame({ n: 'after' }, { maxFrameBytes: 64 }));
        assert.deepStrictEqual(sink.messages, [{ n: 'after' }]);
        assert.strictEqual(sink.errors.length, 1, 'one error per oversize frame, not per chunk');
    });

    it('drains an oversize frame split across the skip boundary', () => {
        const { reader, sink } = collect({ maxFrameBytes: 16 });
        const good = encodeFrame({ n: 1 }, { maxFrameBytes: 16 });
        const stream = concat(rawFrame(new Uint8Array(40).fill(9)), good);
        // Chunk boundary lands inside the doomed payload AND straddles its tail
        // plus the head of the good frame.
        reader.push(stream.subarray(0, 20));
        reader.push(stream.subarray(20));
        reader.end();

        assert.strictEqual(sink.errors.length, 1);
        assert.deepStrictEqual(sink.messages, [{ n: 1 }]);
    });

    it('enforces the real 16 MiB cap on the declared length', () => {
        const { reader, sink } = collect();
        reader.push(encodeFrameHeader(MAX_FRAME_BYTES + 1));
        assert.strictEqual(sink.errors.length, 1);
        assert.strictEqual(sink.errors[0].actualBytes, MAX_FRAME_BYTES + 1);
        assert.strictEqual(sink.errors[0].limitBytes, MAX_FRAME_BYTES);
        assert.strictEqual(reader.skipRemainingBytes, MAX_FRAME_BYTES + 1);
    });
});

// --- malformed payloads ----------------------------------------------------

describe('native frame malformed payloads', () => {
    it('reports a JSON parse failure and keeps the stream alive', () => {
        const { reader, sink } = collect();
        reader.push(concat(rawFrame(utf8('{"unterminated":')), encodeFrame({ n: 'after' })));
        reader.end();

        assert.strictEqual(sink.errors.length, 1);
        assert.strictEqual(sink.errors[0].code, NATIVE_FRAME_MALFORMED);
        assert.strictEqual(sink.errors[0].direction, 'incoming');
        assert.deepStrictEqual(sink.messages, [{ n: 'after' }]);
    });

    it('reports invalid UTF-8 rather than substituting replacement characters', () => {
        const { reader, sink } = collect();
        reader.push(concat(rawFrame(new Uint8Array([0xff, 0xfe])), encodeFrame({ n: 'after' })));
        reader.end();

        assert.strictEqual(sink.errors.length, 1);
        assert.strictEqual(sink.errors[0].code, NATIVE_FRAME_MALFORMED);
        assert.deepStrictEqual(sink.messages, [{ n: 'after' }]);
    });

    it('reports a zero-length frame without desynchronising', () => {
        const { reader, sink } = collect();
        reader.push(concat(encodeFrameHeader(0), encodeFrame({ n: 'after' })));
        reader.end();

        assert.strictEqual(sink.errors.length, 1);
        assert.deepStrictEqual(sink.messages, [{ n: 'after' }]);
    });

    it('answers a deeply nested payload instead of dying on the stack', () => {
        // Verified on the real binary: tjs 26.6.0's JSON.parse throws a
        // catchable RangeError past ~1k levels rather than aborting, so this
        // stays an error frame instead of a dead sidecar.
        const { reader, sink } = collect();
        const bomb = utf8('['.repeat(200_000) + ']'.repeat(200_000));
        reader.push(concat(rawFrame(bomb), encodeFrame({ n: 'after' })));
        reader.end();

        assert.strictEqual(sink.errors.length, 1);
        assert.strictEqual(sink.errors[0].code, NATIVE_FRAME_MALFORMED);
        assert.deepStrictEqual(sink.messages, [{ n: 'after' }]);
    });

    it('reports a bad tagged value without losing the rest of the stream', () => {
        const { reader, sink } = collect();
        reader.push(concat(
            rawFrame(utf8('{"v":{"__type":"BigInt","decimal":"nope"}}')),
            encodeFrame({ n: 'after' })
        ));
        reader.end();

        assert.strictEqual(sink.errors.length, 1);
        assert.strictEqual(sink.errors[0].code, NATIVE_FRAME_MALFORMED);
        assert.deepStrictEqual(sink.messages, [{ n: 'after' }]);
    });
});

// --- error envelope --------------------------------------------------------

describe('native frame error envelope', () => {
    it('matches the worker response envelope shape', () => {
        const error = new Error('constraint failed');
        Object.defineProperty(error, 'errno', { value: 19, enumerable: false });

        assert.deepStrictEqual(frameErrorResponse(error, 'm-7'), {
            channel: 'rpc',
            content: {
                kind: 'response',
                messageId: 'm-7',
                success: false,
                errorMessage: 'constraint failed',
                error: { name: 'Error', message: 'constraint failed', errno: 19 }
            }
        });
    });

    it('uses a null messageId when the frame was never parseable', () => {
        const response = frameErrorResponse(new Error('nope'));
        assert.strictEqual(response.content.messageId, null);
        assert.strictEqual(response.content.success, false);
    });

    it('survives its own frame round-trip', () => {
        const error = new Error('unable to open database file');
        Object.defineProperty(error, 'errno', { value: 14, enumerable: false });
        const decoded = decodeOneFrame(encodeFrame(frameErrorResponse(error, 'm-9'))) as {
            content: { errorMessage: string; error: { errno: number } };
        };
        assert.strictEqual(decoded.content.errorMessage, 'unable to open database file');
        assert.strictEqual(decoded.content.error.errno, 14);
    });
});

// --- stdio transport -------------------------------------------------------

/** Minimal WHATWG-shaped stdin/stdout pair matching what the probe found on tjs 26.6.0. */
function fakeStdio() {
    const inbound: Array<{ value?: Uint8Array; done: boolean }> = [];
    let pendingRead: ((result: { value?: Uint8Array; done: boolean }) => void) | null = null;
    const written: Uint8Array[] = [];
    let writeError: Error | null = null;

    const deliver = (result: { value?: Uint8Array; done: boolean }) => {
        if (pendingRead) {
            const resolve = pendingRead;
            pendingRead = null;
            resolve(result);
        } else {
            inbound.push(result);
        }
    };

    return {
        written,
        failWrites(error: Error) { writeError = error; },
        push(chunk: Uint8Array) { deliver({ value: chunk, done: false }); },
        eof() { deliver({ value: undefined, done: true }); },
        stdin: {
            getReader: () => ({
                read: () => inbound.length > 0
                    ? Promise.resolve(inbound.shift()!)
                    : new Promise<{ value?: Uint8Array; done: boolean }>((resolve) => { pendingRead = resolve; })
            })
        },
        stdout: {
            getWriter: () => ({
                write: async (bytes: Uint8Array) => {
                    if (writeError) throw writeError;
                    written.push(bytes.slice());
                }
            })
        }
    };
}

/** Let the transport's read loop and write chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('native stdio transport', () => {
    it('delivers decoded envelopes to onmessage as worker-shaped events', async () => {
        const io = fakeStdio();
        const transport = createStdioTransport({ stdin: io.stdin, stdout: io.stdout });
        const seen: unknown[] = [];
        transport.onmessage = (event) => { seen.push(event.data); };
        const running = transport.start();

        io.push(encodeFrame(ENVELOPE));
        await settle();
        assert.deepStrictEqual(seen, [ENVELOPE]);

        io.eof();
        await running;
    });

    it('frames outgoing messages onto stdout', async () => {
        const io = fakeStdio();
        const transport = createStdioTransport({ stdin: io.stdin, stdout: io.stdout });
        const running = transport.start();

        transport.postMessage({ channel: 'rpc', content: { kind: 'response', messageId: 'm-1', success: true, data: 5n } });
        await settle();

        assert.strictEqual(io.written.length, 1);
        const decoded = decodeOneFrame(io.written[0]) as { content: { data: bigint } };
        assert.strictEqual(decoded.content.data, 5n);

        io.eof();
        await running;
    });

    it('throws synchronously on an oversize outgoing message so the caller can answer', async () => {
        const io = fakeStdio();
        const transport = createStdioTransport({
            stdin: io.stdin,
            stdout: io.stdout,
            maxFrameBytes: 64
        });
        const running = transport.start();

        assert.throws(
            () => transport.postMessage({ p: 'x'.repeat(200) }),
            (error: unknown) => isNativeFrameError(error)
                && (error as NativeFrameError).direction === 'outgoing'
        );
        await settle();
        assert.strictEqual(io.written.length, 0);

        io.eof();
        await running;
    });

    it('answers an oversize incoming frame in-band and stays alive', async () => {
        const io = fakeStdio();
        const limit = 4096;
        const transport = createStdioTransport({
            stdin: io.stdin,
            stdout: io.stdout,
            maxFrameBytes: limit
        });
        const seen: unknown[] = [];
        transport.onmessage = (event) => { seen.push(event.data); };
        const running = transport.start();

        io.push(rawFrame(new Uint8Array(limit * 2).fill(0x41)));
        await settle();
        assert.strictEqual(io.written.length, 1);
        const reply = decodeOneFrame(io.written[0]) as {
            content: { kind: string; messageId: null; success: boolean; error: { code: string } };
        };
        assert.strictEqual(reply.content.kind, 'response');
        assert.strictEqual(reply.content.messageId, null);
        assert.strictEqual(reply.content.success, false);
        assert.strictEqual(reply.content.error.code, NATIVE_FRAME_TOO_LARGE);

        io.push(encodeFrame({ n: 'after' }, { maxFrameBytes: limit }));
        await settle();
        assert.deepStrictEqual(seen, [{ n: 'after' }]);

        io.eof();
        await running;
    });

    it('keeps reading when even the in-band error frame cannot be encoded', async () => {
        // Degenerate limit: no envelope fits, so the error answer itself is
        // unsendable. The read loop must survive it — a throw out of the frame
        // reader's callback would leave the sidecar deaf to every later request.
        const io = fakeStdio();
        const failures: unknown[] = [];
        const transport = createStdioTransport({
            stdin: io.stdin,
            stdout: io.stdout,
            maxFrameBytes: 64,
            onTransportError: (error) => { failures.push(error); }
        });
        const seen: unknown[] = [];
        transport.onmessage = (event) => { seen.push(event.data); };
        const running = transport.start();

        io.push(rawFrame(new Uint8Array(200).fill(0x41)));
        await settle();
        assert.strictEqual(failures.length, 1);
        assert.ok(isNativeFrameError(failures[0]));
        assert.strictEqual(io.written.length, 0);

        io.push(encodeFrame({ n: 'after' }, { maxFrameBytes: 64 }));
        await settle();
        assert.deepStrictEqual(seen, [{ n: 'after' }]);

        io.eof();
        await running;
    });

    it('fires onEof exactly once at stdin EOF — the orphan signal', async () => {
        const io = fakeStdio();
        let eofCount = 0;
        const transport = createStdioTransport({
            stdin: io.stdin,
            stdout: io.stdout,
            onEof: () => { eofCount += 1; }
        });
        const running = transport.start();

        io.eof();
        await running;
        await settle();
        assert.strictEqual(eofCount, 1);
    });

    it('reports write failures instead of dropping them', async () => {
        const io = fakeStdio();
        const failures: unknown[] = [];
        const transport = createStdioTransport({
            stdin: io.stdin,
            stdout: io.stdout,
            onTransportError: (error) => { failures.push(error); }
        });
        const running = transport.start();
        io.failWrites(new Error('EPIPE'));

        transport.postMessage({ n: 1 });
        await settle();
        assert.strictEqual(failures.length, 1);
        assert.match(String((failures[0] as Error).message), /EPIPE/);

        io.eof();
        await running;
    });

    it('serialises concurrent writes in call order', async () => {
        const io = fakeStdio();
        const transport = createStdioTransport({ stdin: io.stdin, stdout: io.stdout });
        const running = transport.start();

        transport.postMessage({ n: 1 });
        transport.postMessage({ n: 2 });
        transport.postMessage({ n: 3 });
        await settle();

        assert.deepStrictEqual(io.written.map((frame) => decodeOneFrame(frame)), [
            { n: 1 }, { n: 2 }, { n: 3 }
        ]);

        io.eof();
        await running;
    });
});

// --- cross-language fixture ------------------------------------------------

describe('cross-language frame fixture', () => {
    const fixtureDir = path.resolve(process.cwd(), 'tests', 'fixtures');
    const binPath = path.join(fixtureDir, `${FIXTURE_BASENAME}.bin`);
    const manifestPath = path.join(fixtureDir, `${FIXTURE_BASENAME}.json`);

    it('is committed and byte-identical to what the codec produces today', () => {
        const built = buildFrameFixture();
        assert.deepStrictEqual(
            Array.from(fs.readFileSync(binPath)),
            Array.from(built.bytes),
            'tests/fixtures is stale — regenerate it; Task 5 Rust decodes these exact bytes'
        );
        assert.deepStrictEqual(
            JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
            built.manifest
        );
    });

    it('decodes back through the reader, frame for frame', () => {
        const built = buildFrameFixture();
        const { reader, sink } = collect();
        reader.push(new Uint8Array(fs.readFileSync(binPath)));
        reader.end();

        assert.deepStrictEqual(sink.errors, []);
        assert.strictEqual(sink.messages.length, built.manifest.frames.length);
        for (const [index, frame] of built.manifest.frames.entries()) {
            const raw = built.bytes.subarray(
                frame.offset + FRAME_HEADER_BYTES,
                frame.offset + FRAME_HEADER_BYTES + frame.payloadBytes
            );
            assert.strictEqual(readFrameHeader(built.bytes, frame.offset), frame.payloadBytes);
            assert.strictEqual(new TextDecoder().decode(raw), frame.payloadUtf8, frame.label);
            assert.ok(sink.messages[index] !== undefined, frame.label);
        }
    });

    it('pins the 16 MiB boundary as real header bytes', () => {
        const { manifest } = buildFrameFixture();
        assert.strictEqual(manifest.limits.maxFrameBytes, MAX_FRAME_BYTES);
        assert.deepStrictEqual(
            manifest.limits.maxHeader,
            Array.from(encodeFrameHeader(MAX_FRAME_BYTES))
        );
        assert.deepStrictEqual(
            manifest.limits.overMaxHeader,
            Array.from(encodeFrameHeader(MAX_FRAME_BYTES + 1))
        );
    });
});
