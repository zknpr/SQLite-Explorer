/**
 * Build-time codicon subsetting.
 *
 * The webview renders codicons only through `.codicon-NAME:before { content }`
 * code points, so the shipped CSS and font need only the rules and glyphs of
 * the classes the UI references. This is a deliberately narrow TrueType
 * subsetter for the @vscode/codicons font: it accepts exactly the table set
 * that font ships and throws on anything else, so a codicons update that
 * changes the font's layout fails the build instead of shipping a font that
 * renders wrong.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SFNT_TRUETYPE = 0x00010000;
const HEAD_MAGIC = 0x5f0f3cf5;
const CHECKSUM_MAGIC = 0xb1b0afba;
// Rebuilt or copied into the subset.
const KEPT_TABLES = ['OS/2', 'cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post'];
// Dropped once assertGsubInert() proves it cannot change a lone code point.
const DROPPED_TABLES = ['GSUB'];
// Unicode cmap subtables a renderer may pick (HarfBuzz prefers 32-bit ones).
const UNICODE_ENCODINGS = [[3, 10], [0, 4], [3, 1], [0, 3]];
const MAX_COMPONENT_DEPTH = 16;

function fail(message) {
  throw new Error(`codicon subset: ${message}`);
}

function hex(value, width = 4) {
  return value.toString(16).toUpperCase().padStart(width, '0');
}

/**
 * Bounds-checked big-endian reader over `length` bytes at `offset`.
 * DataView alone would throw a bare RangeError and Uint8Array.subarray clamps
 * silently, so every access goes through check().
 */
function reader(bytes, offset, length, what) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
    || offset < 0 || length < 0 || offset + length > bytes.length) {
    fail(`${what} [${offset}, +${length}) lies outside the ${bytes.length}-byte input`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, length);
  const check = (at, size) => {
    if (!Number.isSafeInteger(at) || at < 0 || at + size > length) {
      fail(`${what}: ${size}-byte read at ${at} exceeds its ${length} bytes`);
    }
  };
  return {
    length,
    u16: (at) => { check(at, 2); return view.getUint16(at); },
    i16: (at) => { check(at, 2); return view.getInt16(at); },
    u32: (at) => { check(at, 4); return view.getUint32(at); },
    bytes: (at, size) => { check(at, size); return bytes.subarray(offset + at, offset + at + size); }
  };
}

function parseFormat4(r, base, what) {
  const length = r.u16(base + 2);
  const table = reader(r.bytes(base, length), 0, length, what);
  const segCountX2 = table.u16(6);
  if (segCountX2 === 0 || segCountX2 % 2 !== 0) fail(`${what}: invalid segCountX2 ${segCountX2}`);
  const segCount = segCountX2 / 2;
  const endAt = 14;
  const startAt = endAt + segCountX2 + 2;
  const deltaAt = startAt + segCountX2;
  const rangeAt = deltaAt + segCountX2;
  const map = new Map();
  let previousEnd = -1;
  for (let s = 0; s < segCount; s++) {
    const end = table.u16(endAt + s * 2);
    const start = table.u16(startAt + s * 2);
    const delta = table.u16(deltaAt + s * 2);
    const rangeOffset = table.u16(rangeAt + s * 2);
    // Sorted, disjoint segments also bound the walk to 65,536 code points.
    if (start > end || start <= previousEnd) fail(`${what}: segment ${s} is unsorted or overlapping`);
    previousEnd = end;
    for (let cp = start; cp <= end; cp++) {
      if (cp === 0xffff) continue;
      let glyph = 0;
      if (rangeOffset === 0) {
        glyph = (cp + delta) & 0xffff;
      } else {
        glyph = table.u16(rangeAt + s * 2 + rangeOffset + (cp - start) * 2);
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph !== 0) map.set(cp, glyph);
    }
  }
  if (previousEnd !== 0xffff) fail(`${what}: last segment does not end at U+FFFF`);
  return map;
}

