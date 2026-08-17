/**
 * Node-side half of the frame lane: drives `native-frame-harness.js` inside the
 * REAL fork binary over real pipes.
 *
 * What this proves that the unit suite structurally cannot: the codec survives
 * whatever chunking the OS pipe actually produces (the unit suite chooses its
 * own chunk boundaries), the 16 MiB drain resynchronises against a real writer
 * rather than a synthetic one, and stdin EOF shuts the process down cleanly.
 *
 * It deliberately does NOT try to prove the codec correct by round-tripping
 * through itself — encode and decode agreeing is self-consistency, not
 * correctness. Byte-level correctness is pinned by `tests/fixtures/native-frames.bin`,
 * which the Rust parent decodes independently. The two raw-byte echo checks
 * below are the exception: they compare bytes on the wire to bytes sent, with
 * no decode in the loop.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import {
    FRAME_HEADER_BYTES,
    MAX_FRAME_BYTES,
    NATIVE_FRAME_DESYNC,
    NATIVE_FRAME_MALFORMED,
    NATIVE_FRAME_TOO_LARGE,
    createFrameReader,
    encodeFrame,
    encodeFrameHeader
} from '../../core/native/frame-codec.js';

const HARNESS_SOURCE = path.join(path.dirname(new URL(import.meta.url).pathname), 'native-frame-harness.js');

/**
 * Bundle the harness the way the sidecar itself is bundled: one ESM file with
 * the TypeScript-sourced sentinel helpers inlined, since tjs resolves neither
 * `.ts` nor bare specifiers.
 */
async function bundleHarness(scratch) {
    const outfile = path.join(scratch, 'frame-harness.bundle.js');
    await esbuild.build({
        entryPoints: [HARNESS_SOURCE],
        outfile,
        bundle: true,
        format: 'esm',
        platform: 'neutral',
        target: 'es2022',
        external: ['tjs:*'],
        loader: { '.js': 'js', '.ts': 'ts' }
    });
    return outfile;
}

function equalBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
    return true;
}

function concat(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
}

/** Spawned child + a queue of decoded replies and their raw bytes. */
function startHarness(binary, bundlePath) {
    const child = spawn(binary, ['run', bundlePath], { stdio: ['pipe', 'pipe', 'pipe'] });

    const replies = [];
    const rawReplies = [];
    let waiter = null;
    let stderr = '';
    let exit = null;

    const wake = () => {
        if (waiter && replies.length >= waiter.count) {
            const resolve = waiter.resolve;
            waiter = null;
            resolve();
        }
    };

    // A second reader over the child's stdout, used only to capture raw frame
    // bytes for the byte-identity checks. Appends into a growable buffer and
    // tracks a read offset — reconcatenating per chunk would be O(n^2) over
    // the 16 MiB frames this lane sends.
    let rawBuffer = new Uint8Array(64 * 1024);
    let rawEnd = 0;    // bytes written into rawBuffer
    let rawStart = 0;  // bytes already consumed as complete frames
    const captureRaw = (chunk) => {
        if (rawEnd + chunk.length > rawBuffer.length) {
            // Reclaim consumed bytes first, then grow only if still short.
            if (rawStart > 0) {
                rawBuffer.copyWithin(0, rawStart, rawEnd);
                rawEnd -= rawStart;
                rawStart = 0;
            }
            if (rawEnd + chunk.length > rawBuffer.length) {
                let capacity = rawBuffer.length * 2;
                while (capacity < rawEnd + chunk.length) capacity *= 2;
                const grown = new Uint8Array(capacity);
                grown.set(rawBuffer.subarray(0, rawEnd));
                rawBuffer = grown;
            }
        }
        rawBuffer.set(chunk, rawEnd);
        rawEnd += chunk.length;

        for (;;) {
            if (rawEnd - rawStart < FRAME_HEADER_BYTES) return;
            const view = new DataView(rawBuffer.buffer, rawBuffer.byteOffset + rawStart, FRAME_HEADER_BYTES);
            const total = FRAME_HEADER_BYTES + view.getUint32(0, false);
            if (rawEnd - rawStart < total) return;
            rawReplies.push(rawBuffer.slice(rawStart, rawStart + total));
            rawStart += total;
        }
    };

    const reader = createFrameReader(
        (message) => { replies.push({ ok: message }); wake(); },
        (error) => { replies.push({ readerError: error }); wake(); }
    );

    child.stdout.on('data', (chunk) => {
        const bytes = new Uint8Array(chunk);
        captureRaw(bytes);
        reader.push(bytes);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    // The desync case deliberately writes into a sidecar that is shutting down,
    // so EPIPE here is the EXPECTED outcome, not a lane failure — it is the
    // proof that the peer closed rather than sat alive and deaf. Unhandled, it
    // would throw out of the stream.
    child.stdin.on('error', (error) => { stderr += `[stdin] ${error.code ?? error.message}\n`; });
    child.on('close', (code) => {
        exit = code;
        reader.end();
        if (waiter) { const resolve = waiter.resolve; waiter = null; resolve(); }
    });

    return {
        child,
        get stderr() { return stderr; },
        get exitCode() { return exit; },
        replies,
        rawReplies,
        write(bytes) { child.stdin.write(Buffer.from(bytes)); },
        /** Resolve once `count` total replies have arrived (or the child died). */
        untilReplies(count, timeoutMs = 30000) {
            if (replies.length >= count || exit !== null) return Promise.resolve();
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    waiter = null;
                    reject(new Error(`timed out waiting for reply ${count} (have ${replies.length})`));
                }, timeoutMs);
                waiter = { count, resolve: () => { clearTimeout(timer); resolve(); } };
            });
        },
        endStdin() { child.stdin.end(); },
        untilExit() {
            return exit !== null
                ? Promise.resolve(exit)
                : new Promise((resolve) => child.on('close', resolve));
        }
    };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{binary: string, scratch: string, note: (ok: boolean, label: string, detail?: string) => void}} context
 * @returns {Promise<number>} number of checks run
 */
