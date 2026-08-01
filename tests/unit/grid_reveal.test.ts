import './vscode_mock_setup';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';

const revealModulePath = '../../core/ui/modules/grid-reveal.js';

function rect(left: number, top: number, right: number, bottom: number) {
    return {
        left,
        top,
        right,
        bottom,
        width: right - left,
        height: bottom - top,
        x: left,
        y: top,
        toJSON() { return {}; }
    };
}

describe('grid cell reveal geometry', () => {
    afterEach(() => {
        delete (globalThis as any).document;
    });

    it('moves an unpinned target clear of sticky columns and rows', async () => {
        const stickyColumn = { getBoundingClientRect: () => rect(0, 40, 220, 400) };
        const stickyRow = { getBoundingClientRect: () => rect(0, 0, 500, 120) };
        const container = {
            scrollLeft: 300,
            scrollTop: 200,
            getBoundingClientRect: () => rect(0, 0, 500, 400),
            querySelectorAll(selector: string) {
                if (selector.includes('row-number')) return [stickyColumn];
                if (selector.includes('grid-header')) return [stickyRow];
                return [];
            }
        };
        const target = {
            classList: { contains: () => false },
            closest: () => null,
            getBoundingClientRect: () => rect(100, 70, 200, 100),
            scrollIntoView() {
                throw new Error('measured grid cells must not use unoffset scrollIntoView');
            }
        };
        (globalThis as any).document = {
            getElementById(id: string) {
                return id === 'gridContainer' ? container : null;
            }
        };

        const { revealGridCell } = await import(revealModulePath);
        assert.strictEqual(revealGridCell(target), true);
        assert.strictEqual(container.scrollLeft, 180);
        assert.strictEqual(container.scrollTop, 150);
    });

    it('scrolls forward when a target extends past the unpinned viewport edge', async () => {
        const container = {
            scrollLeft: 40,
            scrollTop: 25,
            getBoundingClientRect: () => rect(0, 0, 500, 400),
            querySelectorAll: () => []
        };
        const target = {
            classList: { contains: () => false },
            closest: () => null,
            getBoundingClientRect: () => rect(470, 380, 560, 455)
        };
        (globalThis as any).document = {
            getElementById: () => container
        };

        const { revealGridCell } = await import(revealModulePath);
        revealGridCell(target);

        assert.strictEqual(container.scrollLeft, 100);
        assert.strictEqual(container.scrollTop, 80);
    });

    it('uses the browser nearest fallback when layout geometry is unavailable', async () => {
        let fallbackOptions: unknown;
        const target = {
            classList: { contains: () => false },
            closest: () => null,
            scrollIntoView(options: unknown) { fallbackOptions = options; }
        };
        (globalThis as any).document = {
            getElementById: () => ({})
        };

        const { revealGridCell } = await import(revealModulePath);
        assert.strictEqual(revealGridCell(target), true);
        assert.deepStrictEqual(fallbackOptions, { block: 'nearest', inline: 'nearest' });
    });
});
