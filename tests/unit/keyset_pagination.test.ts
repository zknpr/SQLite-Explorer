import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  assembleKeysetSelect,
  computeKeysetKey,
  computeKeysetQueryTag,
  decodeKeysetAnchor,
  encodeKeysetAnchor,
  keysetFallbackOrder,
  MAX_KEYSET_ANCHOR_BYTES,
  mintKeysetAnchors,
  resolveKeysetPlan,
  type ResolvedKeysetPlan
} from '../../src/core/keyset-pagination';
import { buildSelectQuery } from '../../src/core/query-builder';
import type { TableIdentity, TableQueryOptions } from '../../src/core/types';

const ROWID_IDENTITY: TableIdentity = { kind: 'rowid' };
const COMPOSITE_IDENTITY: TableIdentity = {
  kind: 'primaryKey',
  columns: [
    { identifier: 'tenant', declaredType: 'TEXT', position: 1 },
    { identifier: 'seq', declaredType: 'INTEGER', position: 2 }
  ]
};

function plan(
  table: string,
  options: TableQueryOptions,
  identity: TableIdentity = ROWID_IDENTITY
): ResolvedKeysetPlan {
  const resolved = resolveKeysetPlan(table, options, identity);
  assert.ok(resolved, 'expected the keyset request to resolve');
  return resolved;
}

function anchorFor(
  table: string,
  options: TableQueryOptions,
  values: readonly (string | number | bigint | null | Uint8Array)[]
): string {
  return encodeKeysetAnchor(computeKeysetQueryTag(table, options), values);
}

describe('keyset query tag', () => {
  const base: TableQueryOptions = {
    columns: ['rowid', 'a', 'b'],
    globalFilterColumns: ['a', 'b'],
    orderBy: 'a',
    orderDir: 'ASC',
    limit: 50,
    offset: 100,
    filters: [{ column: 'a', value: 'x' }]
  };

  it('ignores offset, projection, byte budgets, and inactive filters', () => {
    const tag = computeKeysetQueryTag('t', base);
    assert.strictEqual(tag, computeKeysetQueryTag('t', { ...base, offset: 12345 }));
    assert.strictEqual(tag, computeKeysetQueryTag('t', { ...base, maxInlineCellBytes: 7 }));
    assert.strictEqual(
      tag,
      computeKeysetQueryTag('t', {
        ...base,
        filters: [...base.filters!, { column: 'b', value: '   ' }]
      })
    );
    // The searched column set only matters while a global filter is active.
    assert.strictEqual(
      tag,
      computeKeysetQueryTag('t', { ...base, globalFilterColumns: ['a'] })
    );
  });

  it('changes with table, sort, direction, page size, and active filters', () => {
    const tag = computeKeysetQueryTag('t', base);
    assert.notStrictEqual(tag, computeKeysetQueryTag('other', base));
    assert.notStrictEqual(tag, computeKeysetQueryTag('t', { ...base, orderBy: 'b' }));
    assert.notStrictEqual(tag, computeKeysetQueryTag('t', { ...base, orderDir: 'DESC' }));
    assert.notStrictEqual(tag, computeKeysetQueryTag('t', { ...base, limit: 100 }));
    assert.notStrictEqual(tag, computeKeysetQueryTag('t', { ...base, filters: [] }));
    assert.notStrictEqual(tag, computeKeysetQueryTag('t', { ...base, globalFilter: 'q' }));
    const withGlobal = { ...base, globalFilter: 'q' };
    assert.notStrictEqual(
      computeKeysetQueryTag('t', withGlobal),
      computeKeysetQueryTag('t', { ...withGlobal, globalFilterColumns: ['a'] })
    );
  });

  it('normalizes direction when unsorted', () => {
    const unsorted = { ...base, orderBy: undefined };
    assert.strictEqual(
      computeKeysetQueryTag('t', unsorted),
      computeKeysetQueryTag('t', { ...unsorted, orderDir: 'DESC' })
    );
  });
});

