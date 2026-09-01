import './vscode_mock_setup';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function escapeRegExpLiteral(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findLabelForExactText(template: string, id: string, text: string): string | undefined {
    return template.match(
        new RegExp(`<label\\b(?=[^>]*\\bfor=["']${escapeRegExpLiteral(id)}["'])[^>]*>\\s*${escapeRegExpLiteral(text)}\\s*</label>`, 'i')
    )?.[0];
}

describe('viewer template accessibility', () => {
    it('matches interpolated label text as a RegExp literal', () => {
        for (const [literal, regexInterpretation] of [
            ['C+D', 'CCCD'],
            ['file.name', 'fileXname'],
            ['left|right', 'left'],
            [String.raw`path\name`, 'pathname']
        ]) {
            const literalLabel = `<label for="fixture">${literal}</label>`;
            assert.strictEqual(
                findLabelForExactText(literalLabel, 'fixture', literal),
                literalLabel
            );
            assert.strictEqual(
                findLabelForExactText(
                    `<label for="fixture">${regexInterpretation}</label>`,
                    'fixture',
                    literal
                ),
                undefined
            );
        }
    });

    it('matches interpolated label ids as RegExp literals', () => {
        for (const [literal, regexInterpretation] of [
            ['field.name', 'fieldXname'],
            ['field+name', 'fieldddddname'],
            ['field|name', 'field'],
            [String.raw`field\name`, 'fieldname']
        ]) {
            const literalLabel = `<label for="${literal}">Name</label>`;
            assert.strictEqual(
                findLabelForExactText(literalLabel, literal, 'Name'),
                literalLabel
            );
            assert.strictEqual(
                findLabelForExactText(
                    `<label for="${regexInterpretation}">Name</label>`,
                    literal,
                    'Name'
                ),
                undefined
            );
        }
    });

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

    it('reveals hidden grid icon actions when their cell receives keyboard focus', () => {
        const css = readFileSync(
            path.resolve(process.cwd(), 'core/ui/viewer.css'),
            'utf8'
        );
        const focusRule = css.match(
            /\.header-cell:focus-within\s+\.pin-icon,[^{]*\.header-cell:focus-within\s+\.select-column-icon,[^{]*\.data-cell\.row-number:focus-within\s+\.pin-icon\s*\{([^}]*)\}/s
        )?.[1];

        assert.ok(focusRule, 'keyboard focus must reveal grid pin and select actions');
        assert.match(focusRule, /opacity\s*:\s*(?:0?\.\d*[1-9]\d*|1)(?:\D|$)/i);
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

    it('uses native controls for sidebar navigation and labels both resize handles', () => {
        const template = readFileSync(
            path.resolve(process.cwd(), 'core/ui/viewer.template.html'),
            'utf8'
        );

        for (const section of ['tables', 'views', 'indexes']) {
            const toggle = template.match(
                new RegExp(`<button\\b(?=[^>]*\\bclass=["'][^"']*\\bsection-toggle\\b[^"']*["'])(?=[^>]*\\bdata-section=["']${section}["'])[^>]*>`, 'i')
            )?.[0];
            assert.ok(toggle, `${section} section must use a native toggle button`);
            assert.match(toggle, /\baria-expanded=["'](?:true|false)["']/i);
            assert.match(toggle, new RegExp(`\\baria-controls=["']${section}List["']`, 'i'));
        }

        const settings = template.match(
            /<button\b(?=[^>]*\bid=["']btnOpenSettings["'])[^>]*>/i
        )?.[0];
        assert.ok(settings, 'Configuration must be a native button');

        const resize = template.match(
            /<[^>]+\bid=["']resizeHandle["'][^>]*>/i
        )?.[0];
        assert.ok(resize, 'sidebar resize handle must exist');
        assert.match(resize, /\brole=["']separator["']/i);
        assert.match(resize, /\btabindex=["']0["']/i);
        assert.match(resize, /\baria-label=["'][^"']+["']/i);
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

    it('gives icon-only modal, filter, and pagination buttons meaningful names', () => {
        const template = readFileSync(
            path.resolve(process.cwd(), 'core/ui/viewer.template.html'),
            'utf8'
        );

        const modalCloseButtons = [...template.matchAll(
            /<button\b(?=[^>]*\bclass=["'][^"']*\bmodal-close\b[^"']*["'])[^>]*>/gi
        )].map(match => match[0]);
        assert.ok(modalCloseButtons.length > 0, 'standard modal close buttons must exist');
        for (const button of modalCloseButtons) {
            assert.match(button, /\baria-label=["']Close [^"']+["']/i);
        }

        for (const [id, name] of [
            ['btnApplyFilter', 'Search table'],
            ['btnFirst', 'First page'],
            ['btnPrev', 'Previous page'],
            ['btnNext', 'Next page'],
            ['btnLast', 'Last page'],
            ['btnCloseCellPreview', 'Close cell preview']
        ]) {
            const button = template.match(
                new RegExp(`<button\\b(?=[^>]*\\bid=["']${id}["'])[^>]*>`, 'i')
            )?.[0];
            assert.ok(button, `${id} must exist`);
            assert.match(
                button,
                new RegExp(`\\baria-label=["']${name}["']`, 'i'),
                `${id} must expose the name "${name}"`
            );
        }
    });

    it('announces status changes and associates both footer selectors with visible labels', () => {
        const template = readFileSync(
            path.resolve(process.cwd(), 'core/ui/viewer.template.html'),
            'utf8'
        );
        const status = template.match(/<[^>]+\bid=["']statusText["'][^>]*>/i)?.[0];
        assert.ok(status, 'status text must exist');
        assert.match(status, /\brole=["']status["']/i);
        assert.match(status, /\baria-live=["']polite["']/i);
        assert.match(status, /\baria-atomic=["']true["']/i);

        for (const [id, text] of [
            ['pageSizeSelect', 'Rows:'],
            ['dateFormatSelect', 'Date Format:']
        ]) {
            const label = template.match(
                new RegExp(`<label\\b(?=[^>]*\\bfor=["']${id}["'])[^>]*>\\s*${text}\\s*</label>`, 'i')
            )?.[0];
            assert.ok(label, `${id} must be associated with its visible label`);
        }
    });

    it('associates static create, add-column, and export fields with their labels', () => {
        const template = readFileSync(
            path.resolve(process.cwd(), 'core/ui/viewer.template.html'),
            'utf8'
        );

        for (const [id, text] of [
            ['newTableName', 'Table Name'],
            ['newColumnName', 'Column Name'],
            ['newColumnType', 'Type'],
            ['newColumnDefault', 'Default Value (optional)'],
            ['exportFormat', 'Format']
        ]) {
            const label = findLabelForExactText(template, id, text);
            assert.ok(label, `${id} must be associated with its visible label`);
        }

        for (const [groupId, labelId] of [
            ['columnDefinitions', 'columnDefinitionsLabel'],
            ['exportColumns', 'exportColumnsLabel'],
            ['exportOptions', 'exportOptionsLabel']
        ]) {
            const group = template.match(
                new RegExp(`<[^>]+\\bid=["']${groupId}["'][^>]*>`, 'i')
            )?.[0];
            assert.ok(group, `${groupId} must exist`);
            assert.match(group, /\brole=["']group["']/i);
            assert.match(group, new RegExp(`\\baria-labelledby=["']${labelId}["']`, 'i'));
            assert.match(template, new RegExp(`<[^>]+\\bid=["']${labelId}["'][^>]*>`, 'i'));
        }

        const cellEditor = template.match(
            /<textarea\b(?=[^>]*\bid=["']cellPreviewTextarea["'])[^>]*>/i
        )?.[0];
        assert.ok(cellEditor, 'cell preview editor must exist');
        assert.match(cellEditor, /\baria-labelledby=["']cellPreviewTitle["']/i);

        const hexDump = template.match(
            /<textarea\b(?=[^>]*\bclass=["'][^"']*\bhex-dump-textarea\b[^"']*["'])[^>]*>/i
        )?.[0];
        assert.ok(hexDump, 'BLOB hex dump must exist');
        assert.match(hexDump, /\baria-label=["']BLOB hexadecimal data["']/i);
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
