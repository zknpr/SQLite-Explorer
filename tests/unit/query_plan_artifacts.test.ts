import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { verifyQueryPlanArtifacts } = require('../../scripts/build-query-plan.mjs') as {
    verifyQueryPlanArtifacts(root?: string, options?: { includeBuildAssets?: boolean }): {
        schema: number; sqlJsCommit: string; inputs: Record<string, string>; outputs: Record<string, string>
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

it('requires the pinned source commit even when a different local checkout is supplied', () => {
    const before = verifyQueryPlanArtifacts();
    const directory = fs.mkdtempSync(path.resolve('.tmp/query-plan-source-'));
    try {
        const checkout = path.join(directory, 'source');
        assert.equal(spawnSync('git', ['init', '--quiet', checkout]).status, 0);
        // Version-only tools let this exercise source admission without compiling.
        const emcc = path.join(directory, 'emcc'), zig = path.join(directory, 'zig');
        fs.writeFileSync(emcc, `#!${process.execPath}\nprocess.stdout.write('emcc 5.0.0\\n');\n`, { mode: 0o755 });
        fs.writeFileSync(zig, `#!${process.execPath}\nprocess.stdout.write('0.16.0\\n');\n`, { mode: 0o755 });
        const result = spawnSync(process.execPath, ['scripts/refresh-sqljs.mjs', '--emcc', emcc, '--zig', zig, '--sqljs-source', checkout], { encoding: 'utf8' });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /not a (?:valid object name|tree object): 653366ed214563ea95a57b34c92986b6ff584c23/);
        assert.deepEqual(verifyQueryPlanArtifacts(), before);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
