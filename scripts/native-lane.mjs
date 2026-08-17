/**
 * Real-binary lane for the native engine: `npm run native-lane`.
 *
 * Deliberately OUTSIDE `npm test`. The unit suite exercises
 * `core/native/sqljs-shim.js` over a node:sqlite stand-in so it runs anywhere;
 * this lane spawns the ACTUAL sha-pinned fork binary from `natives/`, loads the
 * same shim over real `tjs:sqlite`, runs the same fixture matrix
 * (`scripts/lib/native-lane-fixtures.mjs`), and diffs the result against the
 * real vendored sql.js running here in node. Fork API drift therefore fails at
 * gate time rather than at runtime in the sidecar.
 *
 * Exits non-zero on any fixture mismatch, errno mismatch, or fork-only check
 * failure.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from '../vendor/sql.js/sql-wasm.js';
import { runFixtures, normalize } from './lib/native-lane-fixtures.mjs';

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
    'native/duplicate-columns-repaired': { columns: ['x', 'x:1'], rows: [[1, 2]] },
    'native/export-sync-refused': { refused: true, mentionsExportAsync: true },
    'native/export-async-roundtrip': {
        header: 'SQLite format 3',
        rows: [{ columns: ['c'], values: [[3]] }]
    },
    'native/content-mode-rejected': null,
    'native/in-transaction': { before: false, during: true, after: false }
};

const scratch = mkdtempSync(path.join(tmpdir(), 'native-lane-'));
let failures = 0;
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

        console.log(
            `\n${failures === 0 ? 'native lane PASSED' : `native lane FAILED (${failures} check(s))`}` +
            ` -- ${native.fixtures.length} shared fixtures, ${native.errnoChecks.length} errno checks, ` +
            `${native.forkOnly.length} fork-only checks`
        );
        if (failures > 0) process.exitCode = 1;
    }
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
