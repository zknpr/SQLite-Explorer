import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.resolve('desktop', 'viewer.html'), 'utf-8');
const THEMES = ['dark', 'light', 'high-contrast', 'solarized', 'nord'];
const REQUIRED_VARS = [
  '--vscode-editor-background', '--vscode-sideBar-background', '--vscode-input-background',
  '--vscode-editor-foreground', '--vscode-descriptionForeground', '--vscode-panel-border',
  '--vscode-focusBorder', '--vscode-list-hoverBackground',
  '--vscode-list-activeSelectionBackground', '--vscode-list-activeSelectionForeground',
  '--vscode-errorForeground', '--vscode-terminal-ansiGreen',
  '--vscode-editorWarning-foreground', '--vscode-button-background',
  '--vscode-button-foreground', '--vscode-button-hoverBackground',
  '--vscode-button-secondaryBackground', '--vscode-button-secondaryForeground',
  '--vscode-button-secondaryHoverBackground', '--vscode-editor-findMatchHighlightBackground',
  '--bg-stripe'
];

for (const theme of THEMES) {
  test(`desktop viewer carries a complete ${theme} theme block`, () => {
    const m = html.match(new RegExp(`:root\\[data-theme=${theme}\\]\\{([^}]*)\\}`))
      ?? html.match(new RegExp(`:root\\[data-theme="${theme}"\\]\\{([^}]*)\\}`));
    assert.ok(m, `missing :root[data-theme=${theme}] block`);
    for (const v of REQUIRED_VARS) assert.ok(m![1].includes(v), `${theme} missing ${v}`);
    assert.ok(m![1].includes('color-scheme:'), `${theme} missing color-scheme`);
  });
}
