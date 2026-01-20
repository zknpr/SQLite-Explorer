/**
 * Theme Utilities
 *
 * Helpers for VS Code theme integration.
 */

import * as vsc from 'vscode';

/**
 * Convert VS Code color theme to CSS color-scheme value.
 */
export function themeToColorScheme(theme: vsc.ColorTheme): 'light' | 'dark' {
  switch (theme.kind) {
    case vsc.ColorThemeKind.Light:
    case vsc.ColorThemeKind.HighContrastLight:
      return 'light';
    case vsc.ColorThemeKind.Dark:
    case vsc.ColorThemeKind.HighContrast:
    default:
      return 'dark';
  }
}

/**
 * Convert VS Code UI kind to string.
 */
export function uiKindToString(kind: vsc.UIKind): 'desktop' | 'web' {
  return kind === vsc.UIKind.Desktop ? 'desktop' : 'web';
}

/**
 * Convert boolean to string for data attributes.
 */
export function boolToString(value: boolean): 'true' | 'false' {
  return value ? 'true' : 'false';
}

/**
 * Convert object to HTML data attributes string.
 */
export function objectToDataAttrs(obj: Record<string, string | undefined>): string {
  const attrs: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      const attrName = `data-${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`;
      const attrValue = value.replace(/"/g, '&quot;');
      attrs.push(`${attrName}="${attrValue}"`);
    }
  }

  return attrs.join(' ');
}