function parseFormat12(r, base, what) {
  const length = r.u32(base + 4);
  const table = reader(r.bytes(base, length), 0, length, what);
  const groups = table.u32(12);
  const map = new Map();
  let previousEnd = -1;
  for (let g = 0; g < groups; g++) {
    const start = table.u32(16 + g * 12);
    const end = table.u32(20 + g * 12);
    const firstGlyph = table.u32(24 + g * 12);
    if (start > end || start <= previousEnd || end > 0x10ffff) {
      fail(`${what}: group ${g} is unsorted, overlapping or beyond U+10FFFF`);
    }
    previousEnd = end;
    for (let cp = start; cp <= end; cp++) {
      const glyph = firstGlyph + (cp - start);
      if (glyph !== 0) map.set(cp, glyph);
    }
  }
  return map;
}

/**
 * Parse every Unicode cmap subtable a renderer could select. They must agree
 * on each mapped code point: otherwise the subset would pick one and the
 * browser might have rendered the other.
 */
function parseCmap(r, numGlyphs) {
  if (r.u16(0) !== 0) fail(`unsupported cmap version ${r.u16(0)}`);
  const count = r.u16(2);
  const parsed = new Map();
  let merged = null;
  for (let i = 0; i < count; i++) {
    const platform = r.u16(4 + i * 8);
    const encoding = r.u16(6 + i * 8);
    const offset = r.u32(8 + i * 8);
    if (!UNICODE_ENCODINGS.some(([p, e]) => p === platform && e === encoding)) continue;
    const what = `cmap (${platform},${encoding})`;
    let map = parsed.get(offset);
    if (!map) {
      const format = r.u16(offset);
      if (format === 4) map = parseFormat4(r, offset, what);
      else if (format === 12) map = parseFormat12(r, offset, what);
      else fail(`${what}: unsupported subtable format ${format}`);
      parsed.set(offset, map);
    }
    if (!merged) {
      merged = map;
    } else if (map !== merged) {
      if (map.size !== merged.size || [...map].some(([cp, glyph]) => merged.get(cp) !== glyph)) {
        fail(`${what} disagrees with another Unicode subtable`);
      }
    }
  }
  if (!merged) fail('no Unicode cmap subtable (format 4 or 12)');
  for (const [cp, glyph] of merged) {
    if (glyph >= numGlyphs) fail(`cmap maps U+${hex(cp)} to glyph ${glyph} of ${numGlyphs}`);
  }
  return merged;
}

/**
 * Parse a TrueType font far enough to subset it. Returns accessors over the
 * original bytes; nothing is copied.
 */
