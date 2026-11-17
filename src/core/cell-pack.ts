import { escapeIdentifier } from './sql-utils';
import {
  HELPER_METADATA_CHUNK_COLUMNS,
  MAX_UTF8_BYTES_PER_CODE_POINT,
  type CellContainmentQuery
} from './cell-containment';
import type { CellValue, ExactIntegerTextMap } from './types';

/**
 * Row-packed transport for 'checked' grid pages (spike). One
 * sqlite_explorer_cell_pack() call per 100 value columns returns a BLOB with
 * everything the four grid cell helpers return for those values; see the
 * format comment above cell_pack in src/runtime/query-plan.c. The decoder
 * rebuilds the exact transport row of the 'checked' containment query, so
 * every later stage runs unchanged.
 */

export const CELL_PACK_FUNCTION = 'sqlite_explorer_cell_pack';
const PACK_SOURCE_ALIAS = '__sqlite_explorer_cell_pack_source';
const PACK_VALUE_PREFIX = '__sqlite_explorer_cell_pack_value_';
const PACK_CHUNK_PREFIX = '__sqlite_explorer_cell_pack_';
const PACK_VERSION = 1;
const PACK_HEADER_BYTES = 6;
const MAX_SQLITE_BYTES = 0x7fffffff;

/** Whether a containment query's transport row can be rebuilt from packed rows. */
export function cellPackApplies(query: CellContainmentQuery): boolean {
  return query.rawTextTransport === 'checked'
    && query.metadataMayBeNull
    && !query.metadataTrailer;
}

/**
 * One pack call per chunk of at most 100 value expressions. A direct select
 * leaves the calls unaliased: its ORDER BY and WHERE names could bind to an
 * alias instead of the table column they name.
 */
export function buildCellPackSelectList(
  valueExpressions: readonly string[],
  query: Pick<CellContainmentQuery, 'effectiveInlineCellBytes' | 'valueColumnCount'>,
  aliased = false
): string {
  if (valueExpressions.length !== query.valueColumnCount || valueExpressions.length < 1) {
    throw new Error('Cell packing requires one expression per value column');
  }
  const characters = Math.floor(query.effectiveInlineCellBytes / MAX_UTF8_BYTES_PER_CODE_POINT);
  const calls: string[] = [];
  for (let offset = 0; offset < valueExpressions.length; offset += HELPER_METADATA_CHUNK_COLUMNS) {
    const chunk = valueExpressions.slice(offset, offset + HELPER_METADATA_CHUNK_COLUMNS);
    // An unaliased call is named by its whole text, about 4,000 characters
    // for 100 values. The native binding builds each row as an object keyed
    // by column name and hashes that name again for every row.
    calls.push(
      `${CELL_PACK_FUNCTION}(${query.effectiveInlineCellBytes}, ${characters}, ${chunk.join(', ')})` +
      (aliased ? ` AS ${escapeIdentifier(`${PACK_CHUNK_PREFIX}${calls.length}`)}` : '')
    );
  }
  return calls.join(', ');
}

/**
 * The packed statement over the containment query's own source, as one
 * co-routine. Correct for every source the containment query accepts.
 */
export function buildCellPackWrappedQuery(
  sourceSql: string,
  query: CellContainmentQuery,
  sourceEndsWithOffset: boolean
): string {
  if (sourceEndsWithOffset && !/ OFFSET \d+$/.test(sourceSql)) {
    throw new Error('Cell pack source does not end with an OFFSET clause');
  }
  const names = Array.from({ length: query.valueColumnCount }, (_, index) => (
    escapeIdentifier(`${PACK_VALUE_PREFIX}${index}`)
  ));
  const source = escapeIdentifier(PACK_SOURCE_ALIAS);
  return `WITH ${source} (${names.join(', ')}) AS (\n` +
    (sourceEndsWithOffset ? `${sourceSql}\n)\n` : `SELECT * FROM (\n${sourceSql}\n) LIMIT -1 OFFSET 0\n)\n`) +
    // Nothing after the select list names a column here, so aliases are safe.
    `SELECT ${buildCellPackSelectList(names, query, true)} FROM ${source}`;
}

