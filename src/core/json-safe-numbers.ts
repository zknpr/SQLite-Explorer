const STRING_ESCAPE_PREFIX = '~';
const NON_FINITE_NUMBER_PREFIX = '~sqlite-explorer-non-finite:';
const POSITIVE_INFINITY_SENTINEL = `${NON_FINITE_NUMBER_PREFIX}Infinity`;
const NEGATIVE_INFINITY_SENTINEL = `${NON_FINITE_NUMBER_PREFIX}-Infinity`;
const NAN_SENTINEL = `${NON_FINITE_NUMBER_PREFIX}NaN`;

/** Longest JSON wire form emitted by encodeJsonSafeNonFiniteNumber. */
export const JSON_SAFE_NON_FINITE_NUMBER_MAX_WIRE_BYTES =
  NEGATIVE_INFINITY_SENTINEL.length + 2;

export function encodeJsonSafeNonFiniteNumber(value: number): string {
  if (Number.isNaN(value)) return NAN_SENTINEL;
  return value > 0 ? POSITIVE_INFINITY_SENTINEL : NEGATIVE_INFINITY_SENTINEL;
}

/**
 * Escape the namespace used by the scalar sentinels. Unlike an object tag,
 * this prefix code is collision-free for arbitrary user strings: one leading
 * '~' is added on write and removed before sentinel recognition on read.
 */
export function escapeJsonSafeNumberString(value: string): string {
  return value.startsWith(STRING_ESCAPE_PREFIX)
    ? `${STRING_ESCAPE_PREFIX}${value}`
    : value;
}

export function jsonSafeNumberStringExpansionBytes(value: string): number {
  return value.startsWith(STRING_ESCAPE_PREFIX) ? 1 : 0;
}

export function decodeJsonSafeNumberString(value: string): string | number {
  if (value.startsWith(`${STRING_ESCAPE_PREFIX}${STRING_ESCAPE_PREFIX}`)) {
    return value.slice(1);
  }
  if (value === POSITIVE_INFINITY_SENTINEL) return Number.POSITIVE_INFINITY;
  if (value === NEGATIVE_INFINITY_SENTINEL) return Number.NEGATIVE_INFINITY;
  if (value === NAN_SENTINEL) return Number.NaN;
  return value;
}