export function parseTrueType(input) {
  const bytes = input instanceof Uint8Array ? input : fail('font input must be a Uint8Array');
  const file = reader(bytes, 0, bytes.length, 'font');
  const version = file.u32(0);
  if (version !== SFNT_TRUETYPE) {
    fail(`sfnt version 0x${hex(version, 8)} is not TrueType outlines (0x00010000)`);
  }
  const numTables = file.u16(4);
  const tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(...file.bytes(at, 4));
    if (tables.has(tag)) fail(`duplicate ${tag} table`);
    const record = { checksum: file.u32(at + 4), offset: file.u32(at + 8), length: file.u32(at + 12) };
    reader(bytes, record.offset, record.length, `${tag} table`);
    tables.set(tag, record);
  }
  for (const tag of tables.keys()) {
    if (!KEPT_TABLES.includes(tag) && !DROPPED_TABLES.includes(tag)) {
      fail(`unexpected ${JSON.stringify(tag)} table; extend and re-verify the subsetter before shipping this font`);
    }
  }
  for (const tag of KEPT_TABLES) {
    if (!tables.has(tag)) fail(`missing ${tag} table`);
  }
  const table = (tag) => {
    const record = tables.get(tag);
    return reader(bytes, record.offset, record.length, `${tag} table`);
  };

  const head = table('head');
  if (head.u32(12) !== HEAD_MAGIC) fail('head magic number mismatch');
  const indexToLocFormat = head.i16(50);
  if (indexToLocFormat !== 0 && indexToLocFormat !== 1) fail(`invalid indexToLocFormat ${indexToLocFormat}`);
  if (head.i16(52) !== 0) fail(`unsupported glyphDataFormat ${head.i16(52)}`);

  const maxp = table('maxp');
  if (maxp.u32(0) !== 0x00010000) fail(`maxp version 0x${hex(maxp.u32(0), 8)} is not TrueType 1.0`);
  maxp.bytes(0, 32);
  const numGlyphs = maxp.u16(4);
  if (numGlyphs === 0) fail('font has no glyphs');

  const hhea = table('hhea');
  const numberOfHMetrics = hhea.u16(34);
  if (numberOfHMetrics === 0 || numberOfHMetrics > numGlyphs) {
    fail(`numberOfHMetrics ${numberOfHMetrics} is outside 1..${numGlyphs}`);
  }
  const hmtx = table('hmtx');
  hmtx.bytes(0, numberOfHMetrics * 4 + (numGlyphs - numberOfHMetrics) * 2);

  const os2 = table('OS/2');
  // Restricted-license (0x0002), no-subsetting (0x0100) and bitmap-only
  // (0x0200) embedding all forbid shipping a rebuilt outline font.
  const fsType = os2.u16(8);
  if (fsType & 0x0302) fail(`OS/2 fsType 0x${hex(fsType)} does not permit subsetting`);

  const post = table('post');
  post.bytes(0, 32);

  const loca = table('loca');
  const glyf = table('glyf');
  const offsets = new Array(numGlyphs + 1);
  for (let g = 0; g <= numGlyphs; g++) {
    offsets[g] = indexToLocFormat === 0 ? loca.u16(g * 2) * 2 : loca.u32(g * 4);
    if (g > 0 && offsets[g] < offsets[g - 1]) fail(`loca is not monotonic at glyph ${g}`);
  }
  if (offsets[numGlyphs] > glyf.length) fail(`loca ends at ${offsets[numGlyphs]}, past the ${glyf.length}-byte glyf table`);

  const checkGlyph = (glyph) => {
    if (!Number.isInteger(glyph) || glyph < 0 || glyph >= numGlyphs) fail(`glyph ${glyph} is outside 0..${numGlyphs - 1}`);
  };
  return {
    tables,
    table,
    numGlyphs,
    indexToLocFormat,
    cmap: parseCmap(table('cmap'), numGlyphs),
    glyph(glyph) {
      checkGlyph(glyph);
      const data = glyf.bytes(offsets[glyph], offsets[glyph + 1] - offsets[glyph]);
      if (data.length > 0 && data.length < 10) fail(`glyph ${glyph} is shorter than its 10-byte header`);
      return data;
    },
    metrics(glyph) {
      checkGlyph(glyph);
      const last = numberOfHMetrics - 1;
      const advance = hmtx.u16(Math.min(glyph, last) * 4);
      const lsb = glyph <= last ? hmtx.i16(glyph * 4 + 2) : hmtx.i16(numberOfHMetrics * 4 + (glyph - numberOfHMetrics) * 2);
      return { advance, lsb };
    }
  };
}

/** Byte offsets of each component's glyphIndex in a composite glyph. */
function compositeComponents(data, glyph) {
  const r = reader(data, 0, data.length, `composite glyph ${glyph}`);
  const components = [];
  let at = 10;
  let flags;
  let instructions = false;
  do {
    flags = r.u16(at);
    components.push({ at: at + 2, glyph: r.u16(at + 2) });
    at += 4 + (flags & 0x0001 ? 4 : 2);
    if (flags & 0x0008) at += 2;
    else if (flags & 0x0040) at += 4;
    else if (flags & 0x0080) at += 8;
    if (flags & 0x0100) instructions = true;
  } while (flags & 0x0020);
  if (instructions) r.bytes(at + 2, r.u16(at));
  else r.bytes(0, at);
  return components;
}