// sql.js getString(): Emscripten's UTF8ToString over the stored byte length
// is a default TextDecoder, which keeps NUL, replaces malformed bytes with
// U+FFFD and drops a leading BOM. Values must match it, lossy or not.
// txiki's binding decodes differently (it keeps a leading BOM, emits one
// U+FFFD per byte of a truncated sequence and lone surrogates for encoded
// ones), so a native caller re-reads a page that has any such value.
const valueDecoder = new TextDecoder();
// The text area holds only bytes the runtime found plain; a fatal decoder
// fails the page instead of trusting a wrong verdict.
const plainDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

type TransportValue = CellValue | bigint;

function malformed(rowIndex: number, chunk: number, detail: string): Error {
  return new Error(`Packed cell row ${rowIndex}, chunk ${chunk} is malformed: ${detail}`);
}

function checkRealText(source: Uint8Array, start: number, end: number, rowIndex: number, chunk: number): void {
  for (let index = start; index < end; index++) {
    const code = source[index];
    // SQLite's REAL text is printable ASCII: digits, sign, '.', 'e', "Inf".
    if (code < 0x21 || code > 0x7e) throw malformed(rowIndex, chunk, 'REAL text is not ASCII');
  }
}

// Literals: every power up to 1e22 is an exact double.
const EXACT_POWERS_OF_TEN = [
  1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11,
  1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22
];

/**
 * Whether the bytes [start, end) are String(value), decided without
 * formatting value: 1 if they are, 0 if they are not, -1 when the bytes
 * alone cannot tell (the caller then compares with String(value)).
 *
 * Only a plain decimal "-?(0|[1-9][0-9]*)\.[0-9]*[1-9]" with at most 15
 * significant digits is decided. Its digits as an integer M are below
 * 2^53 and 10^f is exact for f <= 22, so M / 10^f is Number(text),
 * correctly rounded. If that is not value, the text is not
 * String(value), which always reads back as value: 0.
 * If it is value and the text has at most five zeros after "0.", value is
 * at least 1e-6, a normal double. A normal double's rounding interval is
 * narrower than the gap between any two decimals of at most 15
 * significant digits, so this text is the only such decimal that reads
 * back as value. String(value) uses the fewest digits that read back,
 * so it has these digits and this decimal point, and for a non-integer
 * from 1e-6 to below 1e21 it writes them in this same plain form: 1.
 */
export function realTextIsOwn(source: Uint8Array, start: number, end: number, value: number): number {
  // An integral REAL's "N.0" goes to the caller's '.0' check.
  if (start >= end || source[end - 1] === 0x30) return -1;
  let index = start;
  const negative = source[index] === 0x2d;
  if (negative) index++;
  let mantissa = 0;
  let digits = 0;
  const integerStart = index;
  while (index < end && source[index] >= 0x30 && source[index] <= 0x39) {
    mantissa = mantissa * 10 + (source[index] - 0x30);
    if (mantissa > 0) digits++;
    index++;
  }
  const integerDigits = index - integerStart;
  if (integerDigits === 0 || index === end || source[index] !== 0x2e) return -1;
  index++;
  const fractionStart = index;
  while (index < end && source[index] >= 0x30 && source[index] <= 0x39) {
    mantissa = mantissa * 10 + (source[index] - 0x30);
    if (mantissa > 0) digits++;
    index++;
  }
  const fractionDigits = index - fractionStart;
  if (index !== end || fractionDigits === 0 || digits > 15 || fractionDigits > 22) return -1;
  const parsed = mantissa / EXACT_POWERS_OF_TEN[fractionDigits];
  if ((negative ? -parsed : parsed) !== value) return 0;
  if (integerDigits > 1 && source[integerStart] === 0x30) return -1;
  // Below 1, digits after "0." beyond the fraction's significant ones are zeros.
  if (integerDigits === 1 && source[integerStart] === 0x30 && fractionDigits - digits > 5) return -1;
  return 1;
}