describe('keyset key derivation', () => {
  it('uses identity order for unsorted queries and honors ORDER BY rowid', () => {
    assert.deepStrictEqual(computeKeysetKey({ limit: 5 }, ROWID_IDENTITY), {
      keyColumns: ['rowid'],
      nullableSortKey: false,
      direction: 'ASC'
    });
    assert.deepStrictEqual(
      computeKeysetKey({ orderBy: 'rowid', orderDir: 'DESC' }, ROWID_IDENTITY),
      { keyColumns: ['rowid'], nullableSortKey: false, direction: 'DESC' }
    );
    assert.deepStrictEqual(
      computeKeysetKey({
        columns: ['rowid', 'tenant', 'seq', 'value'],
        orderBy: 'rowid',
        orderDir: 'DESC'
      }, COMPOSITE_IDENTITY),
      { keyColumns: ['tenant', 'seq'], nullableSortKey: false, direction: 'DESC' }
    );
  });

  it('treats a visible WITHOUT ROWID rowid column as ordinary sortable data', () => {
    assert.deepStrictEqual(
      computeKeysetKey({
        columns: ['rowid', 'tenant', 'rowid', 'value'],
        orderBy: 'rowid',
        orderDir: 'DESC'
      }, COMPOSITE_IDENTITY),
      {
        keyColumns: ['rowid', 'tenant', 'seq'],
        nullableSortKey: true,
        direction: 'DESC'
      }
    );
  });

  it('appends the identity tiebreak to a plain sort column', () => {
    assert.deepStrictEqual(
      computeKeysetKey({ orderBy: 'value', orderDir: 'DESC' }, COMPOSITE_IDENTITY),
      { keyColumns: ['value', 'tenant', 'seq'], nullableSortKey: true, direction: 'DESC' }
    );
  });

  it('dedupes a sort column that is an identity member and keeps it NOT NULL', () => {
    assert.deepStrictEqual(
      computeKeysetKey({ orderBy: 'seq' }, COMPOSITE_IDENTITY),
      { keyColumns: ['seq', 'tenant'], nullableSortKey: false, direction: 'ASC' }
    );
  });

  it('refuses external ordering contracts and missing identities', () => {
    assert.strictEqual(computeKeysetKey({ orderByColumns: ['a'] }, ROWID_IDENTITY), undefined);
    assert.strictEqual(computeKeysetKey({}, undefined), undefined);
  });
});

describe('keyset anchor codec', () => {
  const tag = computeKeysetQueryTag('t', { limit: 10 });

  it('round-trips every storage class with full fidelity', () => {
    const cases: Array<[readonly (string | number | bigint | null | Uint8Array)[], unknown[]]> = [
      [[42n], [42]],
      // Beyond 2^53: decodes to the exact decimal string SQLite binds via affinity.
      [[9007199254740993n], ['9007199254740993']],
      [[9223372036854775807n], ['9223372036854775807']],
      [[-9223372036854775808n], ['-9223372036854775808']],
      [[1.5], [1.5]],
      [[Number.NEGATIVE_INFINITY], [Number.NEGATIVE_INFINITY]],
      [[Number.POSITIVE_INFINITY], [Number.POSITIVE_INFINITY]],
      [[9.652937795298495e282], [9.652937795298495e282]],
      [['hello "world"'], ['hello "world"']],
      [[''], ['']],
      [['😀 unicode'], ['😀 unicode']],
      [[Uint8Array.from([0, 255, 16])], [Uint8Array.from([0, 255, 16])]],
      [[new Uint8Array(0)], [new Uint8Array(0)]],
      [[null, 'x', 7n], [null, 'x', 7]]
    ];
    for (const [values, expected] of cases) {
      const decoded = decodeKeysetAnchor(encodeKeysetAnchor(tag, values));
      assert.strictEqual(decoded.tag, tag);
      assert.deepStrictEqual(decoded.values, expected);
    }
  });

  it('exposes each value slot storage class for predicate binding', () => {
    const decoded = decodeKeysetAnchor(
      encodeKeysetAnchor(tag, [null, 'x', 1.5, 7n, Uint8Array.from([1])])
    );
    assert.deepStrictEqual(
      decoded.valueClasses,
      ['null', 'text', 'real', 'integer', 'blob']
    );
  });

  it('rejects malformed, non-canonical, and type-confused tokens', () => {
    const forge = (payload: unknown) =>
      'ksa:' + encodeURIComponent(JSON.stringify(payload));
    const good = encodeKeysetAnchor(tag, [1n]);
    const hostile: unknown[] = [
      undefined,
      null,
      42,
      { anchor: good },
      '',
      'pk:whatever',
      'ksa:',
      'ksa:%',                                  // broken URI encoding
      'ksa:not json',
      good + 'x',                               // trailing garbage
      good.slice(0, -4),                        // truncated
      forge([1]),                               // array payload
      forge({ v: 1, t: tag }),                  // missing k
      forge({ v: 1, t: tag, k: [], x: 1 }),     // extra key
      forge({ v: 2, t: tag, k: [['integer', '1']] }),   // wrong version
      forge({ v: 1, t: 7, k: [['integer', '1']] }),     // non-string tag
      forge({ v: 1, t: tag, k: [] }),                   // no key values
      forge({ v: 1, t: tag, k: ['integer'] }),          // member not a pair
      forge({ v: 1, t: tag, k: [['integer', 5]] }),     // integer as number
      forge({ v: 1, t: tag, k: [['integer', '+1']] }),  // non-canonical integer
      forge({ v: 1, t: tag, k: [['integer', '01']] }),
      forge({ v: 1, t: tag, k: [['integer', '1 ']] }),
      forge({ v: 1, t: tag, k: [['integer', '99999999999999999999']] }), // out of int64
      forge({ v: 1, t: tag, k: [['real', 'NaN']] }),
      forge({ v: 1, t: tag, k: [['real', Number.NaN]] }),
      forge({ v: 1, t: tag, k: [['text', 7]] }),
      forge({ v: 1, t: tag, k: [['blob', 'zz']] }),     // bad hex
      forge({ v: 1, t: tag, k: [['blob', 'abc']] }),    // odd-length hex
      forge({ v: 1, t: tag, k: [['blob', 'AB']] }),     // uppercase hex
      forge({ v: 1, t: tag, k: [['null', 0]] }),        // null with payload
      forge({ v: 1, t: tag, k: [['boolean', true]] }),  // unknown class
      forge({ t: tag, v: 1, k: [['integer', '1']] })    // reordered keys: non-canonical
    ];
    // The reordered-keys case only differs textually; assert it truly differs
    // from the canonical token before asserting rejection.
    assert.notStrictEqual(hostile[hostile.length - 1], good);
    for (const token of hostile) {
      assert.throws(
        () => decodeKeysetAnchor(token),
        /keyset anchor/i,
        `expected rejection for ${String(token).slice(0, 80)}`
      );
    }
  });

  it('rejects encoded anchors that exceed the response-safe per-anchor budget', () => {
    // '%' expands to three ASCII bytes under encodeURIComponent, so this
    // crosses the encoded budget without allocating a multi-megabyte fixture.
    const expansionHeavyText = '%'.repeat(Math.ceil(MAX_KEYSET_ANCHOR_BYTES / 3));
    assert.throws(
      () => encodeKeysetAnchor(tag, [expansionHeavyText]),
      /keyset anchor.*byte limit/i
    );
    assert.throws(
      () => decodeKeysetAnchor('ksa:' + 'a'.repeat(MAX_KEYSET_ANCHOR_BYTES)),
      /keyset anchor.*byte limit/i
    );
  });
});

