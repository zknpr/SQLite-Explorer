import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

const requireConfig = createRequire(import.meta.url);
const website = path.resolve('website');
const assets = ['worker.js', 'viewer.html', 'sql-wasm.js', 'sql-wasm.wasm'];

function fixture(t: TestContext) {
    const root = path.resolve('.tmp/unit-demo-assets');
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(path.join(root, 'run-'));
    const assetDirectory = path.join(directory, 'public/sqlite-viewer');
    mkdirSync(assetDirectory, { recursive: true });
    const configPath = path.join(directory, 'next.config.js');
    copyFileSync(path.join(website, 'next.config.js'), configPath);
    for (const asset of assets) {
        copyFileSync(path.join(website, 'public/sqlite-viewer', asset), path.join(assetDirectory, asset));
    }
    t.after(() => {
        delete requireConfig.cache[configPath];
        rmSync(directory, { recursive: true, force: true });
    });
    return {
        assetDirectory,
        load() {
            delete requireConfig.cache[configPath];
            return requireConfig(configPath);
        }
    };
}

function basePath(config: { env?: Record<string, string> }): string {
    const value = config.env?.NEXT_PUBLIC_SQLITE_VIEWER_BASE_PATH;
    assert.equal(typeof value, 'string', 'the client needs a build-derived demo asset path');
    assert.match(value!, /^\/sqlite-viewer\/[a-f0-9]{64}$/);
    return value!;
}

describe('demo asset cache isolation', () => {
    it('changes every demo URL when any member of the asset set changes', async t => {
        const files = fixture(t);
        const previous = basePath(files.load());
        assert.equal(basePath(files.load()), previous, 'unchanged bytes keep their cache keys');
        for (const asset of assets) {
            const file = path.join(files.assetDirectory, asset);
            const original = readFileSync(file);
            writeFileSync(file, Buffer.concat([original, Buffer.from('\nchanged fixture\n')]));
            const config = files.load();
            const current = basePath(config);
            assert.notEqual(current, previous, `${asset} must invalidate the whole set`);
            assert.deepEqual(await config.rewrites(), assets.map(name => ({
                source: `${current}/${name}`,
                destination: `/sqlite-viewer/${name}`
            })), 'only current-version URLs may resolve to the current assets');
            writeFileSync(file, original);
        }
    });

    it('gives the complete versioned set the same immutable cache policy', async t => {
        const config = fixture(t).load();
        const current = basePath(config);
        const headers = await config.headers();
        for (const asset of assets) {
            const rule = headers.find((entry: { source: string }) => entry.source === `${current}/${asset}`);
            assert.ok(rule, `missing cache policy for ${asset}`);
            assert.deepEqual(rule.headers, [{
                key: 'Cache-Control', value: 'public, max-age=31536000, immutable'
            }]);
        }
        for (const rule of headers) {
            if (rule.headers.some((header: { key: string; value: string }) =>
                header.key.toLowerCase() === 'cache-control' && header.value.includes('immutable'))) {
                assert.ok(assets.some(asset => rule.source === `${current}/${asset}`),
                    'unversioned or unknown assets must not get immutable caching');
            }
        }
    });

    it('does not let Vercel override mutable asset URLs with a year-long cache', () => {
        const config = JSON.parse(readFileSync(path.join(website, 'vercel.json'), 'utf8'));
        for (const file of [...assets.map(asset => `/sqlite-viewer/${asset}`), '/samples/chinook.db']) {
            for (const rule of config.headers) {
                if (!new RegExp(`^${rule.source}$`).test(file)) continue;
                for (const header of rule.headers) {
                    if (header.key.toLowerCase() !== 'cache-control') continue;
                    assert.doesNotMatch(header.value, /immutable|max-age=[1-9]/,
                        `${file} must remain revalidatable`);
                }
            }
        }
    });

    it('fails the website build when a runtime artifact is missing', t => {
        const files = fixture(t);
        rmSync(path.join(files.assetDirectory, 'sql-wasm.wasm'));
        assert.throws(() => files.load(), /ENOENT.*sql-wasm\.wasm/);
    });
});