/**
 * GSUB is dropped because the UI renders each icon as a single `:before`
 * code point. That is only behavior-preserving if every lookup needs a
 * multi-glyph input, so anything other than ligatures of two or more
 * components (single, contextual, extension, ...) is refused.
 */
function assertGsubInert(r) {
  if (r.u16(0) !== 1) fail(`unsupported GSUB major version ${r.u16(0)}`);
  const lookupList = r.u16(8);
  if (lookupList === 0) return;
  const lookupCount = r.u16(lookupList);
  // Offsets may alias; walking each structure once keeps the work linear.
  const seen = new Set();
  for (let l = 0; l < lookupCount; l++) {
    const lookup = lookupList + r.u16(lookupList + 2 + l * 2);
    const type = r.u16(lookup);
    if (type !== 4) fail(`GSUB lookup ${l} has type ${type}; only ligature lookups can be dropped safely`);
    const subtables = r.u16(lookup + 4);
    for (let s = 0; s < subtables; s++) {
      const subtable = lookup + r.u16(lookup + 6 + s * 2);
      if (seen.has(subtable)) continue;
      seen.add(subtable);
      if (r.u16(subtable) !== 1) fail(`GSUB ligature subtable format ${r.u16(subtable)}`);
      const sets = r.u16(subtable + 4);
      for (let i = 0; i < sets; i++) {
        const set = subtable + r.u16(subtable + 6 + i * 2);
        if (seen.has(set)) continue;
        seen.add(set);
        const ligatures = r.u16(set);
        for (let k = 0; k < ligatures; k++) {
          const ligature = set + r.u16(set + 2 + k * 2);
          if (r.u16(ligature + 2) < 2) fail('GSUB has a single-component ligature');
        }
      }
    }
  }
}

function checksum(data) {
  let sum = 0;
  for (let at = 0; at < data.length; at += 4) {
    const word = ((data[at] << 24) | ((data[at + 1] ?? 0) << 16) | ((data[at + 2] ?? 0) << 8) | (data[at + 3] ?? 0)) >>> 0;
    sum = (sum + word) >>> 0;
  }
  return sum;
}

const pad4 = (length) => (length + 3) & ~3;

/** Short loca stores offset/2 in a uint16, so it covers glyf up to 0x1FFFE bytes. */
export function chooseLocaFormat(glyfLength) {
  if (glyfLength % 2 !== 0) fail('glyf length must be even');
  return glyfLength <= 0x1fffe ? 0 : 1;
}

/**
 * Write an sfnt from tag -> table bytes: directory sorted by tag, every table
 * 4-byte aligned and zero padded, per-table checksums, and
 * head.checkSumAdjustment computed with itself zeroed.
 */
export function assembleSfnt(tableMap) {
  const tags = [...tableMap.keys()].sort();
  const numTables = tags.length;
  const entrySelector = Math.floor(Math.log2(numTables));
  const searchRange = 16 * 2 ** entrySelector;
  let offset = 12 + 16 * numTables;
  const placed = tags.map((tag) => {
    const data = tableMap.get(tag);
    const entry = { tag, data, offset };
    offset += pad4(data.length);
    return entry;
  });
  const out = Buffer.alloc(offset);
  out.writeUInt32BE(SFNT_TRUETYPE, 0);
  out.writeUInt16BE(numTables, 4);
  out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(entrySelector, 8);
  out.writeUInt16BE(numTables * 16 - searchRange, 10);
  placed.forEach(({ tag, data, offset: at }, i) => {
    if (tag.length !== 4) fail(`invalid table tag ${JSON.stringify(tag)}`);
    out.set(data, at);
    if (tag === 'head') out.writeUInt32BE(0, at + 8);
    const record = 12 + i * 16;
    out.write(tag, record, 'latin1');
    out.writeUInt32BE(checksum(out.subarray(at, at + pad4(data.length))), record + 4);
    out.writeUInt32BE(at, record + 8);
    out.writeUInt32BE(data.length, record + 12);
  });
  const head = placed.find((entry) => entry.tag === 'head');
  if (head) out.writeUInt32BE((CHECKSUM_MAGIC - checksum(out)) >>> 0, head.offset + 8);
  return out;
}