describe('resolveKeysetPlan', () => {
  const options: TableQueryOptions = {
    columns: ['rowid', 'value'],
    limit: 5,
    offset: 10
  };

  it('resolves the five modes and validates the last-page remainder', () => {
    const first = resolveKeysetPlan('t', { ...options, keyset: { mode: 'first' } }, ROWID_IDENTITY);
    assert.strictEqual(first?.mode, 'first');
    assert.strictEqual(first?.limit, 5);
    assert.deepStrictEqual(first?.keyColumns, ['rowid']);

    const last = resolveKeysetPlan(
      't',
      { ...options, keyset: { mode: 'last', lastPageRowCount: 3 } },
      ROWID_IDENTITY
    );
    assert.strictEqual(last?.mode, 'last');
    assert.strictEqual(last?.limit, 3);

    for (const mode of ['after', 'atOrAfter', 'before'] as const) {
      const resolved = resolveKeysetPlan(
        't',
        { ...options, keyset: { mode, anchor: anchorFor('t', options, [7n]) } },
        ROWID_IDENTITY
      );
      assert.strictEqual(resolved?.mode, mode);
      assert.strictEqual(resolved?.limit, 5);
      assert.deepStrictEqual(resolved?.values, [7]);
      // Storage classes ride along so the predicate can bind INTEGER slots
      // through CAST(? AS INTEGER).
      assert.deepStrictEqual(resolved?.valueClasses, ['integer']);
    }
  });

  it('falls back (undefined) on every legitimate staleness signal', () => {
    const anchor = anchorFor('t', options, [7n]);
    // Control: the unmutated request resolves, so each `undefined` below is
    // caused by the mutated dimension alone.
    assert.ok(
      resolveKeysetPlan('t', { ...options, keyset: { mode: 'after', anchor } }, ROWID_IDENTITY)
    );
    // No request / bad request shapes.
    assert.strictEqual(resolveKeysetPlan('t', options, ROWID_IDENTITY), undefined);
    assert.strictEqual(
      resolveKeysetPlan('t', { ...options, keyset: 'after' as never }, ROWID_IDENTITY),
      undefined
    );
    assert.strictEqual(
      resolveKeysetPlan('t', { ...options, keyset: { mode: 'sideways' as never } }, ROWID_IDENTITY),
      undefined
    );
    // Missing identity (view/keyless) or page size.
    assert.strictEqual(
      resolveKeysetPlan('t', { ...options, keyset: { mode: 'first' } }, undefined),
      undefined
    );
    assert.strictEqual(
      resolveKeysetPlan('t', { ...options, limit: undefined, keyset: { mode: 'first' } }, ROWID_IDENTITY),
      undefined
    );
    // Missing anchor.
    assert.strictEqual(
      resolveKeysetPlan('t', { ...options, keyset: { mode: 'after' } }, ROWID_IDENTITY),
      undefined
    );
    // Tag mismatch: minted under a different table, sort, filter, or page size.
    for (const stale of [
      anchorFor('other', options, [7n]),
      anchorFor('t', { ...options, orderBy: 'value' }, ['x', 7n]),
      anchorFor('t', { ...options, limit: 6 }, [7n]),
      anchorFor('t', { ...options, filters: [{ column: 'value', value: 'q' }] }, [7n])
    ]) {
      assert.strictEqual(
        resolveKeysetPlan('t', { ...options, keyset: { mode: 'after', anchor: stale } }, ROWID_IDENTITY),
        undefined
      );
    }
    // Arity mismatch under a matching tag (schema changed): rowid tag carries
    // one key value; a two-value token cannot have been minted for it.
    const wrongArity = anchorFor('t', options, [7n, 8n]);
    assert.strictEqual(
      resolveKeysetPlan('t', { ...options, keyset: { mode: 'after', anchor: wrongArity } }, ROWID_IDENTITY),
      undefined
    );
    // Out-of-range remainder.
    for (const lastPageRowCount of [0, 6, 2.5, Number.NaN]) {
      assert.strictEqual(
        resolveKeysetPlan('t', { ...options, keyset: { mode: 'last', lastPageRowCount } }, ROWID_IDENTITY),
        undefined
      );
    }
  });

  it('throws on malformed tokens and forged NULL identity slots', () => {
    assert.throws(
      () => resolveKeysetPlan(
        't',
        { ...options, keyset: { mode: 'after', anchor: 'ksa:garbage' } },
        ROWID_IDENTITY
      ),
      /keyset anchor/i
    );
    const nullIdentity = anchorFor('t', options, [null]);
    assert.throws(
      () => resolveKeysetPlan(
        't',
        { ...options, keyset: { mode: 'after', anchor: nullIdentity } },
        ROWID_IDENTITY
      ),
      /NULL in an identity slot/
    );
    const sorted = { ...options, orderBy: 'value' };
    const nullTiebreak = anchorFor('t', sorted, ['x', null]);
    assert.throws(
      () => resolveKeysetPlan(
        't',
        { ...sorted, keyset: { mode: 'after', anchor: nullTiebreak } },
        ROWID_IDENTITY
      ),
      /NULL in an identity slot/
    );
  });
});

