import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import ts from 'typescript';

it('typechecks extension sources and tests without importing archived QA source trees', () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'sqlite-typescript-scope-'));
    try {
        const source = path.join(fixture, 'src', 'main.ts');
        const unitTest = path.join(fixture, 'tests', 'unit', 'example.test.ts');
        const archivedSource = path.join(fixture, 'qa-evidence', 'upstream', 'source.ts');
        const archivedTypes = path.join(fixture, 'qa-evidence', 'upstream', 'vscode.d.ts');
        const websiteSource = path.join(fixture, 'website', 'app', 'page.ts');
        for (const filename of [source, unitTest, archivedSource, archivedTypes, websiteSource]) {
            mkdirSync(path.dirname(filename), { recursive: true });
            writeFileSync(filename, 'export {};\n');
        }

        const configPath = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));
        const loaded = ts.readConfigFile(configPath, filename => readFileSync(filename, 'utf8'));
        assert.equal(loaded.error, undefined);
        const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, fixture);
        assert.deepEqual(parsed.errors, []);
        assert.ok(parsed.fileNames.includes(source), 'extension sources must remain checked');
        assert.ok(parsed.fileNames.includes(unitTest), 'unit tests must remain checked');
        assert.ok(!parsed.fileNames.includes(websiteSource), 'the website owns its separate tsconfig');
        assert.ok(!parsed.fileNames.includes(archivedSource), 'archived upstream implementation is not extension code');
        assert.ok(!parsed.fileNames.includes(archivedTypes), 'archived declarations must not augment VS Code types');
    } finally {
        rmSync(fixture, { recursive: true, force: true });
    }
});
