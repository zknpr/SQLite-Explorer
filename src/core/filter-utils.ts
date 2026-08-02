/**
 * Return the exact filter text when it contains a non-whitespace character.
 * Whitespace-only input is an inactive filter, while padding around a real
 * term remains literal and is passed through unchanged to SQLite.
 */
export function getActiveFilterValue(value: unknown): string | undefined {
  const text = value === null || value === undefined ? '' : String(value);
  return text.trim() ? text : undefined;
}
