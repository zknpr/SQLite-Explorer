import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

interface ParsedFont {
    tables: Map<string, { checksum: number; offset: number; length: number }>;
    numGlyphs: number;
    indexToLocFormat: number;
    cmap: Map<number, number>;
    glyph(glyph: number): Uint8Array;
    metrics(glyph: number): { advance: number; lsb: number };
}
interface CodiconSource { file: string; text: string }

const require = createRequire(import.meta.url);
const lib = require('../../scripts/lib/codicon-subset.mjs') as {
    parseTrueType(font: Uint8Array): ParsedFont;
    subsetTrueTypeFont(font: Uint8Array, codePoints: number[]): Buffer;
    assembleSfnt(tables: Map<string, Uint8Array>): Buffer;
    chooseLocaFormat(glyfLength: number): number;
    readCodiconSources(root: string): CodiconSource[];
    collectCodiconClasses(sources: CodiconSource[]): string[];
    planCodiconCss(css: string, usedClasses: string[], sourceLabel: string): { codePoints: number[]; render(fontToken: string): string };
    buildCodiconSubset(input: { css: string; font: Uint8Array; usedClasses: string[]; sourceLabel: string }): { css: string; font: Buffer; codePoints: number[] };
};

const packageDir = path.resolve('node_modules/@vscode/codicons');
const fullCss = fs.readFileSync(path.join(packageDir, 'dist/codicon.css'), 'utf8');
const fullFont = fs.readFileSync(path.join(packageDir, 'dist/codicon.ttf'));
const sourceLabel = `@vscode/codicons ${JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).version}`;
const usedClasses = lib.collectCodiconClasses(lib.readCodiconSources(process.cwd()));
const build = (classes = usedClasses) => lib.buildCodiconSubset({ css: fullCss, font: fullFont, usedClasses: classes, sourceLabel });

// Parsed independently of the subsetter's CSS planner.
function iconCodePoints(css: string): Map<string, number> {
    const icons = new Map<string, number>();
    for (const match of css.matchAll(/^\.(codicon-[a-z0-9-]+):before \{ content: "\\([0-9a-f]+)" \}$/gm)) {
        icons.set(match[1], Number.parseInt(match[2], 16));
    }
    return icons;
}
const fullIcons = iconCodePoints(fullCss);

function sfntChecksum(bytes: Uint8Array): number {
    const padded = Buffer.concat([Buffer.from(bytes), Buffer.alloc((4 - (bytes.length % 4)) % 4)]);
    let sum = 0;
    for (let at = 0; at < padded.length; at += 4) sum = (sum + padded.readUInt32BE(at)) >>> 0;
    return sum;
}

function tablesOf(font: Uint8Array): Map<string, Buffer> {
    const parsed = lib.parseTrueType(font);
    return new Map([...parsed.tables].map(([tag, record]) => [tag, Buffer.from(font.subarray(record.offset, record.offset + record.length))]));
}

function tableRecord(font: Buffer, tag: string): number {
    for (let i = 0; i < font.readUInt16BE(4); i++) {
        if (font.toString('latin1', 12 + i * 16, 16 + i * 16) === tag) return 12 + i * 16;
    }
    throw new Error(`no ${tag} record`);
}

/** Full font with some glyphs replaced, written with a long loca. */
function withGlyphs(replace: Map<number, Buffer>): Buffer {
    const parsed = lib.parseTrueType(fullFont);
    const tables = tablesOf(fullFont);
    const glyphs = Array.from({ length: parsed.numGlyphs }, (_, glyph) => {
        const data = replace.get(glyph) ?? Buffer.from(parsed.glyph(glyph));
        return Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
    });
    const loca = Buffer.alloc((glyphs.length + 1) * 4);
    let at = 0;
    glyphs.forEach((data, glyph) => { loca.writeUInt32BE(at, glyph * 4); at += data.length; });
    loca.writeUInt32BE(at, glyphs.length * 4);
    const head = Buffer.from(tables.get('head')!);
    head.writeInt16BE(1, 50);
    tables.set('glyf', Buffer.concat(glyphs));
    tables.set('loca', loca);
    tables.set('head', head);
    return lib.assembleSfnt(tables);
}

