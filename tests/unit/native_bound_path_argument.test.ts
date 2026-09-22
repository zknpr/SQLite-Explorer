import assert from 'node:assert/strict';
import { it } from 'node:test';
import { decodeBoundPathArgument } from '../../core/native/bound-path-argument.js';

it('preserves Unicode, UNC prefixes, spaces, percent signs, and quotes across an ASCII argv', () => {
    for (const original of ['C:\\data\\東京 100%.sqlite', '\\\\?\\C:\\data\\é😀.db', '/tmp/a "quoted" database.db']) {
        const argument = `--path-utf8=${encodeURIComponent(original)}`;
        assert.match(argument, /^[\x20-\x7e]+$/);
        assert.equal(decodeBoundPathArgument(argument), original);
    }
});

it('keeps existing literal launch paths and refuses malformed encoded arguments', () => {
    assert.equal(decodeBoundPathArgument('/tmp/100% literal.db'), '/tmp/100% literal.db');
    assert.throws(() => decodeBoundPathArgument('--path-utf8=%ff'), URIError);
});
