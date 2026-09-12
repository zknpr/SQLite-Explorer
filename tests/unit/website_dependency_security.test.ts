import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const semver = require('semver') as {
    intersects(left: string, right: string): boolean;
    satisfies(version: string, range: string): boolean;
};

interface LockedPackage {
    version?: string;
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
}

const website = JSON.parse(readFileSync(
    new URL('../../website/package.json', import.meta.url), 'utf8'
)) as { overrides?: { sharp?: string } };
const { packages } = JSON.parse(readFileSync(
    new URL('../../website/package-lock.json', import.meta.url), 'utf8'
)) as { packages: Record<string, LockedPackage> };

describe('website image dependency security', () => {
    it('does not override the patched Sharp requirement with an affected range', () => {
        const effectiveRange = website.overrides?.sharp
            ?? packages['node_modules/next']?.optionalDependencies?.sharp;
        assert.equal(typeof effectiveRange, 'string', 'missing Sharp requirement');
        // GHSA-rgj7-g3m4-5g8c: a broad override can retain an affected decoder
        // even after Next itself has raised its optional dependency floor.
        assert.equal(semver.intersects(effectiveRange!, '<0.35.4'), false);
    });

    it('does not lock affected Next, Sharp, or platform decoder versions', () => {
        assert.ok(packages['node_modules/next']);
        assert.ok(packages['node_modules/sharp']);
        for (const [location, entry] of Object.entries(packages)) {
            const isNext = /(?:^|\/)node_modules\/next$/.test(location);
            const isSharp = /(?:^|\/)node_modules\/(?:sharp|@img\/sharp-(?!libvips-)[^/]+)$/.test(location);
            if (!isNext && !isSharp) continue;
            assert.equal(typeof entry.version, 'string', `${location}: missing version`);
            const affected = isNext ? '>=10.0.0 <15.5.24 || >=16.0.0 <16.3.3' : '<0.35.4';
            assert.equal(semver.satisfies(entry.version!, affected), false, `${location}@${entry.version}`);
        }
    });

    it('resolves the declared platform decoder and libvips dependencies', () => {
        for (const [location, entry] of Object.entries(packages)) {
            if (!/(?:^|\/)node_modules\/(?:sharp|@img\/sharp-[^/]+)$/.test(location)) continue;
            for (const [name, range] of Object.entries({ ...entry.dependencies, ...entry.optionalDependencies })) {
                if (!name.startsWith('@img/sharp-')) continue;
                const resolved = packages[`${location}/node_modules/${name}`] ?? packages[`node_modules/${name}`];
                assert.ok(resolved?.version, `${location}: missing ${name}`);
                assert.ok(semver.satisfies(resolved.version, range), `${location}: ${name}@${resolved.version} does not satisfy ${range}`);
            }
        }
    });
});