describe('keyset SQL assembly', () => {
  const rowidOptions: TableQueryOptions = {
    columns: ['rowid', 'value'],
    limit: 50,
    offset: 100
  };
  const build = (
    options: TableQueryOptions,
    identity: TableIdentity,
    mode: 'first' | 'after' | 'atOrAfter' | 'before' | 'last',
    anchorValues?: readonly (string | number | bigint | null | Uint8Array)[],
    lastPageRowCount?: number
  ) => {
    const keyset = {
      mode,
      ...(anchorValues ? { anchor: anchorFor('t', options, anchorValues) } : {}),
      ...(lastPageRowCount !== undefined ? { lastPageRowCount } : {})
    };
    const withKeyset = { ...options, keyset };
    return buildSelectQuery('t', withKeyset, plan('t', withKeyset, identity));
  };

  it('leaves the OFFSET query byte-identical when no plan is given', () => {
    const options: TableQueryOptions = {
      columns: ['rowid', 'value'],
      orderBy: 'value',
      orderDir: 'DESC',
      limit: 50,
      offset: 100,
      filters: [{ column: 'value', value: 'x' }]
    };
    assert.deepStrictEqual(
      buildSelectQuery('t', options, undefined),
      buildSelectQuery('t', options)
    );
    assert.strictEqual(
      buildSelectQuery('t', options).sql,
      'SELECT "rowid" AS "rowid", "value" FROM "t" WHERE "value" LIKE ? ESCAPE \'\\\' ' +
      'ORDER BY "value" DESC LIMIT 50 OFFSET 100'
    );
  });

  it('builds the five unsorted rowid navigations', () => {
    const first = buildSelectQuery(
      't',
      { ...rowidOptions, keyset: { mode: 'first' } },
      plan('t', { ...rowidOptions, keyset: { mode: 'first' } })
    );
    assert.deepStrictEqual(first, {
      sql: 'SELECT "rowid" AS "rowid", "value" FROM "t" ORDER BY "rowid" ASC LIMIT 50',
      params: []
    });

    // rowid slots are INTEGER-class: they bind through CAST(? AS INTEGER) so
    // int64 values beyond 2^53 (decoded to decimal strings) seek exactly.
    assert.deepStrictEqual(build(rowidOptions, ROWID_IDENTITY, 'after', [100n]), {
      sql: 'SELECT "rowid" AS "rowid", "value" FROM "t" WHERE "rowid" > CAST(? AS INTEGER) ' +
        'ORDER BY "rowid" ASC LIMIT 50',
      params: [100]
    });
    assert.deepStrictEqual(build(rowidOptions, ROWID_IDENTITY, 'atOrAfter', [100n]), {
      sql: 'SELECT "rowid" AS "rowid", "value" FROM "t" WHERE "rowid" >= CAST(? AS INTEGER) ' +
        'ORDER BY "rowid" ASC LIMIT 50',
      params: [100]
    });
    assert.deepStrictEqual(build(rowidOptions, ROWID_IDENTITY, 'before', [100n]), {
      sql: 'SELECT * FROM (SELECT "rowid" AS "rowid", "value" FROM "t" WHERE "rowid" < CAST(? AS INTEGER) ' +
        'ORDER BY "rowid" DESC LIMIT 50) ORDER BY "rowid" ASC',
      params: [100]
    });
    assert.deepStrictEqual(build(rowidOptions, ROWID_IDENTITY, 'last', undefined, 7), {
      sql: 'SELECT * FROM (SELECT "rowid" AS "rowid", "value" FROM "t" ' +
        'ORDER BY "rowid" DESC LIMIT 7) ORDER BY "rowid" ASC',
      params: []
    });
  });

  it('uses row-value comparators for composite identities', () => {
    const options: TableQueryOptions = { columns: ['tenant', 'seq', 'value'], limit: 10 };
    // Per-slot binding: TEXT stays a plain placeholder, INTEGER gets CAST.
    assert.deepStrictEqual(build(options, COMPOSITE_IDENTITY, 'after', ['north', 7n]), {
      sql: 'SELECT "tenant", "seq", "value" FROM "t" ' +
        'WHERE ("tenant", "seq") > (?, CAST(? AS INTEGER)) ' +
        'ORDER BY "tenant" ASC, "seq" ASC LIMIT 10',
      params: ['north', 7]
    });
  });

  it('composes the seek predicate inside existing filter clauses', () => {
    const options: TableQueryOptions = {
      columns: ['rowid', 'value'],
      limit: 10,
      filters: [{ column: 'value', value: 'needle' }]
    };
    assert.deepStrictEqual(build(options, ROWID_IDENTITY, 'after', [42n]), {
      sql: 'SELECT "rowid" AS "rowid", "value" FROM "t" WHERE "value" LIKE ? ESCAPE \'\\\' ' +
        'AND "rowid" > CAST(? AS INTEGER) ORDER BY "rowid" ASC LIMIT 10',
      params: ['%needle%', 42]
    });
  });

  it('binds REAL sort slots plainly and INTEGER sort slots through CAST', () => {
    const options: TableQueryOptions = { columns: ['rowid', 's'], orderBy: 's', limit: 4 };
    // REAL compares numerically with INTEGER storage in every affinity; only
    // the INTEGER class needs the CAST rescue.
    assert.deepStrictEqual(build(options, ROWID_IDENTITY, 'after', [1.5, 9n]), {
      sql: 'SELECT "rowid" AS "rowid", "s" FROM "t" WHERE ("s", "rowid") > (?, CAST(? AS INTEGER)) ' +
        'ORDER BY "s" ASC, "rowid" ASC LIMIT 4',
      params: [1.5, 9]
    });
    assert.deepStrictEqual(build(options, ROWID_IDENTITY, 'after', [9007199254740993n, 9n]), {
      sql: 'SELECT "rowid" AS "rowid", "s" FROM "t" ' +
        'WHERE ("s", "rowid") > (CAST(? AS INTEGER), CAST(? AS INTEGER)) ' +
        'ORDER BY "s" ASC, "rowid" ASC LIMIT 4',
      params: ['9007199254740993', 9]
    });
  });

  it('decomposes NULL sort boundaries in both directions', () => {
    const asc: TableQueryOptions = { columns: ['rowid', 's'], orderBy: 's', orderDir: 'ASC', limit: 4 };
    const desc: TableQueryOptions = { ...asc, orderDir: 'DESC' };

    // ASC, non-NULL anchor: NULLs sort first and are already behind us.
    assert.deepStrictEqual(build(asc, ROWID_IDENTITY, 'after', ['m', 9n]), {
      sql: 'SELECT "rowid" AS "rowid", "s" FROM "t" WHERE ("s", "rowid") > (?, CAST(? AS INTEGER)) ' +
        'ORDER BY "s" ASC, "rowid" ASC LIMIT 4',
      params: ['m', 9]
    });
    // ASC, NULL anchor: the rest of the NULL run, then every non-NULL row.
    // The CAST rides into the NULL-decomposed identity compare too.
    assert.deepStrictEqual(build(asc, ROWID_IDENTITY, 'after', [null, 9n]), {
      sql: 'SELECT "rowid" AS "rowid", "s" FROM "t" WHERE ' +
        '(("s" IS NULL AND "rowid" > CAST(? AS INTEGER)) OR "s" IS NOT NULL) ' +
        'ORDER BY "s" ASC, "rowid" ASC LIMIT 4',
      params: [9]
    });
    // ASC 'before' runs reversed (DESC), where the NULL run lies ahead.
    assert.deepStrictEqual(build(asc, ROWID_IDENTITY, 'before', ['m', 9n]), {
      sql: 'SELECT * FROM (SELECT "rowid" AS "rowid", "s" FROM "t" WHERE ' +
        '(("s", "rowid") < (?, CAST(? AS INTEGER)) OR "s" IS NULL) ' +
        'ORDER BY "s" DESC, "rowid" DESC LIMIT 4) ORDER BY "s" ASC, "rowid" ASC',
      params: ['m', 9]
    });
    assert.deepStrictEqual(build(asc, ROWID_IDENTITY, 'before', [null, 9n]), {
      sql: 'SELECT * FROM (SELECT "rowid" AS "rowid", "s" FROM "t" WHERE ' +
        '("s" IS NULL AND "rowid" < CAST(? AS INTEGER)) ' +
        'ORDER BY "s" DESC, "rowid" DESC LIMIT 4) ORDER BY "s" ASC, "rowid" ASC',
      params: [9]
    });

    // DESC, non-NULL anchor: the NULL run sorts last and lies ahead.
    assert.deepStrictEqual(build(desc, ROWID_IDENTITY, 'after', ['m', 9n]), {
      sql: 'SELECT "rowid" AS "rowid", "s" FROM "t" WHERE ' +
        '(("s", "rowid") < (?, CAST(? AS INTEGER)) OR "s" IS NULL) ' +
        'ORDER BY "s" DESC, "rowid" DESC LIMIT 4',
      params: ['m', 9]
    });
    // DESC, NULL anchor: only the rest of the NULL run remains.
    assert.deepStrictEqual(build(desc, ROWID_IDENTITY, 'after', [null, 9n]), {
      sql: 'SELECT "rowid" AS "rowid", "s" FROM "t" WHERE ' +
        '("s" IS NULL AND "rowid" < CAST(? AS INTEGER)) ' +
        'ORDER BY "s" DESC, "rowid" DESC LIMIT 4',
      params: [9]
    });
    // DESC 'before' runs reversed (ASC): larger values, NULLs excluded.
    assert.deepStrictEqual(build(desc, ROWID_IDENTITY, 'before', ['m', 9n]), {
      sql: 'SELECT * FROM (SELECT "rowid" AS "rowid", "s" FROM "t" WHERE ' +
        '("s", "rowid") > (?, CAST(? AS INTEGER)) ' +
        'ORDER BY "s" ASC, "rowid" ASC LIMIT 4) ORDER BY "s" DESC, "rowid" DESC',
      params: ['m', 9]
    });
    assert.deepStrictEqual(build(desc, ROWID_IDENTITY, 'before', [null, 9n]), {
      sql: 'SELECT * FROM (SELECT "rowid" AS "rowid", "s" FROM "t" WHERE ' +
        '(("s" IS NULL AND "rowid" > CAST(? AS INTEGER)) OR "s" IS NOT NULL) ' +
        'ORDER BY "s" ASC, "rowid" ASC LIMIT 4) ORDER BY "s" DESC, "rowid" DESC',
      params: [9]
    });
  });

  it('binds anchor values as parameters even for hostile strings', () => {
    const options: TableQueryOptions = { columns: ['rowid', 's'], orderBy: 's', limit: 4 };
    const { sql, params } = build(options, ROWID_IDENTITY, 'after', ['\'; DROP TABLE t; --', 1n]);
    assert.ok(!sql.includes('DROP TABLE'));
    assert.deepStrictEqual(params, ['\'; DROP TABLE t; --', 1]);
  });
});