export async function runFrameLane({ binary, scratch, note }) {
    const bundlePath = await bundleHarness(scratch);
    note(fs.existsSync(bundlePath), 'frame/harness-bundles', '');

    const harness = startHarness(binary, bundlePath);
    let checks = 1;
    // Replies are consumed strictly in order; `take` keeps the case list free
    // of hand-maintained indices so inserting a case cannot silently shift the
    // assertions of every case after it.
    let cursor = 0;
    const take = async (timeoutMs) => {
        await harness.untilReplies(cursor + 1, timeoutMs);
        const reply = harness.replies[cursor];
        const raw = harness.rawReplies[cursor];
        cursor += 1;
        return { value: reply?.ok, raw: raw ?? new Uint8Array(), readerError: reply?.readerError };
    };

    try {
        // 1. one frame, one write -- and the echo is byte-identical.
        const simple = encodeFrame({ channel: 'rpc', content: { kind: 'invoke', messageId: 's1', targetMethod: 'ping', payload: [] } });
        harness.write(simple);
        note(equalBytes((await take()).raw, simple), 'frame/single-write-byte-identical');
        checks += 1;

        // 2. two frames coalesced into ONE write -- leftover-tail retention.
        harness.write(concat([encodeFrame({ n: 'coalesced-a' }), encodeFrame({ n: 'coalesced-b' })]));
        const first = await take();
        const second = await take();
        note(first.value?.n === 'coalesced-a' && second.value?.n === 'coalesced-b',
            'frame/coalesced-write-splits',
            JSON.stringify([first.value, second.value]));
        checks += 1;

        // 3. 256 KiB payload -- reassembled across many pipe chunks, bytes intact.
        const bigFrame = encodeFrame({ n: 'big', p: 'x'.repeat(256 * 1024) });
        harness.write(bigFrame);
        note(equalBytes((await take()).raw, bigFrame),
            'frame/256KiB-byte-identical', `${bigFrame.length} bytes`);
        checks += 1;

        // 4. 1-byte drip feed.
        const drip = encodeFrame({ n: 'drip', v: 42 });
        for (const byte of drip) { harness.write(new Uint8Array([byte])); }
        const dripped = (await take()).value;
        note(dripped?.n === 'drip' && dripped?.v === 42, 'frame/1-byte-drip-feed');
        checks += 1;

        // 5. header split 2 + 2 across three writes.
        const split = encodeFrame({ n: 'split-header' });
        harness.write(split.subarray(0, 2));
        await sleep(5);
        harness.write(split.subarray(2, 4));
        await sleep(5);
        harness.write(split.subarray(4));
        note((await take()).value?.n === 'split-header', 'frame/header-split-2+2');
        checks += 1;

        // 6. tagged values survive the real binary: int64 edges, blob, non-finite, errno.
        const tagged = {
            channel: 'rpc',
            content: {
                kind: 'response',
                messageId: 't1',
                success: true,
                data: {
                    ints: [9007199254740991, 9007199254740992n, 9223372036854775807n, -9223372036854775808n],
                    blob: new Uint8Array([0, 1, 0x7f, 0x80, 0xff]),
                    reals: [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN],
                    text: '~sqlite-explorer-non-finite:NaN',
                    error: { name: 'Error', message: 'constraint failed', errno: 19 }
                }
            }
        };
        harness.write(encodeFrame(tagged));
        const echoed = (await take()).value?.content?.data;
        const taggedOk = echoed
            && echoed.ints[0] === 9007199254740991 && typeof echoed.ints[0] === 'number'
            && echoed.ints[1] === 9007199254740992n
            && echoed.ints[2] === 9223372036854775807n
            && echoed.ints[3] === -9223372036854775808n
            && echoed.blob instanceof Uint8Array && equalBytes(echoed.blob, tagged.content.data.blob)
            && echoed.reals[0] === Infinity && echoed.reals[1] === -Infinity && Number.isNaN(echoed.reals[2])
            && echoed.text === '~sqlite-explorer-non-finite:NaN'
            && echoed.error.errno === 19;
        note(!!taggedOk, 'frame/tagged-values-survive-the-binary',
            taggedOk ? '' : JSON.stringify(echoed, (_key, v) => (typeof v === 'bigint' ? `${v}n` : v)));
        checks += 1;

        // 7. malformed JSON -- in-band error frame, stream survives.
        const garbage = new TextEncoder().encode('{"unterminated":');
        harness.write(concat([encodeFrameHeader(garbage.length), garbage]));
        const malformedReply = (await take()).value?.content;
        note(malformedReply?.success === false
            && malformedReply?.error?.code === NATIVE_FRAME_MALFORMED
            && malformedReply?.messageId === null,
            'frame/malformed-json-answers-in-band',
            JSON.stringify(malformedReply));
        checks += 1;

        harness.write(encodeFrame({ n: 'after-malformed' }));
        note((await take()).value?.n === 'after-malformed', 'frame/stream-alive-after-malformed');
        checks += 1;

        // 7b. Deep-nesting bomb. tjs's JSON.parse must throw catchably rather
        //     than abort the process -- otherwise a single hostile envelope
        //     from the webview kills the sidecar.
        const bomb = new TextEncoder().encode('['.repeat(200_000) + ']'.repeat(200_000));
        harness.write(concat([encodeFrameHeader(bomb.length), bomb]));
        const bombReply = (await take()).value?.content;
        note(bombReply?.error?.code === NATIVE_FRAME_MALFORMED,
            'frame/deep-nesting-answers-in-band', JSON.stringify(bombReply?.errorMessage));
        checks += 1;

        harness.write(encodeFrame({ n: 'after-bomb' }));
        note((await take()).value?.n === 'after-bomb', 'frame/sidecar-survives-nesting-bomb');
        checks += 1;

        // 7c. `__proto__` must arrive as ordinary data, not as a prototype swap.
        const hostile = new TextEncoder().encode('{"__proto__":{"polluted":1},"n":"proto"}');
        harness.write(concat([encodeFrameHeader(hostile.length), hostile]));
        const protoReply = (await take()).value;
        note(protoReply?.n === 'proto'
            && protoReply?.polluted === undefined
            && Object.getPrototypeOf(protoReply) === Object.prototype,
            'frame/__proto__-does-not-retarget', JSON.stringify(protoReply));
        checks += 1;

        // 8. OVERSIZE INCOMING: declare 16 MiB + 1 and then actually send it.
        //    The sidecar must answer in band, DRAIN every doomed byte, and
        //    resynchronise exactly on the next frame boundary.
        const oversize = MAX_FRAME_BYTES + 1;
        harness.write(encodeFrameHeader(oversize));
        const filler = new Uint8Array(1024 * 1024).fill(0x41);
        for (let sent = 0; sent < oversize; sent += filler.length) {
            harness.write(filler.subarray(0, Math.min(filler.length, oversize - sent)));
        }
        const oversizeReply = (await take(60000)).value?.content;
        note(oversizeReply?.success === false
            && oversizeReply?.error?.code === NATIVE_FRAME_TOO_LARGE,
            'frame/oversize-incoming-answers-in-band',
            JSON.stringify(oversizeReply));
        checks += 1;

        harness.write(encodeFrame({ n: 'after-oversize' }));
        const afterOversize = (await take(60000)).value;
        note(afterOversize?.n === 'after-oversize',
            'frame/resynchronises-after-draining-16MiB',
            JSON.stringify(afterOversize));
        checks += 1;

        // 9. boundary: a payload of EXACTLY 16 MiB is accepted and echoed.
        const overhead = JSON.stringify({ n: 'boundary', p: '' }).length;
        const boundary = encodeFrame({ n: 'boundary', p: 'B'.repeat(MAX_FRAME_BYTES - overhead) });
        note(boundary.length === FRAME_HEADER_BYTES + MAX_FRAME_BYTES,
            'frame/boundary-frame-is-exactly-16MiB', `${boundary.length} bytes`);
        checks += 1;
        harness.write(boundary);
        note(equalBytes((await take(60000)).raw, boundary),
            'frame/boundary-frame-echoes-byte-identical');
        checks += 1;

        // 10. stdin EOF -- clean exit, the same path the orphan guard uses.
        harness.endStdin();
        const code = await harness.untilExit();
        note(code === 0, 'frame/stdin-eof-exits-clean', `exit ${code}`);
        checks += 1;
    } finally {
        if (harness.exitCode === null) harness.child.kill('SIGKILL');
        const stderrText = harness.stderr.trim();
        if (stderrText) console.log(`[frame harness stderr]\n${stderrText}\n`);
    }

    // 11. GARBAGE HEADER -> fatal desync. Needs its own process: the fatal path
    //     stops reading for good, so nothing after it could be checked in the
    //     harness above. This is the corrupt-header case a drain-everything
    //     reader would answer by silently eating the next 4 GiB.
    checks += await runDesyncCase(binary, bundlePath, note);

    return checks;
}

