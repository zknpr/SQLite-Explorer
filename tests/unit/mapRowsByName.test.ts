import './vscode_mock_setup';
import { test } from 'node:test';
import * as assert from 'node:assert';
import { mapRowsByName } from '../../src/nativeWorker';
import type { CellValue } from '../../src/core/types';

test('mapRowsByName - returns empty array for null/undefined input', () => {
    assert.deepStrictEqual(mapRowsByName(null, {}), []);
    assert.deepStrictEqual(mapRowsByName(undefined, {}), []);
});

test('mapRowsByName - returns empty array for missing columns or values', () => {
    // @ts-ignore
    assert.deepStrictEqual(mapRowsByName({ columns: [] }, {}), []);
    // @ts-ignore
    assert.deepStrictEqual(mapRowsByName({ values: [] }, {}), []);
});

test('mapRowsByName - maps rows correctly', () => {
    const result = {
        columns: ['id', 'name', 'age'],
        values: [
            [1, 'Alice', 30],
            [2, 'Bob', 25]
        ]
    };

    const mapping = {
        userId: 'id',
        userName: 'name',
        userAge: 'age'
    };

    const expected = [
        { userId: 1, userName: 'Alice', userAge: 30 },
        { userId: 2, userName: 'Bob', userAge: 25 }
    ];

    const actual = mapRowsByName(result, mapping);
    assert.deepStrictEqual(actual, expected);
});

test('mapRowsByName - handles partial mapping', () => {
    const result = {
        columns: ['id', 'name', 'age'],
        values: [
            [1, 'Alice', 30]
        ]
    };

    const mapping = {
        userId: 'id',
        userAge: 'age'
        // name is ignored
    };

    const expected = [
        { userId: 1, userAge: 30 }
    ];

    const actual = mapRowsByName(result, mapping);
    assert.deepStrictEqual(actual, expected);
});

test('mapRowsByName - handles missing columns in result (undefined in output)', () => {
    const result = {
        columns: ['id', 'name'],
        values: [
            [1, 'Alice']
        ]
    };

    const mapping = {
        userId: 'id',
        userAge: 'age' // 'age' is not in columns
    };

    const expected = [
        { userId: 1 } // userAge is missing entirely because idx is undefined
    ];

    const actual = mapRowsByName(result, mapping);
    assert.deepStrictEqual(actual, expected);
});

test('mapRowsByName - handles extra columns in result', () => {
    const result = {
        columns: ['id', 'name', 'age', 'email'],
        values: [
            [1, 'Alice', 30, 'alice@example.com']
        ]
    };

    const mapping = {
        userId: 'id'
    };

    const expected = [
        { userId: 1 }
    ];

    const actual = mapRowsByName(result, mapping);
    assert.deepStrictEqual(actual, expected);
});

test('mapRowsByName - works with generics', () => {
    interface User {
        userId: number;
        userName: string;
    }

    const result = {
        columns: ['id', 'name'],
        values: [
            [1, 'Alice']
        ]
    };

    const mapping = {
        userId: 'id',
        userName: 'name'
    };

    const actual = mapRowsByName<User>(result, mapping);

    // Runtime check
    assert.deepStrictEqual(actual, [{ userId: 1, userName: 'Alice' }]);
});
