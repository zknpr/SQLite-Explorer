import type { CellStorageClass, CellValue } from './types';
import { cellValueToSql } from './sql-utils';

export interface ExportEncodingCell {
  storageClass: CellStorageClass;
  value: CellValue;
}

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Browser-safe Base64 for bounded cells; large desktop cells stay streamed. */
export function encodeExportBytesAsBase64(bytes: Uint8Array): string {
  let encoded = '';
  let offset = 0;
  for (; offset + 2 < bytes.length; offset += 3) {
    const value = (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
    encoded +=
      BASE64_ALPHABET[(value >>> 18) & 63] +
      BASE64_ALPHABET[(value >>> 12) & 63] +
      BASE64_ALPHABET[(value >>> 6) & 63] +
      BASE64_ALPHABET[value & 63];
  }

  const remaining = bytes.length - offset;
  if (remaining === 1) {
    const value = bytes[offset] << 16;
    encoded +=
      BASE64_ALPHABET[(value >>> 18) & 63] +
      BASE64_ALPHABET[(value >>> 12) & 63] +
      '==';
  } else if (remaining === 2) {
    const value = (bytes[offset] << 16) | (bytes[offset + 1] << 8);
    encoded +=
      BASE64_ALPHABET[(value >>> 18) & 63] +
      BASE64_ALPHABET[(value >>> 12) & 63] +
      BASE64_ALPHABET[(value >>> 6) & 63] +
      '=';
  }
  return encoded;
}

function canonicalIntegerText(value: CellValue): string {
  const text = typeof value === 'bigint'
    ? value.toString()
    : typeof value === 'string'
      ? value
      : undefined;
  if (text === undefined) {
    throw new Error('SQLite returned invalid exact INTEGER text for export');
  }
  try {
    if (BigInt(text).toString() !== text) throw new Error();
  } catch {
    throw new Error('SQLite returned non-canonical INTEGER text for export');
  }
  return text;
}

function requireBlob(value: CellValue): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new Error('SQLite returned invalid BLOB data for export');
  }
  return value;
}

/** Encode one complete, bounded cell with the shared CSV policy. */
export function encodeCsvExportCell(cell: ExportEncodingCell): string {
  if (cell.storageClass === 'null') return '';
  if (cell.storageClass === 'blob') return '[BLOB]';
  if (cell.storageClass === 'integer') return canonicalIntegerText(cell.value);
  const text = String(cell.value);
  return text.includes(',') || text.includes('"') || text.includes('\n')
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

/** Return the complete JSON token for one bounded export cell. */
export function encodeJsonExportCell(cell: ExportEncodingCell): string {
  if (cell.storageClass === 'integer') return canonicalIntegerText(cell.value);
  if (cell.storageClass === 'blob') {
    return JSON.stringify(encodeExportBytesAsBase64(requireBlob(cell.value)));
  }
  return JSON.stringify(cell.value) ?? 'null';
}

/** Return the complete SQLite literal for one bounded export cell. */
export function encodeSqlExportCell(cell: ExportEncodingCell): string {
  return cell.storageClass === 'integer'
    ? canonicalIntegerText(cell.value)
    : cellValueToSql(cell.value);
}
