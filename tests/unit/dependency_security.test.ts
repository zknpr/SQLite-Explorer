import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const semver = require('semver') as {
    intersects(left: string, right: string): boolean;
    satisfies(version: string, range: string): boolean;
};
const manifest = JSON.parse(readFileSync(
    new URL('../../package.json', import.meta.url), 'utf8'
)) as { overrides: Record<string, string> };
const { packages } = JSON.parse(readFileSync(
    new URL('../../package-lock.json', import.meta.url), 'utf8'
)) as { packages: Record<string, { version?: string; dependencies?: Record<string, string> }> };

describe('development dependency security', () => {
    it('does not permit affected qs versions through the publication-tool override', () => {
        assert.equal(typeof manifest.overrides.qs, 'string');
        assert.equal(semver.intersects(manifest.overrides.qs, '<6.16.0'), false);
    });

    it('does not retain affected qs or js-yaml versions in nested dependency paths', () => {
        for (const [location, entry] of Object.entries(packages)) {
            const name = /(?:^|\/)node_modules\/(qs|js-yaml)$/.exec(location)?.[1];
            if (!name) continue;
            assert.equal(typeof entry.version, 'string', `${location}: missing version`);
            const affected = name === 'qs' ? '>=2.2.5 <6.16.0'
                : '>=3.0.0 <3.15.2 || >=4.0.0 <4.3.2';
            assert.equal(semver.satisfies(entry.version!, affected), false, `${location}@${entry.version}`);
        }
    });

    it('preserves the separate js-yaml requirement of the desktop test runner', () => {
        const requested = packages['node_modules/mocha'].dependencies?.['js-yaml'];
        const resolved = packages['node_modules/mocha/node_modules/js-yaml']
            ?? packages['node_modules/js-yaml'];
        assert.ok(requested);
        assert.ok(resolved?.version);
        assert.ok(semver.satisfies(resolved.version, requested), 'a publication-tool override must not downgrade Mocha across majors');
    });
});
