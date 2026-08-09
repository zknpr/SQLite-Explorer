import './vscode_mock_setup';

import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
    buildRecordIdentityPredicate,
    buildRecordIdentitiesPredicate,
    decodePrimaryKeyRecordId,
    encodePrimaryKeyRecordId,
    encodePrimaryKeyValue
} from '../../src/core/row-identity';
import type { PrimaryKeyColumn } from '../../src/core/types';

const integerColumn: PrimaryKeyColumn[] = [
    { identifier: 'id', declaredType: 'INTEGER', position: 1 }
];

function rawIntegerIdentity(text: string): string {
    return 'pk:' + encodeURIComponent(JSON.stringify({
        v: 1,
        c: [['id', ['integer', text]]]
    }));
}

describe('primary-key RecordId canonicalization', () => {
    it('rejects noncanonical INTEGER spellings while accepting normalized decimal text', () => {
        for (const alias of ['01', '+1', '-0', ' 1 ']) {
            assert.throws(
                () => decodePrimaryKeyRecordId(rawIntegerIdentity(alias)),
                /canonical|INTEGER identity/,
                alias
            );
        }

        const canonical = rawIntegerIdentity('1');
        assert.deepStrictEqual(decodePrimaryKeyRecordId(canonical), {
            columns: ['id'],
            values: [1]
        });
        assert.strictEqual(encodePrimaryKeyRecordId(integerColumn, [1n]), canonical);
    });

    it('round-trips signed REAL infinities without JSON null coercion', () => {
        const realColumn: PrimaryKeyColumn[] = [
            { identifier: 'key', declaredType: 'REAL', position: 1 }
        ];

        for (const value of [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
            const identity = encodePrimaryKeyRecordId(realColumn, [value]);
            assert.deepStrictEqual(decodePrimaryKeyRecordId(identity), {
                columns: ['key'],
                values: [value]
            });
            assert.doesNotMatch(decodeURIComponent(String(identity)), /\["real",null\]/);
        }

        assert.throws(
            () => encodePrimaryKeyValue(Number.NaN),
            /NaN|REAL identity/
        );
    });
});

describe('bulk primary-key predicates', () => {
    it('casts INTEGER-class identity binds independently of column affinity', () => {
        const columns: PrimaryKeyColumn[] = [
            { identifier: 'key', declaredType: '', position: 1 }
        ];
        const identities = [
            encodePrimaryKeyRecordId(columns, [9007199254740992n]),
            encodePrimaryKeyRecordId(columns, [9007199254740993n])
        ];

        const single = buildRecordIdentityPredicate(
            identities[1],
            { kind: 'primaryKey', columns }
        );
        assert.strictEqual(single.sql, '"key" = CAST(? AS INTEGER)');
        assert.deepStrictEqual(single.params, ['9007199254740993']);

        const bulk = buildRecordIdentitiesPredicate(
            identities,
            { kind: 'primaryKey', columns }
        );
        assert.strictEqual(
            bulk.sql,
            '"key" IN (CAST(? AS INTEGER), CAST(? AS INTEGER))'
        );
        assert.deepStrictEqual(
            bulk.params,
            ['9007199254740992', '9007199254740993']
        );
    });

    it('uses one IN predicate for a single-column primary key', () => {
        const columns: PrimaryKeyColumn[] = [
            { identifier: 'key', declaredType: 'TEXT', position: 1 }
        ];
        const predicate = buildRecordIdentitiesPredicate(
            ['alpha', 'beta', 'gamma'].map(value => encodePrimaryKeyRecordId(columns, [value])),
            { kind: 'primaryKey', columns }
        );

        assert.strictEqual(predicate.sql, '"key" IN (?, ?, ?)');
        assert.deepStrictEqual(predicate.params, ['alpha', 'beta', 'gamma']);
    });

    it('uses a row-value VALUES predicate for a composite primary key', () => {
        const columns: PrimaryKeyColumn[] = [
            { identifier: 'tenant', declaredType: 'TEXT', position: 1 },
            { identifier: 'sequence', declaredType: 'INTEGER', position: 2 }
        ];
        const predicate = buildRecordIdentitiesPredicate(
            [
                encodePrimaryKeyRecordId(columns, ['north', 1n]),
                encodePrimaryKeyRecordId(columns, ['south', 2n])
            ],
            { kind: 'primaryKey', columns }
        );

        assert.strictEqual(
            predicate.sql,
            '("tenant", "sequence") IN (VALUES (?, CAST(? AS INTEGER)), (?, CAST(? AS INTEGER)))'
        );
        assert.deepStrictEqual(predicate.params, ['north', 1, 'south', 2]);
    });
});