/** cmap with one format 4 subtable shared by (0,3) and (3,1). */
function buildCmap(pairs) {
  const segments = [];
  for (const [cp, glyph] of pairs) {
    const last = segments.at(-1);
    if (last && cp === last.end + 1 && glyph - cp === last.glyph - last.start) last.end = cp;
    else segments.push({ start: cp, end: cp, glyph });
  }
  segments.push({ start: 0xffff, end: 0xffff, glyph: 0 });
  const segCount = segments.length;
  const entrySelector = Math.floor(Math.log2(segCount));
  const searchRange = 2 * 2 ** entrySelector;
  const length = 16 + segCount * 8;
  const table = Buffer.alloc(20 + length);
  table.writeUInt16BE(0, 0);
  table.writeUInt16BE(2, 2);
  table.writeUInt16BE(0, 4);
  table.writeUInt16BE(3, 6);
  table.writeUInt32BE(20, 8);
  table.writeUInt16BE(3, 12);
  table.writeUInt16BE(1, 14);
  table.writeUInt32BE(20, 16);
  const f4 = table.subarray(20);
  f4.writeUInt16BE(4, 0);
  f4.writeUInt16BE(length, 2);
  f4.writeUInt16BE(0, 4);
  f4.writeUInt16BE(segCount * 2, 6);
  f4.writeUInt16BE(searchRange, 8);
  f4.writeUInt16BE(entrySelector, 10);
  f4.writeUInt16BE(segCount * 2 - searchRange, 12);
  segments.forEach((segment, s) => {
    f4.writeUInt16BE(segment.end, 14 + s * 2);
    f4.writeUInt16BE(segment.start, 16 + segCount * 2 + s * 2);
    // The terminator maps U+FFFF to glyph 0: (0xFFFF + 1) & 0xFFFF.
    f4.writeUInt16BE(segment.start === 0xffff ? 1 : (segment.glyph - segment.start) & 0xffff, 16 + segCount * 4 + s * 2);
    // idRangeOffset stays 0.
  });
  return table;
}

/**
 * Subset `fontBytes` to glyph 0 plus the glyphs (and composite components)
 * of `codePoints`. New glyph IDs follow the original glyph order. Vertical
 * metrics, head bounds and the maxp maxima are copied unchanged: they remain
 * valid upper bounds, and unchanged ascent/descent keeps the icon baseline
 * where the full font put it.
 */
