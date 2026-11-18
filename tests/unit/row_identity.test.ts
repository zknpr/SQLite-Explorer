import './vscode_mock_setup';

import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
    assertOneRowPerIdentity,
    buildTableIdentityMap,
    buildRecordIdentityPredicate,
    buildRecordIdentitiesPredicate,
    classifyTableIdentity,
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

describe('FTS shadow table identity', () => {
    it('uses the storage layout to distinguish rowid and WITHOUT ROWID shadow tables', () => {
        assert.strictEqual(classifyTableIdentity('shadow', 1), 'primaryKey');
        assert.strictEqual(classifyTableIdentity('shadow', 0), 'rowid');
        assert.strictEqual(classifyTableIdentity('virtual', 0), 'rowid');
        assert.strictEqual(classifyTableIdentity('view', 0), undefined);
    });

    it('preserves composite primary keys with undeclared types in FTS index metadata', () => {
        const identities = buildTableIdentityMap([
            ['fts_fixture_idx', 'shadow', 1, 0, 'segid', '', 1],
            ['fts_fixture_idx', 'shadow', 1, 1, 'term', '', 2],
            ['fts_fixture_idx', 'shadow', 1, 2, 'pgno', '', 0]
        ]);
        assert.deepStrictEqual(identities.get('fts_fixture_idx'), {
            kind: 'primaryKey',
            columns: [
                { identifier: 'segid', declaredType: '', position: 1 },
                { identifier: 'term', declaredType: '', position: 2 }
            ]
        });
    });
});

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
        assert.strictEqual(single.sql, `"key" = +CAST(? AS INTEGER) AND typeof("key") = 'integer'`);
        assert.deepStrictEqual(single.params, ['9007199254740993']);

        const bulk = buildRecordIdentitiesPredicate(
            identities,
            { kind: 'primaryKey', columns }
        );
        assert.strictEqual(
            bulk.sql,
            `"key" IN (+CAST(? AS INTEGER), +CAST(? AS INTEGER)) AND typeof("key") = 'integer'`
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

        assert.strictEqual(predicate.sql, `"key" IN (?, ?, ?) AND typeof("key") = 'text'`);
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
            '("tenant", "sequence") IN (VALUES (?, +CAST(? AS INTEGER)), (?, +CAST(? AS INTEGER))) ' +
            `AND typeof("tenant") = 'text' AND typeof("sequence") = 'integer'`
        );
        assert.deepStrictEqual(predicate.params, ['north', 1, 'south', 2]);
    });

    it('groups identities by the storage-class guards their members need', () => {
        // Each identity keeps the guards of its single-row predicate. A list
        // that mixes classes becomes one IN per set of guards, joined by OR.
        const single: PrimaryKeyColumn[] = [
            { identifier: 'key', declaredType: '', position: 1 }
        ];
        const mixed = buildRecordIdentitiesPredicate(
            [1n, 'one', 2n].map(value => encodePrimaryKeyRecordId(single, [value])),
            { kind: 'primaryKey', columns: single }
        );
        assert.strictEqual(
            mixed.sql,
            `(("key" IN (+CAST(? AS INTEGER), +CAST(? AS INTEGER)) AND typeof("key") = 'integer') ` +
            `OR ("key" IN (?) AND typeof("key") = 'text'))`
        );
        assert.deepStrictEqual(mixed.params, [1, 2, 'one']);

        const composite: PrimaryKeyColumn[] = [
            { identifier: 'a', declaredType: '', position: 1 },
            { identifier: 'b', declaredType: '', position: 2 }
        ];
        const pairs = buildRecordIdentitiesPredicate(
            [[1n, 'x'], ['1', 'x'], [1n, 2n], [3n, 'y']].map(values => (
                encodePrimaryKeyRecordId(composite, values)
            )),
            { kind: 'primaryKey', columns: composite }
        );
        assert.strictEqual(
            pairs.sql,
            '(((("a", "b") IN (VALUES (+CAST(? AS INTEGER), ?), (+CAST(? AS INTEGER), ?)) ' +
            `AND typeof("a") = 'integer' AND typeof("b") = 'text') ` +
            `OR (("a", "b") IN (VALUES (?, ?)) AND typeof("a") = 'text' AND typeof("b") = 'text')) ` +
            'OR (("a", "b") IN (VALUES (+CAST(? AS INTEGER), +CAST(? AS INTEGER))) ' +
            `AND typeof("a") = 'integer' AND typeof("b") = 'integer'))`
        );
        assert.deepStrictEqual(pairs.params, [1, 'x', 3, 'y', '1', 'x', 1, 2]);

        // A rowid is INTEGER storage by definition and needs no guard.
        assert.deepStrictEqual(
            buildRecordIdentitiesPredicate([1, '9007199254740993'], { kind: 'rowid' }),
            { sql: 'rowid IN (?, ?)', params: [1, '9007199254740993'] }
        );
    });
});

describe('one row per deleted identity', () => {
    it('requires each requested identity to match exactly one row, comparing numbers by value', () => {
        const key: PrimaryKeyColumn[] = [{ identifier: 'k', declaredType: '', position: 1 }];
        const id = (value: string | number | bigint) => encodePrimaryKeyRecordId(key, [value]);

        assertOneRowPerIdentity('t', [id('a'), id('b')], [id('b'), id('a')]);
        // The native engine reports an INTEGER key up to 2^53 as a number.
        assertOneRowPerIdentity('t', [id(1), id(2.5)], [id(1n), id(2.5)]);

        // One identity matched twice beside one that matched nothing.
        assert.throws(() => assertOneRowPerIdentity('t', [id('a'), id(5n)], [id('A'), id('a')]), /no longer exist/);
        assert.throws(() => assertOneRowPerIdentity('t', [id('a')], [id('a'), id('a')]), /more than one row/);
        assert.throws(() => assertOneRowPerIdentity('t', [id('a')], [id('A')]), /no longer exist/);
        assert.throws(() => assertOneRowPerIdentity('t', [id('1')], [id(1n)]), /no longer exist/);
        assert.throws(() => assertOneRowPerIdentity('t', [id('a')], [id('a'), id('b')]), /does not name/);
    });
});
