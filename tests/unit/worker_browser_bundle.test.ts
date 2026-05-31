/**
 * Regression tests for the browser worker bundle format.
 *
 * VS Code Web loads out/worker-browser.js as a classic Web Worker from a blob
 * URL. Classic workers parse scripts with the normal script grammar, so this
 * test compiles the bundle with node:vm to catch module-only syntax such as a
 * top-level export before it can ship.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

describe('browser worker bundle', () => {
  it('parses as a classic worker script', () => {
    const bundlePath = path.resolve(process.cwd(), 'out/worker-browser.js');

    if (!existsSync(bundlePath)) {
      assert.fail(
        'Missing out/worker-browser.js. Run `node scripts/build.mjs` before running this regression test.'
      );
    }

    const source = readFileSync(bundlePath, 'utf8');

    const isIifeBundle = /^(?:"use strict";)?\s*\(\s*(?:\(\)\s*=>|function\s*\()/.test(
      source.trimStart()
    );
    assert.ok(
      isIifeBundle,
      'out/worker-browser.js must be emitted as an IIFE classic-worker bundle'
    );

    assert.doesNotThrow(
      () => new vm.Script(source, { filename: bundlePath }),
      'out/worker-browser.js must parse as a classic worker script'
    );
  });
});
