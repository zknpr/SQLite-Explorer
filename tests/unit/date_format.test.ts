import { describe, it } from 'node:test';
import assert from 'node:assert';

const utilsModulePath = '../../core/ui/modules/utils.js';

describe('date formatting', () => {
    it('formats numeric Unix epoch zero instead of treating it as absent', async () => {
        const { formatCellValueAsText } = await import(utilsModulePath);
        assert.strictEqual(
            formatCellValueAsText(0, 'TIMESTAMP', 'iso'),
            '1970-01-01T00:00:00.000Z'
        );
    });

    it('renders future timestamps as future-relative time', async () => {
        const { formatCellValueAsText } = await import(utilsModulePath);
        const twoDaysAhead = Date.now() + (2 * 24 * 60 * 60 * 1000) + 1000;
        assert.strictEqual(
            formatCellValueAsText(twoDaysAhead, 'TIMESTAMP', 'relative'),
            'in 2 days'
        );
    });
});