export function subsetTrueTypeFont(fontBytes, codePoints) {
  const font = parseTrueType(fontBytes);
  if (font.tables.has('GSUB')) assertGsubInert(font.table('GSUB'));

  const wanted = [...new Set(codePoints)].sort((a, b) => a - b);
  if (wanted.length === 0) fail('no code points requested');
  // Depth-first closure over composite components; 'visiting' marks the
  // current path so a component cycle throws instead of recursing forever.
  const state = new Map();
  const visit = (glyph, depth) => {
    if (state.get(glyph) === 'done') return;
    if (state.get(glyph) === 'visiting') fail(`composite glyph cycle through glyph ${glyph}`);
    if (depth > MAX_COMPONENT_DEPTH) fail(`composite nesting exceeds ${MAX_COMPONENT_DEPTH} levels at glyph ${glyph}`);
    state.set(glyph, 'visiting');
    const data = font.glyph(glyph);
    if (data.length > 0 && reader(data, 0, data.length, `glyph ${glyph}`).i16(0) < 0) {
      for (const component of compositeComponents(data, glyph)) visit(component.glyph, depth + 1);
    }
    state.set(glyph, 'done');
  };
  visit(0, 0);
  for (const cp of wanted) {
    // U+FFFF is format 4's terminator, so the subset cmap carries U+0000..U+FFFE.
    if (!Number.isInteger(cp) || cp < 0 || cp >= 0xffff) fail(`code point ${cp} is outside U+0000..U+FFFE`);
    const glyph = font.cmap.get(cp);
    if (!glyph) fail(`U+${hex(cp)} has no glyph in the font`);
    visit(glyph, 0);
  }
  const order = [...state.keys()].sort((a, b) => a - b);
  const newId = new Map(order.map((glyph, index) => [glyph, index]));

  const glyphs = order.map((glyph) => {
    const data = Buffer.from(font.glyph(glyph));
    if (data.length > 0 && data.readInt16BE(0) < 0) {
      for (const component of compositeComponents(data, glyph)) {
        data.writeUInt16BE(newId.get(component.glyph), component.at);
      }
    }
    return Buffer.concat([data, Buffer.alloc(pad4(data.length) - data.length)]);
  });
  const glyf = Buffer.concat(glyphs);
  const locaFormat = chooseLocaFormat(glyf.length);
  const loca = Buffer.alloc((order.length + 1) * (locaFormat === 0 ? 2 : 4));
  let position = 0;
  for (let i = 0; i <= order.length; i++) {
    if (locaFormat === 0) loca.writeUInt16BE(position / 2, i * 2);
    else loca.writeUInt32BE(position, i * 4);
    if (i < order.length) position += glyphs[i].length;
  }

  const hmtx = Buffer.alloc(order.length * 4);
  order.forEach((glyph, i) => {
    const { advance, lsb } = font.metrics(glyph);
    hmtx.writeUInt16BE(advance, i * 4);
    hmtx.writeInt16BE(lsb, i * 4 + 2);
  });

  const copy = (tag) => Buffer.from(font.table(tag).bytes(0, font.tables.get(tag).length));
  const head = copy('head');
  head.writeInt16BE(locaFormat, 50);
  const hhea = copy('hhea');
  hhea.writeUInt16BE(order.length, 34);
  const maxp = copy('maxp');
  maxp.writeUInt16BE(order.length, 4);
  // post format 3 keeps the 32-byte header and drops the glyph names.
  const post = Buffer.from(font.table('post').bytes(0, 32));
  post.writeUInt32BE(0x00030000, 0);
  const os2 = copy('OS/2');
  // usFirstCharIndex/usLastCharIndex describe the rebuilt cmap.
  if (os2.length >= 68) {
    os2.writeUInt16BE(wanted[0], 64);
    os2.writeUInt16BE(wanted.at(-1), 66);
  }
  // usMaxContext describes GSUB/GPOS contexts; none remain.
  if (os2.readUInt16BE(0) >= 2 && os2.length >= 96) os2.writeUInt16BE(0, 94);

  return assembleSfnt(new Map([
    ['OS/2', os2],
    ['cmap', buildCmap(wanted.map((cp) => [cp, newId.get(font.cmap.get(cp))]))],
    ['glyf', glyf],
    ['head', head],
    ['hhea', hhea],
    ['hmtx', hmtx],
    ['loca', loca],
    ['maxp', maxp],
    ['name', copy('name')],
    ['post', post]
  ]));
}

const CLASS_NAME = /^codicon-[a-z0-9]+(?:-[a-z0-9]+)*/;
const CLASS_TOKENS = /codicon-[a-z0-9]+(?:-[a-z0-9]+)*/g;
const ICON_SELECTOR = /^\.(codicon-[a-z0-9]+(?:-[a-z0-9]+)*)::?before$/;
const ICON_BODY = /^\s*content:\s*"\\([0-9a-fA-F]{4,6})"\s*;?\s*$/;
const BASE_SELECTOR = ".codicon[class*='codicon-']";
const FONT_URL = /url\("\.\/codicon\.ttf\?[0-9a-f]+"\)/;

