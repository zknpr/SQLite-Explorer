/**
 * HTML/DOM Utility Functions
 *
 * Utilities for generating HTML attributes and handling DOM-related data.
 * Pure functions with no external dependencies.
 */

/**
 * Convert camelCase to dash-case.
 */
function toDashCase(str: string): string {
  return str.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`);
}

/**
 * Convert object to HTML data attributes string.
 *
 * @param obj - Object with string/boolean/undefined values
 * @returns HTML attribute string like 'data-foo="bar" data-baz="true"'
 */
export function toDatasetAttrs(obj: Record<string, string | boolean | undefined>): string {
  return Object.entries(obj)
    .filter(([, value]) => value != null)
    .map(([key, value]) => `data-${toDashCase(key)}="${String(value).replace(/"/g, '&quot;')}"`)
    .join(' ');
}

/**
 * String representation of boolean for HTML attributes.
 */
export type BoolString = 'true' | 'false';

/**
 * Convert boolean to string for HTML attributes.
 *
 * @param value - Boolean value (or null/undefined)
 * @returns 'true', 'false', or undefined
 */
export function toBoolString(value?: boolean | null): BoolString | undefined {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return undefined;
}
