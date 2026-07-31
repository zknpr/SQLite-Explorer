import './vscode_mock_setup';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('viewer template accessibility', () => {
    it('keeps sidebar view actions keyboard-focusable while visually hidden', () => {
        const css = readFileSync(
            path.resolve(process.cwd(), 'core/ui/viewer.css'),
            'utf8'
        );
        const hiddenRule = css.match(/\.view-item-actions\s*\{([^}]*)\}/s)?.[1];
        const revealRule = css.match(
            /\.list-item:hover\s+\.view-item-actions,\s*\.list-item:focus-within\s+\.view-item-actions\s*\{([^}]*)\}/s
        )?.[1];

        assert.ok(hiddenRule, 'view action base rule must exist');
        assert.doesNotMatch(
            hiddenRule,
            /display\s*:\s*none/i,
            'display:none removes Edit and Drop from sequential keyboard focus'
        );
        assert.match(hiddenRule, /display\s*:\s*flex/i);
        assert.match(hiddenRule, /opacity\s*:\s*0(?:\D|$)/i);
        assert.ok(revealRule, 'view action hover/focus reveal rule must exist');
        assert.match(revealRule, /opacity\s*:\s*1(?:\D|$)/i);
    });

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

        const filterGroup = template.match(
            /<[^>]+\bclass=["'][^"']*\bfilter-group\b[^"']*["'][^>]*>/i
        )?.[0];
        assert.ok(filterGroup, 'toolbar filter group must exist');
        assert.match(
            filterGroup,
            /\bdata-preserve-grid-selection(?:\s|=|>)/i,
            'using the table filter must preserve the active grid selection'
        );
    });
});
