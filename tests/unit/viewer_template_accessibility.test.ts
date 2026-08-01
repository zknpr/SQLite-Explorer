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

        const clearButton = template.match(
            /<button\b(?=[^>]*\bid=["']btnClearFilter["'])[^>]*>/i
        )?.[0];
        assert.ok(clearButton, 'toolbar filter must expose a clear button');
        assert.match(clearButton, /\baria-label\s*=\s*["'][^"']+["']/i);
    });

    it('announces the keyboard escape route for both multiline editors', () => {
        const template = readFileSync(
            path.resolve(process.cwd(), 'core/ui/viewer.template.html'),
            'utf8'
        );
        const css = readFileSync(
            path.resolve(process.cwd(), 'core/ui/viewer.css'),
            'utf8'
        );
        const descriptionId = 'multilineEditorKeyboardHint';
        const description = template.match(
            new RegExp(`<[^>]+\\bid=["']${descriptionId}["'][^>]*>[^<]+<\\/[^>]+>`, 'i')
        )?.[0];

        assert.ok(description, 'the multiline-editor keyboard hint must exist');
        assert.match(description, /class=["'][^"']*\bvisually-hidden\b[^"']*["']/i);
        assert.match(description, /Press Escape, then Tab to move focus out of the editor\./i);
        assert.doesNotMatch(template, /\baria-description\s*=/i);

        for (const id of ['viewSelectSql', 'cellPreviewTextarea']) {
            const textarea = template.match(
                new RegExp(`<textarea\\b(?=[^>]*\\bid=["']${id}["'])[^>]*>`, 'i')
            )?.[0];
            assert.ok(textarea, `${id} must exist`);
            assert.match(
                textarea,
                new RegExp(`\\baria-describedby=["']${descriptionId}["']`, 'i'),
                `${id} must reference the keyboard hint`
            );
        }

        const hiddenRule = css.match(/\.visually-hidden\s*\{([^}]*)\}/s)?.[1];
        assert.ok(hiddenRule, 'the visually-hidden utility must exist');
        assert.match(hiddenRule, /position\s*:\s*absolute/i);
        assert.match(hiddenRule, /overflow\s*:\s*hidden/i);
    });

    it('exposes every modal as a labelled modal dialog', () => {
        const template = readFileSync(
            path.resolve(process.cwd(), 'core/ui/viewer.template.html'),
            'utf8'
        );
        const modalLabels = new Map([
            ['viewModal', 'viewModalTitle'],
            ['addRowModal', 'addRowModalTitle'],
            ['deleteModal', 'deleteModalTitle'],
            ['createTableModal', 'createTableModalTitle'],
            ['addColumnModal', 'addColumnModalTitle'],
            ['exportModal', 'exportModalTitle'],
            ['settingsModal', 'settingsModalTitle'],
            ['cellPreviewModal', 'cellPreviewTitle'],
            ['blob-inspector-modal', 'blobInspectorModalTitle']
        ]);

        for (const [modalId, titleId] of modalLabels) {
            const modal = template.match(
                new RegExp(`<[^>]+\\bid=["']${modalId}["'][^>]*>`, 'i')
            )?.[0];
            const title = template.match(
                new RegExp(`<[^>]+\\bid=["']${titleId}["'][^>]*>`, 'i')
            )?.[0];

            assert.ok(modal, `${modalId} must exist`);
            assert.match(modal, /\brole=["']dialog["']/i, `${modalId} must use dialog semantics`);
            assert.match(modal, /\baria-modal=["']true["']/i, `${modalId} must be modal`);
            assert.match(
                modal,
                new RegExp(`\\baria-labelledby=["']${titleId}["']`, 'i'),
                `${modalId} must reference its visible title`
            );
            assert.ok(title, `${titleId} must label ${modalId}`);
        }
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
