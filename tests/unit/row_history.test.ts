import assert from 'node:assert';
import { describe, it } from 'node:test';

import { LegacyRowHistoryError, rowHistoryStates } from '../../src/core/row-history';
import type { DeletedRow } from '../../src/core/types';

describe('row history identifier matching', () => {
    it('keeps non-ASCII identifiers distinct under SQLite case folding', () => {
        const snapshot: DeletedRow = {
            rowId: 1,
            row: { Ä: 'upper', ä: 'lower' },
            storageClasses: [
                { column: 'Ä', storageClass: 'text' },
                { column: 'ä', storageClass: 'text' }
            ]
        };

        assert.deepStrictEqual(rowHistoryStates(snapshot), [
            { column: 'Ä', state: { storageClass: 'text', value: 'upper' } },
            { column: 'ä', state: { storageClass: 'text', value: 'lower' } }
        ]);
    });

    it('still rejects duplicate ASCII-case aliases', () => {
        const snapshot: DeletedRow = {
            rowId: 1,
            row: { value: 'first', VALUE: 'second' },
            storageClasses: [
                { column: 'value', storageClass: 'text' },
                { column: 'VALUE', storageClass: 'text' }
            ]
        };

        assert.throws(() => rowHistoryStates(snapshot), LegacyRowHistoryError);
    });
});
