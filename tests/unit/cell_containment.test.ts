import './vscode_mock_setup';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDatabaseEngine, WasmDatabaseEngine } from '../../src/core/sqlite-db';

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

    it('divides the 16 MiB page budget across every requested row and column', async () => {
        const { deriveEffectiveInlineCellBytes } = await loadContainmentModule();

        assert.strictEqual(deriveEffectiveInlineCellBytes({
            maxInlineCellBytes: 1024 * 1024,
            maxPageResponseBytes: 16 * 1024 * 1024,
            limit: 500
        }, 8), 4194);
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
            assert.deepStrictEqual(small, {
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