// Plain cells of at least this many bytes are decoded on their own. A slice
// of a shared decoded area is a SlicedString, and every later per-character
// pass over it (utf8ByteLength, wire estimates) pays the indirection; for
// short cells one decode call per cell costs more than that.
const SEPARATE_DECODE_BYTES = 256;
// Raw non-plain TEXT bytes are pooled like decodeRawTextColumns' slabs, so a
// page never holds one backing store per cell.
const RAW_SLAB_BYTES = 64 * 1024;

/**
 * Rebuilds 'checked' containment transport rows from packed chunks: values,
 * the metadata token string or NULL, then raw-TEXT slots for
 * rawTextColumnIndices. INTEGERs are BigInt, as sql.js returns them with
 * useBigInt. When the query carries REAL text, the SQLite text of each REAL
 * that differs from String(value) goes to exactTexts instead of a packed
 * REAL text column: what normalizeIntegerRowsForTransport keeps of those.
 *
 * decodeRow reads each chunk at [start, start + length) of one byte source.
 * The source may be a view of the WASM heap that is only valid until the next
 * step: nothing returned aliases it. Strings are decoded, BLOB values are
 * copied as sql.js getBlob() copies them, and raw TEXT bytes go to slabs.
 */
export class CellPackDecoder {
  readonly chunkCount: number;
  private readonly valueCount: number;
  private readonly limit: number;
  private readonly keepRealTexts: boolean;
  private readonly rawSlotOfColumn: Int32Array;
  private readonly rawStart: number;
  private readonly width: number;
  // Column, UTF-16 length, byte length and area offset of each plain cell in a chunk.
  private readonly areaColumns = new Int32Array(HELPER_METADATA_CHUNK_COLUMNS);
  private readonly areaUnits = new Int32Array(HELPER_METADATA_CHUNK_COLUMNS);
  private readonly areaLengths = new Int32Array(HELPER_METADATA_CHUNK_COLUMNS);
  private slab: Uint8Array | undefined;
  private slabOffset = 0;
  /** TEXT values decoded lossily or from non-plain bytes, in sql.js's way. */
  nonPlainTextValues = 0;
  /** Row index -> value column -> SQLite text, for each REAL whose text differs from String(value). */
  exactTexts: ExactIntegerTextMap | undefined;

  constructor(query: CellContainmentQuery) {
    if (!cellPackApplies(query)) {
      throw new Error('Cell packing requires checked transport without a metadata trailer');
    }
    this.valueCount = query.valueColumnCount;
    this.limit = query.effectiveInlineCellBytes;
    if (!Number.isSafeInteger(this.limit) || this.limit < 0 || this.limit > MAX_SQLITE_BYTES) {
      throw new Error(`Invalid cell window ${this.limit}`);
    }
    this.chunkCount = Math.ceil(this.valueCount / HELPER_METADATA_CHUNK_COLUMNS);
    const realChunkCount = query.numericTransport.packedRealTextColumnCount ?? 0;
    if (realChunkCount !== 0 && realChunkCount !== this.chunkCount) {
      throw new Error('Packed REAL text columns do not match the value chunks');
    }
    // Without the sidecar the page has no REAL text, as on the helper path.
    this.keepRealTexts = realChunkCount > 0;
    if (query.rawTextColumnStart !== this.valueCount + 1) {
      throw new Error('Raw TEXT slots must follow the metadata column');
    }
    this.rawSlotOfColumn = new Int32Array(this.valueCount).fill(-1);
    query.rawTextColumnIndices.forEach((columnIndex, slot) => { this.rawSlotOfColumn[columnIndex] = slot; });
    this.rawStart = query.rawTextColumnStart;
    this.width = this.rawStart + query.rawTextColumnCount;
  }

