import './vscode_mock_setup';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';
import {
    WEBVIEW_TRANSPORT_SURFACES,
    assertWebviewTransportPayload
} from '../../src/core/webview-transport';

const containmentModulePath = '../../src/core/cell-containment.ts';

async function loadContainmentModule(): Promise<any> {
    const module = await import(containmentModulePath).catch(() => undefined);
    assert.ok(module, 'the shared cell-containment module must exist');
    return module;
}

describe('grid cell containment limits', () => {
    it('keeps the 1 MiB per-cell ceiling when the page budget is looser', async () => {
        const { deriveEffectiveInlineCellBytes } = await loadContainmentModule();

        assert.strictEqual(deriveEffectiveInlineCellBytes({
            maxInlineCellBytes: 1024 * 1024,
            maxPageResponseBytes: 16 * 1024 * 1024,
            limit: 2
        }, 4), 1024 * 1024);
    });

    it('keeps a 256-byte SQL clipping floor for a 50-column 5000-row page', async () => {
        const { deriveEffectiveInlineCellBytes } = await loadContainmentModule();

        assert.strictEqual(deriveEffectiveInlineCellBytes({
            maxInlineCellBytes: 1024 * 1024,
            maxPageResponseBytes: 16 * 1024 * 1024,
            limit: 5000
        }, 50), 256);
    });

    it('downgrades the payload tail after actual UTF-8 bytes exhaust the page budget', async () => {
        const { decodeCellContainment } = await loadContainmentModule();
        const decoded = decodeCellContainment([
            ['early', ''],
            ['😀', ''],
            ['late', ''],
            ['x', '']
        ], 1, undefined, 9);

        assert.deepStrictEqual(decoded.rows, [['early'], ['😀'], [''], ['']]);
        assert.deepStrictEqual(decoded.oversizedCells, {
            2: { 0: { storageClass: 'text', byteLength: 4 } },
            3: { 0: { storageClass: 'text', byteLength: 1 } }
        });
        assert.strictEqual(
            decoded.rows.reduce(
                (total: number, row: string[]) => total + Buffer.byteLength(row[0]),
                0
            ),
            9
        );
    });

    it('keeps the 32 MiB aggregate transport guard unreachable for contained pages', async () => {
        const { decodeCellContainment } = await loadContainmentModule();
        const rowCount = 5000;
        const columnCount = 50;
        const value = new Uint8Array(256);
        const packedMetadata = Array(columnCount).fill('b257').join('|');
        const transportedRow = [...Array(columnCount).fill(value), packedMetadata];
        const decoded = decodeCellContainment(
            Array(rowCount).fill(transportedRow),
            columnCount,
            undefined,
            16 * 1024 * 1024
        );
        const response = {
            channel: 'rpc',
            content: {
                kind: 'response',
                messageId: 'contained-wide-grid',
                success: true,
                data: {
                    headers: Array.from(
                        { length: columnCount },
                        (_, column) => `column_${column}`
                    ),
                    rows: decoded.rows,
                    oversizedCells: decoded.oversizedCells
                }
            }
        };

        assert.doesNotThrow(() => assertWebviewTransportPayload(
            response,
            { surface: WEBVIEW_TRANSPORT_SURFACES.hostResponse }
        ));
    });

    it('bounds percent-expanded WITHOUT ROWID identities inside the host response budget', async () => {
        const {
            decodeCellContainment,
            remapPrimaryKeyContainment
        } = await loadContainmentModule();
        const rowCount = 16;
        const primaryKeyBytes = 1024 * 1024 - 1024;
        const keyTail = ' '.repeat(primaryKeyBytes - 2);
        const transportedRows = Array.from({ length: rowCount }, (_, rowIndex) => [
            'visible',
            `${String(rowIndex).padStart(2, '0')}${keyTail}`,
            '|'
        ]);
        const decoded = decodeCellContainment(
            transportedRows,
            2,
            undefined,
            16 * 1024 * 1024
        );
        const remapped = remapPrimaryKeyContainment({
            identity: {
                kind: 'primaryKey',
                columns: [{ identifier: 'key', declaredType: 'TEXT', position: 1 }]
            },
            sourceColumns: ['value', 'key'],
            visibleColumnCount: 1,
            identityRows: decoded.rows,
            rawTextBytes: decoded.rows.map((row: unknown[]) => [
                new TextEncoder().encode(String(row[1]))
            ]),
            rawTextColumnIndices: [1],
            textEncoding: 'utf-8',
            rows: decoded.rows,
            oversizedCells: decoded.oversizedCells,
            exactIntegerTexts: decoded.exactIntegerTexts,
            effectiveInlineCellBytes: 1024 * 1024
        });
        const response = {
            channel: 'rpc',
            content: {
                kind: 'response',
                messageId: 'contained-primary-key-identities',
                success: true,
                data: {
                    headers: ['rowid', 'value'],
                    rows: remapped.rows,
                    oversizedCells: remapped.oversizedCells,
                    exactIntegerTexts: remapped.exactIntegerTexts,
                    readOnlyRowReasons: remapped.readOnlyRowReasons
                }
            }
        };

        assert.match(String(remapped.rows[0][0]), /^pk:/);
        assert.strictEqual(String(remapped.rows.at(-1)?.[0]).startsWith('readonly-pk:'), true);
        assert.ok(Object.keys(remapped.readOnlyRowReasons ?? {}).length > 0);
        assert.doesNotThrow(() => assertWebviewTransportPayload(
            response,
            { surface: WEBVIEW_TRANSPORT_SURFACES.hostResponse }
        ));
    });

    it('returns zero oversized markers for 5000 rows of 50 ordinary UUID cells', async () => {
        const { decodeCellContainment } = await loadContainmentModule();
        const rowCount = 5000;
        const columnCount = 50;
        const uuid = '550e8400-e29b-41d4-a716-446655440000';
        const packedMetadata = Array(columnCount).fill('').join('|');
        const transportedRow = [...Array(columnCount).fill(uuid), packedMetadata];
        const page = decodeCellContainment(
            Array(rowCount).fill(transportedRow),
            columnCount,
            undefined,
            16 * 1024 * 1024
        );

        assert.strictEqual(page.rows.length, 5000);
        assert.strictEqual(page.rows[0].length, 50);
        assert.strictEqual(page.oversizedCells, undefined);
    });

    it('fails closed instead of exceeding SQLite result width for a 1000-column key', async () => {
        const { buildCellContainmentQuery } = await loadContainmentModule();
        const keyColumns = Array.from({ length: 1000 }, (_, index) => index);
        const query = buildCellContainmentQuery(
            'SELECT * FROM "wide_key"',
            1000,
            { limit: 1 },
            keyColumns
        );

        assert.strictEqual(query.transportColumnCount, 1001);
        assert.strictEqual(query.rawTextColumnCount, 0);
        assert.strictEqual(query.rawTextValidationUnavailable, true);
    });

    it('returns bounded WASM previews and exact sparse metadata without changing small DTOs', async () => {
        const result = await createDatabaseEngine({ content: null, maxSize: 0 });
        const engine = result.operations!;
        try {
            await engine.executeQuery(
                'CREATE TABLE contained_cells (text_value TEXT, blob_value BLOB); ' +
                "INSERT INTO contained_cells VALUES ('😀😀😀', x'000102030405060708090a0b'); " +
                "INSERT INTO contained_cells VALUES ('ok', x'0102')"
            );
            const page = await engine.fetchTableData('contained_cells', {
                columns: ['rowid', 'text_value', 'blob_value'],
                orderBy: 'rowid',
                limit: 2,
                offset: 0,
                maxInlineCellBytes: 8,
                maxPageResponseBytes: 64
            });

            assert.deepStrictEqual(page.rows[0], [
                1,
                '😀😀',
                Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7])
            ]);
            assert.deepStrictEqual(page.rows[1], [2, 'ok', Uint8Array.from([1, 2])]);
            assert.deepStrictEqual(page.oversizedCells, {
                0: {
                    1: { storageClass: 'text', byteLength: 12 },
                    2: { storageClass: 'blob', byteLength: 12 }
                }
            });

            const small = await engine.fetchTableData('contained_cells', {
                columns: ['rowid', 'text_value', 'blob_value'],
                filters: [{ column: 'text_value', value: 'ok' }],
                limit: 1,
                offset: 0,
                maxInlineCellBytes: 8,
                maxPageResponseBytes: 64
            });
            // Keyset anchors are the one deliberate DTO addition: every rowid
            // grid page re-anchors itself for seek pagination.
            const { keysetAnchors, ...smallDto } = small;
            assert.ok(keysetAnchors?.first && keysetAnchors?.last);
            assert.deepStrictEqual(smallDto, {
                headers: ['rowid', 'text_value', 'blob_value'],
                rows: [[2, 'ok', Uint8Array.from([1, 2])]],
                columns: ['rowid', 'text_value', 'blob_value'],
                values: [[2, 'ok', Uint8Array.from([1, 2])]],
                exactIntegerTexts: undefined
            });
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });

    it('filters and orders on original values instead of their previews', async () => {
        const result = await createDatabaseEngine({ content: null, maxSize: 0 });
        const engine = result.operations!;
        try {
            await engine.executeQuery(
                'CREATE TABLE original_cell_semantics (payload TEXT); ' +
                "INSERT INTO original_cell_semantics VALUES ('zzzzzz-needle'), ('aaaaaa-needle')"
            );
            const page = await engine.fetchTableData('original_cell_semantics', {
                columns: ['rowid', 'payload'],
                filters: [{ column: 'payload', value: 'needle' }],
                orderBy: 'payload',
                orderDir: 'ASC',
                limit: 2,
                offset: 0,
                maxInlineCellBytes: 4,
                maxPageResponseBytes: 64
            });

            assert.deepStrictEqual(page.rows.map(row => row[0]), [2, 1]);
            assert.deepStrictEqual(page.rows.map(row => row[1]), ['a', 'z']);
        } finally {
            (engine as WasmDatabaseEngine).shutdown();
        }
    });
});
