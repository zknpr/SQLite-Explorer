import type { CellTextEncoding } from './types';

/** Whole-value, fatal decoding that preserves a leading BOM as stored data. */
export function createCellTextDecoder(encoding: CellTextEncoding): { decode(bytes: Uint8Array): string } {
  if (encoding === 'utf-8') return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

  // The desktop's txiki runtime only implements UTF-8 TextDecoder. SQLite
  // still exposes UTF-16 database bytes, including identity/history values.
  // Validate surrogates explicitly: replacement characters would make two
  // different stored values appear to have the same editable identity.
  const littleEndian = encoding === 'utf-16le';
  return {
    decode(bytes) {
      if (bytes.length % 2 !== 0) throw new TypeError(`Invalid ${encoding}: odd byte length`);
      const unitAt = (offset: number) => littleEndian
        ? bytes[offset] | (bytes[offset + 1] << 8)
        : (bytes[offset] << 8) | bytes[offset + 1];
      const parts: string[] = [];
      let part = '';
      for (let offset = 0; offset < bytes.length; offset += 2) {
        const unit = unitAt(offset);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const low = offset + 2 < bytes.length ? unitAt(offset + 2) : -1;
          if (low < 0xdc00 || low > 0xdfff) throw new TypeError(`Invalid ${encoding}: unpaired surrogate`);
          part += String.fromCharCode(unit, low);
          offset += 2;
        } else {
          if (unit >= 0xdc00 && unit <= 0xdfff) throw new TypeError(`Invalid ${encoding}: unpaired surrogate`);
          part += String.fromCharCode(unit);
        }
        if (part.length >= 8192) {
          parts.push(part);
          part = '';
        }
      }
      parts.push(part);
      return parts.join('');
    }
  };
}
