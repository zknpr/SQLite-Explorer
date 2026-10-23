import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { verifyQueryPlanArtifacts } = require('../../scripts/build-query-plan.mjs') as {
    verifyQueryPlanArtifacts(root?: string, options?: { includeBuildAssets?: boolean }): {
        schema: number; sqlJsCommit: string; zigClang?: string; inputs: Record<string, string>; outputs: Record<string, string>
    };
};

function withArtifactCopy(run: (directory: string, manifest: ReturnType<typeof verifyQueryPlanArtifacts>) => void): void {
    const manifest = verifyQueryPlanArtifacts();
    fs.mkdirSync('.tmp', { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('.tmp/query-plan-artifacts-'));
    try {
        for (const file of [...Object.keys(manifest.inputs), ...Object.keys(manifest.outputs), 'vendor/query-plan-manifest.json']) {
            const copy = path.join(directory, file);
            fs.mkdirSync(path.dirname(copy), { recursive: true }); fs.copyFileSync(file, copy);
        }
        run(directory, manifest);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

it('pins query-plan source and every runtime copy, and rejects drift before packaging', () => {
    withArtifactCopy(directory => {
        assert.doesNotThrow(() => verifyQueryPlanArtifacts(directory));
        const library = path.join(directory, 'natives/aarch64-macos/query-plan.dylib');
        fs.appendFileSync(library, 'drift');
        assert.throws(() => verifyQueryPlanArtifacts(directory), /artifact drift.*query-plan\.dylib/);
        fs.copyFileSync('natives/aarch64-macos/query-plan.dylib', library);
        fs.appendFileSync(path.join(directory, 'src/runtime/query-plan.c'), '\n/* source drift */\n');
        assert.throws(() => verifyQueryPlanArtifacts(directory), /artifact drift.*query-plan\.c/);
    });
});

for (const [label, change, expected] of [
    ['wrong upstream commit', (manifest: ReturnType<typeof verifyQueryPlanArtifacts>) => { manifest.sqlJsCommit = 'f'.repeat(40); }, /provenance/],
    ['unknown schema', (manifest: ReturnType<typeof verifyQueryPlanArtifacts>) => { manifest.schema = 2; }, /provenance/],
    ['missing source input', (manifest: ReturnType<typeof verifyQueryPlanArtifacts>) => { delete manifest.inputs['src/runtime/query-plan.c']; }, /inputs inventory/],
    ['missing native target', (manifest: ReturnType<typeof verifyQueryPlanArtifacts>) => { delete manifest.outputs['natives/x86_64-windows/query-plan.dll']; }, /outputs inventory/],
    ['unexpected output', (manifest: ReturnType<typeof verifyQueryPlanArtifacts>) => { manifest.outputs['unexpected/runtime.bin'] = '0'.repeat(64); }, /outputs inventory/]
] as const) {
    it(`rejects query-plan manifests with ${label}`, () => {
        withArtifactCopy((directory, manifest) => {
            change(manifest);
            fs.writeFileSync(path.join(directory, 'vendor/query-plan-manifest.json'), JSON.stringify(manifest));
            assert.throws(() => verifyQueryPlanArtifacts(directory), expected);
        });
    });
}

it('rejects a missing runtime copy instead of allowing a partial build', () => {
    withArtifactCopy(directory => {
        fs.rmSync(path.join(directory, 'website/public/sqlite-viewer/sql-wasm.wasm'));
        assert.throws(() => verifyQueryPlanArtifacts(directory), /ENOENT/);
    });
});

it('allows a clean build to regenerate its ignored WASM asset while still checking tracked copies', () => {
    withArtifactCopy(directory => {
        const asset = path.join(directory, 'assets/sqlite3.wasm');
        fs.rmSync(asset);
        assert.doesNotThrow(() => verifyQueryPlanArtifacts(directory, { includeBuildAssets: false }));
        assert.throws(() => verifyQueryPlanArtifacts(directory), /ENOENT/);
        fs.copyFileSync(path.join(directory, 'vendor/sql.js/sql-wasm.wasm'), asset);
        assert.doesNotThrow(() => verifyQueryPlanArtifacts(directory));
        fs.appendFileSync(asset, 'stale build copy');
        assert.doesNotThrow(() => verifyQueryPlanArtifacts(directory, { includeBuildAssets: false }));
        assert.throws(() => verifyQueryPlanArtifacts(directory), /artifact drift.*sqlite3\.wasm/);
        fs.appendFileSync(path.join(directory, 'vendor/sql.js/sql-wasm.wasm'), 'tracked drift');
        assert.throws(() => verifyQueryPlanArtifacts(directory, { includeBuildAssets: false }), /artifact drift.*sql-wasm\.wasm/);
    });
});

it('rejects legacy artifact refresh arguments before touching generated files', () => {
    const before = verifyQueryPlanArtifacts();
    const result = spawnSync(process.execPath, ['scripts/refresh-sqljs.mjs', '--from', '.tmp/unused-artifact'], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Usage:.*build-query-plan/);
    assert.deepEqual(verifyQueryPlanArtifacts(), before);
});

const OFFICIAL_EMCC = 'emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 5.0.0 (a7c5deabd7c88ba1c38ebe988112256775f944c6)';
const OFFICIAL_ZIG_CLANG = 'clang version 21.1.0';

/**
 * Version-only stand-ins for emcc and zig: enough for the builder's toolchain
 * gate and source admission, never enough to compile. Like the real zig,
 * `zig cc --version` writes an empty a.o into its working directory.
 */
function withFakeToolchain(
    tools: { emcc?: string; zigVersion?: string; zigClang?: string },
    run: (directory: string, emcc: string, zig: string) => void
): void {
    fs.mkdirSync('.tmp', { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('.tmp/query-plan-toolchain-'));
    try {
        const emcc = path.join(directory, 'emcc'), zig = path.join(directory, 'zig');
        fs.writeFileSync(emcc, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(`${tools.emcc ?? OFFICIAL_EMCC}\n`)});\n`, { mode: 0o755 });
        fs.writeFileSync(zig, `#!${process.execPath}
if (process.argv[2] === 'cc') {
    process.getBuiltinModule('node:fs').writeFileSync('a.o', '');
    process.stdout.write(${JSON.stringify(`${tools.zigClang ?? OFFICIAL_ZIG_CLANG}\n`)});
} else {
    process.stdout.write(${JSON.stringify(`${tools.zigVersion ?? '0.16.0'}\n`)});
}
`, { mode: 0o755 });
        run(directory, emcc, zig);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

// The builder shells out to make, tar and unzip, and the fake tools are
// shebang scripts; neither runs on Windows.
const posixToolchain = { skip: process.platform === 'win32' ? 'the runtime builder and its fake tools need a POSIX toolchain' : false };

function runBuilder(args: string[]) {
    return spawnSync(process.execPath, ['scripts/build-query-plan.mjs', ...args], { encoding: 'utf8' });
}

it('requires the pinned source commit even when a different local checkout is supplied', posixToolchain, () => {
    const before = verifyQueryPlanArtifacts();
    withFakeToolchain({}, (directory, emcc, zig) => {
        const checkout = path.join(directory, 'source');
        assert.equal(spawnSync('git', ['init', '--quiet', checkout]).status, 0);
        const result = spawnSync(process.execPath, ['scripts/refresh-sqljs.mjs', '--emcc', emcc, '--zig', zig, '--sqljs-source', checkout], { encoding: 'utf8' });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, new RegExp(`not a (?:valid object name|tree object): ${before.sqlJsCommit}`));
        assert.deepEqual(verifyQueryPlanArtifacts(), before);
    });
});

it('accepts relative --emcc and --zig paths', posixToolchain, () => {
    const before = verifyQueryPlanArtifacts();
    withFakeToolchain({}, (directory, emcc, zig) => {
        const checkout = path.join(directory, 'source');
        assert.equal(spawnSync('git', ['init', '--quiet', checkout]).status, 0);
        const result = runBuilder(['--emcc', path.relative(process.cwd(), emcc), '--zig', path.relative(process.cwd(), zig), '--sqljs-source', checkout]);
        assert.equal(result.status, 1, result.stderr);
        // Past the toolchain gate: the failure is source admission, not a spawn error.
        assert.doesNotMatch(result.stderr, /ENOENT/);
        assert.match(result.stderr, new RegExp(`not a (?:valid object name|tree object): ${before.sqlJsCommit}`));
    });
});

it('runs the zig identity probe outside the checkout', posixToolchain, () => {
    const marker = path.resolve('a.o');
    const stamp = () => (fs.existsSync(marker) ? fs.statSync(marker).mtimeMs : undefined);
    const before = stamp();
    withFakeToolchain({}, (directory, emcc, zig) => {
        const checkout = path.join(directory, 'source');
        assert.equal(spawnSync('git', ['init', '--quiet', checkout]).status, 0);
        const result = runBuilder(['--emcc', emcc, '--zig', zig, '--sqljs-source', checkout]);
        assert.equal(result.status, 1, result.stderr);
        // The fake zig writes a.o into its working directory, as the real one does.
        assert.equal(stamp(), before, 'zig cc --version must not write a.o into the checkout');
    });
});

it('refuses a Zig distribution whose clang identity differs from the official 0.16.0 release', posixToolchain, () => {
    const before = verifyQueryPlanArtifacts();
    // Same `zig version` as the official release, different bundled LLVM: its
    // Linux libraries would differ in .comment.
    withFakeToolchain({ zigClang: 'Homebrew clang version 21.1.8' }, (_directory, emcc, zig) => {
        const result = runBuilder(['--emcc', emcc, '--zig', zig]);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /official Zig 0\.16\.0 release.*found "Homebrew clang version 21\.1\.8"/);
        assert.deepEqual(verifyQueryPlanArtifacts(), before);
    });
});

it('names the toolchain check that failed', posixToolchain, () => {
    for (const [tools, expected] of [
        [{ emcc: OFFICIAL_EMCC.replace(' 5.0.0 ', ' 4.0.10 ') }, /Emscripten 5\.0\.0.*found "emcc .* 4\.0\.10 /],
        // A substring test would admit 15.0.0.
        [{ emcc: OFFICIAL_EMCC.replace(' 5.0.0 ', ' 15.0.0 ') }, /Emscripten 5\.0\.0.*found "emcc .* 15\.0\.0 /],
        [{ emcc: OFFICIAL_EMCC.replace('a7c5deab', 'deadbeef') }, /Emscripten 5\.0\.0.*deadbeef/],
        [{ zigVersion: '0.17.0' }, /Zig 0\.16\.0.*found "0\.17\.0"/],
    ] as const) {
        withFakeToolchain(tools, (_directory, emcc, zig) => {
            const result = runBuilder(['--emcc', emcc, '--zig', zig]);
            assert.equal(result.status, 1, result.stderr);
            assert.match(result.stderr, expected);
        });
    }
});

it('records the Zig clang identity in the runtime manifest', () => {
    assert.equal(verifyQueryPlanArtifacts().zigClang, OFFICIAL_ZIG_CLANG);
});
