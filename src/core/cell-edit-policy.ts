import { MAX_WEBVIEW_BINARY_VALUE_BYTES } from './webview-transport';
import type {
  CellValue,
  OversizedCellMetadata,
  OversizedCellStorageClass
} from './types';

export const CELL_EDIT_VALUE_TOO_LARGE_CODE = 'SQLITE_EXPLORER_CELL_EDIT_VALUE_TOO_LARGE';
export const OVERSIZED_CELL_REPLACEMENT_REQUIRED_CODE =
  'SQLITE_EXPLORER_OVERSIZED_CELL_REPLACEMENT_REQUIRED';
export const OVERSIZED_CELL_REPLACEMENT_CONFLICT_MESSAGE =
  'Oversized cell metadata changed before the confirmed replacement was applied';
export const MAX_OVERSIZED_CELL_REPLACEMENT_ATTEMPTS = 3;
export const OVERSIZED_CELL_REPLACEMENT_RETRY_EXHAUSTED_MESSAGE =
  'Oversized cell metadata changed repeatedly while replacing it. ' +
  'Reopen the cell and retry when concurrent writes have stopped.';
// Writes are bounded by the RPC transport, independently of the configurable
// inline preview limit. A preview setting must never shrink edit capability.
export const DEFAULT_MAX_CELL_EDIT_BYTES = MAX_WEBVIEW_BINARY_VALUE_BYTES;

export interface CellEditPolicyErrorData {
  name: 'CellEditPolicyError';
  code: typeof CELL_EDIT_VALUE_TOO_LARGE_CODE;
  storageClass: OversizedCellStorageClass;
  actualBytes: number;
  limitBytes: number;
  message: string;
}

export interface OversizedCellReplacementRequiredErrorData {
  name: 'OversizedCellReplacementRequiredError';
  code: typeof OVERSIZED_CELL_REPLACEMENT_REQUIRED_CODE;
  table: string;
  column: string;
  storageClass: OversizedCellStorageClass;
  actualBytes: number;
  limitBytes: number;
  message: string;
}

export type CellEditRpcErrorData =
  | CellEditPolicyErrorData
  | OversizedCellReplacementRequiredErrorData;

/** Typed semantic refusal for a new value that would itself be oversized. */
export class CellEditPolicyError extends Error {
  readonly name = 'CellEditPolicyError';
  readonly code = CELL_EDIT_VALUE_TOO_LARGE_CODE;

  constructor(
    readonly storageClass: OversizedCellStorageClass,
    readonly actualBytes: number,
    readonly limitBytes: number,
    message: string = (
      `New ${storageClass.toUpperCase()} cell value is ${actualBytes} bytes and ` +
      `exceeds the ${limitBytes}-byte edit limit.`
    )
  ) {
    super(message);
  }
}

/** Refusal for an unconfirmed attempt to replace an existing oversized cell. */
export class OversizedCellReplacementRequiredError extends Error {
  readonly name = 'OversizedCellReplacementRequiredError';
  readonly code = OVERSIZED_CELL_REPLACEMENT_REQUIRED_CODE;

  constructor(
    readonly table: string,
    readonly column: string,
    readonly storageClass: OversizedCellStorageClass,
    readonly actualBytes: number,
    readonly limitBytes: number,
    message: string = (
      `Existing ${storageClass.toUpperCase()} cell ${table}.${column} is ${actualBytes} bytes. ` +
      'Use the explicitly confirmed oversized-cell replacement path.'
    )
  ) {
    super(message);
  }
}

/** Match TextEncoder's replacement behavior without allocating encoded bytes. */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes++;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 3;
      }
    } else {
      // Lone low surrogates are encoded as U+FFFD, also three UTF-8 bytes.
      bytes += 3;
    }
  }
  return bytes;
}

export function assertCellValueWithinEditLimit(value: CellValue, limitBytes: number): void {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) {
    throw new Error(`Cell edit limit must be a positive safe integer, got ${limitBytes}`);
  }
  const storageClass = typeof value === 'string'
    ? 'text' as const
    : value instanceof Uint8Array
      ? 'blob' as const
      : undefined;
  if (!storageClass) return;

  const actualBytes = typeof value === 'string'
    ? utf8ByteLength(value)
    : value instanceof Uint8Array
      ? value.byteLength
      : 0;
  if (actualBytes > limitBytes) {
    throw new CellEditPolicyError(storageClass, actualBytes, limitBytes);
  }
}

export function normalizeCellEditLimitBytes(limitBytes?: number): number {
  const effectiveLimit = limitBytes ?? DEFAULT_MAX_CELL_EDIT_BYTES;
  if (!Number.isSafeInteger(effectiveLimit) || effectiveLimit < 1) {
    throw new Error(`Cell edit limit must be a positive safe integer, got ${effectiveLimit}`);
  }
  return effectiveLimit;
}

