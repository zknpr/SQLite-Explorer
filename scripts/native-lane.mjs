/**
 * Real-binary lane for the native engine: `npm run native-lane`.
 *
 * Deliberately OUTSIDE `npm test`. It runs two phases against the ACTUAL
 * sha-pinned fork binary from `natives/`:
 *
 *   1. ENGINE — loads `core/native/sqljs-shim.js` over real `tjs:sqlite`, runs
 *      the shared fixture matrix (`scripts/lib/native-lane-fixtures.mjs`), and
 *      diffs the result against the real vendored sql.js running here in node.
 *      The unit suite runs the same shim over a node:sqlite stand-in, so fork
 *      API drift fails at gate time rather than at runtime in the sidecar.
 *   2. TRANSPORT — drives `core/native/stdio-transport.js` inside the binary
 *      over real pipes (`scripts/lib/native-frame-lane.mjs`): drip-feed,
 *      coalesced writes, split headers, 256 KiB, the 16 MiB drain, and EOF.
 *   3. SIDECAR — drives the committed `desktop/native-worker-desktop.js`
 *      end-to-end (`scripts/lib/native-sidecar-lane.mjs`): freshness, real
 *      initializeDatabase/fetchSchema/runConsole envelopes, path binding,
 *      int64/blob tags through real RPCs, oversize in-band answers, the
 *      query deadline, and the ppid watchdog.
 *
 * Exits non-zero on any fixture mismatch, errno mismatch, fork-only check, or
 * transport/sidecar check failure.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from '../vendor/sql.js/sql-wasm.js';
import { runFixtures, normalize } from './lib/native-lane-fixtures.mjs';
import { runFrameLane } from './lib/native-frame-lane.mjs';
import { runSidecarLane } from './lib/native-sidecar-lane.mjs';
import { runMethodSweep } from './lib/native-method-sweep.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Mirrors getNativeBinaryPath() in src/nativeWorker.ts. */
function resolveBinary() {
    const platformDir = {
        linux: process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu',
        darwin: process.arch === 'arm64' ? 'aarch64-macos' : 'x86_64-macos',
        win32: 'x86_64-windows'
    }[process.platform];
    if (!platformDir) throw new Error(`unsupported platform: ${process.platform}`);
    return path.join(REPO_ROOT, 'natives', platformDir, process.platform === 'win32' ? 'tjs.exe' : 'tjs');
}