/**
 * Authored webview and host sources, as `{ file, text }` with root-relative
 * POSIX paths. The generated core/ui/viewer.html is excluded: it derives from
 * these files and the build writes it concurrently.
 */
export function readCodiconSources(root) {
  const sources = [];
  const walk = (relative) => {
    const entries = readdirSync(path.join(root, relative), { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:js|mjs|ts|css|html)$/.test(entry.name) && file !== 'core/ui/viewer.html') {
        sources.push({ file, text: readFileSync(path.join(root, file), 'utf8') });
      }
    }
  };
  walk('core/ui');
  walk('src');
  return sources;
}

/**
 * Every `codicon-*` class named in `sources`. A `codicon-` that is not a
 * complete literal name (`'codicon-' + name`, `codicon-${name}`) throws: the
 * subset could not know which glyph that string selects at run time.
 */
export function collectCodiconClasses(sources) {
  const classes = new Set();
  for (const { file, text } of sources) {
    for (const match of text.matchAll(/codicon-/g)) {
      const name = CLASS_NAME.exec(text.slice(match.index, match.index + 128))?.[0];
      const next = name ? text[match.index + name.length] : undefined;
      if (!name || (next !== undefined && /[-\w$]/.test(next))) {
        const line = text.slice(0, match.index).split('\n').length;
        fail(`${file}:${line}: "codicon-" does not start a complete literal class name; write icon classes as whole literals so the subset keeps their glyphs`);
      }
      classes.add(name);
    }
  }
  return [...classes].sort();
}

/** Top-level comments and blocks of codicon.css, with nested braces balanced. */
function splitCss(css) {
  const blocks = [];
  let at = 0;
  for (;;) {
    while (at < css.length && /\s/.test(css[at])) at++;
    if (at >= css.length) return blocks;
    if (css.startsWith('/*', at)) {
      const end = css.indexOf('*/', at + 2);
      if (end < 0) fail('codicon.css has an unterminated comment');
      blocks.push({ comment: true, text: css.slice(at, end + 2) });
      at = end + 2;
      continue;
    }
    const open = css.indexOf('{', at);
    if (open < 0) fail(`codicon.css has trailing text at offset ${at}`);
    const prelude = css.slice(at, open).trim();
    if (/[;{}]|\/\*/.test(prelude)) fail(`codicon.css has an unexpected statement before offset ${open}`);
    let depth = 1;
    let end = open + 1;
    for (; depth > 0; end++) {
      if (end >= css.length) fail(`codicon.css block ${JSON.stringify(prelude)} is unterminated`);
      const char = css[end];
      if (css.startsWith('/*', end)) {
        const close = css.indexOf('*/', end + 2);
        if (close < 0) fail('codicon.css has an unterminated comment');
        end = close + 1;
      } else if (char === '"' || char === "'") {
        let close = end + 1;
        while (css[close] !== char) {
          if (close >= css.length) fail('codicon.css has an unterminated string');
          close += css[close] === '\\' ? 2 : 1;
        }
        end = close;
      } else if (char === '{') {
        depth++;
      } else if (char === '}') {
        depth--;
      }
    }
    blocks.push({ prelude, body: css.slice(open + 1, end - 1), text: css.slice(at, end) });
    at = end;
  }
}

/**
 * Keep codicon.css's license header, @font-face, base rule, the modifier
 * rules whose classes the UI uses (plus keyframes they animate with) and the
 * icon rules of `usedClasses`, in their original order. Throws when a used
 * class has no rule. `render(fontToken)` writes the CSS once the font's
 * cache-busting token is known.
 */