/** One-component composite (ARG_1_AND_2_ARE_WORDS | ARGS_ARE_XY_VALUES) of `component`. */
function composite(component: number): Buffer {
    const data = Buffer.alloc(18);
    data.writeInt16BE(-1, 0);
    Buffer.from(lib.parseTrueType(fullFont).glyph(component)).copy(data, 2, 2, 10);
    data.writeUInt16BE(0x0003, 10);
    data.writeUInt16BE(component, 12);
    return data;
}

describe('codicon TrueType subsetter', () => {
    const full = lib.parseTrueType(fullFont);
    const subset = build();
    const parsed = lib.parseTrueType(subset.font);
    const usedIcons = usedClasses.filter(name => fullIcons.has(name));
    const usedCodePoints = [...new Set(usedIcons.map(name => fullIcons.get(name)!))].sort((a, b) => a - b);

    it('parses the full font and resolves every icon rule to a real glyph', () => {
        assert.ok(fullIcons.size > 500, `expected the full icon set, parsed ${fullIcons.size}`);
        for (const [name, cp] of fullIcons) {
            const glyph = full.cmap.get(cp);
            assert.ok(glyph !== undefined && glyph > 0 && glyph < full.numGlyphs, `${name} U+${cp.toString(16)}`);
        }
    });

    it('keeps glyph 0 plus exactly the used glyphs, with byte-identical outlines and metrics', () => {
        assert.ok(usedIcons.length >= 20, `scan found ${usedIcons.length} icon classes`);
        assert.deepEqual(subset.codePoints, usedCodePoints);
        assert.deepEqual([...parsed.cmap.keys()].sort((a, b) => a - b), usedCodePoints);
        const oldGlyphs = [...new Set(usedCodePoints.map(cp => full.cmap.get(cp)!))].sort((a, b) => a - b);
        assert.equal(parsed.numGlyphs, oldGlyphs.length + 1);
        assert.deepEqual(Buffer.from(parsed.glyph(0)), Buffer.from(full.glyph(0)));
        assert.deepEqual(parsed.metrics(0), full.metrics(0));
        for (const cp of usedCodePoints) {
            const oldGlyph = full.cmap.get(cp)!;
            const newGlyph = parsed.cmap.get(cp)!;
            // New IDs follow the original glyph order.
            assert.equal(newGlyph, oldGlyphs.indexOf(oldGlyph) + 1, `U+${cp.toString(16)}`);
            assert.ok(Buffer.from(parsed.glyph(newGlyph)).length > 0, `U+${cp.toString(16)} has an outline`);
            assert.deepEqual(Buffer.from(parsed.glyph(newGlyph)), Buffer.from(full.glyph(oldGlyph)), `U+${cp.toString(16)} outline`);
            assert.deepEqual(parsed.metrics(newGlyph), full.metrics(oldGlyph), `U+${cp.toString(16)} metrics`);
        }
    });

    it('writes an exact table directory, checksums, and derived table fields', () => {
        const font = subset.font;
        const numTables = font.readUInt16BE(4);
        const tags = Array.from({ length: numTables }, (_, i) => font.toString('latin1', 12 + i * 16, 16 + i * 16));
        assert.equal(font.readUInt32BE(0), 0x00010000);
        assert.deepEqual(tags, ['OS/2', 'cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post']);
        const entrySelector = Math.floor(Math.log2(numTables));
        assert.equal(font.readUInt16BE(6), 16 * 2 ** entrySelector);
        assert.equal(font.readUInt16BE(8), entrySelector);
        assert.equal(font.readUInt16BE(10), numTables * 16 - 16 * 2 ** entrySelector);

        let expectedOffset = 12 + numTables * 16;
        const tables = new Map<string, Buffer>();
        tags.forEach((tag, i) => {
            const record = 12 + i * 16;
            const offset = font.readUInt32BE(record + 8);
            const length = font.readUInt32BE(record + 12);
            assert.equal(offset, expectedOffset, `${tag} offset`);
            const padded = Buffer.from(font.subarray(offset, offset + ((length + 3) & ~3)));
            assert.ok(padded.subarray(length).every(byte => byte === 0), `${tag} padding`);
            const data = Buffer.from(padded.subarray(0, length));
            tables.set(tag, data);
            const forChecksum = Buffer.from(data);
            if (tag === 'head') forChecksum.writeUInt32BE(0, 8);
            assert.equal(font.readUInt32BE(record + 4), sfntChecksum(forChecksum), `${tag} checksum`);
            expectedOffset = offset + padded.length;
        });
        assert.equal(font.length, expectedOffset);
        // checkSumAdjustment makes the whole file sum to the magic constant.
        assert.equal(sfntChecksum(font), 0xb1b0afba);

        const original = tablesOf(fullFont);
        const differsOnlyAt = (tag: string, ranges: Array<[number, number]>) => {
            const before = original.get(tag)!;
            const after = tables.get(tag)!;
            assert.equal(after.length, before.length, `${tag} length`);
            for (let at = 0; at < after.length; at++) {
                if (!ranges.some(([start, end]) => at >= start && at < end)) assert.equal(after[at], before[at], `${tag} byte ${at}`);
            }
        };
        const glyphs = parsed.numGlyphs;
        differsOnlyAt('head', [[8, 12], [50, 52]]);
        differsOnlyAt('hhea', [[34, 36]]);
        differsOnlyAt('maxp', [[4, 6]]);
        differsOnlyAt('OS/2', [[64, 68], [94, 96]]);
        differsOnlyAt('name', []);
        assert.equal(tables.get('head')!.readInt16BE(50), 0);
        assert.equal(tables.get('loca')!.length, (glyphs + 1) * 2);
        assert.equal(tables.get('loca')!.readUInt16BE(glyphs * 2) * 2, tables.get('glyf')!.length);
        assert.equal(tables.get('hhea')!.readUInt16BE(34), glyphs);
        assert.equal(tables.get('maxp')!.readUInt16BE(4), glyphs);
        assert.equal(tables.get('hmtx')!.length, glyphs * 4);
        assert.equal(tables.get('OS/2')!.readUInt16BE(64), usedCodePoints[0]);
        assert.equal(tables.get('OS/2')!.readUInt16BE(66), usedCodePoints.at(-1));
        const post = tables.get('post')!;
        assert.equal(post.length, 32);
        assert.equal(post.readUInt32BE(0), 0x00030000);
        assert.deepEqual(post.subarray(4), original.get('post')!.subarray(4, 32));

        const cmap = tables.get('cmap')!;
        assert.equal(cmap.readUInt16BE(0), 0);
        assert.equal(cmap.readUInt16BE(2), 2);
        assert.deepEqual([[cmap.readUInt16BE(4), cmap.readUInt16BE(6)], [cmap.readUInt16BE(12), cmap.readUInt16BE(14)]], [[0, 3], [3, 1]]);
        assert.equal(cmap.readUInt32BE(8), 20);
        assert.equal(cmap.readUInt32BE(16), 20);
        const f4 = cmap.subarray(20);
        const segCount = f4.readUInt16BE(6) / 2;
        const segmentSelector = Math.floor(Math.log2(segCount));
        assert.equal(f4.readUInt16BE(0), 4);
        assert.equal(f4.readUInt16BE(2), f4.length);
        assert.equal(f4.length, 16 + segCount * 8);
        assert.equal(f4.readUInt16BE(8), 2 * 2 ** segmentSelector);
        assert.equal(f4.readUInt16BE(10), segmentSelector);
        assert.equal(f4.readUInt16BE(12), segCount * 2 - 2 * 2 ** segmentSelector);
        assert.equal(f4.readUInt16BE(14 + (segCount - 1) * 2), 0xffff);
    });

    it('produces byte-identical output for the same inputs in any class order', () => {
        const again = build([...usedClasses].reverse());
        assert.ok(again.font.equals(subset.font));
        assert.equal(again.css, subset.css);
    });

    it('chooses long loca once glyf outgrows 16-bit half-offsets', () => {
        assert.equal(lib.chooseLocaFormat(0x1fffe), 0);
        assert.equal(lib.chooseLocaFormat(0x20000), 1);
        assert.throws(() => lib.chooseLocaFormat(3), /even/);
    });

    it('keeps composite components and remaps their glyph IDs', () => {
        const parent = full.cmap.get(0xea60)!;
        const component = full.cmap.get(0xeb37)!;
        const font = withGlyphs(new Map([[parent, composite(component)]]));
        const result = lib.parseTrueType(lib.subsetTrueTypeFont(font, [0xea60]));
        assert.equal(result.numGlyphs, 3);
        const newParent = result.cmap.get(0xea60)!;
        const data = Buffer.from(result.glyph(newParent));
        const newComponent = data.readUInt16BE(12);
        assert.equal(newComponent, parent < component ? 2 : 1);
        assert.deepEqual(Buffer.from(result.glyph(newComponent)), Buffer.from(full.glyph(component)));
        const expected = Buffer.concat([composite(component), Buffer.alloc(2)]);
        expected.writeUInt16BE(newComponent, 12);
        assert.deepEqual(data, expected);
    });

    it('rejects a composite cycle', () => {
        const parent = full.cmap.get(0xea60)!;
        assert.throws(() => lib.subsetTrueTypeFont(withGlyphs(new Map([[parent, composite(parent)]])), [0xea60]), /cycle/);
    });

    const patched = (change: (font: Buffer) => void) => {
        const font = Buffer.from(fullFont);
        change(font);
        return font;
    };
    const cases: Array<[string, () => unknown, RegExp]> = [
        ['a non-byte input', () => lib.parseTrueType('font' as unknown as Uint8Array), /Uint8Array/],
        ['a truncated file', () => lib.parseTrueType(fullFont.subarray(0, 100)), /exceeds|outside/],
        ['CFF outlines', () => lib.parseTrueType(patched(font => font.write('OTTO', 0, 'latin1'))), /not TrueType/],
        ['a table past the end of the file', () => lib.parseTrueType(patched(font => font.writeUInt32BE(0x7fffffff, tableRecord(font, 'glyf') + 12))), /outside/],
        ['a non-monotonic loca', () => lib.parseTrueType(patched(font => font.writeUInt16BE(0, font.readUInt32BE(tableRecord(font, 'loca') + 8) + 10))), /monotonic/],
        ['a missing table', () => {
            const tables = tablesOf(fullFont);
            tables.delete('name');
            return lib.parseTrueType(lib.assembleSfnt(tables));
        }, /missing name/],
        ['an unreviewed table', () => {
            const tables = tablesOf(fullFont);
            tables.set('fpgm', Buffer.alloc(4));
            return lib.parseTrueType(lib.assembleSfnt(tables));
        }, /unexpected "fpgm"/],
        ['a no-subsetting fsType', () => lib.parseTrueType(patched(font => font.writeUInt16BE(0x0100, font.readUInt32BE(tableRecord(font, 'OS/2') + 8) + 8))), /fsType/],
        ['disagreeing cmap subtables', () => lib.parseTrueType(patched(font => {
            const cmap = font.readUInt32BE(tableRecord(font, 'cmap') + 8);
            for (let i = 0; i < font.readUInt16BE(cmap + 2); i++) {
                if (font.readUInt16BE(cmap + 4 + i * 8) === 3 && font.readUInt16BE(cmap + 6 + i * 8) === 10) {
                    const group = cmap + font.readUInt32BE(cmap + 8 + i * 8) + 16;
                    font.writeUInt32BE(font.readUInt32BE(group + 8) + 1, group + 8);
                }
            }
        })), /disagrees/],
        ['a GSUB lookup that can substitute a single glyph', () => {
            const tables = tablesOf(fullFont);
            tables.set('GSUB', Buffer.from([0, 1, 0, 0, 0, 0, 0, 0, 0, 10, 0, 1, 0, 4, 0, 1, 0, 0, 0, 0]));
            return lib.subsetTrueTypeFont(lib.assembleSfnt(tables), [0xea60]);
        }, /only ligature/],
        ['a code point the font does not map', () => lib.subsetTrueTypeFont(fullFont, [0x41]), /U\+0041 has no glyph/],
        ['a code point a format 4 cmap cannot carry', () => lib.subsetTrueTypeFont(fullFont, [0x1f600]), /outside U\+0000\.\.U\+FFFE/]
    ];
    for (const [label, run, expected] of cases) {
        it(`throws on ${label}`, () => assert.throws(run, expected));
    }
});