function runHarness(binary, harness, scratch) {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, ['run', harness, scratch], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

/** Expected outcomes for the fork-only checks, which have no sql.js counterpart. */
const FORK_ONLY_EXPECTATIONS = {
    'native/open-by-path': [{ columns: ['c'], values: [[3]] }],
    'native/readonly-blocks-writes': { blocked: true, errno: 8 },
    'native/readonly-query-only-armed': [{ columns: ['query_only'], values: [[1]] }],
    'native/readonly-zero-row-columns': { columns: ['alpha', 'beta'], queryOnly: 1 },
    'native/readonly-columns-inside-transaction': { columns: ['alpha'], queryOnly: 1 },
    'native/readonly-parameterised-zero-row-columns': {
        columns: ['alpha', 'beta'],
        queryOnly: 1
    },
    'native/probe-leaves-no-temp-view': [{ columns: ['c'], values: [[0]] }],
    'native/metadata-never-mutates': {
        insertColumns: [],
        insertRow: [],
        ddlColumns: [],
        inserted: [{ columns: ['c'], values: [[0]] }],
        created: [{ columns: ['c'], values: [[0]] }]
    },
    'native/duplicate-columns-repaired': { columns: ['x', 'x:1'], rows: [[1, 2]] },
    'native/parameterised-duplicate-names-keep-bound-values': {
        before: [],
        after: ['x'],
        rows: [[2]]
    },
    'native/export-sync-refused': { refused: true, mentionsExportAsync: true },
    'native/export-async-roundtrip': {
        header: 'SQLite format 3',
        rows: [{ columns: ['c'], values: [[3]] }]
    },
    'native/content-mode-rejected': null,
    'native/in-transaction': { before: false, during: true, after: false },
    // Wave 2: what the shim can honestly recover from a nonspecific fork error.
    // A missing table is SQLite's own phrasing, PROVEN by a compile probe plus
    // a catalog lookup; everything else keeps the engine's text and adds only
    // the result-code class. errno must survive every rewrite.
    'native/error-message-recovery': {
        missingTable: { message: 'no such table: absent_table', errno: 1 },
        missingColumn: {
            message: 'SQL logic error (SQLITE_ERROR: a misspelled name, a syntax error, or a '
                + 'misused construct \u2014 the native engine cannot report SQLite\u2019s detailed message)',
            errno: 1
        },
        constraint: {
            message: 'constraint failed (SQLITE_CONSTRAINT: a NOT NULL, UNIQUE, CHECK, '
                + 'PRIMARY KEY or FOREIGN KEY constraint rejected the row)',
            errno: 19
        },
        literalNotBlamed: {
            message: 'SQL logic error (SQLITE_ERROR: a misspelled name, a syntax error, or a '
                + 'misused construct \u2014 the native engine cannot report SQLite\u2019s detailed message)',
            errno: 1
        },
        cteNotBlamed: {
            message: 'SQL logic error (SQLITE_ERROR: a misspelled name, a syntax error, or a '
                + 'misused construct \u2014 the native engine cannot report SQLite\u2019s detailed message)',
            errno: 1
        },
        systemTableNotBlamed: {
            message: 'SQL logic error (SQLITE_ERROR: a misspelled name, a syntax error, or a '
                + 'misused construct \u2014 the native engine cannot report SQLite\u2019s detailed message)',
            errno: 1
        },
        // The view itself is never accused (it is in the catalog); the proof
        // walks into its stored body and names the table it lost, which is
        // what SQLite's own message would say too ("no such table: main.t").
        brokenViewNotBlamed: { message: 'no such table: t', errno: 1 }
    }
};

const scratch = mkdtempSync(path.join(tmpdir(), 'native-lane-'));
let failures = 0;
let frameChecks = 0;
let sidecarChecks = 0;
let sweepChecks = 0;
const note = (ok, label, detail) => {
    if (!ok) failures += 1;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` -- ${detail}` : ''}`);
};

try {
    const binary = resolveBinary();
    const harness = path.join(REPO_ROOT, 'scripts', 'lib', 'native-lane-harness.mjs');
    console.log(`binary : ${binary}`);
    console.log(`harness: ${harness}\n`);

    const result = await runHarness(binary, harness, scratch);
    if (result.stderr.trim()) console.log(`[harness stderr]\n${result.stderr.trim()}\n`);
    if (result.code !== 0) {
        console.log(`harness exited ${result.code}`);
        console.log(result.stdout.trim().slice(0, 4000));
        process.exitCode = 1;
    } else {
        const native = JSON.parse(result.stdout);
        console.log(`engine : tjs ${native.engine.tjs}, sqlite ${native.engine.sqlite}\n`);

        const SQL = await initSqlJs();
        const reference = runFixtures(() => new SQL.Database());
        const referenceByName = new Map(reference.map((entry) => [entry.name, entry.outcome]));

        console.log('-- shared fixture matrix (real tjs shim vs real sql.js) --');
        for (const { name, outcome } of native.fixtures) {
            const expected = referenceByName.get(name);
            const actualText = JSON.stringify(outcome);
            const expectedText = JSON.stringify(expected);
            note(actualText === expectedText, name,
                actualText === expectedText ? '' : `sql.js ${expectedText} != tjs ${actualText}`);
        }

        console.log('\n-- errno classification (fork-only: sql.js exposes no result code) --');
        for (const check of native.errnoChecks) {
            note(check.ok, check.name, check.ok ? '' : `expected ${check.expected}, got ${check.actual}`);
        }

        console.log('\n-- fork-only behaviour --');
        for (const { name, outcome } of native.forkOnly) {
            const expected = FORK_ONLY_EXPECTATIONS[name];
            if (expected === null) {
                note(outcome.threw === true, name, outcome.threw ? '' : `expected a rejection, got ${JSON.stringify(outcome)}`);
                continue;
            }
            const expectedText = JSON.stringify(normalize(expected));
            const actualText = JSON.stringify(outcome.ok);
            note(actualText === expectedText, name,
                actualText === expectedText ? '' : `expected ${expectedText}, got ${JSON.stringify(outcome)}`);
        }

        console.log('\n-- stdio transport through the real binary (real pipes) --');
        frameChecks = await runFrameLane({ binary, scratch, note });

        console.log('\n-- sidecar end-to-end (committed bundle, real binary, real pipes) --');
        sidecarChecks = await runSidecarLane({ binary, scratch, note });

        console.log('\n-- per-method sweep (every dispatch-table method, happy + failure) --');
        sweepChecks = await runMethodSweep({ binary, scratch, note });

        console.log(
            `\n${failures === 0 ? 'native lane PASSED' : `native lane FAILED (${failures} check(s))`}` +
            ` -- ${native.fixtures.length} shared fixtures, ${native.errnoChecks.length} errno checks, ` +
            `${native.forkOnly.length} fork-only checks, ${frameChecks} transport checks, ` +
            `${sidecarChecks} sidecar checks, ${sweepChecks} method-sweep checks`
        );
        if (failures > 0) process.exitCode = 1;
    }
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