describe('keyset fallback ordering', () => {
  // Mirrors the engine wiring: derive the key, and when no seek plan consumed
  // it, route the full key through the ordinary orderByColumns machinery.
  const applyFallback = (
    options: TableQueryOptions,
    identity: TableIdentity | undefined
  ) => {
    const key = computeKeysetKey(options, identity);
    const order = keysetFallbackOrder(key, undefined);
    return buildSelectQuery(
      't',
      order ? { ...options, orderBy: undefined, ...order } : options
    );
  };

  it('adopts the full keyset key for anchorable OFFSET pages', () => {
    // Unsorted anchorable: scan order becomes the explicit identity order.
    assert.strictEqual(
      applyFallback({ columns: ['rowid', 'value'], limit: 50, offset: 100 }, ROWID_IDENTITY).sql,
      'SELECT "rowid" AS "rowid", "value" FROM "t" ORDER BY "rowid" ASC LIMIT 50 OFFSET 100'
    );
    // Sorted: the bare sort column gains the uniform identity tiebreak, so
    // OFFSET tie order can no longer depend on SQLite's chosen plan.
    assert.strictEqual(
      applyFallback(
        { columns: ['rowid', 'value'], orderBy: 'value', orderDir: 'DESC', limit: 50, offset: 100 },
        ROWID_IDENTITY
      ).sql,
      'SELECT "rowid" AS "rowid", "value" FROM "t" ' +
      'ORDER BY "value" DESC, "rowid" DESC LIMIT 50 OFFSET 100'
    );
    // Composite identity sorted by a key member: deduped uniform order.
    assert.strictEqual(
      applyFallback(
        { columns: ['tenant', 'seq', 'value'], orderBy: 'seq', orderDir: 'ASC', limit: 10, offset: 20 },
        COMPOSITE_IDENTITY
      ).sql,
      'SELECT "tenant", "seq", "value" FROM "t" ORDER BY "seq" ASC, "tenant" ASC LIMIT 10 OFFSET 20'
    );
    // orderDir without a sort column is meaningless: identity stays ASC.
    assert.strictEqual(
      applyFallback({ columns: ['rowid', 'value'], orderDir: 'DESC', limit: 5 }, ROWID_IDENTITY).sql,
      'SELECT "rowid" AS "rowid", "value" FROM "t" ORDER BY "rowid" ASC LIMIT 5'
    );
    // The export streamer's rowid-ordered identity walk (the one non-grid
    // rowid-first caller, tableExportStreaming) already orders by the keyset
    // key: its SQL stays byte-identical.
    assert.strictEqual(
      applyFallback(
        { columns: ['rowid'], orderBy: 'rowid', orderDir: 'ASC', limit: 512, offset: 0 },
        ROWID_IDENTITY
      ).sql,
      'SELECT "rowid" AS "rowid" FROM "t" ORDER BY "rowid" ASC LIMIT 512 OFFSET 0'
    );
  });

  it('keeps non-anchorable queries byte-identical to the pre-keyset SQL', () => {
    // No identity (view, keyless object, shadowed rowid): unchanged scan...
    assert.strictEqual(
      applyFallback({ columns: ['rowid', 'value'], limit: 50, offset: 100 }, undefined).sql,
      'SELECT "rowid" AS "rowid", "value" FROM "t" LIMIT 50 OFFSET 100'
    );
    // ...and unchanged bare-column sort.
    assert.strictEqual(
      applyFallback(
        { columns: ['rowid', 'value'], orderBy: 'value', orderDir: 'DESC', limit: 50, offset: 100 },
        undefined
      ).sql,
      'SELECT "rowid" AS "rowid", "value" FROM "t" ORDER BY "value" DESC LIMIT 50 OFFSET 100'
    );
    // External multi-column ordering contracts are not grid queries.
    assert.strictEqual(
      applyFallback(
        { columns: ['a', 'b'], orderByColumns: ['a', 'b'], orderDir: 'DESC', limit: 5 },
        ROWID_IDENTITY
      ).sql,
      'SELECT "a", "b" FROM "t" ORDER BY "a" DESC, "b" DESC LIMIT 5'
    );
  });

  it('yields nothing when a keyset plan owns the ordering', () => {
    const options: TableQueryOptions = {
      columns: ['rowid', 'value'],
      limit: 5,
      keyset: { mode: 'first' }
    };
    const key = computeKeysetKey(options, ROWID_IDENTITY);
    const planned = resolveKeysetPlan('t', options, ROWID_IDENTITY);
    assert.ok(key && planned);
    assert.strictEqual(keysetFallbackOrder(key, planned), undefined);
    assert.strictEqual(keysetFallbackOrder(undefined, undefined), undefined);
  });
});

