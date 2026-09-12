/** Yield a task without the timer throttling applied to background webviews. */
function yieldToBrowser() {
    return new Promise(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
            channel.port1.close();
            channel.port2.close();
            resolve();
        };
        channel.port2.postMessage(null);
    });
}

export async function encodeBinaryBase64(bytes, signal) {
    signal?.throwIfAborted();
    if (bytes.byteLength > 65536) {
        // Give a pending Cancel/Undo gesture a task before native encoding.
        await yieldToBrowser();
        signal?.throwIfAborted();
    }
    const nativeEncode = Uint8Array.prototype.toBase64;
    if (typeof nativeEncode === 'function') return nativeEncode.call(bytes);

    const chunks = [];
    const chunkSize = 32768;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        chunks.push(String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunkSize)));
        if (offset > 0 && (offset / chunkSize) % 4 === 0) {
            await yieldToBrowser();
            signal?.throwIfAborted();
        }
    }
    return btoa(chunks.join(''));
}