describe('codicon CSS subset and source scan', () => {
    it('keeps the header, @font-face, base rule and only the used icon rules', () => {
        const { css, font } = build();
        assert.ok(css.startsWith(fullCss.slice(0, fullCss.indexOf('*/') + 2)));
        assert.ok(css.includes(`url("./codicon.ttf?${createHash('sha256').update(font).digest('hex').slice(0, 32)}")`));
        assert.ok(css.includes(".codicon[class*='codicon-'] {"));
        const kept = iconCodePoints(css);
        assert.deepEqual([...kept.keys()].sort(), usedClasses.filter(name => fullIcons.has(name)).sort());
        for (const [name, cp] of kept) assert.equal(cp, fullIcons.get(name));
        assert.ok(!css.includes('codicon-modifier') && !css.includes('@keyframes'), 'no modifier is used today');
    });

    it('keeps a modifier rule and its keyframes only when the UI uses that modifier', () => {
        const css = lib.planCodiconCss(fullCss, ['codicon-sync', 'codicon-modifier-spin'], 'test').render('0');
        assert.match(css, /@keyframes codicon-spin/);
        assert.match(css, /\.codicon-sync\.codicon-modifier-spin/);
        assert.doesNotMatch(css, /\.codicon-loading \{/);
        assert.doesNotMatch(lib.planCodiconCss(fullCss, ['codicon-sync'], 'test').render('0'), /codicon-spin|modifier/);
    });

    it('fails when the UI names a class codicon.css does not define', () => {
        assert.throws(() => lib.planCodiconCss(fullCss, ['codicon-add', 'codicon-not-an-icon'], 'test'), /\.codicon-not-an-icon/);
    });

    it('collects literal class names and rejects names it cannot resolve statically', () => {
        assert.deepEqual(
            lib.collectCodiconClasses([{ file: 'a.js', text: "el.className = 'codicon codicon-add';\nhtml`<span class=\"codicon codicon-file-pdf\">`" }]),
            ['codicon-add', 'codicon-file-pdf']
        );
        for (const text of ["'codicon-' + name", '`codicon-${name}`', '`codicon-file-${kind}`', '`codicon-file${suffix}`', "'codicon-Add'"]) {
            assert.throws(() => lib.collectCodiconClasses([{ file: 'ui.js', text: `\n${text}` }]), /ui\.js:2: "codicon-"/, text);
        }
    });

    it('scans the authored UI sources, not the generated viewer bundle', () => {
        const files = lib.readCodiconSources(process.cwd()).map(source => source.file);
        assert.ok(files.includes('core/ui/viewer.template.html'));
        assert.ok(files.includes('core/ui/modules/grid-render.js'));
        assert.ok(files.includes('src/editorController.ts'));
        assert.ok(!files.includes('core/ui/viewer.html'));
    });
});

describe('built codicon assets', () => {
    const cssPath = path.resolve('assets/codicons/codicon.css');
    const fontPath = path.resolve('assets/codicons/codicon.ttf');

    it('define every codicon class the UI references, with the full font glyph', () => {
        assert.ok(fs.existsSync(cssPath) && fs.existsSync(fontPath), 'run node scripts/build.mjs before the unit suite');
        const shippedCss = fs.readFileSync(cssPath, 'utf8');
        const shippedFont = lib.parseTrueType(fs.readFileSync(fontPath));
        const full = lib.parseTrueType(fullFont);
        const shippedIcons = iconCodePoints(shippedCss);
        // The tracked viewer bundle is what ships; it must not name a class the authored-source scan missed.
        const referenced = lib.collectCodiconClasses([
            ...lib.readCodiconSources(process.cwd()),
            { file: 'core/ui/viewer.html', text: fs.readFileSync('core/ui/viewer.html', 'utf8') }
        ]);
        assert.deepEqual(referenced, usedClasses);
        for (const name of referenced) {
            const cp = shippedIcons.get(name);
            assert.ok(cp !== undefined, `${name} is missing from assets/codicons/codicon.css`);
            assert.equal(cp, fullIcons.get(name), name);
            const glyph = shippedFont.cmap.get(cp)!;
            assert.ok(glyph > 0, `${name} has no glyph in assets/codicons/codicon.ttf`);
            assert.deepEqual(Buffer.from(shippedFont.glyph(glyph)), Buffer.from(full.glyph(full.cmap.get(cp)!)), name);
        }
        for (const [name, cp] of shippedIcons) assert.ok(shippedFont.cmap.has(cp), `${name} U+${cp.toString(16)}`);
        const fresh = build();
        assert.equal(shippedCss, fresh.css, 'assets/codicons/codicon.css is stale; rebuild');
        assert.ok(fs.readFileSync(fontPath).equals(fresh.font), 'assets/codicons/codicon.ttf is stale; rebuild');
    });
});