describe('mintKeysetAnchors', () => {
  const key = { keyColumns: ['s', 'rowid'], nullableSortKey: true, direction: 'ASC' as const };
  const projection = ['rowid', 's'];

  it('mints decodable anchors from exact source rows', () => {
    const minted = mintKeysetAnchors({
      tag: 'tag',
      key,
      projectionColumns: projection,
      rows: [[1n, 'alpha'], [9007199254740993n, null]]
    });
    assert.ok(minted?.first && minted?.last);
    assert.deepStrictEqual(decodeKeysetAnchor(minted.first).values, ['alpha', 1]);
    assert.deepStrictEqual(
      decodeKeysetAnchor(minted.last).values,
      [null, '9007199254740993']
    );
  });

  it('skips rows whose key cells cannot be reproduced faithfully', () => {
    // Containment-clipped sort value on the first row: only last anchors.
    const clipped = mintKeysetAnchors({
      tag: 'tag',
      key,
      projectionColumns: projection,
      rows: [[1n, 'clipped…'], [2n, 'ok']],
      oversizedCells: { 0: { 1: { storageClass: 'text', byteLength: 4096 } } }
    });
    assert.strictEqual(clipped?.first, undefined);
    assert.ok(clipped?.last);

    // SQLite stores signed infinities as REAL and the anchor codec preserves them.
    const infinite = mintKeysetAnchors({
      tag: 'tag',
      key,
      projectionColumns: projection,
      rows: [[1n, Number.POSITIVE_INFINITY]]
    });
    assert.deepStrictEqual(decodeKeysetAnchor(infinite?.first).values, [Infinity, 1]);
    assert.strictEqual(
      mintKeysetAnchors({
        tag: 'tag',
        key: { keyColumns: ['rowid'], nullableSortKey: false, direction: 'ASC' },
        projectionColumns: projection,
        rows: [[null, 'x']]
      }),
      undefined
    );
    // Key column missing from the projection.
    assert.strictEqual(
      mintKeysetAnchors({
        tag: 'tag',
        key,
        projectionColumns: ['other'],
        rows: [[1n]]
      }),
      undefined
    );
    assert.strictEqual(
      mintKeysetAnchors({ tag: 'tag', key, projectionColumns: projection, rows: [] }),
      undefined
    );
  });

  it('omits an over-budget boundary anchor so navigation falls back to OFFSET', () => {
    const expansionHeavyText = '%'.repeat(Math.ceil(MAX_KEYSET_ANCHOR_BYTES / 3));
    const minted = mintKeysetAnchors({
      tag: 'tag',
      key,
      projectionColumns: projection,
      rows: [[1n, expansionHeavyText], [2n, 'small']]
    });

    assert.strictEqual(minted?.first, undefined);
    assert.ok(minted?.last);
    assert.deepStrictEqual(decodeKeysetAnchor(minted.last).values, ['small', 2]);
  });
});

describe('assembleKeysetSelect input hygiene', () => {
  it('keeps caller-supplied filter clauses and params ahead of the predicate', () => {
    const assembled = assembleKeysetSelect({
      selectListSql: '"rowid" AS "rowid", "v"',
      escapedTable: '"t"',
      whereClauses: ['"v" LIKE ? ESCAPE \'\\\''],
      filterParams: ['%x%'],
      plan: {
        mode: 'after',
        keyColumns: ['rowid'],
        nullableSortKey: false,
        direction: 'ASC',
        values: [5],
        limit: 3
      }
    });
    assert.deepStrictEqual(assembled, {
      sql: 'SELECT "rowid" AS "rowid", "v" FROM "t" WHERE "v" LIKE ? ESCAPE \'\\\' ' +
        'AND "rowid" > ? ORDER BY "rowid" ASC LIMIT 3',
      params: ['%x%', 5]
    });
  });
});