/**
 * @returns {Promise<number>} checks run
 */
async function runDesyncCase(binary, bundlePath, note) {
    const harness = startHarness(binary, bundlePath);
    let checks = 0;
    try {
        // 0xffffffff: the largest length a u32 can express, and 256x the cap.
        harness.write(encodeFrameHeader(0xffffffff));
        // A well-formed frame right behind it. A drain-everything reader would
        // swallow this; the fatal path must never deliver it.
        harness.write(encodeFrame({ n: 'must-not-be-delivered' }));

        await harness.untilReplies(1, 30000);
        const reply = harness.replies[0]?.ok?.content;
        note(reply?.success === false && reply?.error?.code === NATIVE_FRAME_DESYNC,
            'frame/garbage-header-is-fatal-desync',
            JSON.stringify(reply?.errorMessage));
        checks += 1;

        // The sidecar must shut itself down rather than sit alive and deaf --
        // exiting closes the pipe, so the parent sees EOF instead of blocking.
        // Nothing is written to stdin here: a hang would mean a deaf-alive peer.
        const code = await Promise.race([
            harness.untilExit(),
            sleep(15000).then(() => 'TIMEOUT')
        ]);
        note(code !== 'TIMEOUT', 'frame/desync-shuts-down-without-hanging', `exit ${code}`);
        checks += 1;

        note(harness.replies.length === 1,
            'frame/desync-delivers-nothing-after-the-fatal-frame',
            `${harness.replies.length} replies: ${JSON.stringify(harness.replies.map((r) => r.ok))}`);
        checks += 1;
    } finally {
        if (harness.exitCode === null) harness.child.kill('SIGKILL');
        const stderrText = harness.stderr.trim();
        if (stderrText) console.log(`[desync harness stderr]\n${stderrText}\n`);
    }
    return checks;
}
