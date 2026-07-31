import './vscode_mock_setup';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('viewer template accessibility', () => {
    it('gives the toolbar table filter an accessible name', () => {
        const template = readFileSync(
            path.resolve(process.cwd(), 'core/ui/viewer.template.html'),
            'utf8'
        );
        const input = template.match(/<input\b(?=[^>]*\bid=["']filterInput["'])[^>]*>/i)?.[0];

        assert.ok(input, 'toolbar filter input must exist');
        assert.match(
            input,
            /\baria-(?:label|labelledby)\s*=\s*["'][^"']+["']/i,
            'toolbar filter input must expose a non-empty accessible name'
        );
    });
});