  private keepRawBytes(source: Uint8Array, start: number, length: number): Uint8Array {
    if (length > RAW_SLAB_BYTES) return source.slice(start, start + length);
    if (!this.slab || RAW_SLAB_BYTES - this.slabOffset < length) {
      this.slab = new Uint8Array(RAW_SLAB_BYTES);
      this.slabOffset = 0;
    }
    const kept = this.slab.subarray(this.slabOffset, this.slabOffset + length);
    kept.set(source.subarray(start, start + length));
    this.slabOffset += length;
    return kept;
  }

  decodeRow(
    source: Uint8Array,
    view: DataView,
    starts: ArrayLike<number>,
    lengths: ArrayLike<number>,
    rowIndex: number
  ): TransportValue[] {
    const { valueCount, limit, keepRealTexts, rawSlotOfColumn, rawStart, width, areaColumns, areaUnits, areaLengths } = this;
    const out: TransportValue[] = new Array(width);
    for (let slot = rawStart; slot < width; slot++) out[slot] = null;
    let tokens: string[] | undefined;
    let realTexts: Record<number, string> | undefined;

    for (let chunk = 0; chunk < this.chunkCount; chunk++) {
      const begin = starts[chunk];
      const size = lengths[chunk];
      const end = begin + size;
      if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(size) || begin < 0 || size < 0 || end > source.length) {
        throw malformed(rowIndex, chunk, 'chunk outside its source');
      }
      const base = chunk * HELPER_METADATA_CHUNK_COLUMNS;
      const cellCount = Math.min(HELPER_METADATA_CHUNK_COLUMNS, valueCount - base);
      if (size < PACK_HEADER_BYTES || source[begin] !== PACK_VERSION || source[begin + 1] !== cellCount) {
        throw malformed(rowIndex, chunk, 'bad header');
      }
      const areaOffset = view.getUint32(begin + 2, true);
      if (areaOffset < PACK_HEADER_BYTES || areaOffset > size) throw malformed(rowIndex, chunk, 'bad text area offset');
      const areaStart = begin + areaOffset;
      let offset = begin + PACK_HEADER_BYTES;
      let areaCells = 0;
      let areaBytes = 0;

      // Hot loop: no closures, so offset stays in a register. Every length
      // is checked against the descriptor end before it is used.
      for (let cell = 0; cell < cellCount; cell++) {
        const column = base + cell;
        if (offset >= areaStart) throw malformed(rowIndex, chunk, 'missing cell');
        const tag = source[offset++];
        // Fixed descriptor bytes after the tag, before any inline bytes.
        const fixed = tag === 1 || tag === 3 || tag === 6 || tag === 8 ? 8
          : tag === 2 ? 9 : tag === 4 || tag === 7 ? 4 : tag === 5 ? 12 : 0;
        if (tag > 8) throw malformed(rowIndex, chunk, `unknown tag ${tag}`);
        if (fixed > areaStart - offset) throw malformed(rowIndex, chunk, 'truncated descriptor');
        if (tag === 3 || tag === 5) {
          let stored = 0;
          if (tag === 5) {
            stored = view.getUint32(offset, true);
            offset += 4;
          }
          const units = view.getUint32(offset, true);
          const bytes = view.getUint32(offset + 4, true);
          offset += 8;
          if (tag === 3 ? bytes > limit : stored <= limit || stored > MAX_SQLITE_BYTES || bytes > stored) {
            // A clipped preview can pass the window: one malformed
            // "character" absorbs every continuation byte after it.
            throw malformed(rowIndex, chunk, 'bad TEXT lengths');
          }
          // Plain UTF-8 needs one to three bytes per UTF-16 unit.
          if (units > bytes || bytes > units * 3) throw malformed(rowIndex, chunk, 'impossible UTF-16 length');
          areaColumns[areaCells] = column;
          areaUnits[areaCells] = units;
          areaLengths[areaCells] = bytes;
          areaCells++;
          areaBytes += bytes;
          if (tag === 5) {
            (tokens ??= new Array<string>(valueCount).fill(''))[column] = `t${stored}`;
            if (rawSlotOfColumn[column] >= 0) out[rawStart + rawSlotOfColumn[column]] = 0n;
          }
        } else if (tag === 1) {
          out[column] = view.getBigInt64(offset, true);
          offset += 8;
        } else if (tag === 0) {
          out[column] = null;
        } else if (tag === 2) {
          const value = view.getFloat64(offset, true);
          out[column] = value;
          const length = source[offset + 8];
          offset += 9;
          if (length < 1 || length > areaStart - offset) throw malformed(rowIndex, chunk, 'bad REAL text length');
          if (keepRealTexts) {
            // Decide from the bytes alone where that is exact, else compare
            // with String(value) in place; build a string only for a text
            // that differs.
            const verdict = realTextIsOwn(source, offset, offset + length, value);
            let differs = verdict === 0;
            if (verdict < 0) {
              const own = String(value);
              const ownLength = own.length;
              let same = 0;
              while (same < ownLength && same < length && source[offset + same] === own.charCodeAt(same)) same++;
              if (same === ownLength && length === ownLength + 2
                && source[offset + same] === 0x2e && source[offset + same + 1] === 0x30) {
                // An integral value: SQLite adds '.0'.
                (realTexts ??= {})[column] = `${own}.0`;
              } else {
                differs = same !== ownLength || length !== ownLength;
              }
            }
            if (differs) {
              // Printable ASCII once checked, which UTF-8 decodes as itself.
              checkRealText(source, offset, offset + length, rowIndex, chunk);
              (realTexts ??= {})[column] = plainDecoder.decode(source.subarray(offset, offset + length));
            }
          } else {
            checkRealText(source, offset, offset + length, rowIndex, chunk);
          }
          offset += length;
        } else {
          // Tags 4, 6, 7 and 8 carry their bytes inline.
          let stored = 0;
          if (tag === 6 || tag === 8) {
            stored = view.getUint32(offset, true);
            offset += 4;
          }
          const length = view.getUint32(offset, true);
          offset += 4;
          if (tag === 4 || tag === 7
            ? length > limit
            : stored <= limit || stored > MAX_SQLITE_BYTES || (tag === 6 ? length > stored : length !== limit)) {
            throw malformed(rowIndex, chunk, 'bad inline lengths');
          }
          if (length > areaStart - offset) throw malformed(rowIndex, chunk, 'length past the end');
          const start = offset;
          offset += length;
          const slot = rawSlotOfColumn[column];
          if (tag === 4) {
            out[column] = valueDecoder.decode(source.subarray(start, start + length));
            this.nonPlainTextValues++;
            if (slot >= 0) out[rawStart + slot] = this.keepRawBytes(source, start, length);
          } else if (tag === 6) {
            out[column] = valueDecoder.decode(source.subarray(start, start + length));
            this.nonPlainTextValues++;
            (tokens ??= new Array<string>(valueCount).fill(''))[column] = `t${stored}`;
            if (slot >= 0) out[rawStart + slot] = 0n;
          } else {
            // A BLOB value leaves the engine in the page, so it owns its bytes.
            out[column] = source.slice(start, start + length);
            if (tag === 8) (tokens ??= new Array<string>(valueCount).fill(''))[column] = `b${stored}`;
          }
        }
      }
      if (offset !== areaStart) throw malformed(rowIndex, chunk, 'trailing descriptor bytes');
      if (areaBytes !== end - areaStart) throw malformed(rowIndex, chunk, 'text area size mismatch');
      // Decode runs of short cells with one call each and long cells alone.
      let index = 0;
      let position = areaStart;
      while (index < areaCells) {
        let last = index;
        let runBytes = areaLengths[index];
        let runUnits = areaUnits[index];
        if (areaLengths[index] < SEPARATE_DECODE_BYTES) {
          while (last + 1 < areaCells && areaLengths[last + 1] < SEPARATE_DECODE_BYTES) {
            last++;
            runBytes += areaLengths[last];
            runUnits += areaUnits[last];
          }
        }
        let text: string;
        try {
          text = plainDecoder.decode(source.subarray(position, position + runBytes));
        } catch {
          throw malformed(rowIndex, chunk, 'text area is not UTF-8');
        }
        if (text.length !== runUnits) throw malformed(rowIndex, chunk, 'text area UTF-16 length mismatch');
        // The runtime's plain rule, held here too: a lossy or BOM-stripped
        // engine string must never be marked as verified bytes.
        if (text.includes('\0') || text.includes('￾') || text.includes('￿')) {
          throw malformed(rowIndex, chunk, 'text area holds a character plain UTF-8 excludes');
        }
        if (index === last) {
          if (runUnits > 0 && text.charCodeAt(0) === 0xfeff) throw malformed(rowIndex, chunk, 'plain TEXT starts with a BOM');
          out[areaColumns[index]] = text;
        } else {
          let unit = 0;
          for (let cell = index; cell <= last; cell++) {
            const units = areaUnits[cell];
            if (units > 0 && text.charCodeAt(unit) === 0xfeff) {
              throw malformed(rowIndex, chunk, 'plain TEXT starts with a BOM');
            }
            out[areaColumns[cell]] = text.slice(unit, unit + units);
            unit += units;
            // A cell boundary inside a surrogate pair would leave two lone halves.
            const next = text.charCodeAt(unit);
            if (next >= 0xdc00 && next <= 0xdfff) throw malformed(rowIndex, chunk, 'cell boundary splits a character');
          }
        }
        position += runBytes;
        index = last + 1;
      }
    }
    out[valueCount] = tokens ? tokens.join('|') : null;
    if (realTexts) (this.exactTexts ??= {})[rowIndex] = realTexts;
    return out;
  }
}