export function planCodiconCss(css, usedClasses, sourceLabel) {
  const blocks = splitCss(css);
  if (!blocks[0]?.comment) fail('codicon.css no longer starts with its license header');
  const used = new Set(usedClasses);
  const icons = new Map();
  const ruleClasses = new Set();
  const kept = [];
  let fontFaces = 0;
  let baseRules = 0;
  for (const block of blocks.slice(1)) {
    if (block.comment) continue;
    const { prelude } = block;
    if (prelude === '@font-face') {
      fontFaces++;
      if ((block.body.match(/url\(/g) ?? []).length !== 1 || !FONT_URL.test(block.body)) {
        fail('@font-face no longer loads exactly one ./codicon.ttf');
      }
      kept.push(block);
    } else if (/^@keyframes\s+[\w-]+$/.test(prelude)) {
      kept.push({ ...block, name: prelude.split(/\s+/)[1] });
    } else if (prelude.startsWith('@')) {
      fail(`codicon.css has an unexpected ${prelude} rule`);
    } else if (/:(?::?before|:?after)\b/.test(prelude)) {
      const selector = ICON_SELECTOR.exec(prelude);
      const content = ICON_BODY.exec(block.body);
      if (!selector || !content) fail(`unexpected icon rule ${JSON.stringify(block.text)}`);
      const cp = Number.parseInt(content[1], 16);
      if (icons.has(selector[1]) && icons.get(selector[1]) !== cp) fail(`.${selector[1]} maps to two code points`);
      icons.set(selector[1], cp);
      if (used.has(selector[1])) kept.push(block);
    } else {
      if (prelude === BASE_SELECTOR) baseRules++;
      const items = prelude.split(',').map((item) => [...item.matchAll(CLASS_TOKENS)].map((token) => token[0]));
      for (const token of items.flat()) ruleClasses.add(token);
      if (items.some((tokens) => tokens.every((token) => used.has(token)))) kept.push(block);
    }
  }
  if (fontFaces !== 1) fail(`expected one @font-face, found ${fontFaces}`);
  if (baseRules !== 1) fail(`expected one ${BASE_SELECTOR} rule, found ${baseRules}`);
  const missing = [...used].filter((name) => !icons.has(name) && !ruleClasses.has(name)).sort();
  if (missing.length > 0) {
    fail(`the UI references ${missing.map((name) => `.${name}`).join(', ')} but codicon.css has no rule for ${missing.length === 1 ? 'it' : 'them'}`);
  }
  const animated = kept.filter((block) => !block.name).map((block) => block.body).join('\n');
  const output = kept.filter((block) => !block.name || new RegExp(`\\b${block.name}\\b`).test(animated));
  const codePoints = [...new Set([...used].filter((name) => icons.has(name)).map((name) => icons.get(name)))]
    .sort((a, b) => a - b);
  const iconClasses = [...used].filter((name) => icons.has(name)).length;
  return {
    codePoints,
    render(fontToken) {
      if (!/^[0-9a-f]+$/.test(fontToken)) fail(`invalid font token ${JSON.stringify(fontToken)}`);
      const note = `/* Generated by scripts/build.mjs from ${sourceLabel}: only the ${iconClasses} icon classes the webview references.\n * codicon.ttf is subset to their glyphs (font license: CC BY 4.0). */`;
      const texts = output.map((block) => (block.prelude === '@font-face'
        ? block.text.replace(FONT_URL, `url("./codicon.ttf?${fontToken}")`)
        : block.text));
      return `${[blocks[0].text, note, ...texts].join('\n\n')}\n`;
    }
  };
}

/**
 * Subset codicon.css and codicon.ttf to `usedClasses`. The font's query token
 * is a hash of the subset bytes, so it changes exactly when the font does.
 */
export function buildCodiconSubset({ css, font, usedClasses, sourceLabel }) {
  const plan = planCodiconCss(css, usedClasses, sourceLabel);
  const subsetFont = subsetTrueTypeFont(font, plan.codePoints);
  const fontToken = createHash('sha256').update(subsetFont).digest('hex').slice(0, 32);
  return { css: plan.render(fontToken), font: subsetFont, codePoints: plan.codePoints };
}