export function assertCellValuesWithinEditLimit(
  values: Iterable<CellValue>,
  limitBytes?: number
): number {
  const effectiveLimit = normalizeCellEditLimitBytes(limitBytes);
  for (const value of values) assertCellValueWithinEditLimit(value, effectiveLimit);
  return effectiveLimit;
}

export function assertOversizedCellReplacementExpectation(
  expected: OversizedCellMetadata,
  limitBytes?: number
): number {
  const effectiveLimit = normalizeCellEditLimitBytes(limitBytes);
  if (
    !expected
    || (expected.storageClass !== 'text' && expected.storageClass !== 'blob')
    || !Number.isSafeInteger(expected.byteLength)
    || expected.byteLength <= effectiveLimit
  ) {
    throw new Error(
      'Guarded oversized-cell replacement requires exact TEXT/BLOB metadata above the edit limit'
    );
  }
  return effectiveLimit;
}

export function formatOversizedCellReplacementWarning(
  table: string,
  column: string,
  metadata: OversizedCellMetadata
): string {
  return (
    `Replace oversized cell "${table}"."${column}"? ` +
    `Current storage class: ${metadata.storageClass.toUpperCase()}. ` +
    `Exact size: ${metadata.byteLength.toLocaleString()} bytes. ` +
    'This edit cannot be undone. Undo will not cross this edit, and existing redo history will be discarded.'
  );
}

export function toCellEditPolicyErrorData(error: unknown): CellEditPolicyErrorData | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as Partial<CellEditPolicyErrorData>;
  if (
    candidate.name !== 'CellEditPolicyError'
    || candidate.code !== CELL_EDIT_VALUE_TOO_LARGE_CODE
    || (candidate.storageClass !== 'text' && candidate.storageClass !== 'blob')
    || !Number.isSafeInteger(candidate.actualBytes)
    || Number(candidate.actualBytes) < 0
    || !Number.isSafeInteger(candidate.limitBytes)
    || Number(candidate.limitBytes) < 1
    || typeof candidate.message !== 'string'
  ) return undefined;

  return {
    name: 'CellEditPolicyError',
    code: CELL_EDIT_VALUE_TOO_LARGE_CODE,
    storageClass: candidate.storageClass,
    actualBytes: Number(candidate.actualBytes),
    limitBytes: Number(candidate.limitBytes),
    message: candidate.message
  };
}

export function fromCellEditPolicyErrorData(error: unknown): CellEditPolicyError | undefined {
  const data = toCellEditPolicyErrorData(error);
  return data
    ? new CellEditPolicyError(
        data.storageClass,
        data.actualBytes,
        data.limitBytes,
        data.message
      )
    : undefined;
}

export function toOversizedCellReplacementRequiredErrorData(
  error: unknown
): OversizedCellReplacementRequiredErrorData | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as Partial<OversizedCellReplacementRequiredErrorData>;
  if (
    candidate.name !== 'OversizedCellReplacementRequiredError'
    || candidate.code !== OVERSIZED_CELL_REPLACEMENT_REQUIRED_CODE
    || typeof candidate.table !== 'string'
    || typeof candidate.column !== 'string'
    || (candidate.storageClass !== 'text' && candidate.storageClass !== 'blob')
    || !Number.isSafeInteger(candidate.actualBytes)
    || Number(candidate.actualBytes) < 0
    || !Number.isSafeInteger(candidate.limitBytes)
    || Number(candidate.limitBytes) < 1
    || typeof candidate.message !== 'string'
  ) return undefined;

  return {
    name: 'OversizedCellReplacementRequiredError',
    code: OVERSIZED_CELL_REPLACEMENT_REQUIRED_CODE,
    table: candidate.table,
    column: candidate.column,
    storageClass: candidate.storageClass,
    actualBytes: Number(candidate.actualBytes),
    limitBytes: Number(candidate.limitBytes),
    message: candidate.message
  };
}

export function fromOversizedCellReplacementRequiredErrorData(
  error: unknown
): OversizedCellReplacementRequiredError | undefined {
  const data = toOversizedCellReplacementRequiredErrorData(error);
  return data
    ? new OversizedCellReplacementRequiredError(
        data.table,
        data.column,
        data.storageClass,
        data.actualBytes,
        data.limitBytes,
        data.message
      )
    : undefined;
}

export function toCellEditRpcErrorData(error: unknown): CellEditRpcErrorData | undefined {
  return toCellEditPolicyErrorData(error)
    ?? toOversizedCellReplacementRequiredErrorData(error);
}

export function fromCellEditRpcErrorData(error: unknown): Error | undefined {
  return fromCellEditPolicyErrorData(error)
    ?? fromOversizedCellReplacementRequiredErrorData(error);
}

export function isOversizedCellReplacementRequiredError(
  error: unknown
): error is OversizedCellReplacementRequiredError {
  return error instanceof OversizedCellReplacementRequiredError
    || toOversizedCellReplacementRequiredErrorData(error) !== undefined;
}

export function isOversizedCellReplacementConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(OVERSIZED_CELL_REPLACEMENT_CONFLICT_MESSAGE);
}
