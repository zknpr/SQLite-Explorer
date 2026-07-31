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

    it('marks selection-dependent controls so click-away handling preserves the selection', () => {
        const template = readFileSync(
            path.resolve(process.cwd(), 'core/ui/viewer.template.html'),
            'utf8'
        );

        for (const id of ['btnDeleteRows', 'btnExport', 'batchUpdateSectionTitle', 'batchUpdateList']) {
            const element = template.match(new RegExp(`<[^>]+\\bid=["']${id}["'][^>]*>`, 'i'))?.[0];
            assert.ok(element, `${id} must exist`);
            assert.match(
                element,
                /\bdata-preserve-grid-selection(?:\s|=|>)/i,
                `${id} must preserve the active grid selection`
            );
        }
    });
});
