import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface StreamReadResult {
    value?: Uint8Array;
    done: boolean;
}

type ExactReader = (buffer: Uint8Array) => Promise<number>;
type ExactReaderFactory = (
    readChunk: () => Promise<StreamReadResult>
) => ExactReader;

const nativeWorkerSource = fs.readFileSync(
    path.resolve(process.cwd(), 'natives', 'native-worker.js'),
    'utf8'
);

function loadExactReaderFactory(): ExactReaderFactory {
    const signature = 'function createExactReader(readChunk)';
    const functionSource = nativeWorkerSource.match(
        /function createExactReader\(readChunk\) \{[\s\S]*?^\}/m
    )?.[0];
    assert.ok(
        functionSource,
        `native worker should define the injectable helper ${signature}`
    );
    return Function(`"use strict"; return (${functionSource});`)() as ExactReaderFactory;
}

function chunks(...values: number[][]): () => Promise<StreamReadResult> {
    let index = 0;
    return async () => index < values.length
        ? { value: new Uint8Array(values[index++]), done: false }
        : { value: undefined, done: true };
}

async function read(exactReader: ExactReader, size: number): Promise<{ count: number; bytes: number[] }> {
    const buffer = new Uint8Array(size);
    const count = await exactReader(buffer);
    return { count, bytes: Array.from(buffer.subarray(0, count)) };
}

describe('native worker stream chunk reassembly', () => {
    it('reassembles a header split across arbitrary chunks', async () => {
        const exactReader = loadExactReaderFactory()(chunks([0], [0, 0], [5]));

        assert.deepStrictEqual(await read(exactReader, 4), {
            count: 4,
            bytes: [0, 0, 0, 5]
        });
    });

    it('reassembles a payload split across arbitrary chunks', async () => {
        const exactReader = loadExactReaderFactory()(chunks([10, 11], [12], [13, 14]));

        assert.deepStrictEqual(await read(exactReader, 5), {
            count: 5,
            bytes: [10, 11, 12, 13, 14]
        });
    });

    it('retains coalesced bytes for multiple messages', async () => {
        const exactReader = loadExactReaderFactory()(chunks([
            0, 0, 0, 2, 10, 11,
            0, 0, 0, 3, 20, 21, 22
        ]));

        assert.deepStrictEqual(await read(exactReader, 4), { count: 4, bytes: [0, 0, 0, 2] });
        assert.deepStrictEqual(await read(exactReader, 2), { count: 2, bytes: [10, 11] });
        assert.deepStrictEqual(await read(exactReader, 4), { count: 4, bytes: [0, 0, 0, 3] });
        assert.deepStrictEqual(await read(exactReader, 3), { count: 3, bytes: [20, 21, 22] });
        assert.deepStrictEqual(await read(exactReader, 4), { count: 0, bytes: [] });
    });

    it('returns the partial byte count when EOF splits a header', async () => {
        const exactReader = loadExactReaderFactory()(chunks([0, 0]));

        assert.deepStrictEqual(await read(exactReader, 4), {
            count: 2,
            bytes: [0, 0]
        });
    });

    it('returns the partial byte count when EOF splits a payload', async () => {
        const exactReader = loadExactReaderFactory()(chunks([10, 11], [12]));

        assert.deepStrictEqual(await read(exactReader, 5), {
            count: 3,
            bytes: [10, 11, 12]
        });
    });

    it('ignores empty chunks without losing subsequent bytes', async () => {
        const exactReader = loadExactReaderFactory()(chunks([], [1], [], [], [2, 3]));

        assert.deepStrictEqual(await read(exactReader, 3), {
            count: 3,
            bytes: [1, 2, 3]
        });
    });
});