/** decodeRow over rows of one owned BLOB per chunk, as sql.js get() returns them. */
export function decodeCellPackRows(
  packedRows: readonly (readonly unknown[])[],
  query: CellContainmentQuery,
  decoder = new CellPackDecoder(query)
): TransportValue[][] {
  const starts = new Array<number>(decoder.chunkCount).fill(0);
  const lengths = new Array<number>(decoder.chunkCount);
  return packedRows.map((row, rowIndex) => {
    if (row.length !== decoder.chunkCount) {
      throw new Error(`Packed cell row ${rowIndex} has ${row.length} columns; expected ${decoder.chunkCount}`);
    }
    if (decoder.chunkCount === 1) {
      const blob = row[0];
      if (!(blob instanceof Uint8Array)) throw malformed(rowIndex, 0, 'not a BLOB');
      lengths[0] = blob.byteLength;
      return decoder.decodeRow(blob, new DataView(blob.buffer, blob.byteOffset, blob.byteLength), starts, lengths, rowIndex);
    }
    // Several chunks: lay them end to end in one buffer.
    let total = 0;
    row.forEach((blob, chunk) => {
      if (!(blob instanceof Uint8Array)) throw malformed(rowIndex, chunk, 'not a BLOB');
      starts[chunk] = total;
      lengths[chunk] = blob.byteLength;
      total += blob.byteLength;
    });
    const joined = new Uint8Array(total);
    row.forEach((blob, chunk) => joined.set(blob as Uint8Array, starts[chunk]));
    return decoder.decodeRow(joined, new DataView(joined.buffer), starts, lengths, rowIndex);
  });
}
